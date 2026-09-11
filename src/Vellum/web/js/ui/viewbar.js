import { h, commandTitle } from '../dom.js';
import { icon } from '../icons.js';
import { openMenu } from './menu.js';

// The view bar floating at the bottom of the document: page navigation, zoom, fit, rotation and
// layout. It follows the active document and is hidden while none is ready.

const ZOOM_CHOICES = [0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4];

export class ViewBar {
  constructor(stage, app, commands) {
    this.app = app;
    this.commands = commands;

    const button = (id, iconName, cls = 'tb-btn small') => {
      const c = commands[id];
      return h('button', { class: cls, title: commandTitle(c), 'aria-label': c.label, html: icon(iconName, 16), onClick: () => c.run() });
    };

    this.prevBtn = button('page.prev', 'chevron-left');
    this.nextBtn = button('page.next', 'chevron-right');
    this.pageInput = h('input', { class: 'page-input', type: 'text', inputmode: 'numeric', spellcheck: 'false', 'aria-label': 'Current page', title: 'Go to page (Ctrl+G)' });
    this.pageTotal = h('span', { class: 'page-total' });
    this.zoomOutBtn = button('zoom.out', 'minus');
    this.zoomInBtn = button('zoom.in', 'plus');
    this.zoomBtn = h('button', { class: 'tb-btn small zoom-value', title: 'Zoom options', 'aria-haspopup': 'menu', onClick: () => this.#openZoomMenu() });
    this.fitPageBtn = button('zoom.fitPage', 'maximize');
    this.fitWidthBtn = button('zoom.fitWidth', 'move-horizontal');
    this.rotateBtn = button('view.rotateCw', 'rotate-cw');
    this.continuousBtn = button('view.continuous', 'gallery-vertical-end', 'seg-btn');
    this.singleBtn = button('view.single', 'file', 'seg-btn');
    this.layoutSeg = h('div', { class: 'seg layout-seg', role: 'group', 'aria-label': 'Page layout' }, this.continuousBtn, this.singleBtn);

    this.el = h('div', { class: 'viewbar ui', role: 'toolbar', 'aria-label': 'View', hidden: true },
      h('div', { class: 'vb-group vb-nav' }, this.prevBtn, h('label', { class: 'page-nav' }, this.pageInput, this.pageTotal), this.nextBtn),
      h('div', { class: 'vb-sep' }),
      h('div', { class: 'vb-group vb-zoom' }, this.zoomOutBtn, this.zoomBtn, this.zoomInBtn),
      h('div', { class: 'vb-sep vb-sep-fit' }),
      h('div', { class: 'vb-group vb-fit' }, this.fitPageBtn, this.fitWidthBtn, this.rotateBtn),
      h('div', { class: 'vb-sep vb-sep-layout' }),
      this.layoutSeg);
    stage.append(this.el);

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
    if (this.el.hidden) return;
    this.pageInput.focus();
    this.pageInput.select();
  }

  /** A brief nudge on the zoom value, so zooming with the wheel is visible here. */
  pulseZoom() {
    this.zoomBtn.classList.remove('pulse');
    void this.zoomBtn.offsetWidth; // restart the animation
    this.zoomBtn.classList.add('pulse');
  }

  update() {
    const s = this.app.active?.state;
    const ready = s?.status === 'ready';
    this.el.hidden = !ready;
    if (!ready) return;
    if (document.activeElement !== this.pageInput) this.pageInput.value = String(s.pageNumber);
    this.pageTotal.textContent = `/ ${s.pagesCount}`;
    this.pageInput.style.width = `${Math.max(2, String(s.pagesCount).length) + 1.6}ch`;
    this.prevBtn.disabled = s.pageNumber <= 1;
    this.nextBtn.disabled = s.pageNumber >= s.pagesCount;
    this.zoomBtn.textContent = `${Math.round(s.scale * 100)}%`;
    this.fitPageBtn.setAttribute('aria-pressed', String(s.scaleValue === 'page-fit'));
    this.fitWidthBtn.setAttribute('aria-pressed', String(s.scaleValue === 'page-width'));
    this.continuousBtn.setAttribute('aria-pressed', String(s.viewMode === 'continuous'));
    this.singleBtn.setAttribute('aria-pressed', String(s.viewMode === 'single'));
    this.layoutSeg.style.setProperty('--seg-index', s.viewMode === 'single' ? '1' : '0');
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
