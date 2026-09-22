// Split by bookmarks V1: cutting a document where its own top-level bookmarks begin.
//
// There is no second split here. pages/outline.js turns the document's outline into sections — page
// ranges with names — and the existing split writes each one with the writer it already used
// (annotations/persist.js composeDocument over a page plan), exactly as a page-range split does.
// Pinned here: only a bookmark whose destination really resolves is a boundary (a link with no page
// is passed over, a nested entry is not a boundary), the pages before the first bookmark are kept as
// a section of their own, file names come from the titles and are safe and deterministic, every page
// lands in exactly one output, and the document that was split is untouched.
// Run: node --test "tests/editing/split-bookmarks.test.mjs"

import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { webModule, openWithPdfjs } from './harness.mjs';
import { makeFixtures, FIXTURE_DIR } from './fixtures.mjs';

const { bookmarkSections, destinationPage, safeFileName, sectionFileNames, topLevelBookmarks } = await webModule('pages/outline.js');
const { composeDocument } = await webModule('annotations/persist.js');
const { identityPlan } = await webModule('pages/plan.js');

let files;
before(async () => { files = await makeFixtures(FIXTURE_DIR); });
const read = (name) => new Uint8Array(fs.readFileSync(files[name]));

const withDoc = async (bytes, run) => {
  const js = await openWithPdfjs(bytes);
  try { return await run(js); } finally { await js.close(); }
};

/** The text of every page, the way the pages read. */
const pageTexts = (js) => Promise.all(Array.from({ length: js.doc.numPages }, async (_, i) => {
  const content = await (await js.doc.getPage(i + 1)).getTextContent();
  return content.items.map((it) => it.str).join(' ').replace(/\s+/g, ' ').trim();
}));

/** One section written out, the way the split writes it: the page plan, minus the pages it doesn't hold. */
const writeSection = (bytes, section, total) => composeDocument({
  base: bytes, plan: identityPlan(total).slice(section.from - 1, section.to),
});

// ---- reading the outline -------------------------------------------------------------------------

test('a bookmark is a boundary only when its destination really resolves to a page', async () => {
  const bookmarks = await withDoc(read('bookmarks'), (js) => topLevelBookmarks(js.doc));
  assert.deepEqual(bookmarks, [
    { title: 'Introduction', page: 2 },
    { title: 'Results / Findings: Q1*', page: 4 },
    { title: 'Appendix', page: 6 },
  ], 'the explicit and the named destination resolve; the entry that is only a link has no page');
  // The nested entry under "Appendix" is on page 6 too, and is not a boundary of its own.
  const outline = await withDoc(read('bookmarks'), (js) => js.doc.getOutline());
  assert.equal(outline.length, 4);
  assert.equal(outline[2].items.length, 1, 'the nested entry is there, and stays inside its parent');
});

test('a document with no outline, and a destination that points nowhere, give nothing', async () => {
  assert.deepEqual(await withDoc(read('multipage'), (js) => topLevelBookmarks(js.doc)), []);
  await withDoc(read('bookmarks'), async (js) => {
    assert.equal(await destinationPage(js.doc, null), null);
    assert.equal(await destinationPage(js.doc, 'no-such-destination'), null);
    assert.equal(await destinationPage(js.doc, []), null);
    assert.equal(await destinationPage(js.doc, 'appendix'), 6, 'a named destination resolves');
  });
});

// ---- the sections --------------------------------------------------------------------------------

test('the sections run from each bookmark to the page before the next, and cover every page once', () => {
  const sections = bookmarkSections([{ title: 'Introduction', page: 2 }, { title: 'Results', page: 4 }, { title: 'Appendix', page: 6 }], 6);
  assert.deepEqual(sections, [
    { title: null, from: 1, to: 1 },
    { title: 'Introduction', from: 2, to: 3 },
    { title: 'Results', from: 4, to: 5 },
    { title: 'Appendix', from: 6, to: 6 },
  ]);
  const covered = sections.flatMap((s) => Array.from({ length: s.to - s.from + 1 }, (_, i) => s.from + i));
  assert.deepEqual(covered, [1, 2, 3, 4, 5, 6], 'every page, once, in order');
});

test('a bookmark on page 1 makes no leading section; two on one page are one boundary', () => {
  assert.deepEqual(bookmarkSections([{ title: 'One', page: 1 }, { title: 'Two', page: 3 }], 4), [
    { title: 'One', from: 1, to: 2 },
    { title: 'Two', from: 3, to: 4 },
  ]);
  assert.deepEqual(bookmarkSections([{ title: 'First here', page: 2 }, { title: 'Also here', page: 2 }], 3), [
    { title: null, from: 1, to: 1 },
    { title: 'First here', from: 2, to: 3 },
  ], 'the first in outline order names the section');
});

test('bookmarks out of range, or none at all, give no sections', () => {
  assert.deepEqual(bookmarkSections([], 5), []);
  assert.deepEqual(bookmarkSections([{ title: 'Off the end', page: 9 }, { title: 'Before the start', page: 0 }], 5), []);
  assert.deepEqual(bookmarkSections([{ title: 'Kept', page: 3 }, { title: 'Off the end', page: 9 }], 5),
    [{ title: null, from: 1, to: 2 }, { title: 'Kept', from: 3, to: 5 }]);
});

// ---- file names ----------------------------------------------------------------------------------

test('a title becomes a file name Windows will take', () => {
  assert.equal(safeFileName('Results / Findings: Q1*'), 'Results Findings Q1');
  assert.equal(safeFileName('a\\b<c>d|e?f"g'), 'a b c d e f g');
  assert.equal(safeFileName('Chapter one.'), 'Chapter one');
  assert.equal(safeFileName('   '), 'Section');
  assert.equal(safeFileName('***', 'Part 2'), 'Part 2');
  assert.equal(safeFileName('NUL'), 'NUL (section)', 'a Windows device name is not left as one');
  assert.equal(safeFileName('con'), 'con (section)');
  assert.equal(safeFileName('Contents'), 'Contents', 'a name that merely starts like one is left alone');
  const long = safeFileName('x'.repeat(200));
  assert.equal(long.length, 60);
  assert.ok(!/[\u0000-\u001f]/.test(safeFileName('a\u0001b')));
});

test('the sections are named from their titles, the first part from the document, and never clash', () => {
  const sections = [{ title: null, from: 1, to: 1 }, { title: 'Introduction', from: 2, to: 3 }, { title: 'Appendix', from: 4, to: 6 }];
  assert.deepEqual(sectionFileNames(sections, 'Report'), ['Report (page 1).pdf', 'Introduction.pdf', 'Appendix.pdf']);
  assert.deepEqual(sectionFileNames([{ title: null, from: 1, to: 3 }], 'Report'), ['Report (pages 1-3).pdf']);
  assert.deepEqual(sectionFileNames([{ title: 'Notes', from: 1, to: 1 }, { title: 'Notes', from: 2, to: 2 }, { title: 'notes', from: 3, to: 3 }], 'X'),
    ['Notes.pdf', 'Notes (2).pdf', 'notes (3).pdf'], 'the same title twice is numbered, ignoring case');
  assert.deepEqual(sectionFileNames(sections, 'Report'), sectionFileNames(sections, 'Report'), 'the same sections always give the same names');
});

// ---- splitting the real document -----------------------------------------------------------------

test('the document splits at its bookmarks: the right pages, in order, in each file', async () => {
  const bytes = read('bookmarks');
  const sections = bookmarkSections(await withDoc(bytes, (js) => topLevelBookmarks(js.doc)), 6);
  assert.deepEqual(sections.map((s) => [s.title, s.from, s.to]), [
    [null, 1, 1], ['Introduction', 2, 3], ['Results / Findings: Q1*', 4, 5], ['Appendix', 6, 6],
  ]);
  assert.deepEqual(sectionFileNames(sections, 'bookmarks'),
    ['bookmarks (page 1).pdf', 'Introduction.pdf', 'Results Findings Q1.pdf', 'Appendix.pdf']);

  const whole = await withDoc(bytes, pageTexts);
  const seen = [];
  for (const section of sections) {
    const out = await writeSection(bytes, section, 6);
    const texts = await withDoc(out, async (js) => {
      assert.equal(js.doc.numPages, section.to - section.from + 1, `${section.title ?? 'the first part'} has its own pages`);
      return pageTexts(js);
    });
    assert.deepEqual(texts, whole.slice(section.from - 1, section.to), 'the pages arrive in order, with their own content');
    seen.push(...texts);
  }
  assert.deepEqual(seen, whole, 'across the outputs, every page of the document appears once, in order');
});

test('every output reopens as a valid PDF and its text is still text', async () => {
  const bytes = read('bookmarks');
  const sections = bookmarkSections(await withDoc(bytes, (js) => topLevelBookmarks(js.doc)), 6);
  for (const section of sections) {
    const out = await writeSection(bytes, section, 6);
    assert.equal(Buffer.from(out.subarray(0, 5)).toString('latin1'), '%PDF-');
    await withDoc(out, async (js) => {
      for (let n = 1; n <= js.doc.numPages; n++) {
        const ops = await (await js.doc.getPage(n)).getOperatorList();
        assert.ok(ops.fnArray.length > 0, 'the page draws something');
        assert.ok(!ops.fnArray.includes(js.pdfjs.OPS.paintImageXObject), 'nothing was rasterized');
      }
      assert.match((await pageTexts(js))[0], /page \d of six/);
    });
  }
});

test('the document that was split is left byte for byte as it was', async () => {
  const before = Buffer.from(fs.readFileSync(files.bookmarks));
  const bytes = read('bookmarks');
  const sections = bookmarkSections(await withDoc(bytes, (js) => topLevelBookmarks(js.doc)), 6);
  for (const section of sections) await writeSection(bytes, section, 6);
  assert.deepEqual(Buffer.from(fs.readFileSync(files.bookmarks)), before, 'untouched on disk');
  assert.deepEqual(Buffer.from(bytes), before, 'untouched in memory');
});
