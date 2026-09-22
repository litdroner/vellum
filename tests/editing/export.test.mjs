// Export Center V1 (export/model.js, export/run.js, export/images.js, export/markdown.js): the shared export
// contract and the three formats built on it. Pinned here: the file names a plan gives (deterministic, padded
// to the document's page count), the pages a selection covers, what the JPEG and PNG exporter asks the canvas
// for, the Markdown a document's text and confident tables become, how overwriting is decided, that
// cancellation stops before the next file and leaves nothing half-written, that a failure names the file and
// does not stop the rest, and that the source PDF is byte-identical after an export.
// Run: node --test tests/editing/export.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { analyzeFile, loadPdfLib, openWithPdfjs, webModule } from './harness.mjs';

const model = await webModule('export/model.js');
const { runExport } = await webModule('export/run.js');
const { dpiScale, renderPageImage } = await webModule('export/images.js');
const { documentMarkdown, outlineHeadings, pageBlocks } = await webModule('export/markdown.js');
const { readSemanticPage } = await webModule('semantic/model.js');
const { pageTables } = await webModule('semantic/tables.js');

// ---- the plan: pages and names ---------------------------------------------------------------

test('a selection covers the pages it names, and nothing else', () => {
  assert.deepEqual(model.selectedPages({ mode: 'all' }, 4), [1, 2, 3, 4]);
  assert.deepEqual(model.selectedPages({ mode: 'range', text: '1-2, 4' }, 4), [1, 2, 4]);
  assert.deepEqual(model.selectedPages({ mode: 'range', text: '3-' }, 4), [3, 4]);
  assert.deepEqual(model.selectedPages({ mode: 'range', text: '2, 2, 1' }, 4), [1, 2], 'sorted, no duplicates');
  assert.deepEqual(model.selectedPages({ mode: 'pages', pages: [3] }, 4), [3]);
  for (const bad of ['0', '5', '3-2', 'two', '', '1-99']) {
    assert.equal(model.selectedPages({ mode: 'range', text: bad }, 4), null, bad);
  }
});

test('file names are deterministic and padded to the document pages', () => {
  const plan = model.exportPlan({ fileName: 'Quarterly report.pdf', formatId: 'jpg', pages: [1, 2, 10], pageCount: 10 });
  assert.deepEqual(plan.files.map((f) => f.name), [
    'Quarterly report (page 001).jpg',
    'Quarterly report (page 002).jpg',
    'Quarterly report (page 010).jpg',
  ]);
  // The same inputs give the same names again, whatever was exported before.
  const again = model.exportPlan({ fileName: 'Quarterly report.pdf', formatId: 'jpg', pages: [10, 2, 1], pageCount: 10 });
  assert.deepEqual(again.files.map((f) => f.name), plan.files.map((f) => f.name));
  // A long document pads wider; PNG keeps the names and changes the extension.
  const big = model.exportPlan({ fileName: 'a.pdf', formatId: 'png', pages: [7], pageCount: 1200 });
  assert.deepEqual(big.files.map((f) => f.name), ['a (page 0007).png']);
  // Markdown is one file for every page chosen.
  const md = model.exportPlan({ fileName: 'a.pdf', formatId: 'markdown', pages: [2, 3], pageCount: 9 });
  assert.deepEqual(md.files.map((f) => ({ name: f.name, pages: [...f.pages] })), [{ name: 'a.md', pages: [2, 3] }]);
});

test('a name a file system cannot hold becomes one it can', () => {
  assert.equal(model.exportBaseName('re:port?.pdf'), 're port');
  assert.equal(model.exportBaseName('.pdf'), 'Document');
  assert.equal(model.exportBaseName('notes.PDF'), 'notes');
});

// ---- running a plan --------------------------------------------------------------------------

/** A host that writes to a Map, as the real one writes to disk. `fail` names files it refuses. */
function fakeHost({ fail = [] } = {}) {
  const written = new Map();
  return {
    written,
    targets: (plan, { taken = [] } = {}) => plan.files.map((f, i) => ({
      name: taken.includes(f.name) ? f.name.replace(/(\.\w+)$/, ' (2)$1') : f.name,
      path: `C:\\out\\${f.name}`,
      token: `t${i}`,
    })),
    write: (target, data) => {
      if (fail.includes(target.name)) throw new Error('Another program has this file open and locked.');
      written.set(target.name, data);
      return data.byteLength;
    },
  };
}

test('a run writes every file and says so', async () => {
  const plan = model.exportPlan({ fileName: 'a.pdf', formatId: 'png', pages: [1, 2], pageCount: 2 });
  const host = fakeHost();
  const seen = [];
  const result = await runExport({
    plan,
    targets: host.targets(plan),
    produce: (file) => new Uint8Array([file.pages[0]]),
    write: host.write,
    onProgress: (step) => seen.push(step.name),
  });
  assert.equal(result.ok, true);
  assert.equal(result.cancelled, false);
  assert.deepEqual(result.written.map((w) => [w.name, w.page, w.bytes]), [['a (page 001).png', 1, 1], ['a (page 002).png', 2, 1]]);
  assert.deepEqual([...host.written.keys()], ['a (page 001).png', 'a (page 002).png']);
  assert.deepEqual(seen, ['a (page 001).png', 'a (page 002).png', null], 'progress for each file, then the end');
  assert.equal(model.describeResult(result), 'Exported 2 files');
});

test('cancelling stops before the next file, and no file is written half-way', async () => {
  const plan = model.exportPlan({ fileName: 'a.pdf', formatId: 'jpg', pages: [1, 2, 3], pageCount: 3 });
  const host = fakeHost();
  const controller = new AbortController();
  const result = await runExport({
    plan,
    targets: host.targets(plan),
    produce: (file) => {
      if (file.pages[0] === 2) controller.abort(); // cancelled while this one is being made
      return new Uint8Array([1]);
    },
    write: host.write,
    signal: controller.signal,
  });
  assert.equal(result.cancelled, true);
  assert.equal(result.ok, false);
  assert.deepEqual([...host.written.keys()], ['a (page 001).jpg'], 'the cancelled file was not written');
  assert.equal(model.describeResult(result), 'Export stopped \u2014 1 file written');
});

test('a file that cannot be written is named, and the rest still are', async () => {
  const plan = model.exportPlan({ fileName: 'a.pdf', formatId: 'jpg', pages: [1, 2, 3], pageCount: 3 });
  const host = fakeHost({ fail: ['a (page 002).jpg'] });
  const result = await runExport({ plan, targets: host.targets(plan), produce: () => new Uint8Array([1]), write: host.write });
  assert.equal(result.ok, false);
  assert.equal(result.cancelled, false);
  assert.deepEqual(result.failed.map((f) => f.name), ['a (page 002).jpg']);
  assert.deepEqual([...host.written.keys()], ['a (page 001).jpg', 'a (page 003).jpg']);
  assert.match(model.describeResult(result), /^2 files written, 1 couldn\u2019t be: Another program/);
});

test('keeping both writes the numbered name the host gives back, replacing writes over the name', async () => {
  const plan = model.exportPlan({ fileName: 'a.pdf', formatId: 'markdown', pages: [1], pageCount: 1 });
  const host = fakeHost();
  const keep = await runExport({ plan, targets: host.targets(plan, { taken: ['a.md'] }), produce: () => new Uint8Array([1]), write: host.write });
  assert.deepEqual(keep.written.map((w) => w.name), ['a (2).md']);
  const replace = await runExport({ plan, targets: host.targets(plan), produce: () => new Uint8Array([1]), write: host.write });
  assert.deepEqual(replace.written.map((w) => w.name), ['a.md']);
  assert.deepEqual([...host.written.keys()], ['a (2).md', 'a.md']);
});

// ---- images ----------------------------------------------------------------------------------

/** A canvas that records what it was asked for and gives back fixed bytes. */
function stubCanvas(record) {
  return (width, height) => {
    record.size = [width, height];
    return {
      width,
      height,
      getContext: () => ({
        set fillStyle(v) { record.fill = v; },
        fillRect: (...args) => { record.rect = args; },
      }),
      toBlob: (cb, mime, quality) => {
        record.mime = mime;
        record.quality = quality;
        cb({ arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer });
      },
    };
  };
}

const stubPdf = (record) => ({
  numPages: 1,
  getPage: async () => ({
    getViewport: ({ scale }) => {
      record.scale = scale;
      return { width: 612 * scale, height: 792 * scale };
    },
    render: () => ({ promise: Promise.resolve((record.rendered = true)) }),
  }),
});

test('JPEG export renders the page at 150 dpi on white and asks the canvas for JPEG', async () => {
  const record = {};
  const bytes = await renderPageImage({
    pdf: stubPdf(record), number: 1, format: model.EXPORT_FORMATS.jpg, createCanvas: stubCanvas(record),
  });
  assert.equal(record.scale, dpiScale(150));
  assert.deepEqual(record.size, [1275, 1650], 'a Letter page at 150 dpi');
  assert.equal(record.fill, '#fff');
  assert.deepEqual(record.rect, [0, 0, 1275, 1650], 'the page is paper, not transparent');
  assert.equal(record.rendered, true);
  assert.equal(record.mime, 'image/jpeg');
  assert.equal(record.quality, 0.92);
  assert.deepEqual([...bytes], [1, 2, 3]);
});

test('PNG export asks the canvas for PNG, and annotations Vellum drew are painted on top', async () => {
  const record = {};
  let painted = null;
  await renderPageImage({
    pdf: stubPdf(record),
    number: 1,
    format: model.EXPORT_FORMATS.png,
    createCanvas: stubCanvas(record),
    paint: (_ctx, number) => { painted = number; },
  });
  assert.equal(record.mime, 'image/png');
  assert.equal(painted, 1, 'painted after the page was rendered');
});

// ---- Markdown --------------------------------------------------------------------------------

// A page with a heading line, a paragraph of two lines, and a 3 x 2 table.
const DOC = [
  [72, 700, 'Field results', 16],
  [72, 660, 'The samples were taken in March and'],
  [72, 646, 'measured the same week.'],
  [72, 600, 'Site'], [300, 600, 'Count'],
  [72, 580, 'North'], [300, 580, '12'],
  [72, 560, 'South'], [300, 560, '31'],
];

async function pdfOf(lines) {
  const { PDFDocument, StandardFonts } = await loadPdfLib();
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([612, 792]);
  for (const [x, y, text, size = 11] of lines) page.drawText(text, { x, y, size, font });
  return doc.save({ useObjectStreams: false });
}

async function semanticPageOf(bytes) {
  const { pages } = await analyzeFile(bytes);
  const js = await openWithPdfjs(bytes);
  try {
    return await readSemanticPage(pages[0], await js.doc.getPage(1));
  } finally {
    await js.close();
  }
}

test('Markdown keeps the text and the confident table, and invents no structure', async () => {
  const page = await semanticPageOf(await pdfOf(DOC));
  const tables = pageTables(page).tables;
  assert.equal(tables.length, 1, 'the table is found by the existing extraction');

  const markdown = documentMarkdown({
    document: { name: 'field.pdf', path: 'C:\\Docs\\field.pdf', contentKey: 'ABCDEF0123456789' },
    pages: [page],
    tables: new Map([[1, tables]]),
  });
  assert.match(markdown, /^# field\.pdf\n/);
  assert.match(markdown, /\n## Page 1\n/);
  assert.match(markdown, /^The samples were taken in March and$/m);
  assert.match(markdown, /^measured the same week\.$/m);
  assert.match(markdown, /\| Site \| Count \|\n\| --- \| --- \|\n\| North \| 12 \|\n\| South \| 31 \|/);
  assert.equal((markdown.match(/North/g) ?? []).length, 1, 'the table text is not written twice');
  assert.match(markdown, /Exported from field\.pdf by Vellum \u2014 page 1\./);
  assert.match(markdown, /C:\\\\Docs\\\\field\.pdf/, 'a backslash is escaped, not read as markup');
  assert.match(markdown, /content abcdef012345\u2026 \(the file as it was read\)/);
  // No heading was guessed: "Field results" is bigger, and is still a paragraph.
  assert.equal(/^#{3,} Field results$/m.test(markdown), false);
  assert.match(markdown, /^Field results$/m);
});

test('a heading is written only when the document outline names it', async () => {
  const page = await semanticPageOf(await pdfOf(DOC));
  const headings = new Map([['Field results', 1]]);
  const blocks = pageBlocks(page, { tables: [], headings });
  assert.equal(blocks[0], '### Field results');
  assert.equal(blocks.filter((b) => b.startsWith('#')).length, 1, 'nothing else became a heading');
});

test('a paragraph the model joined is one Markdown paragraph, and markup in the text is escaped', () => {
  const page = {
    number: 1,
    contentRead: true,
    blocks: [
      { id: 'b1', kind: 'paragraph', text: 'One line\nand its second line', runIds: ['r1', 'r2'] },
      { id: 'b2', kind: 'line', text: '# not a heading *and not* emphasis', runIds: ['r3'] },
    ],
  };
  assert.deepEqual(pageBlocks(page), [
    'One line and its second line',
    '\\# not a heading \\*and not\\* emphasis',
  ]);
});

test('a page whose text is not read says so instead of being filled in', () => {
  const blocks = pageBlocks({ number: 2, contentRead: false, blocks: [] });
  assert.deepEqual(blocks, ['*Vellum doesn\u2019t read the text of a protected PDF, so this page has none here.*']);
});

test('a document with no outline gets no headings', async () => {
  const bytes = await pdfOf(DOC);
  const js = await openWithPdfjs(bytes);
  try {
    assert.equal((await outlineHeadings(js.doc)).size, 0);
  } finally {
    await js.close();
  }
});

// ---- the source document ---------------------------------------------------------------------

test('exporting never changes the PDF it reads', async () => {
  const bytes = await pdfOf(DOC);
  const before = crypto.createHash('sha256').update(bytes).digest('hex');
  const page = await semanticPageOf(bytes);
  const plan = model.exportPlan({ fileName: 'field.pdf', formatId: 'markdown', pages: [1], pageCount: 1 });
  const host = fakeHost();
  const result = await runExport({
    plan,
    targets: host.targets(plan),
    produce: () => new TextEncoder().encode(documentMarkdown({ document: { name: 'field.pdf' }, pages: [page] })),
    write: host.write,
  });
  assert.equal(result.ok, true);
  assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), before);
});
