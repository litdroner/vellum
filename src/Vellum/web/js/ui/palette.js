import { h, prettyKeys } from '../dom.js';
import { icon } from '../icons.js';
import { availability } from '../requirements.js';
import { restoreFocus } from './focus.js';

// The command palette (Ctrl+K): type a few letters of anything Vellum can do, or of a recent file,
// and press Enter. Items come straight from the command registry (commands.js), so everything the
// app can do is here, and nothing it can't. Searching is Tools' own (catalog/search.js): a command is
// also found by the aliases of the tool it runs ("combine" finds Merge PDFs…), and typing a command's
// whole label always puts that command first.

const MAX_RESULTS = 60;
const GROUP_ORDER = ['Recent files', 'File', 'Annotate', 'Pages', 'Page', 'View', 'Search', 'Edit', 'Arrange', 'Tools', 'Forms', 'Bookmarks', 'Links', 'Tabs', 'App'];
const groupRank = (group) => { const i = GROUP_ORDER.indexOf(group); return i < 0 ? GROUP_ORDER.length : i; };
const fileName = (path) => path.slice(path.lastIndexOf('\\') + 1);
const folderOf = (path) => path.slice(0, Math.max(0, path.lastIndexOf('\\')));

// Search and the tools' aliases load the first time the palette opens, never at startup.
let loading = null;
const loadSearch = () => (loading ??= Promise.all([import('../catalog/search.js'), import('../catalog/catalog.js')])
  .then(([search, catalog]) => ({ ...search, fields: catalog.COMMAND_FIELDS, aliases: catalog.aliasesByCommand() })));

const WORD_BREAK = /[\s./\\(-]/;

/** Where each word of the query appears in `text`, for marking; none unless every word is there. */
function hitsIn(text, query) {
  const t = text.toLowerCase();
  const hits = [];
  for (const word of query.toLowerCase().split(/\s+/).filter(Boolean)) {
    let at = -1;
    for (let i = t.indexOf(word); i >= 0; i = t.indexOf(word, i + 1)) {
      if (i === 0 || WORD_BREAK.test(t[i - 1])) { at = i; break; }
      if (at < 0) at = i;
    }
    if (at < 0) return [];
    for (let k = 0; k < word.length; k++) hits.push(at + k);
  }
  return hits;
}

/** The label with its matched letters marked (built as DOM nodes, never HTML). */
function marked(text, hits) {
  if (!hits.length) return [text];
  const set = new Set(hits);
  const out = [];
  let run = '';
  let on = false;
  for (let i = 0; i <= text.length; i++) {
    const hit = set.has(i);
    if (i === text.length || hit !== on) {
      if (run) out.push(on ? h('mark', { text: run }) : run);
      run = '';
      on = hit;
    }
    if (i < text.length) run += text[i];
  }
  return out;
}

export class CommandPalette {
  #recent = [];
  #results = [];
  #active = 0;
  /** catalog/search.js with the palette's fields and aliases, once loaded. */
  #search = null;
  /** The items, indexed for searching; rebuilt when the palette opens and when recent files arrive. */
  #index = null;
  /** Enter was pressed on a query before search had loaded: run the top result when it has. */
  #enterWhenReady = false;

  /** snapshot(): the app's state for requirements.js, which says which commands to leave out. */
  constructor({ app, commands, bridge, snapshot, onOpenRecent }) {
    this.app = app;
    this.commands = commands;
    this.bridge = bridge;
    this.snapshot = snapshot;
    this.onOpenRecent = onOpenRecent;
    this.backdrop = null;
  }

  get isOpen() { return Boolean(this.backdrop); }

  open() {
    if (this.backdrop) {
      this.input.select();
      return;
    }
    this.previousFocus = document.activeElement;
    this.input = h('input', {
      class: 'palette-input', type: 'text', spellcheck: 'false', autocomplete: 'off',
      placeholder: 'What do you want to do?', 'aria-label': 'Search commands and recent files',
      role: 'combobox', 'aria-expanded': 'true', 'aria-controls': 'palette-list',
    });
    this.list = h('div', { class: 'palette-list', id: 'palette-list', role: 'listbox' });
    const panel = h('div', { class: 'palette', role: 'dialog', 'aria-label': 'Command palette' },
      h('div', { class: 'palette-field' }, h('span', { html: icon('search', 18) }), this.input, h('kbd', { text: 'Esc' })),
      this.list);
    this.backdrop = h('div', { class: 'palette-backdrop ui' }, panel);
    this.backdrop.addEventListener('mousedown', (e) => { if (e.target === this.backdrop) this.close(); });
    this.input.addEventListener('input', () => this.#render(true));
    this.input.addEventListener('keydown', (e) => this.#onKey(e));
    this.list.addEventListener('mousemove', (e) => {
      const item = e.target.closest('.palette-item');
      if (item) this.#setActive(Number(item.dataset.index), false);
    });

    document.getElementById('overlay-root').append(this.backdrop);
    requestAnimationFrame(() => this.backdrop?.classList.add('open'));
    this.input.focus();
    this.#index = null;
    this.#enterWhenReady = false;
    this.#render(true);
    loadSearch().then((search) => {
      this.#search = search;
      if (!this.backdrop) return;
      this.#render(false);
      if (this.#enterWhenReady) this.#run(this.#active);
    });
    this.bridge.request('recent.list').then(({ entries }) => {
      const open = new Set(this.app.views.map((v) => v.file.path.toLowerCase()));
      this.#recent = entries.filter((e) => e.exists && !open.has(e.path.toLowerCase())).slice(0, 12);
      this.#index = null;
      if (this.backdrop) this.#render(false);
    }).catch(() => { /* no host */ });
  }

  close() {
    const backdrop = this.backdrop;
    if (!backdrop) return;
    this.backdrop = null;
    backdrop.classList.remove('open');
    setTimeout(() => backdrop.remove(), 200);
    restoreFocus(this.previousFocus);
  }

  /** Everything the palette offers now, in group order. */
  #items() {
    const snap = this.snapshot();
    const items = [];
    for (const [id, c] of Object.entries(this.commands)) {
      if (c.palette === false || !c.label) continue;
      // Left out: a command whose provider this PC doesn't have, and a document command with no document.
      const { present, unmet } = availability(c, snap);
      if (!present || unmet === 'document') continue;
      items.push({
        id, group: c.group ?? 'App', icon: c.icon ?? 'command', label: c.label, keys: c.hint ?? c.keys?.[0],
        aliases: this.#search?.aliases.get(id) ?? null, run: () => c.run(),
      });
    }
    for (const entry of this.#recent) {
      items.push({
        id: `recent:${entry.path}`, group: 'Recent files', icon: 'clock', label: fileName(entry.path), detail: folderOf(entry.path),
        run: () => this.onOpenRecent(entry.path),
      });
    }
    return items.sort((a, b) => groupRank(a.group) - groupRank(b.group));
  }

  #render(resetActive) {
    const query = this.input.value;
    let results;
    if (!query.trim()) {
      results = this.#items().map((item) => ({ ...item, hits: [] }));
    } else if (this.#search) {
      this.#index ??= this.#search.indexItems(this.#items(), this.#search.fields);
      results = this.#search.rank(this.#index, query).slice(0, MAX_RESULTS)
        .map(({ item }) => ({ ...item, hits: hitsIn(item.label, query) }));
    } else {
      results = []; // search is still loading: these render the moment it has
    }
    this.#results = results;
    if (resetActive) this.#active = 0;
    this.#active = Math.min(this.#active, Math.max(0, results.length - 1));

    const nodes = [];
    let lastGroup = null;
    results.forEach((item, index) => {
      // Grouped when browsing; ranked (no headings) when searching.
      if (!query.trim() && item.group !== lastGroup) {
        nodes.push(h('div', { class: 'palette-group', role: 'presentation', text: item.group }));
        lastGroup = item.group;
      }
      nodes.push(h('button', {
        class: 'palette-item', role: 'option', id: `palette-${index}`, dataset: { index }, tabindex: '-1',
        onClick: () => this.#run(index),
      },
      h('span', { class: 'pi-icon', html: icon(item.icon, 16) }),
      h('span', { class: 'pi-label' },
        h('span', { class: 'pi-text' }, ...marked(item.label, item.hits)),
        item.detail ? h('span', { class: 'pi-detail', text: item.detail }) : null),
      item.keys ? h('kbd', { text: prettyKeys(item.keys) }) : null));
    });
    if (!results.length && this.#search) nodes.push(h('div', { class: 'palette-empty', text: `Nothing matches “${query.trim()}”.` }));
    this.list.replaceChildren(...nodes);
    this.#setActive(this.#active, true);
  }

  #setActive(index, scroll) {
    this.#active = index;
    for (const el of this.list.querySelectorAll('.palette-item')) {
      const on = Number(el.dataset.index) === index;
      el.classList.toggle('active', on);
      el.setAttribute('aria-selected', String(on));
      if (on && scroll) el.scrollIntoView({ block: 'nearest' });
    }
    this.input.setAttribute('aria-activedescendant', `palette-${index}`);
  }

  #onKey(e) {
    const count = this.#results.length;
    if (e.key === 'Escape') this.close();
    else if (e.key === 'ArrowDown' && count) this.#setActive((this.#active + 1) % count, true);
    else if (e.key === 'ArrowUp' && count) this.#setActive((this.#active - 1 + count) % count, true);
    else if (e.key === 'Enter') {
      if (this.#search || !this.input.value.trim()) this.#run(this.#active);
      else this.#enterWhenReady = true;
    } else return;
    e.preventDefault();
    e.stopPropagation();
  }

  #run(index) {
    const item = this.#results[index];
    if (!item) return;
    this.close();
    // After the palette has handed focus back, so commands that focus something keep it.
    requestAnimationFrame(() => item.run());
  }
}
