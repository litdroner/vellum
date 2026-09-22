// Merge Documents V1: several PDFs chosen from disk into one new PDF.
//
// The merge has no engine of its own — pages/merge.js builds a page plan and hands it to the writer
// every other page operation uses (annotations/persist.js composeDocument). Pinned here: the pages
// arrive in the order the files were listed, every page keeps its own size and rotation, reordering
// the list reorders the pages, a protected file is refused by name before anything is written, the
// chosen files are left byte for byte as they were, and the merged file reopens as a valid PDF.
// Run: node --test "tests/editing/merge.test.mjs"

import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { webModule, openWithPdfjs } from './harness.mjs';
import { makeFixtures, FIXTURE_DIR } from './fixtures.mjs';

const {
  MINIMUM_INPUTS, MergeInputError, mergeDocuments, mergePlan, countInputs,
  moveInput, removeInput, withoutDuplicates, mergedPageCount, mergedFileName,
} = await webModule('pages/merge.js');

let files;
before(async () => { files = await makeFixtures(FIXTURE_DIR); });

const read = (name) => new Uint8Array(fs.readFileSync(files[name]));
const input = (name) => ({ id: name, name: `${name}.pdf`, path: files[name], bytes: read(name) });

/** Every page of a PDF: its text, its box and the rotation it is shown at. */
async function pagesOf(bytes) {
  const js = await openWithPdfjs(bytes);
  try {
    const out = [];
    for (let n = 1; n <= js.doc.numPages; n++) {
      const page = await js.doc.getPage(n);
      const content = await page.getTextContent();
      out.push({
        text: content.items.map((i) => i.str).join(' ').replace(/\s+/g, ' ').trim(),
        width: Math.round(page.view[2] - page.view[0]),
        height: Math.round(page.view[3] - page.view[1]),
        rotate: page.rotate,
      });
    }
    return out;
  } finally {
    await js.close();
  }
}

// ---- the list the dialog shows -------------------------------------------------------------------

test('the merge list reorders, drops and de-duplicates without touching the rest', () => {
  const list = [{ id: 'a', path: 'A.pdf' }, { id: 'b', path: 'B.pdf' }, { id: 'c', path: 'C.pdf' }];
  assert.deepEqual(moveInput(list, 'c', -1).map((f) => f.id), ['a', 'c', 'b']);
  assert.deepEqual(moveInput(list, 'a', 1).map((f) => f.id), ['b', 'a', 'c']);
  assert.deepEqual(moveInput(list, 'a', -1).map((f) => f.id), ['a', 'b', 'c'], 'the first can’t move up');
  assert.deepEqual(moveInput(list, 'c', 1).map((f) => f.id), ['a', 'b', 'c'], 'the last can’t move down');
  assert.equal(moveInput(list, 'a', -1), list, 'a move that changes nothing returns the same list');
  assert.equal(moveInput(list, 'missing', 1), list);

  assert.deepEqual(removeInput(list, 'b').map((f) => f.id), ['a', 'c']);
  assert.equal(removeInput(list, 'missing'), list);

  const twice = [{ id: '1', path: 'A.pdf' }, { id: '2', path: 'a.PDF' }, { id: '3', path: 'B.pdf' }, { id: '4', path: null }];
  assert.deepEqual(withoutDuplicates(twice).map((f) => f.id), ['1', '3', '4'], 'the same file listed twice is kept once');

  assert.equal(mergedFileName('Report.pdf'), 'Report (merged).pdf');
  assert.equal(mergedFileName('Report'), 'Report (merged).pdf');
  assert.equal(mergedFileName(null), 'Document (merged).pdf');
});

test('the plan puts the first document in as the base and every other one as a source', () => {
  const counted = [{ id: 'a', pageCount: 2 }, { id: 'b', pageCount: 1 }, { id: 'c', pageCount: 3 }];
  const plan = mergePlan(counted);
  assert.equal(plan.length, 6);
  assert.deepEqual(plan.map((e) => `${e.src}:${e.index}`), ['base:0', 'base:1', 'b:0', 'c:0', 'c:1', 'c:2']);
  assert.ok(plan.every((e) => e.rotate === 0 && typeof e.id === 'string'));
  assert.equal(new Set(plan.map((e) => e.id)).size, 6, 'every entry is its own page');
  assert.equal(mergedPageCount(counted), 6);
});

// ---- merging -------------------------------------------------------------------------------------

test('two PDFs merge into one, page count and order following the list', async () => {
  const before = [input('simple'), input('multipage')];
  const bytes = await mergeDocuments(before);
  const pages = await pagesOf(bytes);

  assert.equal(pages.length, 6, 'one page from simple, five from multipage');
  assert.match(pages[0].text, /Hello, world/);
  assert.deepEqual(pages.slice(1).map((p) => p.text.match(/Page (\w+) of five/)?.[1]), ['1', '2', '3', '4', '5']);
});

test('reordering the list reorders the pages, and nothing else changes', async () => {
  const forward = await pagesOf(await mergeDocuments([input('simple'), input('multipage')]));
  const back = await pagesOf(await mergeDocuments([input('multipage'), input('simple')]));

  assert.equal(back.length, forward.length);
  assert.match(back[0].text, /Page 1 of five/);
  assert.match(back.at(-1).text, /Hello, world/);
  assert.deepEqual(back.map((p) => p.text).sort(), forward.map((p) => p.text).sort(), 'the same pages, in another order');
});

test('three PDFs merge in order, page sizes and rotation kept as they were', async () => {
  const sources = [input('mixed-sizes'), input('landscape'), input('simple')];
  const wanted = [];
  for (const f of sources) wanted.push(...await pagesOf(f.bytes));

  const pages = await pagesOf(await mergeDocuments(sources));
  assert.equal(pages.length, wanted.length);
  assert.deepEqual(pages, wanted, 'every page arrives with its own text, box and rotation');
  // The fixture's own shapes, spelled out: the merge must not normalise any of them.
  assert.deepEqual(pages.slice(0, 4).map((p) => [p.width, p.height, p.rotate]),
    [[612, 792, 0], [420, 595, 0], [1224, 792, 0], [612, 792, 90]]);
  assert.deepEqual([pages[4].width, pages[4].height], [792, 612], 'the landscape page stays landscape');
});

test('the same files in the same order give the same bytes', async () => {
  const once = await mergeDocuments([input('simple'), input('mixed-sizes')]);
  const again = await mergeDocuments([input('simple'), input('mixed-sizes')]);
  assert.deepEqual(Buffer.from(once), Buffer.from(again));
});

// ---- refusals ------------------------------------------------------------------------------------

test('a protected PDF is refused by name, whether it is the first file or a later one', async () => {
  for (const order of [[input('encrypted-password'), input('simple')], [input('simple'), input('encrypted-password')]]) {
    await assert.rejects(() => mergeDocuments(order), (err) => {
      assert.ok(err instanceof MergeInputError, 'refused as a merge input problem');
      assert.equal(err.fileName, 'encrypted-password.pdf');
      assert.match(err.message, /“encrypted-password\.pdf” can’t be merged\./);
      assert.match(err.message, /protected \(encrypted\)/, 'in the words Vellum already uses');
      return true;
    });
  }
});

test('a damaged file is refused by name, and fewer than two files is refused before anything is read', async () => {
  const broken = { id: 'x', name: 'broken.pdf', bytes: new Uint8Array([1, 2, 3, 4]) };
  await assert.rejects(() => mergeDocuments([input('simple'), broken]), (err) => {
    assert.equal(err.fileName, 'broken.pdf');
    return true;
  });
  for (const few of [[], [input('simple')]]) {
    await assert.rejects(() => mergeDocuments(few), new RegExp(`at least ${MINIMUM_INPUTS} PDFs`));
  }
});

// ---- the chosen files ----------------------------------------------------------------------------

test('the files that were merged are left byte for byte as they were', async () => {
  const names = ['simple', 'multipage', 'mixed-sizes'];
  const before = Object.fromEntries(names.map((n) => [n, Buffer.from(fs.readFileSync(files[n]))]));
  const inputs = names.map(input);

  await mergeDocuments(inputs);

  for (const n of names) {
    assert.deepEqual(Buffer.from(fs.readFileSync(files[n])), before[n], `${n}.pdf is untouched on disk`);
    assert.deepEqual(Buffer.from(inputs.find((f) => f.id === n).bytes), before[n], `${n}.pdf’s bytes in memory are untouched`);
  }
});

test('the merged PDF reopens as a valid document, its pages readable and its text still text', async () => {
  const bytes = await mergeDocuments([input('simple'), input('mixed-sizes')]);
  assert.equal(Buffer.from(bytes.subarray(0, 5)).toString('latin1'), '%PDF-');

  const js = await openWithPdfjs(bytes);
  try {
    assert.equal(js.doc.numPages, 5);
    for (let n = 1; n <= js.doc.numPages; n++) {
      const page = await js.doc.getPage(n);
      const ops = await page.getOperatorList();
      assert.ok(ops.fnArray.length > 0, `page ${n} draws something`);
      // Nothing is rasterized: the merged pages hold no image the sources didn't have.
      assert.ok(!ops.fnArray.includes(js.pdfjs.OPS.paintImageXObject), `page ${n} is not a picture of a page`);
    }
    const first = await (await js.doc.getPage(1)).getTextContent();
    assert.match(first.items.map((i) => i.str).join(' '), /Hello, world/);
  } finally {
    await js.close();
  }
});
