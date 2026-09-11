import { h, commandTitle } from '../dom.js';
import { icon } from '../icons.js';
import { appIconSvg } from '../brand.js';

// The custom title bar and the invisible resize strips around the window edge.
// Dragging works through CSS `app-region: drag` (Windows treats it as the real caption);
// the edge strips ask the host to start Windows' own resize loop.

// Segoe Fluent Icons / MDL2 caption glyphs, written as escapes so no editor can drop them:
// ChromeMinimize, ChromeMaximize, ChromeRestore, ChromeClose.
const GLYPHS = { minimize: '\uE921', maximize: '\uE922', restore: '\uE923', close: '\uE8BB' };
const EDGES = ['n', 's', 'e', 'w', 'nw', 'ne', 'sw', 'se'];

export class TitleBar {
  /** Called when the "Update" pill is clicked. */
  onUpdate = null;

  constructor(root, app, { bridge, commands }) {
    this.app = app;
    this.commands = commands;

    const control = (kind, label, message) => h('button', {
      class: `wc-btn ${kind}`, title: label, 'aria-label': label, tabindex: '-1', onClick: () => bridge.send(message),
    }, h('span', { class: 'wc-glyph', text: GLYPHS[kind] }));
    const action = (id, iconName) => h('button', {
      class: 'tb-btn small', title: commandTitle(commands[id]), 'aria-label': commands[id].label,
      html: icon(iconName, 16), onClick: (e) => commands[id].run(e),
    });

    this.maxBtn = control('maximize', 'Maximize', 'window.toggleMaximize');
    this.paletteBtn = action('app.palette', 'zap');
    this.settingsBtn = action('app.settings', 'settings');
    this.themeBtn = h('button', { class: 'tb-btn small', onClick: (e) => commands['view.theme'].run(e) });
    this.updateBtn = h('button', { class: 'update-pill', hidden: true, onClick: () => this.onUpdate?.() },
      h('span', { class: 'update-pill-dot' }), h('span', { text: 'Update' }));
    /** The tab strip lives here (see tabs.js). */
    this.tabHost = h('div', { class: 'tab-host' });

    root.append(
      h('div', { class: 'brand' }, h('span', { class: 'brand-mark', html: appIconSvg(28) }), h('span', { class: 'brand-name', text: 'Vellum' })),
      this.tabHost,
      h('div', { class: 'titlebar-actions' }, this.updateBtn, this.paletteBtn, this.settingsBtn, this.themeBtn),
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

  /** The sun/moon button shows the mode it switches to. */
  syncTheme() {
    const dark = document.documentElement.dataset.theme === 'dark';
    const label = dark ? 'Light mode (Ctrl+Shift+L)' : 'Dark mode (Ctrl+Shift+L)';
    this.themeBtn.innerHTML = icon(dark ? 'sun' : 'moon', 16);
    this.themeBtn.title = label;
    this.themeBtn.setAttribute('aria-label', label);
  }

  /** Shows the "Update" pill while a new version is available (null hides it). */
  setUpdate(offer) {
    this.updateBtn.hidden = !offer;
    if (!offer) return;
    const label = `Vellum ${offer.version} is available`;
    this.updateBtn.title = label;
    this.updateBtn.setAttribute('aria-label', label);
  }

  #setMaximized(maximized) {
    document.body.classList.toggle('maximized', maximized);
    this.maxBtn.querySelector('.wc-glyph').textContent = maximized ? GLYPHS.restore : GLYPHS.maximize;
    const label = maximized ? 'Restore' : 'Maximize';
    this.maxBtn.title = label;
    this.maxBtn.setAttribute('aria-label', label);
  }
}
