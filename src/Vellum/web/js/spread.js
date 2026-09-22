// Two-page spreads, as pdf.js lays them out in SpreadMode.ODD: pages 1–2, 3–4, 5–6…, and a
// last page of an odd-length document on its own. Pure page arithmetic, so it can be tested alone.

/** The left-hand (first) page of the spread holding `page`. */
export function spreadStart(page) {
  return page % 2 === 0 ? page - 1 : page;
}

/** The pages of the spread holding `page`, in a document of `count` pages: [left] or [left, right]. */
export function spreadPages(page, count) {
  const left = spreadStart(page);
  return left + 1 <= count ? [left, left + 1] : [left];
}

/** The first page of the next spread, or null on the last one. */
export function nextSpreadPage(page, count) {
  const next = spreadStart(page) + 2;
  return next <= count ? next : null;
}

/** The first page of the previous spread, or null on the first one. */
export function previousSpreadPage(page) {
  const previous = spreadStart(page) - 2;
  return previous >= 1 ? previous : null;
}
