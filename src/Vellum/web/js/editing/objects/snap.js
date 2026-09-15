// Snapping while dragging: pure arithmetic that nudges a move the last few points so that the dragged
// object's edges or centre line up with another object's, or the page's. No DOM, no pdf.js, no
// viewport, no analysis, no edit store.
//
// Like arrange.js it works in DISPLAY axes — x to the right and y downwards, as the page is shown —
// because a line a person sees as vertical is the one to snap to, whatever the page's /Rotate or the
// viewer's rotation. The caller turns quads into boxes in those axes and the result back into page
// space (page-space.js displayBasis); both directions are exact, since pages turn in quarter turns.
//
//   box        [x1, y1, x2, y2]      where the dragged object (or group) would be without snapping
//   targets    [[x1, y1, x2, y2]]    what it may line up with: the other objects, and the page
//   tolerance  how far apart two lines may be and still snap, in the same units
//
// Only the move changes, and only by less than the tolerance: an object's own geometry never does.

/** Lines of a box along one axis: its low edge, its centre and its high edge. */
const linesOf = (box, lo) => [box[lo], (box[lo] + box[lo + 2]) / 2, box[lo + 2]];

/** Two lines closer than this are the same line (it absorbs rounding, nothing a person could see). */
const SAME = 1e-6;

const validBox = (b) => Array.isArray(b) && b.length === 4 && b.every(Number.isFinite) && b[0] <= b[2] && b[1] <= b[3];

/** The smallest offset, within the tolerance, that puts one of the box's lines on one of a target's. */
function nearest(box, targets, lo, tolerance) {
  let best = null;
  for (const line of linesOf(box, lo)) {
    for (const target of targets) {
      for (const other of linesOf(target, lo)) {
        const d = other - line;
        if (Math.abs(d) <= tolerance && (best === null || Math.abs(d) < Math.abs(best))) best = d;
      }
    }
  }
  return best;
}

/**
 * Guides along one axis for a box already snapped: one line wherever one of its lines is exactly on a
 * target's, spanning the box and every target on that line. `axis` 'x' is a vertical line at x = at
 * running from y = from to y = to; 'y' a horizontal one.
 */
function guidesAlong(box, targets, lo) {
  const across = lo === 0 ? 1 : 0;
  const guides = [];
  for (const at of linesOf(box, lo)) {
    const on = targets.filter((t) => linesOf(t, lo).some((l) => Math.abs(l - at) <= SAME));
    if (!on.length || guides.some((g) => Math.abs(g.at - at) <= SAME)) continue;
    const span = [box, ...on];
    guides.push({
      axis: lo === 0 ? 'x' : 'y',
      at,
      from: Math.min(...span.map((b) => b[across])),
      to: Math.max(...span.map((b) => b[across + 2])),
    });
  }
  return guides;
}

/**
 * How much further to move a dragged box so that it lines up — { dx, dy, guides } — where dx and dy
 * are each zero when nothing is within the tolerance along that axis, and never larger than it. The
 * guides are the lines it is then on, for drawing. Nothing to snap to, or a box that isn't one, gives
 * no snap at all.
 */
export function snapMove(box, targets, tolerance) {
  const none = { dx: 0, dy: 0, guides: [] };
  if (!validBox(box) || !Array.isArray(targets) || !(tolerance >= 0)) return none;
  const others = targets.filter(validBox);
  if (!others.length) return none;
  const dx = nearest(box, others, 0, tolerance) ?? 0;
  const dy = nearest(box, others, 1, tolerance) ?? 0;
  const snapped = [box[0] + dx, box[1] + dy, box[2] + dx, box[3] + dy];
  return { dx, dy, guides: [...guidesAlong(snapped, others, 0), ...guidesAlong(snapped, others, 1)] };
}
