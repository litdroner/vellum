import { h, debounce } from '../dom.js';
import { icon } from '../icons.js';

// In-document search. pdf.js's find controller does the matching and highlighting;
// this is the UI around it. Each document remembers its own query.

const FindState = { FOUND: 0, NOT_FOUND: 1, WRAPPED: 2, PENDING: 3 };

export class FindBar {
  constructor(root, app) {
    this.app = app;
    this.input = h('input', { class: 'find-input', type: 'search', placeholder: 'Find in document', spellcheck: 'false', 'aria-label': 'Find in document' });
    this.count = h('span', { class: 'find-count', 'aria-live': 'polite' });
    this.caseBtn = h('button', { class: 'tb-btn small', title: 'Match case', 'aria-pressed': 'false', html: icon('case-sensitive', 16), onClick: () => this.#toggle('caseSensitive', this.caseBtn) });
    this.wordBtn = h('button', { class: 'tb-btn small', title: 'Whole words', 'aria-pressed': 'false', html: icon('whole-word', 16), onClick: () => this.#toggle('entireWord', this.wordBtn) });
    this.prevBtn = h('button', { class: 'tb-btn small', title: 'Previous match (Shift+Enter)', html: icon('chevron-up', 16), onClick: () => this.step(true) });
    this.nextBtn = h('button', { class: 'tb-btn small', title: 'Next match (Enter)', html: icon('chevron-down', 16), onClick: () => this.step(false) });
    this.closeBtn = h('button', { class: 'tb-btn small', title: 'Close (Esc)', html: icon('x', 16), onClick: () => this.close() });
    this.el = h('div', { class: 'findbar ui', role: 'search', hidden: true },
      h('div', { class: 'find-field' }, h('span', { class: 'find-glyph', html: icon('search', 15) }), this.input, this.count),
      this.caseBtn, this.wordBtn, h('div', { class: 'find-sep' }),
      this.prevBtn, this.nextBtn, this.closeBtn);
    root.append(this.el);

    const run = debounce(() => this.app.active?.search(this.input.value), 140);
    this.input.addEventListener('input', run);
    this.input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        run.cancel();
        this.step(e.shiftKey);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        this.close();
      }
    });

    app.addEventListener('viewchange', () => this.#render());
    app.addEventListener('activechange', () => this.#syncToActive());
  }

  get isOpen() { return !this.el.hidden; }

  open(prefill = '') {
    const view = this.app.active;
    if (view?.status !== 'ready') return;
    this.el.hidden = false;
    requestAnimationFrame(() => this.el.classList.add('open'));
    if (prefill) this.input.value = prefill.slice(0, 200);
    else if (!this.input.value) this.input.value = view.find.query;
    this.input.focus();
    this.input.select();
    if (this.input.value) view.search(this.input.value);
  }

  close() {
    this.el.classList.remove('open');
    this.el.hidden = true;
    this.app.active?.endSearch();
    this.app.active?.focus();
  }

  /** Next (or previous) match; opens the bar if it's closed. */
  step(backwards) {
    const view = this.app.active;
    if (!this.isOpen || !this.input.value) {
      this.open(view?.getSelectedText());
      return;
    }
    if (view?.find.query !== this.input.value || view.find.state === null) view?.search(this.input.value);
    else view?.search(this.input.value, { again: true, findPrevious: backwards });
  }

  #toggle(option, button) {
    const view = this.app.active;
    if (!view) return;
    const value = !view.find[option];
    button.setAttribute('aria-pressed', String(value));
    view.search(this.input.value, { [option]: value });
    this.input.focus();
  }

  #syncToActive() {
    const view = this.app.active;
    if (!view || view.status !== 'ready') {
      this.el.hidden = true;
      return;
    }
    this.input.value = view.find.query;
    this.caseBtn.setAttribute('aria-pressed', String(view.find.caseSensitive));
    this.wordBtn.setAttribute('aria-pressed', String(view.find.entireWord));
    this.#render();
  }

  #render() {
    const find = this.app.active?.find;
    if (!find || !this.isOpen) return;
    const { query, state, current, total } = find;
    this.el.classList.toggle('no-match', Boolean(query) && state === FindState.NOT_FOUND);
    if (!query || state === null) this.count.textContent = '';
    else if (state === FindState.NOT_FOUND) this.count.textContent = 'No matches';
    else if (total > 0) this.count.textContent = `${current || 0} of ${total}${total >= 1000 ? '+' : ''}`;
    else this.count.textContent = 'Searching…';
  }
}
