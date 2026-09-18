// Form XObject text, phase 1: the safety groundwork before any of it becomes editable.
//
// Pinned here: text drawn by a Form XObject is still refused for reason 'form', on every occurrence
// and whatever the cross-check says about it; verifyPage() nevertheless compares that text with what
// pdf.js drew inside the same form, glyph for glyph; each occurrence carries what a later phase
// needs to identify it (XObject key, occurrence, depth, resources) and what stands in its way; and
// none of this teaches the font models anything, so page text is editable exactly as it was.
// Run: node --test "tests/editing/form-xobjects.test.mjs"

import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { analyzeFile, engine } from './harness.mjs';
import { makeFixtures, FIXTURE_DIR } from './fixtures.mjs';

const { REASONS, FORM_BLOCKERS, FORM_NOTES, explainForm } = await engine('runs.js');

let page;
before(async () => {
  const files = await makeFixtures(FIXTURE_DIR);
  const { pages } = await analyzeFile(new Uint8Array(fs.readFileSync(files['form-xobjects'])), { pages: [0] });
  page = pages[0];
});

const run = (text) => page.runs.find((r) => r.text === text);
const form = (name) => page.forms.filter((f) => f.name === name);
const only = (name) => {
  const list = form(name);
  assert.equal(list.length, 1, `${name} is drawn once`);
  return list[0];
};

// ---- the refusal, unchanged ---------------------------------------------------------------------

test('every run a form draws is still refused for "form", and only page text is editable', () => {
  assert.equal(page.verified, true);
  const editable = page.runs.filter((r) => r.editable).map((r) => r.text);
  assert.deepEqual(editable, ['Page text stays editable'], 'the page text, and nothing a form draws');
  for (const r of page.runs) {
    const drawnByAForm = Boolean(r.form);
    assert.equal(r.reasons.has('form'), drawnByAForm, `"${r.text}"`);
    if (drawnByAForm) assert.equal(r.editable, false, `"${r.text}" stays refused`);
  }
  // Text whose glyphs came through the cross-check clean is refused just the same.
  const clean = run('Clean form text');
  assert.equal(clean.formVerdict.verified, true);
  assert.equal(clean.editable, false);
  assert.deepEqual([...clean.reasons], ['form']);
  assert.deepEqual(explainForm(only('Clean')), [], 'nothing against it, which is not permission');
});

test('the reasons a form occurrence has are never added to the runs it draws', () => {
  // The occurrence is blocked, the run is not told about it: 'form' is the only reason it carries.
  const borrowed = run('Borrowed resources');
  assert.deepEqual([...borrowed.reasons], ['form']);
  assert.deepEqual(borrowed.formVerdict.blockers, ['inherited-resources']);
  assert.equal(borrowed.formVerdict.verified, false);
  // A reason classify() found on its own is on the run, and quoted in the verdict.
  const invisible = run('Invisible in a form');
  assert.deepEqual([...invisible.reasons].sort(), ['form', 'invisible']);
  assert.deepEqual(invisible.formVerdict.reasons, ['invisible']);
});

// ---- the cross-check ----------------------------------------------------------------------------

test('form text is cross-checked with pdf.js, glyph for glyph, at every depth', () => {
  // Every show a form draws was matched against pdf.js's own reading of the same form: not one of
  // them came back 'mismatch', which is what a count or a glyph disagreement would give.
  const inForms = page.runs.filter((r) => r.form);
  assert.ok(inForms.length >= 8, 'the fixture draws text from several forms');
  for (const r of inForms) {
    assert.ok(!r.formVerdict.reasons.includes('mismatch'), `"${r.text}" agrees with pdf.js`);
    assert.ok(!r.formVerdict.reasons.includes('decode'), `"${r.text}" decoded`);
  }
  // Including text two forms deep, which pdf.js writes out at its own nesting.
  const deep = run('Two forms deep');
  assert.equal(deep.form.depth, 2);
  assert.equal(deep.formVerdict.textVerified, true);
  assert.equal(deep.formVerdict.verified, false, 'its occurrence is not drawn by the page');
});

test('verified safe: a clean depth-1 form is a candidate, with its text proven', () => {
  const clean = only('Clean');
  assert.deepEqual(clean.safety, { blockers: [], notes: [], safe: true });
  assert.deepEqual(clean.verification, { state: 'verified', runs: 1, verified: 1, reasons: [], candidate: true });
  assert.equal(page.summary.formCandidates, page.forms.filter((f) => f.verification.candidate).length);
});

test('verified unsafe: text that agrees with pdf.js but is refused for its own reasons', () => {
  const invisible = only('Invisible');
  assert.equal(invisible.safety.safe, true, 'the form itself is fine');
  assert.equal(invisible.verification.state, 'refused');
  assert.deepEqual(invisible.verification.reasons, ['invisible']);
  assert.equal(invisible.verification.candidate, false);
  assert.deepEqual(explainForm(invisible), [REASONS.invisible]);
});

// ---- what each occurrence records ---------------------------------------------------------------

test('a form drawn twice is two occurrences: same key, own index, own place', () => {
  const [first, second] = form('Twice');
  assert.equal(first.key, second.key, 'one XObject');
  assert.notEqual(first.index, second.index);
  assert.equal(first.uses, 2);
  assert.equal(second.uses, 2);
  assert.ok(first.safety.notes.includes('shared') && second.safety.notes.includes('shared'));
  assert.ok(first.opIndex !== second.opIndex && first.ctm[4] !== second.ctm[4], 'drawn in two places');
  // Each draw's text is its own run, pinned to its own occurrence.
  const runs = page.runs.filter((r) => r.text === 'Drawn twice');
  assert.equal(runs.length, 2);
  assert.deepEqual(runs.map((r) => r.form.occurrence).sort(), [first.index, second.index].sort());
  for (const r of runs) assert.equal(r.form.ambiguous, false);
});

test('an occurrence records its key, depth, place in the page and resources', () => {
  const clean = only('Clean');
  assert.equal(typeof clean.key, 'string');
  assert.equal(clean.name, 'Clean');
  assert.equal(clean.depth, 1);
  assert.equal(clean.stream, 'page');
  assert.equal(clean.parent, null);
  assert.deepEqual(clean.ancestors, []);
  assert.equal(clean.root, clean.index);
  assert.equal(clean.ownResources, true);
  assert.ok(clean.resources, 'the resolver its content reads fonts and graphics from');
  assert.ok(clean.resources.font('H'), 'the font its text is drawn with');
  assert.deepEqual(clean.matrix, [1, 0, 0, 1, 0, 0]);
  assert.deepEqual(clean.bbox, [0, 0, 300, 40]);
  assert.equal(clean.group, null);
  assert.equal(clean.shows.length, 1);
  assert.equal(clean.glyphs, 'Clean form text'.length);
  assert.deepEqual(clean.content, { entered: true, tainted: false, unbalanced: false, openStates: 0, openText: false, recursive: false, tooDeep: false });
});

test('a form inside a form knows which depth-1 occurrence it belongs to', () => {
  const outer = only('Nested');
  const inner = only('In');
  assert.equal(inner.depth, 2);
  assert.equal(inner.stream, outer.key, 'drawn by the outer form, not by the page');
  assert.equal(inner.parent, outer.index);
  assert.deepEqual(inner.ancestors, [outer.index]);
  assert.equal(inner.root, outer.index);
  assert.ok(inner.safety.blockers.includes('depth'));
  assert.ok(outer.safety.notes.includes('nested'));
  // The outer form draws no text itself, but the text below it counts as its.
  assert.equal(outer.shows.length, 0);
  assert.equal(outer.verification.runs, 1);
  assert.equal(run('Two forms deep').form.root, outer.index);
});

test('the blockers an occurrence can carry, each on the form that has it', () => {
  assert.deepEqual(only('Borrowed').safety.blockers, ['inherited-resources']);
  assert.equal(only('Borrowed').ownResources, false);
  assert.deepEqual(only('Layered').safety.blockers, ['layer']);
  assert.ok(only('Layered').oc, 'on an optional-content group');
  assert.deepEqual(only('Masked').safety.blockers, ['soft-mask']);
  assert.equal(only('Masked').softMask, 'Mask');
  assert.deepEqual(only('Unbalanced').safety.blockers, ['structure']);
  assert.equal(only('Unbalanced').content.unbalanced, true, 'a Q that would escape the form');
  for (const name of ['Borrowed', 'Layered', 'Masked', 'Unbalanced']) {
    assert.equal(only(name).safety.safe, false);
    assert.equal(only(name).verification.candidate, false);
    assert.ok(explainForm(only(name)).length > 0, `${name} says why`);
  }
});

test('every blocker and note has words, and only known ones are used', () => {
  for (const f of page.forms) {
    for (const b of f.safety.blockers) assert.ok(FORM_BLOCKERS[b], `blocker "${b}" has words`);
    for (const n of f.safety.notes) assert.ok(FORM_NOTES[n], `note "${n}" has words`);
    for (const r of f.verification.reasons) assert.ok(REASONS[r], `reason "${r}" has words`);
  }
});

// ---- nothing leaks out of the forms -------------------------------------------------------------

test('checking form text teaches the font models nothing', () => {
  // The page and its forms all draw with the same Helvetica. Every code the cross-check proved must
  // have come from the page's own text: a form must not widen what the font may be written with.
  const pageRun = run('Page text stays editable');
  const font = pageRun.font;
  assert.equal(only('Clean').resources.font('H'), font, 'one font model, page and form alike');
  const fromPage = new Set([...pageRun.text].map((ch) => ch.charCodeAt(0)));
  for (const code of font.verified.keys()) assert.ok(fromPage.has(code), `code ${code} was proven by page text`);
  // 'C', 'B' and 'v' start form text only; 'T' is in the page text too.
  for (const ch of ['C', 'B', 'v', 'T']) {
    assert.equal(font.verified.has(ch.charCodeAt(0)), fromPage.has(ch.charCodeAt(0)), ch);
  }
});
