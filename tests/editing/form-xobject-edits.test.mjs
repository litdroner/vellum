// Form XObject text, phase 2: editing it through a private copy of the form.
//
// The one case Vellum writes: a run drawn directly by a depth-1 Form XObject occurrence that has
// resources of its own, whose glyphs came through the pdf.js cross-check clean, that nothing else
// refuses, and whose form carries no layer, soft mask, tagged content or structural trouble. The
// edit goes into a COPY of that form, and only the one `Do` that drew that occurrence is repointed.
//
// What each section is for:
//   1. which runs  — 'form' lifted for exactly those occurrences, and for no other
//   2. the copy    — the original form untouched, the copy carrying its dictionary and its edit
//   3. one occurrence — a form drawn twice, edited once: the other draw unchanged, saved and reopened
//   4. refusals    — unsafe occurrences at the planner, and again at the writer
//   5. the verbs   — only retyping and deleting; moving, scaling, turning and pasting stay 'form'
// Run: node --test "tests/editing/form-xobject-edits.test.mjs"

import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { analyzeFile, engine, loadPdfLib, webModule } from './harness.mjs';
import { makeFixtures, FIXTURE_DIR } from './fixtures.mjs';

const { planTextEdit, planTextTransform, EditError } = await engine('edits.js');
const { openSource } = await engine('source.js');
const { REASONS } = await engine('runs.js');
const { capabilitiesFor } = await engine('objects/capabilities.js');
const { planCopy, TEXT: textCopyKind } = await engine('objects/copies.js');
const { composeDocument } = await webModule('annotations/persist.js');
const { identityPlan } = await webModule('pages/plan.js');

let files;
let base;
before(async () => {
  files = await makeFixtures(FIXTURE_DIR);
  const bytes = new Uint8Array(fs.readFileSync(files['form-xobjects']));
  const result = await analyzeFile(bytes, { pages: [0] });
  base = { bytes, result, page: result.pages[0], plan: identityPlan(result.source.pageCount) };
});

const runs = (text) => base.page.runs.filter((r) => r.text === text);
const run = (text) => {
  const found = runs(text);
  assert.equal(found.length, 1, `one run reads ${JSON.stringify(text)}`);
  return found[0];
};
const occurrence = (name) => base.page.forms.find((f) => f.name === name);

const retype = (r, text, extra = {}) => planTextEdit({ run: r, text, entry: base.plan[0].id, glyphs: base.result.source.glyphs, ...extra });
const compose = (edits) => composeDocument({ base: base.bytes, plan: base.plan, edits });

/** One page's decoded content stream, as text. */
async function pageContent(bytes, pageIndex = 0) {
  const lib = await loadPdfLib();
  const doc = await lib.PDFDocument.load(bytes, { updateMetadata: false });
  const source = await openSource(lib, bytes);
  return Buffer.from(source.contentBytes(doc.getPages()[pageIndex].node)).toString('latin1');
}

/** The Form XObjects a page's resources name: name → { ref, content, dict }. */
async function formXObjects(bytes, pageIndex = 0) {
  const lib = await loadPdfLib();
  const doc = await lib.PDFDocument.load(bytes, { updateMetadata: false });
  const source = await openSource(lib, bytes);
  const resources = doc.getPages()[pageIndex].node.Resources();
  const xobjects = doc.context.lookup(resources.get(lib.PDFName.of('XObject')));
  const out = new Map();
  for (const [name, raw] of xobjects.entries()) {
    const stream = doc.context.lookup(raw);
    if (source.nameOf(stream.dict.get(lib.PDFName.of('Subtype'))) !== 'Form') continue;
    out.set(name.decodeText(), {
      ref: raw.toString(),
      content: Buffer.from(source.streamBytes(stream)).toString('latin1'),
      dict: stream.dict,
      entry: (key) => stream.dict.get(lib.PDFName.of(key))?.toString() ?? null,
    });
  }
  return out;
}

/** The text of every run a reopened file's first page holds, in drawing order. */
const textsOf = async (bytes) => (await analyzeFile(bytes, { pages: [0] })).pages[0].runs.map((r) => r.text);

// ---- 1. which runs this is for -----------------------------------------------------------------

test('a safe depth-1 occurrence lifts "form"; every other occurrence keeps it', () => {
  const clean = run('Clean form text');
  assert.equal(clean.editable, true);
  assert.equal(clean.reasons.size, 0);
  assert.deepEqual(clean.formEdit, {
    occurrence: occurrence('Clean').index, key: occurrence('Clean').key, name: 'Clean', uses: 1,
  });
  // Every refusal the phase-1 fixture holds, still refused, each for its own reason.
  for (const text of ['Borrowed resources', 'On a hidden layer', 'Behind a soft mask', 'Unbalanced form',
    'Two forms deep', 'Invisible in a form', 'Tagged form text', 'Font from outside']) {
    const r = run(text);
    assert.equal(r.formEdit, null, `"${text}" is not editable inside its form`);
    assert.equal(r.editable, false, `"${text}"`);
    assert.ok(r.reasons.has('form'), `"${text}" still says 'form'`);
  }
});

test('a form drawn twice is editable at each occurrence, separately', () => {
  const [first, second] = runs('Drawn twice');
  assert.equal(first.editable, true);
  assert.equal(second.editable, true);
  assert.equal(first.formEdit.key, second.formEdit.key, 'one XObject');
  assert.notEqual(first.formEdit.occurrence, second.formEdit.occurrence, 'two occurrences');
  assert.equal(first.formEdit.uses, 2);
  // Being shared is a note, never a blocker: the private copy is exactly what it is there for.
  assert.deepEqual(occurrence('Twice').safety.blockers, []);
  assert.ok(occurrence('Twice').safety.notes.includes('shared'));
});

test('the record a form edit plans is an ordinary text record: nothing new is stored for forms', () => {
  const record = retype(run('Clean form text'), 'Edited in a form');
  assert.deepEqual(Object.keys(record).sort(), ['encoding', 'entry', 'id', 'kind', 'target', 'text']);
  assert.equal(record.kind, 'text');
  assert.equal(record.text, 'Edited in a form');
  assert.equal(record.encoding.mode, 'font', 'written with the form’s own font');
});

// ---- 2. the copy -------------------------------------------------------------------------------

test('the form the file shares is never changed: the edit goes into a copy of it', async () => {
  const before = await formXObjects(base.bytes);
  const saved = await compose([retype(run('Clean form text'), 'Edited in a form')]);
  const after = await formXObjects(saved);

  // The original object is still there, under its own name, with its own bytes.
  assert.equal(after.get('Clean').ref, before.get('Clean').ref, 'the same object');
  assert.equal(after.get('Clean').content, before.get('Clean').content, 'byte for byte what it was');

  // And a copy beside it, drawing the new text.
  const copies = [...after.keys()].filter((name) => !before.has(name));
  assert.equal(copies.length, 1, 'one copy, for the one occurrence edited');
  const copy = after.get(copies[0]);
  assert.notEqual(copy.ref, before.get('Clean').ref, 'a new object, not the original');
  assert.ok(copy.content.includes('Tf'), 'it draws text');
  assert.ok(copy.content.includes('] TJ'), 'the original glyphs, neutralised where they stood');

  // The copy is the original form: its dictionary, and resources of its own.
  assert.equal(copy.entry('Subtype'), '/Form');
  assert.equal(copy.entry('BBox'), before.get('Clean').entry('BBox'));
  assert.equal(copy.entry('Matrix'), before.get('Clean').entry('Matrix'));
  assert.ok(copy.entry('Resources'), 'resources of its own');
});

test('only that occurrence’s Do is repointed; the page is otherwise what it was', async () => {
  const saved = await compose([retype(run('Clean form text'), 'Edited in a form')]);
  const content = await pageContent(saved);
  assert.equal(content.includes('/Clean Do'), false, 'the one Do that drew it now draws the copy');
  assert.match(content, /\/VlX1 Do/);
  // Every other Do on the page is untouched.
  for (const name of ['Twice', 'Borrowed', 'Nested', 'Layered', 'Masked', 'Unbalanced', 'Invisible', 'Tagged', 'Outside']) {
    assert.ok(content.includes(`/${name} Do`), `/${name} Do is still drawn`);
  }
  assert.equal((content.match(/\/Twice Do/g) ?? []).length, 2, 'both draws of the shared form');
});

// ---- 3. one occurrence, not the form ------------------------------------------------------------

test('a form drawn twice, edited once: the other occurrence is untouched, saved and reopened', async () => {
  const [first, second] = runs('Drawn twice');
  const edited = first.origin[0] < second.origin[0] ? first : second; // the left-hand draw
  const saved = await compose([retype(edited, 'Only this one')]);

  // In the file: the shared form is as it was, one Do of it left, and one copy drawn beside it.
  const before = await formXObjects(base.bytes);
  const after = await formXObjects(saved);
  assert.equal(after.get('Twice').content, before.get('Twice').content, 'the shared form, byte for byte');
  assert.equal(after.get('Twice').ref, before.get('Twice').ref);
  const content = await pageContent(saved);
  assert.equal((content.match(/\/Twice Do/g) ?? []).length, 1, 'the other occurrence still draws the original');
  assert.match(content, /\/VlX1 Do/);

  // Reopened: one draw reads the new text, the other reads exactly what it always did.
  const texts = await textsOf(saved);
  assert.equal(texts.filter((t) => t === 'Only this one').length, 1);
  assert.equal(texts.filter((t) => t === 'Drawn twice').length, 1);
  // And nothing else on the page moved or changed.
  const was = base.page.runs.map((r) => r.text).filter((t) => t !== 'Drawn twice');
  assert.deepEqual(texts.filter((t) => t !== 'Only this one' && t !== 'Drawn twice'), was);
});

test('the copy is read back as an ordinary form, and its text can be edited again', async () => {
  const saved = await compose([retype(run('Clean form text'), 'Edited in a form')]);
  const reopened = (await analyzeFile(saved, { pages: [0] })).pages[0];
  const again = reopened.runs.find((r) => r.text === 'Edited in a form');
  assert.ok(again, 'the new text reads back as a run');
  assert.ok(again.form, 'still drawn by a form — it stayed inside the copy');
  assert.equal(again.editable, true, 'and the copy is as safe as the form it came from');
  assert.equal(again.formEdit.uses, 1, 'the copy is drawn once, by this occurrence alone');
});

test('deleting text inside a form empties it in the copy and leaves the original alone', async () => {
  const before = await formXObjects(base.bytes);
  const saved = await compose([retype(run('Clean form text'), '')]);
  const after = await formXObjects(saved);
  assert.equal(after.get('Clean').content, before.get('Clean').content);
  const texts = await textsOf(saved);
  assert.equal(texts.includes('Clean form text'), false, 'gone from the page');
  assert.ok(texts.includes('Drawn twice'), 'and nothing else went with it');
});

test('two edits inside one occurrence share one copy', async () => {
  // The page's own text edited alongside form text: one page patch, one copy, both changes written.
  const saved = await compose([
    retype(run('Clean form text'), 'Edited in a form'),
    retype(run('Page text stays editable'), 'Page text edited too'),
  ]);
  const content = await pageContent(saved);
  assert.equal((content.match(/\/VlX1 Do/g) ?? []).length, 1);
  const texts = await textsOf(saved);
  assert.ok(texts.includes('Edited in a form'));
  assert.ok(texts.includes('Page text edited too'));
});

// ---- 3b. where the new text lands ---------------------------------------------------------------

test('a form with a Matrix of its own: the new text lands exactly where the old text was', async () => {
  // The placement drawText works out is in PAGE user space; inside the copy it has to be in the
  // FORM's. This fixture's form carries Matrix [1 0 0 1 300 400], so getting that wrong moves the
  // text 300 by 400 — which reading the saved file back would show at once.
  const bytes = new Uint8Array(fs.readFileSync(files.constructs));
  const before = (await analyzeFile(bytes, { pages: [0] })).pages[0];
  const was = before.runs.find((r) => r.text === 'Inside a form');
  assert.deepEqual(before.forms[was.form.occurrence].matrix, [1, 0, 0, 1, 300, 400]);
  assert.equal(was.editable, true);

  const plan = identityPlan(1);
  const saved = await composeDocument({
    base: bytes, plan,
    edits: [planTextEdit({ run: was, text: 'Inside a copy', entry: plan[0].id, glyphs: (await analyzeFile(bytes, { pages: [0] })).source.glyphs })],
  });
  const after = (await analyzeFile(saved, { pages: [0] })).pages[0].runs.find((r) => r.text === 'Inside a copy');
  assert.ok(after, 'the new text reads back');
  assert.deepEqual(after.origin.map((v) => Math.round(v * 1000) / 1000), was.origin.map((v) => Math.round(v * 1000) / 1000));
  assert.deepEqual(after.first.ctm, was.first.ctm, 'drawn under the form’s own matrix, as before');
});

// ---- 4. what is still refused -------------------------------------------------------------------

test('an unsafe occurrence is refused at the planner, in the vocabulary’s own words', () => {
  for (const text of ['Borrowed resources', 'Behind a soft mask', 'Unbalanced form', 'Tagged form text', 'Font from outside']) {
    assert.throws(
      () => retype(run(text), 'Changed'),
      (err) => err instanceof EditError && err.kind === 'not-editable' && err.message === REASONS.form,
      `"${text}" is refused`,
    );
  }
});

test('the writer refuses a record for a run it would have to copy an unsafe form for', async () => {
  // A record the planner would never make, to prove the writer doesn't depend on it having refused.
  const refused = run('Behind a soft mask');
  const forged = { ...retype(run('Clean form text'), 'Changed'), target: { key: refused.key, text: refused.text, glyphs: refused.glyphs.map(([s, g]) => [s, g]) } };
  await assert.rejects(compose([forged]), (err) => err instanceof EditError);
  // …and the original file is what it always was: a refused save writes nothing.
  const after = await formXObjects(base.bytes);
  assert.equal(after.get('Masked').content, (await formXObjects(base.bytes)).get('Masked').content);
});

test('text inside a form is not moved: the writer refuses a record that carries a transform', async () => {
  const record = { ...retype(run('Clean form text'), 'Edited in a form'), transform: [1, 0, 0, 1, 20, 0] };
  await assert.rejects(compose([record]), (err) => err instanceof EditError && /can’t be moved/.test(err.message));
});

test('a pasted copy of text a form draws is refused by the writer', async () => {
  const r = run('Clean form text');
  const copy = planCopy({
    kind: textCopyKind, target: { key: r.key, text: r.text, glyphs: r.glyphs.map(([s, g]) => [s, g]) },
    text: r.text, encoding: { mode: 'original' }, transform: [1, 0, 0, 1, 0, -30], entry: base.plan[0].id,
  });
  await assert.rejects(compose([copy]), (err) => err instanceof EditError && /reusable graphic/.test(err.message));
});

// ---- 5. the verbs on offer ----------------------------------------------------------------------

test('a form run offers retyping and deleting, and keeps "form" for the verbs that redraw it elsewhere', () => {
  const inForm = capabilitiesFor(base.page, 'text-run', run('Clean form text'), { stream: 'page' });
  assert.equal(inForm.editText, true);
  assert.equal(inForm.delete, true);
  for (const verb of ['move', 'scale', 'rotate', 'copy']) assert.equal(inForm[verb], 'form', verb);
  assert.equal(inForm.stretch, 'unsupported');
  // The page's own text is unchanged by any of this.
  const onPage = capabilitiesFor(base.page, 'text-run', run('Page text stays editable'), { stream: 'page' });
  for (const verb of ['editText', 'delete', 'move', 'scale', 'rotate', 'copy']) assert.equal(onPage[verb], true, verb);
});

test('planning a move of text inside a form is refused, whatever the capability said', () => {
  assert.throws(
    () => planTextTransform({ run: run('Clean form text'), transform: [1, 0, 0, 1, 10, 0], entry: base.plan[0].id }),
    (err) => err instanceof EditError,
  );
});
