// Outline editing V1: the document's bookmarks are read as one flat list (pages/outline.js), changed
// with that list's own operations, and written back by composeDocument as the file's /Outlines tree.
// Run: node --test tests/editing/outline.test.mjs

import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { openWithPdfjs, webModule } from './harness.mjs';
import { makeFixtures, FIXTURE_DIR } from './fixtures.mjs';

const { composeDocument } = await webModule('annotations/persist.js');
const { AnnotationStore } = await webModule('annotations/model.js');
const {
  addBookmark, bookmarkSections, clampOutlinePages, followOutlinePages, moveBookmark, nestBookmark,
  newBookmark, normalizeOutline, outlineTree, readOutline, removeBookmark, subtreeEnd, topLevelBookmarks,
  updateBookmark,
} = await webModule('pages/outline.js');

let bytes;
before(async () => { bytes = new Uint8Array(fs.readFileSync((await makeFixtures(FIXTURE_DIR)).bookmarks)); });

/** The outline of saved bytes, read back the way Vellum reads it. */
async function outlineOf(saved) {
  const js = await openWithPdfjs(saved);
  const list = await readOutline(js.doc);
  js.close();
  return list.map(({ title, page, depth, url }) => ({ title, page, depth, url }));
}

const shape = (list) => list.map((b) => `${'  '.repeat(b.depth)}${b.title} → ${b.page ?? b.url ?? '—'}`);

test('the file’s own outline reads as a flat list with its nesting and its pages', async () => {
  const before = Buffer.from(bytes);
  const list = await outlineOf(bytes);
  assert.deepEqual(shape(list), [
    'Introduction → 2',
    'Results / Findings: Q1* → 4',
    'Appendix → 6',
    '  A.1 Notes → 6',
    'Vellum online → https://example.com/vellum',
  ]);
  assert.ok(before.equals(Buffer.from(bytes)), 'reading never changes the opened bytes');
});

test('a document with no outline reads as an empty list', async () => {
  const plain = new Uint8Array(fs.readFileSync((await makeFixtures(FIXTURE_DIR)).multipage));
  assert.deepEqual(await outlineOf(plain), []);
});

test('create, rename, delete, reorder and nesting, all on the one list', async () => {
  const js = await openWithPdfjs(bytes);
  let list = await readOutline(js.doc);
  js.close();

  // Create: after the last entry, at its level.
  list = addBookmark(list, newBookmark({ title: 'Index', page: 5 }), list.at(-1).id);
  assert.equal(list.at(-1).title, 'Index');
  assert.equal(list.at(-1).page, 5);

  // Rename, and send somewhere else.
  const results = list.find((b) => b.title.startsWith('Results'));
  list = updateBookmark(list, results.id, { title: 'Findings', page: 3 });
  assert.equal(list.find((b) => b.id === results.id).title, 'Findings');
  assert.equal(list.find((b) => b.id === results.id).page, 3);

  // Reorder among siblings: the child comes with its parent.
  const appendix = list.find((b) => b.title === 'Appendix');
  list = moveBookmark(list, appendix.id, -1);
  assert.deepEqual(shape(list), [
    'Introduction → 2',
    'Appendix → 6',
    '  A.1 Notes → 6',
    'Findings → 3',
    'Vellum online → https://example.com/vellum',
    'Index → 5',
  ]);

  // Nesting: Findings becomes a child of Appendix; then out again.
  const findings = list.find((b) => b.title === 'Findings');
  list = nestBookmark(list, findings.id, 1);
  assert.equal(list.find((b) => b.id === findings.id).depth, 1);
  list = nestBookmark(list, findings.id, -1);
  assert.equal(list.find((b) => b.id === findings.id).depth, 0);

  // Delete takes everything under the entry with it.
  list = removeBookmark(list, appendix.id);
  assert.deepEqual(shape(list), ['Introduction → 2', 'Findings → 3', 'Vellum online → https://example.com/vellum', 'Index → 5']);
});

test('the list can never be nested in a way a PDF can’t hold', () => {
  const list = normalizeOutline([
    { id: 'a', title: 'A', page: 1, depth: 3 },
    { id: 'b', title: 'B', page: 2, depth: 7 },
    { id: 'c', title: '   ', page: null, depth: 0 },
    { id: 'd', title: 'D', page: 2, depth: 1 },
  ]);
  assert.deepEqual(list.map((b) => [b.title, b.depth]), [['A', 0], ['B', 1], ['D', 1]], 'the first entry is top level; each is at most one deeper');
  assert.equal(list.length, 3, 'an entry with no title and nowhere to go is dropped');

  // Moves that have nowhere to go leave the list exactly as it was.
  assert.equal(moveBookmark(list, 'a', -1), list);
  assert.equal(moveBookmark(list, 'd', 1), list);
  assert.equal(nestBookmark(list, 'a', 1), list, 'nothing above it to nest under');
  assert.equal(nestBookmark(list, 'a', -1), list, 'already top level');
  assert.equal(removeBookmark(list, 'nope'), list);
  assert.equal(subtreeEnd(list, 0), 3, 'A holds B and D');

  const tree = outlineTree(list);
  assert.equal(tree.length, 1);
  assert.deepEqual(tree[0].children.map((c) => c.title), ['B', 'D']);
});

test('a saved outline reopens with the same titles, pages and nesting', async () => {
  const js = await openWithPdfjs(bytes);
  let list = await readOutline(js.doc);
  js.close();
  list = addBookmark(list, newBookmark({ title: 'Index', page: 5 }), list.at(-1).id);
  list = updateBookmark(list, list.find((b) => b.title === 'Appendix').id, { title: 'Appendix A' });
  const child = list.find((b) => b.title === 'A.1 Notes');
  list = addBookmark(list, newBookmark({ title: 'A.2 More notes', page: 6 }), child.id);

  const saved = await composeDocument({ base: bytes, outline: list });
  assert.deepEqual(shape(await outlineOf(saved)), [
    'Introduction → 2',
    'Results / Findings: Q1* → 4',
    'Appendix A → 6',
    '  A.1 Notes → 6',
    '  A.2 More notes → 6',
    'Vellum online → https://example.com/vellum',
    'Index → 5',
  ]);
});

test('the file’s own bookmarks are left exactly as they are when the outline isn’t edited', async () => {
  const saved = await composeDocument({ base: bytes });
  assert.deepEqual(shape(await outlineOf(saved)), shape(await outlineOf(bytes)));
  // And the page-splitting reader still sees the same boundaries.
  const js = await openWithPdfjs(saved);
  const tops = await topLevelBookmarks(js.doc);
  js.close();
  assert.deepEqual(tops.map((b) => b.page), [2, 4, 6]);
  assert.deepEqual(bookmarkSections(tops, 6).map((s) => [s.title, s.from, s.to]), [
    [null, 1, 1], ['Introduction', 2, 3], ['Results / Findings: Q1*', 4, 5], ['Appendix', 6, 6],
  ]);
});

test('an outline with nothing left in it takes the outline out of the file', async () => {
  const saved = await composeDocument({ base: bytes, outline: [] });
  assert.deepEqual(await outlineOf(saved), []);
});

test('a bookmark past the last page loses its destination instead of breaking the file', async () => {
  const list = [newBookmark({ title: 'Way out there', page: 99 }), newBookmark({ title: 'Real', page: 2 })];
  assert.deepEqual(clampOutlinePages(list, 6).map((b) => b.page), [null, 2]);
  const saved = await composeDocument({ base: bytes, outline: list });
  assert.deepEqual(shape(await outlineOf(saved)), ['Way out there → —', 'Real → 2']);
});

test('bookmarks follow their pages when the pages are rearranged', () => {
  const plan = [{ id: 'p1' }, { id: 'p2' }, { id: 'p3' }];
  const list = [
    newBookmark({ title: 'One', page: 1 }),
    newBookmark({ title: 'Two', page: 2 }),
    newBookmark({ title: 'Three', page: 3 }),
  ];
  const reversed = [{ id: 'p3' }, { id: 'p2' }, { id: 'p1' }];
  assert.deepEqual(followOutlinePages(list, plan, reversed).map((b) => [b.title, b.page]), [['One', 3], ['Two', 2], ['Three', 1]]);
  // A bookmark whose page is gone keeps its title and loses its destination.
  const shorter = [{ id: 'p1' }, { id: 'p3' }];
  assert.deepEqual(followOutlinePages(list, plan, shorter).map((b) => [b.title, b.page]), [['One', 1], ['Two', null], ['Three', 2]]);
});

test('an outline change is one undo step in the same store as everything else', () => {
  const store = new AnnotationStore({ author: 'Test' });
  const first = [newBookmark({ title: 'One', page: 1 })];
  store.initOutline(first);
  assert.equal(store.canUndo, false, 'the outline the document opened with is not an edit');

  const second = addBookmark(first, newBookmark({ title: 'Two', page: 2 }), first[0].id);
  store.applyOutline(second);
  assert.equal(store.outline.length, 2);
  assert.equal(store.canUndo, true);

  store.undo();
  assert.deepEqual(store.outline.map((b) => b.title), ['One']);
  store.redo();
  assert.deepEqual(store.outline.map((b) => b.title), ['One', 'Two']);
});
