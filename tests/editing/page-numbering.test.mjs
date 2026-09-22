// Page numbering, the parts added in 0.24: roman numerals and a count that can begin again on the
// pages chosen. Everything else about numbering — that it is real text, upright on rotated pages,
// following moves, duplicates and undo — is unchanged and stays proved in page-stamps.test.mjs.
//
// Nothing new writes anything: the numbers are still drawn by pages/stamps.js into /Artifact
// pagination content by the one writer (annotations/persist.js composeDocument). Pinned here: the
// numerals themselves, what a run counts over, the text the pages end up carrying, and that a
// document numbered this way is written from the source without the source being touched.
// Run: node --test "tests/editing/page-numbering.test.mjs"

import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { openWithPdfjs, webModule } from './harness.mjs';
import { makeFixtures, FIXTURE_DIR } from './fixtures.mjs';

const { composeDocument } = await webModule('annotations/persist.js');
const { identityPlan, setPageSetting } = await webModule('pages/plan.js');
const { PAGE_NUMBER_STYLES, numberingRuns, pageNumberText, romanNumeral } = await webModule('pages/stamps.js');

let files;
before(async () => { files = await makeFixtures(FIXTURE_DIR); });
const read = (name) => new Uint8Array(fs.readFileSync(files[name]));

/** The text of every page, in reading order. */
async function textOf(bytes) {
  const js = await openWithPdfjs(bytes);
  try {
    const out = [];
    for (let n = 1; n <= js.doc.numPages; n++) {
      const items = (await (await js.doc.getPage(n)).getTextContent()).items.map((i) => i.str.trim()).filter(Boolean);
      out.push(items);
    }
    return out;
  } finally {
    await js.close();
  }
}

const numbered = (plan, from, to, setting) =>
  setPageSetting(plan, new Set(plan.slice(from - 1, to).map((e) => e.id)), 'pageNumber', setting);

// ---- the numerals --------------------------------------------------------------------------------

test('roman numerals are written the way they are written', () => {
  const wanted = { 1: 'i', 2: 'ii', 3: 'iii', 4: 'iv', 5: 'v', 6: 'vi', 7: 'vii', 8: 'viii', 9: 'ix', 10: 'x',
    14: 'xiv', 19: 'xix', 40: 'xl', 49: 'xlix', 90: 'xc', 400: 'cd', 900: 'cm', 1990: 'mcmxc', 2024: 'mmxxiv', 3999: 'mmmcmxcix' };
  for (const [value, text] of Object.entries(wanted)) assert.equal(romanNumeral(Number(value)), text, `${value}`);
});

test('a number with no roman numeral is written as the number it is', () => {
  for (const value of [0, -1, 4000, 10000, 1.5, NaN]) assert.equal(romanNumeral(value), String(value), `${value}`);
});

test('the style decides how {n} and {total} read, and the text around them is left alone', () => {
  const format = 'Page {n} of {total}';
  assert.equal(pageNumberText({ format, start: 1, style: 'arabic' }, 4, 9), 'Page 4 of 9');
  assert.equal(pageNumberText({ format, start: 1, style: 'roman' }, 4, 9), 'Page iv of ix');
  assert.equal(pageNumberText({ format, start: 1, style: 'ROMAN' }, 4, 9), 'Page IV of IX');
  assert.equal(pageNumberText({ format: '— {n} —', start: 1, style: 'roman' }, 2, 5), '— ii —');
  assert.equal(pageNumberText({ format: 'Appendix A-{n}', start: 1, style: 'arabic' }, 3, 5), 'Appendix A-3',
    'a prefix and a suffix are just the text around {n}');
  assert.equal(pageNumberText({ format: '{n}', start: 5, style: 'roman' }, 1, 3), 'v', 'the start counts before the numeral is made');
  assert.equal(pageNumberText({ format: '{n}' }, 2, 3), '2', 'no style given is still arabic');
  assert.deepEqual(PAGE_NUMBER_STYLES, ['arabic', 'roman', 'ROMAN']);
});

// ---- what a run counts over ----------------------------------------------------------------------

test('without restarting, every page counts its place in the whole document', () => {
  const setting = { format: '{n}', start: 1, style: 'arabic', restart: false };
  const plan = numbered(identityPlan(4), 1, 4, setting);
  assert.deepEqual(numberingRuns(plan), [{ n: 1, total: 4 }, { n: 2, total: 4 }, { n: 3, total: 4 }, { n: 4, total: 4 }]);
});

test('restarting counts inside the run, and a page with no number counts for nothing', () => {
  const setting = { format: '{n}', start: 1, style: 'roman', restart: true };
  const plan = numbered(identityPlan(5), 2, 4, setting);
  assert.deepEqual(numberingRuns(plan), [null, { n: 1, total: 3 }, { n: 2, total: 3 }, { n: 3, total: 3 }, null]);
});

test('two stretches numbered alike each begin again; a different setting between them breaks the run', () => {
  const front = { format: '{n}', start: 1, style: 'roman', restart: true };
  const body = { format: '{n}', start: 1, style: 'arabic', restart: true };
  let plan = numbered(identityPlan(6), 1, 2, front);
  plan = numbered(plan, 3, 4, body);
  plan = numbered(plan, 5, 6, front);
  assert.deepEqual(numberingRuns(plan), [
    { n: 1, total: 2 }, { n: 2, total: 2 },
    { n: 1, total: 2 }, { n: 2, total: 2 },
    { n: 1, total: 2 }, { n: 2, total: 2 },
  ], 'each stretch is its own run, even where the settings repeat');
});

test('a page numbered from the document among restarting pages keeps the document’s count', () => {
  const restarting = { format: '{n}', start: 1, style: 'arabic', restart: true };
  const whole = { format: '{n}', start: 1, style: 'arabic', restart: false };
  let plan = numbered(identityPlan(4), 1, 2, restarting);
  plan = numbered(plan, 3, 3, whole);
  plan = numbered(plan, 4, 4, restarting);
  assert.deepEqual(numberingRuns(plan), [{ n: 1, total: 2 }, { n: 2, total: 2 }, { n: 3, total: 4 }, { n: 1, total: 1 }]);
});

// ---- the pages that come out ----------------------------------------------------------------------

test('front matter in roman and a body from one: the saved pages read exactly that', async () => {
  const bytes = read('multipage');
  let plan = identityPlan(5);
  plan = numbered(plan, 1, 2, { format: '{n}', position: 'bottom-center', size: 10, start: 1, style: 'roman', restart: true });
  plan = numbered(plan, 3, 5, { format: 'Page {n} of {total}', position: 'bottom-center', size: 10, start: 1, style: 'arabic', restart: true });

  const pages = await textOf(await composeDocument({ base: bytes, plan }));
  assert.equal(pages.length, 5);
  assert.deepEqual(pages.map((items) => items.at(-1)), ['i', 'ii', 'Page 1 of 3', 'Page 2 of 3', 'Page 3 of 3']);
  pages.forEach((items, i) => assert.ok(items.some((s) => s === `Page ${i + 1} of five`), `page ${i + 1} keeps its own text`));
});

test('capitals, a start of its own, and a prefix all reach the page', async () => {
  const plan = numbered(identityPlan(5), 1, 5,
    { format: 'Part A-{n}', position: 'top-right', size: 11, start: 4, style: 'ROMAN', restart: false });
  const pages = await textOf(await composeDocument({ base: read('multipage'), plan }));
  assert.deepEqual(pages.map((items) => items.find((s) => s.startsWith('Part A-'))),
    ['Part A-IV', 'Part A-V', 'Part A-VI', 'Part A-VII', 'Part A-VIII']);
});

test('numbers stay real text in a saved file, and the file it was made from is untouched', async () => {
  const before = Buffer.from(fs.readFileSync(files.multipage));
  const bytes = read('multipage');
  const plan = numbered(identityPlan(5), 1, 5, { format: '{n}', position: 'bottom-center', size: 10, start: 1, style: 'roman', restart: true });

  const out = await composeDocument({ base: bytes, plan });
  assert.deepEqual(Buffer.from(fs.readFileSync(files.multipage)), before, 'the source on disk is untouched');
  assert.deepEqual(Buffer.from(bytes), before, 'the source in memory is untouched');

  // Saved, closed and opened again: still selectable text, and still nothing rasterized.
  const js = await openWithPdfjs(out);
  try {
    assert.equal(js.doc.numPages, 5);
    for (let n = 1; n <= 5; n++) {
      const page = await js.doc.getPage(n);
      const ops = await page.getOperatorList();
      assert.ok(!ops.fnArray.includes(js.pdfjs.OPS.paintImageXObject), `page ${n} was not rasterized`);
      const items = (await page.getTextContent()).items.map((i) => i.str.trim());
      assert.ok(items.includes(romanNumeral(n)), `page ${n} reads ${romanNumeral(n)}`);
    }
  } finally {
    await js.close();
  }
  // Composing the same plan again gives the same file: numbering adds nothing that varies.
  assert.deepEqual(Buffer.from(await composeDocument({ base: read('multipage'), plan })), Buffer.from(out));
});
