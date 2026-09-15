// Building the affine transforms object manipulation is written with. Pure: it imports matrix.js
// and nothing else — no DOM, no pdf.js, no viewport, no analysis, no object model, no edit store,
// no writer. It must stay that way, because the image handler needs conjugate() while a document is
// being composed, which puts this module inside the compose path.
//
// A transform is the PDF affine six-tuple [a b c d e f] matrix.js already speaks, and it is always
// ABSOLUTE and in the ORIGINAL page's user space: "where this object ends up", not "how far it just
// moved". One record holds one transform, so two drags of the same object compose into one.
//
// The two kinds of object then use it differently, and this is the distinction the whole design
// rests on:
//
//   text    is redrawn after the page's content, so its transform is applied AFTER its original
//           placement: the handler emits multiply(show.ctm, T) where it used to emit show.ctm.
//   images  are patched in place, so a page-space T has to be expressed in the image's own basis
//           first: conjugate(ctm, T) is the `cm` to insert before the operator.
//
// Composition, inversion, point application, the identity and translation are matrix.js's own
// (multiply, invert, apply, IDENTITY, translate) and are used unwrapped — a second name for one of
// them would be a second vocabulary. What is here is only what matrix.js does not have: the builders
// manipulation needs (uniform scale, quarter turn, flip, stretch), and the checks that keep a
// transform safe to store and to write.

import { IDENTITY, multiply, invert, translate } from '../matrix.js';

/**
 * Decimals a transform is kept to. The content-stream writer rounds every number it writes to four
 * (num(), editing/content/writer.js), so a transform stored to the same precision is one the file
 * can hold exactly: what is drawn on screen is then what ends up in the PDF.
 */
const PLACES = 4;

/** A transform that can be stored and written: six finite numbers, nothing else. */
export const isValid = (t) => Array.isArray(t) && t.length === 6 && t.every((v) => typeof v === 'number' && Number.isFinite(v));

/** The determinant of the linear part: area scale, and sign. Zero means the basis has collapsed. */
export const determinant = (m) => (isValid(m) ? m[0] * m[3] - m[1] * m[2] : NaN);

/** Rounded to what the writer can hold, without a negative zero (which num() also refuses). */
export function quantize(t) {
  if (!isValid(t)) return null;
  const factor = 10 ** PLACES;
  return t.map((v) => {
    const r = Math.round(v * factor) / factor;
    return Object.is(r, -0) ? 0 : r;
  });
}

/** Are these the same transform, to `tol`? Element by element; no element is allowed to differ. */
export const sameTransform = (a, b, tol = 1e-9) => isValid(a) && isValid(b) && a.every((v, i) => Math.abs(v - b[i]) <= tol);

/**
 * Does this transform leave everything where it is? A record with an identity transform is a record
 * that says nothing, so nothing should store one. Ask it of quantize()d values when the question is
 * really "would this change the file?".
 */
export const isIdentity = (t, tol = 1e-9) => sameTransform(t, IDENTITY, tol);

/**
 * The scale factor of a transform that is a move, a uniform scale, or both — and null for anything
 * else: a rotation, a mirror, a non-uniform scale or a skew, whose linear part is not a positive
 * multiple of the identity. The factor comes back unjudged (it may be zero or negative); what
 * counts as usable is the caller's to say.
 *
 * Reflow asks this: it measures a paragraph along the page's x axis, which a turned paragraph no longer
 * runs along. Text itself may also be turned (similarityScaleOf, edits.js). Ask it of quantize()d
 * values, so that what is stored and what is written answer the same way.
 */
export function moveAndScaleOf(t, tol = 1e-9) {
  if (!isValid(t)) return null;
  const [a, b, c, d] = t;
  return Math.abs(b) <= tol && Math.abs(c) <= tol && Math.abs(a - d) <= tol ? (a + d) / 2 : null;
}

/**
 * How far a similarity's linear part may be from exact, relative to its scale, and still be taken as
 * one: rotations are built from cos and sin, composed with the transform already stored and rounded
 * to four places, so the two halves of a rotation can come out 1e-4 apart. Anything further is a
 * mirror, a skew or a non-uniform scale, and is not a similarity at all.
 */
const SIMILAR = 1e-3;

/**
 * The exact similarity — a move, a rotation and a uniform scale, and nothing else — closest to `t`,
 * quantized to what the writer holds, or null when `t` is not one to within SIMILAR: a mirror, a skew
 * or a non-uniform scale. Its linear part is [p q −q p] with p = s·cos θ and q = s·sin θ exactly, so a
 * stored text placement never picks up a skew however often it is turned, and is judged strictly.
 */
export function similarityOf(t) {
  if (!isValid(t)) return null;
  const [a, b, c, d, e, f] = t;
  const p = (a + d) / 2;
  const q = (b - c) / 2;
  const scale = Math.hypot(p, q);
  if (!(Math.hypot(a - d, b + c) / 2 <= SIMILAR * scale + 1e-9)) return null;
  const kept = quantize([p, q, 0, p, e, f]);
  kept[2] = kept[1] === 0 ? 0 : -kept[1];
  return kept;
}

/**
 * The uniform scale of a transform that is exactly a similarity (see similarityOf), or null. Unjudged,
 * like moveAndScaleOf(): zero is possible, and whether that is usable is the caller's to say.
 */
export function similarityScaleOf(t, tol = 1e-9) {
  if (!isValid(t)) return null;
  const [a, b, c, d] = t;
  return Math.abs(a - d) <= tol && Math.abs(b + c) <= tol ? Math.hypot(a, b) : null;
}

/** A linear transform applied about a fixed point: move the point to the origin, act, move back. */
const about = ([px, py], linear) => multiply(multiply(translate(-px, -py), linear), translate(px, py));

/**
 * A rotation by `radians` counter-clockwise in PDF user space (y up) about `centre`, which does not
 * move: the free rotation a rotate handle drags. A whole quarter turn is quarterTurn()'s exact matrix,
 * so a handle snapped to 90° writes the same numbers the keyboard does.
 */
export function rotateAbout(centre, radians) {
  if (!Number.isFinite(radians)) return null;
  const turns = radians / (Math.PI / 2);
  if (Math.abs(turns - Math.round(turns)) < 1e-9) return quarterTurn(centre, Math.round(turns));
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  return about(centre, [cos, sin, -sin, cos, 0, 0]);
}

/**
 * Uniform scale by `factor` about `anchor`, which does not move. Phase 3 anchors a corner drag at
 * the corner opposite it, so the two corners the person can see behave as they look: one follows
 * the pointer, the other stays put.
 *
 * Uniform only. In an object's own orthogonal basis a uniform scale is also a similarity in page
 * space, which is what keeps scaled text readable back as text rather than as something sheared;
 * non-proportional image resize needs its own builder, in the object's axes, and is not here yet.
 */
export const scaleAbout = (anchor, factor) => (Number.isFinite(factor) ? about(anchor, [factor, 0, 0, factor, 0, 0]) : null);

// Quarter turns counter-clockwise in PDF user space, where y points up: (1, 0) → (0, 1).
const TURNS = Object.freeze([
  Object.freeze([1, 0, 0, 1, 0, 0]),
  Object.freeze([0, 1, -1, 0, 0, 0]),
  Object.freeze([-1, 0, 0, -1, 0, 0]),
  Object.freeze([0, -1, 1, 0, 0, 0]),
]);

/**
 * `turns` quarter turns counter-clockwise about `centre` (negative for clockwise), in PAGE space
 * rather than in the object's own basis: a quarter turn has to swap an object's width and height as
 * they appear on the page, and a turn inside the unit square would instead squash the picture back
 * into the footprint it started with.
 *
 * Which way a turn looks on screen depends on the sign of the object's determinant — a mirrored
 * image turns the other way — so the caller decides the sign; this only builds what it is asked for.
 */
export function quarterTurn(centre, turns) {
  if (!Number.isInteger(turns)) return null;
  return about(centre, TURNS[((turns % 4) + 4) % 4]);
}

// Reflections of the unit square in its own axes: x → 1 − x, and y → 1 − y.
const FLIPS = Object.freeze({
  horizontal: Object.freeze([-1, 0, 0, 1, 1, 0]),
  vertical: Object.freeze([1, 0, 0, -1, 0, 1]),
});

/**
 * A reflection in the object's OWN axes, as a page-space transform: T = B⁻¹ · F · B, where `basis`
 * maps the unit square onto the object (for an image, its CTM). Flipping a turned picture should
 * mirror the picture, not the page, and only its own basis knows which way that is.
 *
 * null when the basis has collapsed and cannot be inverted, and for an axis that isn't one.
 */
export function flip(basis, axis) {
  const local = FLIPS[axis];
  const inverse = local ? invert(basis) : null;
  return inverse ? multiply(multiply(inverse, local), basis) : null;
}

/**
 * A stretch along one of the object's OWN axes, as a page-space transform: the unit square is scaled
 * by `factor` along `axis` ('x' or 'y') about its edge at `fixedAt` (0 or 1), which does not move, and
 * the other axis is left exactly as it is. T = B⁻¹ · S · B, as for flip(), so a turned or mirrored
 * picture is stretched along its own width or height rather than along the page's.
 *
 * Only a positive factor is a stretch: zero would collapse the object and a negative factor would
 * mirror it, which flip() does properly. null for either, for an axis or edge that isn't one, and for
 * a basis that has collapsed.
 *
 * For pictures only. Text is redrawn from its own glyphs and can take a move, a rotation and a uniform
 * scale and nothing else, so a stretch is never offered for it (capabilities.js) and the writer refuses one.
 */
export function stretch(basis, axis, factor, fixedAt) {
  if (!(Number.isFinite(factor) && factor > 0) || (fixedAt !== 0 && fixedAt !== 1)) return null;
  const local = { x: [factor, 0, 0, 1, (1 - factor) * fixedAt, 0], y: [1, 0, 0, factor, 0, (1 - factor) * fixedAt] }[axis];
  const inverse = local && isValid(basis) ? invert(basis) : null;
  return inverse ? multiply(multiply(inverse, local), basis) : null;
}

/**
 * A page-space transform as the `cm` to insert before an operator drawn with `ctm`: C · T · C⁻¹.
 *
 * An image's unit square maps by C, and we want it to map by C and then T. Inserting `L cm` makes
 * the CTM multiply(L, C), so L·C must equal C·T, which gives L = C·T·C⁻¹. Everything the page
 * already did to that image — its clip, its transparency, the colour a stencil mask paints with,
 * its place in the drawing order — is untouched, because only the geometry is wrapped.
 *
 * null when C cannot be inverted: a degenerate placement is refused rather than approximated.
 */
export function conjugate(ctm, transform) {
  const inverse = isValid(ctm) && isValid(transform) ? invert(ctm) : null;
  return inverse ? multiply(multiply(ctm, transform), inverse) : null;
}
