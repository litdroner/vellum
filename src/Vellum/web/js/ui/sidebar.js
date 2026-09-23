import { h } from '../dom.js';
import { icon } from '../icons.js';
import {
  addBookmark, moveBookmark, nestBookmark, newBookmark, outlineTree, readOutline, removeBookmark, updateBookmark,
} from '../pages/outline.js';
import { StructurePanel } from './structure.js';
import { ThumbnailPanel } from './thumbnails.js';

// Left sidebar: page thumbnails (which double as the page organiser), the document's outline (read and
// edited as one list, see pages/outline.js) and,
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

  /** Opens the Structure tab asking a research question of the document (the Research command). */
  showResearch() {
    this.showStructure();
    this.structure?.setResearch(true);
  }

  /** The structure panel of the active document, if it has been created. */
  get structure() {
    return this.#panelsFor(this.app.active)?.structure ?? null;
  }

  /** The outline panel of the active document, if it has been created. */
  get outline() {
    return this.#panelsFor(this.app.active)?.outline ?? null;
  }

  /** Opens the Outline tab and adds a bookmark for the page on screen (the Add bookmark command). */
  showOutline({ add = false } = {}) {
    if (!this.isShown) this.toggle(true);
    this.setMode('outline');
    if (add) this.outline?.addHere();
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
    panels.outline?.destroy();
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

// The Outline tab of the sidebar: the document's bookmarks, read once when it opens and edited from
// then on as the one list pages/outline.js defines. Selecting a bookmark goes to its page; the row's
// buttons rename it, move it among its siblings, nest it under the one above, send it to the page on
// screen, or remove it with everything under it. Every change goes through the edit store, so it is
// one Ctrl+Z, and it reaches the file only when the file is saved (writeOutline).
//
// A protected PDF can't be rewritten, so its outline is shown exactly as before: read-only.
class OutlinePanel {
  #editing = null; // the id of the bookmark whose title is being typed
  #onChange = null;

  constructor(view) {
    this.view = view;
    this.el = h('div', { class: 'outline' });
    this.#onChange = (e) => { if (e.detail.outline) this.render(); };
    view.annotations.addEventListener('change', this.#onChange);
    this.#build();
  }

  destroy() {
    this.view.annotations.removeEventListener('change', this.#onChange);
  }

  get editable() { return this.view.canEditPages; }

  /** The list, read once if the document hasn't finished reading it yet. */
  get list() { return this.view.annotations.outline ?? []; }

  async #build() {
    // initOutline runs as the document opens; wait for it before drawing an empty outline.
    if (this.view.annotations.outline === null) {
      try { this.view.annotations.initOutline(await readOutline(this.view.pdf)); } catch { this.view.annotations.initOutline([]); }
    }
    this.render();
  }

  render() {
    const list = this.list;
    const parts = [];
    if (this.editable) {
      parts.push(h('div', { class: 'outline-bar' },
        h('button', {
          class: 'btn small', title: 'Add a bookmark for the page on screen',
          onClick: () => this.#add(),
        }, h('span', { html: icon('plus', 14) }), 'Add bookmark')));
    }
    if (!list.length) {
      parts.push(h('div', { class: 'panel-empty' },
        h('span', { html: icon('list-tree', 22) }),
        h('strong', { text: 'No outline' }),
        h('span', {
          text: this.editable
            ? 'This document doesn’t include a table of contents. Add a bookmark to start one.'
            : 'This document doesn’t include a table of contents.',
        })));
    } else {
      parts.push(this.#list(outlineTree(list), 0));
    }
    this.el.replaceChildren(...parts);
    if (this.#editing) this.el.querySelector(`.outline-title-input[data-id="${CSS.escape(this.#editing)}"]`)?.select();
  }

  /** Applies one change to the list: one undo step (annotations/model.js applyOutline). */
  #apply(next) {
    if (!this.editable) return;
    const list = this.list;
    if (next.length === list.length && next.every((item, i) => item === list[i])) return;
    this.view.annotations.applyOutline(next);
  }

  /** Adds a bookmark for the page on screen and starts typing its name. */
  addHere() {
    this.#add();
  }

  #add() {
    const page = this.view.state?.pageNumber ?? this.view.viewer?.currentPageNumber ?? 1;
    const bookmark = newBookmark({ title: `Page ${page}`, page });
    this.#editing = bookmark.id;
    this.#apply(addBookmark(this.list, bookmark, this.list.at(-1)?.id ?? null));
  }

  #list(nodes, depth) {
    const list = h('ul', { class: 'outline-list', role: depth === 0 ? 'tree' : 'group' });
    for (const item of nodes) {
      const hasChildren = item.children.length > 0;
      const li = h('li', { class: 'outline-item', role: 'treeitem' });
      const toggle = hasChildren
        ? h('button', { class: 'outline-toggle', 'aria-label': 'Expand', html: icon('chevron-right', 14), onClick: () => setOpen(!li.classList.contains('open')) })
        : h('span', { class: 'outline-toggle' });
      const row = h('div', { class: 'outline-row', style: { paddingInlineStart: `${4 + depth * 14}px` } }, toggle, this.#label(item));
      if (this.editable) row.append(this.#rowTools(item));
      li.append(row);
      const setOpen = (open) => {
        li.classList.toggle('open', open);
        li.setAttribute('aria-expanded', String(open));
        toggle.setAttribute('aria-label', open ? 'Collapse' : 'Expand');
      };
      if (hasChildren) {
        li.append(this.#list(item.children, depth + 1));
        setOpen(true);
      }
      list.append(li);
    }
    return list;
  }

  /** The bookmark's title: the button that goes to its page, or the field that renames it. */
  #label(item) {
    if (this.#editing === item.id) {
      const input = h('input', {
        class: 'field outline-title-input', type: 'text', spellcheck: 'false', 'data-id': item.id,
        'aria-label': 'Bookmark title', value: item.title,
      });
      const commit = (save) => {
        if (this.#editing !== item.id) return;
        this.#editing = null;
        const title = input.value.trim();
        if (save && title && title !== item.title) this.#apply(updateBookmark(this.list, item.id, { title }));
        else this.render();
      };
      input.addEventListener('blur', () => commit(true));
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); commit(true); }
        else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); commit(false); }
      });
      queueMicrotask(() => input.select());
      return input;
    }
    const where = Number.isInteger(item.page) ? `Page ${item.page}` : item.url ? item.url : 'No destination';
    const link = h('button', {
      class: 'outline-link', title: `${item.title || 'Untitled'} — ${where}`,
      onClick: () => this.#navigate(item),
      onDblclick: () => this.#rename(item.id),
    }, item.title || 'Untitled');
    if (item.bold) link.classList.add('bold');
    if (item.italic) link.classList.add('italic');
    if (!Number.isInteger(item.page) && !item.url) link.classList.add('outline-link-empty');
    return link;
  }

  #rowTools(item) {
    const button = (glyph, label, run) => h('button', {
      class: 'outline-tool', title: label, 'aria-label': `${label}: ${item.title || 'Untitled'}`,
      html: icon(glyph, 13), onClick: (e) => { e.stopPropagation(); run(); },
    });
    const page = this.view.state?.pageNumber ?? this.view.viewer?.currentPageNumber ?? 1;
    return h('div', { class: 'outline-tools' },
      button('chevron-up', 'Move up', () => this.#apply(moveBookmark(this.list, item.id, -1))),
      button('chevron-down', 'Move down', () => this.#apply(moveBookmark(this.list, item.id, 1))),
      button('chevron-left', 'Move out one level', () => this.#apply(nestBookmark(this.list, item.id, -1))),
      button('chevron-right', 'Nest under the bookmark above', () => this.#apply(nestBookmark(this.list, item.id, 1))),
      button('type', 'Rename', () => this.#rename(item.id)),
      button('file-text', `Send to page ${page}`, () => this.#apply(updateBookmark(this.list, item.id, { page, url: null }))),
      button('trash-2', 'Delete, with anything under it', () => this.#apply(removeBookmark(this.list, item.id))));
  }

  #rename(id) {
    this.#editing = id;
    this.render();
  }

  #navigate(item) {
    if (Number.isInteger(item.page)) this.view.goToPage?.(item.page);
    else if (item.url) window.open(item.url, '_blank');
  }
}
