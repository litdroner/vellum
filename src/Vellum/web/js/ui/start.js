import { h, timeAgo } from '../dom.js';
import { icon } from '../icons.js';
import { showDialog } from './dialogs.js';

// The home screen, shown when no document is open: a greeting, a large Open card and the documents
// opened recently, each with a picture of its first page (captured when it was last open).

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
  constructor(root, { bridge, onOpenDialog, onOpenRecent }) {
    this.bridge = bridge;
    this.onOpenRecent = onOpenRecent;
    this.name = '';
    this.greeting = h('h1', { class: 'home-greeting' });
    this.date = h('p', { class: 'home-date' });
    this.grid = h('div', { class: 'recent-grid', role: 'list' });
    this.recent = h('section', { class: 'recent', hidden: true, 'aria-label': 'Recent documents' },
      h('div', { class: 'recent-head' },
        h('h2', { text: 'Recent documents' }),
        h('button', { class: 'link-btn', onClick: () => this.#clear() }, 'Clear list')),
      this.grid);
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
              h('kbd', { text: 'Ctrl+O' }))),
          h('div', { class: 'home-art', html: ART })),
        this.recent));
    root.append(this.el);
    this.#renderGreeting();
  }

  /** The person's first name, for the greeting (empty greets without one). */
  setName(name) {
    this.name = name;
    this.#renderGreeting();
  }

  async refresh() {
    this.#renderGreeting();
    let entries = [];
    try { ({ entries } = await this.bridge.request('recent.list')); } catch { /* no host (dev) */ }
    this.recent.hidden = entries.length === 0;
    this.grid.replaceChildren(...entries.slice(0, 12).map((e, i) => this.#card(e, i)));
  }

  #renderGreeting() {
    this.date.textContent = dateFormat.format(new Date());
    this.greeting.textContent = `${greeting()}${this.name ? `, ${this.name}` : ''}.`;
  }

  #card(entry, index) {
    const name = fileName(entry.path);
    const meta = entry.exists
      ? [entry.pages ? `${entry.pages} page${entry.pages === 1 ? '' : 's'}` : null, timeAgo(entry.openedAt, { compact: true })].filter(Boolean).join(' · ')
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
        class: 'tb-btn small recent-remove', title: 'Remove from list', 'aria-label': `Remove ${name} from recent documents`,
        html: icon('x', 14),
        onClick: async () => { await this.bridge.request('recent.remove', { path: entry.path }); this.refresh(); },
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
