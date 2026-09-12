// Vellum 0.5.0 Phase 3, Step 1: the affine algebra object manipulation is written with
// (editing/objects/transform.js). Nothing calls that module yet — this suite is its only caller —
// so nothing in the app behaves differently; these tests are what make Steps 2 and 3 able to rely
// on it. Run: node --test "tests/editing/*.test.mjs"
//
// Pure, like the module: no fixtures, no pdf.js, no document is opened. The CTMs used below are
// real ones, measured from the fixtures in phase3-baseline.test.mjs, which is where the conjugation
// is checked against actual files; here they are constants so this suite stays algebra.

import test from 'node:test';
import assert from 'node:assert/strict';
import { engine } from './harness.mjs';

const { IDENTITY, multiply, invert, apply, translate } = await engine('matrix.js');
const {
  isValid, determinant, quantize, sameTransform, isIdentity,
  scaleAbout, quarterTurn, flip, conjugate,
} = await engine('objects/transform.js');

/** Real placements, measured from the fixtures (see phase3-baseline.test.mjs §4). */
const CTMS = {
  plain: [200, 0, 0, 150, 72, 500], // images fixture, first draw
  square: [100, 0, 0, 100, 400, 600], // images fixture, second draw
  turned: [0, 60, -40, 0, 300, 650], // objects fixture, the 90°-rotated draw
  wide: [230, 0, 0, 100, 72, 480], // overlap fixture, the covering draw
  mirrored: [-120, 0, 0, 80, 300, 200], // a negative determinant: allowed, and must stay exact
  sheared: [100, 0, 30, 90, 50, 50], // nothing here may assume orthogonality
};
const ALL_CTMS = Object.entries(CTMS);

const TOL = 1e-9; // the module's own default: these are closed forms, not measurements
const LOOSE = 1e-6; // where a value has been through an inverse and back

const point = (m, [x, y]) => apply(m, x, y);
const closeTo = (got, want, tol = TOL) => Math.abs(got - want) <= tol;
const samePoint = (got, want, tol = TOL) => closeTo(got[0], want[0], tol) && closeTo(got[1], want[1], tol);

/** The unit square's corners, in the order a quad uses: ll, lr, ur, ul. */
const CORNERS = [[0, 0], [1, 0], [1, 1], [0, 1]];

function assertSame(got, want, what, tol = TOL) {
  assert.ok(got, `${what}: nothing came back`);
  assert.ok(sameTransform(got, want, tol), `${what}: ${JSON.stringify(got)} ≠ ${JSON.stringify(want)}`);
}

// ---- 1. identity and translation, as matrix.js already defines them ---------------------------
// transform.js deliberately wraps neither: composition, inversion, point application, the identity
// and translation are matrix.js's, used under their own names. These pin the SEMANTICS the builders
// below are written against, so a change to those conventions fails here rather than silently
// changing what a transform means.

test('the identity moves nothing, and isIdentity knows it from the smallest nudge', () => {
  assert.deepEqual([...IDENTITY], [1, 0, 0, 1, 0, 0]);
  for (const p of [[0, 0], [72, 500], [-13.5, 1e4]]) assert.ok(samePoint(point(IDENTITY, p), p), `${p}`);
  assert.equal(isIdentity(IDENTITY), true);
  assert.equal(isIdentity([...IDENTITY]), true, 'by value, not by reference');
  assert.equal(isIdentity(translate(0.0001, 0)), false, 'a nudge the writer can still hold is not the identity');
  assert.equal(isIdentity(translate(1e-12, 0)), true, 'and one it cannot is indistinguishable from it');
  assert.equal(isIdentity([1, 0, 0, 1, 0.5, 0], 1), true, 'the tolerance is the caller’s to widen');
});

test('translation moves a point by exactly its offset, and two translations add', () => {
  assert.ok(samePoint(point(translate(25, -40), [72, 500]), [97, 460]));
  assertSame(multiply(translate(25, -40), translate(-5, 10)), translate(20, -30), 'two translations');
  assert.ok(samePoint(point(translate(0, 0), [1, 2]), [1, 2]), 'a zero translation is the identity');
  assert.equal(isIdentity(multiply(translate(7, 3), invert(translate(7, 3)))), true, 'and one undoes the other');
});

test('multiply is "first, then second" — the order the builders are composed in', () => {
  // Translate then scale is not scale then translate, so a point tells the two apart.
  const move = translate(10, 0);
  const grow = [2, 0, 0, 2, 0, 0];
  assert.ok(samePoint(point(multiply(move, grow), [0, 0]), [20, 0]), 'moved by 10, then doubled');
  assert.ok(samePoint(point(multiply(grow, move), [0, 0]), [10, 0]), 'doubled, then moved by 10');
  // Which is the same as saying: applying m1 then m2 equals applying multiply(m1, m2) once.
  for (const [name, ctm] of ALL_CTMS) {
    for (const corner of CORNERS) {
      const stepwise = point(grow, point(ctm, corner));
      assert.ok(samePoint(point(multiply(ctm, grow), corner), stepwise, LOOSE), `${name} ${corner}`);
    }
  }
});

test('apply is the row-vector convention the whole engine uses', () => {
  const m = [2, 3, 5, 7, 11, 13];
  const [x, y] = [1.5, -2];
  assert.ok(samePoint(point(m, [x, y]), [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]));
});

// ---- 2. what a transform must be before it is stored or written --------------------------------

test('only six finite numbers are a transform', () => {
  assert.equal(isValid([1, 0, 0, 1, 0, 0]), true);
  for (const bad of [null, undefined, 'nope', [1, 0, 0, 1, 0], [1, 0, 0, 1, 0, 0, 0], [1, 0, 0, 1, 0, NaN],
    [1, 0, 0, 1, 0, Infinity], [1, 0, 0, 1, 0, -Infinity], [1, 0, 0, 1, 0, '0'], {}]) {
    assert.equal(isValid(bad), false, JSON.stringify(bad) ?? String(bad));
  }
});

test('a transform is kept to the four decimals the writer can hold, and never as a negative zero', () => {
  assert.deepEqual(quantize([1.000049, -0.00004, 0.5, 1, 72.123456, -0.000001]), [1, 0, 0.5, 1, 72.1235, 0]);
  assert.deepEqual(quantize([-0, -0, -0, -0, -0, -0]), [0, 0, 0, 0, 0, 0], 'num() refuses a negative zero, so this does too');
  assert.equal(quantize([1, 0, 0, 1, 0]), null, 'and an invalid transform quantizes to nothing');
  // A quantized transform still does what it did, to the precision the file keeps.
  const T = scaleAbout([172, 575], 1.333333333);
  for (const corner of CORNERS) {
    assert.ok(samePoint(point(quantize(T), corner), point(T, corner), 1e-3), `${corner}`);
  }
});

test('sameTransform compares every element, and refuses what is not a transform', () => {
  assert.equal(sameTransform([1, 0, 0, 1, 5, 5], [1, 0, 0, 1, 5, 5]), true);
  assert.equal(sameTransform([1, 0, 0, 1, 5, 5], [1, 0, 0, 1, 5, 5.0000001]), false, 'the default tolerance is strict');
  assert.equal(sameTransform([1, 0, 0, 1, 5, 5], [1, 0, 0, 1, 5, 5.0000001], 1e-6), true);
  assert.equal(sameTransform([1, 0, 0, 1, 5, 5], null), false);
  assert.equal(sameTransform(null, null), false, 'two non-transforms are not equal, they are not transforms');
});

test('the determinant reports area scale and handedness, and zero when the basis has collapsed', () => {
  assert.equal(determinant(IDENTITY), 1);
  assert.equal(determinant(CTMS.plain), 200 * 150);
  assert.equal(determinant(CTMS.turned), 2400, 'a quarter turn keeps its area');
  assert.ok(determinant(CTMS.mirrored) < 0, 'a mirrored placement is negative, not invalid');
  assert.equal(determinant([0, 0, 0, 0, 10, 10]), 0);
  assert.equal(determinant([1, 2, 2, 4, 0, 0]), 0, 'collinear axes');
  assert.ok(Number.isNaN(determinant([1, 0, 0, 1])), 'and nothing is claimed about a non-transform');
});

// ---- 3. uniform scale ---------------------------------------------------------------------------

test('scaleAbout leaves its anchor exactly where it is', () => {
  for (const anchor of [[0, 0], [72, 500], [-30.5, 12.25]]) {
    for (const factor of [0.5, 1, 2, 1.333, 0.02, 50]) {
      const T = scaleAbout(anchor, factor);
      assert.ok(samePoint(point(T, anchor), anchor, LOOSE), `anchor ${anchor} × ${factor}`);
    }
  }
});

test('scaleAbout scales every distance from the anchor by the factor, and is the closed form', () => {
  const anchor = [72, 500];
  const T = scaleAbout(anchor, 2);
  assertSame(T, [2, 0, 0, 2, -72, -500], 'f, 0, 0, f, ax(1−f), ay(1−f)');
  assert.ok(samePoint(point(T, [172, 500]), [272, 500]), '100 to the right becomes 200');
  assert.ok(samePoint(point(T, [72, 650]), [72, 800]), '150 above becomes 300');
  assert.ok(samePoint(point(T, [22, 450]), [-28, 400]), 'and it works on the other side too');
  assert.equal(isIdentity(scaleAbout(anchor, 1)), true, 'a factor of one is the identity');
});

test('scaleAbout composes: two scales about one anchor multiply', () => {
  const anchor = [172, 575];
  const once = scaleAbout(anchor, 1.5);
  const twice = multiply(once, scaleAbout(anchor, 2));
  assertSame(twice, scaleAbout(anchor, 3), 'one and a half, then double, is triple', LOOSE);
});

test('a uniform scale in an orthogonal basis is a uniform scale in page space', () => {
  // This is why text may be scaled at all: its own frame is orthogonal when it is editable, so a
  // proportional drag cannot shear it, and it reads back on reload as text rather than as a mess.
  for (const name of ['plain', 'square', 'turned', 'wide', 'mirrored']) {
    const C = CTMS[name];
    const T = scaleAbout([0, 0], 1.25);
    const scaled = multiply(C, T);
    const before = [Math.hypot(C[0], C[1]), Math.hypot(C[2], C[3])];
    const after = [Math.hypot(scaled[0], scaled[1]), Math.hypot(scaled[2], scaled[3])];
    assert.ok(closeTo(after[0], before[0] * 1.25, LOOSE) && closeTo(after[1], before[1] * 1.25, LOOSE), `${name}`);
  }
});

test('scaleAbout refuses a factor that is not a number', () => {
  for (const bad of [NaN, Infinity, undefined, null, '2']) assert.equal(scaleAbout([0, 0], bad), null, String(bad));
});

// ---- 4. quarter turns ---------------------------------------------------------------------------

test('a quarter turn counter-clockwise sends (1, 0) to (0, 1), with y pointing up', () => {
  const T = quarterTurn([0, 0], 1);
  assertSame(T, [0, 1, -1, 0, 0, 0], 'the counter-clockwise quarter turn');
  assert.ok(samePoint(point(T, [1, 0]), [0, 1]), 'right becomes up');
  assert.ok(samePoint(point(T, [0, 1]), [-1, 0]), 'up becomes left');
  assert.ok(samePoint(point(quarterTurn([0, 0], -1), [1, 0]), [0, -1]), 'and clockwise sends right to down');
});

test('a quarter turn leaves its centre where it is, and turns the page around it', () => {
  const centre = [172, 575];
  const T = quarterTurn(centre, 1);
  assert.ok(samePoint(point(T, centre), centre, LOOSE), 'the centre is fixed');
  assert.ok(samePoint(point(T, [272, 575]), [172, 675]), '100 to the right becomes 100 above');
  assert.ok(samePoint(point(T, [172, 675]), [72, 575]), 'and 100 above becomes 100 to the left');
});

test('turns are counted mod four: four of them, or none, is the identity', () => {
  const centre = [72, 500];
  for (const turns of [0, 4, -4, 8]) assert.equal(isIdentity(quarterTurn(centre, turns), LOOSE), true, `${turns} turns`);
  assertSame(quarterTurn(centre, 2), quarterTurn(centre, -2), 'half a turn is the same either way', LOOSE);
  assertSame(quarterTurn(centre, 3), quarterTurn(centre, -1), 'three one way is one the other', LOOSE);
  assertSame(multiply(quarterTurn(centre, 1), quarterTurn(centre, 1)), quarterTurn(centre, 2), 'and they compose', LOOSE);
});

test('a quarter turn swaps what an object measures across the page', () => {
  // The point of turning in page space rather than in the object's own square: a wide picture comes
  // out tall. Turned inside the unit square it would have stayed wide.
  const C = CTMS.plain; // 200 across, 150 up
  const corners = CORNERS.map((c) => point(C, c));
  const box = (points) => [
    Math.max(...points.map((p) => p[0])) - Math.min(...points.map((p) => p[0])),
    Math.max(...points.map((p) => p[1])) - Math.min(...points.map((p) => p[1])),
  ];
  assert.deepEqual(box(corners).map(Math.round), [200, 150], 'wide to begin with');
  const centre = [(corners[0][0] + corners[2][0]) / 2, (corners[0][1] + corners[2][1]) / 2];
  const turned = corners.map((p) => point(quarterTurn(centre, 1), p));
  assert.deepEqual(box(turned).map(Math.round), [150, 200], 'tall afterwards');
  assert.ok(closeTo(Math.abs(determinant(multiply(C, quarterTurn(centre, 1)))), Math.abs(determinant(C)), 1e-6), 'and no bigger');
});

test('quarterTurn refuses a fraction of a turn: Phase 3 has no free rotation', () => {
  for (const bad of [0.5, 1.5, NaN, Infinity, undefined, null, '1']) {
    assert.equal(quarterTurn([0, 0], bad), null, String(bad));
  }
});

// ---- 5. reflections, in the object's own axes ---------------------------------------------------

test('a flip mirrors the object in its own axes, not the page’s', () => {
  // An upright placement: a horizontal flip is a page-space mirror about its own middle.
  const C = CTMS.plain; // x 72…272, y 500…650
  const T = flip(C, 'horizontal');
  assert.ok(samePoint(point(T, [72, 500]), [272, 500], LOOSE), 'the left edge becomes the right');
  assert.ok(samePoint(point(T, [272, 650]), [72, 650], LOOSE), 'and the right becomes the left');
  assert.ok(samePoint(point(T, [172, 575]), [172, 575], LOOSE), 'the middle stays put');

  const V = flip(C, 'vertical');
  assert.ok(samePoint(point(V, [72, 500]), [72, 650], LOOSE), 'the bottom edge becomes the top');
  assert.ok(samePoint(point(V, [172, 575]), [172, 575], LOOSE), 'and the middle stays put again');
});

test('on a turned placement a horizontal flip mirrors the picture, which is not the page’s horizontal', () => {
  const C = CTMS.turned; // the unit x axis points up the page, the unit y axis points left
  const T = flip(C, 'horizontal');
  // The picture's own left and right edges are its unit x = 0 and x = 1, which on the page run
  // vertically — so mirroring the picture horizontally moves points up and down, not side to side.
  const ll = point(C, [0, 0]);
  const lr = point(C, [1, 0]);
  assert.ok(samePoint(point(T, ll), lr, LOOSE), 'the picture’s left edge lands on its right edge');
  assert.ok(samePoint(point(T, lr), ll, LOOSE), 'and the other way about');
  assert.ok(Math.abs(point(T, ll)[1] - ll[1]) > 1, 'which is a movement up the page, not across it');
});

test('a flip is its own undoing, on every real placement and both axes', () => {
  for (const [name, C] of ALL_CTMS) {
    for (const axis of ['horizontal', 'vertical']) {
      const T = flip(C, axis);
      assert.ok(T, `${name} ${axis}`);
      assert.equal(isIdentity(multiply(T, T), LOOSE), true, `${name} ${axis}: flipped twice is unflipped`);
    }
  }
});

test('a flip turns the object over: the area is kept, the handedness is not', () => {
  for (const [name, C] of ALL_CTMS) {
    for (const axis of ['horizontal', 'vertical']) {
      const flipped = multiply(C, flip(C, axis));
      assert.ok(closeTo(Math.abs(determinant(flipped)), Math.abs(determinant(C)), 1e-6), `${name} ${axis}: area`);
      assert.ok(determinant(flipped) * determinant(C) < 0, `${name} ${axis}: handedness is reversed`);
    }
  }
});

test('a flip maps the object’s corners onto its own corners, swapped in pairs', () => {
  const swaps = { horizontal: [1, 0, 3, 2], vertical: [3, 2, 1, 0] };
  for (const [name, C] of ALL_CTMS) {
    const corners = CORNERS.map((c) => point(C, c));
    for (const [axis, order] of Object.entries(swaps)) {
      const T = flip(C, axis);
      corners.forEach((from, i) => {
        assert.ok(samePoint(point(T, from), corners[order[i]], LOOSE), `${name} ${axis}: corner ${i} → ${order[i]}`);
      });
    }
  }
});

test('flip refuses a collapsed basis and an axis that is not one', () => {
  assert.equal(flip([0, 0, 0, 0, 10, 10], 'horizontal'), null, 'a basis with no area cannot say which way is across it');
  assert.equal(flip([1, 2, 2, 4, 0, 0], 'vertical'), null, 'collinear axes');
  for (const axis of ['diagonal', 'Horizontal', '', null, undefined]) {
    assert.equal(flip(CTMS.plain, axis), null, String(axis));
  }
});

// ---- 6. inverses ---------------------------------------------------------------------------------

test('every builder’s transform has an inverse that undoes it exactly', () => {
  const cases = [
    ['translation', translate(25, -40)],
    ['scale', scaleAbout([172, 575], 1.6)],
    ['quarter turn', quarterTurn([172, 575], 1)],
    ['half turn', quarterTurn([0, 0], 2)],
    ['flip h', flip(CTMS.turned, 'horizontal')],
    ['flip v', flip(CTMS.sheared, 'vertical')],
    ['a gesture made of several', multiply(multiply(translate(10, 5), scaleAbout([0, 0], 0.75)), quarterTurn([100, 100], -1))],
  ];
  for (const [name, T] of cases) {
    const back = invert(T);
    assert.ok(back, `${name}: no inverse`);
    assert.equal(isIdentity(multiply(T, back), LOOSE), true, `${name}: T then T⁻¹`);
    assert.equal(isIdentity(multiply(back, T), LOOSE), true, `${name}: T⁻¹ then T`);
    for (const p of [[0, 0], [72, 500], [-14.5, 331.25]]) {
      assert.ok(samePoint(point(back, point(T, p)), p, LOOSE), `${name}: the point ${p} comes home`);
    }
  }
});

test('a transform with no area has no inverse, and nothing pretends otherwise', () => {
  for (const singular of [[0, 0, 0, 0, 0, 0], [0, 0, 0, 0, 10, 10], [1, 2, 2, 4, 0, 0], [3, 0, 0, 0, 5, 5], scaleAbout([50, 50], 0)]) {
    assert.equal(determinant(singular), 0, JSON.stringify(singular));
    assert.equal(invert(singular), null, `${JSON.stringify(singular)}: invert`);
    assert.equal(conjugate(singular, translate(1, 1)), null, `${JSON.stringify(singular)}: conjugate`);
    assert.equal(flip(singular, 'horizontal'), null, `${JSON.stringify(singular)}: flip`);
  }
});

// ---- 7. conjugation: a page-space transform in an image's own basis ------------------------------
// The one formula the image handler is built on. It has to hold exactly, for every placement a real
// file can hold, or a moved image lands somewhere other than where the outline promised.

test('conjugate gives the cm that makes the CTM do C then T', () => {
  const transforms = [
    ['move', translate(25, -40)],
    ['scale about a corner', scaleAbout([72, 500], 1.5)],
    ['quarter turn', quarterTurn([172, 575], 1)],
    ['clockwise turn', quarterTurn([0, 0], -1)],
    ['half turn', quarterTurn([172, 575], 2)],
  ];
  for (const [name, C] of ALL_CTMS) {
    for (const [what, T] of transforms) {
      const L = conjugate(C, T);
      assert.ok(L, `${name} ${what}`);
      // multiply(L, C) is the CTM after inserting `L cm`; multiply(C, T) is what we asked for.
      assertSame(multiply(L, C), multiply(C, T), `${name} ${what}`, LOOSE);
      // And so every corner of the image lands where transforming the quad directly puts it.
      for (const corner of CORNERS) {
        const viaPatch = point(multiply(L, C), corner);
        const viaQuad = point(T, point(C, corner));
        assert.ok(samePoint(viaPatch, viaQuad, LOOSE), `${name} ${what}: corner ${corner}`);
      }
    }
  }
});

test('conjugating the identity changes nothing, whatever the placement', () => {
  for (const [name, C] of ALL_CTMS) {
    assert.equal(isIdentity(conjugate(C, IDENTITY), LOOSE), true, name);
  }
});

test('a flip is the one case where the local matrix is the plain reflection', () => {
  // flip() builds B⁻¹·F·B, so conjugating it back by the same basis must return F itself. The two
  // representations — page space for the record, local space for the patch — agree exactly.
  const local = { horizontal: [-1, 0, 0, 1, 1, 0], vertical: [1, 0, 0, -1, 0, 1] };
  for (const [name, C] of ALL_CTMS) {
    for (const [axis, F] of Object.entries(local)) {
      assertSame(conjugate(C, flip(C, axis)), F, `${name} ${axis}`, LOOSE);
    }
  }
});

test('conjugation composes, so two gestures on one image are one patch', () => {
  for (const [name, C] of ALL_CTMS) {
    const first = translate(12, -7);
    const second = scaleAbout([100, 100], 1.25);
    const both = multiply(first, second);
    assertSame(conjugate(C, both), multiply(conjugate(C, first), conjugate(C, second)), `${name}`, LOOSE);
    assertSame(multiply(conjugate(C, both), C), multiply(C, both), `${name}: and it still lands right`, LOOSE);
  }
});

test('conjugate refuses anything that is not a placement and a transform', () => {
  assert.equal(conjugate(CTMS.plain, null), null);
  assert.equal(conjugate(null, translate(1, 1)), null);
  assert.equal(conjugate(CTMS.plain, [1, 0, 0, 1, NaN, 0]), null);
  assert.equal(conjugate([1, 0, 0, 1, 0], translate(1, 1)), null, 'five numbers are not a placement');
});

// ---- 8. and it is still only algebra ------------------------------------------------------------

test('transform.js depends on matrix.js and nothing else', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const { WEB } = await import('./harness.mjs');
  const file = path.join(WEB, 'js', 'editing', 'objects', 'transform.js');
  const source = fs.readFileSync(file, 'utf8');
  const imports = [...source.matchAll(/^\s*import\s[^;]*?from\s+'([^']+)';/gm)].map((m) => m[1]);
  assert.deepEqual(imports, ['../matrix.js'], `transform.js imports ${imports.join(', ')}`);
  // Nothing outside itself: no host global, no dynamic import, no CommonJS. Comments are stripped
  // first, so the prose may discuss a document without the code touching one.
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  for (const reach of [/\bdocument\s*\./, /\bwindow\s*\./, /\bglobalThis\s*\./, /\bnavigator\s*\./, /\brequire\s*\(/, /\bimport\s*\(/]) {
    assert.equal(reach.test(code), false, `transform.js reaches outside itself: ${reach}`);
  }
});
