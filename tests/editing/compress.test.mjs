// Compress PDF V1 (optimize/compress.js): the copy is smaller and is the same document — the same
// pages, the same content streams byte for byte, the same resources, annotations, form fields and
// outline — and the source is never touched.
// Run: node --test "tests/editing/compress.test.mjs"

import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { loadPdfLib, openWithPdfjs, webModule } from './harness.mjs';
import { makeFixtures, FIXTURE_DIR } from './fixtures.mjs';

const { COMPRESSION_LEVELS, CompressError, compressDocument } = await webModule('optimize/compress.js');
const { compareInventory, inventory } = await webModule('optimize/inventory.js');

let files;
let lib;
const read = (name) => new Uint8Array(fs.readFileSync(files[name]));
before(async () => {
  files = await makeFixtures(FIXTURE_DIR);
  lib = await loadPdfLib();
});

const compress = (bytes, level = 'smaller') => compressDocument({ lib, bytes, level });

/**
 * A document with everything the optimizer is supposed to find: the same image stored three times,
 * an uncompressed content stream, and an object nothing points at any more.
 */
async function wasteful() {
  const { PDFDocument, PDFName, PDFRawStream } = lib;
  const doc = await PDFDocument.create({ updateMetadata: false });
  const ctx = doc.context;
  const font = doc.embedStandardFont(lib.StandardFonts.Helvetica).ref;
  // The same 40x40 grey image, stored once per page: identical bytes, identical dictionaries.
  const pixels = Uint8Array.from({ length: 40 * 40 * 3 }, (_, i) => (i * 7) % 251);
  const imageRefs = [0, 1, 2].map(() => ctx.register(ctx.flateStream(pixels, {
    Type: 'XObject', Subtype: 'Image', Width: 40, Height: 40, BitsPerComponent: 8, ColorSpace: 'DeviceRGB',
  })));
  imageRefs.forEach((ref, i) => {
    const page = doc.addPage([300, 300]);
    const content = `q 120 0 0 120 40 140 cm /Im0 Do Q BT /F1 12 Tf 20 40 Td (Page ${i + 1}) Tj ET`;
    // Stored with no filter at all: exactly what the "streams compressed" step is for.
    const stream = PDFRawStream.of(ctx.obj({}), new TextEncoder().encode(content.padEnd(2000, ' ')));
    page.node.set(PDFName.of('Contents'), ctx.register(stream));
    page.node.set(PDFName.of('Resources'), ctx.obj({ Font: { F1: font }, XObject: { Im0: ref } }));
  });
  // An object nothing refers to: the leftover of another program's incremental save.
  ctx.register(ctx.flateStream(new Uint8Array(4000).fill(65)));
  return doc.save({ useObjectStreams: false });
}

test('every level produces a valid PDF that pdf.js reopens with the same pages', async () => {
  const bytes = await wasteful();
  for (const level of COMPRESSION_LEVELS) {
    const report = await compress(bytes, level.id);
    assert.equal(report.level, level.id);
    const js = await openWithPdfjs(report.bytes);
    try {
      assert.equal(js.doc.numPages, 3);
      const text = await (await js.doc.getPage(2)).getTextContent();
      assert.equal(text.items.map((i) => i.str).join('').trim(), 'Page 2');
    } finally {
      await js.close();
    }
  }
});

test('the source bytes are not touched', async () => {
  const bytes = await wasteful();
  const copy = bytes.slice();
  const report = await compress(bytes);
  assert.deepEqual([...bytes], [...copy], 'compressing must not write into the bytes it was given');
  assert.notEqual(report.bytes, bytes);
});

test('what can be optimized is optimized, and the file gets smaller', async () => {
  const bytes = await wasteful();
  const report = await compress(bytes, 'safe');
  const step = (id) => report.steps.find((s) => s.id === id);
  assert.equal(step('merge').count, 2, 'the same image stored three times becomes one object');
  assert.ok(step('compress').count >= 3, 'the unfiltered page content streams are stored with Flate');
  assert.ok(step('unused').count >= 1, 'the object nothing points at is removed');
  assert.ok(report.after < report.before, `${report.after} should be under ${report.before}`);
  assert.equal(report.saved, report.before - report.after);
  assert.equal(report.identical, false);
});

test('“Smaller file” is smaller than “Standard”, and both keep the document', async () => {
  const bytes = await wasteful();
  const safe = await compress(bytes, 'safe');
  const smaller = await compress(bytes, 'smaller');
  assert.ok(smaller.after < safe.after, `${smaller.after} should be under ${safe.after}`);
  const source = await inventory(lib, bytes);
  for (const report of [safe, smaller]) {
    assert.deepEqual(compareInventory(source, await inventory(lib, report.bytes)), []);
  }
});

test('the same document compressed twice gives the same bytes', async () => {
  const bytes = await wasteful();
  for (const level of ['safe', 'smaller']) {
    const a = await compress(bytes, level);
    const b = await compress(bytes, level);
    assert.deepEqual([...a.bytes], [...b.bytes], `${level} must be deterministic`);
  }
});

test('page count and page content are preserved, page for page', async () => {
  for (const name of ['multipage', 'columns', 'images', 'large', 'form-xobjects']) {
    const bytes = read(name);
    const report = await compress(bytes);
    const before = await inventory(lib, bytes);
    const after = await inventory(lib, report.bytes);
    assert.equal(after.pageCount, before.pageCount, name);
    assert.deepEqual(after.pages.map((p) => p.contentHash), before.pages.map((p) => p.contentHash), `${name}: content streams`);
    assert.deepEqual(compareInventory(before, after), [], name);
  }
});

test('forms, links, annotations and bookmarks are not silently lost', async () => {
  for (const name of ['form', 'annotations', 'bookmarks', 'structure']) {
    const bytes = read(name);
    const before = await inventory(lib, bytes);
    const report = await compress(bytes);
    const after = await inventory(lib, report.bytes);
    assert.deepEqual(after.fields, before.fields, `${name}: form fields`);
    assert.equal(after.outline, before.outline, `${name}: outline`);
    assert.deepEqual(after.pages.map((p) => p.annotations), before.pages.map((p) => p.annotations), `${name}: annotations`);
    assert.deepEqual(compareInventory(before, after), [], name);
  }
  // The fixtures must actually hold what this claims to check, or the test proves nothing.
  const form = await inventory(lib, read('form'));
  assert.ok(form.fields.length > 0, 'the form fixture has form fields');
  const annotated = await inventory(lib, read('annotations'));
  assert.ok(annotated.pages.some((p) => p.annotations.some((a) => a.startsWith('Link'))), 'the annotations fixture has a link');
  assert.ok(annotated.pages.some((p) => p.annotations.some((a) => a.startsWith('Text'))), 'the annotations fixture has a note');
  assert.ok(annotated.pages.some((p) => p.annotations.some((a) => a.startsWith('Widget'))), 'the annotations fixture has a form widget');
});

test('a file with nothing left to save comes back as an exact copy, never bigger', async () => {
  const first = await compress(read('multipage'), 'smaller');
  const again = await compress(first.bytes, 'smaller');
  assert.equal(again.identical, true);
  assert.deepEqual([...again.bytes], [...first.bytes]);
  assert.equal(again.saved, 0);
});

test('a protected PDF is refused, and nothing is produced', async () => {
  await assert.rejects(() => compress(read('encrypted-structure')), (err) => {
    assert.ok(err instanceof CompressError);
    assert.match(err.message, /protected/i);
    return true;
  });
});

test('a signed PDF is compressed but the copy says the signature is not carried over', async () => {
  const report = await compress(read('signed'));
  assert.ok(report.warnings.some((w) => /signed/i.test(w)), report.warnings.join(' | '));
});

test('a result that lost something is refused and never handed back', async () => {
  const bytes = await wasteful();
  const { compareInventory: compare, inventory: take } = await webModule('optimize/inventory.js');
  const before = await take(lib, bytes);
  // A copy with its last page removed is exactly what the check has to catch.
  const doc = await lib.PDFDocument.load(bytes, { updateMetadata: false });
  doc.removePage(2);
  const damaged = await take(lib, await doc.save({ useObjectStreams: false }));
  const differences = compare(before, damaged);
  assert.ok(differences.length, 'losing a page must be reported');
  assert.match(differences[0], /3 pages and the result has 2/);
});

test('changed page content is caught, not just a changed page count', async () => {
  const bytes = read('multipage');
  const before = await inventory(lib, bytes);
  const doc = await lib.PDFDocument.load(bytes, { updateMetadata: false });
  const page = doc.getPages()[0];
  page.node.set(lib.PDFName.of('Contents'), doc.context.register(doc.context.flateStream('BT ET')));
  const differences = compareInventory(before, await inventory(lib, await doc.save({ useObjectStreams: false })));
  assert.ok(differences.some((d) => /content is not the same/.test(d)), differences.join(' | '));
});

test('streams are merged only when their dictionaries match too', async () => {
  const { PDFDocument, PDFName } = lib;
  const doc = await PDFDocument.create({ updateMetadata: false });
  const ctx = doc.context;
  const pixels = Uint8Array.from({ length: 300 }, (_, i) => i % 256);
  // The same bytes, but one is 10x10 and the other 5x20: they must stay two objects.
  const a = ctx.register(ctx.flateStream(pixels, { Type: 'XObject', Subtype: 'Image', Width: 10, Height: 10, BitsPerComponent: 8, ColorSpace: 'DeviceRGB' }));
  const b = ctx.register(ctx.flateStream(pixels, { Type: 'XObject', Subtype: 'Image', Width: 5, Height: 20, BitsPerComponent: 8, ColorSpace: 'DeviceRGB' }));
  const page = doc.addPage([200, 200]);
  page.node.set(PDFName.of('Contents'), ctx.register(ctx.flateStream('q 50 0 0 50 10 10 cm /A Do Q q 50 0 0 50 80 10 cm /B Do Q')));
  page.node.set(PDFName.of('Resources'), ctx.obj({ XObject: { A: a, B: b } }));
  const report = await compress(await doc.save({ useObjectStreams: false }), 'safe');
  assert.equal(report.steps.find((s) => s.id === 'merge').count, 0);
  const after = await inventory(lib, report.bytes);
  assert.ok(after.pages[0].resources.some((r) => /XObject\/A=Image 10x10/.test(r)), after.pages[0].resources.join(' | '));
  assert.ok(after.pages[0].resources.some((r) => /XObject\/B=Image 5x20/.test(r)), after.pages[0].resources.join(' | '));
});

test('a stopped run produces nothing', async () => {
  const stop = new AbortController();
  stop.abort();
  await assert.rejects(() => compressDocument({ lib, bytes: read('multipage'), level: 'safe', signal: stop.signal }),
    (err) => err instanceof CompressError);
});
