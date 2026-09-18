// Integration tests for the editing engine on generated fixtures, every page cross-checked with
// the app's own pdf.js build. Run: node --test "tests/editing/*.test.mjs"
// Extra real-world PDFs (read only) can be checked too: VELLUM_TEST_PDFS="a.pdf;b.pdf".

import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { analyzeFile, describeRuns, engine, loadPdfLib, openWithPdfjs, pdfjsPageData } from './harness.mjs';
import { makeFixtures, FIXTURE_DIR } from './fixtures.mjs';

const { openSource, SourceError } = await engine('source.js');
const { analyzePage, verifyPage } = await engine('runs.js');
const { fallbackFontFor, charactersOutsideWinAnsi } = await engine('fonts.js');

let files;
const cache = new Map();
before(async () => { files = await makeFixtures(FIXTURE_DIR); });

const read = (name) => new Uint8Array(fs.readFileSync(files[name]));
async function analyzed(name) {
  if (!cache.has(name)) cache.set(name, await analyzeFile(read(name)));
  return cache.get(name);
}
const runsOn = async (name, page = 0) => describeRuns((await analyzed(name)).pages[page]);
const byText = (runs, text) => {
  const found = runs.find((r) => r.text === text);
  assert.ok(found, `no run reads ${JSON.stringify(text)}; got ${JSON.stringify(runs.map((r) => r.text))}`);
  return found;
};
const fontNamed = (result, name) => [...result.source.fonts.values()].find((f) => f?.name === name);

test('simple text: each line is one run, decoded exactly and editable', async () => {
  const runs = await runsOn('simple');
  assert.deepEqual(runs.map((r) => [r.text, r.editable]), [
    ['Hello, world', true],
    ['A second line with punctuation: café, naïve — 50% off!', true],
    ['Third line.', true],
  ]);
  assert.deepEqual(runs[0].origin, [72, 700]);
  assert.equal(runs[0].size, 24);
});

test('multi-page, landscape and mixed page sizes (including a /Rotate 90 page)', async () => {
  const multi = await analyzed('multipage');
  assert.deepEqual(multi.pages.map((p) => describeRuns(p).map((r) => [r.text, r.editable])), [1, 2, 3, 4, 5].map((n) => [[`Page ${n} of five`, true]]));
  assert.deepEqual((await runsOn('landscape')).map((r) => [r.text, r.editable]), [['A landscape page', true]]);
  const mixed = await analyzed('mixed-sizes');
  assert.deepEqual(mixed.pages.map((p) => describeRuns(p).map((r) => [r.text, r.editable])),
    [[['Letter page', true]], [['A5 page', true]], [['Tabloid landscape', true]], [['Rotated page', true]]]);
});

test('fonts: standard 14, bold and italic, embedded TrueType (full and subset) and CFF all verified', async () => {
  const runs = await runsOn('fonts');
  for (const text of ['Helvetica regular', 'Helvetica bold', 'Helvetica oblique', 'Times regular', 'Times bold',
    'Times italic', 'Courier fixed', 'Liberation Sans embedded', 'Liberation Bold subset', 'Foxit Serif Type 1']) {
    assert.equal(byText(runs, text).editable, true, text);
  }
  const result = await analyzed('fonts');
  const style = (name) => fallbackFontFor(fontNamed(result, name)).name;
  assert.equal(style('Helvetica-Bold'), 'Helvetica-Bold');
  assert.equal(style('Helvetica-Oblique'), 'Helvetica-Oblique');
  assert.equal(style('Times-Italic'), 'Times-Italic');
  assert.equal(style('Times-Bold'), 'Times-Bold');
  assert.equal(style('Courier'), 'Courier');
  assert.equal(style('LiberationSans'), 'Helvetica');
  assert.equal(style('ChromSerifOTF'), 'Times-Roman');
});

test('font compatibility is conservative once pdf.js has confirmed what a font draws', async () => {
  const result = await analyzed('fonts');
  // Fonts the viewer supplies (not embedded) can write anything in their encoding.
  assert.equal(fontNamed(result, 'Helvetica').planText('New words: ñ, € and “quotes”').ok, true);
  // Embedded fonts can only write characters proven present — even a full, non-subset font.
  const full = fontNamed(result, 'LiberationSans').planText('Sandbox');
  assert.deepEqual([full.ok, full.missing], [false, ['x']]);
  const subset = fontNamed(result, 'LiberationSans-Bold');
  assert.equal(subset.planText('Liberation').ok, true);
  assert.deepEqual(subset.planText('Quartz').missing.sort(), ['Q', 'z']);
  // Scripts no available font can write are reported, not attempted.
  for (const font of [fontNamed(result, 'Helvetica'), subset]) {
    assert.equal(font.planText('नमस्ते').ok, false);
    assert.equal(font.planText('你好').ok, false);
  }
  assert.ok(charactersOutsideWinAnsi('नमस्ते 你好', result.source.glyphs).length > 0);
});

test('composite Identity-H font: ToUnicode decoding, no word spacing on two-byte codes, unmapped glyphs refused', async () => {
  const runs = await runsOn('composite');
  assert.equal(byText(runs, 'Composite Identity font text with spaces').editable, true);
  assert.equal(byText(runs, 'spaces with Tw').editable, true); // pdf.js confirmed every position
  // ToUnicode has neither 'Q' nor 'u' (the fixture maps only the words above): those glyphs can't be read.
  const unmapped = byText(runs, '��iet');
  assert.deepEqual([unmapped.editable, unmapped.reasons], [false, ['decode']]);
  const font = fontNamed(await analyzed('composite'), 'LiberationSans-Regular');
  assert.equal(font.planText('Composite').ok, true);
  assert.deepEqual(font.planText('Zebra').missing.sort(), ['Z', 'b', 'r']);
});

test('columns stay separate runs, even when one TJ spans both', async () => {
  const runs = await runsOn('columns');
  assert.equal(runs.length, 26);
  assert.ok(runs.every((r) => r.editable));
  assert.equal(byText(runs, 'Left column line 7').origin[0], 72);
  assert.equal(byText(runs, 'Right column line 7').origin[0], 320);
  byText(runs, 'Gap left');
  byText(runs, 'Gap right');
});

test('images and annotations around text leave it editable', async () => {
  assert.deepEqual((await runsOn('images')).map((r) => [r.text, r.editable]),
    [['Caption under the picture', true], ['Text beside another picture', true]]);
  assert.deepEqual((await runsOn('annotations')).map((r) => [r.text, r.editable]),
    [['Text with a link and a note', true], ['Field below:', true]]);
});

test('scanned pages are recognised; an OCR text layer is not treated as editable', async () => {
  const result = await analyzed('scanned');
  assert.equal(result.pages[0].summary.kind, 'scanned');
  assert.equal(result.pages[0].runs.length, 0);
  assert.equal(result.pages[1].summary.kind, 'scanned-ocr');
  assert.deepEqual(describeRuns(result.pages[1]).map((r) => [r.text, r.editable, r.reasons]), [['Recognised text layer', false, ['invisible']]]);
});

test('unusual constructs: each is read correctly or refused for the right reason', async () => {
  const runs = await runsOn('constructs');
  const expect = {
    'World kerned': true, 'Spaced and scaled words': true, Raised: true, 'Line one': true, 'Line two': true,
    'Line three': true, 'Hex string': true, 'Escapes (paren) back\\slash AB': true, 'After the inline image': true,
    'Café': true, 'Hi!': true, 'Rotated text': true, 'Upside-down text': true, 'Inside a rectangle clip': true,
    'Page footer artifact': true, 'Outlined text': true, 'Filled and outlined': true,
    // A clean depth-1 form with resources of its own: edited through a private copy of it.
    'Inside a form': true,
    OK: ['metrics'], abab: ['type3'], 'Skewed text': ['skewed'], 'Mirrored text': ['skewed'],
    'Clipped by a curve': ['clipped'], 'Cut by a rectangle clip': ['clipped'], 'Visible glyphs': ['actual-text'],
    'Invisible text': ['invisible'], 'Clip text': ['invisible'],
  };
  for (const [text, want] of Object.entries(expect)) {
    const run = byText(runs, text);
    if (want === true) assert.deepEqual([run.editable, run.reasons], [true, []], text);
    else assert.deepEqual([run.editable, run.reasons], [false, want], text);
  }
  const bold = runs.filter((r) => r.text === 'Fake bold');
  assert.equal(bold.length, 2);
  assert.ok(bold.every((r) => !r.editable && r.reasons.includes('overlap')));
  const zero = byText(runs, 'Zero size');
  assert.equal(zero.editable, false);
  assert.ok(zero.reasons.includes('degenerate'));
  // Positions follow the text state exactly (rise, leading from TL / ' / ").
  assert.deepEqual(byText(runs, 'Raised').origin, [72, 695]);
  assert.deepEqual(byText(runs, 'Line three').origin, [72, 642]);
});

test('a text object split across content streams, and text drawn before any font is chosen', async () => {
  const result = await analyzed('constructs');
  assert.deepEqual(describeRuns(result.pages[1]).map((r) => [r.text, r.editable]), [['Split across streams', true]]);
  // pdf.js skips the font-less text; the rest of the page still lines up with it and stays editable.
  assert.deepEqual(describeRuns(result.pages[2]).map((r) => [r.text, r.editable]), [['Normal text after it', true]]);
});

test('encrypted PDFs are refused by the engine (they still open in pdf.js with the right password)', async () => {
  const lib = await loadPdfLib();
  for (const name of ['encrypted-open', 'encrypted-password']) {
    await assert.rejects(openSource(lib, read(name)), (err) => err instanceof SourceError && err.kind === 'encrypted');
  }
  const open = await openWithPdfjs(read('encrypted-open'));
  assert.equal(open.doc.numPages, 1);
  await open.close();
  const locked = await openWithPdfjs(read('encrypted-password'), { password: 'secret' });
  const text = await (await locked.doc.getPage(1)).getTextContent();
  assert.equal(text.items[0].str, 'Protected text');
  await locked.close();
});

test('nothing is editable before pdf.js has confirmed it', async () => {
  const lib = await loadPdfLib();
  const source = await openSource(lib, read('simple'));
  const analysis = analyzePage(source.page(0));
  assert.ok(analysis.runs.length > 0);
  assert.ok(analysis.runs.every((r) => !r.editable && r.reasons.has('unverified')));
});

test('any disagreement with pdf.js makes the affected text non-editable', async () => {
  const lib = await loadPdfLib();
  const bytes = read('simple');
  const js = await openWithPdfjs(bytes);
  try {
    const fresh = async () => analyzePage((await openSource(lib, bytes)).page(0));
    const clone = (data) => ({ ...data, operatorList: structuredClone(data.operatorList), textContent: structuredClone(data.textContent) });
    const data = await pdfjsPageData(js, 1);

    // A different character for one glyph: that line only.
    const glyphs = clone(data);
    const firstShow = glyphs.operatorList.fnArray.indexOf(data.OPS.showText);
    glyphs.operatorList.argsArray[firstShow][0][0].unicode = 'X';
    const a = verifyPage(await fresh(), glyphs);
    assert.deepEqual(a.runs.map((r) => r.editable), [false, true, true]);
    assert.ok(a.runs[0].reasons.has('mismatch'));

    // A different width: that line only.
    const widths = clone(data);
    widths.operatorList.argsArray[firstShow][0][1].width += 40;
    assert.ok(verifyPage(await fresh(), widths).runs[0].reasons.has('metrics'));

    // pdf.js drew a different number of text operations: nothing on the page is trusted.
    const count = clone(data);
    count.operatorList.fnArray.splice(firstShow, 1);
    count.operatorList.argsArray.splice(firstShow, 1);
    assert.ok(verifyPage(await fresh(), count).runs.every((r) => !r.editable));

    // pdf.js places a line somewhere else: that line only.
    const moved = clone(data);
    const item = moved.textContent.items.find((i) => i.str === 'Third line.');
    item.transform = [...item.transform.slice(0, 4), item.transform[4] + 6, item.transform[5]];
    assert.deepEqual(verifyPage(await fresh(), moved).runs.map((r) => r.editable), [true, true, false]);
  } finally {
    await js.close();
  }
});

test('large document: 200 pages analyzed and verified quickly', async (t) => {
  const result = await analyzed('large');
  const runs = result.pages.flatMap((p) => p.runs);
  assert.equal(runs.length, 8000);
  assert.ok(runs.every((r) => r.editable));
  const perPage = (ms) => Math.round((ms / result.pages.length) * 100) / 100;
  t.diagnostic(`per page: analyze ${perPage(result.timing.analyze)} ms, pdf.js ${perPage(result.timing.pdfjs)} ms, verify ${perPage(result.timing.verify)} ms`);
  assert.ok(result.timing.analyze / result.pages.length < 25, 'analysis stays well under a frame per page');
});

test('real-world PDFs from VELLUM_TEST_PDFS (optional, read only)', async (t) => {
  const list = (process.env.VELLUM_TEST_PDFS ?? '').split(';').map((s) => s.trim()).filter(Boolean);
  if (!list.length) {
    t.skip('set VELLUM_TEST_PDFS to check real files');
    return;
  }
  for (const file of list) {
    let result;
    try {
      result = await analyzeFile(new Uint8Array(fs.readFileSync(file)));
    } catch (err) {
      if (err instanceof SourceError) {
        t.diagnostic(`${path.basename(file)}: refused (${err.kind})`);
        continue;
      }
      throw err;
    }
    const runs = result.pages.flatMap((p) => p.runs);
    const reasons = {};
    for (const r of runs) for (const why of r.reasons) reasons[why] = (reasons[why] ?? 0) + 1;
    t.diagnostic(`${path.basename(file)}: ${result.pages.length} pages, ${runs.filter((r) => r.editable).length}/${runs.length} runs editable; ${JSON.stringify(reasons)}`);
  }
});
