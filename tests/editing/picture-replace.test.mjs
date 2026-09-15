// Vellum 0.5.0 should-have: replacing a picture's image with a PNG or JPEG from a file.
//
// The replaced draw keeps its frame — the image is drawn into the same unit square under the same
// CTM, clip and marked content — and only its resource name changes, to a new /XObject entry for the
// embedded image. The old resource is released on exactly the terms a deleted picture's is. What is
// pinned here: the file really holds the new image, where the old one was drawn; shared resources
// stay for the draws that still use them; a moved or turned picture keeps its placement; one undo
// step; unusable files, inline images and PDF/A documents are refused before anything is stored.
// Run: node --test "tests/editing/*.test.mjs"

import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import zlib from 'node:zlib';
import { analyzeFile, engine, loadPdfLib, webModule, withSession } from './harness.mjs';
import { makeFixtures, FIXTURE_DIR } from './fixtures.mjs';

const { openSource } = await engine('source.js');
const { EditError } = await engine('edits.js');
const { planImageEdit, readPicture, replaceRefusal } = await engine('objects/image.js');
const { objectsOf } = await engine('objects/page-objects.js');
const { apply, multiply } = await engine('matrix.js');
const { quarterTurn, flip } = await engine('objects/transform.js');
const { composeDocument } = await webModule('annotations/persist.js');
const { identityPlan } = await webModule('pages/plan.js');

let files;
before(async () => { files = await makeFixtures(FIXTURE_DIR); });
const read = (name) => new Uint8Array(fs.readFileSync(files[name]));

/** A PNG of `width` × `height` pixels, RGBA when `alpha` (some pixels half transparent), else RGB. */
function png(width, height, { alpha = false } = {}) {
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const out = Buffer.alloc(body.length + 8);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(zlib.crc32(body), body.length + 4);
    return out;
  };
  const channels = alpha ? 4 : 3;
  const rows = [];
  for (let y = 0; y < height; y++) {
    const row = Buffer.alloc(1 + width * channels);
    for (let x = 0; x < width; x++) {
      const at = 1 + x * channels;
      row[at] = (x * 40) & 255;
      row[at + 1] = (y * 60) & 255;
      row[at + 2] = 90;
      if (alpha) row[at + 3] = x % 2 ? 128 : 255;
    }
    rows.push(row);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, alpha ? 6 : 2, 0, 0, 0], 8);
  return new Uint8Array(Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header), chunk('IDAT', zlib.deflateSync(Buffer.concat(rows))), chunk('IEND', Buffer.alloc(0)),
  ]));
}

/** A 4 × 2 baseline JPEG (made once with System.Drawing). */
const JPEG = new Uint8Array(Buffer.from('/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoHBwYIDAoMDAsKCwsNDhIQDQ4RDgsLEBYQERMUFRUVDA8XGBYUGBIUFRT/2wBDAQMEBAUEBQkFBQkUDQsNFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBT/wAARCAACAAQDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDn/h74l1f/AIRe1/4mt7/4EP6D3ooor+ZMX/Hn6s93If8AkVYb/BH8j//Z', 'base64'));

/** The page's pictures as the object model names them, in drawing order. */
const imagesOf = async (bytes, page = 0) => objectsOf((await analyzeFile(bytes)).pages[page]).filter((o) => o.kind === 'image');

/** A page's content stream, and its /XObject entries by name (resolved), in a saved file. */
async function pageOf(bytes, index = 0) {
  const lib = await loadPdfLib();
  const doc = await lib.PDFDocument.load(bytes, { updateMetadata: false });
  const page = doc.getPages()[index];
  const source = await openSource(lib, bytes);
  const content = Buffer.from(source.contentBytes(page.node)).toString('latin1');
  const dict = page.node.Resources()?.lookup(lib.PDFName.of('XObject'));
  const xobjects = new Map(dict instanceof lib.PDFDict
    ? dict.keys().map((k) => [k.asString().slice(1), doc.context.lookup(dict.get(k))]) : []);
  const get = (stream, key) => doc.context.lookup(stream.dict.get(lib.PDFName.of(key)));
  return { lib, doc, content, xobjects, get };
}

/** The record the session would store: a replacement, with its bytes in `sources` under `source`. */
async function replacing(object, bytes, entry, sources, { source = `src${sources.size}`, transform = null } = {}) {
  sources.set(source, bytes);
  const picture = await readPicture(await loadPdfLib(), bytes);
  return planImageEdit({ object, transform, replacement: { source, ...picture }, entry });
}

const cornersOf = (m) => [[0, 0], [1, 0], [1, 1], [0, 1]].map(([x, y]) => apply(m, x, y));
const near = (a, b, tol) => a.every((p, i) => Math.hypot(p[0] - b[i][0], p[1] - b[i][1]) <= tol);
const countOf = (haystack, needle) => haystack.split(needle).length - 1;

test('a picture is replaced in place: same frame, same drawing order, and the file holds the new image', async () => {
  const bytes = read('images');
  const plan = identityPlan(1);
  const [first, second] = await imagesOf(bytes);
  const sources = new Map();
  const record = await replacing(first, JPEG, plan[0].id, sources);
  assert.deepEqual(record.replacement, { source: 'src0', format: 'jpeg', width: 4, height: 2 });
  const saved = await composeDocument({ base: bytes, plan, edits: [record], sources });

  const after = await imagesOf(saved);
  assert.equal(after.length, 2, 'still two pictures');
  // (A rewritten page is wrapped in one more q … Q, so operator numbers move up by one; the order doesn't.)
  assert.deepEqual(after.map((o) => o.ref.opIndex - 1), [first.ref.opIndex, second.ref.opIndex], 'at the same places in the drawing order');
  assert.deepEqual(after[0].record.ctm, first.record.ctm, 'drawn into exactly the same frame');
  assert.deepEqual([after[0].record.info.width, after[0].record.info.height], [4, 2], 'the new image, at its own size');
  assert.deepEqual(after[1].record.ctm, second.record.ctm);
  assert.equal(after[1].record.name, 'Im1', 'the other draw is untouched');

  const { content, xobjects, get, lib } = await pageOf(saved);
  assert.equal(countOf(content, '/Im1 Do'), 1);
  assert.match(content, /q 200 0 0 150 72 500 cm\s+\/VlImg1 Do\s+Q/, 'only the name changed');
  assert.deepEqual([...xobjects.keys()].sort(), ['Im1', 'VlImg1'], 'the shared resource stays for the draw that still uses it');
  const embedded = xobjects.get('VlImg1');
  assert.equal(get(embedded, 'Filter').asString(), '/DCTDecode', 'the JPEG is embedded as it is, not re-encoded');
  assert.deepEqual(Buffer.from(embedded.getContents()), Buffer.from(JPEG), 'byte for byte');
  assert.ok(get(embedded, 'Width') instanceof lib.PDFNumber);
});

test('replacing the last draw of a resource releases it, and its bytes leave the file', async () => {
  const bytes = read('images');
  const plan = identityPlan(1);
  const images = await imagesOf(bytes);
  const sources = new Map();
  const edits = [];
  for (const o of images) edits.push(await replacing(o, png(6, 3), plan[0].id, sources));
  const saved = await composeDocument({ base: bytes, plan, edits, sources });
  const { content, xobjects } = await pageOf(saved);
  assert.deepEqual([...xobjects.keys()].sort(), ['VlImg1', 'VlImg2'], 'Im1 is gone, one new name per replaced draw');
  assert.equal(countOf(content, '/Im1 Do'), 0);
  // The 32 × 32 original is collected because nothing reaches it; the new PNGs are 6 × 3.
  const after = await imagesOf(saved);
  assert.deepEqual(after.map((o) => [o.record.info.width, o.record.info.height]), [[6, 3], [6, 3]]);
  const lib = await loadPdfLib();
  const doc = await lib.PDFDocument.load(saved, { updateMetadata: false });
  const sizes = doc.context.enumerateIndirectObjects()
    .map(([, o]) => o).filter((o) => o instanceof lib.PDFRawStream && o.dict.get(lib.PDFName.of('Subtype'))?.asString() === '/Image')
    .map((o) => o.dict.get(lib.PDFName.of('Width')).asNumber());
  assert.deepEqual(sizes, [6, 6], 'no 32-pixel image is left in the file');
});

test('a page drawing a form keeps the old resource, and a PNG with transparency keeps its alpha', async () => {
  const bytes = read('objects');
  const plan = identityPlan(1);
  const plain = (await imagesOf(bytes)).find((o) => o.ref.stream === 'page' && o.record.name === 'Im1');
  const sources = new Map();
  const saved = await composeDocument({ base: bytes, plan, edits: [await replacing(plain, png(4, 4, { alpha: true }), plan[0].id, sources)], sources });
  const { xobjects, get, lib } = await pageOf(saved);
  assert.ok(xobjects.has('Im1'), 'a form on the page may reach Im1 through the page, so it stays');
  assert.ok(get(xobjects.get('VlImg1'), 'SMask') instanceof lib.PDFRawStream, 'the transparency is the image’s own soft mask');
  // Every other picture on the page is exactly where it was.
  const before = await imagesOf(bytes);
  const after = await imagesOf(saved);
  assert.deepEqual(after.map((o) => [o.ref.stream, o.record.ctm]), before.map((o) => [o.ref.stream, o.record.ctm]));
});

test('a moved, turned and mirrored picture keeps its placement when replaced, and when moved again', async () => {
  const bytes = read('objects');
  const plan = identityPlan(1);
  const turned = (await imagesOf(bytes))[1]; // turned a quarter by its own CTM
  const T = multiply(quarterTurn([300, 660], 1), flip(turned.record.ctm, 'horizontal'));
  const sources = new Map();
  const record = await replacing(turned, JPEG, plan[0].id, sources, { transform: T });
  const saved = await composeDocument({ base: bytes, plan, edits: [record], sources });
  const again = (await imagesOf(saved)).find((o) => o.record.info?.width === 4 && o.record.info?.height === 2);
  assert.ok(again, 'the new image is on the page');
  assert.ok(near(cornersOf(again.record.ctm), cornersOf(multiply(turned.record.ctm, record.transform)), 0.02),
    'every corner exactly where the moved picture was');
  assert.equal(again.capabilities.replace, true, 'and it can be replaced again after a save');
});

test('pages that inherit one resource: only the replaced page changes, and a duplicate shares the one embedded image', async () => {
  const bytes = read('gallery'); // three pages drawing Im1 from resources inherited from the page tree
  const { duplicateEntries } = await webModule('pages/plan.js');
  const { followEdits } = await engine('edits.js');
  const base = identityPlan(3);
  const sources = new Map();
  const record = await replacing((await imagesOf(bytes, 0))[0], JPEG, base[0].id, sources);
  const { plan, copies } = duplicateEntries(base, new Set([base[0].id]));
  const edits = [record, ...followEdits([record], plan, copies).map((c) => c.edit.after)];
  const saved = await composeDocument({ base: bytes, plan, edits, sources });

  const lib = await loadPdfLib();
  const doc = await lib.PDFDocument.load(saved, { updateMetadata: false });
  const perPage = doc.getPages().map((p) => {
    const xo = p.node.Resources()?.lookup(lib.PDFName.of('XObject'));
    return xo instanceof lib.PDFDict ? xo.keys().map((k) => [k.decodeText(), xo.get(k).toString()]) : [];
  });
  assert.deepEqual(perPage.map((names) => names.map(([n]) => n)), [['VlImg1'], ['VlImg1'], ['Im1'], ['Im1']],
    'the page and its copy draw the new image; the other two pages keep Im1');
  assert.equal(perPage[0][0][1], perPage[1][0][1], 'one embedded image object, shared by the page and its copy');
  const widths = [];
  for (let i = 0; i < 4; i++) widths.push((await imagesOf(saved, i)).map((o) => o.record.info.width));
  const original = (await imagesOf(bytes, 1))[0].record.info.width;
  assert.notEqual(original, 4);
  assert.deepEqual(widths, [[4], [4], [original], [original]], 'the new image on the page and its copy, the original on the others');
});

test('what can be replaced: the capability, and the refusals it shares with moving', async () => {
  const objects = await imagesOf(read('objects'));
  const verdicts = objects.map((o) => [o.ref.stream === 'page' ? o.ref.opIndex : 'form', o.record.inline, o.capabilities.replace]);
  for (const o of objects) {
    const expected = replaceRefusal(o.record, o.ref) ?? true;
    assert.equal(o.capabilities.replace, expected, `${o.ref.key}`);
    if (o.capabilities.move !== true) assert.notEqual(o.capabilities.replace, true, `${o.ref.key}: what can’t be moved can’t be replaced`);
  }
  assert.equal(objects.find((o) => o.record.inline).capabilities.replace, 'unsupported', 'an inline image names no resource to swap');
  assert.ok(verdicts.some(([, , v]) => v === true), JSON.stringify(verdicts));
  const text = objectsOf((await analyzeFile(read('objects'))).pages[0]).find((o) => o.kind === 'text-run');
  assert.notEqual(text.capabilities.replace, true, 'text is never replaced with a picture');
});

test('unusable files are refused before anything is stored', async () => {
  const lib = await loadPdfLib();
  const gif = new Uint8Array(Buffer.from('GIF89a\x01\x00\x01\x00\x00\x00\x00;', 'latin1'));
  const broken = png(5, 5).slice(0, 40); // a real PNG header, cut off
  const huge = png(1, 1); // a header claiming 20000 × 20000 pixels: refused before anything is decoded
  new DataView(huge.buffer).setUint32(16, 20000);
  new DataView(huge.buffer).setUint32(20, 20000);
  await assert.rejects(readPicture(lib, huge), (err) => err.kind === 'picture' && /too large/.test(err.message));
  for (const [what, bytes] of [['a GIF', gif], ['a cut-off PNG', broken], ['nothing', new Uint8Array(0)], ['not bytes', 'data']]) {
    await assert.rejects(readPicture(lib, bytes), (err) => err instanceof EditError && err.kind === 'picture', what);
  }
  assert.deepEqual(await readPicture(lib, png(3, 7)), { format: 'png', width: 3, height: 7 });
});

test('the session replaces a picture as one record and one undo step, and moving it keeps the new image', async () => {
  await withSession(read('images'), async ({ store, session, sources, bytes, plan }) => {
    const { objects } = await session.objects(1);
    const [picture] = objects.filter((o) => o.kind === 'image');
    const text = objects.find((o) => o.kind === 'text-run');
    assert.equal(await session.transformObject(1, picture.ref.key, [1, 0, 0, 1, 15, -10]), true);
    assert.equal(await session.replaceImage(1, picture.ref.key, JPEG), true);
    assert.equal(store.edits.length, 1, 'still one record for the picture');
    const [record] = store.edits;
    assert.deepEqual(record.transform, [1, 0, 0, 1, 15, -10], 'where it was moved to');
    assert.equal(sources.get(record.replacement.source), JPEG, 'the bytes are kept in the document’s sources');

    // Moved back where it started, it keeps its record: the replacement is still a change.
    assert.equal(await session.transformObject(1, picture.ref.key, [1, 0, 0, 1, -15, 10]), true);
    assert.equal(store.edits.length, 1);
    assert.ok(store.edits[0].replacement, 'the replacement survives the move');
    const saved = await composeDocument({ base: bytes, plan, edits: store.edits, sources });
    const [after] = await imagesOf(saved);
    assert.deepEqual([after.record.ctm, after.record.info.width], [picture.record.ctm, 4], 'the new image, in the original frame');

    // Undo: back to the moved original picture, then to nothing. Redo brings the replacement back.
    assert.equal(store.undo(), true);
    assert.equal(store.undo(), true);
    assert.deepEqual([store.edits.length, store.edits[0].replacement], [1, undefined], 'one undo step took the replacement away');
    assert.equal(store.redo(), true);
    assert.equal(store.edits[0].replacement.format, 'jpeg');

    await assert.rejects(session.replaceImage(1, text.ref.key, JPEG), (err) => err.kind === 'not-editable', 'text is refused');
    await assert.rejects(session.replaceImage(1, picture.ref.key, new Uint8Array([1, 2, 3])), (err) => err.kind === 'picture');
    assert.equal(store.edits.length, 1, 'and neither refusal stored anything');

    // Deleting a replaced picture removes its draw; nothing of the replacement is written.
    await session.removeObject(1, picture.ref.key);
    const gone = await composeDocument({ base: bytes, plan, edits: store.edits, sources });
    assert.equal((await imagesOf(gone)).length, 1);
    assert.equal((await pageOf(gone)).xobjects.has('VlImg1'), false);
  });
});

test('a PDF/A document is refused, by the session and by the writer', async () => {
  await withSession(read('pdfa'), async ({ session }) => {
    await assert.rejects(session.replaceImage(1, 'image:page#0', JPEG), (err) => err.kind === 'pdfa');
  });
  const bytes = read('images');
  const plan = identityPlan(1);
  const [first] = await imagesOf(bytes);
  const sources = new Map();
  const record = await replacing(first, JPEG, 'x', sources);
  // The same record against the PDF/A file never reaches its pages: the whole-document check stops it.
  const pdfa = read('pdfa');
  await assert.rejects(composeDocument({ base: pdfa, plan: identityPlan(1), edits: [{ ...record, entry: identityPlan(1)[0].id }], sources }),
    (err) => err.kind === 'pdfa');
  // And a record whose image has gone from the sources refuses the save rather than dropping the change.
  await assert.rejects(composeDocument({ base: bytes, plan, edits: [{ ...record, entry: plan[0].id }], sources: new Map() }),
    (err) => err.kind === 'missing');
});
