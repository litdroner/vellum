// Vellum 0.5.0 must-haves, proved: objects that have been moved, scaled, turned and deleted — one or
// several — survive the page organiser (reorder, duplicate, rotate, delete) and a save, the rest of
// the file comes through intact, and every refusal a person can meet is a sentence.
//
// Records are planned the way the session plans them, kept in the one edit store, carried through
// page changes by followEdits exactly as DocumentView does, written by composeDocument, and then the
// saved file is read again from scratch: pdf-lib for its structure, pdf.js for what it draws.
// Run: node --test "tests/editing/*.test.mjs"

import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { analyzeFile, engine, loadPdfLib, openWithPdfjs, webModule } from './harness.mjs';
import { makeFixtures, FIXTURE_DIR } from './fixtures.mjs';

const { openSource } = await engine('source.js');
const { planTextEdit, planTextTransform, followEdits } = await engine('edits.js');
const { planImageEdit } = await engine('objects/image.js');
const { objectsOf } = await engine('objects/page-objects.js');
const { VERBS, refusalMessage } = await engine('objects/capabilities.js');
const { REASONS } = await engine('runs.js');
const { apply, translate } = await engine('matrix.js');
const { scaleAbout, quarterTurn } = await engine('objects/transform.js');
const { composeDocument } = await webModule('annotations/persist.js');
const { AnnotationStore } = await webModule('annotations/model.js');
const { identityPlan, duplicateEntries, copyEntries, moveEntries, removeEntries, rotateEntries } = await webModule('pages/plan.js');

let files;
before(async () => { files = await makeFixtures(FIXTURE_DIR); });
const read = (name) => new Uint8Array(fs.readFileSync(files[name]));

/** A document as the app holds it: original bytes, verified analyses, an identity plan, a store. */
async function open(name) {
  const bytes = read(name);
  const result = await analyzeFile(bytes);
  const plan = identityPlan(result.source.pageCount);
  const store = new AnnotationStore();
  store.initPlan(plan);
  return { bytes, result, plan, store };
}

const pictureOf = (d, page) => objectsOf(d.result.pages[page]).find((o) => o.kind === 'image');
const runOf = (d, page, text) => d.result.pages[page].runs.find((r) => r.text === text);
const entryOf = (d, page) => d.plan[page].id;

/** Records for a picture and a caption on one page, planned as the session plans them. */
const movePicture = (d, page, transform, entry = entryOf(d, page)) => planImageEdit({ object: pictureOf(d, page), transform, entry });
const moveText = (d, page, text, transform, entry = entryOf(d, page)) => planTextTransform({ run: runOf(d, page, text), transform, entry });

/** Changes the plan in the store the way DocumentView does: one step, records following their pages. */
function changePlan(d, next, copies = []) {
  d.store.applyPlan(next, followEdits(d.store.edits, next, copies));
}

const compose = (d) => composeDocument({ base: d.bytes, plan: d.store.plan, edits: d.store.edits });
const CORNERS = [[0, 0], [1, 0], [1, 1], [0, 1]];
const near = (a, b, tol = 0.05) => a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) <= tol);
const cornersNear = (got, want, tol = 0.05) => got.length === want.length && got.every((p, i) => near(p, want[i], tol));

/** What a saved file holds, page by page: where each picture is, where each line is, the /Rotate. */
async function reread(bytes) {
  const result = await analyzeFile(bytes);
  const lib = await loadPdfLib();
  const doc = await lib.PDFDocument.load(bytes, { updateMetadata: false });
  return result.pages.map((analysis, i) => ({
    rotate: doc.getPages()[i].getRotation().angle,
    pictures: objectsOf(analysis).filter((o) => o.kind === 'image').map((o) => CORNERS.map(([x, y]) => apply(o.record.ctm, x, y))),
    runs: analysis.runs.filter((r) => r.text.trim()).map((r) => ({ text: r.text, origin: r.origin, size: r.frame.size })),
    run(text) { return this.runs.find((r) => r.text === text) ?? null; },
  }));
}

/** An original picture's corners, moved by a page-space transform. */
const cornersAfter = (d, page, transform) => CORNERS.map(([x, y]) => apply(transform, ...apply(pictureOf(d, page).record.ctm, x, y)));

/**
 * The checks every saved file has to pass, whatever was done to it: pdf-lib loads it; pdf.js draws
 * every page without an error; and every image a page draws by name is in the resources that page
 * really resolves — so nothing was released that is still in use, on this page or on any other.
 */
async function assertIntact(bytes, what) {
  const lib = await loadPdfLib();
  const doc = await lib.PDFDocument.load(bytes, { updateMetadata: false });
  const result = await analyzeFile(bytes);
  doc.getPages().forEach((page, i) => {
    const xobjects = page.node.Resources()?.lookup(lib.PDFName.of('XObject'));
    const names = xobjects instanceof lib.PDFDict ? xobjects.keys().map((k) => k.decodeText()) : [];
    for (const image of result.pages[i].images) {
      if (image.inline || image.stream !== 'page') continue;
      assert.ok(names.includes(image.name), `${what}: page ${i + 1} draws /${image.name} but its resources have ${JSON.stringify(names)}`);
    }
  });
  const js = await openWithPdfjs(bytes);
  try {
    for (let n = 1; n <= js.doc.numPages; n++) {
      const page = await js.doc.getPage(n);
      await page.getOperatorList();
      await page.getTextContent();
    }
  } finally {
    await js.close();
  }
  return result;
}

/** How many picture draws pdf.js makes on each page. */
async function drawsPerPage(bytes) {
  const js = await openWithPdfjs(bytes);
  try {
    const counts = [];
    for (let n = 1; n <= js.doc.numPages; n++) {
      const ops = await (await js.doc.getPage(n)).getOperatorList();
      counts.push(ops.fnArray.filter((f) => f === js.pdfjs.OPS.paintImageXObject).length);
    }
    return counts;
  } finally {
    await js.close();
  }
}

/** A page's content stream, hashed, as the saved file has it. */
async function contentHashes(bytes) {
  const lib = await loadPdfLib();
  const doc = await lib.PDFDocument.load(bytes, { updateMetadata: false });
  const source = await openSource(lib, bytes);
  return doc.getPages().map((p) => crypto.createHash('sha256').update(source.contentBytes(p.node)).digest('hex'));
}

// ---- 1. the page organiser ---------------------------------------------------------------------

test('moved objects follow their page when pages are reordered, and the pages around it are untouched', async () => {
  const d = await open('gallery');
  const delta = translate(40, -30);
  d.store.applyEdits([[null, movePicture(d, 1, delta)], [null, moveText(d, 1, 'Picture two', delta)]]);
  changePlan(d, moveEntries(d.store.plan, new Set([entryOf(d, 1)]), 3));
  assert.deepEqual(d.store.plan.map((e) => e.index), [0, 2, 1]);
  const saved = await compose(d);
  await assertIntact(saved, 'reordered');
  const pages = await reread(saved);
  assert.ok(cornersNear(pages[2].pictures[0], cornersAfter(d, 1, delta)), 'the picture moved with its page, to the end');
  assert.ok(near(pages[2].run('Picture two').origin, apply(delta, ...runOf(d, 1, 'Picture two').origin)), 'and so did its caption');
  const [before, after] = [await contentHashes(d.bytes), await contentHashes(saved)];
  assert.deepEqual([after[0], after[1]], [before[0], before[2]], 'the other two pages are exactly as they were');
});

test('a duplicated page carries its object records, and each copy can then be changed on its own', async () => {
  const d = await open('gallery');
  const picture = pictureOf(d, 0);
  const scale = scaleAbout([72, 560], 0.5);
  d.store.applyEdit(null, movePicture(d, 0, scale));
  const { plan: next, copies } = duplicateEntries(d.store.plan, new Set([entryOf(d, 0)]));
  changePlan(d, next, copies);
  assert.equal(d.store.edits.length, 2, 'the copy has a record of its own');
  assert.notEqual(d.store.edits[0].id, d.store.edits[1].id);
  let saved = await compose(d);
  await assertIntact(saved, 'duplicated');
  let pages = await reread(saved);
  assert.ok(cornersNear(pages[0].pictures[0], cornersAfter(d, 0, scale)), 'the original is scaled');
  assert.ok(cornersNear(pages[1].pictures[0], cornersAfter(d, 0, scale)), 'and so is the copy');

  // Now the picture is deleted on the copy alone.
  const copyId = copies[0][1];
  const copyRecord = d.store.edits.find((e) => e.entry === copyId);
  d.store.applyEdit(copyRecord, planImageEdit({ object: picture, removed: true, entry: copyId, id: copyRecord.id }));
  saved = await compose(d);
  await assertIntact(saved, 'deleted on the copy');
  assert.deepEqual(await drawsPerPage(saved), [1, 0, 1, 1], 'only the copy lost its picture');
  pages = await reread(saved);
  assert.ok(cornersNear(pages[0].pictures[0], cornersAfter(d, 0, scale)), 'the original keeps its scaled picture');
  assert.ok(pages[1].run('Picture one'), 'and the copy keeps its caption');
  d.store.undo();
  assert.deepEqual(await drawsPerPage(await compose(d)), [1, 1, 1, 1], 'undo puts the picture back on the copy');
});

test('pages copied and pasted elsewhere carry their records, keep their order, and undo and redo as one step', async () => {
  const d = await open('gallery');
  const scale = scaleAbout([72, 560], 0.5);
  d.store.applyEdit(null, movePicture(d, 0, scale));
  const ids = [entryOf(d, 1), entryOf(d, 0)];
  const { plan: next, copies } = copyEntries(d.store.plan, new Set(ids), 3);
  assert.deepEqual(next.map((e) => e.index), [0, 1, 2, 0, 1], 'copies pasted after page 3, in page order');
  assert.deepEqual(copies.map(([from]) => from), [entryOf(d, 0), entryOf(d, 1)]);
  changePlan(d, next, copies);
  assert.equal(d.store.edits.length, 2, 'the pasted copy of page 1 has a record of its own');
  const saved = await compose(d);
  await assertIntact(saved, 'pasted');
  const pages = await reread(saved);
  assert.equal(pages.length, 5);
  assert.ok(cornersNear(pages[3].pictures[0], cornersAfter(d, 0, scale)), 'the pasted copy is scaled like its page');
  assert.ok(pages[4].run('Picture two'), 'and page 2 follows it');
  d.store.undo();
  assert.equal(d.store.plan.length, 3);
  assert.equal(d.store.edits.length, 1, 'undo takes the copies and their records away');
  d.store.redo();
  assert.equal(d.store.plan.length, 5);
  assert.equal(d.store.edits.length, 2, 'redo brings them back');
});

test('a turned page keeps its objects exactly where they were put, in its own user space', async () => {
  const d = await open('gallery');
  const delta = translate(100, 120);
  d.store.applyEdits([[null, movePicture(d, 2, delta)], [null, moveText(d, 2, 'Picture three', delta)]]);
  changePlan(d, rotateEntries(d.store.plan, new Set([entryOf(d, 2)]), 90));
  const saved = await compose(d);
  await assertIntact(saved, 'turned');
  const pages = await reread(saved);
  assert.equal(pages[2].rotate, 90, 'the page is turned');
  assert.ok(cornersNear(pages[2].pictures[0], cornersAfter(d, 2, delta)), 'the picture is where it was moved to');
  assert.ok(near(pages[2].run('Picture three').origin, apply(delta, ...runOf(d, 2, 'Picture three').origin)));
  assert.deepEqual([pages[0].rotate, pages[1].rotate], [0, 0], 'the other pages are not turned');
});

test('deleting a page takes its object records with it, and undo brings the page and its records back', async () => {
  const d = await open('gallery');
  const delta = translate(10, 10);
  d.store.applyEdits([[null, movePicture(d, 1, delta)], [null, moveText(d, 1, 'Picture two', delta)], [null, movePicture(d, 2, delta)]]);
  changePlan(d, removeEntries(d.store.plan, new Set([entryOf(d, 1)])));
  assert.equal(d.store.edits.length, 1, 'only the record on the page that is still there');
  let saved = await compose(d);
  await assertIntact(saved, 'page deleted');
  let pages = await reread(saved);
  assert.equal(pages.length, 2);
  assert.ok(cornersNear(pages[1].pictures[0], cornersAfter(d, 2, delta)));
  d.store.undo();
  assert.equal(d.store.edits.length, 3);
  saved = await compose(d);
  pages = await reread(saved);
  assert.equal(pages.length, 3);
  assert.ok(cornersNear(pages[1].pictures[0], cornersAfter(d, 1, delta)), 'the page and its moved picture are back together');
});

test('a group gesture follows its page through a copy, a move and a turn', async () => {
  const d = await open('gallery');
  const anchor = [300, 490];
  const scale = scaleAbout(anchor, 1.5);
  d.store.applyEdits([[null, movePicture(d, 1, scale)], [null, moveText(d, 1, 'Picture two', scale)]]);
  const { plan: copied, copies } = duplicateEntries(d.store.plan, new Set([entryOf(d, 1)]));
  changePlan(d, copied, copies);
  changePlan(d, moveEntries(d.store.plan, new Set([copies[0][1]]), 0)); // the copy to the front
  changePlan(d, rotateEntries(d.store.plan, new Set([entryOf(d, 1)]), 270)); // the original turned
  assert.equal(d.store.edits.length, 4, 'two records on each copy of the page');
  const saved = await compose(d);
  await assertIntact(saved, 'copied, moved and turned');
  const pages = await reread(saved);
  const run = runOf(d, 1, 'Picture two');
  for (const [at, rotate] of [[0, 0], [2, 270]]) {
    assert.equal(pages[at].rotate, rotate);
    assert.ok(cornersNear(pages[at].pictures[0], cornersAfter(d, 1, scale)), `page ${at + 1}: the picture`);
    const caption = pages[at].run('Picture two');
    assert.ok(near(caption.origin, apply(scale, ...run.origin)) && Math.abs(caption.size - run.frame.size * 1.5) < 0.01, `page ${at + 1}: the caption`);
  }
});

// ---- 2. resources that pages share -----------------------------------------------------------------------

test('deleting the picture on one page never takes it from the pages that inherit the same resources', async () => {
  const d = await open('gallery');
  d.store.applyEdit(null, planImageEdit({ object: pictureOf(d, 0), removed: true, entry: entryOf(d, 0) }));
  let saved = await compose(d);
  await assertIntact(saved, 'one picture deleted');
  assert.deepEqual(await drawsPerPage(saved), [0, 1, 1], 'pages two and three still draw it');
  const lib = await loadPdfLib();
  const names = async (bytes) => {
    const doc = await lib.PDFDocument.load(bytes, { updateMetadata: false });
    return doc.getPages().map((p) => {
      const xo = p.node.Resources()?.lookup(lib.PDFName.of('XObject'));
      return xo instanceof lib.PDFDict ? xo.keys().map((k) => k.decodeText()) : [];
    });
  };
  assert.deepEqual(await names(saved), [[], ['Im1'], ['Im1']], 'released from the first page’s own resources only');

  // Every picture deleted: none is drawn, and nothing any page draws is missing.
  for (const page of [1, 2]) d.store.applyEdit(null, planImageEdit({ object: pictureOf(d, page), removed: true, entry: entryOf(d, page) }));
  saved = await compose(d);
  await assertIntact(saved, 'every picture deleted');
  assert.deepEqual(await drawsPerPage(saved), [0, 0, 0]);
  assert.deepEqual((await reread(saved)).map((p) => p.runs.map((r) => r.text)), [['Picture one'], ['Picture two'], ['Picture three']], 'the captions all stay');
});

// ---- 3. the rest of the file ---------------------------------------------------------------------------

test('moving and deleting objects keeps the page boxes, annotations, links, form fields, outline and metadata', async () => {
  const d = await open('annotations');
  const lib = await loadPdfLib();
  const run = runOf(d, 0, 'Text with a link and a note');
  const field = runOf(d, 0, 'Field below:');
  d.store.applyEdits([
    [null, planTextTransform({ run, transform: translate(0, -60), entry: entryOf(d, 0) })],
    [null, planTextEdit({ run: field, text: '', entry: entryOf(d, 0), glyphs: d.result.source.glyphs })],
  ]);
  const saved = await compose(d);
  await assertIntact(saved, 'annotations fixture');
  const describe = async (bytes) => {
    const doc = await lib.PDFDocument.load(bytes, { updateMetadata: false });
    const page = doc.getPages()[0];
    const annots = page.node.Annots()?.asArray().map((a) => doc.context.lookup(a)) ?? [];
    const outlines = doc.catalog.lookup(lib.PDFName.of('Outlines'));
    return {
      media: page.getMediaBox(), crop: page.getCropBox(), rotate: page.getRotation().angle,
      annots: annots.map((a) => a.lookup(lib.PDFName.of('Subtype'))?.decodeText?.()),
      rects: annots.map((a) => a.lookup(lib.PDFName.of('Rect'))?.asArray().map((n) => n.asNumber())),
      uri: annots.map((a) => a.lookup(lib.PDFName.of('A'))?.lookup?.(lib.PDFName.of('URI'))?.decodeText?.()).filter(Boolean),
      fields: doc.getForm().getFields().map((f) => [f.getName(), f.getText?.() ?? null]),
      outline: outlines?.lookup(lib.PDFName.of('First'))?.lookup(lib.PDFName.of('Title'))?.decodeText?.() ?? null,
      title: doc.getTitle() ?? null,
    };
  };
  assert.deepEqual(await describe(saved), await describe(d.bytes), 'everything but the page content is as it was');
  const pages = await reread(saved);
  assert.ok(near(pages[0].run(run.text).origin, apply(translate(0, -60), ...run.origin)), 'the moved line is where it was put');
  assert.equal(pages[0].run('Field below:'), null, 'and the deleted line is gone');
});

test('a saved file with manipulated objects opens with every object selectable and changeable where it was put', async () => {
  const d = await open('images');
  const [first, second] = objectsOf(d.result.pages[0]).filter((o) => o.kind === 'image');
  const text = runOf(d, 0, 'Caption under the picture');
  const turn = quarterTurn([450, 650], 1); // the second picture, a quarter turn about its own centre
  d.store.applyEdits([
    [null, planImageEdit({ object: first, transform: translate(0, 40), entry: entryOf(d, 0) })],
    [null, planImageEdit({ object: second, transform: turn, entry: entryOf(d, 0) })],
    [null, planTextTransform({ run: text, transform: translate(0, 40), entry: entryOf(d, 0) })],
  ]);
  const saved = await compose(d);
  const again = await assertIntact(saved, 'reopened');
  const objects = objectsOf(again.pages[0]);
  const pictures = objects.filter((o) => o.kind === 'image');
  assert.equal(pictures.length, 2);
  for (const o of pictures) assert.deepEqual([o.capabilities.move, o.capabilities.scale, o.capabilities.rotate, o.capabilities.delete], [true, true, true, true]);
  const caption = objects.find((o) => o.kind === 'text-run' && o.text === 'Caption under the picture');
  assert.equal(caption.capabilities.move, true, 'the moved line can be moved again');
  assert.equal(caption.editable, true, 'and edited: pdf.js reads it exactly as Vellum wrote it');
  const expected = CORNERS.map(([x, y]) => apply(turn, ...apply(second.record.ctm, x, y)));
  const found = pictures.map((o) => CORNERS.map(([x, y]) => apply(o.record.ctm, x, y)));
  assert.ok(found.some((c) => cornersNear(c, expected, 0.1)), `the turned picture is where the turn put it: ${JSON.stringify(found)}`);
});

// ---- 4. what a person is told ------------------------------------------------------------------------

test('every refusal a person can meet, for any verb on any object of any fixture, is a sentence', async () => {
  const names = ['simple', 'fonts', 'constructs', 'images', 'scanned', 'transparency', 'objects', 'tagged', 'pdfa', 'overlap', 'gallery', 'cmaps', 'composite', 'columns'];
  const seen = new Set();
  for (const name of names) {
    const result = await analyzeFile(read(name));
    for (const analysis of result.pages) {
      for (const object of objectsOf(analysis)) {
        for (const verb of VERBS) {
          const answer = object.capabilities[verb];
          if (answer === true) continue;
          assert.equal(typeof REASONS[answer], 'string', `${name} ${object.ref.key} ${verb}: “${answer}” has no sentence`);
          assert.equal(refusalMessage(verb, answer), REASONS[answer]);
          assert.ok(refusalMessage(verb, answer, 2).endsWith(REASONS[answer]));
          seen.add(answer);
        }
      }
    }
  }
  for (const key of ['clipped', 'form', 'layer', 'soft-mask', 'unsupported', 'type3']) assert.ok(seen.has(key), `the fixtures reach the “${key}” refusal`);
});
