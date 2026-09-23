// The Crop dialog's picture of the page: the page as it is shown, with the rectangle that is kept drawn
// over it. Presentational only — it measures and draws, and says what the rectangle is; the crop itself
// is the page plan's `crop` setting, and pages/crop.js is the only place that turns one into the other.
//
// The rectangle is held in fractions of the shown page, so it survives the preview being any size, and
// is reported back in points of the shown page (pages/crop.js marginsFromRect). Dragging inside it moves
// it, dragging a handle resizes that edge or corner, and dragging outside it starts a new one. Every
// change fires an `input` event on the node, which is what the dialog already listens for.
//
//   cropPreview({ page, size, margins }) -> { node, size, set(margins), margins(), close() }
//     page     a pdf.js page, drawn at its own rotation; or null (the frame is then simply empty)
//     size     { width, height } of the shown page, in points
//     margins  the crop to start with, as the page is shown

import { h, clamp } from '../dom.js';
import { marginsFromRect, rectFromMargins } from '../pages/crop.js';

const MAX_WIDTH = 384;   // CSS pixels the preview may take in the dialog
const MAX_HEIGHT = 260;
const MIN_FRACTION = 0.02; // the rectangle never closes to nothing under the pointer

const HANDLES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];

export function cropPreview({ page = null, size, margins = null }) {
  const scale = Math.min(MAX_WIDTH / size.width, MAX_HEIGHT / size.height, 1);
  const width = Math.max(1, Math.round(size.width * scale));
  const height = Math.max(1, Math.round(size.height * scale));

  const canvas = h('canvas', { class: 'crop-page', width: String(width), height: String(height) });
  const rectEl = h('div', { class: 'crop-rect' }, ...HANDLES.map((at) => h('i', { class: `crop-handle crop-${at}`, 'data-handle': at })));
  const frame = h('div', { class: 'crop-frame' }, canvas, rectEl);
  frame.style.width = `${width}px`;
  frame.style.height = `${height}px`;
  const node = h('div', { class: 'crop-preview' }, frame,
    h('p', { class: 'crop-hint', text: 'Drag on the page to choose what to keep.' }));

  // The rectangle, in fractions of the shown page: { x, y, w, h }, x and y from its top-left.
  let box = fractionsOf(margins, size);

  const show = () => {
    rectEl.style.left = `${box.x * 100}%`;
    rectEl.style.top = `${box.y * 100}%`;
    rectEl.style.width = `${box.w * 100}%`;
    rectEl.style.height = `${box.h * 100}%`;
  };
  const changed = () => {
    show();
    node.dispatchEvent(new Event('input', { bubbles: true }));
  };

  // ---- drawing the page -------------------------------------------------------------------------
  let rendering = null;
  if (page) {
    const base = page.getViewport({ scale: 1, rotation: page.rotate });
    const viewport = page.getViewport({ scale: (width * (window.devicePixelRatio || 1)) / base.width, rotation: page.rotate });
    canvas.width = Math.max(1, Math.round(viewport.width));
    canvas.height = Math.max(1, Math.round(viewport.height));
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    rendering = page.render({ canvas, canvasContext: ctx, viewport });
    rendering.promise.catch(() => { /* a page that won't draw simply leaves the frame blank */ });
  }

  // ---- dragging ----------------------------------------------------------------------------------
  const at = (e) => {
    const r = frame.getBoundingClientRect();
    return { x: clamp((e.clientX - r.left) / r.width, 0, 1), y: clamp((e.clientY - r.top) / r.height, 0, 1) };
  };
  let drag = null;

  frame.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    const point = at(e);
    const handle = e.target.closest?.('.crop-handle')?.dataset.handle ?? null;
    // While the rectangle is still the whole page there is nothing to move, so a drag across it draws
    // the first one. Once it is smaller than the page, dragging inside it moves it.
    const whole = box.w > 0.999 && box.h > 0.999;
    if (handle) drag = { kind: 'resize', handle, box: { ...box } };
    else if (e.target === rectEl && !whole) drag = { kind: 'move', from: point, box: { ...box } };
    else drag = { kind: 'draw', from: point };
    frame.setPointerCapture(e.pointerId);
    e.preventDefault();
    if (drag.kind === 'draw') { box = { x: point.x, y: point.y, w: 0, h: 0 }; changed(); }
  });

  frame.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const point = at(e);
    if (drag.kind === 'draw') box = between(drag.from, point);
    else if (drag.kind === 'move') box = moved(drag.box, point.x - drag.from.x, point.y - drag.from.y);
    else box = resized(drag.box, drag.handle, point);
    changed();
  });

  const end = (e) => {
    if (!drag) return;
    // A click that drew nothing keeps the whole page rather than cropping it away.
    if (drag.kind === 'draw' && (box.w < MIN_FRACTION || box.h < MIN_FRACTION)) box = { x: 0, y: 0, w: 1, h: 1 };
    drag = null;
    if (e?.pointerId != null && frame.hasPointerCapture?.(e.pointerId)) frame.releasePointerCapture(e.pointerId);
    changed();
  };
  frame.addEventListener('pointerup', end);
  frame.addEventListener('pointercancel', end);

  show();

  return {
    node,
    size,
    /** Puts the rectangle where these shown margins leave it (the fields, edited by hand). */
    set(next) {
      const wanted = fractionsOf(next, size);
      if (Math.abs(wanted.x - box.x) < 1e-6 && Math.abs(wanted.y - box.y) < 1e-6
        && Math.abs(wanted.w - box.w) < 1e-6 && Math.abs(wanted.h - box.h) < 1e-6) return;
      box = wanted;
      show();
    },
    /** The crop the rectangle leaves, as the page is shown, in points. */
    margins() {
      return marginsFromRect({ x: box.x * size.width, y: box.y * size.height, width: box.w * size.width, height: box.h * size.height }, size);
    },
    close() {
      try { rendering?.cancel(); } catch { /* already finished */ }
      canvas.width = canvas.height = 0;
    },
  };
}

/** The rectangle these shown margins leave, in fractions of the page. */
function fractionsOf(margins, size) {
  if (!margins) return { x: 0, y: 0, w: 1, h: 1 };
  const rect = rectFromMargins(margins, size);
  return {
    x: clamp(rect.x / size.width, 0, 1),
    y: clamp(rect.y / size.height, 0, 1),
    w: clamp(rect.width / size.width, 0, 1),
    h: clamp(rect.height / size.height, 0, 1),
  };
}

const between = (a, b) => ({ x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(b.x - a.x), h: Math.abs(b.y - a.y) });

const moved = (box, dx, dy) => ({
  x: clamp(box.x + dx, 0, 1 - box.w),
  y: clamp(box.y + dy, 0, 1 - box.h),
  w: box.w,
  h: box.h,
});

/** One edge or corner dragged to `point`; the opposite edges stay where they are. */
function resized(box, handle, point) {
  let { x, y, w, h } = box;
  if (handle.includes('w')) { const right = x + w; x = clamp(point.x, 0, right - MIN_FRACTION); w = right - x; }
  if (handle.includes('e')) { w = clamp(point.x, x + MIN_FRACTION, 1) - x; }
  if (handle.includes('n')) { const bottom = y + h; y = clamp(point.y, 0, bottom - MIN_FRACTION); h = bottom - y; }
  if (handle.includes('s')) { h = clamp(point.y, y + MIN_FRACTION, 1) - y; }
  return { x, y, w, h };
}
