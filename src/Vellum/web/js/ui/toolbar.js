import { h, commandTitle } from '../dom.js';
import { icon } from '../icons.js';
import { openMenu } from './menu.js';
import { PALETTES } from '../annotations/model.js';
import { toolPrefs } from '../annotations/layer.js';

// The main toolbar: sidebar and Open on the left; the annotation tools in the middle, labelled so
// they read as modes; document actions on the right. Page navigation, zoom and layout are in the
// view bar floating at the bottom of the document (viewbar.js).

const TOOL_BUTTONS = [
  ['select', 'mouse-pointer-2', 'annot.select', 'Select'],
  ['highlight', 'highlighter', 'annot.highlight', 'Highlight'],
  ['underline', 'underline', 'annot.underline', 'Underline'],
  ['note', 'sticky-note', 'annot.note', 'Note'],
  ['ink', 'pen-line', 'annot.ink', 'Draw'],
  ['edit', 'type', 'edit.text', 'Edit'],
];
const INK_WIDTHS = [[1, 'Fine pen'], [2, 'Medium pen'], [3.5, 'Bold pen']];
const COLOR_NAMES = {
  '#ffd84d': 'Yellow', '#a3eab9': 'Mint', '#9ad7f2': 'Aqua', '#ffb38f': 'Peach', '#f5a8d4': 'Pink',
  '#e5484d': 'Red', '#2f6fd6': 'Blue', '#1f9e6b': 'Green', '#231f1b': 'Ink black', '#f0892b': 'Orange',
};

export class Toolbar {
  /** Called with the "More" button when it's clicked; the app builds that menu. */
  onMenu = null;
  /** { tone: label } and a setter, provided by the app (page colours). */
  pageTones = null;
  onPageTone = null;

  constructor(root, app, commands) {
    this.root = root;
    this.app = app;
    this.commands = commands;

    const button = (id, iconName, cls = 'tb-btn') => {
      const c = commands[id];
      return h('button', { class: cls, title: commandTitle(c), 'aria-label': c.label, html: icon(iconName), onClick: () => c.run() });
    };

    this.sidebarBtn = button('sidebar.toggle', 'panel-left');
    this.openBtn = button('file.open', 'folder-open');

    this.toolButtons = TOOL_BUTTONS.map(([, iconName, id, short]) => {
      const c = commands[id];
      return h('button', { class: 'seg-btn', title: commandTitle(c), 'aria-label': c.label, onClick: () => c.run() },
        h('span', { html: icon(iconName, 17) }), h('span', { class: 'seg-label', text: short }));
    });
    this.toolSeg = h('div', { class: 'seg tool-seg', role: 'group', 'aria-label': 'Tools' }, ...this.toolButtons);
    this.toolSeg.style.setProperty('--seg-count', String(TOOL_BUTTONS.length));
    this.colorBtn = h('button', { class: 'tb-btn color-btn', title: 'Colour', 'aria-label': 'Annotation colour', 'aria-haspopup': 'menu', onClick: () => this.#openPalette() },
      h('span', { class: 'color-dot' }));

    this.undoBtn = button('edit.undo', 'undo-2');
    this.redoBtn = button('edit.redo', 'redo-2');
    this.undoBtn.classList.add('history-btn');
    this.redoBtn.classList.add('history-btn');
    this.saveBtn = button('file.save', 'save');
    this.saveBtn.classList.add('save-btn');
    this.searchBtn = button('find.open', 'search');
    this.toneBtn = h('button', {
      class: 'tb-btn tone-btn', title: 'Page colours (Ctrl+Shift+D)', 'aria-label': 'Page colours', 'aria-haspopup': 'menu',
      html: icon('contrast'), onClick: () => this.#openToneMenu(),
    });
    this.printBtn = button('file.print', 'printer');
    this.printBtn.classList.add('print-btn');
    this.menuBtn = h('button', { class: 'tb-btn', title: 'More', 'aria-label': 'More', 'aria-haspopup': 'menu', html: icon('ellipsis'), onClick: () => this.onMenu?.(this.menuBtn) });

    // Groups marked doc-only fade out when no document is open.
    root.append(
      h('div', { class: 'tb-group' }, this.sidebarBtn, this.openBtn),
      h('div', { class: 'tb-spacer' }),
      h('div', { class: 'tb-group tools-group doc-only' }, this.toolSeg, this.colorBtn),
      h('div', { class: 'tb-spacer' }),
      h('div', { class: 'tb-group doc-only' }, this.undoBtn, this.redoBtn, this.saveBtn, this.searchBtn, this.toneBtn, this.printBtn),
      h('div', { class: 'tb-sep' }),
      h('div', { class: 'tb-group' }, this.menuBtn),
    );

    app.addEventListener('activechange', () => this.update());
    app.addEventListener('viewchange', () => this.update());
    this.update();
  }

  update() {
    const s = this.app.active?.state;
    const ready = s?.status === 'ready';
    this.root.classList.toggle('no-doc', !this.app.active);
    for (const b of [this.sidebarBtn, this.searchBtn, this.printBtn, this.colorBtn, this.toneBtn, ...this.toolButtons]) b.disabled = !ready;
    // Text editing isn't possible in some documents (protected ones): say why on the button.
    const editBtn = this.toolButtons[TOOL_BUTTONS.findIndex(([tool]) => tool === 'edit')];
    const blocked = ready ? this.app.active.textEditing?.unavailableReason : null;
    if (blocked) editBtn.disabled = true;
    editBtn.title = blocked ?? commandTitle(this.commands['edit.text']);

    const toolIndex = Math.max(0, TOOL_BUTTONS.findIndex(([tool]) => tool === s?.tool));
    this.toolSeg.style.setProperty('--seg-index', String(toolIndex));
    this.toolSeg.toggleAttribute('data-empty', !ready);
    this.toolButtons.forEach((b, i) => b.setAttribute('aria-pressed', String(ready && i === toolIndex)));
    this.colorBtn.style.setProperty('--dot', toolPrefs[this.#colorTool()]);

    this.saveBtn.hidden = !(ready && s.dirty);
    this.undoBtn.disabled = !ready || !s.canUndo;
    this.redoBtn.disabled = !ready || !s.canRedo;
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
    return !tool || tool === 'select' || tool === 'edit' ? 'highlight' : tool;
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
}
