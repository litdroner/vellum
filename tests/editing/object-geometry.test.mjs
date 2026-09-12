// Vellum 0.5.0 Phase 2: object geometry in PDF user space (editing/objects/geometry.js).
//
// The point of these tests is that geometry is done in the page's OWN space, on the object's own
// oriented quad — not on an axis-aligned box, and never on screen. So they check the quad solve
// against the formula Edit mode already used for text, then push it through the cases a box test
// gets wrong: a turned image, a mirrored one, a sheared one, and one with no area at all.
// Run: node --test "tests/editing/*.test.mjs"

import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { analyzeFile, engine } from './harness.mjs';
import { makeFixtures, FIXTURE_DIR } from './fixtures.mjs';

const { quadContains, quadArea, objectContains, handlePoints, hitTest } = await engine('objects/geometry.js');
const { pageObjects } = await engine('objects/page-objects.js');

let files;
const cache = new Map();
before(async () => { files = await makeFixtures(FIXTURE_DIR); });
const read = (name) => new Uint8Array(fs.readFileSync(files[name]));

async function analyzed(name) {
  if (!cache.has(name)) cache.set(name, await analyzeFile(read(name)));
  return cache.get(name);
}

/** A quad from a matrix applied to the unit square, exactly as the interpreter builds an image's. */
const unitQuad = (m) => {
  const at = (x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
  return [...at(0, 0), ...at(1, 0), ...at(1, 1), ...at(0, 1)];
};

// ---- 1. the same answer Edit mode already gave for text ------------------------------------

/** The test exactly as ui/text-editor.js asked it before Phase 2: along and across the run. */
function runContainsAsBefore(run, [x, y], tol) {
  const { dir, up } = run.frame;
  const dx = x - run.origin[0];
  const dy = y - run.origin[1];
  const a = dx * dir[0] + dy * dir[1];
  const u = dx * up[0] + dy * up[1];
  const e = run.extent;
  return a >= e.minA - tol && a <= e.maxA + tol && u >= e.minU - tol && u <= e.maxU + tol;
}

const FIXTURES = ['simple', 'columns', 'fonts', 'constructs', 'objects', 'cropbox', 'composite'];

/** Is the run's frame orthonormal — the case in which the two tests are the same mathematics? */
const upright = (run) => Math.abs(run.frame.dir[0] * run.frame.up[0] + run.frame.dir[1] * run.frame.up[1]) < 1e-9;

test('the quad solve agrees with the old run test, for every upright run in every fixture', async () => {
  let runs = 0;
  let probes = 0;
  let inside = 0;
  for (const name of FIXTURES) {
    for (const page of (await analyzed(name)).pages) {
      for (const run of page.runs) {
        // Skewed frames and zero-area runs are where the two deliberately differ; the next two
        // tests are about exactly those, and say which answer is the right one.
        if (!upright(run) || quadArea(run.quad) === 0) continue;
        runs++;
        const [x1, y1, x2, y2] = run.box;
        // Probe a grid over the run's bounding box, stretched well past every edge, so the points
        // that separate the two tests — inside the box but outside a turned quad — are included.
        const w = Math.max(x2 - x1, 1);
        const h = Math.max(y2 - y1, 1);
        for (let i = -2; i <= 12; i++) {
          for (let j = -2; j <= 12; j++) {
            const point = [x1 + (w * i) / 10, y1 + (h * j) / 10];
            for (const tol of [0, 0.75]) {
              probes++;
              const before = runContainsAsBefore(run, point, tol);
              const now = quadContains(run.quad, point, tol);
              if (before) inside++;
              assert.equal(now, before, `${name}: ${run.text} at ${point} tol ${tol}`);
            }
          }
        }
      }
    }
  }
  assert.ok(runs > 30, `only ${runs} runs compared`);
  assert.ok(inside > 0 && inside < probes, 'the probes must land both inside and outside');
});

test('on skewed text the quad solve is exact where the old run test was not', async () => {
  const page = (await analyzed('constructs')).pages.find((p) => p.runs.some((r) => !upright(r)));
  const run = page.runs.find((r) => !upright(r));
  assert.ok(run, 'the fixture draws skewed text');
  assert.ok(run.reasons.has('skewed'), 'which the engine already refuses to edit, for that reason');

  // placeRun() builds the quad as origin + dir·a + up·u. Solving in that basis inverts it exactly;
  // projecting with dot products only inverts it when dir and up are at right angles, and here
  // they are not — so the old test rejected points that are genuinely on the run, its own corners
  // among them.
  const corner = [run.quad[0], run.quad[1]];
  assert.equal(quadContains(run.quad, corner, 0), true, 'a corner of the quad is on the run');
  assert.equal(runContainsAsBefore(run, corner, 0), false, 'the old test said it was not');

  // Every corner and the centre are inside, as they must be for any quad.
  for (let i = 0; i < 8; i += 2) assert.equal(quadContains(run.quad, [run.quad[i], run.quad[i + 1]], 1e-9), true, `corner ${i / 2}`);
  const centre = [(run.quad[0] + run.quad[4]) / 2, (run.quad[1] + run.quad[5]) / 2];
  assert.equal(quadContains(run.quad, centre, 0), true, 'the centre is inside');
});

test('a run with no size cannot be clicked, where the old test would have accepted its baseline', async () => {
  const run = (await analyzed('constructs')).pages
    .flatMap((p) => p.runs).find((r) => quadArea(r.quad) === 0 && r.extent.maxA > r.extent.minA);
  assert.ok(run, 'the fixture draws text at zero size');
  const onBaseline = [(run.quad[0] + run.quad[2]) / 2, run.quad[1]];
  assert.equal(runContainsAsBefore(run, onBaseline, 0), true, 'the old test accepted its baseline');
  assert.equal(quadContains(run.quad, onBaseline, 0), false, 'a shape with no area has nothing to hit');
});

// ---- 2. an oriented box is not a bounding box ----------------------------------------------

test('a rotated quad refuses the bounding box corners', () => {
  // A square turned 45°: its bounding box corners are as far outside it as a test can get.
  const s = Math.SQRT1_2 * 20;
  const quad = unitQuad([s, s, -s, s, 100, 100]);
  const xs = [quad[0], quad[2], quad[4], quad[6]];
  const ys = [quad[1], quad[3], quad[5], quad[7]];
  const corner = [Math.min(...xs), Math.min(...ys)];
  assert.equal(quadContains(quad, [100 + s, 100 + s], 0), true, 'the middle is inside');
  assert.equal(quadContains(quad, corner, 0), false, 'the bounding box corner is not');
  // …and no tolerance worth the name lets it in: the corner is about 14 points away.
  assert.equal(quadContains(quad, corner, 2), false);
  assert.equal(quadContains(quad, corner, 20), true, 'a tolerance that large would, and says so');
});

test('a turned image from a real page is hit on its own quad', async () => {
  const page = (await analyzed('objects')).pages[0];
  // 'q 0 60 -40 0 300 650 cm /Im1 Do Q' — the unit square turned a quarter turn.
  const turned = pageObjects(page).find((o) => o.kind === 'image' && o.record.ctm[0] === 0 && o.record.ctm[1] === 60);
  assert.ok(turned, 'the fixture draws a quarter-turned image');
  const quad = turned.geometry.quad;
  const centre = [(quad[0] + quad[4]) / 2, (quad[1] + quad[5]) / 2];
  assert.equal(quadContains(quad, centre, 0), true);
  const [bx1, by1] = turned.geometry.box;
  assert.equal(quadContains(quad, [bx1 - 1, by1 - 1], 0), false, 'outside the box is outside the quad');
  // The turn is a real one: the quad's first edge runs up the page, not across it.
  assert.equal(Math.round(quad[2] - quad[0]), 0, 'the bottom edge has no horizontal extent');
  assert.equal(Math.round(quad[3] - quad[1]), 60);
});

test('mirrored and sheared quads are solved exactly, not approximated', () => {
  const mirrored = unitQuad([-30, 0, 0, 20, 200, 100]); // negative x scale: ll and lr swap sides
  assert.equal(quadContains(mirrored, [185, 110], 0), true);
  assert.equal(quadContains(mirrored, [215, 110], 0), false);
  assert.ok(quadArea(mirrored) > 0, 'area is unsigned, so a mirror still has one');

  const sheared = unitQuad([40, 0, 25, 30, 100, 100]); // a parallelogram leaning right
  assert.equal(quadContains(sheared, [120, 105], 0), true, 'inside, low and left');
  assert.equal(quadContains(sheared, [120, 125], 0), false, 'directly above it, outside the lean');
  assert.equal(quadContains(sheared, [145, 125], 0), true, 'the same height, along the lean');
});

test('tolerance is real distance, even on a sheared quad', () => {
  const sheared = unitQuad([40, 0, 25, 30, 100, 100]);
  // Straight down from the bottom edge: the distance is exactly what the tolerance must measure.
  assert.equal(quadContains(sheared, [120, 99], 0), false);
  assert.equal(quadContains(sheared, [120, 99], 0.5), false);
  assert.equal(quadContains(sheared, [120, 99], 1.5), true);
  assert.equal(quadContains(sheared, [120, 97], 1.5), false, 'three points away, with 1.5 of slack');
});

test('a quad with no area is never hit, and never widens to its box', () => {
  const flat = unitQuad([50, 0, 0, 0, 100, 100]); // zero height
  assert.equal(quadArea(flat), 0);
  for (const tol of [0, 5, 1000]) assert.equal(quadContains(flat, [125, 100], tol), false, `tol ${tol}`);
  assert.equal(quadContains(null, [0, 0], 5), false);
  assert.equal(quadContains([1, 2, 3], [0, 0], 5), false, 'a short quad is not a quad');
  assert.equal(quadContains(unitQuad([1, 0, 0, 1, 0, 0]), [NaN, 0], 1), false);
});

test('objectContains reads the analysis own quad and re-measures nothing', async () => {
  const page = (await analyzed('objects')).pages[0];
  const image = pageObjects(page).find((o) => o.kind === 'image');
  const quad = image.geometry.quad;
  const centre = [(quad[0] + quad[4]) / 2, (quad[1] + quad[5]) / 2];
  assert.equal(objectContains(image, centre, 0), quadContains(quad, centre, 0));
  assert.equal(objectContains(image, centre, 0), true);
  // A path has no quad, so it is never contained — its bounding box is not a stand-in.
  const path = pageObjects(page).find((o) => o.kind === 'path');
  assert.ok(path && path.geometry.box, 'a painted path has a box');
  assert.equal(objectContains(path, [path.geometry.box[0] + 1, path.geometry.box[1] + 1], 0), false);
});

// ---- 3. handle geometry: computed and tested, drawn by nothing --------------------------------

test('handle points follow the object own frame, not a bounding box', () => {
  const quad = unitQuad([40, 0, 0, 20, 100, 100]); // upright: 40 × 20 at (100, 100)
  const points = handlePoints(quad);
  assert.equal(points.length, 8, 'four corners and four edge midpoints');
  assert.deepEqual(points.slice(0, 4), [[100, 100], [140, 100], [140, 120], [100, 120]]);
  assert.deepEqual(points.slice(4), [[120, 100], [140, 110], [120, 120], [100, 110]], 'bottom, right, top, left');
});

test('handle points turn, mirror and shear with the quad', () => {
  const turned = handlePoints(unitQuad([0, 40, -20, 0, 100, 100])); // a quarter turn
  const [ll, lr, ur, ul, bottom, right, top, left] = turned;
  const mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  assert.deepEqual(bottom, mid(ll, lr));
  assert.deepEqual(right, mid(lr, ur));
  assert.deepEqual(top, mid(ur, ul));
  assert.deepEqual(left, mid(ul, ll));

  const sheared = handlePoints(unitQuad([40, 0, 25, 30, 0, 0]));
  assert.deepEqual(sheared[3], [25, 30], 'the upper-left corner leans with the shear');
  assert.deepEqual(sheared[6], [45, 30], 'and so does the midpoint of the top edge');

  assert.equal(handlePoints(null), null);
  assert.equal(handlePoints([1, 2]), null);
});

test('nothing in the app draws a handle yet', () => {
  // Phase 2 computes handle geometry and stops there: no verb can honour a drag, so no handle is
  // offered. If this ever fails, either Phase 3 has landed or something is promising a feature.
  const js = new URL('../../src/Vellum/web/js/', import.meta.url);
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const at = new URL(`${e.name}${e.isDirectory() ? '/' : ''}`, dir);
    return e.isDirectory() ? walk(at) : e.name.endsWith('.js') ? [at] : [];
  });
  const users = walk(js).filter((f) => /\bhandlePoints\b/.test(fs.readFileSync(f, 'utf8')));
  assert.deepEqual(users.map((u) => u.pathname.split('/').pop()), ['geometry.js'],
    'handlePoints is defined, tested, and called by no part of the UI');
});

// ---- 4. hit-testing: drawing order decides --------------------------------------------------

test('the topmost object wins, whatever its size', () => {
  const object = (order, quad) => ({ kind: 'image', order, geometry: { quad } });
  const big = object([1], unitQuad([200, 0, 0, 200, 0, 0]));
  const small = object([0], unitQuad([20, 0, 0, 20, 50, 50]));
  // Drawing order: the small one first, the big one over it. The big one is what you see.
  assert.equal(hitTest([small, big], [55, 55], 0), big);
  // Reverse the order and the small one is on top there.
  const smallOnTop = object([2], unitQuad([20, 0, 0, 20, 50, 50]));
  assert.equal(hitTest([big, smallOnTop], [55, 55], 0), smallOnTop);
});

test('objects that tie on drawing order are separated by size', () => {
  // One TJ operator holding two columns gives two runs the same order path.
  const object = (order, quad) => ({ kind: 'text-run', order, geometry: { quad } });
  const outer = object([7], unitQuad([100, 0, 0, 100, 0, 0]));
  const inner = object([7], unitQuad([10, 0, 0, 10, 20, 20]));
  assert.equal(hitTest([outer, inner], [25, 25], 0), inner, 'the smaller of the tie');
  assert.equal(hitTest([inner, outer], [25, 25], 0), inner, 'whichever way round they are listed');
  assert.equal(hitTest([outer, inner], [80, 80], 0), outer, 'outside the inner one, the outer wins');
});

test('a miss is null, and an empty page has nothing to hit', () => {
  const object = { kind: 'image', order: [0], geometry: { quad: unitQuad([10, 0, 0, 10, 0, 0]) } };
  assert.equal(hitTest([], [5, 5], 0), null);
  assert.equal(hitTest([object], [50, 50], 0), null);
  assert.equal(hitTest([object], [10.5, 5], 0), null);
  assert.equal(hitTest([object], [10.5, 5], 1), object, 'within tolerance it is a hit');
});

test('drawing order comes from the order path, so nesting sorts where the form is drawn', async () => {
  const page = (await analyzed('objects')).pages[0];
  const nested = pageObjects(page).find((o) => o.kind === 'image' && o.ref.stream !== 'page');
  assert.ok(nested, 'the fixture draws an image inside /Fm1');
  assert.ok(nested.order.length > 1, `a nested object has a path, not an index: ${nested.order}`);
  // Its own operator index inside the form is small; that alone would sort it near the front of
  // the page, ahead of everything the page draws after it.
  assert.ok(nested.order[0] > nested.ref.opIndex, 'it sorts where the form that draws it is drawn');
});
