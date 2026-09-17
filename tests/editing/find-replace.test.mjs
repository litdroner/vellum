// Find and replace (editing/find-replace.js, editing/session.js replaceText).
//
// Pinned here: plain-text matching with match case and whole words; Replace All is ONE undo step
// through the ordinary text-edit records; replacing one match picks the occurrence under a point;
// text a font can't write is left as it is with the reason; the saved file reads the new text.
// Run: node --test "tests/editing/*.test.mjs"

import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { analyzeFile, engine, webModule, withSession } from './harness.mjs';
import { makeFixtures, FIXTURE_DIR } from './fixtures.mjs';

const { findMatches, replaceMatches, mayContain, nearestMatch } = await engine('find-replace.js');
const { composeDocument } = await webModule('annotations/persist.js');

let files;
before(async () => { files = await makeFixtures(FIXTURE_DIR); });
const read = (name) => new Uint8Array(fs.readFileSync(files[name]));
const texts_ = async (bytes) => (await analyzeFile(bytes)).pages.map((p) => p.runs.map((r) => r.text));

test('matching: plain text, match case, whole words, white space', () => {
  const text = 'Cat catalog cat. CAT a.b';
  assert.deepEqual(findMatches(text, 'cat').map((m) => m.start), [0, 4, 12, 17]);
  assert.deepEqual(findMatches(text, 'cat', { caseSensitive: true }).map((m) => m.start), [4, 12]);
  assert.deepEqual(findMatches(text, 'cat', { entireWord: true }).map((m) => m.start), [0, 12, 17]);
  assert.deepEqual(findMatches(text, 'a.b').map((m) => m.start), [21], 'no pattern characters');
  assert.deepEqual(findMatches('one  two', 'one two'), [{ start: 0, end: 8 }]);
  assert.deepEqual(findMatches(text, ''), []);
  assert.equal(replaceMatches(text, findMatches(text, 'cat', { entireWord: true }), 'dog'), 'dog catalog dog. dog a.b');
  assert.ok(mayContain('Page 1 of fi ve', 'FIVE'));
  assert.ok(!mayContain('Page 1', 'five'));
  const two = findMatches('ab ab', 'ab');
  assert.equal(nearestMatch('ab ab', two, 0.9).start, 3);
});

test('Replace All: every page, one undo step, saved as page text', async () => {
  const bytes = read('multipage');
  await withSession(bytes, async ({ plan, store, session, sources }) => {
    const result = await session.replaceText('FIVE', '5', { caseSensitive: false, entireWord: true });
    assert.deepEqual(result, { replaced: 5, skipped: 0, reasons: [] });
    assert.equal(store.edits.filter((e) => e.kind === 'text').length, 5);
    store.undo();
    assert.equal(store.edits.length, 0, 'one undo takes all of it away');
    assert.ok(!store.canUndo);
    store.redo();
    assert.equal(store.edits.length, 5);
    const saved = await composeDocument({ base: bytes, plan, edits: store.edits, sources });
    assert.deepEqual((await texts_(saved)).flat(), [1, 2, 3, 4, 5].map((p) => `Page ${p} of 5`));
  });
});

test('whole words and match case leave other matches alone', async () => {
  await withSession(read('multipage'), async ({ session, store }) => {
    assert.equal((await session.replaceText('fiv', 'x', { entireWord: true })).replaced, 0);
    assert.equal((await session.replaceText('PAGE', 'x', { caseSensitive: true })).replaced, 0);
    assert.equal(store.edits.length, 0);
  });
});

test('Replace one: the match under the point, in that run only', async () => {
  const bytes = read('simple');
  await withSession(bytes, async ({ plan, store, session, sources }) => {
    const { runs } = await session.page(1);
    const line = runs.find((r) => r.text.startsWith('A second line')).run;
    // "line" is at the start of the run; a point near its left end picks it, not another run's text.
    const point = [line.quad[0] + (line.quad[2] - line.quad[0]) * 0.2, (line.quad[1] + line.quad[7]) / 2];
    const result = await session.replaceText('line', 'row', {}, { pageNumber: 1, point });
    assert.equal(result.replaced, 1);
    const saved = await composeDocument({ base: bytes, plan, edits: store.edits, sources });
    const after = (await texts_(saved))[0];
    assert.ok(after.includes('A second row with punctuation: café, naïve — 50% off!'), JSON.stringify(after));
    assert.ok(after.includes('Third line.'));
  });
});

test('text a font can’t write is left as it is, with the reason', async () => {
  await withSession(read('simple'), async ({ session, store }) => {
    const result = await session.replaceText('world', '₹', {});
    assert.equal(result.replaced, 0);
    assert.equal(result.skipped, 1);
    assert.match(result.reasons[0], /₹/);
    assert.equal(store.edits.length, 0);
  });
});

test('pasted copies and new text are replaced too, in the same one undo step, and saved', async () => {
  const bytes = read('simple');
  await withSession(bytes, async ({ plan, store, session, sources }) => {
    const hello = (await session.objects(1)).objects.find((o) => o.text === 'Hello, world');
    await session.pasteObjects(1, await session.copyObjects(1, [hello.ref.key]), [1, 0, 0, 1, 0, -300]);
    const box = await session.insertText(1, { basis: [1, 0, 0, -1, 0, 0], box: [0, 0, 612, 792] });
    assert.equal(await session.edit(1, box, 'New world box'), true);
    const before = store.edits.length;

    const result = await session.replaceText('world', 'earth', { entireWord: true });
    assert.deepEqual(result, { replaced: 3, skipped: 0, reasons: [] });
    const texts = store.edits.map((e) => e.text);
    assert.deepEqual(texts.filter((t) => t === 'Hello, earth').length, 2, JSON.stringify(texts));
    assert.ok(texts.includes('New earth box'));
    assert.equal(store.edits.length, before + 1, 'copy and new text keep their one record each');

    store.undo();
    const undone = store.edits.map((e) => e.text);
    assert.equal(store.edits.length, before, 'one undo takes back the run edit');
    assert.ok(undone.includes('Hello, world'), 'and the copy');
    assert.ok(undone.includes('New world box'), 'and the new text');
    store.redo();

    const saved = await composeDocument({ base: bytes, plan, edits: store.edits, sources });
    const after = (await texts_(saved))[0];
    assert.equal(after.filter((t) => t === 'Hello, earth').length, 2, JSON.stringify(after));
    assert.ok(after.includes('New earth box'), JSON.stringify(after));
    assert.ok(!after.some((t) => t.includes('world')));
  });
});

test('a copy or new text that can’t take the replacement is left as it is and counted', async () => {
  await withSession(read('simple'), async ({ session, store }) => {
    const hello = (await session.objects(1)).objects.find((o) => o.text === 'Hello, world');
    await session.pasteObjects(1, await session.copyObjects(1, [hello.ref.key]), [1, 0, 0, 1, 0, -300]);
    const box = await session.insertText(1, { basis: [1, 0, 0, -1, 0, 0], box: [0, 0, 612, 792] });
    await session.edit(1, box, 'New world box');
    const edits = JSON.stringify(store.edits);
    const result = await session.replaceText('world', '₹', {});
    assert.deepEqual([result.replaced, result.skipped], [0, 3]);
    assert.ok(result.reasons.length >= 1);
    assert.equal(JSON.stringify(store.edits), edits, 'nothing stored');
  });
});
