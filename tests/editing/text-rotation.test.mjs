// Vellum 0.6: rotating text, by quarter turns and freely (editing/edits.js textTransformRefusal and
// textPlacement, editing/objects/transform.js similarityOf and rotateAbout).
//
// A turn is the same transform a move or a scale already is — absolute, in the original page's user
// space, one record per object — and the text writer already draws it under one `cm`. Pinned here: a
// stored text transform is always an exact similarity however often it is turned; the saved file reads
// back as the same editable text in the same font, size, colour and opacity, turned, with nothing
// rasterized; a turn of several objects is one undo step; turned copies and retyped turned text keep
// their turn; mirrors, stretches and skews are still refused, and a turned paragraph is not reflowed.
// Run: node --test "tests/editing/*.test.mjs"

import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { analyzeFile, engine, webModule, withSession } from './harness.mjs';
import { makeFixtures, FIXTURE_DIR } from './fixtures.mjs';

const { textTransformRefusal, textPlacement } = await engine('edits.js');
const { multiply } = await engine('matrix.js');
const { similarityOf, rotateAbout, quarterTurn, quantize } = await engine('objects/transform.js');
const { quadCentre } = await engine('objects/geometry.js');
const { textBlocks } = await engine('objects/text-block.js');
const { composeDocument } = await webModule('annotations/persist.js');

let files;
before(async () => { files = await makeFixtures(FIXTURE_DIR); });
const read = (name) => new Uint8Array(fs.readFileSync(files[name]));

const degrees = (d) => (d * Math.PI) / 180;
const near = (a, b, tol = 1e-3) => a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) <= tol);
const turnOf = (object, angle) => ({ key: object.ref.key, delta: rotateAbout(quadCentre(object.geometry.quad), angle) });
const depth = (store) => {
  let n = 0;
  while (store.canUndo) { store.undo(); n++; }
  for (let i = 0; i < n; i++) store.redo();
  return n;
};

test('a text placement is always an exact similarity, however often it is turned', () => {
  let t = [1, 0, 0, 1, 0, 0];
  for (let i = 0; i < 60; i++) {
    t = textPlacement(quantize(multiply(t, rotateAbout([300, 400], degrees(7.3)))));
    assert.ok(t[0] === t[3] && t[1] === -t[2], `turn ${i}: ${t}`);
    assert.equal(textTransformRefusal(t), null, `turn ${i}`);
  }
  assert.ok(Math.abs(Math.hypot(t[0], t[1]) - 1) < 1e-3, 'and still the same size');
  assert.deepEqual(rotateAbout([10, 20], Math.PI / 2), quarterTurn([10, 20], 1), 'a snapped quarter turn is the keyboard’s exact matrix');
  for (const [what, transform] of [['a mirror', [-1, 0, 0, 1, 0, 0]], ['a stretch', [2, 0, 0, 1, 0, 0]], ['a skew', [1, 0, 0.4, 1, 0, 0]], ['a turned mirror', [0, 1, 1, 0, 0, 0]]]) {
    assert.equal(similarityOf(transform), null, what);
    assert.equal(textTransformRefusal(textPlacement(transform)), 'unsupported', what);
  }
});

test('turned text saves as the same text: font, size, colour and opacity kept, nothing rasterized, one undo step', async () => {
  const bytes = read('crosspage');
  await withSession(bytes, async ({ store, session, sources, plan }) => {
    const tinted = (await session.objects(1)).objects.find((o) => o.text === 'Tinted half text');
    assert.equal(tinted.capabilities.rotate, true);
    assert.equal(await session.transformObjects(1, [turnOf(tinted, degrees(30))], { verb: 'rotate' }), true);
    assert.equal(store.edits.length, 1);
    const [record] = store.edits;
    assert.deepEqual([record.kind, record.encoding.mode], ['text', 'original'], 'the file’s own glyphs, redrawn');
    assert.ok(record.transform[0] === record.transform[3] && record.transform[1] === -record.transform[2]);
    // Turned again, it is still the one record.
    assert.equal(await session.transformObjects(1, [turnOf((await session.objects(1)).objects.find((o) => o.ref.key === tinted.ref.key), degrees(15))], { verb: 'rotate' }), true);
    assert.equal(store.edits.length, 1);
    assert.equal(depth(store), 2);

    const before = (await analyzeFile(bytes)).pages[0];
    const original = before.runs.find((r) => r.text === 'Tinted half text');
    const saved = await composeDocument({ base: bytes, plan, edits: store.edits, sources });
    const after = (await analyzeFile(saved)).pages[0];
    const run = after.runs.find((r) => r.text === 'Tinted half text');
    assert.ok(run, after.runs.map((r) => r.text).join(' | '));
    assert.ok(near(run.frame.dir, [Math.cos(degrees(45)), Math.sin(degrees(45))]), `turned 45°: ${run.frame.dir}`);
    assert.ok(Math.abs(run.frame.size - original.frame.size) < 1e-3, 'the same size');
    assert.equal(run.font.name, original.font.name, 'the same font');
    assert.deepEqual(run.first.fill.color.args, original.first.fill.color.args, 'the same colour');
    assert.equal(run.first.fill.space.args.length, original.first.fill.space.args.length, 'in the same colour space');
    assert.equal(run.first.ca, 0.5, 'the same opacity');
    assert.ok(run.editable, 'still editable text after reopening');
    assert.equal(after.images.length, before.images.length, 'no picture was added: nothing rasterized');
    assert.equal(after.runs.filter((r) => r.text === 'Tinted half text').length, 1, 'and the original is not drawn as well');

    store.undo();
    store.undo();
    assert.deepEqual(store.edits, []);
    store.redo();
    assert.equal(store.edits.length, 1);
  });
});

test('several lines and a picture turn as one undo step; turned text keeps its turn when retyped', async () => {
  const bytes = read('images');
  await withSession(bytes, async ({ store, session, sources, plan }) => {
    const { objects } = await session.objects(1);
    const picture = objects.find((o) => o.kind === 'image');
    const caption = objects.find((o) => o.text === 'Caption under the picture');
    const beside = objects.find((o) => o.text === 'Text beside another picture');
    const turn = quarterTurn([300, 500], -1); // one shape, turned about one centre
    assert.equal(await session.transformObjects(1, [picture, caption, beside].map((o) => ({ key: o.ref.key, delta: turn })), { verb: 'rotate' }), true);
    assert.equal(store.edits.length, 3);
    assert.equal(depth(store), 1);

    assert.equal(await session.edit(1, caption.record.key, 'Turned caption'), true);
    const retyped = store.edits.find((e) => e.target?.key === caption.record.key);
    assert.deepEqual([retyped.text, retyped.transform], ['Turned caption', turn]);

    const saved = await composeDocument({ base: bytes, plan, edits: store.edits, sources });
    const runs = (await analyzeFile(saved)).pages[0].runs;
    for (const text of ['Turned caption', 'Text beside another picture']) {
      const run = runs.find((r) => r.text === text);
      assert.ok(run && near(run.frame.dir, [0, -1]), `${text}: ${run?.frame.dir}`);
    }
  });
});

test('a pasted copy turns like its original, and the original stays where it was', async () => {
  const bytes = read('images');
  await withSession(bytes, async ({ store, session, sources, plan }) => {
    const caption = (await session.objects(1)).objects.find((o) => o.text === 'Caption under the picture');
    const [key] = await session.pasteObjects(1, await session.copyObjects(1, [caption.ref.key]), [1, 0, 0, 1, 0, -40]);
    const copy = (await session.objects(1)).objects.find((o) => o.ref.key === key);
    assert.equal(copy.capabilities.rotate, true);
    assert.equal(await session.transformObjects(1, [turnOf(copy, Math.PI / 2)], { verb: 'rotate' }), true);
    assert.equal(store.edits.length, 1, 'the copy’s one record');
    assert.equal(store.edits[0].kind, 'text-copy');

    const saved = await composeDocument({ base: bytes, plan, edits: store.edits, sources });
    const runs = (await analyzeFile(saved)).pages[0].runs.filter((r) => r.text === 'Caption under the picture');
    assert.equal(runs.length, 2);
    assert.ok(runs.some((r) => near(r.frame.dir, [1, 0])) && runs.some((r) => near(r.frame.dir, [0, 1])), runs.map((r) => r.frame.dir).join(' | '));
  });
});

test('a mirror of text is refused with nothing stored, and a turned paragraph is not reflowed', async () => {
  await withSession(read('images'), async ({ store, session }) => {
    const caption = (await session.objects(1)).objects.find((o) => o.text === 'Caption under the picture');
    await assert.rejects(session.transformObjects(1, [{ key: caption.ref.key, delta: [-1, 0, 0, 1, 400, 0] }], { verb: 'rotate' }),
      (err) => err.detail?.reason === 'unsupported');
    assert.deepEqual(store.edits, []);
  });
  await withSession(read('paragraphs'), async ({ store, session }) => {
    const { objects } = await session.objects(1);
    const [block] = textBlocks(objects);
    assert.ok(block, 'the fixture has a paragraph');
    const lines = block.keys.map((key) => objects.find((o) => o.ref.key === key));
    const turn = rotateAbout(quadCentre(lines[0].geometry.quad), degrees(20));
    assert.equal(await session.transformObjects(1, lines.map((o) => ({ key: o.ref.key, delta: turn })), { verb: 'rotate' }), true);
    const edits = store.edits.length;
    await assert.rejects(session.reflowParagraph(1, block.keys, 120), (err) => err.detail?.reason === 'placement');
    assert.equal(store.edits.length, edits, 'nothing stored');
  });
});
