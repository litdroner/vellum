// Vellum 0.5.0 Phase 3, Step 3: moving and scaling text. The `transform` on a text edit record
// (editing/edits.js) and the `encoding.mode: 'original'` that goes with it, written into real PDFs
// through composeDocument exactly as a retype is.
//
// Nothing in the app can make one of these yet: capabilities still refuse move and scale (Step 4)
// and there is no interaction (Steps 5–6). These tests are the only caller, and they build records
// through planTextTransform, the same way the session will.
//
// What each section is for:
//   1. the record  — its shape, that a move needs no font, that the transform is ABSOLUTE
//   2. the writing — where moved and scaled text actually lands, and that it reads back as text
//   3. mode 'original' — the file's own glyph bytes, kerning and all, with nothing looked up
//   4. one record  — retyped-then-moved, and moved-then-retyped, stay a single edit
//   5. refusals    — at the planner and again at the writer, in the engine's existing words
//   6. untransformed output — byte for byte what it was before transforms existed
// Run: node --test "tests/editing/*.test.mjs"

import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { analyzeFile, engine, loadPdfLib, webModule } from './harness.mjs';
import { makeFixtures, FIXTURE_DIR } from './fixtures.mjs';

const { planTextEdit, planTextTransform, textTransformRefusal, EditError } = await engine('edits.js');
const { IDENTITY, translate, multiply, apply } = await engine('matrix.js');
const { scaleAbout, quarterTurn, flip } = await engine('objects/transform.js');
const { AnnotationStore } = await webModule('annotations/model.js');
const { openSource } = await engine('source.js');
const { composeDocument } = await webModule('annotations/persist.js');
const { identityPlan } = await webModule('pages/plan.js');

let files;
const cache = new Map();
before(async () => { files = await makeFixtures(FIXTURE_DIR); });
const read = (name) => new Uint8Array(fs.readFileSync(files[name]));

/** A document as the app holds it: original bytes, verified analyses, an identity plan. */
async function open(name) {
  if (!cache.has(name)) {
    const bytes = read(name);
    const result = await analyzeFile(bytes);
    cache.set(name, { bytes, result, plan: identityPlan(result.source.pageCount) });
  }
  return cache.get(name);
}

const compose = (d, edits, extra = {}) => composeDocument({ base: d.bytes, plan: d.plan, edits, ...extra });

const runOf = (d, page, text) => {
  const run = d.result.pages[page].runs.find((r) => r.text === text);
  assert.ok(run, `no run ${JSON.stringify(text)} on page ${page + 1}`);
  return run;
};

/** A move or scale of one run, planned the way the session will plan it. */
const move = (d, page, text, transform, extra = {}) => planTextTransform({ run: runOf(d, page, text), transform, entry: d.plan[page].id, ...extra });

/** A retype of one run, planned the way the session already plans it. */
const retype = (d, page, from, to, extra = {}) => planTextEdit({ run: runOf(d, page, from), text: to, entry: d.plan[page].id, glyphs: d.result.source.glyphs, ...extra });

/** One page's decoded content stream and its resource dictionary: exactly what the writer controls. */
async function pageShape(bytes, pageIndex = 0) {
  const lib = await loadPdfLib();
  const doc = await lib.PDFDocument.load(bytes, { updateMetadata: false });
  const source = await openSource(lib, bytes);
  const page = doc.getPages()[pageIndex];
  return {
    content: Buffer.from(source.contentBytes(page.node)).toString('latin1'),
    resources: page.node.Resources()?.toString() ?? null,
  };
}

const contentOf = async (bytes, pageIndex = 0) => (await pageShape(bytes, pageIndex)).content;

/** The block the writer appends after the page's own content: the redrawn text and nothing else. */
const appended = (content) => content.slice(content.lastIndexOf('\nq\n') + 1).trimEnd();

/** Where a run sits in a saved file, found by its text. */
async function runAfter(saved, text, pageIndex = 0) {
  const analysis = (await analyzeFile(saved)).pages[pageIndex];
  return analysis.runs.find((r) => r.text === text) ?? null;
}

const round = (list, places = 4) => list.map((v) => Math.round(v * 10 ** places) / 10 ** places);

/** The TJ codes a run's glyphs already are in the file, as the hex a content stream would hold. */
function originalHex(d, page, text) {
  const analysis = d.result.pages[page];
  let hex = '';
  for (const [si, gi] of runOf(d, page, text).glyphs) {
    const glyph = analysis.shows[si].glyphs[gi];
    const bytes = analysis.shows[si].elements[glyph.el].bytes;
    for (let k = 0; k < glyph.byteLength; k++) hex += bytes[glyph.byteStart + k].toString(16).padStart(2, '0');
  }
  return hex;
}

// ---- 1. the record a move plans ----------------------------------------------------------------

test('a move plans one text record: the same fingerprint, the file’s own text, and an absolute transform', async () => {
  const d = await open('simple');
  const record = move(d, 0, 'Hello, world', translate(40, -25));
  assert.deepEqual(Object.keys(record).sort(), ['encoding', 'entry', 'id', 'kind', 'target', 'text', 'transform']);
  assert.equal(record.kind, 'text', 'a move is a text edit, not a second kind');
  assert.deepEqual(record.encoding, { mode: 'original' }, 'nothing about the text changes, so nothing is chosen for it');
  assert.equal(record.text, 'Hello, world', 'the text it reads is still the file’s own');
  assert.deepEqual(record.transform, [1, 0, 0, 1, 40, -25]);
  // The same fingerprint a retype stores: the run by its first glyph, its text and its glyphs.
  assert.deepEqual(Object.keys(record.target).sort(), ['glyphs', 'key', 'text']);
  assert.deepEqual(record.target, retype(d, 0, 'Hello, world', 'Hello, Vellum').target);
});

test('a transform is kept to the four decimals the content stream can hold, and no more', async () => {
  const d = await open('simple');
  const record = move(d, 0, 'Hello, world', [1.000004999, 0, 0, 1.000004999, 12.00006, -0.000004]);
  assert.deepEqual(record.transform, [1, 0, 0, 1, 12.0001, 0], 'rounded to four places, and no negative zero');
});

test('the identity is not stored: a move that moves nothing plans a record that says nothing', async () => {
  const d = await open('simple');
  assert.equal(Object.hasOwn(move(d, 0, 'Hello, world', IDENTITY), 'transform'), false);
  assert.equal(Object.hasOwn(move(d, 0, 'Hello, world', translate(0, 0)), 'transform'), false);
  assert.equal(Object.hasOwn(retype(d, 0, 'Hello, world', 'Hello, Vellum'), 'transform'), false, 'and a plain retype has none at all');
});

test('the transform is absolute: a second move replaces the first rather than composing with it', async () => {
  const d = await open('simple');
  const first = move(d, 0, 'Hello, world', translate(40, 0));
  const second = planTextTransform({ run: runOf(d, 0, 'Hello, world'), record: first, transform: translate(0, -25) });
  assert.deepEqual(second.transform, [1, 0, 0, 1, 0, -25], 'where it ends up, not how far it just moved');
  assert.notDeepEqual(second.transform, [1, 0, 0, 1, 40, -25], 'an incremental transform would have composed');
  assert.equal(second.id, first.id, 'and it is still the same record');
  // And the file agrees: the text lands at the second transform, not at both.
  const saved = await compose(d, [second]);
  assert.deepEqual(round((await runAfter(saved, 'Hello, world')).origin), [72, 675]);
});

// ---- 2. writing a move, a scale, and both ------------------------------------------------------
// The transform is applied AFTER the text's own placement, so what the page said about the run —
// its font, size, colour, spacing and text matrix — is replayed exactly as before, and only the
// `cm` differs. Every case below checks the file, not the record: where the run actually is when
// the saved PDF is read back, and that it still reads back as the same editable text.

test('a translation: the text lands exactly where the transform says, and is still editable there', async () => {
  const d = await open('simple');
  const run = runOf(d, 0, 'Hello, world');
  const saved = await compose(d, [move(d, 0, 'Hello, world', translate(40, -25))]);
  const moved = await runAfter(saved, 'Hello, world');
  assert.deepEqual(round(moved.origin), round(apply(translate(40, -25), ...run.origin)));
  assert.deepEqual(round(moved.origin), [112, 675]);
  assert.equal(moved.frame.size, run.frame.size, 'a move does not change its size');
  assert.deepEqual([moved.editable, [...moved.reasons]], [true, []], 'and it can be edited again in the saved file');
  assert.equal(appended(await contentOf(saved)).split('\n')[1], '1 0 0 1 40 -25 cm', 'the move is the CTM, and the only thing that changed');
});

test('a uniform scale about a corner: the corner stays put and the text grows with it', async () => {
  const d = await open('simple');
  const run = runOf(d, 0, 'Hello, world');
  const transform = scaleAbout(run.origin, 1.5);
  const saved = await compose(d, [move(d, 0, 'Hello, world', transform)]);
  const moved = await runAfter(saved, 'Hello, world');
  assert.deepEqual(round(moved.origin), round(run.origin), 'the anchor does not move');
  assert.equal(moved.frame.size, run.frame.size * 1.5, '24pt text becomes 36pt');
  const width = (r) => r.box[2] - r.box[0];
  assert.ok(Math.abs(width(moved) - width(run) * 1.5) < 1e-6, `${width(moved)} is not 1.5 × ${width(run)}`);
  assert.deepEqual([moved.editable, [...moved.reasons]], [true, []]);
});

test('a translation and a uniform scale together: one transform, applied as one', async () => {
  const d = await open('simple');
  const run = runOf(d, 0, 'Hello, world');
  const transform = multiply(scaleAbout(run.origin, 0.5), translate(100, 30));
  const saved = await compose(d, [move(d, 0, 'Hello, world', transform)]);
  const moved = await runAfter(saved, 'Hello, world');
  assert.deepEqual(round(moved.origin), round(apply(transform, ...run.origin)));
  assert.deepEqual(round(moved.origin), [172, 730]);
  assert.equal(moved.frame.size, run.frame.size * 0.5);
});

test('a run the page itself rotated keeps its own text matrix, and moves in page space', async () => {
  // The rotation lives in the run's `Tm`, which is the page's and not the edit's: a move must add
  // to where the page put the text, not replace it (phase3-baseline pins the untransformed form).
  const d = await open('constructs');
  const saved = await compose(d, [move(d, 0, 'Rotated text', translate(-20, 0))]);
  const content = await contentOf(saved);
  assert.match(content, /^1 0 0 1 -20 0 cm$/m, 'the move is a page-space CTM');
  assert.match(content, /^0 1 -1 0 540 300 Tm$/m, 'and the page’s own rotation is untouched');
  const moved = await runAfter(saved, 'Rotated text');
  assert.deepEqual(round(moved.origin), round(apply(translate(-20, 0), ...runOf(d, 0, 'Rotated text').origin)));
});

test('moved text keeps the colour, spacing, scale and graphics state the page drew it with', async () => {
  const d = await open('constructs');
  const saved = await compose(d, [move(d, 0, 'Spaced and scaled words', translate(5, 5))]);
  const block = appended(await contentOf(saved)).split('\n');
  assert.equal(block[1], '1 0 0 1 5 5 cm');
  assert.equal(block[4], '2 Tc 6 Tw 80 Tz 0 Ts 0 Tr', 'the page’s own Tc, Tw and Tz, replayed as they were');
});

test('moving PDF/A text embeds nothing, so the file still follows the standard', async () => {
  const d = await open('pdfa');
  const run = d.result.pages[0].runs.find((r) => r.editable);
  const before = await pageShape(d.bytes);
  const saved = await compose(d, [planTextTransform({ run, transform: translate(0, -30), entry: d.plan[0].id })]);
  const after = await pageShape(saved);
  assert.equal(after.resources, before.resources, 'no font was added: the run is redrawn with its own');
  assert.deepEqual(round((await runAfter(saved, run.text)).origin), round(apply(translate(0, -30), ...run.origin)));
});

// ---- 3. encoding.mode 'original' ---------------------------------------------------------------
// A move reuses the glyph bytes the file already holds. No font is looked up, nothing is
// re-encoded, nothing is substituted and no text is reflowed — which is the whole point: moved
// text has to be the same text, or moving it would be a way of changing it by accident.

test('mode ‘original’ writes the file’s own glyph codes, byte for byte', async () => {
  const d = await open('simple');
  const saved = await compose(d, [move(d, 0, 'Hello, world', translate(40, -25))]);
  const hex = originalHex(d, 0, 'Hello, world');
  assert.equal(hex, '48656c6c6f2c20776f726c64', 'the codes the page’s own bytes decoded to');
  assert.match(appended(await contentOf(saved)), new RegExp(`^\\[<${hex}>\\] TJ$`, 'm'));
});

test('mode ‘original’ keeps two-byte composite codes exactly as the file has them', async () => {
  const d = await open('composite');
  const text = 'Composite Identity font text with spaces';
  const saved = await compose(d, [move(d, 0, text, translate(10, 10))]);
  const hex = originalHex(d, 0, text);
  assert.equal(hex.length, text.length * 4, 'an Identity-H font: two bytes a glyph');
  assert.match(appended(await contentOf(saved)), new RegExp(`^\\[<${hex}>\\] TJ$`, 'm'));
  assert.equal((await runAfter(saved, text)).text, text, 'and it reads back as the same text');
});

test('mode ‘original’ keeps the kerning the file had, as the numbers that produce it', async () => {
  // The fixture draws this run as [<W> 120 <o> -30 <rld kerned>]: the adjustments are the page's,
  // not the font's, so redrawing it from natural advances alone would quietly respace the word.
  const d = await open('constructs');
  const saved = await compose(d, [move(d, 0, 'World kerned', translate(0, -20))]);
  assert.match(appended(await contentOf(saved)), /^\[<57> 120 <6f> -30 <726c64206b65726e6564>\] TJ$/m);
  const moved = await runAfter(saved, 'World kerned');
  const run = runOf(d, 0, 'World kerned');
  assert.deepEqual(round(moved.origin), round(apply(translate(0, -20), ...run.origin)));
  assert.ok(Math.abs((moved.box[2] - moved.box[0]) - (run.box[2] - run.box[0])) < 1e-6, 'the same width, kerning and all');
});

test('mode ‘original’ needs no font at all: a run a retype could only write in a substitute still moves in its own', async () => {
  // This run's font is a subset that can't write "Quartz jumps", so a retype falls back to a
  // standard font and adds it to the page (phase1-baseline pins that). A move asks nothing of the
  // font, so it must add nothing.
  const d = await open('fonts');
  assert.equal(retype(d, 0, 'Liberation Sans embedded', 'Quartz jumps').encoding.mode, 'standard', 'the case this test is about');
  const before = await pageShape(d.bytes);
  const saved = await compose(d, [move(d, 0, 'Liberation Sans embedded', translate(0, -40))]);
  const after = await pageShape(saved);
  assert.equal(after.resources, before.resources, 'no /VlF1, no standard font, nothing added');
  assert.match(after.content, new RegExp(`^\\[<${originalHex(d, 0, 'Liberation Sans embedded')}>\\] TJ$`, 'm'));
});

test('a run spread over two content streams moves as one piece of text', async () => {
  const d = await open('constructs');
  const saved = await compose(d, [move(d, 1, 'Split across streams', translate(0, -100))], {});
  assert.match(appended(await contentOf(saved, 1)), new RegExp(`^\\[<${originalHex(d, 1, 'Split across streams')}>\\] TJ$`, 'm'));
  const moved = await runAfter(saved, 'Split across streams', 1);
  assert.deepEqual(round(moved.origin), round(apply(translate(0, -100), ...runOf(d, 1, 'Split across streams').origin)));
});

// ---- 4. one object, one record -----------------------------------------------------------------
// Text that has been retyped and then moved is one edit, not a text edit plus a move. It has to be:
// two records for one run would each neutralise the same glyphs, which the writer refuses outright,
// and undo would need two steps to put back what was one gesture.

test('retyped text that is then moved stays ONE record, with its id, text and encoding', async () => {
  const d = await open('simple');
  const typed = retype(d, 0, 'Hello, world', 'Hello, Vellum');
  const moved = planTextTransform({ run: runOf(d, 0, 'Hello, world'), record: typed, transform: translate(0, -40) });
  assert.equal(moved.id, typed.id, 'the same record');
  assert.deepEqual(moved.encoding, typed.encoding, 'still written in its own font, with the codes already proven');
  assert.deepEqual([moved.text, moved.target], [typed.text, typed.target]);
  assert.deepEqual(moved.transform, [1, 0, 0, 1, 0, -40]);
  // In the store that is one edit and one undo step, not two.
  const store = new AnnotationStore();
  store.initPlan(d.plan);
  store.applyEdit(null, typed);
  store.applyEdit(typed, moved);
  assert.equal(store.edits.length, 1, 'one record for one run');
  store.undo();
  assert.deepEqual(store.edits, [typed], 'undo takes back the move and leaves the retype');
  // And the file draws the new text in the new place, once.
  const saved = await compose(d, [moved]);
  const content = await contentOf(saved);
  assert.equal(content.split(' TJ').length - 1, 2, 'the neutralised original and the redrawn text: no third draw');
  assert.match(appended(content), /^1 0 0 1 0 -40 cm$/m);
  assert.equal((await runAfter(saved, 'Hello, Vellum')).text, 'Hello, Vellum');
});

test('a scale carries the retyped text with it, not the text the file started with', async () => {
  const d = await open('simple');
  const run = runOf(d, 0, 'Hello, world');
  const typed = retype(d, 0, 'Hello, world', 'Hi');
  const moved = planTextTransform({ record: typed, transform: scaleAbout(run.origin, 2) });
  const after = await runAfter(await compose(d, [moved]), 'Hi');
  assert.equal(after.frame.size, run.frame.size * 2);
  assert.deepEqual(round(after.origin), round(run.origin));
});

test('moved text that is then retyped keeps the move: still one record, still in its new place', async () => {
  const d = await open('simple');
  const run = runOf(d, 0, 'Hello, world');
  const moved = move(d, 0, 'Hello, world', translate(30, -50));
  const typed = retype(d, 0, 'Hello, world', 'Hello, Vellum', { id: moved.id, transform: moved.transform });
  assert.equal(typed.id, moved.id, 'one record either way round');
  assert.deepEqual(typed.transform, moved.transform, 'the placement is not about the text, and survives it');
  assert.equal(typed.encoding.mode, 'font', 'and the new text is written in the run’s own font');
  const after = await runAfter(await compose(d, [typed]), 'Hello, Vellum');
  assert.deepEqual(round(after.origin), round(apply(translate(30, -50), ...run.origin)));
});

// ---- 5. what is refused ------------------------------------------------------------------------
// Text is redrawn from the file's own glyphs, so only a move and a uniform scale can be written.
// Everything else is refused twice: at the planner, and again at the writer, because what goes into
// the file must not depend on the UI having asked the right question. Every refusal uses a key
// classify() already has (runs.js) — Step 3 added none.

test('a rotation is refused, in the engine’s own words', async () => {
  const d = await open('simple');
  const run = runOf(d, 0, 'Hello, world');
  for (const [what, transform] of [
    ['a quarter turn', quarterTurn(run.origin, 1)],
    ['a small angle', [Math.cos(0.5), Math.sin(0.5), -Math.sin(0.5), Math.cos(0.5), 0, 0]],
    ['a half turn', [-1, 0, 0, -1, 0, 0]],
  ]) {
    assert.equal(textTransformRefusal(transform), 'unsupported', what);
    assert.throws(() => move(d, 0, 'Hello, world', transform), (e) => {
      assert.ok(e instanceof EditError && e.kind === 'not-editable', `${what}: ${e.message}`);
      assert.equal(e.detail.reason, 'unsupported');
      assert.equal(e.message, 'Vellum can’t do this to this object yet.');
      return true;
    }, what);
  }
});

test('a non-uniform scale, a mirror and a skew are refused', async () => {
  const d = await open('simple');
  const basis = [200, 0, 0, 150, 72, 500]; // something to flip in, as an image edit would
  for (const [what, transform] of [
    ['taller than wide', [1, 0, 0, 2, 0, 0]],
    ['wider than tall', [2, 0, 0, 1, 0, 0]],
    ['a mirror', [-1, 0, 0, 1, 0, 0]],
    ['a flip in its own axes', flip(basis, 'horizontal')],
    ['a skew', [1, 0, 0.4, 1, 0, 0]],
    ['a slant', [1, 0.4, 0, 1, 0, 0]],
  ]) {
    assert.equal(textTransformRefusal(transform), 'unsupported', what);
    assert.throws(() => move(d, 0, 'Hello, world', transform), (e) => e instanceof EditError && e.detail.reason === 'unsupported', what);
  }
});

test('a scale that has collapsed is refused as text with no usable size', async () => {
  const d = await open('simple');
  for (const transform of [[0, 0, 0, 0, 0, 0], [0, 0, 0, 0, 72, 700], [1e-9, 0, 0, 1e-9, 0, 0]]) {
    assert.equal(textTransformRefusal(transform), 'degenerate', JSON.stringify(transform));
    assert.throws(() => move(d, 0, 'Hello, world', transform), (e) => {
      assert.ok(e instanceof EditError && e.kind === 'not-editable');
      assert.equal(e.message, 'This text has no usable size.');
      return true;
    });
  }
});

test('a transform that isn’t six finite numbers is refused rather than guessed at', async () => {
  const d = await open('simple');
  for (const transform of [[1, 0, 0, 1, NaN, 0], [1, 0, 0, 1, 0, Infinity], [1, 0, 0, 1], 'nope', {}]) {
    assert.throws(() => move(d, 0, 'Hello, world', transform), EditError, JSON.stringify(transform));
  }
});

test('text the engine refuses to edit cannot be moved either, and says the same thing', async () => {
  const d = await open('constructs');
  const refusals = {
    'Skewed text': 'Slanted, mirrored or distorted text can’t be edited yet.',
    'Mirrored text': 'Slanted, mirrored or distorted text can’t be edited yet.',
    'Invisible text': 'This text is invisible (for example the searchable layer of a scanned page). Editing it wouldn’t change what you see.',
    abab: 'This text is drawn with a picture font (Type 3), which Vellum can’t edit.',
    'Inside a form': 'This text is part of a reusable graphic in the file, which Vellum can’t edit yet.',
  };
  for (const [text, message] of Object.entries(refusals)) {
    assert.throws(() => move(d, 0, text, translate(5, 5)), (e) => {
      assert.ok(e instanceof EditError && e.kind === 'not-editable', text);
      assert.equal(e.message, message, text);
      return true;
    }, text);
  }
  // A structurally unsound page refuses everything on it, moves included.
  const page = d.result.pages.findIndex((p) => p.unbalanced);
  assert.ok(page > 0, 'the constructs fixture has a page with a stray Q');
  assert.throws(() => move(d, page, 'After a stray Q', translate(5, 5)), (e) => {
    assert.equal(e.message, 'This page’s drawing instructions are unbalanced, so Vellum won’t risk rewriting it.');
    return e instanceof EditError;
  });
});

test('planTextTransform refuses what it is not given, and what isn’t a text record', async () => {
  const d = await open('simple');
  assert.throws(() => planTextTransform({ transform: translate(5, 5), entry: d.plan[0].id }), EditError, 'no run and no record');
  assert.throws(() => planTextTransform({ record: { id: 'x', kind: 'image', entry: d.plan[0].id }, transform: translate(5, 5) }), (e) => {
    assert.ok(e instanceof EditError && e.kind === 'unsupported');
    assert.equal(e.detail.kind, 'image', 'an image edit is moved by its own planner, not this one');
    return true;
  });
});

test('an unsupported transform that reaches the writer is refused there too, and nothing is written', async () => {
  const d = await open('simple');
  const run = runOf(d, 0, 'Hello, world');
  const good = move(d, 0, 'Hello, world', translate(10, 10));
  for (const transform of [quarterTurn(run.origin, 1), [2, 0, 0, 1, 0, 0], [1, 0, 0.4, 1, 0, 0], [0, 0, 0, 0, 0, 0]]) {
    await assert.rejects(() => compose(d, [{ ...good, transform }]), (err) => {
      assert.ok(err instanceof EditError && err.kind === 'content', `${JSON.stringify(transform)}: ${err.message}`);
      assert.match(err.message, /^Text on page 1 is being moved or scaled in a way Vellum can’t write, so nothing was changed\.$/);
      return true;
    }, JSON.stringify(transform));
  }
  // And a page that refused one record refused the whole save: the good one wasn't written either.
  await assert.rejects(() => compose(d, [good, { ...good, id: 'other', transform: [2, 0, 0, 1, 0, 0] }]), EditError);
});

// ---- 6. untransformed text, byte for byte what it was ------------------------------------------
// phase1-baseline.test.mjs holds the seven golden content streams for records without a transform,
// and those stay the contract. These pin the two things Step 3 could have broken quietly: that a
// record without a transform still writes that exact stream, and that an identity is written as no
// transform at all rather than as a `cm` that happens to cancel.

test('an untransformed retype writes exactly the stream it wrote before transforms existed', async () => {
  // The same golden phase1-baseline.test.mjs pins, repeated here so that the transform path has to
  // prove it changed nothing. If both files fail together, the writer moved; if only one does, this
  // file is wrong.
  const d = await open('simple');
  const saved = await compose(d, [retype(d, 0, 'Hello, world', 'Hello, Vellum')]);
  assert.equal((await contentOf(saved)).trimEnd(), `q
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
Q`.trimEnd());
});

test('an identity transform forced into a record changes not one byte of the file', async () => {
  const d = await open('simple');
  const record = retype(d, 0, 'Hello, world', 'Hello, Vellum');
  const plain = await compose(d, [record]);
  for (const transform of [null, undefined, IDENTITY, [1, 0, 0, 1, 0, 0]]) {
    const saved = await compose(d, [{ ...record, transform }]);
    assert.deepEqual(Buffer.from(saved), Buffer.from(plain), `transform: ${JSON.stringify(transform)}`);
  }
});

test('a moved record differs from the untransformed one in the CTM alone', async () => {
  const d = await open('simple');
  const record = retype(d, 0, 'Hello, world', 'Hello, Vellum');
  const plain = (await contentOf(await compose(d, [record]))).split('\n');
  const moved = (await contentOf(await compose(d, [{ ...record, transform: translate(40, -25) }]))).split('\n');
  assert.equal(plain.length, moved.length);
  const differing = plain.map((line, i) => [line, moved[i]]).filter(([a, b]) => a !== b);
  assert.deepEqual(differing, [['1 0 0 1 0 0 cm', '1 0 0 1 40 -25 cm']], 'one line, and it is the CTM');
});

test('removing text still removes it, transform or not, and draws nothing', async () => {
  const d = await open('simple');
  const removal = retype(d, 0, 'Third line.', '   ');
  assert.deepEqual(removal.encoding, { mode: 'none' });
  const plain = await compose(d, [removal]);
  const moved = await compose(d, [{ ...removal, transform: translate(20, 20) }]);
  assert.deepEqual(Buffer.from(moved), Buffer.from(plain), 'there is nothing to move: removed text is not drawn');
  assert.equal((await contentOf(plain)).includes('(Third line.)'), false);
});

test('composing the same moved record twice writes the same file', async () => {
  const d = await open('simple');
  const record = move(d, 0, 'Hello, world', scaleAbout([72, 700], 1.25));
  assert.deepEqual(Buffer.from(await compose(d, [record])), Buffer.from(await compose(d, [record])));
});
