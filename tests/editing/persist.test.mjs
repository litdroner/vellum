// Phase 2: writing text edits into PDFs. Edits are planned on analyses that pdf.js confirmed,
// written by composeDocument (the app's only PDF writer), and the results are checked by opening
// them again — with pdf-lib for structure and with the app's own pdf.js for what's drawn.
// Run: node --test "tests/editing/*.test.mjs"

import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { analyzeFile, describeRuns, engine, loadPdfLib, openWithPdfjs, webModule } from './harness.mjs';
import { makeFixtures, FIXTURE_DIR } from './fixtures.mjs';

const { openSource } = await engine('source.js');
const { planTextEdit, followEdits, EditError } = await engine('edits.js');
const { composeDocument } = await webModule('annotations/persist.js');
const { AnnotationStore } = await webModule('annotations/model.js');
const { identityPlan, duplicateEntries, removeEntries, moveEntries } = await webModule('pages/plan.js');

let files;
before(async () => { files = await makeFixtures(FIXTURE_DIR); });
const read = (name) => new Uint8Array(fs.readFileSync(files[name]));

/** A document as the app would hold it: bytes, verified analysis, identity page plan. */
async function open(bytes) {
  const result = await analyzeFile(bytes);
  return { bytes, result, plan: identityPlan(result.source.pageCount) };
}

function plan(docState, page, fromText, toText, id) {
  const run = docState.result.pages[page].runs.find((r) => r.text === fromText);
  assert.ok(run, `no run ${JSON.stringify(fromText)} on page ${page + 1}`);
  return planTextEdit({ run, text: toText, entry: docState.plan[page].id, glyphs: docState.result.source.glyphs, id });
}

const compose = (docState, edits, extra = {}) => composeDocument({ base: docState.bytes, plan: extra.plan ?? docState.plan, edits, ...extra });

/** What pdf.js draws as text on a page: [{ str, x, y }] (rounded), whitespace-only items left out. */
async function drawnText(bytes, pageNumber) {
  const js = await openWithPdfjs(bytes);
  try {
    const content = await (await js.doc.getPage(pageNumber)).getTextContent();
    return content.items.filter((i) => i.str.trim()).map((i) => ({ str: i.str, x: Math.round(i.transform[4] * 100) / 100, y: Math.round(i.transform[5] * 100) / 100 }));
  } finally {
    await js.close();
  }
}

/** The document's structure, for before/after comparisons. */
async function structure(bytes) {
  const lib = await loadPdfLib();
  const { PDFName, PDFDict, PDFArray } = lib;
  const doc = await lib.PDFDocument.load(bytes, { updateMetadata: false });
  const source = await openSource(lib, bytes);
  const pages = doc.getPages().map((p) => {
    const annots = p.node.Annots();
    const list = annots ? annots.asArray().map((a) => doc.context.lookup(a)) : [];
    return {
      media: p.getMediaBox(), crop: p.getCropBox(), rotate: p.getRotation().angle,
      annots: list.map((a) => a.lookup(PDFName.of('Subtype'))?.decodeText?.()),
      uris: list.map((a) => a.lookup(PDFName.of('A'))?.lookup?.(PDFName.of('URI'))?.decodeText?.()).filter(Boolean),
      content: crypto.createHash('sha256').update(source.contentBytes(p.node)).digest('hex'),
    };
  });
  const outlines = doc.catalog.lookup(PDFName.of('Outlines'));
  const first = outlines instanceof PDFDict ? outlines.lookup(PDFName.of('First')) : null;
  let fields = [];
  try { fields = doc.getForm().getFields().map((f) => [f.getName(), f.constructor.name === 'PDFTextField' ? f.getText() : null]); } catch { fields = []; }
  const images = [];
  doc.getPages().forEach((p, i) => {
    const xo = p.node.Resources()?.lookup(PDFName.of('XObject'));
    if (xo instanceof PDFDict) for (const [k] of xo.entries()) images.push(`${i}:${k.decodeText()}`);
  });
  return { count: pages.length, pages, outline: first?.lookup(PDFName.of('Title'))?.decodeText?.() ?? null, fields, title: doc.getTitle() ?? null, images, kids: doc.catalog.lookup(PDFName.of('Pages')).lookup(PDFName.of('Kids')) instanceof PDFArray };
}

/** Every stream of a PDF, decoded, joined: to prove replaced text isn't hiding anywhere in the file. */
async function allStreamBytes(bytes) {
  const lib = await loadPdfLib();
  const doc = await lib.PDFDocument.load(bytes, { updateMetadata: false });
  const chunks = [];
  for (const [, obj] of doc.context.enumerateIndirectObjects()) {
    if (obj instanceof lib.PDFRawStream) {
      try { chunks.push(Buffer.from(lib.decodePDFRawStream(obj).decode())); } catch { chunks.push(Buffer.from(obj.contents)); }
    }
  }
  return Buffer.concat(chunks).toString('latin1');
}

// ---- undo / redo -------------------------------------------------------------------------------

test('A → B → C, undo → B, undo → A, redo → B, redo → C — in the one existing undo history', async () => {
  const d = await open(read('simple'));
  const store = new AnnotationStore();
  store.initPlan(d.plan);
  let rebuilds = 0;
  store.addEventListener('change', (e) => { if (e.detail.edits) rebuilds++; });
  const b = plan(d, 0, 'Hello, world', 'Hello, Vellum');
  store.applyEdit(null, b);
  const c = plan(d, 0, 'Hello, world', 'Goodbye, Vellum', b.id);
  store.applyEdit(b, c);
  // What pdf.js draws on the first line (edited text is drawn after the page's own content, so
  // it's found by position, not order).
  const shows = async () => (await drawnText(await compose(d, store.edits), 1)).find((i) => i.y === 700)?.str;
  assert.equal(await shows(), 'Goodbye, Vellum');
  assert.equal(store.dirty, true);
  store.undo();
  assert.equal(await shows(), 'Hello, Vellum');
  store.undo();
  assert.equal(store.edits.length, 0);
  assert.equal(await shows(), 'Hello, world');
  assert.equal(store.dirty, false, 'back to the file as it is: nothing to save');
  store.redo();
  assert.equal(await shows(), 'Hello, Vellum');
  store.redo();
  assert.equal(await shows(), 'Goodbye, Vellum');
  assert.equal(rebuilds, 6, 'every step asks the view to rebuild');
  // Saving doesn't touch the history; undoing after a save makes it dirty again.
  store.markSaved();
  assert.equal(store.dirty, false);
  store.undo();
  assert.equal(store.dirty, true);
  store.redo();
  assert.equal(store.dirty, false);
  // Annotations and text edits share the history (one Ctrl+Z at a time, in order).
  store.add(store.create({ type: 'note', page: 1, point: [10, 10], color: '#ffd84d' }));
  store.undo();
  assert.equal(store.all.length, 0);
  assert.equal(store.edits[0].text, 'Goodbye, Vellum');
});

test('two documents keep separate histories', async () => {
  const a = await open(read('simple'));
  const b = await open(read('landscape'));
  const storeA = new AnnotationStore();
  const storeB = new AnnotationStore();
  storeA.initPlan(a.plan);
  storeB.initPlan(b.plan);
  storeA.applyEdit(null, plan(a, 0, 'Third line.', 'Line three.'));
  storeB.applyEdit(null, plan(b, 0, 'A landscape page', 'A wide page'));
  storeA.undo();
  assert.deepEqual([storeA.edits.length, storeB.edits.length], [0, 1]);
});

// ---- save and reopen ------------------------------------------------------------------------------

test('edit → save → close → reopen: the new text is real, searchable and editable again', async () => {
  const d = await open(read('simple'));
  const saved = await compose(d, [plan(d, 0, 'Hello, world', 'Hello, Vellum')]);
  const reopened = await open(saved);
  const runs = describeRuns(reopened.result.pages[0]);
  const edited = runs.find((r) => r.text === 'Hello, Vellum');
  assert.ok(edited && edited.editable, 'the saved text is found and verified as editable');
  assert.deepEqual(edited.origin, [72, 700]);
  assert.equal(edited.size, 24);
  assert.equal(edited.font, 'Helvetica');
  assert.ok(!runs.some((r) => r.text.includes('Hello, world')));
  // Edit it again in the reopened file.
  const again = await compose(reopened, [plan(reopened, 0, 'Hello, Vellum', 'Hello again')]);
  assert.ok((await drawnText(again, 1)).some((i) => i.str === 'Hello again'));
});

test('the replaced text is really gone from the file, not just hidden', async () => {
  const d = await open(read('simple'));
  const before = await allStreamBytes(d.bytes);
  assert.ok(before.includes('Hello, world'));
  const saved = await compose(d, [plan(d, 0, 'Hello, world', 'Greetings')]);
  const after = await allStreamBytes(saved);
  assert.ok(!after.includes('Hello, world'), 'old text bytes remain somewhere in the saved file');
  assert.ok(!after.includes('Hello'), 'not even partly');
});

test('only the edited page changes: size, rotation, annotations, links, form fields, outline, metadata, images kept', async () => {
  const multi = await open(read('multipage'));
  const saved = await compose(multi, [plan(multi, 2, 'Page 3 of five', 'Page three of five')]);
  const [a, b] = [await structure(multi.bytes), await structure(saved)];
  assert.equal(b.count, a.count);
  a.pages.forEach((page, i) => {
    assert.deepEqual([b.pages[i].media, b.pages[i].crop, b.pages[i].rotate], [page.media, page.crop, page.rotate]);
    if (i === 2) assert.notEqual(b.pages[i].content, page.content);
    else assert.equal(b.pages[i].content, page.content, `page ${i + 1}'s content changed`);
  });

  const annotated = await open(read('annotations'));
  const out = await compose(annotated, [plan(annotated, 0, 'Text with a link and a note', 'Text with a link and a comment')]);
  const [x, y] = [await structure(annotated.bytes), await structure(out)];
  assert.deepEqual(y.pages[0].annots, x.pages[0].annots);
  assert.deepEqual(y.pages[0].uris, ['https://example.com/']);
  assert.deepEqual(y.fields, x.fields);
  assert.equal(y.outline, 'First page');
  assert.equal(y.title, 'Annotations fixture');

  const pictures = await open(read('images'));
  const withImages = await compose(pictures, [plan(pictures, 0, 'Caption under the picture', 'A new caption')]);
  assert.deepEqual((await structure(withImages)).images, (await structure(pictures.bytes)).images);
  const js = await openWithPdfjs(withImages);
  const ops = await (await js.doc.getPage(1)).getOperatorList();
  assert.equal(ops.fnArray.filter((f) => f === js.pdfjs.OPS.paintImageXObject).length, 2, 'both pictures still drawn');
  await js.close();
});

test('everything else on a busy page stays exactly where it was', async () => {
  const d = await open(read('constructs'));
  const edits = [
    plan(d, 0, 'World kerned', 'World'),
    plan(d, 0, 'Line two', 'Line 2'), // shown with ' (moves to the next line first)
    plan(d, 0, 'Spaced and scaled words', 'Spaced words'),
    plan(d, 0, 'Raised', 'Lifted'),
    plan(d, 0, 'Rotated text', 'Turned text'),
    plan(d, 0, 'Outlined text', 'Outlined words'),
    plan(d, 0, 'Hex string', ''), // removed
  ];
  const saved = await compose(d, edits);
  const old = ['World kerned', 'Line two', 'Spaced and scaled words', 'Raised', 'Rotated text', 'Outlined text', 'Hex string'];
  const reopened = await open(saved);
  const runs = describeRuns(reopened.result.pages[0]);
  // Every run that wasn't edited is read at exactly the same place — and, where it was editable
  // before, pdf.js still confirms it (its positions are part of that check).
  const unedited = describeRuns(d.result.pages[0]).filter((r) => !old.includes(r.text));
  for (const r of unedited) {
    const same = runs.find((x) => x.text === r.text && x.origin[0] === r.origin[0] && x.origin[1] === r.origin[1]);
    assert.ok(same, `${JSON.stringify(r.text)} moved or changed`);
    if (r.editable) assert.equal(same.editable, true, `${JSON.stringify(r.text)} is no longer confirmed by pdf.js`);
  }
  // pdf.js still draws all of that text (however it splits it into items).
  const flat = (items) => items.map((i) => i.str).join('').replace(/\s+/g, '');
  const drawn = flat(await drawnText(saved, 1));
  for (const r of unedited.filter((x) => x.reasons[0] !== 'invisible' && x.reasons[0] !== 'blank')) {
    assert.ok(drawn.includes(r.text.replace(/\s+/g, '')), `pdf.js no longer draws ${JSON.stringify(r.text)}`);
  }
  const at = (text) => runs.find((r) => r.text === text);
  assert.deepEqual(at('Line 2').origin, [72, 656]);
  assert.deepEqual(at('Line three').origin, [72, 642], 'the " line still follows the edited \' line');
  assert.deepEqual(at('Lifted').origin, [72, 695], 'text rise kept');
  assert.deepEqual(at('Turned text').origin, [540, 300]);
  assert.ok(at('Turned text').editable);
  assert.ok(!runs.some((r) => r.text === 'Hex string'));
  const spaced = reopened.result.pages[0].runs.find((r) => r.text === 'Spaced words');
  assert.equal(spaced.first.th, 0.8, 'horizontal scaling kept');
  assert.equal(spaced.first.tc, 2, 'character spacing kept');
  assert.equal(reopened.result.pages[0].runs.find((r) => r.text === 'Outlined words').first.tr, 1, 'outline rendering kept');
});

test('fonts: the original font when it can write the text; a matching standard font when not', async () => {
  const d = await open(read('fonts'));
  const same = plan(d, 0, 'Liberation Bold subset', 'Liberation Bold');
  assert.equal(same.encoding.mode, 'font');
  const other = plan(d, 0, 'Liberation Sans embedded', 'Quartz jumps');
  assert.deepEqual([other.encoding.mode, other.encoding.font], ['standard', 'Helvetica']);
  const serif = plan(d, 0, 'Times italic', 'Times italique');
  assert.equal(serif.encoding.mode, 'font', 'a standard font the viewer supplies can write any WinAnsi text');
  const saved = await compose(d, [same, other, serif]);
  const reopened = describeRuns((await open(saved)).result.pages[0]);
  const font = (text) => reopened.find((r) => r.text === text)?.font;
  assert.equal(font('Liberation Bold'), 'LiberationSans-Bold');
  assert.equal(font('Quartz jumps'), 'Helvetica');
  assert.equal(font('Times italique'), 'Times-Italic');
  assert.ok(reopened.filter((r) => ['Liberation Bold', 'Quartz jumps', 'Times italique'].includes(r.text)).every((r) => r.editable));

  const composite = await open(read('composite'));
  const two = plan(composite, 0, 'Composite Identity font text with spaces', 'Composite text with spaces');
  assert.equal(two.encoding.mode, 'font');
  assert.ok(two.encoding.items.every((i) => i.space || i.byteLength === 2), 'two-byte codes');
  const out = await compose(composite, [two]);
  assert.ok((await drawnText(out, 1)).some((i) => i.str === 'Composite text with spaces'));
});

test('text that can’t be written safely is refused with a reason, and nothing is changed', async () => {
  const d = await open(read('fonts'));
  assert.throws(() => plan(d, 0, 'Helvetica regular', 'नमस्ते'), (e) => e instanceof EditError && e.kind === 'characters');
  assert.throws(() => plan(d, 0, 'Liberation Bold subset', '你好'), (e) => e instanceof EditError && e.kind === 'characters');
  const c = await open(read('constructs'));
  assert.throws(() => plan(c, 0, 'abab', 'x'), (e) => e instanceof EditError && e.kind === 'not-editable');
  assert.throws(() => plan(c, 0, 'Inside a form', 'x'), (e) => e instanceof EditError && e.kind === 'not-editable');
  assert.throws(() => plan(c, 3, 'After a stray Q', 'x'), (e) => e instanceof EditError && e.kind === 'not-editable');
  // A record that no longer matches the file is refused at save time.
  const record = plan(d, 0, 'Courier fixed', 'Courier');
  const stale = { ...record, target: { ...record.target, text: 'Something else' } };
  await assert.rejects(compose(d, [stale]), (e) => e instanceof EditError && e.kind === 'changed');
});

test('content left open at the end of a page is closed properly around the new text', async () => {
  const d = await open(read('constructs'));
  const saved = await compose(d, [plan(d, 4, 'Left open', 'Closed now')]);
  const runs = describeRuns((await open(saved)).result.pages[4]);
  assert.deepEqual(runs.map((r) => [r.text, r.editable, r.origin]), [['Closed now', true, [72, 700]]]);
});

test('edits follow the page organiser: moved, duplicated and deleted pages', async () => {
  const d = await open(read('multipage'));
  const store = new AnnotationStore();
  store.initPlan(d.plan);
  store.applyEdit(null, plan(d, 1, 'Page 2 of five', 'Second page'));
  const id = d.plan[1].id;
  // Duplicate page 2: the copy carries the edit too (one undo step).
  let { plan: next, copies } = duplicateEntries(store.plan, new Set([id]));
  store.applyPlan(next, followEdits(store.edits, next, copies));
  assert.equal(store.edits.length, 2);
  let saved = await compose(d, store.edits, { plan: store.plan });
  assert.deepEqual([await drawnText(saved, 2), await drawnText(saved, 3)].map((p) => p[0].str), ['Second page', 'Second page']);
  // Move the original to the end: its edit goes with it.
  next = moveEntries(store.plan, new Set([id]), store.plan.length);
  store.applyPlan(next, followEdits(store.edits, next));
  saved = await compose(d, store.edits, { plan: store.plan });
  assert.equal((await drawnText(saved, 6))[0].str, 'Second page');
  assert.equal((await drawnText(saved, 2))[0].str, 'Second page'); // the copy stayed in place
  // Delete it: its edit is gone, the copy's remains.
  next = removeEntries(store.plan, new Set([id]));
  store.applyPlan(next, followEdits(store.edits, next));
  assert.equal(store.edits.length, 1);
  saved = await compose(d, store.edits, { plan: store.plan });
  assert.equal((await structure(saved)).count, 5);
  // Undo brings the page and its edit back together.
  store.undo();
  assert.equal(store.edits.length, 2);
});

test('rotated and differently sized pages keep their geometry', async () => {
  const d = await open(read('mixed-sizes'));
  const saved = await compose(d, [plan(d, 3, 'Rotated page', 'Turned page'), plan(d, 1, 'A5 page', 'Small page')]);
  const [a, b] = [await structure(d.bytes), await structure(saved)];
  assert.deepEqual(b.pages.map((p) => [p.media, p.rotate]), a.pages.map((p) => [p.media, p.rotate]));
  const reopened = await open(saved);
  assert.deepEqual(describeRuns(reopened.result.pages[3]).map((r) => [r.text, r.origin]), [['Turned page', [72, 700]]]);
});

test('rebuild speed with an edit on a 200-page document', async (t) => {
  const d = await open(read('large'));
  const edit = plan(d, 99, 'Page 100, line 1: the quick brown fox jumps over the lazy dog.', 'Page 100, edited.');
  let start = performance.now();
  await compose(d, [], { clean: false });
  const plainMs = performance.now() - start;
  start = performance.now();
  const bytes = await compose(d, [edit], { clean: false });
  const editMs = performance.now() - start;
  start = performance.now();
  await compose(d, [edit]);
  const saveMs = performance.now() - start;
  start = performance.now();
  const js = await openWithPdfjs(bytes);
  await (await js.doc.getPage(100)).getOperatorList();
  const showMs = performance.now() - start;
  await js.close();
  t.diagnostic(`compose without edits ${Math.round(plainMs)} ms; with one edit (rebuild) ${Math.round(editMs)} ms; saving (with clean-up) ${Math.round(saveMs)} ms; pdf.js reopen + draw page ${Math.round(showMs)} ms`);
  assert.ok(editMs < plainMs + 400, 'an edit adds little to a rebuild');
});

test('rebuild speed on real PDFs from VELLUM_TEST_PDFS (optional, read only)', async (t) => {
  const list = (process.env.VELLUM_TEST_PDFS ?? '').split(';').map((s) => s.trim()).filter(Boolean);
  if (!list.length) {
    t.skip('set VELLUM_TEST_PDFS to measure real files');
    return;
  }
  for (const file of list) {
    let d;
    try {
      d = await open(new Uint8Array(fs.readFileSync(file)));
    } catch {
      continue; // protected files are refused by design
    }
    const page = d.result.pages.findIndex((p) => p.runs.some((r) => r.editable && r.text.length > 8));
    if (page < 0) continue;
    const run = d.result.pages[page].runs.find((r) => r.editable && r.text.length > 8);
    const edit = planTextEdit({ run, text: `${run.text} (edited)`, entry: d.plan[page].id, glyphs: d.result.source.glyphs });
    const start = performance.now();
    const bytes = await compose(d, [edit], { clean: false });
    const ms = performance.now() - start;
    const drawn = await drawnText(bytes, page + 1);
    assert.ok(drawn.some((i) => i.str.includes('(edited)')), `${file}: the edit shows`);
    t.diagnostic(`${file.split(/[\\/]/).pop()}: ${d.result.source.pageCount} pages, rebuild with one edit ${Math.round(ms)} ms (${edit.encoding.mode === 'font' ? 'original font' : edit.encoding.font})`);
  }
});
