import { h, reducedMotion } from '../dom.js';

// A brief outline over a box on a page, drawn in the page element so it follows zoom and never changes the
// page or the document. Used by the Structure panel when an object or a search result is selected, and by
// Collection research when a result's document has been opened at its page.

const MARK_MS = 2400;

/**
 * Outlines `box` ([x1, y1, x2, y2] in PDF user space) on page `number` of `view` and brings it into sight,
 * for a moment. Returns { clear() } to take it away sooner, or null when the page isn't laid out yet.
 */
export function markPageBox(view, number, box, { ms = MARK_MS } = {}) {
  const pageView = view.viewer?.getPageView(number - 1);
  if (!pageView?.div || !box) return null;
  const vp = pageView.viewport;
  const [ax, ay] = vp.convertToViewportPoint(box[0], box[1]);
  const [bx, by] = vp.convertToViewportPoint(box[2], box[3]);
  const pad = 2;
  const mark = h('div', {
    class: 'structure-mark', 'aria-hidden': 'true',
    style: {
      left: `${((Math.min(ax, bx) - pad) / vp.width) * 100}%`,
      top: `${((Math.min(ay, by) - pad) / vp.height) * 100}%`,
      width: `${((Math.abs(bx - ax) + pad * 2) / vp.width) * 100}%`,
      height: `${((Math.abs(by - ay) + pad * 2) / vp.height) * 100}%`,
    },
  });
  pageView.div.append(mark);
  requestAnimationFrame(() => mark.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: reducedMotion() ? 'auto' : 'smooth' }));
  const timer = setTimeout(() => mark.remove(), ms);
  return { clear() { clearTimeout(timer); mark.remove(); } };
}

/**
 * The same, once page `number` has been drawn (view.pageShown) — a document that has just opened lays its
 * pages out and draws them a moment after it is ready, and drawing a page empties its element first.
 */
export async function markPageBoxWhenReady(view, number, box, { ms, wait = 8000 } = {}) {
  await view.pageShown(number, wait);
  await new Promise((resolve) => requestAnimationFrame(resolve));
  return markPageBox(view, number, box, { ms });
}

/** The box of a model item: its own, or the one its quad spans. */
export function itemBox(item) {
  if (item?.box) return item.box;
  const quad = item?.quad;
  if (!quad || quad.length < 8) return null;
  const xs = [quad[0], quad[2], quad[4], quad[6]];
  const ys = [quad[1], quad[3], quad[5], quad[7]];
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}
