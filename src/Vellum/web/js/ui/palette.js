import { h, prettyKeys } from '../dom.js';
import { icon } from '../icons.js';

// The command palette (Ctrl+K): type a few letters of anything Vellum can do, or of a recent file,
// and press Enter. Items come straight from the command registry (commands.js), so everything the
// app can do is here, and nothing it can't.

const MAX_RESULTS = 60;
const GROUP_ORDER = ['Recent files', 'File', 'Annotate', 'Pages', 'Page', 'View', 'Search', 'Edit', 'Arrange', 'Tabs', 'App'];
const fileName = (path) => path.slice(path.lastIndexOf('\\') + 1);
const folderOf = (path) => path.slice(0, Math.max(0, path.lastIndexOf('\\')));

const WORD_BREAK = /[\s./\\(-]/;

/**
 * Every word of the query must appear in `text` ("rot pag" finds "Rotate page right"). Matches at
 * the start of a word and near the start of the text rank higher. Scattered letters don't count.
 */
function match(text, query) {
  const t = text.toLowerCase();
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return { score: 0, hits: [] };
  let score = 0;
  const hits = [];
  for (const word of words) {
    let at = -1;
    for (let i = t.indexOf(word); i >= 0; i = t.indexOf(word, i + 1)) {
      if (i === 0 || WORD_BREAK.test(t[i - 1])) { at = i; break; }
      if (at < 0) at = i;
    }
    if (at < 0) return null;
    const wordStart = at === 0 || WORD_BREAK.test(t[at - 1]);
    score += 100 - Math.min(at, 60) + (wordStart ? 60 : 0);
    for (let k = 0; k < word.length; k++) hits.push(at + k);
  }
  return { score, hits };
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

  constructor({ app, commands, bridge, onOpenRecent }) {
    this.app = app;
    this.commands = commands;
    this.bridge = bridge;
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
    this.#render(true);
    this.bridge.request('recent.list').then(({ entries }) => {
      const open = new Set(this.app.views.map((v) => v.file.path.toLowerCase()));
      this.#recent = entries.filter((e) => e.exists && !open.has(e.path.toLowerCase())).slice(0, 12);
      if (this.backdrop) this.#render(false);
    }).catch(() => { /* no host */ });
  }

  close() {
    const backdrop = this.backdrop;
    if (!backdrop) return;
    this.backdrop = null;
    backdrop.classList.remove('open');
    setTimeout(() => backdrop.remove(), 200);
    this.previousFocus?.focus?.({ preventScroll: true });
  }

  #items() {
    const hasDoc = this.app.active?.status === 'ready';
    const items = [];
    for (const [id, c] of Object.entries(this.commands)) {
      if (c.palette === false || !c.label || (c.doc && !hasDoc)) continue;
      items.push({ id, group: c.group ?? 'App', icon: c.icon ?? 'command', label: c.label, keys: c.hint ?? c.keys?.[0], run: () => c.run() });
    }
    for (const entry of this.#recent) {
      items.push({
        id: `recent:${entry.path}`, group: 'Recent files', icon: 'clock', label: fileName(entry.path), detail: folderOf(entry.path),
        run: () => this.onOpenRecent(entry.path),
      });
    }
    return items;
  }

  #render(resetActive) {
    const query = this.input.value;
    const order = (g) => { const i = GROUP_ORDER.indexOf(g); return i < 0 ? GROUP_ORDER.length : i; };
    let results;
    if (query.trim()) {
      results = this.#items()
        .map((item) => {
          const m = match(item.label, query) ?? match(`${item.group} ${item.label}`, query);
          if (!m) return null;
          const onLabel = match(item.label, query);
          return { ...item, score: m.score, hits: onLabel?.hits ?? [] };
        })
        .filter(Boolean)
        .sort((a, b) => b.score - a.score || order(a.group) - order(b.group))
        .slice(0, MAX_RESULTS);
    } else {
      results = this.#items()
        .map((item) => ({ ...item, hits: [] }))
        .sort((a, b) => order(a.group) - order(b.group));
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
    if (!results.length) nodes.push(h('div', { class: 'palette-empty', text: `Nothing matches “${query.trim()}”.` }));
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
    else if (e.key === 'Enter') this.#run(this.#active);
    else return;
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
