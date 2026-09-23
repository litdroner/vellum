import { h, prettyKeys, debounce } from '../dom.js';
import { icon } from '../icons.js';
import { availability } from '../requirements.js';
import { comboFromEvent } from '../shortcuts.js';
import { CATEGORIES, TOOLS, COMMAND_FIELDS, toolCommands, toolFields } from '../catalog/catalog.js';
import { indexItems, rank } from '../catalog/search.js';
import { createToolPrefs, FAVORITES_LIMIT } from '../catalog/store.js';
import { modalOpen, openModal } from './focus.js';
import { toast } from './dialogs.js';

// Tools: everything Vellum can do, found by what you want to get done (docs/TOOLS_UX_SPEC.md). A modal
// sheet over whatever is showing, loaded the first time it opens. What it lists is the catalog's data
// (catalog/catalog.js); it finds with the palette's search (catalog/search.js); whether a tool can run now
// is its command's own answer (requirements.js). Running a tool is running its command, after the sheet has
// closed and handed focus back. Nothing here knows what a particular tool does, needs or means.

const OWN = 'app.tools'; // the command that opens this sheet: its keys close it again
const MAX_TOOLS = 12; // search results: tools first, this many at most…
const MAX_COMMANDS = 5; // …then commands that aren't tools
const CHIPS = 6; // favourites, then recent, on the landing
const CLOSE_MS = 200; // fading out, then removed: a fixed time, never transitionend (Reduce motion has none)

/** The categories shown: never a reserved one (Automate), nor one with nothing in it. */
const CATEGORY_LIST = CATEGORIES.filter((c) => !c.reserved && TOOLS.some((t) => t.category === c.id));
const TOOL = new Map(TOOLS.map((t) => [t.id, t]));
const TOOL_COMMANDS = new Set(TOOLS.flatMap(toolCommands));

let serial = 0;
const nextId = (what) => `tools-${what}-${++serial}`;

/** localStorage, or nothing where the page may not use it (favourites and recent then aren't kept). */
function pageStorage() {
  try { return localStorage; } catch { return null; }
}

export class ToolsSheet {
  #app;
  #commands;
  #snapshot;
  #selectedPages;
  #findInDocument;
  #searchCommands;
  #prefs = createToolPrefs(pageStorage());
  #narrow = matchMedia('(max-width: 719px)');
  #toolIndex = null; // the catalog, indexed for search once
  #commandIndex = null; // commands that aren't tools, indexed per opening (they depend on the document)
  #close = null; // openModal's close(), while open
  #els = null; // the sheet's parts, while open
  #leaving = null; // the sheet fading out: removed at once if Tools opens again, so no id is ever there twice
  #resize = null;
  #snap = null; // the app's state when the sheet opened (requirements.js)
  #avail = new Map(); // command id → availability, from #snap
  #pages = []; // page numbers selected in the thumbnails when the sheet opened
  #view = 'home'; // what the rail shows: 'home', 'favorites', 'recent' or a category id
  #results = []; // the options listed while searching: { off, run }
  #active = 0;
  #announceCount = debounce((text) => this.#announce(text), 300);

  /**
   * snapshot(): the app's state for requirements.js; selectedPages(): the page numbers selected in the
   * thumbnails; findInDocument(text), searchCommands(text): where an empty search can go on.
   */
  constructor({ app, commands, snapshot, selectedPages, findInDocument, searchCommands }) {
    this.#app = app;
    this.#commands = commands;
    this.#snapshot = snapshot;
    this.#selectedPages = selectedPages;
    this.#findInDocument = findInDocument;
    this.#searchCommands = searchCommands;
  }

  get isOpen() { return Boolean(this.#close); }

  /** Opens on the landing, a category ({ category }) or a search ({ query }). False over another modal. */
  open({ category = null, query = '' } = {}) {
    if (this.isOpen) {
      if (CATEGORY_LIST.some((c) => c.id === category)) this.#show(category);
      if (query) this.#setQuery(query);
      this.#els.input.focus();
      return true;
    }
    if (modalOpen()) return false;
    this.#leaving?.remove();
    this.#leaving = null;
    // Read before anything moves: focus and, with it, the page's text selection.
    this.#readState();
    this.#view = CATEGORY_LIST.some((c) => c.id === category) ? category : 'home';
    this.#build();
    this.#close = openModal(this.#els.backdrop, { dialog: this.#els.sheet, onEscape: () => this.#escape() });
    if (!this.#close) {
      this.#els = null;
      return false;
    }
    this.#els.input.focus();
    this.#renderRail();
    this.#els.rail.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    this.#setQuery(query);
    this.#app.addEventListener('viewready', this.#onAppChange);
    this.#app.addEventListener('activechange', this.#onAppChange);
    this.#narrow.addEventListener('change', this.#onNarrow);
    this.#resize = new ResizeObserver(() => this.#placePill(false));
    this.#resize.observe(this.#els.rail);
    return true;
  }

  close() {
    const close = this.#close;
    if (!close) return;
    const { backdrop } = this.#els;
    this.#close = null;
    this.#els = null;
    this.#announceCount.cancel();
    this.#resize.disconnect();
    this.#app.removeEventListener('viewready', this.#onAppChange);
    this.#app.removeEventListener('activechange', this.#onAppChange);
    this.#narrow.removeEventListener('change', this.#onNarrow);
    backdrop.classList.add('closing');
    this.#leaving = backdrop;
    setTimeout(() => {
      backdrop.remove();
      if (this.#leaving === backdrop) this.#leaving = null;
    }, CLOSE_MS);
    close(); // the app back, focus back where it was, the text selection back
  }

  // ---- state ------------------------------------------------------------------------------

  #readState() {
    this.#snap = this.#snapshot();
    this.#avail.clear();
    this.#commandIndex = null;
    this.#pages = this.#selectedPages();
  }

  /** Whether command `id` can run now: { present, available, reason, unmet } (requirements.js). */
  #can(id) {
    let a = this.#avail.get(id);
    if (!a) this.#avail.set(id, a = availability(this.#commands[id], this.#snap));
    return a;
  }

  /** A tool whose command's provider isn't on this PC isn't listed anywhere. */
  #listed = (t) => this.#can(t.command).present;
  #toolsIn = (category) => TOOLS.filter((t) => t.category === category.id && this.#listed(t));
  #iconOf = (t) => t.icon ?? this.#commands[t.command]?.icon ?? 'command';
  #keysOf = (id) => { const c = this.#commands[id]; return c?.hint ?? c?.keys?.[0] ?? null; };

  #onAppChange = () => {
    if (!this.isOpen) return;
    this.#redraw(() => {
      this.#readState();
      this.#renderRail();
      if (this.#els.input.value.trim()) this.#renderResults();
      else this.#renderView(false);
    });
  };

  /** Runs `draw`; if it took away what had focus, focus goes to the same place's equivalent, never to the page. */
  #redraw(draw) {
    const { sheet, rail, panel, input } = this.#els;
    const from = rail.contains(document.activeElement) ? 'rail' : panel.contains(document.activeElement) ? 'panel' : null;
    draw();
    if (sheet.contains(document.activeElement)) return;
    const tab = rail.querySelector('[aria-selected="true"]');
    const cell = panel.hidden ? null : panel.querySelector('[data-cell][tabindex="0"]');
    const target = from === 'panel' ? cell ?? tab : from === 'rail' ? tab : null;
    (target ?? input).focus();
  }

  #onNarrow = () => {
    this.#els?.rail.setAttribute('aria-orientation', this.#narrow.matches ? 'horizontal' : 'vertical');
    this.#placePill(false);
  };

  // ---- the sheet --------------------------------------------------------------------------

  #build() {
    const titleId = nextId('title');
    const closeKeys = this.#keysOf(OWN);
    const input = h('input', {
      class: 'tools-input', type: 'search', spellcheck: 'false', autocomplete: 'off',
      placeholder: 'What do you want to do?', 'aria-label': 'Search tools',
      role: 'combobox', 'aria-expanded': 'false', 'aria-controls': 'tools-results', 'aria-autocomplete': 'list',
    });
    const field = h('div', { class: 'tools-field' },
      h('span', { class: 'tools-field-icon', html: icon('search', 18) }), input,
      closeKeys ? h('kbd', { text: prettyKeys(closeKeys), 'aria-hidden': 'true' }) : null);
    const pill = h('span', { class: 'tools-pill', 'aria-hidden': 'true' });
    const rail = h('div', {
      class: 'tools-rail', role: 'tablist', 'aria-label': 'Categories',
      'aria-orientation': this.#narrow.matches ? 'horizontal' : 'vertical',
    });
    const panel = h('div', { class: 'tools-panel', id: 'tools-panel', role: 'tabpanel' });
    const list = h('div', { class: 'tools-list', id: 'tools-results', role: 'listbox', 'aria-label': 'Tools found' });
    const results = h('div', { class: 'tools-results tools-fade', hidden: true }, list);
    const content = h('div', { class: 'tools-content' }, panel, results);
    const status = h('div', { class: 'vl-sr-only', role: 'status', 'aria-live': 'polite' });
    const closeBtn = h('button', { class: 'tb-btn tools-close', 'aria-label': 'Close Tools', title: 'Close (Esc)', html: icon('x', 18), onClick: () => this.close() });
    // Focusable (not a Tab stop), so a click on its empty space keeps focus, and with it Esc and its keys, in the sheet.
    const sheet = h('div', { class: 'tools-sheet', role: 'dialog', 'aria-labelledby': titleId, tabindex: '-1' },
      h('h2', { class: 'vl-sr-only', id: titleId, text: 'Tools' }),
      h('div', { class: 'tools-head' }, field),
      h('div', { class: 'tools-body' }, rail, content),
      closeBtn,
      status);
    const backdrop = h('div', { class: 'tools-backdrop ui' }, sheet);

    backdrop.addEventListener('mousedown', (e) => { if (e.target === backdrop) this.close(); });
    field.addEventListener('mousedown', (e) => { if (e.target !== input) { e.preventDefault(); input.focus(); } });
    input.addEventListener('input', () => this.#renderQuery());
    input.addEventListener('keydown', (e) => this.#onInputKey(e));
    rail.addEventListener('click', (e) => { const tab = e.target.closest('[role="tab"]'); if (tab) this.#show(tab.dataset.view); });
    rail.addEventListener('keydown', (e) => this.#onRailKey(e));
    // Narrow, the rail is a row with no scrollbar: a vertical wheel scrolls it sideways, as the tab strip does.
    rail.addEventListener('wheel', (e) => {
      if (!this.#narrow.matches || Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
      rail.scrollLeft += e.deltaY;
      e.preventDefault();
    }, { passive: false });
    panel.addEventListener('keydown', (e) => this.#onPanelKey(e));
    panel.addEventListener('focusin', (e) => { if (e.target.matches('[data-cell]')) this.#rove(e.target); });
    list.addEventListener('mousedown', (e) => e.preventDefault()); // focus stays in the search field
    list.addEventListener('mousemove', (e) => {
      const option = e.target.closest('[role="option"]');
      if (option) this.#setActive(Number(option.dataset.index), false);
    });
    list.addEventListener('click', (e) => {
      const option = e.target.closest('[role="option"]');
      if (option) this.#runOption(Number(option.dataset.index));
    });
    sheet.addEventListener('keydown', (e) => this.#onSheetKey(e));
    this.#els = { backdrop, sheet, input, rail, pill, panel, results, list, content, status };
  }

  #escape() {
    const { input } = this.#els;
    if (!input.value) return this.close();
    this.#setQuery('');
    input.focus();
  }

  #onSheetKey(e) {
    if ((this.#commands[OWN]?.keys ?? []).includes(comboFromEvent(e))) {
      e.preventDefault();
      e.stopPropagation();
      this.close();
      return;
    }
    // Typing anywhere in the sheet goes to the search field.
    const { input } = this.#els;
    if (e.target !== input && e.key.length === 1 && e.key !== ' ' && !e.ctrlKey && !e.altKey && !e.metaKey) {
      e.preventDefault();
      input.focus();
      input.value += e.key;
      this.#renderQuery();
    }
  }

  // ---- the rail -----------------------------------------------------------------------------

  #renderRail() {
    const favorites = this.#prefs.favorites().filter((id) => this.#listed(TOOL.get(id)));
    const recent = this.#prefs.recent().filter((id) => this.#listed(TOOL.get(id)));
    const items = [{ id: 'home', name: 'Home', icon: 'house' }];
    // Only once there are some (or while they are the view on show).
    if (favorites.length || this.#view === 'favorites') items.push({ id: 'favorites', name: 'Favorites', icon: 'star', count: favorites.length });
    if (recent.length || this.#view === 'recent') items.push({ id: 'recent', name: 'Recent', icon: 'clock' });
    items.push('-');
    for (const c of CATEGORY_LIST) items.push({ id: c.id, name: c.name, icon: c.icon, count: this.#toolsIn(c).length });
    const tabs = items.map((item) => {
      if (item === '-') return h('span', { class: 'tools-rail-sep', role: 'none' });
      const selected = item.id === this.#view;
      return h('button', {
        class: 'tools-tab', role: 'tab', id: `tools-tab-${item.id}`, tabindex: selected ? '0' : '-1',
        'aria-selected': String(selected), 'aria-controls': 'tools-panel', dataset: { view: item.id },
        'aria-label': item.count != null ? `${item.name}, ${item.count} ${item.count === 1 ? 'tool' : 'tools'}` : null,
      },
      h('span', { class: 'tools-tab-icon', html: icon(item.icon, 16) }),
      h('span', { class: 'tools-tab-name', text: item.name }),
      item.count != null ? h('span', { class: 'tools-tab-count', text: String(item.count) }) : null);
    });
    this.#els.rail.replaceChildren(this.#els.pill, ...tabs);
    this.#placePill(false);
  }

  /** The selected pill slides to the selected tab (or jumps, when the rail was just drawn). */
  #placePill(animate) {
    const els = this.#els;
    if (!els) return;
    const tab = els.rail.querySelector('[aria-selected="true"]');
    els.pill.hidden = !tab;
    if (!tab) return;
    if (!animate) els.pill.style.transition = 'none';
    els.pill.style.setProperty('--pill-x', `${tab.offsetLeft}px`);
    els.pill.style.setProperty('--pill-y', `${tab.offsetTop}px`);
    els.pill.style.setProperty('--pill-w', `${tab.offsetWidth}px`);
    els.pill.style.setProperty('--pill-h', `${tab.offsetHeight}px`);
    if (!animate) {
      els.pill.getBoundingClientRect();
      els.pill.style.transition = '';
    }
  }

  /** Shows a view of the rail (leaving a search), and selects its tab. */
  #show(view, { focusTab = false } = {}) {
    const { input, rail } = this.#els;
    const changed = view !== this.#view || Boolean(input.value);
    this.#view = view;
    input.value = '';
    let selectedTab = null;
    for (const tab of rail.querySelectorAll('[role="tab"]')) {
      const selected = tab.dataset.view === view;
      tab.setAttribute('aria-selected', String(selected));
      tab.tabIndex = selected ? 0 : -1;
      if (selected) selectedTab = tab;
    }
    this.#placePill(true);
    this.#renderView(changed);
    selectedTab?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    if (focusTab) selectedTab?.focus();
  }

  #onRailKey(e) {
    const tabs = [...this.#els.rail.querySelectorAll('[role="tab"]')];
    const at = tabs.indexOf(e.target);
    const to = { ArrowDown: at + 1, ArrowRight: at + 1, ArrowUp: at - 1, ArrowLeft: at - 1, Home: 0, End: tabs.length - 1 }[e.key];
    if (at < 0 || to === undefined) return;
    e.preventDefault();
    e.stopPropagation();
    this.#show(tabs[(to + tabs.length) % tabs.length].dataset.view, { focusTab: true });
  }

  // ---- views: the landing, a category, favourites, recent ----------------------------------

  #renderView(animate) {
    const { panel, results, input, sheet, content } = this.#els;
    const view = this.#view;
    const category = CATEGORY_LIST.find((c) => c.id === view);
    const body = category ? this.#category(category)
      : view === 'favorites' ? this.#saved('favorites')
        : view === 'recent' ? this.#saved('recent')
          : this.#landing();
    const wasSearching = !results.hidden;
    panel.replaceChildren(body);
    panel.setAttribute('aria-labelledby', `tools-tab-${view}`);
    panel.hidden = false;
    results.hidden = true;
    delete sheet.dataset.searching;
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
    // One cross-fade back from a search; a short rise for a new category; nothing otherwise.
    if (wasSearching) body.classList.add('tools-fade');
    else if (animate) body.classList.add('tools-enter');
    content.scrollTop = 0;
    this.#rove(panel.querySelector('[data-cell]'), { focus: false });
  }

  #landing() {
    const doc = this.#app.active;
    const ready = this.#snap.document;
    const blocks = [];
    let title = 'Start without a document';
    let note = null;
    if (ready) title = `For “${doc.file.name}”`;
    else if (doc?.status === 'error') {
      title = doc.error?.title ?? `“${doc.file.name}” couldn’t be opened`;
      note = doc.error?.message ?? null;
    } else if (doc) title = `“${doc.file.name}” is still opening`;
    blocks.push(h('header', { class: 'tools-head-text' },
      h('h3', { class: 'tools-title', text: title }),
      note ? h('p', { class: 'tools-subtitle', text: note }) : null));

    // With no document ready, what works without one comes first.
    if (!ready) {
      const free = TOOLS.filter((t) => this.#listed(t) && this.#can(t.command).available);
      if (free.length) {
        blocks.push(h('section', { class: 'tools-block', 'aria-label': 'Start without a document' },
          doc ? h('h4', { class: 'tools-label', text: 'Start without a document' }) : null,
          h('div', { class: 'tools-cards' }, ...free.map((t) => this.#card(t)))));
      }
    }

    // Favourites, then recent tools: the ones that can run now, as quick chips.
    const runnable = (id) => TOOL.has(id) && this.#listed(TOOL.get(id)) && this.#can(TOOL.get(id).command).available;
    const favorites = this.#prefs.favorites().filter(runnable).slice(0, CHIPS);
    const recent = this.#prefs.recent().filter((id) => runnable(id) && !favorites.includes(id)).slice(0, CHIPS - favorites.length);
    for (const [name, ids] of [['Favorites', favorites], ['Recent', recent]]) {
      if (!ids.length) continue;
      blocks.push(h('section', { class: 'tools-block' },
        h('h4', { class: 'tools-label', text: name }),
        h('div', { class: 'tools-chips' }, ...ids.map((id) => this.#chip(TOOL.get(id))))));
    }

    blocks.push(h('section', { class: 'tools-block' },
      h('div', { class: 'tools-block-head' },
        h('h4', { class: 'tools-label', text: 'All tools' }),
        doc ? null : h('span', { class: 'tools-note', text: 'Most tools work on an open PDF' }),
        doc ? null : this.#openButton()),
      h('div', { class: 'tools-tiles' }, ...CATEGORY_LIST.map((c) => this.#tile(c)))));
    return h('div', { class: 'tools-view' }, ...blocks);
  }

  #category(category) {
    const tools = this.#toolsIn(category);
    const head = h('header', { class: 'tools-cat-head' },
      h('span', { class: 'tools-well tools-well-tint', html: icon(category.icon, 20) }),
      h('div', { class: 'tools-head-text' },
        h('h3', { class: 'tools-title', text: category.name }),
        h('p', { class: 'tools-subtitle', text: category.blurb })));
    if (this.#snap.document) {
      const sections = category.sections.length
        ? category.sections.map((s) => ({ name: s.name, tools: tools.filter((t) => t.section === s.id) })).filter((s) => s.tools.length)
        : [{ name: null, tools }];
      return h('div', { class: 'tools-view' }, head, ...sections.map((s) => this.#section(s.name, s.tools)));
    }
    // No document: what works without one is listed as usual; the rest waits, once, for a PDF.
    const free = tools.filter((t) => this.#can(t.command).unmet !== 'document');
    const bound = tools.filter((t) => this.#can(t.command).unmet === 'document');
    const doc = this.#app.active;
    const waitId = nextId('wait');
    return h('div', { class: 'tools-view' }, head,
      free.length ? this.#section(null, free) : null,
      bound.length ? h('section', { class: 'tools-section tools-waiting' },
        h('div', { class: 'tools-block-head' },
          h('h4', { class: 'tools-label', id: waitId, text: doc?.status === 'loading' ? `Ready once “${doc.file.name}” has opened` : 'Open a PDF to use these' }),
          doc?.status === 'loading' ? null : this.#openButton()),
        this.#rows(bound, { describedBy: waitId, waiting: true })) : null);
  }

  #saved(kind) {
    const favorites = kind === 'favorites';
    const tools = (favorites ? this.#prefs.favorites() : this.#prefs.recent()).map((id) => TOOL.get(id)).filter((t) => t && this.#listed(t));
    const clear = !favorites && tools.length
      ? h('button', { class: 'link-btn tools-clear', 'data-line': '', 'data-cell': '', onClick: () => this.#clearRecent() }, 'Clear')
      : null;
    return h('div', { class: 'tools-view' },
      h('header', { class: 'tools-cat-head' },
        h('span', { class: 'tools-well tools-well-tint', html: icon(favorites ? 'star' : 'clock', 20) }),
        h('div', { class: 'tools-head-text' },
          h('h3', { class: 'tools-title', text: favorites ? 'Favorites' : 'Recent' }),
          h('p', { class: 'tools-subtitle', text: favorites ? 'The tools you starred, kept on this PC' : 'The tools you ran last, newest first' })),
        clear),
      tools.length ? this.#section(null, tools)
        : h('p', { class: 'tools-empty', text: favorites ? 'Nothing starred. Star a tool to keep it here.' : 'Nothing here now.' }));
  }

  #clearRecent() {
    this.#prefs.clearRecent();
    this.#redraw(() => {
      this.#renderRail();
      this.#renderView(false);
    });
    this.#announce('Recent tools cleared');
  }

  #section(name, tools) {
    return h('section', { class: 'tools-section' },
      name ? h('h4', { class: 'tools-label', text: name }) : null,
      this.#rows(tools));
  }

  // ---- rows, tiles, cards, chips ------------------------------------------------------------

  #rows(tools, { describedBy = null, waiting = false } = {}) {
    return h('ul', { class: 'tools-rows', role: 'list' }, ...tools.map((t) => this.#row(t, { describedBy, waiting })));
  }

  /**
   * One tool: the tool itself (a button), its variants, its shortcut and its star. A tool that can't run
   * now stays in its place, still focusable, with the reason in place of its description; waiting for a
   * document, the group's heading says why instead.
   */
  #row(t, { describedBy, waiting }) {
    const can = this.#can(t.command);
    const off = !can.available;
    const nameId = nextId('name');
    const lineId = nextId('line');
    const scope = !off && t.fits === 'pages.selected' ? this.#scope() : null;
    const keys = this.#keysOf(t.command);
    const main = h('button', {
      class: 'tools-run', 'data-cell': '', 'aria-labelledby': nameId,
      'aria-describedby': [lineId, describedBy].filter(Boolean).join(' '),
      'aria-disabled': off ? 'true' : null, 'aria-keyshortcuts': keys ? keys.replace(/\bCtrl\b/g, 'Control') : null,
      onClick: () => this.#runTool(t, t.command),
    },
    h('span', { class: 'tools-well', html: icon(this.#iconOf(t), 18) }),
    h('span', { class: 'tools-row-text' },
      h('span', { class: 'tools-row-name', id: nameId, text: t.name }),
      h('span', { class: 'tools-row-line', id: lineId, text: off && !waiting ? can.reason : scope ?? t.blurb })));
    const variants = (t.variants ?? []).map((v) => h('button', {
      class: 'tools-variant', 'data-cell': '', 'aria-label': `${t.name}: ${v.label}`,
      'aria-disabled': this.#can(v.command).available ? null : 'true', onClick: () => this.#runTool(t, v.command),
    }, v.label));
    const starred = this.#prefs.isFavorite(t.id);
    const star = h('button', {
      class: 'tools-star', 'data-cell': '', 'aria-pressed': String(starred), 'aria-label': `Add ${t.name} to favorites`,
      html: icon('star', 16), onClick: (e) => this.#toggleFavorite(t, e.currentTarget),
    });
    return h('li', { class: 'tools-row', 'data-line': '', 'data-off': off ? '' : null, dataset: { tool: t.id } },
      main,
      h('span', { class: 'tools-row-end' }, ...variants, keys ? h('kbd', { text: prettyKeys(keys), 'aria-hidden': 'true' }) : null, star));
  }

  /** The pages a tool that suits selected pages will act on, when some are selected in the thumbnails. */
  #scope() {
    const pages = this.#pages;
    if (!pages.length) return null;
    if (pages.length === 1) return `Page ${pages[0]} (selected)`;
    return pages.at(-1) - pages[0] === pages.length - 1 ? `Pages ${pages[0]}–${pages.at(-1)} (selected)` : `${pages.length} pages (selected)`;
  }

  #tile(category) {
    const blurbId = nextId('blurb');
    return h('button', {
      class: 'tools-tile', 'data-line': '', 'data-cell': '', dataset: { category: category.id },
      'aria-label': category.name, 'aria-describedby': blurbId, onClick: () => this.#show(category.id, { focusTab: true }),
    },
    h('span', { class: 'tools-tile-head' },
      h('span', { class: 'tools-well tools-well-tint', html: icon(category.icon, 18) }),
      h('span', { class: 'tools-tile-name', text: category.name })),
    h('span', { class: 'tools-tile-blurb', id: blurbId, text: category.blurb }));
  }

  /** A tool that works without a document, on the landing when none is open. */
  #card(t) {
    const blurbId = nextId('blurb');
    return h('button', {
      class: 'tools-tile tools-card', 'data-line': '', 'data-cell': '', dataset: { tool: t.id },
      'aria-label': t.name, 'aria-describedby': blurbId, onClick: () => this.#runTool(t, t.command),
    },
    h('span', { class: 'tools-tile-head' },
      h('span', { class: 'tools-well tools-well-tint', html: icon(this.#iconOf(t), 18) }),
      h('span', { class: 'tools-tile-name', text: t.name })),
    h('span', { class: 'tools-tile-blurb', id: blurbId, text: t.blurb }));
  }

  #chip(t) {
    return h('button', { class: 'tools-chip', 'data-line': '', 'data-cell': '', dataset: { tool: t.id }, onClick: () => this.#runTool(t, t.command) },
      h('span', { class: 'tools-chip-icon', html: icon(this.#iconOf(t), 16) }), t.name);
  }

  #openButton() {
    return h('button', {
      class: 'btn primary small tools-open', 'data-line': '', 'data-cell': '',
      onClick: () => this.#afterClosing(() => this.#commands['file.open'].run()),
    }, h('span', { html: icon('folder-open', 15) }), 'Open a PDF');
  }

  #toggleFavorite(t, star) {
    const on = this.#prefs.toggleFavorite(t.id);
    if (on === null) {
      toast(`You can keep ${FAVORITES_LIMIT} favorites. Unstar one to add another.`);
      return;
    }
    star.setAttribute('aria-pressed', String(on));
    star.classList.remove('pulse');
    void star.offsetWidth; // start the pulse again
    star.classList.add('pulse');
    this.#announce(on ? `${t.name} added to favorites` : `${t.name} removed from favorites`);
    this.#renderRail(); // Favorites appears, or goes, in the rail
  }

  /** Arrow keys move between the rows (and the landing's cards), and along a row's buttons. */
  #onPanelKey(e) {
    const cell = e.target.closest?.('[data-cell]');
    const line = cell?.closest('[data-line]');
    if (!line) return;
    const lines = [...this.#els.panel.querySelectorAll('[data-line]')];
    const cellsOf = (l) => (l.matches('[data-cell]') ? [l] : [...l.querySelectorAll('[data-cell]')]);
    const cells = cellsOf(line);
    const at = lines.indexOf(line);
    const within = cells.length > 1;
    const first = (l) => (l ? cellsOf(l)[0] : null);
    const target = {
      ArrowDown: () => first(lines[at + 1]),
      ArrowUp: () => first(lines[at - 1]),
      ArrowRight: () => (within ? cells[cells.indexOf(cell) + 1] : first(lines[at + 1])),
      ArrowLeft: () => (within ? cells[cells.indexOf(cell) - 1] : first(lines[at - 1])),
      Home: () => first(lines[0]),
      End: () => first(lines.at(-1)),
    }[e.key];
    if (!target) return;
    e.preventDefault();
    e.stopPropagation();
    const next = target();
    if (next) this.#rove(next);
  }

  /** The content is one Tab stop: `cell`, which gets focus unless told otherwise. */
  #rove(cell, { focus = true } = {}) {
    if (!cell) return;
    for (const c of this.#els.panel.querySelectorAll('[data-cell]')) c.tabIndex = c === cell ? 0 : -1;
    if (focus && document.activeElement !== cell) cell.focus();
  }

  // ---- search -------------------------------------------------------------------------------

  #setQuery(query) {
    this.#els.input.value = query;
    this.#renderQuery();
  }

  /** The query changed: results while there is one, and the view the rail shows once it's cleared. */
  #renderQuery() {
    const searching = Boolean(this.#els.input.value.trim());
    if (searching) this.#renderResults();
    else if (!this.#els.results.hidden || !this.#els.panel.childElementCount) this.#renderView(false);
  }

  /** The results replace the view as they are typed: a cross-fade when they first show, none per key. */
  #renderResults() {
    const { input, list, results, panel, sheet } = this.#els;
    const query = input.value.trim();
    this.#toolIndex ??= indexItems(TOOLS, toolFields(this.#commands));
    this.#commandIndex ??= indexItems(this.#otherCommands(), COMMAND_FIELDS);
    const favorites = new Set(this.#prefs.favorites());
    const recent = new Set(this.#prefs.recent());
    // Among equal matches: what can run now, then favourites, then recent tools (search.js never lets
    // this lift a weaker match).
    const context = (t) => (this.#can(t.command).available ? 4 : 0) + (favorites.has(t.id) ? 2 : 0) + (recent.has(t.id) ? 1 : 0);
    const tools = rank(this.#toolIndex, query, { context }).map((r) => r.item).filter(this.#listed).slice(0, MAX_TOOLS);
    const more = rank(this.#commandIndex, query).map((r) => r.item).slice(0, MAX_COMMANDS);

    this.#results = [];
    const groups = [];
    if (tools.length) {
      groups.push(this.#group(null, 'Tools', tools.flatMap((t) => (t.variants ?? [{ label: null, command: t.command }])
        .map((v) => this.#option({
          name: t.name, variant: v.label, icon: this.#iconOf(t), keys: this.#keysOf(v.command), tool: t,
          line: this.#can(v.command).available ? t.blurb : this.#can(v.command).reason,
          off: !this.#can(v.command).available, run: () => this.#runTool(t, v.command),
        })))));
    }
    if (more.length) {
      groups.push(this.#group('More commands', null, more.map((c) => this.#option({
        name: c.label, icon: c.icon, keys: c.keys, line: this.#can(c.id).available ? null : this.#can(c.id).reason,
        off: !this.#can(c.id).available, run: () => this.#afterClosing(() => this.#commands[c.id].run()),
      }))));
    }
    if (!tools.length && !more.length) {
      // Never a feature that doesn't exist: only where else to look.
      const fallbacks = [];
      if (this.#snap.document) {
        fallbacks.push(this.#option({ name: `Find “${query}” in this document`, icon: 'search', keys: this.#keysOf('find.open'), run: () => this.#afterClosing(() => this.#findInDocument(query)) }));
      }
      fallbacks.push(this.#option({ name: `Search commands for “${query}”`, icon: 'zap', keys: this.#keysOf('app.palette'), run: () => this.#afterClosing(() => this.#searchCommands(query)) }));
      groups.push(h('p', { class: 'tools-empty', text: `No tools match “${query}”.` }), this.#group(null, 'Look elsewhere', fallbacks));
    }
    list.replaceChildren(...groups);
    results.hidden = false; // its fade plays each time it goes from hidden to shown
    panel.hidden = true;
    sheet.dataset.searching = '';
    input.setAttribute('aria-expanded', 'true');
    this.#setActive(0, true);
    this.#els.content.scrollTop = 0;
    const count = tools.length;
    this.#announceCount(count ? `${count} ${count === 1 ? 'tool matches' : 'tools match'} “${query}”` : `No tools match “${query}”`);
  }

  /** The palette's commands that aren't tools (nor this sheet), for "More commands". */
  #otherCommands() {
    const items = [];
    for (const [id, c] of Object.entries(this.#commands)) {
      if (c.palette === false || !c.label || TOOL_COMMANDS.has(id) || id === OWN) continue;
      const { present, unmet } = this.#can(id);
      if (!present || unmet === 'document') continue; // as the palette: no document commands with no document
      items.push({ id, label: c.label, group: c.group ?? 'App', aliases: null, icon: c.icon ?? 'command', keys: c.hint ?? c.keys?.[0] });
    }
    return items;
  }

  #group(heading, label, options) {
    const headingId = heading ? nextId('group') : null;
    return h('div', { class: 'tools-group', role: 'group', 'aria-labelledby': headingId, 'aria-label': heading ? null : label },
      heading ? h('div', { class: 'tools-label', id: headingId, role: 'presentation', text: heading }) : null,
      ...options);
  }

  #option({ name, variant = null, icon: iconName, keys = null, line = null, off = false, run, tool = null }) {
    const index = this.#results.length;
    this.#results.push({ off, run });
    const lineId = line ? nextId('line') : null;
    return h('div', {
      class: 'tools-option', role: 'option', id: `tools-option-${index}`, 'aria-selected': 'false',
      'aria-disabled': off ? 'true' : null, 'aria-label': variant ? `${name}, ${variant}` : name, 'aria-describedby': lineId,
      'data-off': off ? '' : null, dataset: tool ? { index, tool: tool.id } : { index },
    },
    h('span', { class: 'tools-well', html: icon(iconName, 18) }),
    h('span', { class: 'tools-row-text' },
      h('span', { class: 'tools-row-name', text: name }),
      line ? h('span', { class: 'tools-row-line', id: lineId, text: line }) : null),
    variant ? h('span', { class: 'tools-option-variant', text: variant }) : null,
    keys ? h('kbd', { text: prettyKeys(keys) }) : null);
  }

  #setActive(index, scroll) {
    const { list, input } = this.#els;
    this.#active = this.#results.length ? Math.max(0, Math.min(index, this.#results.length - 1)) : 0;
    for (const el of list.querySelectorAll('[role="option"]')) {
      const on = Number(el.dataset.index) === this.#active;
      el.classList.toggle('active', on);
      el.setAttribute('aria-selected', String(on));
      if (on && scroll) el.scrollIntoView({ block: 'nearest' });
    }
    if (this.#results.length) input.setAttribute('aria-activedescendant', `tools-option-${this.#active}`);
    else input.removeAttribute('aria-activedescendant');
  }

  #onInputKey(e) {
    if (this.#els.results.hidden) return; // not searching: the keys stay the field's own
    const count = this.#results.length;
    if (e.key === 'ArrowDown' && count) this.#setActive((this.#active + 1) % count, true);
    else if (e.key === 'ArrowUp' && count) this.#setActive((this.#active - 1 + count) % count, true);
    else if (e.key === 'Enter') this.#runOption(this.#active);
    else return;
    e.preventDefault();
    e.stopPropagation();
  }

  /** An option that can't run does nothing: its reason is already on it. */
  #runOption(index) {
    const option = this.#results[index];
    if (option && !option.off) option.run();
  }

  // ---- running ------------------------------------------------------------------------------

  /** Runs a tool by running its command (or one of its variants'), as any surface does. */
  #runTool(t, id) {
    if (!this.#can(id).available) return; // aria-disabled: nothing happens, and the reason is already shown
    this.#prefs.recordRun(t.id);
    this.#afterClosing(() => this.#commands[id].run());
  }

  /** Closes the sheet, then runs `fn` on the next frame, once focus is back: what it focuses keeps focus. */
  #afterClosing(fn) {
    this.close();
    requestAnimationFrame(() => fn());
  }

  #announce(text) {
    const status = this.#els?.status;
    if (!status) return;
    status.textContent = '';
    requestAnimationFrame(() => { status.textContent = text; });
  }
}
