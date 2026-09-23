// Cropping a page: the geometry the Crop dialog's rectangle and its four margin fields share, and the
// pages a crop is applied to. Pure: no DOM, no pdf.js, no pdf-lib, no state.
//
// There is one crop in Vellum and this is not it: the crop itself is the page plan's `crop` setting
// ({ top, right, bottom, left } points trimmed from the page's own visible box, pages/stamps.js), which
// annotations/persist.js writes as the page's /CropBox when the document is saved. Nothing here trims,
// deletes or rasterizes anything; it only turns what a person draws or types into that same setting.
//
// Two coordinate systems meet here and nowhere else:
//   shown   the page as a person sees it, x right and y down from its top-left corner, in points —
//           what the rectangle is drawn in
//   own     the page as it is stored, its four sides unrotated — what the plan entry holds
// A page's own /Rotate turns one into the other in quarter turns (`turns`, clockwise), so a crop drawn
// on a page shown sideways trims the sides a person actually sees.

/** The four sides, clockwise, as the page is shown. */
export const CROP_SIDES = Object.freeze(['top', 'right', 'bottom', 'left']);

/** The smallest crop the page writer will take (pages/stamps.js refuses one that leaves nothing). */
export const MIN_CROP = 1;

const number = (v) => (Number.isFinite(Number(v)) ? Math.max(0, Number(v)) : 0);
const round = (v) => Math.round(v * 1000) / 1000;

/** Quarter turns clockwise, from a page's rotation in degrees. */
export const quarterTurns = (rotate) => ((Math.round((Number(rotate) || 0) / 90) % 4) + 4) % 4;

/** The page's own (unrotated) sides for margins measured as the page is shown. */
export function ownSides(shown, turns = 0) {
  const k = quarterTurns(turns * 90);
  return Object.fromEntries(CROP_SIDES.map((side, i) => [side, round(number(shown[CROP_SIDES[(i + k) % 4]]))]));
}

/** The margins as the page is shown, for a plan entry's own (unrotated) sides. */
export function shownSides(own, turns = 0) {
  const k = quarterTurns(turns * 90);
  return Object.fromEntries(CROP_SIDES.map((side, i) => [side, round(number(own?.[CROP_SIDES[(i - k + 4) % 4]]))]));
}

/** True when a crop actually trims something; a crop of nothing is no crop at all. */
export const isCrop = (sides) => Boolean(sides) && CROP_SIDES.some((side) => number(sides[side]) > 0);

/**
 * The margins a rectangle drawn on the shown page leaves, in points.
 *   rect  { x, y, width, height } from the shown page's top-left corner
 *   size  { width, height } of the shown page
 */
export function marginsFromRect(rect, size) {
  const x = Math.min(Math.max(0, number(rect?.x)), size.width);
  const y = Math.min(Math.max(0, number(rect?.y)), size.height);
  const width = Math.min(Math.max(0, number(rect?.width)), size.width - x);
  const height = Math.min(Math.max(0, number(rect?.height)), size.height - y);
  return {
    top: round(y),
    right: round(size.width - (x + width)),
    bottom: round(size.height - (y + height)),
    left: round(x),
  };
}

/** The rectangle a set of shown margins leaves on the shown page. The inverse of marginsFromRect. */
export function rectFromMargins(margins, size) {
  const left = Math.min(number(margins?.left), size.width);
  const top = Math.min(number(margins?.top), size.height);
  return {
    x: round(left),
    y: round(top),
    width: round(Math.max(0, size.width - left - number(margins?.right))),
    height: round(Math.max(0, size.height - top - number(margins?.bottom))),
  };
}

/**
 * Why this crop can't be applied to a page of this size, or null when it can. The same rule the page
 * writer enforces (pages/stamps.js), said before anything is applied rather than after.
 */
export function cropProblem(margins, size) {
  if (!size || !(size.width > 0) || !(size.height > 0)) return null;
  const rect = rectFromMargins(margins, size);
  if (rect.width < MIN_CROP || rect.height < MIN_CROP) return 'The crop leaves nothing of the page.';
  return null;
}

/** Which pages a crop is applied to. 'selected' is what the person chose; the rest count the plan. */
export const CROP_SCOPES = Object.freeze(['selected', 'odd', 'even', 'all']);

/**
 * The plan entry ids a scope covers, in the plan's order.
 *   plan      the page plan (entries with an id), in document order
 *   selected  the ids the person chose
 * Odd and even count a page's place in the document, as a person numbers pages: page 1 is odd.
 */
export function scopeIds(scope, { plan = [], selected = [] } = {}) {
  if (scope === 'all') return plan.map((e) => e.id);
  if (scope === 'odd') return plan.filter((_, i) => i % 2 === 0).map((e) => e.id);
  if (scope === 'even') return plan.filter((_, i) => i % 2 === 1).map((e) => e.id);
  const chosen = new Set(selected);
  return plan.filter((e) => chosen.has(e.id)).map((e) => e.id);
}
