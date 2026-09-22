// PDF → Word V1 (export/docx.js on export/zip.js), on the Export Center contract (export/model.js,
// export/run.js). Pinned here: that the paragraphs come out in the semantic model's reading order, that
// bold and italic are taken from the PDF's own font name and from nothing else, that a confident table
// becomes a Word table of real cells with its empty cells kept, that a link the PDF draws over a run
// becomes a Word hyperlink, that one page is separated from the next by a page break, that a heading is
// written only where the document's outline names it, that a page Vellum can't read says so instead of
// being filled in, that the same pages always give the same bytes, and that the PDF is unchanged.
// Run: node --test tests/editing/export-word.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { analyzeFile, loadPdfLib, openWithPdfjs, webModule } from './harness.mjs';

const model = await webModule('export/model.js');
const { runExport } = await webModule('export/run.js');
const { documentDocx, pageXml, runStyle } = await webModule('export/docx.js');
const { readSemanticPage } = await webModule('semantic/model.js');
const { pageTables } = await webModule('semantic/tables.js');
const pako = await import('../../src/Vellum/web/vendor/pako/pako.esm.mjs');

// ---- reading a .docx back --------------------------------------------------------------------------

/** The archive's parts by name, from its central directory. */
function unzip(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = bytes.length - 22;
  while (end >= 0 && view.getUint32(end, true) !== 0x06054b50) end--;
  assert.ok(end >= 0, 'the archive has an end-of-directory record');
  const count = view.getUint16(end + 10, true);
  let at = view.getUint32(end + 16, true);
  const parts = new Map();
  for (let i = 0; i < count; i++) {
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

const unescape = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
/** A paragraph's text, as Word would read it out. */
const textOf = (xml) => unescape([...xml.matchAll(/<w:t(?: [^>]*)?>(.*?)<\/w:t>/gs)].map(([, t]) => t).join(''));
/** Every top-level paragraph's text, in order — the document's reading order. */
const paragraphs = (xml) => [...xml.matchAll(/<w:p>(.*?)<\/w:p>/gs)].map(([, p]) => textOf(p));

// ---- fixtures --------------------------------------------------------------------------------------

const DOCUMENT = { name: 'field.pdf', path: 'C:\\Docs\\field.pdf', contentKey: 'ABCDEF0123456789' };

// A page with a title, a two-line paragraph and a 3 x 3 table whose middle row has an empty last cell.
const PAGE = [
  [72, 700, 'Field results', 16],
  [72, 660, 'The samples were taken in March and'],
  [72, 646, 'measured the same week.'],
  [72, 600, 'Site'], [250, 600, 'Count'], [420, 600, 'Depth'],
  [72, 580, 'North'], [250, 580, '12'],
  [72, 560, 'South'], [250, 560, '31'], [420, 560, '4.2'],
];

async function pdfOf(lines) {
  const { PDFDocument, StandardFonts } = await loadPdfLib();
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([612, 792]);
  for (const [x, y, text, size = 11] of lines) page.drawText(text, { x, y, size, font });
  return doc.save({ useObjectStreams: false });
}

async function readPage(bytes) {
  const { pages } = await analyzeFile(bytes);
  const js = await openWithPdfjs(bytes);
  try {
    const page = await readSemanticPage(pages[0], await js.doc.getPage(1));
    return { page, tables: new Map([[page.number, pageTables(page).tables]]) };
  } finally {
    await js.close();
  }
}

/** A page of the model, made by hand, for what a real PDF can't say in one line. */
const fakePage = ({ number = 1, blocks = [], runs = [], links = [], box = [0, 0, 612, 792] }) =>
  ({ number, contentRead: true, box, rotate: 0, blocks, runs, links });

// ---- the format on the export contract ---------------------------------------------------------------

test('Word is one file for the pages chosen, named after the document', () => {
  const plan = model.exportPlan({ fileName: 'Quarterly report.pdf', formatId: 'word', pages: [2, 3], pageCount: 9 });
  assert.deepEqual(plan.files.map((f) => ({ name: f.name, pages: [...f.pages] })), [{ name: 'Quarterly report.docx', pages: [2, 3] }]);
  assert.equal(plan.format.kind, 'binary');
});

// ---- formatting ---------------------------------------------------------------------------------------

test('bold and italic come from the PDF\u2019s own font name, and from nothing else', () => {
  assert.deepEqual(runStyle('ABCDEF+TimesNewRomanPS-BoldItalicMT'), { bold: true, italic: true });
  assert.deepEqual(runStyle('Arial-BoldMT'), { bold: true, italic: false });
  assert.deepEqual(runStyle('Helvetica-Oblique'), { bold: false, italic: true });
  assert.deepEqual(runStyle('Arial,Bold'), { bold: true, italic: false });
  assert.deepEqual(runStyle('Lato-SemiBold'), { bold: true, italic: false });
  assert.deepEqual(runStyle('Helvetica'), { bold: false, italic: false });
  // A name that merely contains the letters is not a claim about the type.
  assert.deepEqual(runStyle('Boldoni'), { bold: false, italic: false });
  assert.deepEqual(runStyle(null), { bold: false, italic: false });
});

test('a run is bold or italic only where the font name says so, and a big run is still a paragraph', async () => {
  const page = fakePage({
    blocks: [{ id: 'b1', kind: 'paragraph', text: 'Plain\nStrong', runIds: ['r1', 'r2'] }],
    runs: [
      { id: 'r1', text: 'Plain', font: 'Helvetica', size: 24, box: [0, 0, 10, 10] },
      { id: 'r2', text: 'Strong', font: 'Helvetica-Bold', size: 11, box: [0, 0, 10, 10] },
    ],
  });
  const xml = pageXml(page, { rels: null });
  assert.equal(paragraphs(xml).join('|'), 'Plain Strong', 'the lines of a paragraph are one paragraph');
  assert.match(xml, /<w:r><w:t xml:space="preserve">Plain<\/w:t><\/w:r>/, 'the 24pt run claims nothing');
  assert.match(xml, /<w:rPr><w:b\/><\/w:rPr><w:t xml:space="preserve"> Strong<\/w:t>/);
});

// ---- a real document ------------------------------------------------------------------------------------

test('paragraphs and a confident table come out in the model\u2019s reading order', async () => {
  const { page, tables } = await readPage(await pdfOf(PAGE));
  assert.equal(tables.get(1).length, 1, 'the existing extraction finds the table');
  const parts = unzip(await documentDocx({ document: DOCUMENT, pages: [page], tables }));
  const xml = parts.get('word/document.xml');

  const text = textOf(xml);
  assert.ok(text.indexOf('Field results') < text.indexOf('The samples were taken'), 'the title comes first');
  assert.ok(text.indexOf('The samples were taken') < text.indexOf('Site'), 'then the text, then the table');
  // These lines are ones paragraph grouping left alone, so each stays its own paragraph, in the model's order.
  assert.deepEqual(paragraphs(xml).slice(0, 3), ['Field results', 'The samples were taken in March and', 'measured the same week.']);
  assert.equal((text.match(/North/g) ?? []).length, 1, 'a table\u2019s text is not written twice');

  // The table is a real Word table: one row per row, one cell per column, the empty cell kept.
  const rows = [...xml.matchAll(/<w:tr>(.*?)<\/w:tr>/gs)].map(([, row]) =>
    [...row.matchAll(/<w:tc>(.*?)<\/w:tc>/gs)].map(([, cell]) => textOf(cell)));
  assert.deepEqual(rows, [['Site', 'Count', 'Depth'], ['North', '12', ''], ['South', '31', '4.2']]);
  assert.equal((xml.match(/<w:gridCol /g) ?? []).length, 3, 'the grid has the table\u2019s columns');

  // A real package, and nothing rasterized into it.
  for (const name of ['[Content_Types].xml', '_rels/.rels', 'word/document.xml', 'word/_rels/document.xml.rels', 'word/styles.xml']) {
    assert.ok(parts.has(name), name);
  }
  assert.equal([...parts.keys()].some((n) => /media|image|\.png$|\.jpe?g$/i.test(n)), false, 'no picture of the page');
  assert.match(xml, /<w:pgSz w:w="12240" w:h="15840"\/>/, 'the page size the PDF has');
  assert.match(textOf(xml), /Exported from field\.pdf by Vellum \u2014 page 1\./);
  assert.match(textOf(xml), /C:\\Docs\\field\.pdf/);
});

test('a heading is written only where the document\u2019s outline names it', async () => {
  const { page, tables } = await readPage(await pdfOf(PAGE));
  const plain = await documentDocx({ document: DOCUMENT, pages: [page], tables });
  assert.equal(/w:pStyle w:val="Heading/.test(unzip(plain).get('word/document.xml')), false, 'no outline, no headings');

  const headings = new Map([[1, new Map([['Field results', 1]])]]);
  const xml = unzip(await documentDocx({ document: DOCUMENT, pages: [page], tables, headings })).get('word/document.xml');
  assert.match(xml, /<w:pPr><w:pStyle w:val="Heading1"\/><\/w:pPr><w:r><w:t xml:space="preserve">Field results<\/w:t>/);
  assert.equal((xml.match(/w:pStyle w:val="Heading/g) ?? []).length, 1, 'nothing else became a heading');
});

// ---- links, pages and what can\u2019t be read ------------------------------------------------------------

test('a link the PDF draws over a run becomes a Word hyperlink to that URL', async () => {
  const page = fakePage({
    blocks: [{ id: 'b1', kind: 'line', text: 'Visit the project page', runIds: ['r1'] }],
    runs: [{ id: 'r1', text: 'Visit the project page', font: 'Helvetica', box: [72, 617, 180, 629] }],
    links: [{ id: 'l1', url: 'https://example.com/a&b', internal: false, box: [72, 615, 200, 632] }],
  });
  const parts = unzip(await documentDocx({ document: DOCUMENT, pages: [page] }));
  const xml = parts.get('word/document.xml');
  assert.match(xml, /<w:hyperlink r:id="rId2"><w:r><w:rPr><w:rStyle w:val="Hyperlink"\/><\/w:rPr>/);
  assert.match(parts.get('word/_rels/document.xml.rels'), /Id="rId2".*Target="https:\/\/example\.com\/a&amp;b" TargetMode="External"/);

  // A run the link's own rectangle doesn't cover is not linked: no link is inferred from being nearby.
  const apart = fakePage({
    blocks: [{ id: 'b1', kind: 'line', text: 'Elsewhere', runIds: ['r1'] }],
    runs: [{ id: 'r1', text: 'Elsewhere', font: 'Helvetica', box: [72, 300, 180, 312] }],
    links: [{ id: 'l1', url: 'https://example.com/', internal: false, box: [72, 615, 200, 632] }],
  });
  assert.equal(/<w:hyperlink/.test(unzip(await documentDocx({ document: DOCUMENT, pages: [apart] })).get('word/document.xml')), false);
});

test('one page is separated from the next by a page break', async () => {
  const pageOf = (number, text) => fakePage({
    number,
    blocks: [{ id: `b${number}`, kind: 'line', text, runIds: [`r${number}`] }],
    runs: [{ id: `r${number}`, text, font: 'Helvetica', box: [0, 0, 10, 10] }],
  });
  const xml = unzip(await documentDocx({ document: DOCUMENT, pages: [pageOf(1, 'One'), pageOf(2, 'Two'), pageOf(3, 'Three')] })).get('word/document.xml');
  assert.equal((xml.match(/<w:br w:type="page"\/>/g) ?? []).length, 2, 'a break between the pages, not after the last');
  assert.ok(xml.indexOf('One') < xml.indexOf('Two') && xml.indexOf('Two') < xml.indexOf('Three'));
  const between = xml.slice(xml.indexOf('One'), xml.indexOf('Two'));
  assert.match(between, /<w:br w:type="page"\/>/);
});

test('a page whose text is not read says so instead of being filled in', async () => {
  const locked = { number: 1, contentRead: false, box: [0, 0, 612, 792], rotate: 0, blocks: [], runs: [], links: [] };
  const xml = unzip(await documentDocx({ document: DOCUMENT, pages: [locked] })).get('word/document.xml');
  assert.match(textOf(xml), /Vellum doesn\u2019t read the text of a protected PDF/);
  assert.equal(/<w:tbl>/.test(xml), false, 'and nothing was made up for it');
});

test('markup in the document\u2019s text is written as text, not as markup', async () => {
  const page = fakePage({
    blocks: [{ id: 'b1', kind: 'line', text: '<w:p> & "quoted"', runIds: ['r1'] }],
    runs: [{ id: 'r1', text: '<w:p> & "quoted"', font: 'Helvetica', box: [0, 0, 10, 10] }],
  });
  const xml = unzip(await documentDocx({ document: DOCUMENT, pages: [page] })).get('word/document.xml');
  assert.equal(paragraphs(xml)[0], '<w:p> & "quoted"');
});

// ---- determinism and the source document ---------------------------------------------------------------

test('the same document and pages give the same Word file, byte for byte', async () => {
  const { page, tables } = await readPage(await pdfOf(PAGE));
  const once = await documentDocx({ document: DOCUMENT, pages: [page], tables });
  const again = await documentDocx({ document: DOCUMENT, pages: [page], tables });
  assert.deepEqual([...once], [...again]);
});

test('a Word export writes one file through the shared run, and never changes the PDF', async () => {
  const bytes = await pdfOf(PAGE);
  const before = crypto.createHash('sha256').update(bytes).digest('hex');
  const { page, tables } = await readPage(bytes);
  const plan = model.exportPlan({ fileName: 'field.pdf', formatId: 'word', pages: [1], pageCount: 1 });
  const written = new Map();
  const result = await runExport({
    plan,
    targets: plan.files.map((f, i) => ({ name: f.name, path: `C:\\out\\${f.name}`, token: `t${i}` })),
    produce: () => documentDocx({ document: DOCUMENT, pages: [page], tables }),
    write: (target, data) => { written.set(target.name, data); return data.byteLength; },
  });
  assert.equal(result.ok, true);
  assert.deepEqual([...written.keys()], ['field.docx']);
  assert.deepEqual([...written.get('field.docx').subarray(0, 4)], [0x50, 0x4b, 0x03, 0x04], 'a ZIP, as .docx is');
  assert.equal(model.describeResult(result), 'Exported 1 file');
  assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), before);
});
