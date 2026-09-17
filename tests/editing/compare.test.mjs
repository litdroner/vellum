// PDF Compare (compare/diff.js): page matching and text differences.
//
// Pinned here: words keep their boxes and pdf.js's split words are joined; pages that stay, move, are
// added or removed; text added, removed and changed, with boxes on the side that has the words and an
// anchor on the side that doesn't; two real PDFs read by pdf.js give exactly the expected changes.
// Run: node --test "tests/editing/*.test.mjs"

import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { openWithPdfjs, webModule } from './harness.mjs';
import { makeFixtures, FIXTURE_DIR } from './fixtures.mjs';

const { pageWords, pageProfile, similarity, alignPages, diffSequence, diffWords, rowChanges } = await webModule('compare/diff.js');

let files;
before(async () => { files = await makeFixtures(FIXTURE_DIR); });

/** Words on one line, 10pt apart: enough geometry for the diff. */
const words = (text, y = 700) => text.split(' ').filter(Boolean).map((t, i) => ({ text: t, rect: [72 + i * 40, y, 72 + i * 40 + 30, y + 12] }));
const profile = (text) => pageProfile(words(text));

test('words: boxes along the text; an item split mid-word is joined', () => {
  const item = (str, x, width, hasEOL = false) => ({ str, transform: [12, 0, 0, 12, x, 700], width, height: 12, hasEOL });
  const got = pageWords({ items: [item('Hello wor', 72, 54), item('ld again', 126, 48, true), item('Next', 72, 24)] });
  assert.deepEqual(got.map((w) => w.text), ['Hello', 'world', 'again', 'Next']);
  const [hello] = got;
  assert.ok(Math.abs(hello.rect[0] - 72) < 0.01 && Math.abs(hello.rect[2] - 102) < 0.01, `x from the item's width: ${hello.rect}`);
  assert.ok(hello.rect[1] < 700 && hello.rect[3] > 708, 'descent below the baseline, cap height above');
  assert.equal(pageWords({ items: [item('a', 72, 6, true), item('b', 78, 6)] }).length, 2, 'not joined across a line end');
});

test('similarity: shared words, empty pages', () => {
  assert.equal(similarity(profile('a b c d'), profile('a b c d')), 1);
  assert.equal(similarity(profile('a b c d'), profile('a b x y')), 0.5);
  assert.equal(similarity(profile(''), profile('')), 1);
  assert.equal(similarity(profile(''), profile('a')), 0);
});

test('pages: unchanged, added, removed', () => {
  const A = ['one alpha beta', 'two gamma delta', 'three epsilon zeta'].map(profile);
  assert.deepEqual(alignPages(A, A).map((r) => [r.kind, r.a, r.b]), [['same', 0, 0], ['same', 1, 1], ['same', 2, 2]]);
  const B = ['one alpha beta', 'new page entirely here', 'two gamma delta'].map(profile);
  assert.deepEqual(alignPages(A, B).map((r) => [r.kind, r.a, r.b]), [['same', 0, 0], ['added', null, 1], ['same', 1, 2], ['removed', 2, null]]);
});

test('pages: reordered pages are moved, not removed and added', () => {
  const A = ['intro a b c', 'first x y z', 'second p q r', 'end u v w'].map(profile);
  const B = ['intro a b c', 'second p q r', 'first x y z', 'end u v w'].map(profile);
  const rows = alignPages(A, B);
  assert.deepEqual(rows.map((r) => [r.kind, r.a, r.b]), [['same', 0, 0], ['moved', 2, 1], ['same', 1, 2], ['same', 3, 3]]);
  // A page moved from the end to the front, and edited a little on the way.
  const C = ['end u v w changed', 'intro a b c', 'first x y z', 'second p q r'].map(profile);
  assert.deepEqual(alignPages(A, C).map((r) => [r.kind, r.a, r.b]), [['moved', 3, 0], ['same', 0, 1], ['same', 1, 2], ['same', 2, 3]]);
});

test('text: Myers diff reproduces B from A', () => {
  const cases = [['a b c', 'a b c'], ['a b c', 'a x c'], ['', 'a b'], ['a b', ''], ['a b c d e f', 'b c x e f g'], ['x a x b x', 'a x b x x']];
  for (const [p, q] of cases) {
    const a = p.split(' ').filter(Boolean);
    const b = q.split(' ').filter(Boolean);
    const ops = diffSequence(a, b);
    assert.deepEqual(ops.filter((o) => o[0] !== '-').map((o) => b[o[0] === '=' ? o[2] : o[1]]), b, `${p} → ${q}`);
    assert.deepEqual(ops.filter((o) => o[0] !== '+').map((o) => a[o[1]]), a, `${p} → ${q}`);
  }
  assert.equal(diffSequence('a b c d'.split(' '), 'a x c d'.split(' ')).filter((o) => o[0] !== '=').length, 2, 'minimal');
});

test('text: added, removed and changed, with boxes and anchors', () => {
  const changes = diffWords(words('the cat sat on the mat'), words('the black cat sat on a mat today'));
  assert.deepEqual(changes.map((c) => [c.kind, c.before, c.after]), [['added', '', 'black'], ['changed', 'the', 'a'], ['added', '', 'today']]);
  const [black, the] = changes;
  assert.equal(black.bRects.length, 1);
  assert.deepEqual(black.aRects, []);
  assert.deepEqual(black.aAnchor, words('the')[0].rect, 'anchored after the unchanged word before it');
  assert.equal(the.aRects.length, 1);
  assert.equal(the.bRects.length, 1);
  const removed = diffWords(words('keep this please'), words('keep please'));
  assert.deepEqual(removed.map((c) => [c.kind, c.before]), [['removed', 'this']]);
  assert.ok(removed[0].bAnchor, 'the removed text is pointed at in B too');
  const lines = diffWords([...words('one two', 700), ...words('three', 680)], words('one'));
  assert.equal(lines[0].aRects.length, 2, 'one box per line');
});

test('two real PDFs: every change found, and nothing else', async () => {
  const read = async (name) => {
    const js = await openWithPdfjs(new Uint8Array(fs.readFileSync(files[name])));
    const pages = [];
    for (let n = 1; n <= js.doc.numPages; n++) pages.push(pageWords(await (await js.doc.getPage(n)).getTextContent()));
    await js.close();
    return pages;
  };
  const A = await read('compare-a');
  const B = await read('compare-b');
  const rows = alignPages(A.map(pageProfile), B.map(pageProfile));
  assert.deepEqual(rows.map((r) => [r.kind, r.a, r.b]), [['same', 0, 0], ['moved', 2, 1], ['same', 1, 2], ['removed', 3, null], ['added', null, 3]]);
  const changes = rows.flatMap((row, i) => rowChanges(row, i, A[row.a] ?? [], B[row.b] ?? []));
  assert.deepEqual(changes.map((c) => [c.kind, c.row, c.before ?? '', c.after ?? '']), [
    ['text-removed', 0, 'Prepared for the finance team', ''],
    ['text-changed', 0, 'ten', 'twelve'],
    ['text-added', 0, '', 'Costs stayed flat'],
    ['page-moved', 1, '', ''],
    ['page-removed', 3, '', ''],
    ['page-added', 4, '', ''],
  ]);
  const ten = changes[1];
  assert.ok(ten.aRects[0][1] > 630 && ten.aRects[0][3] < 660, `"ten" is on its line in A: ${ten.aRects[0]}`);
  assert.ok(ten.bRects[0][1] > 650 && ten.bRects[0][3] < 680, `"twelve" is on its line in B: ${ten.bRects[0]}`);
});
