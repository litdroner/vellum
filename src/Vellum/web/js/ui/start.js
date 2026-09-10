import { h } from '../dom.js';
import { icon } from '../icons.js';
import { markSvg } from '../brand.js';

// The screen shown when no document is open: open button, drop hint, recent files.

const relative = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
const UNITS = [['year', 31536000], ['month', 2592000], ['week', 604800], ['day', 86400], ['hour', 3600], ['minute', 60]];

function timeAgo(iso) {
  const seconds = (new Date(iso) - Date.now()) / 1000;
  for (const [unit, size] of UNITS) {
    if (Math.abs(seconds) >= size) return relative.format(Math.round(seconds / size), unit);
  }
  return 'just now';
}

const fileName = (path) => path.slice(path.lastIndexOf('\\') + 1);
const folderOf = (path) => path.slice(0, Math.max(0, path.lastIndexOf('\\')));

export class StartScreen {
  constructor(root, { bridge, onOpenDialog, onOpenRecent }) {
    this.bridge = bridge;
    this.onOpenRecent = onOpenRecent;
    this.list = h('div', { class: 'recent-list', role: 'list' });
    this.recent = h('section', { class: 'recent', hidden: true, 'aria-label': 'Recent files' },
      h('div', { class: 'recent-head' },
        h('h2', { text: 'Recent' }),
        h('button', { class: 'link-btn', onClick: () => this.#clear() }, 'Clear')),
      this.list);
    this.el = h('div', { class: 'start ui' },
      h('div', { class: 'start-hero' },
        h('div', { class: 'mark-tile', html: markSvg(38) }),
        h('h1', { class: 'start-title', text: 'Vellum' }),
        h('p', { class: 'start-sub', text: 'A quiet place to read.' })),
      h('div', { class: 'start-well' },
        h('button', { class: 'btn primary start-open', onClick: onOpenDialog },
          h('span', { html: icon('folder-open', 17) }), 'Open a PDF', h('kbd', { text: 'Ctrl+O' })),
        h('p', { class: 'start-hint', text: 'or drop files anywhere in the window' })),
      this.recent);
    root.append(this.el);
  }

  async refresh() {
    let entries = [];
    try { ({ entries } = await this.bridge.request('recent.list')); } catch { /* no host (dev) */ }
    this.recent.hidden = entries.length === 0;
    this.list.replaceChildren(...entries.slice(0, 12).map((e) => this.#row(e)));
  }

  #row(entry) {
    const name = fileName(entry.path);
    return h('div', { class: `recent-row${entry.exists ? '' : ' missing'}`, role: 'listitem' },
      h('button', {
        class: 'recent-open', title: entry.path, disabled: !entry.exists,
        onClick: () => this.onOpenRecent(entry.path),
      },
      h('span', { class: 'recent-icon', html: icon(entry.exists ? 'file-text' : 'file-x', 17) }),
      h('span', { class: 'recent-text' },
        h('span', { class: 'recent-name', text: name }),
        h('span', { class: 'recent-path', text: entry.exists ? folderOf(entry.path) : 'File not found' })),
      h('span', { class: 'recent-time', text: timeAgo(entry.openedAt) })),
      h('button', {
        class: 'tb-btn small recent-remove', title: 'Remove from list', 'aria-label': `Remove ${name} from recent files`,
        html: icon('x', 14),
        onClick: async () => { await this.bridge.request('recent.remove', { path: entry.path }); this.refresh(); },
      }));
  }

  async #clear() {
    await this.bridge.request('recent.clear');
    this.refresh();
  }
}
