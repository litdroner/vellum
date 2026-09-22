// PDF → Excel V1 (export/xlsx.js on export/zip.js), on the Export Center contract (export/model.js,
// export/run.js). Pinned here: that a confident table becomes one worksheet of real cells, that several
// tables become several sheets in page order, that row and column order and empty cells survive, that a
// number is only written as a number when reading it as one changes nothing, that a region the extraction
// wasn't confident about is left out and named instead, that a document with no table writes no file at
// all, that the same document always gives the same bytes, and that the PDF is unchanged.
// Run: node --test tests/editing/export-excel.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { analyzeFile, loadPdfLib, openWithPdfjs, webModule } from './harness.mjs';

const model = await webModule('export/model.js');
const { runExport } = await webModule('export/run.js');
const { cellNumber, columnLetters, tablesWorkbook, workbookSheets, worksheetXml } = await webModule('export/xlsx.js');
const { zipArchive } = await webModule('export/zip.js');
const { readSemanticPage } = await webModule('semantic/model.js');
const { pageTables } = await webModule('semantic/tables.js');
const pako = await import('../../src/Vellum/web/vendor/pako/pako.esm.mjs');

// ---- reading an .xlsx back ---------------------------------------------------------------------

/** The archive's parts by name, from its central directory — enough to read what we just wrote. */
function unzip(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = bytes.length - 22;
  while (end >= 0 && view.getUint32(end, true) !== 0x06054b50) end--;
  assert.ok(end >= 0, 'the archive has an end-of-directory record');
  const count = view.getUint16(end + 10, true);
  let at = view.getUint32(end + 16, true);
  const parts = new Map();
  for (let i = 0; i < count; i++) {
    assert.equal(view.getUint32(at, true), 0x02014b50, 'a central directory header');
    const method = view.getUint16(at + 10, true);
    const compressed = view.getUint32(at + 20, true);
    const nameLength = view.getUint16(at + 28, true);
    const offset = view.getUint32(at + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(at + 46, at + 46 + nameLength));
    const body = offset + 30 + view.getUint16(offset + 26, true) + view.getUint16(offset + 28, true);
    const raw = bytes.subarray(body, body + compressed);
    parts.set(name, new TextDecoder().decode(method === 8 ? pako.inflateRaw(raw) : raw));
    at += 46 + nameLength + view.getUint16(at + 30, true) + view.getUint16(at + 32, true);
  }
  return parts;
}

/** A worksheet's cells as rows of strings, with an empty cell as null — what Excel would show. */
function sheetRows(xml) {
  return [...xml.matchAll(/<row [^>]*>(.*?)<\/row>/gs)].map(([, row]) =>
    [...row.matchAll(/<c r="[A-Z]+\d+"(?: t="inlineStr")?\s*(?:\/>|>(.*?)<\/c>)/gs)].map(([, body]) => {
      if (body === undefined) return null;
      const text = /<t[^>]*>(.*?)<\/t>/s.exec(body);
      if (text) return text[1].replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
      return Number(/<v>(.*?)<\/v>/s.exec(body)[1]);
    }));
}

const sheetNames = (parts) => [...parts.get('xl/workbook.xml').matchAll(/<sheet name="([^"]*)"/g)].map(([, n]) => n);

// ---- fixtures ------------------------------------------------------------------------------------

// A page with a heading, a paragraph, and a 3 x 3 table whose middle row has an empty last cell.
const ONE_TABLE = [
  [72, 700, 'Field results', 16],
  [72, 660, 'The samples were taken in March and'],
  [72, 646, 'measured the same week.'],
  [72, 600, 'Site'], [250, 600, 'Count'], [420, 600, 'Depth'],
  [72, 580, 'North'], [250, 580, '12'],
  [72, 560, 'South'], [250, 560, '31'], [420, 560, '4.2'],
];

// The same page with a second table below it, so one page gives two worksheets.
const TWO_TABLES = [
  ...ONE_TABLE,
  [72, 420, 'Depth'], [250, 420, 'Code'],
  [72, 400, '1.5'], [250, 400, '007'],
  [72, 380, '-2'], [250, 380, '1.50'],
];

const NO_TABLE = [
  [72, 700, 'A note about the samples that runs on for a while as ordinary prose,'],
  [72, 686, 'across two lines, and holds nothing a table could be read out of.'],
];

async function pdfOf(lines) {
  const { PDFDocument, StandardFonts } = await loadPdfLib();
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([612, 792]);
  for (const [x, y, text, size = 11] of lines) page.drawText(text, { x, y, size, font });
  return doc.save({ useObjectStreams: false });
}

async function extractionOf(bytes) {
  const { pages } = await analyzeFile(bytes);
  const js = await openWithPdfjs(bytes);
  try {
    return pageTables(await readSemanticPage(pages[0], await js.doc.getPage(1)));
  } finally {
    await js.close();
  }
}

const DOCUMENT = { name: 'field.pdf', path: 'C:\\Docs\\field.pdf', contentKey: 'ABCDEF0123456789' };

// ---- the format on the export contract -----------------------------------------------------------

test('Excel is one file for the pages chosen, named after the document', () => {
  const plan = model.exportPlan({ fileName: 'Quarterly report.pdf', formatId: 'excel', pages: [2, 3], pageCount: 9 });
  assert.deepEqual(plan.files.map((f) => ({ name: f.name, pages: [...f.pages] })), [{ name: 'Quarterly report.xlsx', pages: [2, 3] }]);
  assert.equal(plan.format.kind, 'binary');
});

// ---- cells -----------------------------------------------------------------------------------------

test('a cell is a number only when reading it as one changes nothing', () => {
  assert.equal(cellNumber('31'), 31);
  assert.equal(cellNumber('-2'), -2);
  assert.equal(cellNumber('1.5'), 1.5);
  assert.equal(cellNumber(' 12 '), 12);
  for (const text of ['007', '1.50', '1,200', '+3', '1e4', '12%', '\u00a35', '2024-01-02', '1 500', '', '3.', 'N/A']) {
    assert.equal(cellNumber(text), null, text);
  }
  assert.equal(cellNumber('1234567890123456'), null, 'more digits than a spreadsheet keeps exactly');
});

test('columns are lettered as a spreadsheet letters them', () => {
  assert.deepEqual([0, 1, 25, 26, 27, 51, 52].map(columnLetters), ['A', 'B', 'Z', 'AA', 'AB', 'AZ', 'BA']);
});

test('a worksheet keeps row and column order and writes an empty cell as an empty cell', () => {
  const xml = worksheetXml([['Site', 'Count'], ['North', null], ['South', '31']]);
  assert.match(xml, /<row r="1"><c r="A1" t="inlineStr"><is><t xml:space="preserve">Site<\/t><\/is><\/c><c r="B1"/);
  assert.match(xml, /<row r="2">.*<c r="B2"\/><\/row>/, 'the empty cell is there, in its own column');
  assert.match(xml, /<c r="B3"><v>31<\/v><\/c>/, 'a plain number is a number');
  assert.deepEqual(sheetRows(xml), [['Site', 'Count'], ['North', null], ['South', 31]]);
});

test('markup in a cell is written as text, not as markup', () => {
  assert.deepEqual(sheetRows(worksheetXml([['<b> & "x"', "it's"]])), [['<b> & "x"', "it's"]]);
});

// ---- a document's tables -----------------------------------------------------------------------------

test('a confident table becomes one worksheet of real cells, in the table\u2019s own order', async () => {
  const extraction = await extractionOf(await pdfOf(ONE_TABLE));
  assert.equal(extraction.tables.length, 1, 'the existing extraction finds the table');

  const bytes = await tablesWorkbook({ document: DOCUMENT, pages: [extraction] });
  const parts = unzip(bytes);
  assert.deepEqual(sheetNames(parts), ['Page 1', 'About this export']);
  assert.deepEqual(sheetRows(parts.get('xl/worksheets/sheet1.xml')), [
    ['Site', 'Count', 'Depth'],
    ['North', 12, null],
    ['South', 31, 4.2],
  ]);
  // The prose on the page is not in the workbook: only tables are.
  assert.equal(/Field results|samples were taken/.test(parts.get('xl/worksheets/sheet1.xml')), false);
  // A real package: the parts Excel opens it by, and no image of anything.
  for (const name of ['[Content_Types].xml', '_rels/.rels', 'xl/workbook.xml', 'xl/_rels/workbook.xml.rels']) {
    assert.ok(parts.has(name), name);
  }
  assert.match(parts.get('xl/_rels/workbook.xml.rels'), /Target="worksheets\/sheet1\.xml"/);
});

test('several tables become several worksheets, in page and reading order', async () => {
  const extraction = await extractionOf(await pdfOf(TWO_TABLES));
  assert.equal(extraction.tables.length, 2);
  const parts = unzip(await tablesWorkbook({ document: DOCUMENT, pages: [extraction] }));
  assert.deepEqual(sheetNames(parts), ['Page 1 table 1', 'Page 1 table 2', 'About this export']);
  assert.deepEqual(sheetRows(parts.get('xl/worksheets/sheet1.xml'))[0], ['Site', 'Count', 'Depth']);
  assert.deepEqual(sheetRows(parts.get('xl/worksheets/sheet2.xml')), [
    ['Depth', 'Code'],
    [1.5, '007'],
    [-2, '1.50'],
  ]);
});

test('worksheets across pages are named for their page and keep page order', () => {
  const table = (rows) => ({ rows: rows.map((r) => r.map((text) => (text == null ? null : { text }))) });
  const sheets = workbookSheets([
    { page: 2, tables: [table([['a']])], ambiguous: [] },
    { page: 5, tables: [table([['b']]), table([['c']])], ambiguous: [] },
  ]);
  assert.deepEqual(sheets.map((s) => s.name), ['Page 2', 'Page 5 table 1', 'Page 5 table 2']);
  assert.deepEqual(sheets.map((s) => s.rows), [[['a']], [['b']], [['c']]]);
});

test('a region the extraction wasn\u2019t confident about is left out and named, not guessed at', async () => {
  const extraction = await extractionOf(await pdfOf(ONE_TABLE));
  const ambiguous = { ...extraction, ambiguous: [{ page: 1, box: [0, 0, 1, 1], rowCount: 4, reason: 'a column\u2019s cells aren\u2019t aligned' }] };
  const parts = unzip(await tablesWorkbook({ document: DOCUMENT, pages: [ambiguous] }));
  assert.deepEqual(sheetNames(parts), ['Page 1', 'About this export'], 'no worksheet was made for it');
  const notes = sheetRows(parts.get('xl/worksheets/sheet2.xml')).map((r) => r.join(' '));
  assert.ok(notes.some((r) => /Not confidently a table/.test(r)));
  assert.ok(notes.some((r) => /Page 1 4 rows not written \u2014 a column\u2019s cells aren\u2019t aligned/.test(r)));
  assert.ok(notes.some((r) => /Exported from field\.pdf/.test(r)));
  assert.ok(notes.some((r) => /C:\\Docs\\field\.pdf/.test(r)));
});

test('a document with no confident table writes no spreadsheet at all', async () => {
  const extraction = await extractionOf(await pdfOf(NO_TABLE));
  assert.equal(extraction.tables.length, 0);
  await assert.rejects(
    () => tablesWorkbook({ document: DOCUMENT, pages: [extraction] }),
    /didn\u2019t confidently find a table/,
  );
});

test('the same document and pages give the same workbook, byte for byte', async () => {
  const extraction = await extractionOf(await pdfOf(TWO_TABLES));
  const once = await tablesWorkbook({ document: DOCUMENT, pages: [extraction] });
  const again = await tablesWorkbook({ document: DOCUMENT, pages: [extraction] });
  assert.deepEqual([...once], [...again]);
  // Nothing in the bytes is the time of the export: the archive uses the ZIP epoch throughout.
  const stamp = await zipArchive([{ name: 'a.txt', data: 'a' }]);
  assert.deepEqual([...stamp.subarray(10, 14)], [0, 0, 0x21, 0]);
});

// ---- the export, end to end ---------------------------------------------------------------------------

test('an Excel export writes one file through the shared run, and never changes the PDF', async () => {
  const bytes = await pdfOf(ONE_TABLE);
  const before = crypto.createHash('sha256').update(bytes).digest('hex');
  const extraction = await extractionOf(bytes);
  const plan = model.exportPlan({ fileName: 'field.pdf', formatId: 'excel', pages: [1], pageCount: 1 });
  const written = new Map();
  const result = await runExport({
    plan,
    targets: plan.files.map((f, i) => ({ name: f.name, path: `C:\\out\\${f.name}`, token: `t${i}` })),
    produce: () => tablesWorkbook({ document: DOCUMENT, pages: [extraction] }),
    write: (target, data) => { written.set(target.name, data); return data.byteLength; },
  });
  assert.equal(result.ok, true);
  assert.deepEqual([...written.keys()], ['field.xlsx']);
  assert.deepEqual([...written.get('field.xlsx').subarray(0, 4)], [0x50, 0x4b, 0x03, 0x04], 'a ZIP, as .xlsx is');
  assert.equal(model.describeResult(result), 'Exported 1 file');
  assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), before);
});

test('a document with no table fails the file by name and writes nothing', async () => {
  const extraction = await extractionOf(await pdfOf(NO_TABLE));
  const plan = model.exportPlan({ fileName: 'notes.pdf', formatId: 'excel', pages: [1], pageCount: 1 });
  const written = new Map();
  const result = await runExport({
    plan,
    targets: [{ name: 'notes.xlsx', path: 'C:\\out\\notes.xlsx', token: 't0' }],
    produce: () => tablesWorkbook({ document: { name: 'notes.pdf' }, pages: [extraction] }),
    write: (target, data) => { written.set(target.name, data); return data.byteLength; },
  });
  assert.equal(result.ok, false);
  assert.equal(written.size, 0, 'no bogus spreadsheet');
  assert.deepEqual(result.failed.map((f) => f.name), ['notes.xlsx']);
  assert.match(result.failed[0].error, /didn\u2019t confidently find a table/);
});
