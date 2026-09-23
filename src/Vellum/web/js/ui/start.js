import { h, prettyKeys, timeAgo } from '../dom.js';
import { icon } from '../icons.js';
import { researchCollectionDialog } from './collection-research.js';
import { showKnowledgeGraph } from './knowledge-graph.js';
import { deleteSavedResearch, savedResearchMeta, showSavedResearch } from './saved-research.js';
import { showDialog, toast } from './dialogs.js';

// The home screen, shown when no document is open: a greeting, a large Open card with a row of quick tools
// under it (tools that need no document, from Tools' catalog; docs/TOOLS_UX_SPEC.md §8), and the documents
// opened recently, each with a picture of its first page (captured when it was last open), then the
// person's collections: named lists of documents (only their paths; no file is copied, moved or changed),
// each with Research: one question asked of every document in it (ui/collection-research.js), and the
// document a piece of evidence comes from opened at its page.
//
// Graph shows what Vellum can prove about one collection (ui/knowledge-graph.js): the documents it lists,
// the pages evidence came from and that evidence — derived from the collection and the research already
// shown in this session, and kept only while the window is open.
//
// Saved research lists the results kept on this PC (ui/saved-research.js, Services/SavedResearch.cs). Opening
// one shows the evidence exactly as it was found — the research is never run again — and a passage still opens
// its document at its page. Delete removes that one saved result and nothing else.

const dateFormat = new Intl.DateTimeFormat(undefined, { weekday: 'long', day: 'numeric', month: 'long' });
const fileName = (path) => path.slice(path.lastIndexOf('\\') + 1);
const folderOf = (path) => path.slice(0, Math.max(0, path.lastIndexOf('\\')));

function greeting() {
  const hour = new Date().getHours();
  if (hour >= 5 && hour < 12) return 'Good morning';
  if (hour >= 12 && hour < 18) return 'Good afternoon';
  return 'Good evening';
}

// Sheets of paper, the top one with its corner curling up in the accent colour (the Vellum mark),
// floating over a soft glow. Colours come from the theme.
const ART = `<svg viewBox="0 0 420 320" fill="none" aria-hidden="true">
  <defs>
    <radialGradient id="ha-glow" cx=".5" cy=".5" r=".5">
      <stop offset="0" style="stop-color: var(--tint)"/>
      <stop offset="1" style="stop-color: var(--tint); stop-opacity: 0"/>
    </radialGradient>
    <linearGradient id="ha-paper" x1="0" y1="0" x2=".3" y2="1">
      <stop offset="0" stop-color="#ffffff"/>
      <stop offset="1" style="stop-color: color-mix(in srgb, #ffffff 86%, var(--tint))"/>
    </linearGradient>
    <linearGradient id="ha-curl" x1="1" y1="0" x2="0" y2="1">
      <stop offset="0" style="stop-color: color-mix(in srgb, var(--accent) 45%, #ffffff)"/>
      <stop offset=".6" style="stop-color: var(--accent)"/>
      <stop offset="1" style="stop-color: color-mix(in srgb, var(--accent) 72%, #000000)"/>
    </linearGradient>
    <radialGradient id="ha-orb" cx=".35" cy=".3" r=".75">
      <stop offset="0" style="stop-color: color-mix(in srgb, var(--accent) 35%, #ffffff)"/>
      <stop offset=".7" style="stop-color: var(--accent)"/>
      <stop offset="1" style="stop-color: color-mix(in srgb, var(--accent) 70%, #000000)"/>
    </radialGradient>
    <radialGradient id="ha-orb-2" cx=".35" cy=".3" r=".75">
      <stop offset="0" style="stop-color: color-mix(in srgb, var(--accent-3) 35%, #ffffff)"/>
      <stop offset="1" style="stop-color: var(--accent-3)"/>
    </radialGradient>
  </defs>
  <circle cx="230" cy="165" r="150" fill="url(#ha-glow)"/>
  <g class="art-sheet art-float-b">
    <rect x="150" y="58" width="176" height="226" rx="12" fill="url(#ha-paper)" transform="rotate(9 238 171)"/>
    <g transform="rotate(9 238 171)" stroke-linecap="round" class="art-lines">
      <path d="M176 104h96M176 124h122M176 144h108M176 164h84"/>
    </g>
  </g>
  <g class="art-sheet art-float-a">
    <path d="M126 44h170a14 14 0 0 1 14 14v164L240 292H126a14 14 0 0 1-14-14V58a14 14 0 0 1 14-14z" fill="url(#ha-paper)"/>
    <g stroke-linecap="round" class="art-lines">
      <path d="M142 86h104M142 108h134M142 130h118"/>
      <path d="M142 158h92" class="art-mark"/>
      <path d="M142 186h128M142 208h86"/>
    </g>
    <path d="M310 222c-30-6-60 6-74 34-6 12-2 26 4 36 8-28 34-58 70-70z" fill="url(#ha-curl)"/>
    <path d="M308 223c-26-1-50 12-62 34" stroke="rgba(255,255,255,.55)" stroke-width="2" stroke-linecap="round"/>
  </g>
  <circle class="art-orb art-float-c" cx="88" cy="232" r="24" fill="url(#ha-orb)"/>
  <circle class="art-orb art-float-b" cx="352" cy="70" r="13" fill="url(#ha-orb-2)"/>
</svg>`;

export class StartScreen {
  /**
   * homeTools(): a promise of the quick tools for the row under the Open card ({ id, name, icon, blurb, run }),
   * chosen by Tools' catalog (app.js); onAllTools(): opens Tools, whose keys are allToolsKeys.
   */
  constructor(root, { bridge, onOpenDialog, onOpenRecent, onOpenEvidence, homeTools, onAllTools, allToolsKeys }) {
    this.bridge = bridge;
    this.homeTools = homeTools;
    // Quick tools: filled in once the catalog has loaded (after the first paint); All tools is there from the start.
    this.toolChips = h('div', { class: 'home-tool-chips' });
    this.tools = h('div', { class: 'home-tools', role: 'group', 'aria-label': 'Quick tools' },
      this.toolChips,
      h('button', { class: 'link-btn home-all-tools', onClick: onAllTools },
        'All tools', allToolsKeys ? h('kbd', { text: prettyKeys(allToolsKeys) }) : null));
    this.onOpenRecent = onOpenRecent;
    this.onOpenEvidence = onOpenEvidence ?? ((e) => onOpenRecent(e.path));
    // The last research shown for a collection, by its id: what the Graph lists as evidence. In memory only.
    this.researched = new Map();
    this.collectionsRead = [];
    this.savedItems = [];
    this.name = '';
    this.greeting = h('h1', { class: 'home-greeting' });
    this.date = h('p', { class: 'home-date' });
    this.grid = h('div', { class: 'recent-grid', role: 'list' });
    this.recent = h('section', { class: 'recent', hidden: true, 'aria-label': 'Recent documents' },
      h('div', { class: 'recent-head' },
        h('h2', { text: 'Recent documents' }),
        h('button', { class: 'link-btn', onClick: () => this.#clear() }, 'Clear list')),
      this.grid);
    this.collectionList = h('div', { class: 'collection-list' });
    this.collections = h('section', { class: 'recent collections', 'aria-label': 'Collections' },
      h('div', { class: 'recent-head' },
        h('h2', { text: 'Collections' }),
        h('button', { class: 'link-btn', onClick: () => this.#create() }, 'New collection')),
      this.collectionList);
    this.savedList = h('div', { class: 'collection-list saved-research-list' });
    this.saved = h('section', { class: 'recent collections saved-research', hidden: true, 'aria-label': 'Saved research' },
      h('div', { class: 'recent-head' },
        h('h2', { text: 'Saved research' })),
      this.savedList);
    this.el = h('div', { class: 'start ui' },
      h('div', { class: 'start-inner' },
        h('div', { class: 'home-top' },
          h('div', { class: 'home-copy' },
            this.date,
            this.greeting,
            h('p', { class: 'home-sub', text: 'Paper meets possibilities.' }),
            h('button', { class: 'open-card', onClick: onOpenDialog },
              h('span', { class: 'open-plus', html: icon('plus', 24) }),
              h('span', { class: 'open-text' },
                h('span', { class: 'open-title', text: 'Open a PDF' }),
                h('span', { class: 'open-hint', text: 'Drag and drop files anywhere, or click to browse' })),
              h('kbd', { text: 'Ctrl+O' })),
            this.tools),
          h('div', { class: 'home-art', html: ART })),
        this.recent,
        this.collections,
        this.saved));
    root.append(this.el);
    this.#renderGreeting();
  }

  /** The person's first name, for the greeting (empty greets without one). */
  setName(name) {
    this.name = name;
    this.#renderGreeting();
  }

  /** The quick tools, recently used first; kept on the same tool when one of them has focus. */
  async renderTools() {
    let tools = [];
    try { tools = (await this.homeTools?.()) ?? []; } catch { /* the catalog didn't load: All tools still works */ }
    const focused = this.toolChips.contains(document.activeElement) ? document.activeElement.dataset.tool : null;
    this.toolChips.replaceChildren(...tools.map((t) => h('button', {
      class: 'tools-chip home-tool', dataset: { tool: t.id }, title: t.blurb, onClick: () => t.run(),
    }, h('span', { class: 'tools-chip-icon', html: icon(t.icon, 16) }), t.name)));
    if (focused) (this.toolChips.querySelector(`[data-tool="${focused}"]`) ?? this.tools.querySelector('button'))?.focus();
  }

  async refresh() {
    this.#renderGreeting();
    this.renderTools();
    let entries = [];
    try { ({ entries } = await this.bridge.request('recent.list')); } catch { /* no host (dev) */ }
    this.recent.hidden = entries.length === 0;
    this.grid.replaceChildren(...entries.slice(0, 12).map((e, i) => this.#card(e, i, {
      label: 'Remove from list', from: 'recent documents',
      remove: async () => { await this.bridge.request('recent.remove', { path: e.path }); this.refresh(); },
    })));
    await this.#renderCollections();
    await this.#renderSaved();
  }

  async #renderCollections() {
    let collections = [];
    try { ({ collections } = await this.bridge.request('collections.list')); } catch { /* no host (dev) */ }
    this.collectionsRead = collections;
    this.collectionList.replaceChildren(...(collections.length
      ? collections.map((c) => this.#collection(c))
      : [h('p', { class: 'collection-empty', text: 'Group the documents you use together. The files stay where they are.' })]));
  }

  /** The research kept on this PC. Reading the list runs nothing: each item is shown as it was saved. */
  async #renderSaved() {
    let items = [];
    try { ({ items } = await this.bridge.request('research.list')); } catch { /* no host (dev) */ }
    this.savedItems = items;
    this.saved.hidden = items.length === 0;
    this.savedList.replaceChildren(...items.map((item) => this.#savedItem(item)));
  }

  #savedItem(item) {
    return h('div', { class: 'collection saved-item', 'data-id': item.id },
      h('div', { class: 'collection-head' },
        h('h3', { class: 'collection-name', text: item.name }),
        h('span', { class: 'collection-meta', text: savedResearchMeta(item) }),
        h('button', { class: 'link-btn', 'aria-label': `Open saved research ${item.name}`, onClick: () => this.#openSaved(item) }, 'Open'),
        h('button', { class: 'link-btn danger', 'aria-label': `Delete saved research ${item.name}`, onClick: () => this.#deleteSaved(item) }, 'Delete')));
  }

  async #openSaved(item) {
    await showSavedResearch({ item, onOpenEvidence: (evidence) => this.onOpenEvidence(evidence) });
  }

  async #deleteSaved(item) {
    if (await deleteSavedResearch({ bridge: this.bridge, item })) await this.#renderSaved();
  }

  #collection(c) {
    const count = c.documents.length;
    const missing = c.documents.filter((d) => !d.exists).length;
    const summary = [count ? `${count} document${count === 1 ? '' : 's'}` : 'Empty', missing ? `${missing} not found` : null].filter(Boolean).join(' · ');
    return h('div', { class: 'collection', 'data-id': c.id },
      h('div', { class: 'collection-head' },
        h('h3', { class: 'collection-name', text: c.name }),
        h('span', { class: 'collection-meta', text: summary }),
        count ? h('button', { class: 'link-btn', 'aria-label': `Research ${c.name}`, onClick: () => this.#research(c) }, 'Research') : null,
        count ? h('button', { class: 'link-btn', 'aria-label': `Graph of ${c.name}`, onClick: () => this.#graph(c) }, 'Graph') : null,
        h('button', { class: 'link-btn', 'aria-label': `Add PDFs to ${c.name}`, onClick: () => this.#add(c) }, 'Add PDFs…'),
        h('button', { class: 'link-btn', 'aria-label': `Rename ${c.name}`, onClick: () => this.#rename(c) }, 'Rename'),
        h('button', { class: 'link-btn danger', 'aria-label': `Delete ${c.name}`, onClick: () => this.#delete(c) }, 'Delete')),
      count ? h('div', { class: 'recent-grid', role: 'list', 'aria-label': c.name },
        ...c.documents.map((d, i) => this.#card(d, i, {
          label: 'Remove from collection', from: c.name,
          remove: () => this.#change(() => this.bridge.request('collections.remove', { id: c.id, path: d.path })),
        }))) : null);
  }

  /** Makes a collection change, says why when it's refused, and shows the result. */
  async #change(request) {
    try { return await request(); } catch (err) { toast(err.message, { kind: 'error' }); return null; } finally { await this.#renderCollections(); }
  }

  /** One question asked of every document in the collection; the evidence chosen opens its own document at its page. */
  async #research(c) {
    const evidence = await researchCollectionDialog({
      bridge: this.bridge,
      collection: c,
      onResult: (found) => this.researched.set(c.id, found),
    });
    await this.#renderSaved();
    if (evidence) await this.onOpenEvidence(evidence);
  }

  /** The collection's relationships, derived on the spot from what is already known. Read-only. */
  async #graph(c) {
    await showKnowledgeGraph({
      focus: { kind: 'collection', id: c.id, name: c.name },
      collections: this.collectionsRead,
      evidence: this.researched.get(c.id)?.evidence ?? [],
      onOpen: (node) => (node.number
        ? this.onOpenEvidence({ path: node.path, number: node.number, box: node.box ?? null })
        : this.onOpenRecent(node.path)),
    });
  }

  async #create() {
    const name = await askName({ title: 'New collection', action: 'Create' });
    if (name) await this.#change(() => this.bridge.request('collections.create', { name }));
  }

  async #rename(c) {
    const name = await askName({ title: 'Rename collection', action: 'Rename', value: c.name });
    if (name && name !== c.name) await this.#change(() => this.bridge.request('collections.rename', { id: c.id, name }));
  }

  async #delete(c) {
    const choice = await showDialog({
      title: `Delete “${c.name}”?`,
      message: 'The collection is removed. The documents in it aren’t touched.',
      iconName: 'trash-2',
      buttons: [{ id: 'cancel', label: 'Cancel', primary: true }, { id: 'delete', label: 'Delete collection' }],
    });
    if (choice === 'delete') await this.#change(() => this.bridge.request('collections.delete', { id: c.id }));
  }

  async #add(c) {
    const result = await this.#change(() => this.bridge.request('collections.addDialog', { id: c.id }));
    const already = result ? result.chosen - result.added : 0;
    if (already > 0) toast(`${already === 1 ? 'One document was' : `${already} documents were`} already in “${c.name}”`);
  }

  #renderGreeting() {
    this.date.textContent = dateFormat.format(new Date());
    this.greeting.textContent = `${greeting()}${this.name ? `, ${this.name}` : ''}.`;
  }

  #card(entry, index, { label, from, remove }) {
    const name = fileName(entry.path);
    const meta = entry.exists
      ? [entry.pages ? `${entry.pages} page${entry.pages === 1 ? '' : 's'}` : null, entry.openedAt ? timeAgo(entry.openedAt, { compact: true }) : null].filter(Boolean).join(' · ') || folderOf(entry.path)
      : 'File not found';
    const cover = entry.exists && entry.cover
      ? h('img', { src: entry.cover, alt: '', draggable: 'false' })
      : h('span', { class: 'recent-placeholder', html: icon(entry.exists ? 'file-text' : 'file-x', 26) });
    return h('div', { class: `recent-card${entry.exists ? '' : ' missing'}`, role: 'listitem', style: `--i:${index}` },
      h('button', {
        class: 'recent-open', title: entry.path, disabled: !entry.exists,
        onClick: () => this.onOpenRecent(entry.path),
      },
      h('span', { class: 'recent-thumb' }, cover),
      h('span', { class: 'recent-text' },
        h('span', { class: 'recent-name', text: name }),
        h('span', { class: 'recent-meta', text: meta, title: folderOf(entry.path) }))),
      h('button', {
        class: 'tb-btn small recent-remove', title: label, 'aria-label': `Remove ${name} from ${from}`,
        html: icon('x', 14),
        onClick: remove,
      }));
  }

  async #clear() {
    const choice = await showDialog({
      title: 'Clear recent documents?',
      message: 'The list and its page previews are removed. Your files aren’t touched.',
      iconName: 'clock',
      buttons: [{ id: 'cancel', label: 'Cancel', primary: true }, { id: 'clear', label: 'Clear list' }],
    });
    if (choice !== 'clear') return;
    await this.bridge.request('recent.clear');
    this.refresh();
  }
}

/** Asks for a collection name. Resolves with the trimmed name, or null when cancelled or left empty. */
async function askName({ title, action, value = '' }) {
  const input = h('input', { class: 'field', type: 'text', maxlength: '80', spellcheck: 'false', autocomplete: 'off', placeholder: 'Collection name', 'aria-label': 'Collection name' });
  input.value = value;
  const choice = await showDialog({
    title, content: [input], iconName: 'folder-open',
    buttons: [{ id: 'cancel', label: 'Cancel' }, { id: 'ok', label: action, primary: true }],
    onOpen: () => { requestAnimationFrame(() => input.select()); return input; },
  });
  const name = input.value.trim();
  return choice === 'ok' && name ? name : null;
}
