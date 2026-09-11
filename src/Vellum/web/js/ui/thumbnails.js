import { h } from '../dom.js';
import { icon } from '../icons.js';

// Page thumbnails that double as a page organiser.
//   click            go to the page
//   Ctrl/Shift+click select several pages (Esc clears, Ctrl+A selects all)
//   drag             move the page (or all selected pages) to a new position
//   right-click      page actions; with pages selected, a bar at the bottom offers them too
// Thumbnails are keyed by page-plan entry id, so after pages are rearranged the ones already
// drawn are reused instead of redrawn.

const THUMB_CSS_WIDTH = 124;
const AUTOSCROLL_EDGE = 44;
const CACHE_LIMIT = 400;

export class ThumbnailPanel {
  #items = [];
  #visible = new Set();
  #queue = new Set();
  #busy = false;
  #viewRotation = 0;
  #activePage = 0;
  #selected;
  #anchor = null;
  #suppressClick = false;
  #shownOnce = false;
  #abort = new AbortController();

  /**
   * actions: page operations (see pages/actions.js). cache/selection/scrollTop carry state over
   * from the panel this one replaces after a rebuild.
   */
  constructor(view, { actions, cache = new Map(), selection = [], scrollTop = 0 }) {
    this.view = view;
    this.actions = actions;
    this.cache = cache;
    this.#selected = new Set(selection);
    this.#viewRotation = view.state.rotation;

    this.list = h('div', { class: 'thumbs', role: 'listbox', 'aria-label': 'Pages', 'aria-multiselectable': 'true', tabindex: '0' });
    this.caret = h('div', { class: 'thumb-caret', hidden: true });
    this.list.append(this.caret);
    this.barLabel = h('span', { class: 'page-bar-label' });
    const barButton = (iconName, label, run) => h('button', {
      class: 'tb-btn small', title: label, 'aria-label': label, html: icon(iconName, 16), onClick: () => run(this.targetIds()),
    });
    this.barButtons = [
      barButton('rotate-ccw', 'Rotate left', (ids) => actions.rotate(view, ids, -90)),
      barButton('rotate-cw', 'Rotate right', (ids) => actions.rotate(view, ids, 90)),
      barButton('copy-plus', 'Duplicate', (ids) => actions.duplicate(view, ids)),
      barButton('file-output', 'Extract to a new PDF…', (ids) => actions.extract(view, ids)),
      barButton('trash-2', 'Delete', (ids) => actions.remove(view, ids)),
    ];
    this.bar = h('div', { class: 'page-bar', hidden: true },
      h('div', { class: 'page-bar-head' }, this.barLabel, h('button', { class: 'link-btn', onClick: () => this.clearSelection() }, 'Clear')),
      h('div', { class: 'page-bar-actions' }, ...this.barButtons));
    this.el = h('div', { class: 'thumbs-panel' }, this.list, this.bar);
    this.observer = new IntersectionObserver((entries) => this.#onIntersect(entries), { root: this.list, rootMargin: '600px 0px' });

    const opts = { signal: this.#abort.signal };
    view.annotations.addEventListener('change', (e) => {
      if (e.detail.plan || view.rebuilding) return; // a rebuild replaces this panel
      for (const n of e.detail.pages) this.#invalidate(n);
      this.#pump();
    }, opts);
    this.list.addEventListener('click', (e) => this.#onClick(e), opts);
    this.list.addEventListener('pointerdown', (e) => this.#onPointerDown(e), opts);
    this.list.addEventListener('contextmenu', (e) => this.#onContextMenu(e), opts);
    this.list.addEventListener('keydown', (e) => this.#onKey(e), opts);
    this.#build(scrollTop);
  }

  /** Selected page ids in page order, or the current page's id when nothing is selected. */
  targetIds() {
    if (this.#selected.size) return this.#items.filter((i) => this.#selected.has(i.id)).map((i) => i.id);
    const current = this.#items[this.view.state.pageNumber - 1];
    return current ? [current.id] : [];
  }

  get selectedIds() { return [...this.#selected]; }

  selectAll() {
    for (const item of this.#items) this.#selected.add(item.id);
    this.#paintSelection();
  }

  clearSelection() {
    this.#selected.clear();
    this.#paintSelection();
  }

  shown() {
    // Centre the current page the first time; after a rebuild keep the scroll position.
    this.sync(!this.#shownOnce && !this.list.scrollTop);
    this.#shownOnce = true;
  }

  destroy() {
    this.#abort.abort();
    this.observer.disconnect();
  }

  /** Follows the document: current page, view rotation, rebuild in progress. */
  sync(force = false) {
    const { pageNumber, rotation, rebuilding, canEditPages } = this.view.state;
    this.el.classList.toggle('busy', rebuilding);
    for (const b of this.barButtons) b.disabled = !canEditPages;
    if (rotation !== this.#viewRotation) {
      this.#viewRotation = rotation;
      for (const item of this.#items) {
        item.rendered = false;
        item.key = `${item.baseKey}:${rotation}`;
      }
      for (const n of this.#visible) this.#queue.add(n);
      this.#pump();
    }
    if (pageNumber === this.#activePage && !force) return;
    const item = this.#items[pageNumber - 1];
    if (!item) return; // not built yet; #build syncs again
    this.#items[this.#activePage - 1]?.el.classList.remove('active');
    this.#activePage = pageNumber;
    item.el.classList.add('active');
    if (this.el.isConnected) item.el.scrollIntoView({ block: force ? 'center' : 'nearest', behavior: force ? 'instant' : 'smooth' });
  }

  /** Where a drop at this height would insert pages (0 = before the first). */
  insertionIndex(clientY) {
    for (let i = 0; i < this.#items.length; i++) {
      const r = this.#items[i].el.getBoundingClientRect();
      if (clientY < r.top + r.height / 2) return i;
    }
    return this.#items.length;
  }

  showCaret(index) {
    const at = this.#items[index]?.el;
    const last = this.#items.at(-1)?.el;
    if (!at && !last) return;
    this.caret.style.top = `${at ? at.offsetTop - 8 : last.offsetTop + last.offsetHeight + 8}px`;
    this.caret.hidden = false;
  }

  hideCaret() {
    this.caret.hidden = true;
  }

  // ---- building & drawing ---------------------------------------------------------

  async #build(scrollTop) {
    const pdf = this.view.pdf;
    const plan = this.view.shownPlan;
    const first = await pdf.getPage(1);
    const vp = first.getViewport({ scale: 1, rotation: (first.rotate + this.#viewRotation) % 360 });
    const ratio = `${vp.width} / ${vp.height}`;
    const fragment = document.createDocumentFragment();
    for (let n = 1; n <= pdf.numPages; n++) {
      const entry = plan?.[n - 1];
      const id = entry?.id ?? `page-${n}`;
      const frame = h('div', { class: 'thumb-frame', style: { aspectRatio: ratio } });
      frame.style.setProperty('--r', String(vp.width / vp.height)); // caps very tall pages (see CSS)
      const el = h('div', { class: 'thumb', role: 'option', title: `Page ${n}`, dataset: { page: n, id } },
        frame, h('span', { class: 'thumb-num', text: String(n) }));
      const baseKey = `${id}:${entry?.rotate ?? 0}`;
      const item = { n, id, baseKey, key: `${baseKey}:${this.#viewRotation}`, el, frame, rendered: false };
      const cached = this.cache.get(item.key);
      if (cached) {
        frame.style.aspectRatio = cached.ratio;
        frame.style.setProperty('--r', cached.r);
        frame.replaceChildren(cached.canvas);
        item.rendered = true;
      }
      this.#items.push(item);
      fragment.append(el);
    }
    this.list.append(fragment);
    const ids = new Set(this.#items.map((i) => i.id));
    for (const id of this.#selected) if (!ids.has(id)) this.#selected.delete(id);
    this.#paintSelection();
    for (const item of this.#items) this.observer.observe(item.el);
    this.list.scrollTop = scrollTop;
    this.sync(false);
  }

  #invalidate(n) {
    const item = this.#items[n - 1];
    if (!item) return;
    item.rendered = false;
    this.cache.delete(item.key);
    if (this.#visible.has(n)) this.#queue.add(n);
  }

  #onIntersect(entries) {
    for (const entry of entries) {
      const n = Number(entry.target.dataset.page);
      if (entry.isIntersecting) {
        this.#visible.add(n);
        if (!this.#items[n - 1].rendered) this.#queue.add(n);
      } else {
        this.#visible.delete(n);
        this.#queue.delete(n);
      }
    }
    this.#pump();
  }

  /** Draws queued thumbnails one at a time, after the main view has painted, in idle time. */
  async #pump() {
    if (this.#busy || this.#queue.size === 0 || this.#abort.signal.aborted || this.view.rebuilding) return;
    this.#busy = true;
    await this.view.firstRender;
    const n = Math.min(...this.#queue);
    this.#queue.delete(n);
    const item = this.#items[n - 1];
    try {
      if (item && !item.rendered && this.view.pdf) await this.#render(item);
    } catch { /* page failed to render; leave the placeholder */ }
    this.#busy = false;
    requestIdleCallback(() => this.#pump(), { timeout: 120 });
  }

  async #render(item) {
    const page = await this.view.pdf.getPage(item.n);
    const rotation = (page.rotate + this.#viewRotation) % 360;
    const base = page.getViewport({ scale: 1, rotation });
    const dpr = Math.min(devicePixelRatio || 1, 2);
    const viewport = page.getViewport({ scale: (THUMB_CSS_WIDTH * dpr) / base.width, rotation });
    const canvas = document.createElement('canvas');
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    await page.render({ canvas, canvasContext: canvas.getContext('2d'), viewport }).promise;
    if (this.#abort.signal.aborted) return;
    this.view.paintAnnotations(canvas.getContext('2d'), item.n, viewport);
    const ratio = `${viewport.width} / ${viewport.height}`;
    const r = String(viewport.width / viewport.height);
    item.frame.style.aspectRatio = ratio;
    item.frame.style.setProperty('--r', r);
    item.frame.replaceChildren(canvas);
    item.rendered = true;
    this.cache.set(item.key, { canvas, ratio, r });
    if (this.cache.size > CACHE_LIMIT) this.cache.delete(this.cache.keys().next().value);
  }

  // ---- selection ----------------------------------------------------------------

  #paintSelection() {
    for (const item of this.#items) {
      const on = this.#selected.has(item.id);
      item.el.classList.toggle('selected', on);
      item.el.setAttribute('aria-selected', String(on));
    }
    const count = this.#selected.size;
    this.bar.hidden = count === 0;
    this.barLabel.textContent = `${count} page${count === 1 ? '' : 's'} selected`;
  }

  #indexOf(id) {
    return Math.max(0, this.#items.findIndex((i) => i.id === id));
  }

  #onClick(e) {
    if (this.#suppressClick) return;
    const el = e.target.closest('.thumb');
    if (!el) return;
    const n = Number(el.dataset.page);
    const id = el.dataset.id;
    this.list.focus({ preventScroll: true });
    if (e.ctrlKey || e.metaKey) {
      if (!this.#selected.size) this.#selected.add(this.#items[this.view.state.pageNumber - 1]?.id);
      if (this.#selected.has(id)) this.#selected.delete(id);
      else this.#selected.add(id);
      this.#anchor = id;
    } else if (e.shiftKey) {
      const from = this.#indexOf(this.#anchor ?? this.#items[this.view.state.pageNumber - 1]?.id);
      this.#selected.clear();
      for (let i = Math.min(from, n - 1); i <= Math.max(from, n - 1); i++) this.#selected.add(this.#items[i].id);
    } else {
      this.#selected.clear();
      this.#anchor = id;
      this.view.goToPage(n, { pulse: true });
    }
    this.#selected.delete(undefined);
    this.#paintSelection();
  }

  #onKey(e) {
    if (e.key === 'Escape' && this.#selected.size) this.clearSelection();
    else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') this.selectAll();
    else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') this.view.goToPage(this.view.state.pageNumber + (e.key === 'ArrowDown' ? 1 : -1));
    else return;
    e.preventDefault();
  }

  #onContextMenu(e) {
    const el = e.target.closest('.thumb');
    e.preventDefault();
    e.stopPropagation();
    if (!el) return;
    if (!this.#selected.has(el.dataset.id)) {
      this.#selected.clear();
      this.#selected.add(el.dataset.id);
      this.#paintSelection();
    }
    this.actions.contextMenu(this.view, this.targetIds(), { x: e.clientX, y: e.clientY, index: Number(el.dataset.page) });
  }

  // ---- drag to reorder ------------------------------------------------------------

  #onPointerDown(e) {
    if (e.button !== 0 || !this.view.canEditPages) return;
    const el = e.target.closest('.thumb');
    if (!el) return;
    const start = [e.clientX, e.clientY];
    let drag = null;

    const autoscroll = () => {
      if (!drag || drag.done) return;
      const box = this.list.getBoundingClientRect();
      const direction = drag.y < box.top + AUTOSCROLL_EDGE ? -1 : drag.y > box.bottom - AUTOSCROLL_EDGE ? 1 : 0;
      if (direction) {
        this.list.scrollTop += direction * 14;
        drag.index = this.insertionIndex(drag.y);
        this.showCaret(drag.index);
      }
      requestAnimationFrame(autoscroll);
    };
    const move = (ev) => {
      if (!drag) {
        if (Math.hypot(ev.clientX - start[0], ev.clientY - start[1]) < 6) return;
        const ids = this.#selected.has(el.dataset.id) ? this.targetIds() : [el.dataset.id];
        drag = { ids, ghost: this.#ghost(el, ids.length), index: null, y: ev.clientY, done: false };
        this.el.classList.add('dragging');
        for (const item of this.#items) if (ids.includes(item.id)) item.el.classList.add('lifted');
        requestAnimationFrame(autoscroll);
      }
      drag.y = ev.clientY;
      drag.ghost.style.transform = `translate(${ev.clientX + 14}px, ${ev.clientY + 10}px)`;
      drag.index = this.insertionIndex(ev.clientY);
      this.showCaret(drag.index);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      if (!drag) return;
      drag.done = true;
      drag.ghost.remove();
      this.hideCaret();
      this.el.classList.remove('dragging');
      for (const item of this.#items) item.el.classList.remove('lifted');
      // The click that ends a drag isn't a click on a page.
      this.#suppressClick = true;
      setTimeout(() => { this.#suppressClick = false; });
      if (drag.index != null) this.actions.move(this.view, drag.ids, drag.index);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  /** A small copy of the dragged thumbnail that follows the pointer, with a count when several move. */
  #ghost(el, count) {
    const ghost = h('div', { class: 'thumb-ghost ui', 'aria-hidden': 'true' });
    const source = el.querySelector('canvas');
    if (source) {
      const copy = document.createElement('canvas');
      copy.width = source.width;
      copy.height = source.height;
      copy.getContext('2d').drawImage(source, 0, 0);
      ghost.append(copy);
    }
    if (count > 1) ghost.append(h('span', { class: 'thumb-ghost-count', text: String(count) }));
    document.getElementById('overlay-root').append(ghost);
    return ghost;
  }
}
