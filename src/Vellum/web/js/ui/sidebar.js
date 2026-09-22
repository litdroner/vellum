import { h } from '../dom.js';
import { icon } from '../icons.js';
import { StructurePanel } from './structure.js';
import { ThumbnailPanel } from './thumbnails.js';

// Left sidebar: page thumbnails (which double as the page organiser), the document's own outline and,
// once asked for, its structure (the semantic document model, read-only).
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
    this.hasStructure = false; // the Structure tab joins the others once it is first opened, for the session
    this.isOpen = localStorage.getItem('vellum.sidebar.open') !== '0';
    // In a narrow window the sidebar floats over the document (so the page keeps its width) and
    // starts closed; opening it there doesn't change the remembered wide-window choice.
    this.narrow = matchMedia('(max-width: 820px)');
    this.narrowOpen = false;
    this.narrow.addEventListener('change', () => {
      this.narrowOpen = false;
      this.#applyOpen();
      if (this.isShown) this.render();
    });

    this.thumbsTab = h('button', { class: 'seg-btn', role: 'tab', title: 'Page thumbnails', onClick: () => this.setMode('thumbs') },
      h('span', { html: icon('layout-grid', 16) }), h('span', { text: 'Pages' }));
    this.outlineTab = h('button', { class: 'seg-btn', role: 'tab', title: 'Document outline', onClick: () => this.setMode('outline') },
      h('span', { html: icon('list-tree', 16) }), h('span', { text: 'Outline' }));
    this.structureTab = h('button', { class: 'seg-btn', role: 'tab', title: 'Document structure', hidden: true, onClick: () => this.setMode('structure') },
      h('span', { html: icon('file-text', 16) }), h('span', { text: 'Structure' }));
    this.tabs = h('div', { class: 'seg sidebar-tabs', role: 'tablist' }, this.thumbsTab, this.outlineTab, this.structureTab);
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

  /** Whether the sidebar is on screen now. */
  get isShown() {
    return this.narrow.matches ? this.narrowOpen : this.isOpen;
  }

  toggle(force) {
    if (this.narrow.matches) {
      this.narrowOpen = force ?? !this.narrowOpen;
    } else {
      this.isOpen = force ?? !this.isOpen;
      localStorage.setItem('vellum.sidebar.open', this.isOpen ? '1' : '0');
    }
    this.#applyOpen();
    if (this.isShown) this.render();
  }

  /** Opens the sidebar on the page thumbnails (used by page commands). */
  showPages() {
    if (!this.isShown) this.toggle(true);
    if (this.mode !== 'thumbs') this.setMode('thumbs');
  }

  /** Opens the sidebar on the document's structure (the Document structure command). */
  showStructure() {
    this.hasStructure = true;
    if (!this.isShown) this.toggle(true);
    this.setMode('structure');
  }

  /** The structure panel of the active document, if it has been created. */
  get structure() {
    return this.#panelsFor(this.app.active)?.structure ?? null;
  }

  setMode(mode) {
    this.mode = mode;
    if (mode !== 'structure') localStorage.setItem('vellum.sidebar.mode', mode);
    this.render();
  }

  render() {
    this.thumbsTab.setAttribute('aria-selected', String(this.mode === 'thumbs'));
    this.outlineTab.setAttribute('aria-selected', String(this.mode === 'outline'));
    this.structureTab.setAttribute('aria-selected', String(this.mode === 'structure'));
    this.structureTab.hidden = !this.hasStructure;
    this.tabs.classList.toggle('compact', this.hasStructure);
    this.tabs.style.setProperty('--seg-count', this.hasStructure ? '3' : '2');
    this.tabs.style.setProperty('--seg-index', String(['thumbs', 'outline', 'structure'].indexOf(this.mode)));
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
    } else if (this.mode === 'structure') {
      panel = panels.structure ??= new StructurePanel(view);
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
    panels.structure?.documentChanged(); // the same panel reads again what changed
    if (view === this.app.active) this.render();
  }

  #panelsFor(view, create = false) {
    if (!view) return null;
    if (!this.#panels.has(view) && create) this.#panels.set(view, {});
    return this.#panels.get(view);
  }

  #applyOpen() {
    this.root.classList.toggle('collapsed', !this.isShown);
    this.root.classList.toggle('overlay', this.narrow.matches);
    this.root.setAttribute('aria-hidden', String(!this.isShown));
    this.root.inert = !this.isShown; // a hidden sidebar's buttons leave the Tab order too
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
        toggle.setAttribute('aria-label', open ? 'Collapse' : 'Expand');
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
