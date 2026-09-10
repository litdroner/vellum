import { h } from '../dom.js';
import { icon } from '../icons.js';
import { markSvg } from '../brand.js';

// The custom title bar and the invisible resize strips around the window edge.
// Dragging works through CSS `app-region: drag` (Windows treats it as the real caption);
// the edge strips ask the host to start Windows' own resize loop.

const GLYPHS = { minimize: '', maximize: '', restore: '', close: '' };
const EDGES = ['n', 's', 'e', 'w', 'nw', 'ne', 'sw', 'se'];

export class TitleBar {
  constructor(root, app, { bridge, commands }) {
    this.app = app;
    this.commands = commands;

    const control = (kind, label, message) => h('button', {
      class: `wc-btn ${kind}`, title: label, 'aria-label': label, tabindex: '-1', onClick: () => bridge.send(message),
    }, h('span', { class: 'wc-glyph', text: GLYPHS[kind] }));

    this.maxBtn = control('maximize', 'Maximize', 'window.toggleMaximize');
    this.themeBtn = h('button', { class: 'tb-btn small', onClick: () => commands['view.theme'].run() });
    /** The tab strip lives here (see tabs.js). */
    this.tabHost = h('div', { class: 'tab-host' });

    root.append(
      h('div', { class: 'brand' }, h('span', { class: 'brand-mark', html: markSvg(17) }), h('span', { class: 'brand-name', text: 'Vellum' })),
      this.tabHost,
      h('div', { class: 'titlebar-actions' }, this.themeBtn),
      h('div', { class: 'window-controls' },
        control('minimize', 'Minimize', 'window.minimize'), this.maxBtn, control('close', 'Close', 'window.close')));

    const edges = document.getElementById('window-edges');
    for (const edge of EDGES) {
      edges.append(h('div', {
        class: `edge edge-${edge}`,
        onPointerdown: (e) => {
          if (e.button !== 0) return;
          e.preventDefault();
          bridge.send('window.resize', { edge });
        },
      }));
    }

    bridge.on('window-state', ({ maximized }) => this.#setMaximized(maximized));
    bridge.on('window-active', ({ active }) => document.body.classList.toggle('inactive', !active));
    bridge.request('window.state').then((s) => {
      this.#setMaximized(s.maximized);
      document.body.classList.toggle('inactive', !s.active);
    }).catch(() => { /* no host */ });

    this.syncTheme();
  }

  syncTheme() {
    const light = document.documentElement.dataset.theme === 'light';
    const label = light ? 'Dark theme (Ctrl+Shift+L)' : 'Light theme (Ctrl+Shift+L)';
    this.themeBtn.innerHTML = icon(light ? 'moon' : 'sun', 16);
    this.themeBtn.title = label;
    this.themeBtn.setAttribute('aria-label', label);
  }

  #setMaximized(maximized) {
    document.body.classList.toggle('maximized', maximized);
    this.maxBtn.querySelector('.wc-glyph').textContent = maximized ? GLYPHS.restore : GLYPHS.maximize;
    const label = maximized ? 'Restore' : 'Maximize';
    this.maxBtn.title = label;
    this.maxBtn.setAttribute('aria-label', label);
  }
}
