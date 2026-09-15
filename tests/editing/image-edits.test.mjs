// Vellum 0.5.0 Phase 3, Step 2: the image handler (editing/objects/image.js) and the `image` edit
// kind it registers. Moving, scaling, turning, flipping and deleting a picture that is already on a
// page, written into real PDFs through composeDocument exactly as a text edit is.
//
// Nothing in the app can make one of these records yet: capabilities still refuse every verb
// (Step 4) and there is no interaction (Steps 5–6). These tests are the only caller, and they build
// records through planImageEdit, the same way the session will.
// Run: node --test "tests/editing/*.test.mjs"

import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { analyzeFile, engine, loadPdfLib, webModule } from './harness.mjs';
import { makeFixtures, FIXTURE_DIR } from './fixtures.mjs';

const { openSource } = await engine('source.js');
const { EditError, planTextEdit } = await engine('edits.js');
const { planImageEdit, imageRefusal } = await engine('objects/image.js');
const { handlerFor, writableKinds } = await engine('objects/registry.js');
const { objectsOf } = await engine('objects/page-objects.js');
const { multiply, apply } = await engine('matrix.js');
const { scaleAbout, quarterTurn, flip } = await engine('objects/transform.js');
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

/** The images of one page, as the object model names them, in drawing order. */
const imagesOf = (d, page = 0) => objectsOf(d.result.pages[page]).filter((o) => o.kind === 'image');

/** One page's decoded content stream. */
async function contentOf(bytes, pageIndex = 0) {
  const lib = await loadPdfLib();
  const doc = await lib.PDFDocument.load(bytes, { updateMetadata: false });
  const source = await openSource(lib, bytes);
  return Buffer.from(source.contentBytes(doc.getPages()[pageIndex].node)).toString('latin1');
}

/** A page's /XObject resource names in a saved file. */
async function xobjectNames(bytes, pageIndex = 0) {
  const lib = await loadPdfLib();
  const doc = await lib.PDFDocument.load(bytes, { updateMetadata: false });
  const resources = doc.getPages()[pageIndex].node.Resources();
  const xobjects = resources?.lookup(lib.PDFName.of('XObject'));
  return xobjects instanceof lib.PDFDict ? xobjects.keys().map((k) => k.asString().replace('/', '')).sort() : [];
}

/** Where an image's four corners end up in a composed file, found by its place in drawing order. */
async function cornersAfter(saved, which = 0, page = 0) {
  const image = objectsOf((await analyzeFile(saved)).pages[page]).filter((o) => o.kind === 'image')[which];
  return image ? [[0, 0], [1, 0], [1, 1], [0, 1]].map(([x, y]) => apply(image.record.ctm, x, y)) : null;
}

const CORNERS = [[0, 0], [1, 0], [1, 1], [0, 1]];
const round = (v, places = 3) => Math.round(v * 10 ** places) / 10 ** places;
const roundAll = (points) => points.map((p) => p.map((v) => round(v)));

/**
 * How far a corner may land from where it was asked to, in points. The transform is written in the
 * picture's OWN units, where 1 is its whole width, and the content-stream writer keeps four
 * decimals — so the error is the picture's size divided by ten thousand. The fixtures' pictures are
 * at most a few hundred points across, which is well inside this. Pinned in its own test below.
 */
const PLACEMENT_TOLERANCE = 0.02;

/** Where transforming the object's own placement by T says its corners should land. */
const expectedCorners = (object, T) => CORNERS.map(([x, y]) => apply(multiply(object.record.ctm, T), x, y));

function assertCorners(got, want, what, tol = PLACEMENT_TOLERANCE) {
  assert.ok(got, `${what}: no picture came back`);
  assert.equal(got.length, want.length, `${what}: corner count`);
  got.forEach((p, i) => {
    const off = Math.hypot(p[0] - want[i][0], p[1] - want[i][1]);
    assert.ok(off <= tol, `${what}: corner ${i} is ${round(off, 5)} pt out — ${JSON.stringify(roundAll(got))} vs ${JSON.stringify(roundAll(want))}`);
  });
}

/** Plans a transform for one image of a page, through the planner the session will use. */
function planFor(d, object, transform, { removed = false, page = 0 } = {}) {
  return planImageEdit({ object, transform, removed, entry: d.plan[page].id });
}

const countOf = (haystack, needle) => haystack.split(needle).length - 1;

// ---- 1. the kind is registered, and the record says what was approved -------------------------

test('the image kind is registered, so the page writer no longer refuses it', async () => {
  assert.deepEqual(writableKinds().sort(), ['image', 'image-copy', 'inserted-image', 'text', 'text-copy'], 'five kinds are writable now (inserted pictures since 0.5.0, pasted copies since 0.6)');
  const handler = handlerFor('image');
  assert.ok(handler, 'a handler claims it');
  assert.equal(handler.kind, 'image');
  assert.equal(typeof handler.write, 'function');
  assert.equal(handlerFor('image-move'), null, 'and an unknown kind is still unclaimed');
});

test('an image record carries exactly the approved target facts', async () => {
  const d = await open('images');
  const [first] = imagesOf(d);
  const record = planFor(d, first, [1, 0, 0, 1, 10, -5]);
  assert.deepEqual(Object.keys(record).sort(), ['entry', 'id', 'kind', 'removed', 'target', 'transform']);
  assert.deepEqual(Object.keys(record.target).sort(), ['ctm', 'height', 'inline', 'key', 'name', 'opIndex', 'stream', 'width']);
  assert.equal(record.kind, 'image');
  assert.equal(record.target.key, 'image:page#2', 'identity is where it is drawn');
  assert.deepEqual([record.target.stream, record.target.opIndex], ['page', 2]);
  assert.deepEqual([record.target.name, record.target.inline], ['Im1', false], 'the resource name is a fingerprint, not identity');
  assert.deepEqual(record.target.ctm, [200, 0, 0, 150, 72, 500]);
  assert.deepEqual([record.target.width, record.target.height], [32, 32]);
  assert.deepEqual(record.transform, [1, 0, 0, 1, 10, -5]);
  assert.equal(record.removed, false);
});

test('two draws of one resource are two records, told apart by where they are drawn', async () => {
  const d = await open('images');
  const [first, second] = imagesOf(d);
  const a = planFor(d, first, [1, 0, 0, 1, 5, 0]);
  const b = planFor(d, second, [1, 0, 0, 1, 5, 0]);
  assert.equal(a.target.name, b.target.name, 'the same resource');
  assert.notEqual(a.target.key, b.target.key, 'but not the same object');
  assert.deepEqual([a.target.opIndex, b.target.opIndex], [2, 11]);
});

test('a transform is kept to what the writer can hold, and the identity is a record that does nothing', async () => {
  const d = await open('images');
  const [first] = imagesOf(d);
  assert.deepEqual(planFor(d, first, [1, 0, 0, 1, 10.000049, -0.000001]).transform, [1, 0, 0, 1, 10, 0]);
  assert.deepEqual(planFor(d, first, null).transform, [1, 0, 0, 1, 0, 0], 'no transform plans the identity');
  const saved = await compose(d, [planFor(d, first, null)]);
  // The page still goes through the writer — having a record for it is what decides that, and that
  // is the page writer's own behaviour — but the record contributes no patch, so nothing is wrapped.
  const content = await contentOf(saved);
  assert.equal(countOf(content, 'q 200 0 0 150 72 500 cm /Im1 Do Q'), 1, 'the draw is exactly as it was');
  assert.equal(countOf(content, 'q 100 0 0 100 400 600 cm /Im1 Do Q'), 1, 'and so is the other one');
  assert.equal(/cm q /.test(content), false, 'nothing was wrapped around either of them');
});

// ---- 2. the transforms, written into real files ------------------------------------------------
// Each one is checked where it counts: the picture's corners in the SAVED file are where composing
// its placement with the transform says they should be.

test('a moved image lands exactly where the transform says', async () => {
  const d = await open('images');
  const [first] = imagesOf(d);
  const T = [1, 0, 0, 1, 25, -40];
  const saved = await compose(d, [planFor(d, first, T)]);
  assertCorners(await cornersAfter(saved, 0), expectedCorners(first, T), 'the moved picture');
  assertCorners(await cornersAfter(saved, 1), expectedCorners(imagesOf(d)[1], [1, 0, 0, 1, 0, 0]), 'the other draw has not moved', 0);
});

test('a uniformly scaled image keeps its anchor and grows by the factor', async () => {
  const d = await open('images');
  const [first] = imagesOf(d);
  const anchor = apply(first.record.ctm, 0, 0); // the corner opposite a top-right drag
  const T = scaleAbout(anchor, 1.5);
  const saved = await compose(d, [planFor(d, first, T)]);
  const corners = await cornersAfter(saved, 0);
  assertCorners(corners, expectedCorners(first, T), 'the scaled picture');
  assertCorners([corners[0]], [anchor], 'the anchor has not moved');
  const width = Math.hypot(corners[1][0] - corners[0][0], corners[1][1] - corners[0][1]);
  assert.ok(Math.abs(width - 200 * 1.5) <= PLACEMENT_TOLERANCE, `half again as wide: ${width}`);
});

test('an image turned a quarter turn swaps what it measures across the page', async () => {
  const d = await open('images');
  const [first] = imagesOf(d); // 200 across, 150 up
  const centre = apply(first.record.ctm, 0.5, 0.5);
  for (const turns of [1, -1]) {
    const T = quarterTurn(centre, turns);
    const saved = await compose(d, [planFor(d, first, T)]);
    const corners = await cornersAfter(saved, 0);
    assertCorners(corners, expectedCorners(first, T), `${turns} turn`);
    const xs = corners.map((p) => p[0]);
    const ys = corners.map((p) => p[1]);
    assert.ok(Math.abs((Math.max(...xs) - Math.min(...xs)) - 150) <= PLACEMENT_TOLERANCE, `${turns} turn: 150 across afterwards`);
    assert.ok(Math.abs((Math.max(...ys) - Math.min(...ys)) - 200) <= PLACEMENT_TOLERANCE, `${turns} turn: 200 up afterwards`);
  }
});

test('a flipped image is mirrored in its own axes, and flipping twice puts it back', async () => {
  const d = await open('images');
  const [first] = imagesOf(d);
  for (const axis of ['horizontal', 'vertical']) {
    const T = flip(first.record.ctm, axis);
    const saved = await compose(d, [planFor(d, first, T)]);
    const corners = await cornersAfter(saved, 0);
    assertCorners(corners, expectedCorners(first, T), axis);
    // The picture occupies exactly the same place on the page; only its content is turned over.
    const before = CORNERS.map(([x, y]) => apply(first.record.ctm, x, y));
    const box = (points) => [Math.min(...points.map((p) => p[0])), Math.min(...points.map((p) => p[1])),
      Math.max(...points.map((p) => p[0])), Math.max(...points.map((p) => p[1]))].map((v) => round(v));
    assert.deepEqual(box(corners), box(before), `${axis}: the same place on the page`);
    // And the handedness is reversed, which is what a mirror is.
    const det = (m) => m[0] * m[3] - m[1] * m[2];
    const after = multiply(first.record.ctm, T);
    assert.ok(det(after) * det(first.record.ctm) < 0, `${axis}: turned over`);
    assertCorners(await cornersAfter(await compose(d, [planFor(d, first, multiply(T, T))]), 0),
      before, `${axis}: flipped twice is unflipped`);
  }
});

test('a flip on a turned placement mirrors the picture, not the page', async () => {
  const d = await open('objects');
  const turned = imagesOf(d).find((o) => o.record.ctm[0] === 0 && o.record.ctm[1] === 60);
  assert.ok(turned, 'the objects fixture draws a rotated image');
  const T = flip(turned.record.ctm, 'horizontal');
  const saved = await compose(d, [planFor(d, turned, T)]);
  const which = imagesOf(d).indexOf(turned);
  assertCorners(await cornersAfter(saved, which), expectedCorners(turned, T), 'the turned picture');
  // Its own left and right edges run up the page here, so mirroring it moves points vertically.
  const ll = apply(turned.record.ctm, 0, 0);
  assert.ok(Math.abs(apply(T, ll[0], ll[1])[1] - ll[1]) > 1, 'the mirror runs up the page, not across it');
});

// ---- 3. in place: what the page did around the draw still happens -------------------------------

test('a transformed image stays exactly where it was in the drawing order', async () => {
  const d = await open('overlap');
  const images = imagesOf(d);
  const order = images.map((o) => o.ref.opIndex);
  assert.deepEqual(order, [2, 16, 20, 24], 'four draws, in this order');
  // Move the first one, which is drawn UNDER the text: it must still be drawn under the text.
  const saved = await compose(d, [planFor(d, images[0], [1, 0, 0, 1, 5, 5])]);
  const content = await contentOf(saved);
  const firstDraw = content.indexOf('/Im1 Do');
  const firstText = content.indexOf('(Over the picture)');
  assert.ok(firstDraw >= 0 && firstText >= 0 && firstDraw < firstText, 'the moved draw is still before the text that covers it');
  // And the object model, reading the saved file, still finds it first.
  const after = objectsOf((await analyzeFile(saved)).pages[0]);
  assert.deepEqual(after.filter((o) => o.kind === 'image' || o.kind === 'text-run').map((o) => o.kind),
    ['image', 'text-run', 'text-run', 'image', 'image', 'image'], 'the drawing order is unchanged');
});

test('the patch wraps the original operator and copies none of its bytes', async () => {
  const d = await open('images');
  const [first] = imagesOf(d);
  const saved = await compose(d, [planFor(d, first, [1, 0, 0, 1, 25, -40])]);
  const content = await contentOf(saved);
  // 25 points right and 40 down, in a picture 200 by 150: 25/200 and -40/150 in its own units.
  assert.match(content, /q 1 0 0 1 0\.125 -0\.2667 cm \/Im1 Do Q/, 'the wrap is q <local> cm <operator> Q');
  assert.equal(countOf(content, '/Im1 Do'), 2, 'both draws are still there, once each');
  assert.match(content, /q 200 0 0 150 72 500 cm q 1 0 0 1 0\.125 -0\.2667 cm \/Im1 Do Q Q/, 'inside the q … Q the page already had');
  assert.equal(content.includes('25 -40'), false, 'the page-space transform is never what is written');
});

test('the local transform is the conjugation, not the page-space one, when the placement is not the identity', async () => {
  const d = await open('objects');
  const turned = imagesOf(d).find((o) => o.record.ctm[0] === 0 && o.record.ctm[1] === 60);
  const T = [1, 0, 0, 1, 30, 0]; // 30 points to the right, in PAGE space
  const saved = await compose(d, [planFor(d, turned, T)]);
  const content = await contentOf(saved);
  assert.equal(content.includes('q 1 0 0 1 30 0 cm'), false, 'the page-space transform is not what is emitted');
  assert.match(content, /q 1 0 0 1 0 -0\.75 cm/, 'C · T · C⁻¹ is');
  // And it lands 30 points to the right on the page all the same.
  const which = imagesOf(d).indexOf(turned);
  assertCorners(await cornersAfter(saved, which), expectedCorners(turned, T), 'the turned picture');
});

test('an image’s ExtGState, marked content and stencil fill colour come through untouched', async () => {
  const d = await open('objects');
  const images = imagesOf(d);
  const half = images[3]; // drawn under /Half gs, at half opacity, with its own /SMask
  const stencil = images[2]; // a stencil mask, painted in the current fill colour
  const tagged = images[6]; // inside /Figure << /MCID 3 >> BDC … EMC
  const saved = await compose(d, [
    planFor(d, half, [1, 0, 0, 1, 3, 0]),
    planFor(d, stencil, [1, 0, 0, 1, 3, 0]),
    planFor(d, tagged, [1, 0, 0, 1, 3, 0]),
  ]);
  const content = await contentOf(saved);
  // 3 points right, in pictures 40 and 30 wide: 0.075 and 0.1 of their own width.
  assert.match(content, /\/Half gs 40 0 0 40 150 560 cm q 1 0 0 1 0\.075 0 cm \/Im2 Do Q/, 'the ExtGState still applies to the draw');
  assert.match(content, /0 0 1 rg 40 0 0 40 72 560 cm q 1 0 0 1 0\.075 0 cm \/Mask Do Q/, 'and the fill colour a stencil is painted with');
  assert.match(content, /\/Figure <<\/MCID 3>> BDC q 30 0 0 30 350 560 cm q 1 0 0 1 0\.1 0 cm \/Im1 Do Q Q EMC/, 'the wrap is inside the marked content, so the tag still covers it');
  // The analysis of the saved file agrees: the same transparency, the same tag.
  const after = objectsOf((await analyzeFile(saved)).pages[0]).filter((o) => o.kind === 'image');
  assert.deepEqual([after[3].record.ca, after[3].record.CA], [0.5, 0.5], 'still half-transparent');
  assert.equal(after[3].record.info.smask, true, 'still carrying its own soft mask');
  assert.equal(after[6].record.mcid, 3, 'still tagged');
  assert.equal(after[2].record.info.imageMask, true, 'still a stencil');
});

test('an inline image is wrapped without its raw data being touched', async () => {
  const d = await open('objects');
  const inline = imagesOf(d).find((o) => o.record.inline);
  const before = await contentOf(d.bytes);
  const saved = await compose(d, [planFor(d, inline, [1, 0, 0, 1, 12, 0])]);
  const content = await contentOf(saved);
  const block = /BI \/W 2 \/H 1 \/CS \/RGB \/BPC 8 ID ABCDEF EI/;
  assert.match(before, block, 'the fixture draws one');
  assert.match(content, block, 'and its bytes are unchanged');
  // 12 points right, in a picture 20 wide: 0.6 of its own width.
  assert.match(content, /q 1 0 0 1 0\.6 0 cm BI \/W 2 \/H 1 \/CS \/RGB \/BPC 8 ID ABCDEF EI Q/, 'wrapped whole');
  const after = objectsOf((await analyzeFile(saved)).pages[0]).filter((o) => o.kind === 'image').find((o) => o.record.inline);
  assert.deepEqual([after.record.info.width, after.record.info.height], [2, 1], 'and it still reads as the same image');
});

// ---- 4. deletion, and the conservative resource rule --------------------------------------------

test('deleting an image removes the draw and leaves the stream correct', async () => {
  const d = await open('images');
  const [first] = imagesOf(d);
  const saved = await compose(d, [planFor(d, first, null, { removed: true })]);
  const content = await contentOf(saved);
  assert.equal(countOf(content, '/Im1 Do'), 1, 'one draw is gone, the other is not');
  assert.match(content, /q 200 0 0 150 72 500 cm\s+Q/, 'what the page did around it still happens');
  const after = objectsOf((await analyzeFile(saved)).pages[0]).filter((o) => o.kind === 'image');
  assert.equal(after.length, 1, 'and the page now draws one picture');
  assert.deepEqual(after[0].record.ctm, [100, 0, 0, 100, 400, 600], 'the one that was kept');
});

test('a shared resource is kept while any other draw still uses it', async () => {
  const d = await open('images');
  const [first] = imagesOf(d);
  const saved = await compose(d, [planFor(d, first, null, { removed: true })]);
  assert.deepEqual(await xobjectNames(saved), ['Im1'], 'the second draw still needs it');
});

test('the last draw of a resource releases it, and its bytes go from the file', async () => {
  const d = await open('images');
  const images = imagesOf(d);
  const saved = await compose(d, images.map((o) => planFor(d, o, null, { removed: true })));
  assert.deepEqual(await xobjectNames(saved), [], 'nothing draws it any more, so the entry goes');
  assert.equal(countOf(await contentOf(saved), '/Im1 Do'), 0, 'and no draw is left');
  // The image data itself is collected, because nothing in the file reaches it now.
  assert.ok(saved.length < d.bytes.length, `the saved file is smaller: ${saved.length} vs ${d.bytes.length}`);
});

test('a page that draws a Form XObject keeps its resources, because a form may reach them', async () => {
  const d = await open('objects');
  // Every page-level draw of Im1 removed at once — but a form is drawn on this page, so the entry
  // stays rather than Vellum guessing what the form's content resolves through.
  const drawsOfIm1 = imagesOf(d).filter((o) => o.record.name === 'Im1' && o.ref.stream === 'page' && !imageRefusal(o.record, o.ref));
  assert.ok(drawsOfIm1.length >= 2, `${drawsOfIm1.length} removable draws of Im1`);
  const saved = await compose(d, drawsOfIm1.map((o) => planFor(d, o, null, { removed: true })));
  assert.ok((await xobjectNames(saved)).includes('Im1'), 'the resource entry is left alone');
});

test('deleting an inline image releases nothing, because it names nothing', async () => {
  const d = await open('objects');
  const inline = imagesOf(d).find((o) => o.record.inline);
  const before = await xobjectNames(d.bytes);
  const saved = await compose(d, [planFor(d, inline, null, { removed: true })]);
  assert.deepEqual(await xobjectNames(saved), before, 'the page’s resources are untouched');
  assert.equal(/BI \/W 2 \/H 1/.test(await contentOf(saved)), false, 'and the inline image is gone');
});

// ---- 5. refusals ---------------------------------------------------------------------------------

test('the approved refusals, each named in the one reason vocabulary', async () => {
  const d = await open('objects');
  const images = imagesOf(d);
  const reasonFor = (o) => imageRefusal(o.record, o.ref);
  assert.equal(reasonFor(images[0]), null, 'a plain image can be changed');
  assert.equal(reasonFor(images[3]), null, 'an image with its OWN /SMask is fine');
  assert.equal(reasonFor(images[4]), 'clipped', 'a clip that does not contain it');
  assert.equal(reasonFor(images[8]), 'layer', 'on a layer that can be switched off');
  assert.equal(reasonFor(images[9]), 'layer', 'the image’s own /OC');
  assert.equal(reasonFor(images[11]), 'form', 'drawn by a Form XObject');
  assert.equal(imageRefusal({ ...images[0].record, ctm: [0, 0, 0, 0, 10, 10] }, images[0].ref), 'degenerate', 'a placement with no area');
  assert.equal(imageRefusal({ ...images[0].record, ctm: [1, 2, 2, 4, 0, 0] }, images[0].ref), 'degenerate', 'collinear axes');
  assert.equal(imageRefusal(null, null), 'unsupported', 'and nothing is claimed about a non-image');
});

test('the planner refuses a refused image, in the words the reason already has', async () => {
  const d = await open('objects');
  const images = imagesOf(d);
  const { REASONS } = await engine('runs.js');
  for (const [which, reason] of [[4, 'clipped'], [8, 'layer'], [11, 'form']]) {
    assert.throws(() => planFor(d, images[which], [1, 0, 0, 1, 5, 0]), (err) => {
      assert.ok(err instanceof EditError, `image ${which}: ${err}`);
      assert.equal(err.kind, 'not-editable', `image ${which}: refusal kind`);
      assert.deepEqual(err.detail, { reason }, `image ${which}: the reason is named`);
      assert.equal(err.message, REASONS[reason], `image ${which}: and it is the sentence the reason already has`);
      return true;
    });
  }
  assert.throws(() => planImageEdit({ object: { kind: 'text-run' }, entry: d.plan[0].id }), EditError, 'and a text run is not an image');
});

test('a record whose picture has changed takes the whole save down with it', async () => {
  const d = await open('images');
  const [first] = imagesOf(d);
  const good = planFor(d, first, [1, 0, 0, 1, 10, 0]);
  const cases = [
    ['a different place', { ...good.target, ctm: [200, 0, 0, 150, 72, 501] }],
    ['a different resource', { ...good.target, name: 'Im9' }],
    ['a different size', { ...good.target, width: 33 }],
    ['no such operator', { ...good.target, opIndex: 99 }],
    ['another stream', { ...good.target, stream: 'Fm1_form' }],
  ];
  for (const [what, target] of cases) {
    await assert.rejects(() => compose(d, [{ ...good, target }]), (err) => {
      assert.ok(err instanceof EditError, `${what}: ${err}`);
      assert.equal(err.kind, 'changed', `${what}: refusal kind`);
      return true;
    }, what);
  }
  // Nothing partial: a good text edit sent alongside is refused too.
  const text = planTextEdit({
    run: d.result.pages[0].runs.find((r) => r.text === 'Caption under the picture'),
    text: 'Changed caption', entry: d.plan[0].id, glyphs: d.result.source.glyphs,
  });
  await assert.rejects(() => compose(d, [text, { ...good, target: { ...good.target, name: 'Im9' } }]), EditError);
});

test('the writer refuses a refused image even when a record for it exists', async () => {
  // Belt and braces: the planner refuses these, so this record is made by hand — what matters is
  // that the file cannot depend on the UI having asked the right question.
  const d = await open('objects');
  const clipped = imagesOf(d)[4];
  const byHand = {
    id: 'by-hand', kind: 'image', entry: d.plan[0].id, transform: [1, 0, 0, 1, 5, 0], removed: false,
    target: {
      key: clipped.ref.key, stream: clipped.ref.stream, opIndex: clipped.ref.opIndex,
      name: clipped.record.name, inline: clipped.record.inline, ctm: [...clipped.record.ctm],
      width: clipped.record.info?.width ?? null, height: clipped.record.info?.height ?? null,
    },
  };
  await assert.rejects(() => compose(d, [byHand]), (err) => {
    assert.equal(err.kind, 'not-editable');
    assert.deepEqual(err.detail, { reason: 'clipped' });
    return true;
  });
});

test('two records for one picture are refused rather than written twice', async () => {
  const d = await open('images');
  const [first] = imagesOf(d);
  const a = planFor(d, first, [1, 0, 0, 1, 10, 0]);
  const b = { ...planFor(d, first, [1, 0, 0, 1, 20, 0]), id: 'second' };
  await assert.rejects(() => compose(d, [a, b]), (err) => {
    assert.equal(err.kind, 'changed');
    assert.match(err.message, /same picture/);
    return true;
  });
});

// ---- 6. everything else about the file is left alone --------------------------------------------

test('only the edited page changes, and text edits on the same page still work beside images', async () => {
  const d = await open('images');
  const [first] = imagesOf(d);
  const text = planTextEdit({
    run: d.result.pages[0].runs.find((r) => r.text === 'Caption under the picture'),
    text: 'Changed caption', entry: d.plan[0].id, glyphs: d.result.source.glyphs,
  });
  const saved = await compose(d, [planFor(d, first, [1, 0, 0, 1, 25, -40]), text]);
  const content = await contentOf(saved);
  assert.match(content, /q 1 0 0 1 0\.125 -0\.2667 cm \/Im1 Do Q/, 'the picture moved');
  assert.match(content, /\[<[0-9a-f]+>\] TJ/, 'and the text was rewritten after the page');
  assert.equal(content.includes('(Caption under the picture)'), false, 'the old text is gone');
  const runs = (await analyzeFile(saved)).pages[0].runs.map((r) => r.text);
  assert.ok(runs.includes('Changed caption'), `runs: ${runs.join(' | ')}`);
});

test('composing the same image edits twice writes the same file', async () => {
  const d = await open('images');
  const [first] = imagesOf(d);
  const edits = [planFor(d, first, quarterTurn(apply(first.record.ctm, 0.5, 0.5), 1))];
  assert.deepEqual(Buffer.from(await compose(d, edits)), Buffer.from(await compose(d, edits)));
});

test('a moved image can be moved again after a save, from where it now is', async () => {
  const d = await open('images');
  const [first] = imagesOf(d);
  const once = await compose(d, [planFor(d, first, [1, 0, 0, 1, 25, 0])]);
  // Reopened, it is a fresh document with no records: the draw has a new operator index and the
  // transform is already baked into its placement.
  const reopened = { bytes: once, result: await analyzeFile(once), plan: identityPlan(1) };
  const [again] = objectsOf(reopened.result.pages[0]).filter((o) => o.kind === 'image');
  assert.deepEqual(again.record.ctm, [200, 0, 0, 150, 97, 500], 'the move is in the file now');
  assert.equal(imageRefusal(again.record, again.ref), null, 'and it can be moved again');
  const twice = await compose(reopened, [planImageEdit({ object: again, transform: [1, 0, 0, 1, 25, 0], entry: reopened.plan[0].id })]);
  const [final] = objectsOf((await analyzeFile(twice)).pages[0]).filter((o) => o.kind === 'image');
  assertCorners(CORNERS.map(([x, y]) => apply(final.record.ctm, x, y)),
    expectedCorners(first, [1, 0, 0, 1, 50, 0]), '50 points right in all');
});

test('the placement error the local transform costs is measured, and it is tiny', async () => {
  // The transform is written in the picture's own units, so four decimals there is the picture's
  // size over ten thousand in page space. This is the one price of patching in place rather than
  // redrawing, and it is worth knowing exactly rather than approximately.
  const d = await open('images');
  const [first] = imagesOf(d); // 200 by 150 points
  let worst = 0;
  for (const T of [[1, 0, 0, 1, 25, -40], [1, 0, 0, 1, 0.3333, 0.6667], scaleAbout(apply(first.record.ctm, 0, 0), 1.3333)]) {
    const corners = await cornersAfter(await compose(d, [planFor(d, first, T)]), 0);
    expectedCorners(first, T).forEach((want, i) => {
      worst = Math.max(worst, Math.hypot(corners[i][0] - want[0], corners[i][1] - want[1]));
    });
  }
  assert.ok(worst <= PLACEMENT_TOLERANCE, `worst corner error ${worst} pt`);
  assert.ok(worst < 0.011, `a hundredth of a point at most, on a picture 200 across: ${round(worst, 5)} pt`);
});
