// PDF → PowerPoint V1 (export/pptx.js on export/zip.js), on the Export Center contract (export/model.js,
// export/run.js). Pinned here: that one page becomes one slide and the page order is the slide order,
// that a block of text becomes a real text box placed by its own box, that the lines of a paragraph come
// out as one wrapped paragraph, that a confident table becomes a PowerPoint table of real cells with its
// empty cells kept, that the deck's size is the page's own, that content the model can't give safely
// (images, colours, drawings) is left out rather than guessed or rasterized, that the package a reader
// opens is structurally whole, that the same pages always give the same bytes, and that the PDF is
// unchanged.
// Run: node --test tests/editing/export-powerpoint.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { analyzeFile, loadPdfLib, openWithPdfjs, webModule } from './harness.mjs';

const model = await webModule('export/model.js');
const { runExport } = await webModule('export/run.js');
const { deckSize, documentPptx, pageShapes, placeBox, shownSize } = await webModule('export/pptx.js');
const { readSemanticPage } = await webModule('semantic/model.js');
const { pageTables } = await webModule('semantic/tables.js');
const pako = await import('../../src/Vellum/web/vendor/pako/pako.esm.mjs');

// ---- reading a .pptx back ----------------------------------------------------------------------------

/** The archive's parts by name, from its central directory (the same reader the Word test uses). */
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
/** The text of a slide, shape or cell, as PowerPoint would read it out. */
const textOf = (xml) => unescape([...xml.matchAll(/<a:t>(.*?)<\/a:t>/gs)].map(([, t]) => t).join(''));
/** Every text box on a slide, in the order it is written. */
const boxes = (xml) => [...xml.matchAll(/<p:sp>(.*?)<\/p:sp>/gs)].map(([, sp]) => sp);
/** A shape's placement, in EMU: { x, y, cx, cy, rot }. */
function xfrmOf(xml) {
  const m = /<a:xfrm(?: rot="(-?\d+)")?><a:off x="(-?\d+)" y="(-?\d+)"\/><a:ext cx="(\d+)" cy="(\d+)"\/>/.exec(xml);
  assert.ok(m, 'the shape is placed');
  return { rot: Number(m[1] ?? 0), x: Number(m[2]), y: Number(m[3]), cx: Number(m[4]), cy: Number(m[5]) };
}
const EMU = 12700;
const near = (emu, points, slack = 3) => Math.abs(emu / EMU - points) <= slack;

// ---- fixtures ------------------------------------------------------------------------------------------

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

async function pdfOf(lines, size = [612, 792]) {
  const { PDFDocument, StandardFonts } = await loadPdfLib();
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage(size);
  for (const [x, y, text, pt = 11] of lines) page.drawText(text, { x, y, size: pt, font });
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
const fakePage = ({ number = 1, blocks = [], runs = [], links = [], box = [0, 0, 612, 792], rotate = 0 }) =>
  ({ number, contentRead: true, box, rotate, blocks, runs, links });

const lineBlock = (id, text, box, { font = 'Helvetica', size = 11 } = {}) => ({
  block: { id, kind: 'line', text, runIds: [`r-${id}`], box },
  run: { id: `r-${id}`, text, font, size, box },
});

// ---- the format on the export contract -------------------------------------------------------------

test('PowerPoint is one file for the pages chosen, named after the document', () => {
  const plan = model.exportPlan({ fileName: 'Quarterly report.pdf', formatId: 'powerpoint', pages: [2, 3], pageCount: 9 });
  assert.deepEqual(plan.files.map((f) => ({ name: f.name, pages: [...f.pages] })), [{ name: 'Quarterly report.pptx', pages: [2, 3] }]);
  assert.equal(plan.format.kind, 'binary');
  assert.equal(plan.format.extension, 'pptx');
});

// ---- simple and multi-line text -----------------------------------------------------------------------

test('a line of text becomes one editable text box, placed where the line sits', async () => {
  const { block, run } = lineBlock('b1', 'Field results', [72, 690, 200, 706], { size: 16 });
  const parts = unzip(await documentPptx({ document: DOCUMENT, pages: [fakePage({ blocks: [block], runs: [run] })] }));
  const slide = parts.get('ppt/slides/slide1.xml');
  const shapes = boxes(slide);
  assert.equal(shapes.length, 1, 'one block, one shape');
  assert.equal(textOf(shapes[0]), 'Field results');
  assert.match(shapes[0], /<p:cNvSpPr txBox="1"\/>/, 'a real text box, not a picture');
  assert.match(shapes[0], /<a:rPr lang="en-US" sz="1600"/, 'the run\u2019s own size, and nothing more claimed');

  // Placed from the top-left of the slide: 72pt in from the left, 792 - 706 = 86pt down.
  const at = xfrmOf(shapes[0]);
  // The box is the text's own, with a couple of points of room so PowerPoint never clips its own text.
  assert.ok(near(at.x, 70, 0.5) && near(at.y, 84, 0.5), `placed at ${at.x / EMU}, ${at.y / EMU}`);
  assert.ok(near(at.cx, 132, 0.5) && near(at.cy, 20, 0.5), 'as wide and tall as the text\u2019s own box');
  assert.equal(at.rot, 0);
});

test('the lines of a paragraph come out as one wrapped paragraph in one box', async () => {
  // Two lines paragraph grouping joined into one block (editing/objects/text-block.js), as the model gives it.
  const box = [72, 646, 320, 672];
  const page = fakePage({
    blocks: [{ id: 'b1', kind: 'paragraph', text: 'The samples were taken in March and\nmeasured the same week.', runIds: ['r1', 'r2'], box }],
    runs: [
      { id: 'r1', text: 'The samples were taken in March and', font: 'Helvetica', size: 11, box: [72, 658, 320, 672] },
      { id: 'r2', text: 'measured the same week.', font: 'Helvetica', size: 11, box: [72, 646, 240, 660] },
    ],
  });
  const shapes = boxes(unzip(await documentPptx({ document: DOCUMENT, pages: [page] })).get('ppt/slides/slide1.xml'));
  assert.equal(shapes.length, 1, 'the two lines are one paragraph, so one box');
  assert.equal(textOf(shapes[0]), 'The samples were taken in March and measured the same week.');
  assert.equal((shapes[0].match(/<a:p>/g) ?? []).length, 1, 'one paragraph');
  assert.match(shapes[0], /<a:bodyPr wrap="square"/, 'PowerPoint wraps it inside the block’s own width');
  // The box spans both lines, so the wrapped paragraph has the room the page gave it.
  const at = xfrmOf(shapes[0]);
  assert.ok(near(at.cy, 30, 0.5), 'both lines tall');
});

test('bold and italic are the PDF\u2019s own font name, and nothing else is claimed', async () => {
  const plain = lineBlock('b1', 'Plain', [72, 700, 120, 712], { font: 'Helvetica' });
  const strong = lineBlock('b2', 'Strong', [72, 680, 120, 692], { font: 'Arial-BoldMT' });
  const slanted = lineBlock('b3', 'Slanted', [72, 660, 120, 672], { font: 'Helvetica-Oblique' });
  const page = fakePage({
    blocks: [plain.block, strong.block, slanted.block],
    runs: [plain.run, strong.run, slanted.run],
  });
  const shapes = boxes(unzip(await documentPptx({ document: DOCUMENT, pages: [page] })).get('ppt/slides/slide1.xml'));
  assert.equal(/ b="1"| i="1"/.test(shapes[0]), false, 'a plain run claims neither');
  assert.match(shapes[1], /sz="1100" b="1" dirty="0"/);
  assert.match(shapes[2], /sz="1100" i="1" dirty="0"/);
  assert.equal(/<a:solidFill>/.test(shapes[0]), false, 'no colour is invented for the text');
});

test('markup in the document\u2019s text is written as text, not as markup', async () => {
  const { block, run } = lineBlock('b1', '<a:p> & "quoted"', [72, 700, 200, 712]);
  const slide = unzip(await documentPptx({ document: DOCUMENT, pages: [fakePage({ blocks: [block], runs: [run] })] })).get('ppt/slides/slide1.xml');
  assert.equal(textOf(boxes(slide)[0]), '<a:p> & "quoted"');
});

test('a link the PDF draws over a run becomes a PowerPoint hyperlink to that URL', async () => {
  const { block, run } = lineBlock('b1', 'Visit the project page', [72, 617, 180, 629]);
  const page = fakePage({
    blocks: [block], runs: [run],
    links: [{ id: 'l1', url: 'https://example.com/a&b', internal: false, box: [72, 615, 200, 632] }],
  });
  const parts = unzip(await documentPptx({ document: DOCUMENT, pages: [page] }));
  assert.match(parts.get('ppt/slides/slide1.xml'), /<a:hlinkClick r:id="rId2"\/>/);
  assert.match(parts.get('ppt/slides/_rels/slide1.xml.rels'), /Id="rId2".*Target="https:\/\/example\.com\/a&amp;b" TargetMode="External"/);

  // A run the link's own rectangle doesn't cover is not linked: no link is inferred from being nearby.
  const apart = fakePage({ blocks: [block], runs: [run], links: [{ id: 'l1', url: 'https://example.com/', internal: false, box: [72, 300, 200, 320] }] });
  assert.equal(/<a:hlinkClick/.test(unzip(await documentPptx({ document: DOCUMENT, pages: [apart] })).get('ppt/slides/slide1.xml')), false);
});

// ---- page ordering --------------------------------------------------------------------------------------

test('one page is one slide, and the page order is the slide order', async () => {
  const pageOf = (number, text) => {
    const { block, run } = lineBlock(`b${number}`, text, [72, 700, 200, 712]);
    return fakePage({ number, blocks: [block], runs: [run] });
  };
  const parts = unzip(await documentPptx({ document: DOCUMENT, pages: [pageOf(3, 'Three'), pageOf(4, 'Four'), pageOf(5, 'Five')] }));
  assert.deepEqual([1, 2, 3].map((n) => textOf(parts.get(`ppt/slides/slide${n}.xml`))), ['Three', 'Four', 'Five']);
  assert.equal(parts.has('ppt/slides/slide4.xml'), false, 'three pages, three slides');

  // The deck lists them in that order, and each entry names its own slide.
  const presentation = parts.get('ppt/presentation.xml');
  assert.match(presentation, /<p:sldIdLst><p:sldId id="256" r:id="rId2"\/><p:sldId id="257" r:id="rId3"\/><p:sldId id="258" r:id="rId4"\/><\/p:sldIdLst>/);
  const rels = parts.get('ppt/_rels/presentation.xml.rels');
  for (const n of [1, 2, 3]) assert.match(rels, new RegExp(`Id="rId${n + 1}"[^>]*Target="slides/slide${n}\\.xml"`));
});

// ---- tables ----------------------------------------------------------------------------------------------

test('a confident table becomes a PowerPoint table of real cells, its empty cell kept', async () => {
  const { page, tables } = await readPage(await pdfOf(PAGE));
  assert.equal(tables.get(1).length, 1, 'the existing extraction finds the table');
  const slide = unzip(await documentPptx({ document: DOCUMENT, pages: [page], tables })).get('ppt/slides/slide1.xml');

  const frames = [...slide.matchAll(/<p:graphicFrame>(.*?)<\/p:graphicFrame>/gs)].map(([, f]) => f);
  assert.equal(frames.length, 1, 'one table, one frame');
  const rows = [...frames[0].matchAll(/<a:tr [^>]*>(.*?)<\/a:tr>/gs)].map(([, row]) =>
    [...row.matchAll(/<a:tc>(.*?)<\/a:tc>/gs)].map(([, cell]) => textOf(cell)));
  assert.deepEqual(rows, [['Site', 'Count', 'Depth'], ['North', '12', ''], ['South', '31', '4.2']]);
  assert.equal((frames[0].match(/<a:gridCol /g) ?? []).length, 3, 'the grid has the table\u2019s columns');
  assert.match(frames[0], /uri="http:\/\/schemas\.openxmlformats\.org\/drawingml\/2006\/table"/);

  // The table's text is not also written as loose text boxes.
  assert.equal((textOf(slide).match(/North/g) ?? []).length, 1);
  const text = textOf(slide);
  assert.ok(text.indexOf('Field results') < text.indexOf('The samples were taken'), 'the title comes first');
  assert.ok(text.indexOf('The samples were taken') < text.indexOf('Site'), 'then the text, then the table');
});

// ---- page dimensions -------------------------------------------------------------------------------------

test('the deck keeps the page\u2019s dimensions, and a turned page is as it is shown', async () => {
  const a4 = fakePage({ box: [0, 0, 595.28, 841.89] });
  assert.deepEqual(deckSize([a4]), { width: 595.28, height: 841.89 });
  const presentation = unzip(await documentPptx({ document: DOCUMENT, pages: [a4] })).get('ppt/presentation.xml');
  assert.match(presentation, /<p:sldSz cx="7560056" cy="10692003"\/>/, 'A4 in EMU, the page\u2019s own aspect');

  // A page with its own /Rotate is the size a person sees, not the size it is stored at.
  assert.deepEqual(shownSize(fakePage({ box: [0, 0, 612, 792], rotate: 90 })), { width: 792, height: 612 });
  assert.deepEqual(shownSize(fakePage({ box: [0, 0, 612, 792], rotate: 0 })), { width: 612, height: 792 });

  // An offset box (a crop box that doesn't start at the origin) measures from its own corner.
  assert.deepEqual(deckSize([fakePage({ box: [20, 30, 320, 430] })]), { width: 300, height: 400 });
});

test('a turned page\u2019s text is placed and turned as the page is shown', async () => {
  const box = [72, 690, 200, 706];
  const at = placeBox(box, fakePage({ box: [0, 0, 612, 792], rotate: 90 }));
  // Rotated a quarter turn clockwise, the top-left of the page is at the top-right of the slide.
  assert.equal(at.rot, 90);
  assert.ok(Math.abs(at.x + at.cx / 2 - 698) < 1 && Math.abs(at.y + at.cy / 2 - 136) < 1, `centre at ${at.x + at.cx / 2}, ${at.y + at.cy / 2}`);

  const { block, run } = lineBlock('b1', 'Turned', box);
  const slide = unzip(await documentPptx({ document: DOCUMENT, pages: [fakePage({ blocks: [block], runs: [run], rotate: 90 })] })).get('ppt/slides/slide1.xml');
  assert.match(slide, /<a:xfrm rot="5400000">/, 'the box is turned with the page');
});

// ---- content the model can\u2019t give safely ----------------------------------------------------------------

test('nothing is rasterized, and an image the model has no pixels for is left out, not guessed', async () => {
  const { block, run } = lineBlock('b1', 'Above the picture', [72, 700, 220, 712]);
  const page = {
    ...fakePage({ blocks: [block], runs: [run] }),
    images: [{ id: 'p1:img1', key: 'img1', box: [72, 400, 400, 650], quad: null, inline: false, inserted: false, pixels: [800, 600] }],
  };
  const parts = unzip(await documentPptx({ document: DOCUMENT, pages: [page] }));
  assert.equal([...parts.keys()].some((n) => /media|\.png$|\.jpe?g$/i.test(n)), false, 'no picture part, and no picture of the page');
  assert.equal(/<p:pic>|<a:blip/.test(parts.get('ppt/slides/slide1.xml')), false, 'and no empty placeholder invented for it');
  assert.equal(boxes(parts.get('ppt/slides/slide1.xml')).length, 1, 'only the text the model can vouch for');
});

test('a page whose text is not read says so instead of being filled in', async () => {
  const locked = { number: 1, contentRead: false, box: [0, 0, 612, 792], rotate: 0, blocks: [], runs: [], links: [] };
  const slide = unzip(await documentPptx({ document: DOCUMENT, pages: [locked] })).get('ppt/slides/slide1.xml');
  assert.match(textOf(slide), /Vellum doesn\u2019t read the text of a protected PDF/);
  assert.equal(/<a:tbl>|<p:pic>/.test(slide), false, 'and nothing was made up for it');
});

test('a block with no box of its own is left out rather than placed somewhere invented', async () => {
  const page = fakePage({
    blocks: [{ id: 'b1', kind: 'line', text: 'Nowhere', runIds: ['r1'], box: null }],
    runs: [{ id: 'r1', text: 'Nowhere', font: 'Helvetica', size: 11, box: null }],
  });
  assert.equal(pageShapes(page), '');
});

// ---- a package a reader can open --------------------------------------------------------------------------

test('the deck a reader opens is structurally whole', async () => {
  const { page, tables } = await readPage(await pdfOf(PAGE));
  const parts = unzip(await documentPptx({ document: DOCUMENT, pages: [page], tables }));
  for (const name of ['[Content_Types].xml', '_rels/.rels', 'docProps/core.xml', 'ppt/presentation.xml',
    'ppt/_rels/presentation.xml.rels', 'ppt/slideMasters/slideMaster1.xml', 'ppt/slideMasters/_rels/slideMaster1.xml.rels',
    'ppt/slideLayouts/slideLayout1.xml', 'ppt/slideLayouts/_rels/slideLayout1.xml.rels', 'ppt/theme/theme1.xml',
    'ppt/slides/slide1.xml', 'ppt/slides/_rels/slide1.xml.rels']) {
    assert.ok(parts.has(name), name);
  }
  // Every part is declared, and every relationship points at a part that is in the package.
  const types = parts.get('[Content_Types].xml');
  for (const name of ['/ppt/presentation.xml', '/ppt/slides/slide1.xml', '/ppt/slideMasters/slideMaster1.xml',
    '/ppt/slideLayouts/slideLayout1.xml', '/ppt/theme/theme1.xml', '/docProps/core.xml']) {
    assert.ok(types.includes(`PartName="${name}"`), name);
  }
  for (const [name, xml] of parts) {
    if (!name.endsWith('.rels')) continue;
    const base = name.replace(/_rels\/[^/]+$/, '');
    for (const [, target] of xml.matchAll(/Target="([^"]+)"(?! TargetMode)/g)) {
      const resolved = new URL(target, `vellum:/${base}`).pathname.replace(/^\//, '');
      assert.ok(parts.has(resolved), `${name} points at ${resolved}`);
    }
  }
  // Every slide's XML is balanced and its own shape ids are unique.
  const slide = parts.get('ppt/slides/slide1.xml');
  assert.equal((slide.match(/<p:sp>/g) ?? []).length, (slide.match(/<\/p:sp>/g) ?? []).length);
  const ids = [...slide.matchAll(/<p:cNvPr id="(\d+)"/g)].map(([, id]) => id);
  assert.equal(new Set(ids).size, ids.length, 'no shape id is used twice');
  assert.match(parts.get('docProps/core.xml'), /Exported from field\.pdf by Vellum \u2014 page 1\./);
});

// ---- determinism and the source document ---------------------------------------------------------------

test('the same document and pages give the same PowerPoint file, byte for byte', async () => {
  const { page, tables } = await readPage(await pdfOf(PAGE));
  const once = await documentPptx({ document: DOCUMENT, pages: [page], tables });
  const again = await documentPptx({ document: DOCUMENT, pages: [page], tables });
  assert.deepEqual([...once], [...again]);
});

test('a PowerPoint export writes one file through the shared run, and never changes the PDF', async () => {
  const bytes = await pdfOf(PAGE);
  const before = crypto.createHash('sha256').update(bytes).digest('hex');
  const { page, tables } = await readPage(bytes);
  const plan = model.exportPlan({ fileName: 'field.pdf', formatId: 'powerpoint', pages: [1], pageCount: 1 });
  const written = new Map();
  const result = await runExport({
    plan,
    targets: plan.files.map((f, i) => ({ name: f.name, path: `C:\\out\\${f.name}`, token: `t${i}` })),
    produce: () => documentPptx({ document: DOCUMENT, pages: [page], tables }),
    write: (target, data) => { written.set(target.name, data); return data.byteLength; },
  });
  assert.equal(result.ok, true);
  assert.deepEqual([...written.keys()], ['field.pptx']);
  assert.deepEqual([...written.get('field.pptx').subarray(0, 4)], [0x50, 0x4b, 0x03, 0x04], 'a ZIP, as .pptx is');
  assert.equal(model.describeResult(result), 'Exported 1 file');
  assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), before);
});
