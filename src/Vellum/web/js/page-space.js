// The one place that converts between a rendered page and PDF user space.
//
// pdf.js's viewport already carries everything that makes the two differ: the crop box (it is the
// viewport's viewBox), the page's own /Rotate together with the viewer's rotation, and the zoom.
// So nothing here subtracts a crop origin or turns a point by hand — doing either a second time is
// exactly how a rotated or cropped page ends up one transform out. The only correction made here
// is for a page element whose size differs from its viewport's, which happens mid-zoom, before
// pdf.js has re-rendered at the new scale.

/** The page under a DOM element: { n, pageView }, or null when it isn't one of this view's pages. */
export function pageViewAt(view, element) {
  const div = element?.closest?.('.page');
  if (!div || !view.viewerEl.contains(div)) return null;
  const n = Number(div.dataset.pageNumber);
  const pageView = view.viewer.getPageView(n - 1);
  return pageView ? { n, pageView } : null;
}

/** A client (screen) point in PDF user space: [x, y]. */
export function toPdfPoint(pageView, clientX, clientY) {
  const box = pageView.div.getBoundingClientRect();
  const vp = pageView.viewport;
  return vp.convertToPdfPoint((clientX - box.left) * (vp.width / box.width), (clientY - box.top) * (vp.height / box.height));
}

/** A PDF user-space point as a client (screen) point: [x, y], or null while the page has no size. */
export function toClientPoint(pageView, x, y) {
  const box = pageView.div.getBoundingClientRect();
  if (!box.width || !box.height) return null;
  const vp = pageView.viewport;
  const [vx, vy] = vp.convertToViewportPoint(x, y);
  return [box.left + vx * (box.width / vp.width), box.top + vy * (box.height / vp.height)];
}

/** A quad (four PDF-space corners, flat) on screen as [[x, y] × 4], or null. */
export function toClientQuad(pageView, quad) {
  const box = pageView.div.getBoundingClientRect();
  if (!box.width || !box.height) return null;
  const vp = pageView.viewport;
  const sx = box.width / vp.width;
  const sy = box.height / vp.height;
  const points = [];
  for (let i = 0; i < 8; i += 2) {
    const [vx, vy] = vp.convertToViewportPoint(quad[i], quad[i + 1]);
    points.push([box.left + vx * sx, box.top + vy * sy]);
  }
  return points;
}

/** `px` screen pixels as PDF points at this page's current zoom. */
export const tolerancePoints = (pageView, px) => px / pageView.viewport.scale;

/**
 * PDF user space as the page is shown: the linear map from user space to display axes (x to the
 * right, y downwards), in points — the viewport's own transform without its zoom or its offset. A
 * page is only ever turned in quarter turns, so this is a turn and a flip, and it inverts exactly.
 * Measures where things are as a person sees them, whatever the page's /Rotate or the viewer's.
 */
export function displayBasis(pageView) {
  const vp = pageView.viewport;
  const [a, b, c, d] = vp.transform;
  return [a / vp.scale, b / vp.scale, c / vp.scale, d / vp.scale, 0, 0];
}
