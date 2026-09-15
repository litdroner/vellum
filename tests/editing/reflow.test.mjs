// Vellum 0.5.0 should-have: single-style paragraph reflow (editing/objects/reflow.js).
//
// Pinned here: a plain paragraph refills its words, in order and none lost, into its own lines at a new
// width, each line no wider than asked; a width narrower than a word, or one needing more lines than the
// paragraph has, is refused; kerned text, words spaced by pen moves, a hyphenated break and lines placed
// separately are refused; and through the session a reflow is one undo step whose saved file holds the
// words on the paragraph's own baselines and left edge, in its own font, read back by pdf.js, with nothing
// else on the page changed — and a scaled paragraph is measured as it is shown.
// Run: node --test "tests/editing/*.test.mjs"

import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { engine, webModule, analyzeFile, withSession } from './harness.mjs';
import { makeFixtures, FIXTURE_DIR } from './fixtures.mjs';

const { reflowTexts, reflowRefusal } = await engine('objects/reflow.js');
const { textBlocks } = await engine('objects/text-block.js');
const { quadBox } = await engine('objects/geometry.js');
const { translate } = await engine('matrix.js');
const { scaleAbout } = await engine('objects/transform.js');
const { EditError } = await engine('edits.js');
const { composeDocument } = await webModule('annotations/persist.js');

let files;
before(async () => { files = await makeFixtures(FIXTURE_DIR); });
const read = (name) => new Uint8Array(fs.readFileSync(files[name]));

const PARAGRAPH = ['The first line of a plain paragraph that', 'runs on to a second line, then a third', 'line, and ends on this fourth one, which', 'is shorter.'];
const WORDS = PARAGRAPH.join(' ').split(' ');

/** The runs with these texts, as reflow lines with no records, in the order given. */
const linesOf = (analysis, texts) => texts.map((text) => ({ run: analysis.runs.find((r) => r.text === text), record: null }));

/** Width of a run as the file lays it out, along the text. */
const laidWidth = (run) => quadBox(run.quad)[2] - quadBox(run.quad)[0];

const reasonOf = (fn) => {
  try {
    fn();
  } catch (err) {
    if (err instanceof EditError) return err.detail?.reason;
    throw err;
  }
  return null;
};

test('a plain paragraph refills its own lines at a new width: every word, in order, no line too wide', async () => {
  const [analysis] = (await analyzeFile(read('paragraphs'))).pages;
  const lines = linesOf(analysis, [...PARAGRAPH].reverse()); // any order: the top line is found
  assert.equal(reflowRefusal(analysis, lines), null);
  const texts = reflowTexts(analysis, lines, 400);
  assert.equal(texts.length, 4);
  assert.deepEqual(texts.filter(Boolean).join(' ').split(' '), WORDS, 'every word, in order');
  assert.ok(texts.filter(Boolean).length < 4 && texts.at(-1) === '', 'wider: fewer lines, the last emptied');
  // Narrower than now, but still within four lines.
  const widest = Math.max(...lines.map(({ run }) => laidWidth(run)));
  const narrower = reflowTexts(analysis, lines, widest - 10);
  assert.deepEqual(narrower.filter(Boolean).join(' ').split(' '), WORDS);
  assert.equal(narrower.filter(Boolean).length, 4);
});

test('refused: narrower than a word, more lines than the paragraph has, kerning, pen-move spaces, a hyphen', async () => {
  const [page1, page2] = (await analyzeFile(read('paragraphs'))).pages;
  const lines = linesOf(page1, PARAGRAPH);
  assert.equal(reasonOf(() => reflowTexts(page1, lines, 20)), 'narrow');
  assert.equal(reasonOf(() => reflowTexts(page1, lines, 120)), 'lines');
  assert.equal(reasonOf(() => reflowTexts(page1, lines.slice(0, 1), 400)), 'lines', 'one line is not a paragraph');
  const kerned = page2.runs.filter((r) => r.text.includes('ave line') || r.text.includes('oward line'));
  assert.equal(kerned.length, 2, JSON.stringify(page2.runs.map((r) => r.text)));
  assert.equal(reasonOf(() => reflowTexts(page2, kerned.map((run) => ({ run, record: null })), 400)), 'layout');
  const moved = page2.runs.filter((r) => r.text.startsWith('Words') || r.text.startsWith('by'));
  assert.equal(reasonOf(() => reflowTexts(page2, moved.map((run) => ({ run, record: null })), 400)), 'layout');
  const hyphen = linesOf(page2, ['A paragraph with a hyphen-', 'ated word across two lines']);
  assert.equal(reasonOf(() => reflowTexts(page2, hyphen, 400)), 'hyphen');
  assert.match(reflowRefusal(page2, hyphen), /hyphen/);
  // Lines far apart are not one paragraph, and a black line and a red one are not one style.
  assert.equal(reasonOf(() => reflowTexts(page1, linesOf(page1, ['is shorter.', 'Eleven-point line']), 400)), 'spacing');
  assert.equal(reasonOf(() => reflowTexts(page1, linesOf(page1, ['A black line', 'A red line']), 400)), 'style');
});

test('through the session: one undo step, and the saved file has the words on the paragraph’s own lines', async () => {
  await withSession(read('paragraphs'), async ({ bytes, plan, store, session }) => {
    const { objects } = await session.objects(1);
    const [block] = textBlocks(objects);
    const before = await analyzeFile(bytes);
    assert.equal(await session.reflowParagraph(1, block.keys, 400), true);
    assert.equal(store.edits.length, 4, 'a record for each line');
    assert.deepEqual([...new Set(store.edits.map((e) => e.encoding.mode))].sort(), ['font', 'none'], 'its own font, or emptied — never a substitute');
    assert.equal(store.undo(), true);
    assert.deepEqual([store.edits.length, store.canUndo], [0, false], 'one undo step');
    store.redo();
    const saved = await composeDocument({ base: bytes, plan, edits: store.edits });
    const [after] = (await analyzeFile(saved)).pages;
    assert.equal(after.verified, true, 'pdf.js draws what the analysis reads');
    const original = before.pages[0].runs.filter((r) => PARAGRAPH.includes(r.text)).sort((a, b) => b.quad[1] - a.quad[1]);
    const texts = store.edits.slice().sort((a, b) => block.keys.indexOf(`run:${a.target.key}`) - block.keys.indexOf(`run:${b.target.key}`)).map((e) => e.text).filter(Boolean);
    for (const [i, text] of texts.entries()) {
      const line = after.runs.find((r) => r.text === text);
      assert.ok(line, `“${text}” is on the page`);
      assert.ok(Math.abs(line.quad[0] - original[i].quad[0]) < 0.01 && Math.abs(line.quad[1] - original[i].quad[1]) < 0.01, `“${text}” on line ${i + 1}’s own baseline and edge`);
      assert.ok(laidWidth(line) <= 400.01, `“${text}” within the width`);
      assert.equal(line.fontName, original[i].fontName, 'in the paragraph’s own font');
    }
    assert.deepEqual(texts.join(' ').split(' '), WORDS);
    const others = (a) => a.runs.filter((r) => !PARAGRAPH.includes(r.text) && !texts.includes(r.text)).map((r) => [r.text, r.quad.map((v) => v.toFixed(2)).join()]);
    assert.deepEqual(others(after), others(before.pages[0]), 'nothing else on the page changed');
  });
});

test('a paragraph scaled as one is measured as it is shown; lines placed separately are refused', async () => {
  await withSession(read('paragraphs'), async ({ store, session }) => {
    const { objects } = await session.objects(1);
    const [block] = textBlocks(objects);
    await session.transformObjects(1, block.keys.map((key) => ({ key, delta: scaleAbout([72, 700], 2) })), { verb: 'scale' });
    assert.equal(await session.reflowParagraph(1, block.keys, 800), true, 'twice as wide, shown twice as large');
    const shown = store.edits.map((e) => e.text).filter(Boolean);
    assert.equal(shown.length, reflowTexts((await session.objects(1)).analysis, block.keys.map((key) => ({ run: objects.find((o) => o.ref.key === key).record, record: null })), 400).filter(Boolean).length);
    assert.ok(store.edits.every((e) => e.transform?.[0] === 2), 'the placement is kept on every line');
    // A line the reflow emptied is gone from the page; the rest, one of them nudged on its own, are no
    // longer placed as one.
    const kept = store.edits.filter((e) => e.text).map((e) => `run:${e.target.key}`);
    await assert.rejects(session.reflowParagraph(1, block.keys, 800), (err) => err.kind === 'missing');
    await session.transformObjects(1, [{ key: kept[0], delta: translate(1, 0) }]);
    await assert.rejects(session.reflowParagraph(1, kept, 800), (err) => err.detail?.reason === 'placement');
  });
});
