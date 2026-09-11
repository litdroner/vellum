// 2D affine matrices in PDF's convention: [a b c d e f] maps a point (x, y) to
// (a·x + c·y + e, b·x + d·y + f), and multiply(m1, m2) is "m1, then m2" — so the CTM after
// `cm` is multiply(cmMatrix, ctm), and a glyph's rendering matrix is
// multiply(multiply(fontMatrix, textMatrix), ctm).

export const IDENTITY = Object.freeze([1, 0, 0, 1, 0, 0]);

export function multiply(m1, m2) {
  const [a1, b1, c1, d1, e1, f1] = m1;
  const [a2, b2, c2, d2, e2, f2] = m2;
  return [
    a1 * a2 + b1 * c2,
    a1 * b2 + b1 * d2,
    c1 * a2 + d1 * c2,
    c1 * b2 + d1 * d2,
    e1 * a2 + f1 * c2 + e2,
    e1 * b2 + f1 * d2 + f2,
  ];
}

export function apply(m, x, y) {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

/** Applies only the linear part (no translation): for directions and distances. */
export function applyLinear(m, x, y) {
  return [m[0] * x + m[2] * y, m[1] * x + m[3] * y];
}

export function invert(m) {
  const [a, b, c, d, e, f] = m;
  const det = a * d - b * c;
  if (!det || !Number.isFinite(det)) return null;
  return [d / det, -b / det, -c / det, a / det, (c * f - d * e) / det, (b * e - a * f) / det];
}

export const translate = (tx, ty) => [1, 0, 0, 1, tx, ty];

/** Axis-aligned bounds [x1, y1, x2, y2] of a list of points [[x, y], ...]. */
export function boundsOf(points) {
  let x1 = Infinity;
  let y1 = Infinity;
  let x2 = -Infinity;
  let y2 = -Infinity;
  for (const [x, y] of points) {
    if (x < x1) x1 = x;
    if (x > x2) x2 = x;
    if (y < y1) y1 = y;
    if (y > y2) y2 = y;
  }
  return [x1, y1, x2, y2];
}

/** Intersection of two [x1, y1, x2, y2] boxes; null when they don't overlap. */
export function intersect(p, q) {
  const box = [Math.max(p[0], q[0]), Math.max(p[1], q[1]), Math.min(p[2], q[2]), Math.min(p[3], q[3])];
  return box[0] <= box[2] && box[1] <= box[3] ? box : null;
}
