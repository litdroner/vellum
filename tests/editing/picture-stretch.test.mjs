// Vellum 0.5.0: stretching a picture — resizing it non-proportionally, along its own axes.
//
// The last must-have of the image list ("move, resize, rotate 90°, flip and delete"): 0.4.1 shipped
// "resize" as a uniform scale. A stretch is a builder in the picture's OWN axes (transform.js
// stretch()), a verb of its own in the capability model that is true for pictures and never for
// text, and a gesture the session and the image writer already know how to store and write — the
// `cm` patch can hold any affine transform. What is pinned here: the geometry is exact whatever the
// picture's placement, the verb is offered only where it can be written, and the saved file has the
// picture exactly where the stretch put it.
// Run: node --test "tests/editing/*.test.mjs"

import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { analyzeFile, engine, webModule, withSession } from './harness.mjs';
import { makeFixtures, FIXTURE_DIR } from './fixtures.mjs';

const { stretch } = await engine('objects/transform.js');
const { quadBasis } = await engine('objects/geometry.js');
const { objectsOf } = await engine('objects/page-objects.js');
const { planImageEdit } = await engine('objects/image.js');
const { refusalMessage } = await engine('objects/capabilities.js');
const { REASONS } = await engine('runs.js');
const { apply, multiply } = await engine('matrix.js');
const { composeDocument } = await webModule('annotations/persist.js');
const { identityPlan } = await webModule('pages/plan.js');

let files;
before(async () => { files = await makeFixtures(FIXTURE_DIR); });
const read = (name) => new Uint8Array(fs.readFileSync(files[name]));

const CORNERS = [[0, 0], [1, 0], [1, 1], [0, 1]];
const cornersOf = (m) => CORNERS.map(([x, y]) => apply(m, x, y));
const near = (a, b, tol = 1e-6) => a.every((v, i) => Math.abs(v - b[i]) <= tol);
const cornersNear = (got, want, tol = 1e-6) => got.every((p, i) => near(p, want[i], tol));
const length = (a, b) => Math.hypot(b[0] - a[0], b[1] - a[1]);

// ---- 1. the builder ------------------------------------------------------------------------------

test('stretched along its own width, a picture keeps its fixed edge and its height', () => {
  const basis = [100, 0, 0, 50, 72, 650]; // 100 × 50 at (72, 650)
  const [ll, lr, ur, ul] = cornersOf(multiply(basis, stretch(basis, 'x', 1.5, 0)));
  assert.ok(near(ll, [72, 650]) && near(ul, [72, 700]), 'the left edge does not move');
  assert.ok(near(lr, [222, 650]) && near(ur, [222, 700]), 'the right edge moves out by half the width');
  const [, lr2, , ul2] = cornersOf(multiply(basis, stretch(basis, 'x', 0.5, 1)));
  assert.ok(near(lr2, [172, 650]), 'fixed at the other edge, the right edge stays');
  assert.ok(near(ul2, [122, 700]), 'and the left edge comes in');
  const [ll3, lr3, ur3] = cornersOf(multiply(basis, stretch(basis, 'y', 2, 1)));
  assert.ok(near(ur3, [172, 700]), 'stretched in height from the top edge, the top stays');
  assert.ok(near(ll3, [72, 600]) && near(lr3, [172, 600]), 'and the bottom goes down by the height');
});

test('a turned, mirrored or sheared picture stretches along its own axes, not the page’s', () => {
  // Turned a quarter: its own width runs up the page (the objects fixture draws one like this).
  const turned = [0, 60, -40, 0, 300, 650];
  let before = cornersOf(turned);
  let after = cornersOf(multiply(turned, stretch(turned, 'x', 2, 0)));
  assert.ok(near(after[0], before[0]) && near(after[3], before[3]), 'its fixed edge is where it was');
  assert.ok(Math.abs(length(after[0], after[1]) - 2 * length(before[0], before[1])) < 1e-9, 'its own width doubles');
  assert.ok(Math.abs(length(after[0], after[3]) - length(before[0], before[3])) < 1e-9, 'its own height does not change');
  assert.ok(Math.abs(after[1][0] - before[1][0]) < 1e-9 && after[1][1] > before[1][1], 'and on the page that is upwards');

  const mirrored = [-100, 0, 0, 50, 172, 650];
  before = cornersOf(mirrored);
  after = cornersOf(multiply(mirrored, stretch(mirrored, 'x', 3, 0)));
  assert.ok(near(after[0], before[0]), 'a mirrored picture keeps its own x = 0 edge');
  assert.ok(near(after[1], [172 - 300, 650]), 'and grows in its own (leftward) direction');

  const sheared = [80, 10, 20, 60, 100, 100];
  before = cornersOf(sheared);
  after = cornersOf(multiply(sheared, stretch(sheared, 'y', 1.25, 0)));
  assert.ok(near(after[0], before[0]) && near(after[1], before[1]), 'a sheared picture keeps its bottom edge');
  assert.ok(near(after[3], [100 + 20 * 1.25, 100 + 60 * 1.25]), 'and its sides lengthen along themselves');
});

test('nothing that is not a stretch is built', () => {
  const basis = [100, 0, 0, 50, 72, 650];
  for (const factor of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) assert.equal(stretch(basis, 'x', factor, 0), null, `factor ${factor}`);
  assert.equal(stretch(basis, 'z', 2, 0), null, 'an axis that isn’t one');
  assert.equal(stretch(basis, 'x', 2, 0.5), null, 'an edge that isn’t one');
  assert.equal(stretch([0, 0, 0, 0, 1, 1], 'x', 2, 0), null, 'a collapsed basis');
  assert.equal(stretch([1, 2, 3], 'x', 2, 0), null, 'a basis that isn’t a transform');
  assert.deepEqual(stretch(basis, 'x', 1, 0).map((v) => Math.round(v * 1e9) / 1e9), [1, 0, 0, 1, 0, 0], 'a factor of one is the identity');
});

test('a picture’s quad gives back its placement, so the basis is read from what is drawn', async () => {
  const analysis = (await analyzeFile(read('objects'))).pages[0];
  let checked = 0;
  for (const o of objectsOf(analysis).filter((x) => x.kind === 'image')) {
    const basis = quadBasis(o.geometry.quad);
    if (!basis) continue;
    assert.ok(near(basis, o.record.ctm, 1e-9), `${o.ref.key}: ${basis} vs ${o.record.ctm}`);
    checked++;
  }
  assert.ok(checked >= 10, `${checked} pictures compared`);
  assert.equal(quadBasis([1, 1, 1, 1, 1, 1, 1, 1]), null, 'a quad with no area has no basis');
});

// ---- 2. the capability, the session, the file --------------------------------------------------------

test('a picture may be stretched exactly when it may be moved; text never may', async () => {
  for (const name of ['objects', 'images', 'overlap', 'gallery', 'scanned', 'constructs']) {
    for (const analysis of (await analyzeFile(read(name))).pages) {
      for (const o of objectsOf(analysis)) {
        if (o.kind === 'image') assert.equal(o.capabilities.stretch, o.capabilities.move, `${name} ${o.ref.key}`);
        else assert.notEqual(o.capabilities.stretch, true, `${name} ${o.ref.key}: ${o.kind} cannot be stretched`);
        if (o.kind === 'text-run' && o.capabilities.move === true) assert.equal(o.capabilities.stretch, 'unsupported', `${name} ${o.ref.key}`);
      }
    }
  }
  assert.equal(refusalMessage('stretch', 'unsupported', 2), `Not all of the selected objects can be stretched. ${REASONS.unsupported}`);
});

test('the session stretches a picture as one record and one undo step, and refuses text in the one vocabulary', async () => {
  await withSession(read('images'), async ({ store, session }) => {
    const { objects } = await session.objects(1);
    const picture = objects.find((o) => o.kind === 'image');
    const text = objects.find((o) => o.kind === 'text-run');
    const basis = quadBasis(picture.geometry.quad);
    const delta = stretch(basis, 'x', 1.4, 0);
    assert.equal(await session.transformObject(1, picture.ref.key, delta, { verb: 'stretch' }), true);
    assert.equal(store.edits.length, 1);
    assert.ok(near(store.edits[0].transform, delta, 1e-4), 'the record holds the stretch, to the writer’s four decimals');
    const textStretch = stretch(quadBasis(text.geometry.quad), 'x', 1.4, 0);
    await assert.rejects(session.transformObject(1, text.ref.key, textStretch, { verb: 'stretch' }),
      (err) => err.kind === 'not-editable' && err.detail.reason === 'unsupported');
    await assert.rejects(session.transformObjects(1, [{ key: picture.ref.key, delta }, { key: text.ref.key, delta: textStretch }], { verb: 'stretch' }),
      (err) => /can be stretched/.test(err.message));
    // A text record that somehow carried a stretch is refused by the planner too, whatever the verb.
    await assert.rejects(session.transformObject(1, text.ref.key, textStretch, { verb: 'scale' }),
      (err) => err.kind === 'not-editable' && err.detail.reason === 'unsupported');
    assert.equal(store.edits.length, 1, 'and nothing was written for the text');
    assert.equal(store.undo(), true);
    assert.deepEqual([store.edits.length, store.canUndo], [0, false], 'the stretch was one undo step');
  });
});

test('the saved file has the stretched picture exactly there, and it can be changed again from there', async () => {
  const bytes = read('objects');
  const analysis = (await analyzeFile(bytes)).pages[0];
  const plan = identityPlan(1);
  const pictures = objectsOf(analysis).filter((o) => o.kind === 'image' && o.capabilities.stretch === true);
  const upright = pictures[0]; // 100 × 50
  const turned = pictures[1]; // turned a quarter
  const edits = [
    planImageEdit({ object: upright, transform: stretch(upright.record.ctm, 'y', 0.5, 1), entry: plan[0].id }),
    planImageEdit({ object: turned, transform: stretch(turned.record.ctm, 'x', 1.5, 0), entry: plan[0].id }),
  ];
  const saved = await composeDocument({ base: bytes, plan, edits });
  const again = objectsOf((await analyzeFile(saved)).pages[0]).filter((o) => o.kind === 'image');
  const found = again.map((o) => cornersOf(o.record.ctm));
  for (const [object, record] of [[upright, edits[0]], [turned, edits[1]]]) {
    const want = cornersOf(multiply(object.record.ctm, record.transform));
    assert.ok(found.some((c) => cornersNear(c, want, 0.02)), `${object.ref.key} is where the stretch put it`);
  }
  const moved = again.find((o) => cornersNear(cornersOf(o.record.ctm), cornersOf(multiply(upright.record.ctm, edits[0].transform)), 0.02));
  assert.deepEqual([moved.capabilities.move, moved.capabilities.stretch], [true, true], 'and can be moved and stretched again');
  const [ll, lr, , ul] = cornersOf(moved.record.ctm);
  assert.ok(Math.abs(length(ll, lr) - 100) < 0.02 && Math.abs(length(ll, ul) - 25) < 0.02, 'half its height, all of its width');
});
