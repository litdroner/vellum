// Fill & Sign v1: a signature is an inserted picture (objects/inserted-image.js) made by ui/signature.js —
// ink trimmed from a transparent canvas, placed at a higher density than an ordinary picture. What is
// pinned here: the ink trim; the smaller starting size; and that a transparent signature, moved, resized
// and turned, is saved as real page content (its image with a soft mask, drawn in its own q … Q) and
// reads back from the file exactly where it was left.
// Run: node --test "tests/editing/*.test.mjs"

import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import zlib from 'node:zlib';
import { analyzeFile, engine, loadPdfLib, openWithPdfjs, webModule, withSession } from './harness.mjs';
import { makeFixtures, FIXTURE_DIR } from './fixtures.mjs';

const { defaultPlacement } = await engine('objects/inserted-image.js');
const { objectsOf } = await engine('objects/page-objects.js');
const { multiply } = await engine('matrix.js');
const { rotateAbout, scaleAbout } = await engine('objects/transform.js');
const { composeDocument } = await webModule('annotations/persist.js');
const { inkBounds, POINTS_PER_PIXEL } = await webModule('ui/signature.js');

let files;
before(async () => { files = await makeFixtures(FIXTURE_DIR); });

/** An RGBA PNG, transparent except for a dark bar across the middle. */
function inkPng(width, height) {
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const out = Buffer.alloc(body.length + 8);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(zlib.crc32(body), body.length + 4);
    return out;
  };
  const row = 1 + width * 4;
  const rows = Buffer.alloc(row * height, 0);
  for (let y = Math.floor(height / 3); y < Math.ceil((2 * height) / 3); y++) {
    for (let x = 0; x < width; x++) rows.set([17, 17, 17, 255], y * row + 1 + x * 4);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 6, 0, 0, 0], 8);
  return new Uint8Array(Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header), chunk('IDAT', zlib.deflateSync(rows)), chunk('IEND', Buffer.alloc(0)),
  ]));
}

const close = (a, b, tol = 1e-3) => a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) <= tol);

test('the ink is trimmed with a margin kept inside the canvas; a blank canvas has none', () => {
  const [w, h] = [20, 10];
  const data = new Uint8Array(w * h * 4);
  assert.equal(inkBounds(data, w, h), null);
  for (const [x, y] of [[5, 3], [12, 6]]) data[(y * w + x) * 4 + 3] = 200;
  assert.deepEqual(inkBounds(data, w, h, 2), { x: 3, y: 1, width: 12, height: 8 });
  assert.deepEqual(inkBounds(data, w, h, 6), { x: 0, y: 0, width: 19, height: 10 }, 'clamped to the canvas');
});

test('a signature starts at its denser size: 900 × 300 canvas pixels are 150 × 50 pt', () => {
  const t = defaultPlacement({ width: 900, height: 300, box: [0, 0, 600, 800], basis: [1, 0, 0, -1, 0, 0], pointsPerPixel: POINTS_PER_PIXEL });
  assert.ok(close(t, [150, 0, 0, 50, 225, 375]), String(t));
});

test('a transparent signature, moved, resized and turned, is saved as page content and reads back where it was left', async () => {
  const bytes = new Uint8Array(fs.readFileSync(files.simple));
  const js = await openWithPdfjs(bytes);
  const page = await js.doc.getPage(1);
  const [a, b, c, d] = page.getViewport({ scale: 1 }).transform;
  const shown = { basis: [a, b, c, d, 0, 0], box: page.view, pointsPerPixel: POINTS_PER_PIXEL };
  await js.close();

  await withSession(bytes, async ({ store, session, sources, plan }) => {
    const key = await session.insertImage(1, inkPng(600, 180), shown);
    const start = store.edits[0].transform;
    assert.ok(close([Math.abs(start[0]), Math.abs(start[3])], [100, 30]), `100 × 30 pt: ${start}`);

    const centre = [start[4] + start[0] / 2, start[5] + start[3] / 2];
    const change = multiply(multiply([1, 0, 0, 1, 40, -120], scaleAbout(centre, 1.5)), rotateAbout(centre, Math.PI / 12));
    assert.equal(await session.transformObject(1, key, change), true);
    assert.equal(store.edits.length, 1, 'one record');
    assert.ok(store.canUndo, 'undoable');
    const placed = store.edits[0].transform;
    assert.ok(Math.abs(placed[1]) > 1, 'turned');

    const saved = await composeDocument({ base: bytes, plan, edits: store.edits, sources });
    const pictures = objectsOf((await analyzeFile(saved, { pages: [0] })).pages[0]).filter((o) => o.kind === 'image');
    assert.equal(pictures.length, 1);
    assert.ok(close(pictures[0].record.ctm, placed, 1e-3), `saved where it was left: ${pictures[0].record.ctm} vs ${placed}`);

    const lib = await loadPdfLib();
    const doc = await lib.PDFDocument.load(saved);
    const xobjects = doc.getPages()[0].node.Resources().lookup(lib.PDFName.of('XObject'));
    const image = doc.context.lookup(xobjects.get(lib.PDFName.of('VlImg1')));
    assert.ok(image.dict.get(lib.PDFName.of('SMask')), 'its transparency is kept as a soft mask, not flattened onto the page');
  });
});
