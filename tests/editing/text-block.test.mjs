// Vellum 0.5.0 should-have: paragraph grouping (editing/objects/text-block.js).
//
// Pinned here: a plain paragraph is one block, top line first; a list, columns, a table, a change of
// size or colour, a drifting spacing, a rule between lines and an indented first line are not; a moved
// line leaves its paragraph; and a block moved through the session is one undo step and lands in the
// saved file with every line where the gesture put it, still one paragraph.
// Run: node --test "tests/editing/*.test.mjs"

import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { engine, webModule, analyzeFile, withSession } from './harness.mjs';
import { makeFixtures, FIXTURE_DIR } from './fixtures.mjs';

const { textBlocks, blockOf } = await engine('objects/text-block.js');
const { objectsOf } = await engine('objects/page-objects.js');
const { transformQuad, quadBox } = await engine('objects/geometry.js');
const { translate } = await engine('matrix.js');
const { composeDocument } = await webModule('annotations/persist.js');

let files;
before(async () => { files = await makeFixtures(FIXTURE_DIR); });
const read = (name) => new Uint8Array(fs.readFileSync(files[name]));

const PARAGRAPH = ['The first line of a plain paragraph that', 'runs on to a second line, then a third', 'line, and ends on this fourth one, which', 'is shorter.'];

/** Blocks as the texts of their lines. */
const texts = (objects, blocks) => blocks.map((b) => b.keys.map((key) => objects.find((o) => o.ref.key === key).text));

test('a plain paragraph is one block; lists, columns, tables, style changes, rules and indents are not', async () => {
  const [analysis] = (await analyzeFile(read('paragraphs'))).pages;
  const objects = objectsOf(analysis);
  const blocks = textBlocks(objects);
  assert.deepEqual(texts(objects, blocks), [PARAGRAPH, ['Evenly spaced one', 'Evenly spaced two']],
    'the paragraph, and the two evenly spaced lines without the one spaced further');
  assert.equal(blocks[0].key, blocks[0].keys[0].replace(/^/, 'block:'));
  const key = objects.find((o) => o.text === 'is shorter.').ref.key;
  assert.equal(blockOf(blocks, key), blocks[0]);
  assert.equal(blockOf(blocks, objects.find((o) => o.text === 'Cell A1').ref.key), null);
  // Without the rule's path in the objects, those two lines are an ordinary pair.
  const noPaths = objects.filter((o) => o.kind !== 'path');
  assert.ok(texts(noPaths, textBlocks(noPaths)).some((b) => b.join('|') === 'Above a rule|Below a rule'), 'it was the rule that kept them apart');
});

test('a line moved out of its paragraph leaves it, and a paragraph moved whole stays one', async () => {
  const [analysis] = (await analyzeFile(read('paragraphs'))).pages;
  const objects = objectsOf(analysis);
  const inParagraph = new Set(PARAGRAPH);
  const moved = (object, t) => ({ ...object, geometry: { ...object.geometry, quad: transformQuad(object.geometry.quad, t) } });
  const nudged = objects.map((o) => (o.text === 'runs on to a second line, then a third' ? moved(o, translate(30, 0)) : o));
  assert.equal(texts(nudged, textBlocks(nudged)).some((b) => b.includes(PARAGRAPH[0])), false, 'a line pulled sideways breaks the paragraph');
  const shifted = objects.map((o) => (inParagraph.has(o.text) ? moved(o, translate(250, 0)) : o));
  assert.deepEqual(texts(shifted, textBlocks(shifted))[0], PARAGRAPH);
  // Moved down onto the rows of the list, its last line shares a row with a bullet: no longer grouped whole.
  const onList = objects.map((o) => (inParagraph.has(o.text) ? moved(o, translate(250, -40)) : o));
  assert.equal(texts(onList, textBlocks(onList)).some((b) => b.includes('is shorter.')), false);
});

test('a paragraph moved through the session: one undo step, and the saved file has it there, still a paragraph', async () => {
  await withSession(read('paragraphs'), async ({ bytes, plan, store, session }) => {
    const { objects } = await session.objects(1);
    const [block] = textBlocks(objects);
    assert.equal(block.keys.length, 4);
    const before = new Map(block.keys.map((key) => [objects.find((o) => o.ref.key === key).text, quadBox(objects.find((o) => o.ref.key === key).geometry.quad)]));
    assert.equal(await session.transformObjects(1, block.keys.map((key) => ({ key, delta: translate(200, -30) }))), true);
    assert.equal(store.edits.length, 4);
    assert.equal(store.undo(), true);
    assert.deepEqual([store.edits.length, store.canUndo], [0, false], 'one undo step for the whole paragraph');
    store.redo();
    const saved = await composeDocument({ base: bytes, plan, edits: store.edits });
    const again = objectsOf((await analyzeFile(saved)).pages[0]);
    for (const [text, box] of before) {
      const line = again.find((o) => o.text === text && Math.abs(quadBox(o.geometry.quad)[0] - box[0] - 200) < 0.05);
      assert.ok(line, `${text} moved 200 across`);
      assert.ok(Math.abs(quadBox(line.geometry.quad)[1] - box[1] + 30) < 0.05, `${text} moved 30 down`);
    }
    assert.ok(texts(again, textBlocks(again)).some((b) => b.join('|') === PARAGRAPH.join('|')), 'still one paragraph in the saved file');
  });
});
