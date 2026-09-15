// Lining several objects up, and spacing them evenly: pure arithmetic that gives each object the move
// that puts it in its place. No DOM, no pdf.js, no viewport, no analysis, no edit store.
//
// It works in DISPLAY axes — x to the right and y downwards, as the page is shown — because "align
// left" means the left a person sees, whatever the page's own /Rotate or the viewer's rotation. The
// caller turns each object's quad into a box in those axes, and each move back into page space
// (page-space.js displayBasis). Both directions are exact: a page is only ever turned in quarter turns.
//
//   boxes  [{ key, box: [x1, y1, x2, y2] }]   where each object is now, in display axes
//   moves  [{ key, dx, dy }]                   how far each one goes, in the same axes and order
//
// Only moves come out of here — never a scale or anything else — so what these arrange can be
// arranged by any object that can be moved. An object already where it belongs gets a move of zero,
// which the session stores as no change at all.

/** The ways several objects can be lined up: edges and centres, across and down. */
export const ALIGNMENTS = Object.freeze(['left', 'center', 'right', 'top', 'middle', 'bottom']);

/** The ways several objects can be spaced evenly. */
export const DISTRIBUTIONS = Object.freeze(['horizontal', 'vertical']);

/** The fewest objects each kind of arrangement means anything for. */
export const MINIMUM = Object.freeze({ align: 2, distribute: 3 });

const validBox = (b) => Array.isArray(b?.box) && b.box.length === 4 && b.box.every(Number.isFinite) && b.box[0] <= b.box[2] && b.box[1] <= b.box[3];

/**
 * Moves that line the boxes up along one edge or centre of the box around all of them: `left`,
 * `center` and `right` move across only, `top`, `middle` and `bottom` down only. null when there are
 * too few boxes, one that isn't a box, or an alignment that isn't one.
 */
export function alignMoves(boxes, alignment) {
  if (!ALIGNMENTS.includes(alignment) || !Array.isArray(boxes) || boxes.length < MINIMUM.align || !boxes.every(validBox)) return null;
  const x1 = Math.min(...boxes.map((b) => b.box[0]));
  const y1 = Math.min(...boxes.map((b) => b.box[1]));
  const x2 = Math.max(...boxes.map((b) => b.box[2]));
  const y2 = Math.max(...boxes.map((b) => b.box[3]));
  return boxes.map(({ key, box }) => {
    const across = { left: x1 - box[0], center: (x1 + x2) / 2 - (box[0] + box[2]) / 2, right: x2 - box[2] }[alignment];
    const down = { top: y1 - box[1], middle: (y1 + y2) / 2 - (box[1] + box[3]) / 2, bottom: y2 - box[3] }[alignment];
    return { key, dx: across ?? 0, dy: down ?? 0 };
  });
}

/**
 * Moves that space the boxes evenly across (`horizontal`) or down (`vertical`): the first and the last
 * — by where their centres are — stay exactly where they are, and every gap between one box and the
 * next becomes the same. Boxes that overlap get the same overlap instead, which is the same rule.
 * null when there are fewer than three boxes, one that isn't a box, or a direction that isn't one.
 */
export function distributeMoves(boxes, direction) {
  if (!DISTRIBUTIONS.includes(direction) || !Array.isArray(boxes) || boxes.length < MINIMUM.distribute || !boxes.every(validBox)) return null;
  const [lo, hi] = direction === 'horizontal' ? [0, 2] : [1, 3];
  const size = (b) => b.box[hi] - b.box[lo];
  const order = boxes
    .map((b, i) => ({ b, i }))
    .sort((p, q) => (p.b.box[lo] + p.b.box[hi]) - (q.b.box[lo] + q.b.box[hi]) || p.i - q.i)
    .map((p) => p.b);
  const start = order[0].box[lo];
  const end = order.at(-1).box[hi];
  const gap = (end - start - order.reduce((sum, b) => sum + size(b), 0)) / (order.length - 1);
  const moves = new Map();
  let at = start;
  for (const b of order) {
    // The last box is exactly where it was by construction; say so, rather than leave rounding in.
    const d = b === order.at(-1) ? 0 : at - b.box[lo];
    moves.set(b, direction === 'horizontal' ? { key: b.key, dx: d, dy: 0 } : { key: b.key, dx: 0, dy: d });
    at += size(b) + gap;
  }
  return boxes.map((b) => moves.get(b));
}
