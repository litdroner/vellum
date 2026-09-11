// Vellum 0.5.0 Phase 0: hardening of the 0.4 text-editing engine (transparency, document profile,
// PDF/A, signatures, thumbnails). Run: node --test "tests/editing/*.test.mjs"

import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { analyzeFile, describeRuns, engine, loadPdfLib, webModule } from './harness.mjs';
import { makeFixtures, FIXTURE_DIR } from './fixtures.mjs';

const { planTextEdit, EditError } = await engine('edits.js');
const { inspectDocument, mayBeSigned } = await engine('source.js');
const { AnnotationStore } = await webModule('annotations/model.js');
const { composeDocument } = await webModule('annotations/persist.js');
const { identityPlan } = await webModule('pages/plan.js');

let files;
before(async () => { files = await makeFixtures(FIXTURE_DIR); });
const read = (name) => new Uint8Array(fs.readFileSync(files[name]));

async function open(bytes) {
  const result = await analyzeFile(bytes);
  return { bytes, result, plan: identityPlan(result.source.pageCount) };
}

const runOf = (d, page, text) => {
  const run = d.result.pages[page].runs.find((r) => r.text === text);
  assert.ok(run, `no run ${JSON.stringify(text)} on page ${page + 1}`);
  return run;
};

function plan(d, page, fromText, toText, extra = {}) {
  return planTextEdit({ run: runOf(d, page, fromText), text: toText, entry: d.plan[page].id, glyphs: d.result.source.glyphs, ...extra });
}

const compose = (d, edits) => composeDocument({ base: d.bytes, plan: d.plan, edits });

// ---- transparency -------------------------------------------------------------------------------

test('soft-mask transparency: text drawn through a soft mask is refused; opacity and blend modes stay editable', async () => {
  const d = await open(read('transparency'));
  const runs = describeRuns(d.result.pages[0]);
  const at = (text) => runs.find((r) => r.text === text);
  assert.deepEqual([at('Masked text').editable, at('Masked text').reasons], [false, ['soft-mask']]);
  for (const text of ['Mask cleared again', 'Half-transparent text', 'Multiplied text', 'Plain text']) {
    assert.deepEqual([at(text).editable, at(text).reasons], [true, []], text);
  }
  assert.throws(() => plan(d, 0, 'Masked text', 'Changed'), (e) => e instanceof EditError && e.kind === 'not-editable');
  // What the interpreter recorded for each line.
  const first = (text) => runOf(d, 0, text).first;
  assert.equal(first('Masked text').softMask, 'Mask');
  assert.equal(first('Mask cleared again').softMask, null);
  assert.deepEqual([first('Half-transparent text').ca, first('Half-transparent text').CA], [0.5, 0.5]);
  assert.equal(first('Multiplied text').blend, 'Multiply');
  assert.deepEqual([first('Plain text').ca, first('Plain text').blend, first('Plain text').softMask], [1, 'Normal', null]);
});

test('edited transparent text keeps its opacity and blend mode', async () => {
  const d = await open(read('transparency'));
  const saved = await compose(d, [plan(d, 0, 'Half-transparent text', 'Still half-transparent'), plan(d, 0, 'Multiplied text', 'Still multiplied')]);
  const reopened = await open(saved);
  const half = runOf(reopened, 0, 'Still half-transparent');
  assert.deepEqual([half.editable, half.first.ca, half.first.CA], [true, 0.5, 0.5]);
  const multiplied = runOf(reopened, 0, 'Still multiplied');
  assert.deepEqual([multiplied.editable, multiplied.first.blend], [true, 'Multiply']);
  // The masked line is untouched and still refused.
  assert.deepEqual(describeRuns(reopened.result.pages[0]).find((r) => r.text === 'Masked text').reasons, ['soft-mask']);
});

// ---- signed PDFs: confirming the first change ---------------------------------------------------

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const note = (store, x) => store.create({ type: 'note', page: 1, point: [x, x], color: '#ffd84d' });

test('change guard: changes wait for confirmation, then apply in order as separate steps', async () => {
  const store = new AnnotationStore();
  let answer;
  store.guard = () => new Promise((resolve) => { answer = resolve; });
  store.add(note(store, 1));
  store.add(note(store, 2)); // made while the first waits: joins the queue
  assert.deepEqual([store.all.length, store.pending, store.dirty], [0, true, false]);
  assert.equal(store.undo(), false, 'nothing to undo while changes wait');
  answer(true);
  await tick();
  assert.deepEqual([store.all.length, store.pending, store.dirty], [2, false, true]);
  // Confirmed once: the view's guard now says yes straight away.
  store.guard = () => true;
  store.add(note(store, 3));
  assert.equal(store.all.length, 3);
  store.undo();
  store.undo();
  assert.equal(store.all.length, 1, 'each waiting change became its own undo step');
});

test('change guard: a refused change is dropped and nothing is marked unsaved', async () => {
  const store = new AnnotationStore();
  store.guard = () => Promise.resolve(false);
  store.add(note(store, 1));
  await tick();
  assert.deepEqual([store.all.length, store.pending, store.dirty, store.canUndo], [0, false, false, false]);
  store.guard = () => false; // refused without asking
  store.add(note(store, 2));
  await tick();
  assert.equal(store.all.length, 0);
  store.guard = () => Promise.reject(new Error('dialog failed'));
  store.add(note(store, 3));
  await tick();
  assert.equal(store.all.length, 0, 'an error while asking counts as no');
});

test('signature hint from the raw bytes: certain only when a file surely has no signature', async () => {
  assert.equal(mayBeSigned(read('simple')), false);
  assert.equal(mayBeSigned(read('tagged')), false);
  assert.equal(mayBeSigned(read('signed')), true);
  assert.equal(mayBeSigned(read('signed-noflags')), true);
  // Compressed object streams could hide the SignaturesExist flag: then the file is checked properly.
  const lib = await loadPdfLib();
  const packed = await (await lib.PDFDocument.load(read('simple'))).save({ useObjectStreams: true });
  assert.equal(mayBeSigned(packed), true);
  assert.equal((await inspectDocument(lib, packed)).signed, false);
});

// ---- document profile: signatures, tags, PDF/A ----------------------------------------------

test('document profile: signed, tagged and PDF/A files are recognised; ordinary and protected files too', async () => {
  const lib = await loadPdfLib();
  const profile = (name) => inspectDocument(lib, read(name));
  assert.deepEqual(await profile('simple'), { encrypted: false, signed: false, certified: false, tagged: false, pdfa: null });
  assert.deepEqual(await profile('annotations'), { encrypted: false, signed: false, certified: false, tagged: false, pdfa: null }, 'a form without signatures');
  assert.equal((await profile('signed')).signed, true, 'signature value and SignaturesExist flag');
  assert.equal((await profile('signed-noflags')).signed, true, 'a signature value without the SignaturesExist flag');
  assert.equal((await profile('tagged')).tagged, true);
  assert.deepEqual((await profile('pdfa')).pdfa, { part: 2, conformance: 'B' });
  assert.equal((await profile('encrypted-open')).encrypted, true);
  // XMP written with attributes instead of elements.
  const doc = await lib.PDFDocument.create();
  doc.addPage();
  const xmp = '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description rdf:about="" xmlns:pdfaid="http://www.aiim.org/pdfa/ns/id/" pdfaid:part="1" pdfaid:conformance="a"/></rdf:RDF></x:xmpmeta>';
  doc.catalog.set(lib.PDFName.of('Metadata'), doc.context.register(doc.context.stream(xmp, { Type: 'Metadata', Subtype: 'XML' })));
  assert.deepEqual((await inspectDocument(lib, await doc.save())).pdfa, { part: 1, conformance: 'A' });
});

test('tagged PDFs: tagged text is marked (so the editor can warn), artifacts are not', async () => {
  const d = await open(read('tagged'));
  assert.deepEqual([runOf(d, 0, 'A tagged heading').tagged, runOf(d, 0, 'A tagged heading').editable], [true, true]);
  assert.equal(runOf(d, 0, 'A tagged paragraph of text.').tagged, true);
  assert.deepEqual([runOf(d, 0, 'Page 1').tagged, runOf(d, 0, 'Page 1').first.artifact], [false, true]);
});

test('PDF/A: a change that needs a substitute (non-embedded) font is refused; one in the embedded font is fine', async () => {
  const d = await open(read('pdfa'));
  const from = 'Archived text in an embedded font';
  const ok = plan(d, 0, from, 'Archived text', { embeddedFontsOnly: true });
  assert.equal(ok.encoding.mode, 'font');
  assert.throws(() => plan(d, 0, from, 'Quartz', { embeddedFontsOnly: true }), (e) => e instanceof EditError && e.kind === 'pdfa' && /PDF\/A/.test(e.message));
  // Without the PDF/A constraint the same change would use a standard font…
  const substitute = plan(d, 0, from, 'Quartz');
  assert.equal(substitute.encoding.mode, 'standard');
  // …and the writer refuses such a record for a PDF/A file too: nothing is written.
  await assert.rejects(compose(d, [substitute]), (e) => e instanceof EditError && e.kind === 'pdfa');
  // An edit in the embedded font saves, and the PDF/A metadata is kept.
  const saved = await compose(d, [ok]);
  assert.deepEqual((await inspectDocument(await loadPdfLib(), saved)).pdfa, { part: 2, conformance: 'B' });
});
