import { h } from '../dom.js';
import { icon } from '../icons.js';

// Left sidebar: page thumbnails and the document's own outline (table of contents).
// Each document gets its own panels, created lazily and kept while its tab is open.

const THUMB_CSS_WIDTH = 124;

export class Sidebar {
  #panels = new WeakMap();

  constructor(root, app) {
    this.root = root;
    this.app = app;
    this.mode = localStorage.getItem('vellum.sidebar.mode') === 'outline' ? 'outline' : 'thumbs';
    this.isOpen = localStorage.getItem('vellum.sidebar.open') !== '0';

    this.thumbsTab = h('button', { class: 'seg-btn', role: 'tab', title: 'Page thumbnails', onClick: () => this.setMode('thumbs') },
      h('span', { html: icon('layout-grid', 16) }), h('span', { text: 'Pages' }));
    this.outlineTab = h('button', { class: 'seg-btn', role: 'tab', title: 'Document outline', onClick: () => this.setMode('outline') },
      h('span', { html: icon('list-tree', 16) }), h('span', { text: 'Outline' }));
    this.body = h('div', { class: 'sidebar-body' });
    this.tabs = h('div', { class: 'seg sidebar-tabs', role: 'tablist' }, this.thumbsTab, this.outlineTab);
    root.append(h('div', { class: 'sidebar-head' }, this.tabs), this.body);

    app.addEventListener('activechange', () => this.render());
    app.addEventListener('viewready', () => this.render());
    app.addEventListener('viewchange', () => this.#panelsFor(app.active)?.thumbs?.sync());
    this.#applyOpen();
    this.render();
  }

  toggle(force) {
    this.isOpen = force ?? !this.isOpen;
    localStorage.setItem('vellum.sidebar.open', this.isOpen ? '1' : '0');
    this.#applyOpen();
    if (this.isOpen) this.render();
  }

  setMode(mode) {
    this.mode = mode;
    localStorage.setItem('vellum.sidebar.mode', mode);
    this.render();
  }

  render() {
    this.thumbsTab.setAttribute('aria-selected', String(this.mode === 'thumbs'));
    this.outlineTab.setAttribute('aria-selected', String(this.mode === 'outline'));
    this.tabs.style.setProperty('--seg-index', this.mode === 'outline' ? '1' : '0');
    const view = this.app.active;
    if (!view || view.status !== 'ready') {
      this.body.replaceChildren(h('div', { class: 'panel-empty', text: view?.status === 'loading' ? '' : 'No document' }));
      return;
    }
    const panels = this.#panelsFor(view, true);
    const panel = this.mode === 'thumbs'
      ? (panels.thumbs ??= new ThumbnailPanel(view))
      : (panels.outline ??= new OutlinePanel(view));
    if (panel.el.parentNode !== this.body) this.body.replaceChildren(panel.el);
    panel.shown?.();
  }

  #panelsFor(view, create = false) {
    if (!view) return null;
    if (!this.#panels.has(view) && create) this.#panels.set(view, {});
    return this.#panels.get(view);
  }

  #applyOpen() {
    this.root.classList.toggle('collapsed', !this.isOpen);
    this.root.setAttribute('aria-hidden', String(!this.isOpen));
  }
}

class ThumbnailPanel {
  #items = [];
  #visible = new Set();
  #queue = new Set();
  #busy = false;
  #rotation = 0;
  #activePage = 0;

  constructor(view) {
    this.view = view;
    this.el = h('div', { class: 'thumbs', role: 'listbox', 'aria-label': 'Pages' });
    this.observer = new IntersectionObserver((entries) => this.#onIntersect(entries), { root: this.el, rootMargin: '600px 0px' });
    this.#rotation = view.state.rotation;
    // Thumbnails show annotations too; redraw a page's thumbnail when its annotations change.
    view.annotations.addEventListener('change', (e) => {
      for (const n of e.detail.pages) {
        const item = this.#items[n - 1];
        if (!item) continue;
        item.rendered = false;
        if (this.#visible.has(n)) this.#queue.add(n);
      }
      this.#pump();
    });
    this.#build();
  }

  async #build() {
    const pdf = this.view.pdf;
    const first = await pdf.getPage(1);
    const vp = first.getViewport({ scale: 1, rotation: (first.rotate + this.#rotation) % 360 });
    const ratio = `${vp.width} / ${vp.height}`;
    const fragment = document.createDocumentFragment();
    for (let n = 1; n <= pdf.numPages; n++) {
      const frame = h('div', { class: 'thumb-frame', style: { aspectRatio: ratio } });
      const el = h('button', { class: 'thumb', role: 'option', title: `Page ${n}`, dataset: { page: n }, onClick: () => this.view.goToPage(n, { pulse: true }) },
        frame, h('span', { class: 'thumb-num', text: String(n) }));
      this.#items.push({ n, el, frame, rendered: false });
      fragment.append(el);
    }
    this.el.append(fragment);
    for (const item of this.#items) this.observer.observe(item.el);
    this.sync(true);
  }

  shown() {
    this.sync(true);
  }

  /** Follows the current page and rotation of the document. */
  sync(force = false) {
    const { pageNumber, rotation } = this.view.state;
    if (rotation !== this.#rotation) {
      this.#rotation = rotation;
      for (const item of this.#items) item.rendered = false;
      for (const n of this.#visible) this.#queue.add(n);
      this.#pump();
    }
    if (pageNumber === this.#activePage && !force) return;
    const item = this.#items[pageNumber - 1];
    if (!item) return; // thumbnails not built yet; #build syncs again when they are
    const previous = this.#items[this.#activePage - 1];
    previous?.el.classList.remove('active');
    previous?.el.setAttribute('aria-selected', 'false');
    this.#activePage = pageNumber;
    item.el.classList.add('active');
    item.el.setAttribute('aria-selected', 'true');
    if (this.el.isConnected) item.el.scrollIntoView({ block: force ? 'center' : 'nearest', behavior: force ? 'instant' : 'smooth' });
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

  /** Renders queued thumbnails one at a time, after the main view has painted, in idle time. */
  async #pump() {
    if (this.#busy || this.#queue.size === 0) return;
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
    const rotation = (page.rotate + this.#rotation) % 360;
    const base = page.getViewport({ scale: 1, rotation });
    const dpr = Math.min(devicePixelRatio || 1, 2);
    const viewport = page.getViewport({ scale: (THUMB_CSS_WIDTH * dpr) / base.width, rotation });
    const canvas = document.createElement('canvas');
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    await page.render({ canvas, canvasContext: canvas.getContext('2d'), viewport }).promise;
    this.view.paintAnnotations(canvas.getContext('2d'), item.n, viewport);
    item.frame.style.aspectRatio = `${viewport.width} / ${viewport.height}`;
    item.frame.replaceChildren(canvas);
    item.rendered = true;
  }
}

class OutlinePanel {
  constructor(view) {
    this.view = view;
    this.el = h('div', { class: 'outline' });
    this.#build();
  }

  async #build() {
    let outline = null;
    try { outline = await this.view.pdf.getOutline(); } catch { /* treat as none */ }
    if (!outline?.length) {
      this.el.append(h('div', { class: 'panel-empty' },
        h('span', { html: icon('list-tree', 22) }),
        h('strong', { text: 'No outline' }),
        h('span', { text: 'This document doesn’t include a table of contents.' })));
      return;
    }
    this.el.append(this.#list(outline, 0));
  }

  #list(items, depth) {
    const list = h('ul', { class: 'outline-list', role: depth === 0 ? 'tree' : 'group' });
    for (const item of items) {
      const hasChildren = item.items?.length > 0;
      const li = h('li', { class: 'outline-item', role: 'treeitem' });
      const toggle = hasChildren
        ? h('button', { class: 'outline-toggle', 'aria-label': 'Expand', html: icon('chevron-right', 14), onClick: () => setOpen(!li.classList.contains('open')) })
        : h('span', { class: 'outline-toggle' });
      const link = h('button', { class: 'outline-link', title: item.title, onClick: () => this.#navigate(item) }, item.title || 'Untitled');
      if (item.bold) link.classList.add('bold');
      if (item.italic) link.classList.add('italic');
      li.append(h('div', { class: 'outline-row', style: { paddingInlineStart: `${4 + depth * 14}px` } }, toggle, link));
      const setOpen = (open) => {
        li.classList.toggle('open', open);
        li.setAttribute('aria-expanded', String(open));
      };
      if (hasChildren) {
        li.append(this.#list(item.items, depth + 1));
        // A positive /Count in the PDF means "shown expanded by default".
        setOpen(item.count > 0 && depth === 0);
      }
      list.append(li);
    }
    return list;
  }

  #navigate(item) {
    if (item.dest) this.view.goToDestination(item.dest);
    else if (item.url) window.open(item.url, '_blank');
  }
}
