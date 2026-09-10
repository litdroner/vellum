import { h, commandTitle } from '../dom.js';
import { icon } from '../icons.js';
import { openMenu } from './menu.js';
import { PALETTES } from '../annotations/model.js';
import { toolPrefs } from '../annotations/layer.js';

const ZOOM_CHOICES = [0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4];
const TOOL_BUTTONS = [
  ['select', 'mouse-pointer-2', 'annot.select'],
  ['highlight', 'highlighter', 'annot.highlight'],
  ['underline', 'underline', 'annot.underline'],
  ['note', 'sticky-note', 'annot.note'],
  ['ink', 'pen-line', 'annot.ink'],
];
const INK_WIDTHS = [[1, 'Fine pen'], [2, 'Medium pen'], [3.5, 'Bold pen']];
const COLOR_NAMES = {
  '#ffd84d': 'Yellow', '#a3eab9': 'Mint', '#9ad7f2': 'Aqua', '#ffb38f': 'Peach', '#f5a8d4': 'Pink',
  '#e5484d': 'Red', '#2f6fd6': 'Blue', '#1f9e6b': 'Green', '#231f1b': 'Ink black', '#f0892b': 'Orange',
};

export class Toolbar {
  /** Called with the "More" button when it's clicked; the app builds that menu. */
  onMenu = null;

  constructor(root, app, commands) {
    this.root = root;
    this.app = app;
    this.commands = commands;

    const button = (id, iconName, cls = 'tb-btn') => {
      const c = commands[id];
      return h('button', { class: cls, title: commandTitle(c), 'aria-label': c.label, html: icon(iconName), onClick: () => c.run() });
    };

    this.openBtn = button('file.open', 'folder-open');
    this.sidebarBtn = button('sidebar.toggle', 'panel-left');
    this.prevBtn = button('page.prev', 'chevron-up');
    this.nextBtn = button('page.next', 'chevron-down');
    this.pageInput = h('input', { class: 'page-input', type: 'text', inputmode: 'numeric', spellcheck: 'false', 'aria-label': 'Current page', title: 'Go to page (Ctrl+G)' });
    this.pageTotal = h('span', { class: 'page-total' });
    this.zoomOutBtn = button('zoom.out', 'zoom-out');
    this.zoomInBtn = button('zoom.in', 'zoom-in');
    this.zoomBtn = h('button', { class: 'tb-btn zoom-value', title: 'Zoom options', 'aria-haspopup': 'menu', onClick: () => this.#openZoomMenu() });

    this.toolButtons = TOOL_BUTTONS.map(([, iconName, id]) => button(id, iconName, 'seg-btn'));
    this.toolSeg = h('div', { class: 'seg annot-tools', role: 'group', 'aria-label': 'Annotation tools' }, ...this.toolButtons);
    this.toolSeg.style.setProperty('--seg-count', String(TOOL_BUTTONS.length));
    this.colorBtn = h('button', { class: 'tb-btn color-btn', title: 'Colour', 'aria-label': 'Annotation colour', 'aria-haspopup': 'menu', onClick: () => this.#openPalette() },
      h('span', { class: 'color-dot' }));

    this.continuousBtn = button('view.continuous', 'gallery-vertical-end', 'seg-btn');
    this.singleBtn = button('view.single', 'file', 'seg-btn');
    this.layoutSeg = h('div', { class: 'seg doc-only layout-seg', role: 'group', 'aria-label': 'Page layout' }, this.continuousBtn, this.singleBtn);
    this.toneBtn = h('button', {
      class: 'tb-btn tone-btn', title: 'Page colours (Ctrl+Shift+D)', 'aria-label': 'Page colours', 'aria-haspopup': 'menu',
      html: icon('contrast'), onClick: () => this.#openToneMenu(),
    });
    this.rotateCcwBtn = button('view.rotateCcw', 'rotate-ccw');
    this.rotateCwBtn = button('view.rotateCw', 'rotate-cw');
    this.searchBtn = button('find.open', 'search');
    this.printBtn = button('file.print', 'printer');
    this.saveBtn = button('file.save', 'save');
    this.saveBtn.classList.add('save-btn');
    this.menuBtn = h('button', { class: 'tb-btn', title: 'More options', 'aria-label': 'More options', 'aria-haspopup': 'menu', html: icon('ellipsis'), onClick: () => this.onMenu?.(this.menuBtn) });

    // Groups marked doc-only fade out when no document is open.
    root.append(
      h('div', { class: 'tb-group' }, this.openBtn, this.sidebarBtn),
      h('div', { class: 'tb-sep doc-only' }),
      h('div', { class: 'tb-group page-group doc-only' }, this.prevBtn, h('label', { class: 'page-nav' }, this.pageInput, this.pageTotal), this.nextBtn),
      h('div', { class: 'tb-spacer' }),
      h('div', { class: 'tb-group zoom-group doc-only' }, this.zoomOutBtn, this.zoomBtn, this.zoomInBtn),
      h('div', { class: 'tb-spacer' }),
      h('div', { class: 'tb-group tools-group doc-only' }, this.toolSeg, this.colorBtn),
      h('div', { class: 'tb-sep doc-only' }),
      this.layoutSeg,
      h('div', { class: 'tb-group doc-only' }, this.toneBtn),
      h('div', { class: 'tb-group rotate-group doc-only' }, this.rotateCcwBtn, this.rotateCwBtn),
      h('div', { class: 'tb-sep doc-only' }),
      h('div', { class: 'tb-group doc-only' }, this.searchBtn, this.printBtn, this.saveBtn),
      h('div', { class: 'tb-group' }, this.menuBtn),
    );

    this.pageInput.addEventListener('focus', () => this.pageInput.select());
    this.pageInput.addEventListener('blur', () => this.update());
    this.pageInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        const n = parseInt(this.pageInput.value, 10);
        if (Number.isFinite(n)) app.active?.goToPage(n, { pulse: true });
        app.active?.focus();
      } else if (e.key === 'Escape') {
        this.update();
        app.active?.focus();
      }
    });

    app.addEventListener('activechange', () => this.update());
    app.addEventListener('viewchange', () => this.update());
    this.update();
  }

  focusPageInput() {
    if (this.pageInput.disabled) return;
    this.pageInput.focus();
    this.pageInput.select();
  }

  update() {
    const s = this.app.active?.state;
    const ready = s?.status === 'ready';
    this.root.classList.toggle('no-doc', !this.app.active);
    for (const b of [this.sidebarBtn, this.prevBtn, this.nextBtn, this.pageInput, this.zoomOutBtn, this.zoomInBtn, this.zoomBtn,
      this.continuousBtn, this.singleBtn, this.rotateCcwBtn, this.rotateCwBtn, this.searchBtn, this.printBtn, this.colorBtn, ...this.toolButtons]) {
      b.disabled = !ready;
    }
    if (document.activeElement !== this.pageInput) this.pageInput.value = ready ? String(s.pageNumber) : '';
    this.pageTotal.textContent = ready ? `/ ${s.pagesCount}` : '';
    this.pageInput.style.width = `${Math.max(2, String(s?.pagesCount ?? 1).length) + 1.6}ch`;
    if (ready) {
      this.prevBtn.disabled = s.pageNumber <= 1;
      this.nextBtn.disabled = s.pageNumber >= s.pagesCount;
    }
    this.zoomBtn.textContent = ready ? `${Math.round(s.scale * 100)}%` : '—';

    this.continuousBtn.setAttribute('aria-pressed', String(ready && s.viewMode === 'continuous'));
    this.singleBtn.setAttribute('aria-pressed', String(ready && s.viewMode === 'single'));
    this.layoutSeg.style.setProperty('--seg-index', ready && s.viewMode === 'single' ? '1' : '0');
    this.layoutSeg.toggleAttribute('data-empty', !ready);

    const toolIndex = Math.max(0, TOOL_BUTTONS.findIndex(([tool]) => tool === s?.tool));
    this.toolSeg.style.setProperty('--seg-index', String(toolIndex));
    this.toolSeg.toggleAttribute('data-empty', !ready);
    this.toolButtons.forEach((b, i) => b.setAttribute('aria-pressed', String(ready && i === toolIndex)));
    this.colorBtn.style.setProperty('--dot', toolPrefs[this.#colorTool()]);

    this.saveBtn.hidden = !(ready && s.dirty);
    this.toneBtn.disabled = !ready;
    this.toneBtn.setAttribute('aria-pressed', String((document.documentElement.dataset.pageTone ?? 'normal') !== 'normal'));
  }

  #openToneMenu() {
    const current = document.documentElement.dataset.pageTone ?? 'normal';
    openMenu(Object.entries(this.pageTones ?? {}).map(([tone, label]) => ({
      label, checked: tone === current, action: () => this.onPageTone?.(tone),
    })), { anchor: this.toneBtn, align: 'center' });
  }

  /** The tool whose colour the swatch button shows (Select shows the highlighter's). */
  #colorTool() {
    const tool = this.app.active?.state.tool;
    return !tool || tool === 'select' ? 'highlight' : tool;
  }

  #openPalette() {
    const tool = this.#colorTool();
    const items = PALETTES[tool].map((color) => ({
      label: COLOR_NAMES[color] ?? color,
      swatch: color,
      checked: toolPrefs[tool] === color,
      action: () => {
        toolPrefs[tool] = color;
        toolPrefs.save();
        this.update();
      },
    }));
    if (tool === 'ink') {
      items.push('-', ...INK_WIDTHS.map(([width, label]) => ({
        label, checked: toolPrefs.inkWidth === width,
        action: () => { toolPrefs.inkWidth = width; toolPrefs.save(); },
      })));
    }
    openMenu(items, { anchor: this.colorBtn, align: 'center', className: 'palette-menu' });
  }

  #openZoomMenu() {
    const view = this.app.active;
    if (!view) return;
    const { scale, scaleValue } = view.state;
    const preset = (value, commandId) => ({
      label: this.commands[commandId].label,
      checked: scaleValue === value,
      shortcut: this.commands[commandId].keys[0],
      action: () => this.commands[commandId].run(),
    });
    openMenu([
      preset('page-width', 'zoom.fitWidth'),
      preset('page-fit', 'zoom.fitPage'),
      preset('page-actual', 'zoom.actual'),
      '-',
      ...ZOOM_CHOICES.map((z) => ({
        label: `${Math.round(z * 100)}%`,
        checked: !isNaN(parseFloat(scaleValue)) && Math.abs(scale - z) < 0.001,
        action: () => view.zoomTo(z),
      })),
    ], { anchor: this.zoomBtn, align: 'center', className: 'zoom-menu' });
  }
}
