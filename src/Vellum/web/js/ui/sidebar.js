import { h } from '../dom.js';
import { icon } from '../icons.js';
import { ThumbnailPanel } from './thumbnails.js';

// Left sidebar: page thumbnails (which double as the page organiser) and the document's own outline.
// Each document gets its own panels, created lazily and kept while its tab is open. When a
// document's pages are rearranged it's rebuilt, so its panels are replaced (carrying over the
// thumbnails already drawn, the selection and the scroll position).

export class Sidebar {
  #panels = new WeakMap();
  #watched = new WeakSet();

  constructor(root, app, pageActions) {
    this.root = root;
    this.app = app;
    this.pageActions = pageActions;
    this.mode = localStorage.getItem('vellum.sidebar.mode') === 'outline' ? 'outline' : 'thumbs';
    this.isOpen = localStorage.getItem('vellum.sidebar.open') !== '0';

    this.thumbsTab = h('button', { class: 'seg-btn', role: 'tab', title: 'Page thumbnails', onClick: () => this.setMode('thumbs') },
      h('span', { html: icon('layout-grid', 16) }), h('span', { text: 'Pages' }));
    this.outlineTab = h('button', { class: 'seg-btn', role: 'tab', title: 'Document outline', onClick: () => this.setMode('outline') },
      h('span', { html: icon('list-tree', 16) }), h('span', { text: 'Outline' }));
    this.tabs = h('div', { class: 'seg sidebar-tabs', role: 'tablist' }, this.thumbsTab, this.outlineTab);
    this.pageMenuBtn = h('button', {
      class: 'tb-btn small page-menu-btn', title: 'Page tools', 'aria-label': 'Page tools', 'aria-haspopup': 'menu',
      html: icon('ellipsis', 16), onClick: () => this.pageActions.panelMenu(this.app.active, this.thumbs, this.pageMenuBtn),
    });
    this.body = h('div', { class: 'sidebar-body' });
    root.append(h('div', { class: 'sidebar-head' }, this.tabs, this.pageMenuBtn), this.body);

    app.addEventListener('activechange', () => this.render());
    app.addEventListener('viewready', () => this.render());
    app.addEventListener('viewchange', () => this.thumbs?.sync());
    this.#applyOpen();
    this.render();
  }

  /** The thumbnail panel of the active document, if it has been created. */
  get thumbs() {
    return this.#panelsFor(this.app.active)?.thumbs ?? null;
  }

  toggle(force) {
    this.isOpen = force ?? !this.isOpen;
    localStorage.setItem('vellum.sidebar.open', this.isOpen ? '1' : '0');
    this.#applyOpen();
    if (this.isOpen) this.render();
  }

  /** Opens the sidebar on the page thumbnails (used by page commands). */
  showPages() {
    if (!this.isOpen) this.toggle(true);
    if (this.mode !== 'thumbs') this.setMode('thumbs');
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
    const ready = view?.status === 'ready';
    this.pageMenuBtn.hidden = this.mode !== 'thumbs' || !ready;
    if (!ready) {
      this.body.replaceChildren(h('div', { class: 'panel-empty', text: view?.status === 'loading' ? '' : 'No document' }));
      return;
    }
    if (!this.#watched.has(view)) {
      this.#watched.add(view);
      view.addEventListener('documentchange', () => this.#rebuilt(view));
    }
    const panels = this.#panelsFor(view, true);
    let panel;
    if (this.mode === 'thumbs') {
      panels.thumbs ??= new ThumbnailPanel(view, { actions: this.pageActions, ...panels.carry });
      panels.carry = null;
      panel = panels.thumbs;
    } else {
      panel = panels.outline ??= new OutlinePanel(view);
    }
    if (panel.el.parentNode !== this.body) this.body.replaceChildren(panel.el);
    panel.shown?.();
  }

  #rebuilt(view) {
    const panels = this.#panelsFor(view);
    if (!panels) return;
    const old = panels.thumbs;
    if (old) {
      panels.carry = { cache: old.cache, selection: old.selectedIds, scrollTop: old.list.scrollTop };
      old.destroy();
    }
    panels.thumbs = null;
    panels.outline = null;
    if (view === this.app.active) this.render();
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
