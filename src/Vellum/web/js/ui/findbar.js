import { h, debounce } from '../dom.js';
import { icon } from '../icons.js';
import { EditError } from '../editing/edits.js';
import { toPdfPoint } from '../page-space.js';

// In-document search. pdf.js's find controller does the matching and highlighting;
// this is the UI around it. Each document remembers its own query.
//
// Replace is retyping (editing/session.js replaceText): the highlighted match, or every match, goes
// through the same text-edit pipeline as typing into the text, as one undo step.

const FindState = { FOUND: 0, NOT_FOUND: 1, WRAPPED: 2, PENDING: 3 };

export class FindBar {
  #researchOn = null; // the view to search again once the replacement has been drawn
  #replacing = false;

  constructor(root, app) {
    this.app = app;
    this.input = h('input', { class: 'find-input', type: 'search', placeholder: 'Find in document', spellcheck: 'false', 'aria-label': 'Find in document' });
    this.count = h('span', { class: 'find-count', 'aria-live': 'polite' });
    this.replaceToggle = h('button', { class: 'tb-btn small', title: 'Replace (Ctrl+H)', 'aria-expanded': 'false', html: icon('chevron-right', 16), onClick: () => this.#showReplace(this.replaceRow.hidden) });
    this.caseBtn = h('button', { class: 'tb-btn small', title: 'Match case', 'aria-pressed': 'false', html: icon('case-sensitive', 16), onClick: () => this.#toggle('caseSensitive', this.caseBtn) });
    this.wordBtn = h('button', { class: 'tb-btn small', title: 'Whole words', 'aria-pressed': 'false', html: icon('whole-word', 16), onClick: () => this.#toggle('entireWord', this.wordBtn) });
    this.prevBtn = h('button', { class: 'tb-btn small', title: 'Previous match (Shift+Enter)', html: icon('chevron-up', 16), onClick: () => this.step(true) });
    this.nextBtn = h('button', { class: 'tb-btn small', title: 'Next match (Enter)', html: icon('chevron-down', 16), onClick: () => this.step(false) });
    this.closeBtn = h('button', { class: 'tb-btn small', title: 'Close (Esc)', html: icon('x', 16), onClick: () => this.close() });
    this.replaceInput = h('input', { class: 'find-input', type: 'text', placeholder: 'Replace with', spellcheck: 'false', 'aria-label': 'Replace with' });
    this.replaceBtn = h('button', { class: 'btn small', title: 'Replace this match (Enter)', onClick: () => this.replace() }, 'Replace');
    this.replaceAllBtn = h('button', { class: 'btn small', title: 'Replace every match (Ctrl+Alt+Enter)', onClick: () => this.replaceAll() }, 'Replace all');
    this.replaceRow = h('div', { class: 'find-replace', hidden: true },
      h('div', { class: 'find-field' }, this.replaceInput), this.replaceBtn, this.replaceAllBtn);
    this.el = h('div', { class: 'findbar ui', role: 'search', hidden: true },
      this.replaceToggle,
      h('div', { class: 'find-field' }, h('span', { class: 'find-glyph', html: icon('search', 15) }), this.input, this.count),
      this.caseBtn, this.wordBtn, h('div', { class: 'find-sep' }),
      this.prevBtn, this.nextBtn, this.closeBtn, this.replaceRow);
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
    this.replaceInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        if (e.ctrlKey && e.altKey) this.replaceAll();
        else this.replace();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        this.close();
      }
    });

    app.addEventListener('viewchange', () => {
      const view = this.app.active;
      // A replacement changes the pages: once they are drawn again, find what is left.
      if (this.#researchOn && view === this.#researchOn && !view.rebuilding) {
        this.#researchOn = null;
        if (this.isOpen && this.input.value) view.search(this.input.value);
      }
      this.#render();
    });
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

  /** Opens the bar with Replace showing; the replacement field is focused once there is a query. */
  openReplace(prefill = '') {
    this.open(prefill);
    if (!this.isOpen) return;
    this.#showReplace(true);
    if (this.input.value) {
      this.replaceInput.focus();
      this.replaceInput.select();
    }
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

  /** Replaces the highlighted match; with none highlighted yet, highlights the next one first. */
  async replace() {
    const view = this.app.active;
    const query = this.input.value;
    if (!view || !query) return;
    const selected = view.findController?.selected;
    const pageView = selected?.pageIdx >= 0 ? view.viewer.getPageView(selected.pageIdx) : null;
    const mark = view.find.query === query && view.find.total > 0 && selected.matchIdx >= 0
      ? pageView?.div.querySelector('.textLayer .highlight.selected') : null;
    if (!mark) {
      this.step(false);
      return;
    }
    const rect = mark.getBoundingClientRect();
    const point = toPdfPoint(pageView, rect.left + rect.width / 2, rect.top + rect.height / 2);
    await this.#replaceWith(view, { pageNumber: selected.pageIdx + 1, point });
  }

  /** Replaces every match in the document, as one undo step. */
  async replaceAll() {
    const view = this.app.active;
    if (!view || !this.input.value) return;
    await this.#replaceWith(view, null);
  }

  async #replaceWith(view, at) {
    if (this.#replacing) return;
    this.#replacing = true;
    try {
      const reason = view.textEditing.unavailableReason;
      if (reason) throw new EditError('document', reason);
      if (!(await view.textEditor?.commitPending?.() ?? true)) return;
      if (!(await view.confirmChanges())) return;
      const { replaced, skipped, reasons } = await view.textEditing.replaceText(this.input.value, this.replaceInput.value, view.find, at);
      if (view.rebuilding) this.#researchOn = view;
      if (at) return;
      const left = skipped ? ` ${skipped} ${skipped === 1 ? 'match was' : 'matches were'} left as they are: ${reasons.join(' ')}` : '';
      this.#notify(view, replaced || skipped ? `Replaced ${replaced} ${replaced === 1 ? 'match' : 'matches'}.${left}` : 'No text to replace was found.');
    } catch (err) {
      if (!(err instanceof EditError)) throw err;
      this.#notify(view, err.message);
    } finally {
      this.#replacing = false;
    }
  }

  #notify(view, message) {
    view.dispatchEvent(new CustomEvent('notice', { detail: { message } }));
  }

  #showReplace(show) {
    this.replaceRow.hidden = !show;
    this.el.classList.toggle('replacing', show);
    this.replaceToggle.setAttribute('aria-expanded', String(show));
    this.replaceToggle.innerHTML = icon(show ? 'chevron-down' : 'chevron-right', 16);
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
