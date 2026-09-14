// Object geometry in PDF user space: oriented boxes, containment, hit-testing, handle points.
//
// Pure — no DOM, no pdf.js, no viewport. Everything here works in the page's own user space, which
// is where the analysis already puts it: a text run's quad comes from its reading frame
// (editing/runs.js) and an image's from its CTM (editing/content/interpreter.js), so both are
// already oriented. Screen coordinates never reach this module; a pointer is converted once, by
// page-space.js, and every comparison happens here in points.

import { compareOrder } from './page-objects.js';
import { apply, boundsOf } from '../matrix.js';

// Below this a quad has no usable area: its own basis can't be solved for, so nothing is inside it.
const MIN_AREA = 1e-9;

/** Signed area × 1 of the parallelogram a quad spans, as an absolute value. 0 when it has none. */
export function quadArea(quad) {
  if (!quad || quad.length < 8) return 0;
  const ux = quad[2] - quad[0];
  const uy = quad[3] - quad[1];
  const vx = quad[6] - quad[0];
  const vy = quad[7] - quad[1];
  const det = ux * vy - uy * vx;
  return Number.isFinite(det) ? Math.abs(det) : 0;
}

/**
 * Is a PDF-space point inside a quad, within `tol` user-space units?
 *
 * A quad is ll, lr, ur, ul — a parallelogram. With u = lr − ll and v = ul − ll, every point is
 * p = ll + s·u + t·v, so one 2×2 solve says where the point falls in the quad's OWN basis. That is
 * exact for rotated, mirrored and sheared quads alike, where testing the axis-aligned bounding box
 * would accept a large wrong area around a turned object.
 *
 * The tolerance is real distance, not parametric slack. `s` runs across the quad, and the height of
 * the parallelogram measured against the v edge is |det| / |v|, so `tol` points of real distance is
 * tol·|v| / |det| in s, and the mirror of that in t.
 *
 * A quad with no area is never inside anything, rather than quietly widening to its bounding box.
 */
export function quadContains(quad, point, tol = 0) {
  if (!quad || quad.length < 8 || !point) return false;
  const ox = quad[0];
  const oy = quad[1];
  const ux = quad[2] - ox;
  const uy = quad[3] - oy;
  const vx = quad[6] - ox;
  const vy = quad[7] - oy;
  const det = ux * vy - uy * vx;
  if (!Number.isFinite(det) || Math.abs(det) < MIN_AREA) return false;
  const px = point[0] - ox;
  const py = point[1] - oy;
  if (!Number.isFinite(px) || !Number.isFinite(py)) return false;
  const s = (px * vy - py * vx) / det;
  const t = (ux * py - uy * px) / det;
  const ds = (tol * Math.hypot(vx, vy)) / Math.abs(det);
  const dt = (tol * Math.hypot(ux, uy)) / Math.abs(det);
  return s >= -ds && s <= 1 + ds && t >= -dt && t <= 1 + dt;
}

/** Is a PDF-space point on this object? Its quad is the analysis's own, never re-measured here. */
export const objectContains = (object, point, tol = 0) => quadContains(object?.geometry?.quad, point, tol);

/**
 * A quad where a page-space transform puts it: the same four corners, each mapped through the
 * transform. This is how an object that has been moved, scaled, turned or flipped is drawn and hit
 * tested — the analysis always describes the ORIGINAL page (that is what makes identity stable), so
 * where an object is NOW is its own quad plus the absolute transform its edit record holds.
 *
 * The quad comes back unchanged for a null transform, so "no record" and "a record that moves
 * nothing" draw the same thing.
 */
export function transformQuad(quad, transform) {
  if (!quad || quad.length < 8) return null;
  if (!transform) return quad;
  const out = [];
  for (let i = 0; i < 8; i += 2) out.push(...apply(transform, quad[i], quad[i + 1]));
  return out.every(Number.isFinite) ? out : null;
}

/** The axis-aligned bounds of a quad: [x1, y1, x2, y2], or null. */
export function quadBox(quad) {
  if (!quad || quad.length < 8) return null;
  return boundsOf([[quad[0], quad[1]], [quad[2], quad[3]], [quad[4], quad[5]], [quad[6], quad[7]]]);
}

/**
 * The axis-aligned bounds of several quads together — a selection of objects as one box — as
 * [x1, y1, x2, y2], or null when there is nothing to bound. In PDF user space; a page is only ever
 * turned in quarter turns, so this box is a rectangle on screen too.
 */
export function unionBox(quads) {
  const points = [];
  for (const quad of quads ?? []) {
    if (!quad || quad.length < 8) continue;
    for (let i = 0; i < 8; i += 2) points.push([quad[i], quad[i + 1]]);
  }
  if (!points.length) return null;
  const box = boundsOf(points);
  return box.every(Number.isFinite) ? box : null;
}

/** A box [x1, y1, x2, y2] as a quad (ll, lr, ur, ul), so a box is outlined and handled like an object. */
export const boxQuad = (box) => (box ? [box[0], box[1], box[2], box[1], box[2], box[3], box[0], box[3]] : null);

/**
 * Is the whole of a quad inside a box [x1, y1, x2, y2]? Every corner has to be: a selection
 * rectangle takes what it encloses, not whatever it touches, so a large picture behind the text
 * being gathered up is not swept in with it. A quad with no area is never inside anything.
 */
export function quadWithin(quad, box) {
  if (!box || quadArea(quad) < MIN_AREA) return false;
  for (let i = 0; i < 8; i += 2) {
    if (!(quad[i] >= box[0] && quad[i] <= box[2] && quad[i + 1] >= box[1] && quad[i + 1] <= box[3])) return false;
  }
  return true;
}

/** The centre of a quad — the mean of its four corners, which is its centre of symmetry. */
export function quadCentre(quad) {
  if (!quad || quad.length < 8) return null;
  return [(quad[0] + quad[2] + quad[4] + quad[6]) / 4, (quad[1] + quad[3] + quad[5] + quad[7]) / 4];
}

/**
 * The eight points a resize handle would sit on, in PDF user space and in the quad's own frame:
 * the four corners (ll, lr, ur, ul), then the midpoints of the bottom, right, top and left edges.
 * Under rotation, mirroring or shear these follow the object, because they are built from its own
 * corners rather than from a bounding box.
 *
 * The first four — the corners — are what Edit mode draws and drags for a uniform scale, anchored
 * at the corner opposite the one being pulled. The edge midpoints are computed but not drawn: a
 * non-proportional resize needs a builder in the object's own axes that objects/transform.js does
 * not have, and text could not be written that way at all, so an edge handle would promise a drag
 * nothing can honour.
 */
export function handlePoints(quad) {
  if (!quad || quad.length < 8) return null;
  const corners = [[quad[0], quad[1]], [quad[2], quad[3]], [quad[4], quad[5]], [quad[6], quad[7]]];
  const mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  const [ll, lr, ur, ul] = corners;
  return [...corners, mid(ll, lr), mid(lr, ur), mid(ur, ul), mid(ul, ll)];
}

/**
 * The topmost object under a PDF-space point, or null.
 *
 * `objects` arrives in drawing order (objectsOf() sorts it that way), so the search runs backwards:
 * the last thing drawn is the thing you see, and drawing order decides — not size, which would let
 * a small picture behind a large one win over the one actually on top.
 *
 * Objects can tie: one TJ operator holding two columns gives two runs the same order path, and
 * compareOrder() calls them equal. Equal-order objects are adjacent after the sort, so the search
 * stops at the first different order and lets the smaller of the tied objects win — which is how
 * Edit mode has always picked the inner of two nested pieces of text.
 */
export function hitTest(objects, point, tol = 0) {
  let best = null;
  for (let i = objects.length - 1; i >= 0; i--) {
    const object = objects[i];
    if (best && compareOrder(object, best) !== 0) break;
    if (!objectContains(object, point, tol)) continue;
    if (!best || quadArea(object.geometry.quad) < quadArea(best.geometry.quad)) best = object;
  }
  return best;
}
