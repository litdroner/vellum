import { h } from '../dom.js';
import { icon } from '../icons.js';

// Document tabs in the title bar. Click to switch, middle-click or × to close, drag to reorder.
// A peach dot marks unsaved annotations.

export class TabStrip {
  #tabs = new Map(); // view → { el, icon, name, iconKey }

  constructor(host, app, { onNew, onClose }) {
    this.app = app;
    this.onClose = onClose;
    this.list = h('div', { class: 'tabs', role: 'tablist', 'aria-label': 'Open documents' });
    this.newBtn = h('button', { class: 'tab-new', title: 'Open a PDF (Ctrl+O)', 'aria-label': 'Open a PDF', html: icon('plus', 16), onClick: onNew });
    host.replaceChildren(this.list, this.newBtn);

    // Vertical wheel scrolls a long tab strip sideways.
    this.list.addEventListener('wheel', (e) => {
      if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
      this.list.scrollLeft += e.deltaY;
      e.preventDefault();
    }, { passive: false });

    for (const type of ['viewschange', 'activechange', 'tabchange']) app.addEventListener(type, () => this.render());
    this.render();
  }

  render() {
    const views = this.app.views;
    for (const [view, tab] of this.#tabs) {
      if (views.includes(view)) continue;
      this.#tabs.delete(view);
      tab.el.classList.add('closing');
      tab.el.addEventListener('animationend', () => tab.el.remove(), { once: true });
      setTimeout(() => tab.el.remove(), 400);
    }

    const live = () => [...this.list.children].filter((c) => !c.classList.contains('closing'));
    views.forEach((view, index) => {
      let tab = this.#tabs.get(view);
      if (!tab) {
        tab = this.#create(view);
        this.#tabs.set(view, tab);
      }
      const s = view.state;
      const active = view === this.app.active;
      tab.el.classList.toggle('active', active);
      tab.el.setAttribute('aria-selected', String(active));
      tab.el.classList.toggle('dirty', s.dirty);
      tab.el.title = view.file.path;
      if (tab.name.textContent !== view.file.name) tab.name.textContent = view.file.name;
      const iconKey = s.status === 'loading' ? 'loading' : s.status === 'error' ? 'triangle-alert' : view.encrypted ? 'lock' : 'file-text';
      if (tab.iconKey !== iconKey) {
        tab.iconKey = iconKey;
        tab.icon.innerHTML = iconKey === 'loading' ? '<span class="tab-spinner"></span>' : icon(iconKey, 14);
      }
      const current = live();
      if (current[index] !== tab.el) this.list.insertBefore(tab.el, current[index] ?? null);
    });

    const activeTab = this.#tabs.get(this.app.active)?.el;
    if (activeTab && !activeTab.classList.contains('dragging')) activeTab.scrollIntoView({ inline: 'nearest', block: 'nearest' });
  }

  #create(view) {
    const iconEl = h('span', { class: 'tab-icon' });
    const name = h('span', { class: 'tab-name' });
    const close = h('button', { class: 'tab-close', title: 'Close (Ctrl+W)', 'aria-label': 'Close tab', tabindex: '-1', html: icon('x', 13) });
    const el = h('div', { class: 'tab', role: 'tab' }, iconEl, name, h('span', { class: 'tab-dirty', title: 'Unsaved annotations' }), close);

    close.addEventListener('click', (e) => {
      e.stopPropagation();
      this.onClose(view);
    });
    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || e.target.closest('.tab-close')) return;
      this.app.activate(view);
      this.#dragToReorder(e, view, el);
    });
    el.addEventListener('mousedown', (e) => { if (e.button === 1) e.preventDefault(); }); // no autoscroll cursor
    el.addEventListener('auxclick', (e) => {
      if (e.button !== 1) return;
      e.preventDefault();
      this.onClose(view);
    });
    return { el, icon: iconEl, name, iconKey: null };
  }

  #dragToReorder(e, view, el) {
    let base = e.clientX;
    let dragging = false;
    const center = (t) => {
      const r = t.getBoundingClientRect();
      return r.left + r.width / 2;
    };
    const move = (ev) => {
      if (!dragging) {
        if (Math.abs(ev.clientX - base) < 5) return;
        dragging = true;
        el.setPointerCapture(ev.pointerId);
        el.classList.add('dragging');
      }
      const dx = ev.clientX - base;
      el.style.transform = `translateX(${dx}px)`;
      const tabs = [...this.list.querySelectorAll('.tab:not(.closing)')];
      const i = tabs.indexOf(el);
      const mid = center(el);
      const target = tabs[i + 1] && mid > center(tabs[i + 1]) ? i + 1 : tabs[i - 1] && mid < center(tabs[i - 1]) ? i - 1 : i;
      if (target === i) return;
      // Keep the tab under the pointer as it changes place in the strip.
      const before = el.getBoundingClientRect().left - dx;
      this.app.move(view, target);
      const after = el.getBoundingClientRect().left - dx;
      base += after - before;
      el.style.transform = `translateX(${ev.clientX - base}px)`;
    };
    const up = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      if (!dragging) return;
      el.classList.remove('dragging');
      const from = el.style.transform;
      el.style.transform = '';
      el.animate([{ transform: from }, { transform: 'none' }], { duration: 180, easing: 'cubic-bezier(.2,.8,.2,1)' });
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  }
}
