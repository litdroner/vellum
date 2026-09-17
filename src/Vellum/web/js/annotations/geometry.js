// Geometry shared by the on-screen layer, printing and saving.
// All annotation coordinates are PDF user space: points, origin bottom-left, y up.

export const NOTE_SIZE = 20;

/** Bounding box [x1, y1, x2, y2] of an annotation, optionally padded. */
export function bounds(a, pad = 0) {
  let x1 = Infinity;
  let y1 = Infinity;
  let x2 = -Infinity;
  let y2 = -Infinity;
  const take = (x, y) => {
    if (x < x1) x1 = x;
    if (x > x2) x2 = x;
    if (y < y1) y1 = y;
    if (y > y2) y2 = y;
  };
  for (const q of a.quads ?? []) for (let i = 0; i < 8; i += 2) take(q[i], q[i + 1]);
  for (const p of a.paths ?? []) for (let i = 0; i < p.length; i += 2) take(p[i], p[i + 1]);
  if (a.type === 'field') {
    take(a.rect[0], a.rect[1]);
    take(a.rect[2], a.rect[3]);
  }
  if (a.type === 'note') {
    take(a.point[0], a.point[1]);
    take(a.point[0] + NOTE_SIZE, a.point[1] - NOTE_SIZE);
  }
  const extra = pad + (a.type === 'ink' ? (a.width ?? 0) / 2 : 0);
  return [x1 - extra, y1 - extra, x2 + extra, y2 + extra];
}

/** Underline strokes: one per quad, just above the quad's lower edge, thickness scaled to the text. */
export function underlineSegments(quads) {
  return quads.map((q) => {
    const [ulx, uly, , , llx, lly, lrx, lry] = q;
    const vx = ulx - llx;
    const vy = uly - lly;
    const height = Math.hypot(vx, vy) || 1;
    const width = Math.max(0.6, height * 0.07);
    const ox = (vx / height) * width * 0.9;
    const oy = (vy / height) * width * 0.9;
    return { x1: llx + ox, y1: lly + oy, x2: lrx + ox, y2: lry + oy, width };
  });
}

// ---- text selection → quads ---------------------------------------------------

/** Corners of a screen rect as the text's upper-left, upper-right, lower-left, lower-right, given view rotation. */
function readingCorners(r, rotation) {
  switch (rotation) {
    case 90: return [[r.r, r.t], [r.r, r.b], [r.l, r.t], [r.l, r.b]];
    case 180: return [[r.r, r.b], [r.l, r.b], [r.r, r.t], [r.l, r.t]];
    case 270: return [[r.l, r.b], [r.l, r.t], [r.r, r.b], [r.r, r.t]];
    default: return [[r.l, r.t], [r.r, r.t], [r.l, r.b], [r.r, r.b]];
  }
}

/** Merges the many small rects a selection produces into one rect per line of text. */
function mergeLines(rects, vertical) {
  const flip = (r) => ({ l: r.t, r: r.b, t: r.l, b: r.r });
  const list = (vertical ? rects.map(flip) : rects).sort((a, b) => a.t - b.t || a.l - b.l);
  const lines = [];
  for (const r of list) {
    const h = r.b - r.t;
    const line = lines.find((L) => {
      const overlap = Math.min(L.b, r.b) - Math.max(L.t, r.t);
      return overlap >= 0.5 * Math.min(h, L.b - L.t) && r.l <= L.r + h * 0.8 && r.r >= L.l - h * 0.8;
    });
    if (line) {
      line.l = Math.min(line.l, r.l);
      line.r = Math.max(line.r, r.r);
      line.t = Math.min(line.t, r.t);
      line.b = Math.max(line.b, r.b);
    } else {
      lines.push({ ...r });
    }
  }
  return vertical ? lines.map(flip) : lines;
}

/**
 * Converts the current text selection inside a document into highlight/underline quads,
 * grouped by page: [{ page, quads }]. Empty if nothing usable is selected.
 */
export function selectionToQuads(view) {
  const selection = getSelection();
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return [];
  const pageOf = (node) => (node?.nodeType === 1 ? node : node?.parentElement)?.closest?.('.page');
  const anchorPage = pageOf(selection.anchorNode);
  const focusPage = pageOf(selection.focusNode);
  if (!anchorPage || !focusPage || !view.viewerEl.contains(anchorPage)) return [];

  let from = Number(anchorPage.dataset.pageNumber);
  let to = Number(focusPage.dataset.pageNumber);
  if (from > to) [from, to] = [to, from];

  const rects = [];
  for (let i = 0; i < selection.rangeCount; i++) rects.push(...selection.getRangeAt(i).getClientRects());

  const rotation = view.viewer.pagesRotation;
  const vertical = rotation % 180 !== 0;
  const result = [];
  for (let n = from; n <= to; n++) {
    const pageView = view.viewer.getPageView(n - 1);
    if (!pageView?.div) continue;
    const box = pageView.div.getBoundingClientRect();
    const local = [];
    for (const r of rects) {
      if (r.width < 1 || r.height < 1) continue;
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      if (cx < box.left || cx > box.right || cy < box.top || cy > box.bottom) continue;
      // Skip the full-page helper element pdf.js uses while selecting.
      if (vertical ? r.width > box.width * 0.35 : r.height > box.height * 0.35) continue;
      local.push({ l: r.left - box.left, t: r.top - box.top, r: r.right - box.left, b: r.bottom - box.top });
    }
    if (!local.length) continue;
    const viewport = pageView.viewport;
    const sx = viewport.width / box.width;
    const sy = viewport.height / box.height;
    const quads = mergeLines(local, vertical).map((line) =>
      readingCorners(line, rotation).flatMap(([x, y]) => viewport.convertToPdfPoint(x * sx, y * sy)));
    result.push({ page: n, quads });
  }
  return result;
}

// ---- hit testing -------------------------------------------------------------

function distanceToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSq = dx * dx + dy * dy;
  const t = lengthSq ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lengthSq)) : 0;
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

function nearPath(p, x, y, reach) {
  if (p.length === 2) return Math.hypot(x - p[0], y - p[1]) <= reach;
  for (let i = 0; i < p.length - 2; i += 2) {
    if (distanceToSegment(x, y, p[i], p[i + 1], p[i + 2], p[i + 3]) <= reach) return true;
  }
  return false;
}

/** Topmost annotation under a PDF-space point, within `tolerance` points. */
export function hitTest(annotations, [x, y], tolerance) {
  for (let i = annotations.length - 1; i >= 0; i--) {
    const a = annotations[i];
    if (a.type === 'ink') {
      if (a.paths.some((p) => nearPath(p, x, y, a.width / 2 + tolerance))) return a;
      continue;
    }
    const [x1, y1, x2, y2] = bounds(a, tolerance);
    if (x < x1 || x > x2 || y < y1 || y > y2) continue;
    if (a.type === 'note' || a.type === 'field') return a;
    // Quads are axis-aligned in user space, so a per-quad box test is exact enough.
    const hit = a.quads.some((q) => {
      const xs = [q[0], q[2], q[4], q[6]];
      const ys = [q[1], q[3], q[5], q[7]];
      return x >= Math.min(...xs) - tolerance && x <= Math.max(...xs) + tolerance
        && y >= Math.min(...ys) - tolerance && y <= Math.max(...ys) + tolerance;
    });
    if (hit) return a;
  }
  return null;
}

// ---- freehand strokes ----------------------------------------------------------

const fmt = (v) => Math.round(v * 100) / 100;

/** Smooth SVG path through the points (quadratic curves through midpoints). */
export function inkPathD(p) {
  if (p.length < 2) return '';
  let d = `M${fmt(p[0])} ${fmt(p[1])}`;
  if (p.length === 2) return `${d}l0.01 0`;
  if (p.length === 4) return `${d}L${fmt(p[2])} ${fmt(p[3])}`;
  for (let i = 2; i < p.length - 2; i += 2) {
    d += `Q${fmt(p[i])} ${fmt(p[i + 1])} ${fmt((p[i] + p[i + 2]) / 2)} ${fmt((p[i + 1] + p[i + 3]) / 2)}`;
  }
  return `${d}L${fmt(p.at(-2))} ${fmt(p.at(-1))}`;
}

/** Ramer–Douglas–Peucker: drops points that don't change the stroke's shape by more than epsilon. */
export function simplify(points, epsilon) {
  if (points.length <= 4) return points.map(fmt);
  const count = points.length / 2;
  const keep = new Uint8Array(count);
  keep[0] = keep[count - 1] = 1;
  const stack = [[0, count - 1]];
  while (stack.length) {
    const [start, end] = stack.pop();
    let maxDistance = 0;
    let index = -1;
    for (let i = start + 1; i < end; i++) {
      const d = distanceToSegment(points[2 * i], points[2 * i + 1], points[2 * start], points[2 * start + 1], points[2 * end], points[2 * end + 1]);
      if (d > maxDistance) { maxDistance = d; index = i; }
    }
    if (maxDistance > epsilon && index > 0) {
      keep[index] = 1;
      stack.push([start, index], [index, end]);
    }
  }
  const out = [];
  for (let i = 0; i < count; i++) if (keep[i]) out.push(fmt(points[2 * i]), fmt(points[2 * i + 1]));
  return out;
}
