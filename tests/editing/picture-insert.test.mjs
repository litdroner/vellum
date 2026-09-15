// Vellum 0.5.0 should-have: putting a PNG or JPEG from a file on a page as a new picture.
//
// An inserted picture is its own record (objects/inserted-image.js): the image in the document's
// sources and a transform from its unit square into the page's user space, drawn after the page's own
// content under a new /XObject name. What is pinned here: where a new picture starts (centred, upright
// as shown, never enlarged); the file draws it exactly there, with nothing already on the page
// changed; it is an object like any picture — moved, replaced, deleted, one undo step each; blank and
// duplicated pages; and unusable files and PDF/A documents refused before anything is stored.
// Run: node --test "tests/editing/*.test.mjs"

import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import zlib from 'node:zlib';
import { analyzeFile, engine, loadPdfLib, openWithPdfjs, webModule, withSession } from './harness.mjs';
import { makeFixtures, FIXTURE_DIR } from './fixtures.mjs';

const { openSource } = await engine('source.js');
const { readPicture } = await engine('objects/image.js');
const { defaultPlacement, planInsertion, keyOf } = await engine('objects/inserted-image.js');
const { objectsOf } = await engine('objects/page-objects.js');
const { apply, multiply } = await engine('matrix.js');
const { followEdits } = await engine('edits.js');
const { composeDocument } = await webModule('annotations/persist.js');
const { identityPlan } = await webModule('pages/plan.js');

let files;
before(async () => { files = await makeFixtures(FIXTURE_DIR); });
const read = (name) => new Uint8Array(fs.readFileSync(files[name]));

/** An RGB PNG of `width` × `height` pixels. */
function png(width, height) {
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const out = Buffer.alloc(body.length + 8);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(zlib.crc32(body), body.length + 4);
    return out;
  };
  const rows = Buffer.alloc((1 + width * 3) * height, 90);
  for (let y = 0; y < height; y++) rows[y * (1 + width * 3)] = 0;
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8);
  return new Uint8Array(Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header), chunk('IDAT', zlib.deflateSync(rows)), chunk('IEND', Buffer.alloc(0)),
  ]));
}

/** A 4 × 2 baseline JPEG (the one picture-replace.test.mjs uses). */
const JPEG = new Uint8Array(Buffer.from('/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoHBwYIDAoMDAsKCwsNDhIQDQ4RDgsLEBYQERMUFRUVDA8XGBYUGBIUFRT/2wBDAQMEBAUEBQkFBQkUDQsNFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBT/wAARCAACAAQDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDn/h74l1f/AIRe1/4mt7/4EP6D3ooor+ZMX/Hn6s93If8AkVYb/BH8j//Z', 'base64'));

/** What pdf.js calls the page's shown basis at scale 1 (page-space.js displayBasis), and its crop box. */
async function shownOf(bytes, pageNumber) {
  const js = await openWithPdfjs(bytes);
  try {
    const page = await js.doc.getPage(pageNumber);
    const [a, b, c, d] = page.getViewport({ scale: 1 }).transform;
    return { basis: [a, b, c, d, 0, 0], box: page.view };
  } finally {
    await js.close();
  }
}

/** A saved page's content (latin1) and its /XObject names → objects. */
async function pageOf(bytes, index = 0) {
  const lib = await loadPdfLib();
  const doc = await lib.PDFDocument.load(bytes, { updateMetadata: false });
  const page = doc.getPages()[index];
  const source = await openSource(lib, bytes);
  const content = Buffer.from(source.contentBytes(page.node)).toString('latin1');
  const dict = page.node.Resources()?.lookup(lib.PDFName.of('XObject'));
  const xobjects = new Map(dict instanceof lib.PDFDict ? dict.keys().map((k) => [k.asString().slice(1), dict.get(k)]) : []);
  return { doc, content, xobjects };
}

const imagesOf = async (bytes, page = 0) => objectsOf((await analyzeFile(bytes, { pages: [page] })).pages[0]).filter((o) => o.kind === 'image');
const close = (a, b, tol = 1e-3) => a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) <= tol);

/** An inserted-picture record with its bytes in `sources`. */
async function inserting(bytes, transform, entry, sources, source = `src${sources.size}`) {
  sources.set(source, bytes);
  const picture = await readPicture(await loadPdfLib(), bytes);
  return planInsertion({ picture: { source, ...picture }, transform, entry });
}

test('a new picture starts centred, upright as the page is shown, at its natural size but at most half the page', async () => {
  // An upright A4-ish page: 800 × 600 pixels is 600 × 450 pt, too big — halved page width is the limit.
  const upright = defaultPlacement({ width: 800, height: 600, box: [0, 0, 600, 800], basis: [1, 0, 0, -1, 0, 0] });
  assert.ok(close(upright, [300, 0, 0, 225, 150, 287.5]), `fitted and centred: ${upright}`);
  // A small image is not enlarged: 40 × 20 pixels is 30 × 15 pt.
  const small = defaultPlacement({ width: 40, height: 20, box: [0, 0, 600, 800], basis: [1, 0, 0, -1, 0, 0] });
  assert.ok(close(small, [30, 0, 0, 15, 285, 392.5]), `natural size: ${small}`);

  // A page with /Rotate 90 (mixed-sizes, page 4): the picture is upright on screen, not on the page.
  const { basis, box } = await shownOf(read('mixed-sizes'), 4);
  const t = defaultPlacement({ width: 400, height: 200, box, basis });
  const shown = ([u, v]) => apply(basis, ...apply(t, u, v));
  const [tl, tr, bl] = [[0, 1], [1, 1], [0, 0]].map(shown);
  assert.ok(Math.abs(tl[1] - tr[1]) < 1e-3 && tr[0] - tl[0] > 0, 'its top edge runs left to right on screen');
  assert.ok(Math.abs(tl[0] - bl[0]) < 1e-3 && bl[1] - tl[1] > 0, 'and its top is above its bottom');
  assert.ok(close([tr[0] - tl[0], bl[1] - tl[1]], [300, 150]), 'at 300 × 150 pt');
  const centre = apply(t, 0.5, 0.5);
  assert.ok(close(centre, [(box[0] + box[2]) / 2, (box[1] + box[3]) / 2]), 'centred on the page');

  assert.equal(defaultPlacement({ width: 0, height: 10, box, basis }), null);
  assert.equal(defaultPlacement({ width: 10, height: 10, box, basis: [0, 0, 0, 0, 0, 0] }), null);
});

test('an inserted picture is drawn after the page, exactly where its record says, and nothing else changes', async () => {
  const bytes = read('images');
  const plan = identityPlan(1);
  const before = await imagesOf(bytes);
  const sources = new Map();
  const record = await inserting(JPEG, [120, 0, 0, 60, 200, 300], plan[0].id, sources);
  assert.equal(record.kind, 'inserted-image');
  assert.deepEqual(record.picture, { source: 'src0', format: 'jpeg', width: 4, height: 2 });
  const saved = await composeDocument({ base: bytes, plan, edits: [record], sources });

  const after = await imagesOf(saved);
  assert.equal(after.length, before.length + 1, 'one more picture');
  const added = after.at(-1);
  assert.deepEqual(added.record.ctm, [120, 0, 0, 60, 200, 300], 'drawn last, in exactly its frame');
  assert.deepEqual([added.record.info.width, added.record.info.height], [4, 2]);
  before.forEach((o, i) => assert.deepEqual([after[i].record.ctm, after[i].record.name], [o.record.ctm, o.record.name], 'the page’s own pictures are untouched'));

  const { doc, content, xobjects } = await pageOf(saved);
  assert.match(content, /Q\n\s*q 120 0 0 60 200 300 cm \/VlImg1 Do Q\s*$/, 'appended after the page, in its own q … Q');
  assert.deepEqual([...xobjects.keys()].sort(), ['Im1', 'VlImg1']);
  assert.deepEqual(Buffer.from(doc.context.lookup(xobjects.get('VlImg1')).getContents()), Buffer.from(JPEG), 'the JPEG byte for byte');

  // A second picture on the same page gets the next name; the first keeps its own.
  const second = await inserting(png(10, 10), [30, 0, 0, 30, 10, 10], plan[0].id, sources);
  const twice = await pageOf(await composeDocument({ base: bytes, plan, edits: [record, second], sources }));
  assert.deepEqual([...twice.xobjects.keys()].sort(), ['Im1', 'VlImg1', 'VlImg2']);
});

test('on a blank page and on a duplicated one: each page draws it, from one embedded image', async () => {
  const bytes = read('simple');
  const [first] = identityPlan(1);
  const blank = { id: 'blank-1', src: 'blank', width: 300, height: 400, rotate: 0 };
  const sources = new Map();
  const onBlank = await inserting(JPEG, [100, 0, 0, 50, 100, 175], blank.id, sources);
  const onFirst = await inserting(JPEG, [80, 0, 0, 40, 72, 72], first.id, sources, 'src0');
  // Duplicating the first page copies its record, as it does for every edit.
  const copy = { ...first, id: 'copy-1' };
  const plan = [first, copy, blank];
  const copied = followEdits([onFirst], plan, [[first.id, copy.id]]).map((c) => c.edit.after).filter(Boolean);
  const saved = await composeDocument({ base: bytes, plan, edits: [onFirst, ...copied, onBlank], sources });

  for (const [index, ctm] of [[0, [80, 0, 0, 40, 72, 72]], [1, [80, 0, 0, 40, 72, 72]], [2, [100, 0, 0, 50, 100, 175]]]) {
    const pictures = await imagesOf(saved, index);
    assert.equal(pictures.length, 1, `page ${index + 1} draws one picture`);
    assert.deepEqual(pictures[0].record.ctm, ctm);
  }
  const pages = await Promise.all([0, 1, 2].map((i) => pageOf(saved, i)));
  const refs = new Set(pages.map((p) => p.xobjects.get('VlImg1').toString()));
  assert.equal(refs.size, 1, 'one image object in the file, however many pages draw it');
});

test('in the session: inserted, selectable, moved, replaced, deleted — one record and one undo step each', async () => {
  const bytes = read('images');
  const shown = await shownOf(bytes, 1);
  await withSession(bytes, async ({ store, session, sources, plan }) => {
    const before = (await session.objects(1)).objects.length;
    const key = await session.insertImage(1, png(40, 20), shown);
    assert.equal(store.edits.length, 1);
    const [record] = store.edits;
    assert.equal(key, keyOf(record));
    assert.equal(sources.get(record.picture.source).length > 0, true, 'the bytes are kept in the document’s sources');

    const { objects } = await session.objects(1);
    assert.equal(objects.length, before + 1);
    const object = objects.at(-1);
    assert.equal(object.ref.key, key, 'the new picture comes last, over everything the page draws');
    assert.equal(object.kind, 'image');
    for (const verb of ['move', 'scale', 'stretch', 'rotate', 'replace', 'delete']) assert.equal(object.capabilities[verb], true, verb);
    assert.notEqual(object.capabilities.editText, true);
    assert.ok((await session.page(1)).runs.length > 0, 'the page’s text still reads with a picture on it');

    // Moved there and back: still one record, and still on the page.
    const start = record.transform;
    assert.equal(await session.transformObject(1, key, [1, 0, 0, 1, 20, -10]), true);
    assert.deepEqual(store.edits[0].transform, multiply(start, [1, 0, 0, 1, 20, -10]));
    assert.equal(await session.transformObject(1, key, [1, 0, 0, 1, -20, 10]), true);
    assert.deepEqual([store.edits.length, store.edits[0].transform], [1, start], 'back where it was put, the picture stays');

    // Replaced: the same record and place, another image.
    assert.equal(await session.replaceImage(1, key, JPEG), true);
    assert.deepEqual([store.edits.length, store.edits[0].id, store.edits[0].transform, store.edits[0].picture.format], [1, record.id, start, 'jpeg']);

    // Saved and reloaded: the file draws the JPEG exactly there.
    const saved = await composeDocument({ base: bytes, plan, edits: store.edits, sources });
    const added = (await imagesOf(saved)).at(-1);
    assert.ok(close(added.record.ctm, start, 1e-4), 'the saved picture is where it was put');
    assert.deepEqual([added.record.info.width, added.record.info.height], [4, 2]);

    // Deleted: the record goes. Undo brings it back; redo takes it away again.
    assert.equal(await session.removeObject(1, key), true);
    assert.equal(store.edits.length, 0);
    assert.equal((await session.objects(1)).objects.length, before);
    assert.equal(store.undo(), true);
    assert.equal(store.edits[0].picture.format, 'jpeg');
    assert.equal(store.redo(), true);
    assert.equal(store.edits.length, 0);
    // Undoing everything removes the insertion itself, in one step each.
    while (store.undo());
    assert.equal(store.edits.length, 0, 'nothing is left once the insertion is undone');
  });
});

test('unusable files, PDF/A documents and missing sources are refused, and nothing is stored', async () => {
  const bytes = read('images');
  const shown = await shownOf(bytes, 1);
  await withSession(bytes, async ({ store, session }) => {
    await assert.rejects(session.insertImage(1, new Uint8Array([1, 2, 3]), shown), (err) => err.kind === 'picture');
    await assert.rejects(session.insertImage(1, png(40, 20).slice(0, 40), shown), (err) => err.kind === 'picture', 'a cut-off PNG');
    await assert.rejects(session.insertImage(1, 'not bytes', shown), (err) => err.kind === 'picture');
    await assert.rejects(session.insertImage(9, JPEG, shown), (err) => err.kind === 'missing', 'a page that isn’t there');
    assert.equal(store.edits.length, 0);
  });
  await withSession(read('pdfa'), async ({ store, session }) => {
    await assert.rejects(session.insertImage(1, JPEG, shown), (err) => err.kind === 'pdfa');
    assert.equal(store.edits.length, 0);
  });
  const plan = identityPlan(1);
  const sources = new Map();
  const record = await inserting(JPEG, [50, 0, 0, 25, 100, 100], plan[0].id, sources);
  await assert.rejects(composeDocument({ base: read('pdfa'), plan, edits: [record], sources }), (err) => err.kind === 'pdfa', 'the writer refuses PDF/A too');
  await assert.rejects(composeDocument({ base: bytes, plan, edits: [record], sources: new Map() }), (err) => err.kind === 'missing', 'a missing image refuses the save');
  assert.throws(() => planInsertion({ picture: record.picture, transform: [0, 0, 0, 0, 5, 5], entry: plan[0].id }), (err) => err.kind === 'content', 'no area');
  assert.throws(() => planInsertion({ picture: { source: '', format: 'gif', width: 1, height: 1 }, transform: [1, 0, 0, 1, 0, 0], entry: 'x' }), (err) => err.kind === 'content');
});
