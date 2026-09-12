// Vellum 0.5.0 Phase 1, Step 0: characterization baselines taken BEFORE the object model and the
// unified page writer exist. Nothing here tests a new feature — every assertion records what the
// 0.4 engine does today, so that extracting the writer (Step 1) and deriving page objects (Step 2)
// have to prove they changed nothing. A failure in this file means behaviour moved; if the move was
// intended, the expected text below is what gets updated, deliberately and in review.
// Run: node --test "tests/editing/*.test.mjs"
//
// The golden values are readable content-stream text, not hashes: composeDocument happens to be
// byte-stable across runs, but a hash would fail opaquely after (say) a pdf-lib upgrade, whereas a
// content stream fails as a diff you can read.

import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { analyzeFile, engine, loadPdfLib, webModule } from './harness.mjs';
import { makeFixtures, FIXTURE_DIR } from './fixtures.mjs';

const { openSource } = await engine('source.js');
const { planTextEdit } = await engine('edits.js');
const { composeDocument } = await webModule('annotations/persist.js');
const { identityPlan } = await webModule('pages/plan.js');

let files;
const cache = new Map();
before(async () => { files = await makeFixtures(FIXTURE_DIR); });
const read = (name) => new Uint8Array(fs.readFileSync(files[name]));

async function analyzed(name) {
  if (!cache.has(name)) cache.set(name, await analyzeFile(read(name)));
  return cache.get(name);
}

/** A document as the app would hold it (same shape the other suites use). */
async function open(bytes) {
  const result = await analyzeFile(bytes);
  return { bytes, result, plan: identityPlan(result.source.pageCount) };
}

function planEdit(d, page, fromText, toText) {
  const run = d.result.pages[page].runs.find((r) => r.text === fromText);
  assert.ok(run, `no run ${JSON.stringify(fromText)} on page ${page + 1}`);
  return planTextEdit({ run, text: toText, entry: d.plan[page].id, glyphs: d.result.source.glyphs });
}

const compose = (d, edits, extra = {}) => composeDocument({ base: d.bytes, plan: d.plan, edits, ...extra });

/** Every page's decoded content stream and resource dictionary: exactly what the writer controls. */
async function pageShapes(bytes) {
  const lib = await loadPdfLib();
  const doc = await lib.PDFDocument.load(bytes, { updateMetadata: false });
  const source = await openSource(lib, bytes);
  return doc.getPages().map((p) => ({
    content: Buffer.from(source.contentBytes(p.node)).toString('latin1'),
    resources: p.node.Resources()?.toString() ?? null,
  }));
}

const contentOf = async (bytes, pageIndex) => (await pageShapes(bytes))[pageIndex].content;

/**
 * Compares a composed content stream with its golden text. Only the very end is trimmed: the
 * decoded content carries a trailing newline from joining streams, which says nothing about the
 * writer. Every blank line inside the stream is significant and is compared.
 */
const sameContent = (actual, expected, what) => assert.equal(actual.trimEnd(), expected.trimEnd(), what);

const count = (haystack, needle) => haystack.split(needle).length - 1;

// ---- 1. the current text writer's output, frozen ------------------------------------------------
// Each case covers a different branch of apply.js: plain replacement, a non-zero crop origin, a
// substitute standard font (which adds a resource), two-byte codes, ExtGState replay, a page that
// leaves states open, and removal. The shape is always: the page's own content wrapped in q … Q
// with the edited glyphs neutralised to an equal advance, then the new text drawn from a clean
// state. If Step 1 changes any byte of this, these tests say exactly which.

test('writer baseline: a plain replacement in the text’s own font', async () => {
  const d = await open(read('simple'));
  const saved = await compose(d, [planEdit(d, 0, 'Hello, world', 'Hello, Vellum')]);
  sameContent(await contentOf(saved, 0), `q
BT /F1 24 Tf 72 700 Td [-5223] TJ ET
BT /F1 12 Tf 72 660 Td (A second line with punctuation: caf\\351, na\\357ve \\227 50% off!) Tj ET
BT /F1 12 Tf 72 640 Td (Third line.) Tj ET

Q
q
1 0 0 1 0 0 cm
BT
/F1 24 Tf
0 Tc 0 Tw 100 Tz 0 Ts 0 Tr
1 0 0 1 72 700 Tm
[<48656c6c6f2c2056656c6c756d>] TJ
ET
Q`);
});

test('writer baseline: a page whose crop box doesn’t start at the origin', async () => {
  const d = await open(read('cropbox'));
  const saved = await compose(d, [planEdit(d, 0, 'Inside an offset crop box', 'Still inside the crop box')]);
  sameContent(await contentOf(saved, 0), `q
BT /F1 14 Tf 120 600 Td [-10895] TJ ET
BT /F1 14 Tf 120 150 Td (Near the bottom of the crop) Tj ET

Q
q
1 0 0 1 0 0 cm
BT
/F1 14 Tf
0 Tc 0 Tw 100 Tz 0 Ts 0 Tr
1 0 0 1 120 600 Tm
[<5374696c6c20696e73696465207468652063726f7020626f78>] TJ
ET
Q`);
});

test('writer baseline: a substitute standard font is drawn with, and added to, the page’s resources', async () => {
  const d = await open(read('fonts'));
  const record = planEdit(d, 0, 'Liberation Sans embedded', 'Quartz jumps');
  assert.deepEqual([record.encoding.mode, record.encoding.font], ['standard', 'Helvetica'], 'the case this test is about');
  const saved = await compose(d, [record]);
  sameContent(await contentOf(saved, 0), `q
BT /H 14 Tf 72 720 Td (Helvetica regular) Tj ET
BT /HB 14 Tf 72 700 Td (Helvetica bold) Tj ET
BT /HI 14 Tf 72 680 Td (Helvetica oblique) Tj ET
BT /T 14 Tf 72 650 Td (Times regular) Tj ET
BT /TB 14 Tf 72 630 Td (Times bold) Tj ET
BT /TI 14 Tf 72 610 Td (Times italic) Tj ET
BT /C 14 Tf 72 580 Td (Courier fixed) Tj ET
BT /LS 14 Tf 72 550 Td [-11951] TJ ET
BT /LB 14 Tf 72 530 Td (Liberation Bold subset) Tj ET
BT /FX 14 Tf 72 500 Td (Foxit Serif Type 1) Tj ET

Q
q
1 0 0 1 0 0 cm
BT
/VlF1 14 Tf
0 Tc 0 Tw 100 Tz 0 Ts 0 Tr
1 0 0 1 72 550 Tm
[<51756172747a206a756d7073>] TJ
ET
Q`);
});

test('writer baseline: two-byte codes through a composite font', async () => {
  const d = await open(read('composite'));
  const saved = await compose(d, [planEdit(d, 0, 'Composite Identity font text with spaces', 'Composite text')]);
  sameContent(await contentOf(saved, 0), `q
BT /F0 16 Tf 72 700 Td [-17619] TJ ET
BT /F0 12 Tf 8 Tw 72 670 Td <0056005300440046004800560003005a004c0057004b00030037005a> Tj ET
BT /F0 12 Tf 0 Tw 72 640 Td <00340058004c00480057> Tj ET

Q
q
1 0 0 1 0 0 cm
BT
/F0 16 Tf
0 Tc 0 Tw 100 Tz 0 Ts 0 Tr
1 0 0 1 72 700 Tm
[<002600520050005300520056004c00570048000300570048005b0057>] TJ
ET
Q`);
});

test('writer baseline: an ExtGState (opacity) is replayed before the new text', async () => {
  const d = await open(read('transparency'));
  const saved = await compose(d, [planEdit(d, 0, 'Half-transparent text', 'Still half-transparent')]);
  sameContent(await contentOf(saved, 0), `q
q /Mask gs BT /F1 14 Tf 72 700 Td (Masked text) Tj ET Q
q /Mask gs /NoMask gs BT /F1 14 Tf 72 670 Td (Mask cleared again) Tj ET Q
q /Half gs BT /F1 14 Tf 72 640 Td [-9059] TJ ET Q
q /Multiply gs BT /F1 14 Tf 72 610 Td (Multiplied text) Tj ET Q
BT /F1 14 Tf 72 580 Td (Plain text) Tj ET

Q
q
/Half gs
1 0 0 1 0 0 cm
BT
/F1 14 Tf
0 Tc 0 Tw 100 Tz 0 Ts 0 Tr
1 0 0 1 72 640 Tm
[<5374696c6c2068616c662d7472616e73706172656e74>] TJ
ET
Q`);
});

test('writer baseline: a page that leaves a text object and two states open is closed around the new text', async () => {
  const d = await open(read('constructs'));
  const saved = await compose(d, [planEdit(d, 4, 'Left open', 'Closed now')]);
  // The page's own CTM (1 0 0 1 20 0, from its unclosed q … cm) is repeated for the new text.
  sameContent(await contentOf(saved, 4), `q
q 1 0 0 1 20 0 cm q BT /H 12 Tf 52 700 Td [-4170] TJ

ET
Q
Q
Q
q
1 0 0 1 20 0 cm
BT
/H 12 Tf
0 Tc 0 Tw 100 Tz 0 Ts 0 Tr
1 0 0 1 52 700 Tm
[<436c6f736564206e6f77>] TJ
ET
Q`);
});

test('writer baseline: removing text neutralises the glyphs and draws nothing new', async () => {
  const d = await open(read('constructs'));
  const record = planEdit(d, 0, 'Hex string', '');
  assert.equal(record.encoding.mode, 'none', 'the case this test is about');
  const before = await contentOf(d.bytes, 0);
  const after = await contentOf(await compose(d, [record]), 0);
  assert.ok(after.includes('BT /H 12 Tf 72 610 Td [-5001] TJ ET'), 'the glyphs became an equal advance');
  assert.ok(!after.includes('48657820737472696e67'), 'the removed text is gone from the stream');
  assert.equal(count(after, 'BT'), count(before, 'BT'), 'no text object was appended for a removal');
  assert.ok(after.length < before.length, 'a removal only shrinks the stream');
});

// ---- 2. edited-page content streams and resource dictionaries stay equivalent -------------------

test('composing is deterministic: the same edits twice produce the same bytes', async () => {
  // Not a golden value — a property. It is what lets the goldens above be trusted at all, and it
  // must survive the writer extraction.
  const d = await open(read('simple'));
  const edits = [planEdit(d, 0, 'Hello, world', 'Hello, Vellum')];
  const [a, b] = [await compose(d, edits), await compose(d, edits)];
  assert.deepEqual(Buffer.from(a), Buffer.from(b), 'composeDocument is not byte-deterministic');
});

test('only the edited page’s content and resources change; every other page is untouched', async () => {
  const d = await open(read('multipage'));
  const before = await pageShapes(d.bytes);
  const after = await pageShapes(await compose(d, [planEdit(d, 2, 'Page 3 of five', 'Page three of five')]));
  assert.equal(after.length, before.length);
  before.forEach((page, i) => {
    if (i === 2) {
      assert.notEqual(after[i].content, page.content, 'the edited page should have been rewritten');
      assert.equal(after[i].resources, page.resources, 'an edit in the text’s own font needs no new resource');
      return;
    }
    assert.equal(after[i].content, page.content, `page ${i + 1}'s content changed`);
    assert.equal(after[i].resources, page.resources, `page ${i + 1}'s resources changed`);
  });
});

test('a substitute font adds exactly one font resource to the edited page, keeping the rest', async () => {
  const lib = await loadPdfLib();
  const d = await open(read('fonts'));
  const fontKeys = async (bytes) => {
    const doc = await lib.PDFDocument.load(bytes, { updateMetadata: false });
    const fonts = doc.getPages()[0].node.Resources()?.lookup(lib.PDFName.of('Font'));
    return fonts ? fonts.entries().map(([k]) => k.decodeText()) : [];
  };
  const before = await fontKeys(d.bytes);
  const after = await fontKeys(await compose(d, [planEdit(d, 0, 'Liberation Sans embedded', 'Quartz jumps')]));
  assert.deepEqual(after.slice(0, before.length), before, 'the page’s own fonts are kept, in order');
  assert.deepEqual(after.slice(before.length), ['VlF1'], 'exactly one font is added, named VlF1');
});

// ---- 5. capability baseline: text → editable + sorted reasons -----------------------------------
// Today capability is one flag (run.editable) and a reason set. Phase 1 turns that into a map of
// verbs. Whatever shape it takes, `editText` has to keep answering exactly this, and refusals have
// to keep their reason keys — these are the sentences a person reads.

const REFUSALS = {
  composite: [
    [['Composite Identity font text with spaces', true, []], ['spaces with Tw', true, []], ['��iet', false, ['decode']]],
  ],
  scanned: [
    [],
    [['Recognised text layer', false, ['invisible']]],
  ],
  transparency: [
    [['Masked text', false, ['soft-mask']], ['Mask cleared again', true, []], ['Half-transparent text', true, []],
      ['Multiplied text', true, []], ['Plain text', true, []]],
  ],
  objects: [
    [['Tagged paragraph', true, []], ['Artifact text', true, []], ['Text on a visible layer', false, ['layer']],
      ['Text on a hidden layer', false, ['layer']], ['Ordinary text', true, []]],
  ],
  cmaps: [
    [['One byte codes through an embedded CMap', true, []], ['����', false, ['decode', 'encoding', 'metrics', 'mismatch']]],
  ],
  constructs: [
    [['World kerned', true, []], ['Spaced and scaled words', true, []], ['Raised', true, []], ['Line one', true, []],
      ['Line two', true, []], ['Line three', true, []], ['Hex string', true, []], ['Escapes (paren) back\\slash AB', true, []],
      ['After the inline image', true, []], ['Café', true, []], ['Hi!', true, []], ['OK', false, ['metrics']],
      ['abab', false, ['type3']], ['Inside a form', false, ['form']], ['Rotated text', true, []],
      ['Skewed text', false, ['skewed']], ['Upside-down text', true, []], ['Mirrored text', false, ['skewed']],
      ['Clipped by a curve', false, ['clipped']], ['Inside a rectangle clip', true, []],
      ['Cut by a rectangle clip', false, ['clipped']], ['Fake bold', false, ['overlap']], ['Fake bold', false, ['overlap']],
      ['Visible glyphs', false, ['actual-text']], ['Page footer artifact', true, []], ['Outlined text', true, []],
      ['Filled and outlined', true, []], ['Invisible text', false, ['invisible']], ['Clip text', false, ['invisible']],
      ['Zero size', false, ['degenerate', 'skewed']]],
    [['Split across streams', true, []]],
    [['Normal text after it', true, []]],
    [['After a stray Q', false, ['structure']]],
    [['Left open', true, []]],
  ],
};

for (const [name, pages] of Object.entries(REFUSALS)) {
  test(`capability baseline: ${name} — which text is editable, and why the rest isn’t`, async () => {
    const d = await analyzed(name);
    assert.equal(d.pages.length, pages.length, 'page count');
    d.pages.forEach((page, i) => {
      const actual = page.runs.map((r) => [r.text, r.editable, [...r.reasons].sort()]);
      assert.deepEqual(actual, pages[i], `${name} page ${i + 1}`);
    });
  });
}

test('capability baseline: fixtures whose text is entirely editable stay entirely editable', async () => {
  // Cheaper than listing every run, and it still catches a refusal creeping in.
  const expected = {
    simple: [3], multipage: [1, 1, 1, 1, 1], fonts: [10], columns: [26], images: [2],
    cropbox: [2], tagged: [3], pdfa: [1], signed: [1],
  };
  for (const [name, counts] of Object.entries(expected)) {
    const d = await analyzed(name);
    assert.deepEqual(d.pages.map((p) => p.runs.length), counts, `${name}: number of runs per page`);
    for (const page of d.pages) {
      for (const run of page.runs) {
        assert.deepEqual([run.editable, [...run.reasons]], [true, []], `${name}: ${JSON.stringify(run.text)}`);
      }
    }
  }
});

// ---- 6. object identity ---------------------------------------------------------------------
// Phase 2 selection needs a way to name one object on a page and find it again. These tests record
// what today's data can and cannot do, so the object model's `ref` is designed on facts.

test('object identity: run keys are unique on a page and stable across analyses', async () => {
  for (const name of ['simple', 'objects', 'constructs']) {
    const a = await analyzeFile(read(name));
    const b = await analyzeFile(read(name));
    a.pages.forEach((page, i) => {
      const keys = page.runs.map((r) => r.key);
      assert.equal(new Set(keys).size, keys.length, `${name} page ${i + 1}: run keys are not unique`);
      assert.deepEqual(keys, b.pages[i].runs.map((r) => r.key), `${name} page ${i + 1}: run keys are not stable`);
    });
  }
  assert.deepEqual((await analyzed('simple')).pages[0].runs.map((r) => r.key), ['0:0', '1:0', '2:0'],
    'a run key is "show index : glyph index" of its first glyph');
});

test('object identity: an image’s key names its resource, not the drawing — so it cannot identify one object', async () => {
  const page = (await analyzed('objects')).pages[0];
  // /Im1 is drawn many times; every one of those draws reports the same key.
  const im1 = page.images.filter((im) => im.name === 'Im1');
  assert.ok(im1.length > 1, 'the fixture draws the same image more than once');
  assert.equal(new Set(im1.map((im) => im.key)).size, 1, 'repeated draws of one image share a key');
  assert.equal(page.images.find((im) => im.inline).key, null, 'an inline image has no key at all');
  // What *is* unique is where the object is drawn: its stream plus the operator index in it.
  const places = [...page.runs.map((r) => `${r.first.form?.key ?? 'page'}#${r.first.opIndex}`),
    ...page.images.map((im) => `${im.stream}#${im.opIndex}`),
    ...page.paths.map((p) => `${p.stream}#${p.opIndex}`),
    ...page.forms.map((f) => `${f.stream}#${f.opIndex}`)];
  assert.equal(new Set(places).size, places.length, 'stream + operator index is unique across every kind');
});

test('object identity: untouched runs keep their keys when another run on the page is edited', async () => {
  const d = await open(read('simple'));
  const saved = await compose(d, [planEdit(d, 0, 'Hello, world', 'Hello, Vellum')]);
  const runs = (await analyzeFile(saved)).pages[0].runs;
  const keep = runs.filter((r) => r.text !== 'Hello, Vellum').map((r) => [r.text, r.key]);
  assert.deepEqual(keep, [
    ['A second line with punctuation: café, naïve — 50% off!', '1:0'],
    ['Third line.', '2:0'],
  ], 'the unedited runs keep the keys they had before the edit');
});

// ---- 7. z-order, including content inside a form XObject -----------------------------------------
// `order` cannot be a single operator index: an object inside a form has an index in the FORM's
// stream, which says nothing about where that form is drawn on the page. The order of an object is
// the path of operator indexes from the page down to it.

/** The drawing position of one record as a path: [op on the page, …, op in the innermost form]. */
function orderPath(page, { stream, opIndex }) {
  const byKey = new Map(page.forms.map((f) => [f.key, f]));
  const path = [opIndex];
  let at = stream;
  while (at !== 'page') {
    const form = byKey.get(at);
    if (!form) break; // a form the page doesn't draw itself: nothing more can be said
    path.unshift(form.opIndex);
    at = form.stream;
  }
  return path;
}

const placed = (page) => [
  ...page.runs.map((r) => ({ label: r.text, ...orderKey(page, { stream: r.first.form?.key ?? 'page', opIndex: r.first.opIndex }) })),
  ...page.images.map((im) => ({ label: `image#${im.index}`, ...orderKey(page, im) })),
  ...page.paths.map((p) => ({ label: `path:${p.paint}`, ...orderKey(page, p) })),
  ...page.forms.map((f) => ({ label: `form:/${f.name}`, ...orderKey(page, f) })),
];

function orderKey(page, rec) {
  const path = orderPath(page, rec);
  return { path, sort: path.map((n) => String(n).padStart(6, '0')).join('.') };
}

test('z-order: every object on a page sorts into the order it is drawn', async () => {
  const page = (await analyzed('objects')).pages[0];
  const order = placed(page).sort((a, b) => (a.sort < b.sort ? -1 : a.sort > b.sort ? 1 : 0)).map((o) => o.label);
  assert.deepEqual(order, [
    'image#0', 'image#1', 'image#2', 'image#3', 'image#4', 'image#5', 'image#6', 'image#7', 'image#8',
    'image#9', 'image#10', 'form:/Fm1', 'image#11',
    'path:fill', 'path:stroke', 'path:shading',
    'Tagged paragraph', 'Artifact text', 'Text on a visible layer', 'Text on a hidden layer', 'Ordinary text',
  ]);
});

test('z-order: an image inside a form is placed by where the form is drawn, not by its own index', async () => {
  const page = (await analyzed('objects')).pages[0];
  const form = page.forms[0];
  const inside = page.images.find((im) => im.stream !== 'page');
  assert.equal(inside.stream, form.key, 'the fixture draws an image inside the form');
  assert.deepEqual(orderPath(page, inside), [form.opIndex, inside.opIndex], 'its order is the form’s position, then its own');
  assert.deepEqual([form.opIndex, inside.opIndex], [57, 2]);

  // Why a scalar won't do: inside the form this image is only the 2nd operator, so by bare operator
  // index it sorts in among the first images on the page — ahead of ones genuinely drawn long
  // before the form is. (It even ties with image#0, which is also operator 2, but on the page.)
  const naive = [...page.images].sort((a, b) => a.opIndex - b.opIndex);
  const naiveAt = naive.findIndex((im) => im.index === inside.index);
  const earlierOnThePage = naive.findIndex((im) => im.index === 1); // drawn at page operator 6
  assert.ok(naiveAt < earlierOnThePage,
    `a bare opIndex sorts the nested image (${naiveAt}) ahead of image#1 (${earlierOnThePage}), which is drawn before the form`);
  assert.equal(page.images[0].opIndex, inside.opIndex, 'and it ties with a page-level image outright');

  // The path-based order puts it where it belongs: immediately after the form that draws it.
  const correct = placed(page).sort((a, b) => (a.sort < b.sort ? -1 : a.sort > b.sort ? 1 : 0)).map((o) => o.label);
  assert.deepEqual(correct.slice(11, 13), ['form:/Fm1', `image#${inside.index}`]);
});

test('z-order: text inside a form is nested the same way', async () => {
  const page = (await analyzed('constructs')).pages[0];
  const run = page.runs.find((r) => r.text === 'Inside a form');
  assert.ok(run.first.form, 'the fixture draws text inside a form');
  const path = orderPath(page, { stream: run.first.form.key, opIndex: run.first.opIndex });
  assert.equal(path.length, 2, 'a page operator index, then one inside the form');
  assert.equal(path[0], page.forms.find((f) => f.key === run.first.form.key).opIndex);
});

// ---- 8. unknown edit kinds ------------------------------------------------------------------
// Today a record whose kind isn't 'text' is filtered out and silently ignored. Under the Phase 1
// registry an unregistered kind should be REFUSED instead, so a user's edit can never be dropped
// without a word. This test pins today's behaviour so that change is a deliberate, visible diff
// rather than something that slips through.

const unknownRecord = (entry) => ({
  id: 'unknown-1', kind: 'image-move', entry,
  target: { key: '0:0' }, transform: [1, 0, 0, 1, 10, 0],
});

test('unknown edit kinds are silently ignored today (Step 1 must turn this into a refusal)', async () => {
  const d = await open(read('simple'));
  const unknown = unknownRecord(d.plan[0].id);
  const none = await compose(d, []);
  const withUnknown = await compose(d, [unknown]);
  assert.deepEqual(Buffer.from(withUnknown), Buffer.from(none),
    'an unknown kind changes nothing at all — it is dropped without a word');

  // And it does not disturb a real edit made alongside it.
  const text = [planEdit(d, 0, 'Hello, world', 'Hello, Vellum')];
  const textOnly = await compose(d, text);
  const mixed = await compose(d, [...text, unknownRecord(d.plan[0].id)]);
  assert.deepEqual(Buffer.from(mixed), Buffer.from(textOnly), 'the text edit is written; the unknown kind is ignored');
});

test('an edit naming a page the plan doesn’t have is ignored rather than failing the save', async () => {
  // The other half of the writer's dispatch: records are matched to pages by plan entry id.
  const d = await open(read('simple'));
  const stray = { ...planEdit(d, 0, 'Hello, world', 'Hello, Vellum'), entry: 'no-such-entry' };
  assert.deepEqual(Buffer.from(await compose(d, [stray])), Buffer.from(await compose(d, [])));
});
