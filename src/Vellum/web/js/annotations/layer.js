import { h, clamp } from '../dom.js';
import { icon } from '../icons.js';
import { copySelection } from '../commands.js';
import { PALETTES } from './model.js';
import { selectionToQuads, bounds, hitTest, inkPathD, simplify, underlineSegments, NOTE_SIZE } from './geometry.js';

// Vellum's own annotation layer, one per document.
//
// Each rendered page gets two SVG overlays whose coordinate system *is* PDF user space (via the
// page viewport's transform), so they scale with zoom for free:
//   .vl-hl    highlights, blended with `multiply` like a real highlighter, below the text layer's hit area
//   .vl-marks underlines, ink, notes and selection outlines, on top
// Both ignore the mouse; clicks are hit-tested in PDF space instead, so selecting text over a
// highlight keeps working. In draw / note mode the top layer captures the pointer.

const SVG_NS = 'http://www.w3.org/2000/svg';
function svg(tag, attrs = {}) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, value);
  return el;
}

export const TOOLS = ['select', 'highlight', 'underline', 'note', 'ink'];

/** Tool colours and pen width: shared by every document and remembered between sessions. */
export const toolPrefs = (() => {
  const defaults = { highlight: PALETTES.highlight[0], underline: PALETTES.pen[0], note: PALETTES.note[0], ink: PALETTES.pen[1], inkWidth: 2 };
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem('vellum.tools') || '{}'); } catch { /* ignore */ }
  const prefs = { ...defaults, ...saved };
  Object.defineProperty(prefs, 'save', {
    value() {
      const { highlight, underline, note, ink, inkWidth } = prefs;
      try { localStorage.setItem('vellum.tools', JSON.stringify({ highlight, underline, note, ink, inkWidth })); } catch { /* ignore */ }
    },
  });
  return prefs;
})();

const noteDate = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });

export class AnnotationLayer extends EventTarget {
  tool = 'select';
  selectedId = null;

  #pages = new Map(); // page number → { div, hl, marks, hlGroup, marksGroup, uiGroup, shapes, ready }
  #observer;
  #stroke = null;
  #pendingNote = null;
  #popover = null;
  #editor = null;
  #lastInk = null;
  #hoverQueued = false;
  #suppressClick = false;

  constructor(view, store) {
    super();
    this.view = view;
    this.store = store;

    // pdf.js clears unknown children from a page when it re-renders (zoom, rotation);
    // put our overlays straight back, before the next paint. "Missing" means not inside the page,
    // not "not in the document": in single-page view pdf.js detaches every page that isn't shown,
    // and re-appending into a detached page would trigger this observer again, forever.
    this.#observer = new MutationObserver((records) => {
      for (const record of records) {
        for (const layer of this.#pages.values()) {
          if (layer.div === record.target && layer.hl.parentNode !== layer.div) record.target.append(layer.hl, layer.marks);
        }
      }
    });

    const bus = view.eventBus;
    bus.on('pagerendered', ({ pageNumber }) => this.#attach(pageNumber));
    bus.on('rotationchanging', () => requestAnimationFrame(() => {
      for (const n of this.#pages.keys()) this.#attach(n);
      this.#reposition();
    }));
    bus.on('scalechanging', () => requestAnimationFrame(() => this.#reposition()));

    store.addEventListener('change', (e) => {
      for (const n of e.detail.pages) this.#render(n);
      if (this.selectedId && !store.get(this.selectedId)) this.select(null);
    });

    const opts = { signal: view.signal };
    const c = view.container;
    c.addEventListener('pointerdown', (e) => this.#onPointerDown(e), opts);
    c.addEventListener('pointerup', (e) => this.#onPointerUp(e), opts);
    c.addEventListener('click', (e) => this.#onClick(e), opts);
    c.addEventListener('pointermove', (e) => this.#onHover(e), opts);
    c.addEventListener('keydown', (e) => this.#onKey(e), opts);
    document.addEventListener('selectionchange', () => {
      if (this.#popover?.kind === 'selection' && getSelection().isCollapsed) this.#closePopover();
    }, opts);
    document.addEventListener('pointerdown', (e) => {
      if (this.#editor && !this.#editor.el.contains(e.target)) this.#closeEditor(true);
      if (this.#popover && !this.#popover.el.contains(e.target)) this.#closePopover();
    }, { ...opts, capture: true });
  }

  // ---- public API ---------------------------------------------------------------

  setTool(tool) {
    if (!TOOLS.includes(tool)) return;
    this.tool = tool;
    this.view.el.dataset.tool = tool;
    this.select(null);
    this.#closePopover();
    if (tool === 'ink' || tool === 'note') getSelection()?.removeAllRanges();
    this.dispatchEvent(new Event('toolchange'));
  }

  select(id, { popover = true } = {}) {
    const previous = this.selectedId && this.store.get(this.selectedId);
    this.selectedId = id;
    if (previous) this.#render(previous.page);
    this.#closePopover();
    const a = id && this.store.get(id);
    if (a) {
      this.#render(a.page);
      if (popover && a.type !== 'note') this.#showAnnotationBar(a);
    }
    this.dispatchEvent(new Event('selectionchange'));
  }

  deleteSelected() {
    const id = this.selectedId;
    if (!id) return;
    this.select(null);
    this.store.remove(id);
  }

  /**
   * Drops every page overlay, popover and open note editor. Used when the document's pages are
   * rebuilt: page numbers on screen and in the store briefly disagree, so nothing may be drawn
   * or edited until the new pages render (then they re-attach as usual).
   */
  reset() {
    this.#closeEditor(false);
    this.#closePopover();
    this.#pendingNote = null;
    this.#stroke = null;
    this.selectedId = null;
    this.#observer.disconnect();
    for (const layer of this.#pages.values()) {
      layer.hl.remove();
      layer.marks.remove();
    }
    this.#pages.clear();
  }

  /** Turns the current text selection into highlight / underline annotations. */
  markSelection(type, color = toolPrefs[type]) {
    if (this.view.rebuilding) return false;
    const groups = selectionToQuads(this.view);
    if (!groups.length) return false;
    this.store.add(...groups.map((g) => this.store.create({ type, page: g.page, quads: g.quads, color })));
    getSelection().removeAllRanges();
    this.#closePopover();
    return true;
  }

  addNoteAt(clientX, clientY) {
    if (this.view.rebuilding) return;
    const at = this.#pageAt(document.elementFromPoint(clientX, clientY));
    if (!at) return;
    const [x, y] = this.#toPdf(at.pageView, clientX, clientY);
    const note = this.store.create({ type: 'note', page: at.n, point: [x - NOTE_SIZE / 2, y + NOTE_SIZE / 2], color: toolPrefs.note });
    this.#pendingNote = note;
    if (this.tool === 'note') this.setTool('select');
    this.#render(at.n);
    this.#openEditor(note, true);
  }

  editNote(id) {
    const a = this.store.get(id);
    if (a?.type === 'note') this.#openEditor(a, false);
  }

  hitAt(clientX, clientY) {
    const at = this.#pageAt(document.elementFromPoint(clientX, clientY));
    if (!at) return null;
    return hitTest(this.store.forPage(at.n), this.#toPdf(at.pageView, clientX, clientY), this.#tolerance(at.pageView));
  }

  // ---- page overlays -------------------------------------------------------------

  /** Attaches overlays to every page that has already rendered (after a rebuild finishes). */
  refresh() {
    const count = this.view.pdf?.numPages ?? 0;
    for (let n = 1; n <= count; n++) {
      if (this.view.viewer.getPageView(n - 1)?.renderingState === 3 /* finished */) this.#attach(n);
    }
  }

  #attach(n) {
    if (this.view.rebuilding) return; // the pages on screen are about to be replaced
    const pageView = this.view.viewer.getPageView(n - 1);
    if (!pageView?.div) return;
    let layer = this.#pages.get(n);
    if (!layer || layer.div !== pageView.div) {
      const hl = svg('svg', { class: 'vl-layer vl-hl', 'aria-hidden': 'true', preserveAspectRatio: 'none' });
      const marks = svg('svg', { class: 'vl-layer vl-marks', preserveAspectRatio: 'none' });
      const hlGroup = svg('g');
      const marksGroup = svg('g');
      const uiGroup = svg('g');
      hl.append(hlGroup);
      marks.append(marksGroup, uiGroup);
      layer = { div: pageView.div, hl, marks, hlGroup, marksGroup, uiGroup, shapes: new Map(), ready: false };
      this.#pages.set(n, layer);
      this.#observer.observe(pageView.div, { childList: true });
    }
    if (layer.hl.parentNode !== pageView.div) pageView.div.append(layer.hl, layer.marks);

    // viewBox in page points; the group transform maps PDF user space into it (flip + rotation).
    const unit = pageView.viewport.clone({ scale: 1 });
    const viewBox = `0 0 ${unit.width} ${unit.height}`;
    const matrix = `matrix(${unit.transform.join(' ')})`;
    layer.hl.setAttribute('viewBox', viewBox);
    layer.marks.setAttribute('viewBox', viewBox);
    for (const g of [layer.hlGroup, layer.marksGroup, layer.uiGroup]) g.setAttribute('transform', matrix);
    this.#render(n);
    layer.ready = true;
  }

  /** Keyed update: only annotations that changed get new elements (so nothing flickers). */
  #render(n) {
    const layer = this.#pages.get(n);
    if (!layer) return;
    const seen = new Set();
    for (const a of this.store.forPage(n)) {
      seen.add(a.id);
      const entry = layer.shapes.get(a.id);
      if (entry?.a === a) continue;
      const el = this.#shape(a);
      if (layer.ready) {
        el.classList.add('vl-new');
        el.addEventListener('animationend', () => el.classList.remove('vl-new'), { once: true });
      }
      if (entry) entry.el.replaceWith(el);
      else (a.type === 'highlight' ? layer.hlGroup : layer.marksGroup).append(el);
      layer.shapes.set(a.id, { a, el });
    }
    for (const [id, entry] of layer.shapes) {
      if (!seen.has(id)) {
        entry.el.remove();
        layer.shapes.delete(id);
      }
    }
    const ui = [];
    if (this.#pendingNote?.page === n) ui.push(this.#shape(this.#pendingNote));
    const selected = this.selectedId && this.store.get(this.selectedId);
    if (selected?.page === n) ui.push(this.#outline(selected));
    if (this.#stroke?.page === n) ui.push(this.#stroke.el);
    layer.uiGroup.replaceChildren(...ui);
  }

  #shape(a) {
    let el;
    switch (a.type) {
      case 'highlight':
        el = svg('path', {
          d: a.quads.map((q) => `M${q[0]} ${q[1]}L${q[2]} ${q[3]}L${q[6]} ${q[7]}L${q[4]} ${q[5]}Z`).join(''),
          fill: a.color,
        });
        break;
      case 'underline':
        el = svg('g', { stroke: a.color });
        for (const s of underlineSegments(a.quads)) {
          el.append(svg('line', { x1: s.x1, y1: s.y1, x2: s.x2, y2: s.y2, 'stroke-width': s.width }));
        }
        break;
      case 'ink':
        el = svg('path', {
          d: a.paths.map(inkPathD).join(''), fill: 'none', stroke: a.color,
          'stroke-width': a.width, 'stroke-linecap': 'round', 'stroke-linejoin': 'round',
        });
        break;
      default:
        el = this.#noteShape(a);
    }
    el.classList.add('vl-a');
    el.dataset.id = a.id;
    return el;
  }

  #noteShape(a) {
    // Icons are drawn y-down in a 20×20 box, then flipped into PDF space.
    const g = svg('g', { class: 'vl-note', transform: `translate(${a.point[0]} ${a.point[1]}) scale(1 -1)` });
    g.append(
      svg('rect', { x: 1, y: 2.2, width: 18, height: 18, rx: 3.5, fill: 'rgba(30, 20, 10, .28)' }),
      svg('rect', { x: 1, y: 1, width: 18, height: 18, rx: 3.5, fill: a.color, stroke: 'rgba(40, 30, 20, .55)', 'stroke-width': 0.8 }),
      svg('path', { d: 'M5 7h10M5 10.5h10M5 14h6.5', stroke: 'rgba(40, 30, 20, .7)', 'stroke-width': 1.1, 'stroke-linecap': 'round', fill: 'none' }));
    if (a.contents) {
      const title = svg('title');
      title.textContent = a.contents;
      g.append(title);
    }
    return g;
  }

  #outline(a) {
    const [x1, y1, x2, y2] = bounds(a, 2.5);
    return svg('rect', { class: 'vl-outline', x: x1, y: y1, width: x2 - x1, height: y2 - y1, rx: 2 });
  }

  // ---- coordinates ---------------------------------------------------------------

  #pageAt(element) {
    const div = element?.closest?.('.page');
    if (!div || !this.view.viewerEl.contains(div)) return null;
    const n = Number(div.dataset.pageNumber);
    const pageView = this.view.viewer.getPageView(n - 1);
    return pageView ? { n, pageView } : null;
  }

  #toPdf(pageView, clientX, clientY) {
    const box = pageView.div.getBoundingClientRect();
    const vp = pageView.viewport;
    return vp.convertToPdfPoint((clientX - box.left) * (vp.width / box.width), (clientY - box.top) * (vp.height / box.height));
  }

  /** About 5 screen pixels, in PDF points at the current zoom. */
  #tolerance(pageView) {
    return 5 / pageView.viewport.scale;
  }

  /** Where an annotation currently is on screen. */
  #clientRect(a) {
    const pageView = this.view.viewer.getPageView(a.page - 1);
    if (!pageView?.div) return null;
    const box = pageView.div.getBoundingClientRect();
    const vp = pageView.viewport;
    const s = box.width / vp.width;
    const [x1, y1, x2, y2] = bounds(a);
    const pts = [[x1, y1], [x2, y2], [x1, y2], [x2, y1]].map(([x, y]) => vp.convertToViewportPoint(x, y));
    const xs = pts.map((p) => p[0]);
    const ys = pts.map((p) => p[1]);
    return new DOMRect(box.left + Math.min(...xs) * s, box.top + Math.min(...ys) * s,
      (Math.max(...xs) - Math.min(...xs)) * s, (Math.max(...ys) - Math.min(...ys)) * s);
  }

  // ---- input -------------------------------------------------------------------

  #onPointerDown(e) {
    if (e.button !== 0) return;
    if (this.tool === 'ink') this.#startStroke(e);
    else if (this.tool === 'select') {
      const note = e.target.closest?.('.vl-note[data-id]');
      if (note) this.#startNoteDrag(e, note);
    }
  }

  #onPointerUp(e) {
    if (e.button !== 0 || this.tool === 'ink' || this.tool === 'note') return;
    // Let the browser settle the selection first.
    setTimeout(() => {
      const selection = getSelection();
      if (!selection || selection.isCollapsed || !this.view.container.contains(selection.anchorNode)) return;
      if (this.tool === 'highlight' || this.tool === 'underline') this.markSelection(this.tool);
      else this.#showSelectionBar();
    }, 10);
  }

  #onClick(e) {
    if (this.#suppressClick) {
      this.#suppressClick = false;
      return;
    }
    if (e.target.closest?.('.vl-pop, .vl-note-editor')) return;
    const at = this.#pageAt(e.target);
    if (this.tool === 'note') {
      if (at) this.addNoteAt(e.clientX, e.clientY);
      return;
    }
    if (this.tool !== 'select' || e.target.closest?.('.annotationLayer a')) return;
    if (!getSelection().isCollapsed) return;
    if (!at) {
      this.select(null);
      return;
    }
    const hit = hitTest(this.store.forPage(at.n), this.#toPdf(at.pageView, e.clientX, e.clientY), this.#tolerance(at.pageView));
    if (hit?.type === 'note') {
      this.select(hit.id, { popover: false });
      this.#openEditor(hit, false);
      return;
    }
    this.select(hit?.id ?? null);
  }

  /** Pointer cursor when hovering an annotation you can click. */
  #onHover(e) {
    if (this.tool !== 'select' || this.#hoverQueued || e.buttons) return;
    this.#hoverQueued = true;
    const { clientX, clientY, target } = e;
    requestAnimationFrame(() => {
      this.#hoverQueued = false;
      const at = this.#pageAt(target);
      let hit = null;
      if (at && getSelection().isCollapsed) {
        const list = this.store.forPage(at.n);
        if (list.length) hit = hitTest(list, this.#toPdf(at.pageView, clientX, clientY), this.#tolerance(at.pageView));
      }
      this.view.container.classList.toggle('vl-hover', Boolean(hit));
    });
  }

  #onKey(e) {
    if (e.key !== 'Escape' || e.target.closest?.('input, textarea')) return;
    if (this.selectedId) this.select(null);
    else if (this.tool !== 'select') this.setTool('select');
    else return;
    e.preventDefault();
  }

  // ---- drawing -----------------------------------------------------------------

  #startStroke(e) {
    const at = this.#pageAt(e.target);
    const layer = at && this.#pages.get(at.n);
    if (!layer) return;
    e.preventDefault();
    const target = layer.marks;
    target.setPointerCapture?.(e.pointerId);
    const color = toolPrefs.ink;
    const width = toolPrefs.inkWidth;
    const el = svg('path', {
      class: 'vl-ink-live', fill: 'none', stroke: color, 'stroke-width': width,
      'stroke-linecap': 'round', 'stroke-linejoin': 'round',
    });
    const stroke = { page: at.n, points: [...this.#toPdf(at.pageView, e.clientX, e.clientY)], el, color, width, last: [e.clientX, e.clientY] };
    this.#stroke = stroke;
    layer.uiGroup.append(el);
    el.setAttribute('d', inkPathD(stroke.points));

    const move = (ev) => {
      const events = ev.getCoalescedEvents?.();
      for (const p of events?.length ? events : [ev]) {
        if (Math.hypot(p.clientX - stroke.last[0], p.clientY - stroke.last[1]) < 1.5) continue;
        stroke.last = [p.clientX, p.clientY];
        stroke.points.push(...this.#toPdf(at.pageView, p.clientX, p.clientY));
      }
      el.setAttribute('d', inkPathD(stroke.points));
    };
    const end = () => {
      target.removeEventListener('pointermove', move);
      target.removeEventListener('pointerup', end);
      target.removeEventListener('pointercancel', end);
      this.#finishStroke();
    };
    target.addEventListener('pointermove', move);
    target.addEventListener('pointerup', end);
    target.addEventListener('pointercancel', end);
  }

  #finishStroke() {
    const stroke = this.#stroke;
    this.#stroke = null;
    if (!stroke) return;
    stroke.el.remove();
    const points = simplify(stroke.points, 0.25);
    const previous = this.#lastInk && this.store.get(this.#lastInk.id);
    // Strokes drawn in quick succession with the same pen become one ink annotation, as in Acrobat.
    if (previous && previous.page === stroke.page && previous.color === stroke.color
      && previous.width === stroke.width && Date.now() - this.#lastInk.time < 1500) {
      this.store.update(previous.id, { paths: [...previous.paths, points] });
    } else {
      const a = this.store.create({ type: 'ink', page: stroke.page, color: stroke.color, width: stroke.width, paths: [points] });
      this.store.add(a);
      this.#lastInk = { id: a.id };
    }
    this.#lastInk.time = Date.now();
  }

  #startNoteDrag(e, el) {
    const a = this.store.get(el.dataset.id);
    const at = this.#pageAt(e.target);
    if (!a || !at) return;
    e.preventDefault(); // no text selection while dragging a note
    const origin = this.#toPdf(at.pageView, e.clientX, e.clientY);
    const start = [e.clientX, e.clientY];
    let delta = null;
    const move = (ev) => {
      if (!delta && Math.hypot(ev.clientX - start[0], ev.clientY - start[1]) < 4) return;
      const p = this.#toPdf(at.pageView, ev.clientX, ev.clientY);
      delta = [p[0] - origin[0], p[1] - origin[1]];
      el.setAttribute('transform', `translate(${a.point[0] + delta[0]} ${a.point[1] + delta[1]}) scale(1 -1)`);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      if (delta) {
        this.#suppressClick = true;
        this.store.update(a.id, { point: [a.point[0] + delta[0], a.point[1] + delta[1]] });
      }
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  // ---- popovers ------------------------------------------------------------------

  #swatch(color, pressed, onPick, size = 22) {
    return h('button', {
      class: 'swatch', style: `--swatch:${color};width:${size}px;height:${size}px`, title: color,
      'aria-label': `Colour ${color}`, 'aria-pressed': String(pressed),
      onMousedown: (e) => e.preventDefault(), onClick: onPick,
    });
  }

  #popButton(iconName, label, action) {
    return h('button', {
      class: 'tb-btn small', title: label, 'aria-label': label, html: icon(iconName, 16),
      onMousedown: (e) => e.preventDefault(), onClick: action,
    });
  }

  /** Small bar over selected text: highlight colours, underline, copy. */
  #showSelectionBar() {
    const selection = getSelection();
    const rects = [...selection.getRangeAt(selection.rangeCount - 1).getClientRects()]
      .filter((r) => r.width > 1 && r.height > 1 && r.height < 300);
    if (!rects.length) return;
    const top = rects.reduce((m, r) => (r.top < m.top ? r : m));
    const el = h('div', { class: 'vl-pop ui', role: 'toolbar', 'aria-label': 'Selected text' },
      h('span', { class: 'vl-pop-icon', html: icon('highlighter', 15) }),
      ...PALETTES.highlight.map((color) => this.#swatch(color, color === toolPrefs.highlight, () => {
        toolPrefs.highlight = color;
        toolPrefs.save();
        this.markSelection('highlight', color);
      })),
      h('div', { class: 'vl-sep' }),
      this.#popButton('underline', 'Underline', () => this.markSelection('underline')),
      this.#popButton('copy', 'Copy', () => {
        copySelection();
        this.#closePopover();
      }));
    this.#openPopover(el, () => top, 'selection');
  }

  /** Bar for a selected annotation: colour and delete. */
  #showAnnotationBar(a) {
    const el = h('div', { class: 'vl-pop ui', role: 'toolbar', 'aria-label': 'Annotation' },
      ...PALETTES[a.type].map((color) => this.#swatch(color, color.toLowerCase() === a.color.toLowerCase(), () => {
        toolPrefs[a.type] = color;
        toolPrefs.save();
        this.store.update(a.id, { color });
        const updated = this.store.get(a.id);
        if (updated) this.#showAnnotationBar(updated);
      })),
      h('div', { class: 'vl-sep' }),
      this.#popButton('trash-2', 'Delete (Del)', () => this.deleteSelected()));
    this.#openPopover(el, () => this.#clientRect(this.store.get(a.id) ?? a), 'annotation');
  }

  #openPopover(el, anchor, kind) {
    this.#closePopover();
    this.#popover = { el, anchor, kind };
    this.view.container.append(el);
    this.#place(el, anchor(), 'above');
  }

  #closePopover() {
    this.#popover?.el.remove();
    this.#popover = null;
  }

  /** Positions an element inside the scroll container, so it scrolls with the page. */
  #place(el, rect, prefer) {
    if (!rect) return;
    const c = this.view.container;
    const box = c.getBoundingClientRect();
    const w = el.offsetWidth;
    const hgt = el.offsetHeight;
    const gap = 10;
    let top = prefer === 'above' ? rect.top - hgt - gap : rect.bottom + gap;
    if (prefer === 'above' && top < box.top + 6) top = rect.bottom + gap;
    if (prefer === 'below' && top + hgt > box.bottom - 6) top = Math.max(box.top + 6, rect.top - hgt - gap);
    const left = clamp(rect.left + rect.width / 2 - w / 2, box.left + 8, Math.max(box.left + 8, box.left + c.clientWidth - w - 8));
    el.style.left = `${left - box.left + c.scrollLeft}px`;
    el.style.top = `${top - box.top + c.scrollTop}px`;
  }

  #reposition() {
    if (this.#popover) {
      if (this.#popover.kind === 'selection') this.#closePopover();
      else this.#place(this.#popover.el, this.#popover.anchor(), 'above');
    }
    if (this.#editor) this.#place(this.#editor.el, this.#clientRect(this.#editorNote()), 'below');
  }

  // ---- sticky-note editor ------------------------------------------------------------

  #editorNote() {
    const editor = this.#editor;
    return editor.isNew ? this.#pendingNote ?? editor.note : this.store.get(editor.note.id) ?? editor.note;
  }

  #openEditor(note, isNew) {
    this.#closeEditor(true);
    const text = h('textarea', { class: 'vl-note-text', placeholder: 'Write a note…', spellcheck: 'true', 'aria-label': 'Note text' });
    text.value = note.contents || '';
    let color = note.color;
    const swatches = h('div', { class: 'vl-note-swatches' });
    const paintSwatches = () => swatches.replaceChildren(...PALETTES.note.map((c) => this.#swatch(c, c === color, () => {
      color = c;
      toolPrefs.note = c;
      toolPrefs.save();
      paintSwatches();
      if (isNew && this.#pendingNote) {
        this.#pendingNote = { ...this.#pendingNote, color };
        this.#render(note.page);
      }
    }, 18)));
    paintSwatches();

    const editor = { note, isNew, text, color: () => color };
    editor.el = h('div', { class: 'vl-note-editor ui', role: 'dialog', 'aria-label': 'Sticky note' },
      h('div', { class: 'vl-note-head' },
        h('strong', { text: note.author || 'Note' }),
        h('span', { text: noteDate.format(new Date(note.modified || Date.now())) })),
      text,
      h('div', { class: 'vl-note-foot' },
        swatches,
        h('span', { class: 'spacer' }),
        h('button', { class: 'link-btn danger', onClick: () => this.#deleteEditorNote() }, isNew ? 'Discard' : 'Delete'),
        h('button', { class: 'btn primary small', onClick: () => this.#closeEditor(true) }, 'Done')));
    text.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' || (e.key === 'Enter' && e.ctrlKey)) {
        e.preventDefault();
        e.stopPropagation();
        this.#closeEditor(true);
      }
    });
    this.#editor = editor;
    this.view.container.append(editor.el);
    this.#place(editor.el, this.#clientRect(note), 'below');
    text.focus({ preventScroll: true });
  }

  #closeEditor(save) {
    const editor = this.#editor;
    if (!editor) return;
    this.#editor = null;
    editor.el.remove();
    const contents = editor.text.value.trim();
    const color = editor.color();
    if (editor.isNew) {
      this.#pendingNote = null;
      // A note is only created once it has some text.
      if (save && contents) this.store.add({ ...editor.note, contents, color });
      else this.#render(editor.note.page);
    } else if (save) {
      const current = this.store.get(editor.note.id);
      if (current && (current.contents !== contents || current.color !== color)) this.store.update(current.id, { contents, color });
    }
    this.view.focus();
  }

  #deleteEditorNote() {
    const editor = this.#editor;
    if (!editor) return;
    this.#editor = null;
    editor.el.remove();
    if (editor.isNew) {
      this.#pendingNote = null;
      this.#render(editor.note.page);
    } else {
      this.select(null);
      this.store.remove(editor.note.id);
    }
    this.view.focus();
  }
}
