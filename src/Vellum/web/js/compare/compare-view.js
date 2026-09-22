import { h, debounce, reducedMotion } from '../dom.js';
import { icon } from '../icons.js';
import { documentAssetOptions } from '../pdfjs.js';
import { pageWords, pageProfile, alignPages, rowChanges } from './diff.js';
import { FILTERS, countByFilter, stepChange, positionOf } from './filter.js';

// PDF Compare: two documents side by side, their differences listed and marked on the pages.
// Read-only: each file is read into memory with pdf.js and nothing is ever written back. Work is spread
// out so the window stays responsive: pages are read one at a time (text only), then matched and diffed
// row by row with pauses between; a page is drawn only when its row scrolls near the view, and the pixel
// comparison of Overlay mode only for those rows.
//
//   status: 'loading' | 'reading' | 'comparing' | 'ready' | 'failed'
//   rows:    matched pages (compare/diff.js alignPages)
//   changes: every difference, in row order (compare/diff.js rowChanges); index: the selected one
//   filter:  the type of change listed, marked and stepped through ('all' or a tone; compare/filter.js)

const KINDS = {
  'text-added': { label: 'Added', tone: 'added' },
  'text-removed': { label: 'Removed', tone: 'removed' },
  'text-changed': { label: 'Changed', tone: 'changed' },
  'page-added': { label: 'Page added', tone: 'added' },
  'page-removed': { label: 'Page removed', tone: 'removed' },
  'page-moved': { label: 'Page moved', tone: 'moved' },
};

const MODES = [['side', 'Side by side'], ['overlay', 'Overlay'], ['blink', 'Blink']];

// Overlay colours are drawn into the page image, which is always paper white.
const INK_REMOVED = [214, 64, 48];
const INK_ADDED = [34, 150, 96];

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const quote = (text, max = 60) => `“${text.length > max ? `${text.slice(0, max - 1)}…` : text}”`;

export class CompareView {
  status = 'loading';
  mode = 'side';
  rows = [];
  changes = [];
  index = -1;
  filter = 'all';

  #lib;
  #askPassword;
  #onClose;
  #docs = { a: null, b: null };
  #pages = { a: [], b: [] }; // { viewport (scale 1), words }
  #tasks = [];
  #renders = new Set();
  #rowEls = [];
  #visible = new Set();
  #rendering = false;
  #again = false;
  #observer = null;
  #resize = null;
  #abort = new AbortController();
  #closed = false;
  #blink = 0;

  /** files: { a, b } as the host describes them ({ name, path, url }). */
  constructor({ pdfjsLib, files, askPassword, onClose }) {
    this.#lib = pdfjsLib;
    this.files = files;
    this.#askPassword = askPassword;
    this.#onClose = onClose;

    const chip = (side, file) => h('span', { class: `cmp-file ${side}`, title: file.path ?? file.name },
      h('span', { class: 'cmp-file-tag', text: side.toUpperCase() }), h('span', { class: 'cmp-file-name', text: file.name }));
    this.countEl = h('span', { class: 'cmp-count', 'aria-live': 'polite', text: 'Opening documents…' });
    this.positionEl = h('span', { class: 'cmp-position' });
    this.prevBtn = h('button', { class: 'tb-btn small', title: 'Previous change (Shift+F7)', 'aria-label': 'Previous change', disabled: true, html: icon('chevron-up', 16), onClick: () => this.step(-1) });
    this.nextBtn = h('button', { class: 'tb-btn small', title: 'Next change (F7)', 'aria-label': 'Next change', disabled: true, html: icon('chevron-down', 16), onClick: () => this.step(1) });
    this.modeButtons = MODES.map(([id, label]) => h('button', {
      class: 'seg-btn', role: 'radio', 'aria-checked': String(id === this.mode), dataset: { mode: id }, onClick: () => this.setMode(id),
    }, label));
    this.modeSeg = h('div', { class: 'seg cmp-modes', role: 'radiogroup', 'aria-label': 'Comparison view', style: `--seg-count:${MODES.length};--seg-index:0` }, this.modeButtons);
    this.filterButtons = FILTERS.map(([id, label]) => h('button', {
      class: `seg-btn cmp-filter-btn ${id}`, role: 'radio', 'aria-checked': String(id === this.filter), dataset: { filter: id },
      disabled: id !== 'all', onClick: () => this.setFilter(id),
    }, h('span', { class: 'cmp-filter-n', text: '0' }), h('span', { class: 'cmp-filter-label', text: label })));
    this.filterSeg = h('div', { class: 'seg cmp-filters', role: 'radiogroup', 'aria-label': 'Show changes', style: `--seg-count:${FILTERS.length};--seg-index:0` }, this.filterButtons);
    this.list = h('ol', { class: 'cmp-list', 'aria-label': 'Changes' });
    this.pagesEl = h('div', { class: 'cmp-pages' }, h('div', { class: 'cmp-progress' }, h('span', { class: 'toast-spinner' }), h('span', { text: 'Opening documents…' })));
    this.el = h('div', { class: 'compare ui', role: 'dialog', 'aria-label': 'Compare documents', tabindex: '-1', 'data-own-keys': '', dataset: { mode: this.mode, show: this.filter } },
      h('div', { class: 'cmp-bar' },
        h('span', { class: 'cmp-title', html: icon('files', 17) }, 'Compare'),
        h('div', { class: 'cmp-files' }, chip('a', files.a), h('span', { class: 'cmp-vs', text: 'with' }), chip('b', files.b)),
        this.countEl,
        h('div', { class: 'cmp-nav' }, this.prevBtn, this.positionEl, this.nextBtn),
        this.modeSeg,
        h('button', { class: 'tb-btn small', title: 'Close (Esc)', 'aria-label': 'Close comparison', html: icon('x', 16), onClick: () => this.close() })),
      h('div', { class: 'cmp-body' }, h('aside', { class: 'cmp-side' }, this.filterSeg, this.list), this.pagesEl));

    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !e.target.closest?.('.dialog')) { e.preventDefault(); this.close(); }
      else if (e.key === 'F7') { e.preventDefault(); this.step(e.shiftKey ? -1 : 1); }
    }, { signal: this.#abort.signal });
  }

  async start() {
    document.getElementById('overlay-root').append(this.el);
    requestAnimationFrame(() => this.el.classList.add('open'));
    this.el.focus({ preventScroll: true });
    try {
      for (const side of ['a', 'b']) {
        this.#docs[side] = await this.#open(this.files[side]);
        if (this.#closed) return;
        if (!this.#docs[side]) { this.close(); return; } // password not given
      }
      await this.#read();
      if (this.#closed) return;
      this.#layout();
      await this.#compare();
    } catch (err) {
      if (!this.#closed) this.#fail(err.message);
    }
  }

  close() {
    if (this.#closed) return;
    this.#closed = true;
    this.#abort.abort();
    clearInterval(this.#blink);
    this.#observer?.disconnect();
    this.#resize?.disconnect();
    for (const task of this.#renders) task.cancel();
    for (const task of this.#tasks) task.destroy();
    this.el.classList.remove('open');
    setTimeout(() => this.el.remove(), 220);
    this.#onClose?.(this);
  }

  get closed() { return this.#closed; }

  /** Moves to the next (1) or previous (-1) change the filter shows, wrapping around. */
  step(delta) {
    const next = stepChange(this.changes, this.index, delta, this.filter);
    if (next >= 0) this.select(next);
  }

  /** Lists, marks and steps through only one type of change ('all' or a tone); nothing is compared again. */
  setFilter(filter) {
    if (!FILTERS.some(([id]) => id === filter) || filter === this.filter) return;
    this.filter = filter;
    this.el.dataset.show = filter;
    this.filterSeg.style.setProperty('--seg-index', FILTERS.findIndex(([id]) => id === filter));
    for (const b of this.filterButtons) b.setAttribute('aria-checked', String(b.dataset.filter === filter));
    this.#updatePosition();
  }

  /** Selects a change and brings its place on the pages into view. */
  select(index) {
    const change = this.changes[index];
    if (!change) return;
    this.index = index;
    for (const el of this.el.querySelectorAll('.cmp-item.current, .cmp-mark.current, .cmp-page.current')) el.classList.remove('current');
    for (const el of this.el.querySelectorAll(`[data-change="${index}"]`)) {
      el.classList.add('current');
      if (el.classList.contains('cmp-mark')) {
        el.classList.remove('flash');
        void el.offsetWidth; // restart the animation
        el.classList.add('flash');
      }
    }
    this.list.querySelector(`.cmp-item[data-change="${index}"]`)?.scrollIntoView({ block: 'nearest' });
    this.#updatePosition();

    const rowEl = this.#rowEls[change.row];
    const top = (el) => el.getBoundingClientRect().top - this.pagesEl.getBoundingClientRect().top + this.pagesEl.scrollTop;
    let target = top(rowEl) - 16;
    const side = change.bRects?.length || change.bAnchor ? 'b' : 'a';
    const rect = change[`${side}Rects`]?.[0] ?? change[`${side}Anchor`];
    const pageEl = rowEl.querySelector(`.cmp-slot.${side} .cmp-page`);
    if (rect && pageEl) {
      const { top: fraction } = this.#box(side, this.rows[change.row][side], rect);
      target = top(pageEl) + (fraction / 100) * pageEl.offsetHeight - this.pagesEl.clientHeight / 3;
    }
    this.pagesEl.scrollTo({ top: Math.max(0, target), behavior: reducedMotion() ? 'auto' : 'smooth' });
  }

  setMode(mode) {
    if (!MODES.some(([id]) => id === mode) || mode === this.mode) return;
    this.mode = mode;
    this.el.dataset.mode = mode;
    const i = MODES.findIndex(([id]) => id === mode);
    this.modeSeg.style.setProperty('--seg-index', i);
    for (const b of this.modeButtons) b.setAttribute('aria-checked', String(b.dataset.mode === mode));
    // Blink swaps A and B on a timer (chosen, so it runs even with reduced motion).
    clearInterval(this.#blink);
    this.el.classList.remove('blink-b');
    if (mode === 'blink') this.#blink = setInterval(() => this.el.classList.toggle('blink-b'), 700);
    this.#renderVisible();
  }

  // ---- reading and comparing ------------------------------------------------------------------

  async #open(file) {
    this.#progress(`Opening “${file.name}”…`);
    const response = await fetch(file.url);
    if (!response.ok) throw new Error(`“${file.name}” couldn’t be read${response.status === 404 ? ': the file is no longer there' : ''}.`);
    const data = new Uint8Array(await response.arrayBuffer());
    const task = this.#lib.getDocument({ data, ...documentAssetOptions });
    this.#tasks.push(task);
    let cancelled = false;
    task.onPassword = async (updatePassword, reason) => {
      const incorrect = reason === (this.#lib.PasswordResponses?.INCORRECT_PASSWORD ?? 2);
      const password = this.#closed ? null : await this.#askPassword({ fileName: file.name, incorrect });
      if (password == null) {
        cancelled = true;
        task.destroy();
      } else {
        updatePassword(password);
      }
    };
    try {
      return await task.promise;
    } catch (err) {
      if (cancelled || this.#closed) return null;
      throw new Error(`“${file.name}” couldn’t be opened as a PDF (${err.message}).`);
    }
  }

  /** Reads each page's size and words, one page at a time. */
  async #read() {
    this.status = 'reading';
    const total = this.#docs.a.numPages + this.#docs.b.numPages;
    const ctx = document.createElement('canvas').getContext('2d');
    const measure = (text, style) => {
      ctx.font = `100px ${style?.fontFamily ?? 'sans-serif'}`;
      return ctx.measureText(text).width;
    };
    let done = 0;
    for (const side of ['a', 'b']) {
      const doc = this.#docs[side];
      for (let n = 1; n <= doc.numPages; n++) {
        if (this.#closed) return;
        const page = await doc.getPage(n);
        const words = pageWords(await page.getTextContent(), { measure });
        this.#pages[side].push({ viewport: page.getViewport({ scale: 1 }), words });
        page.cleanup();
        done++;
        if (done % 4 === 0 || done === total) this.#progress(`Reading pages… ${done} of ${total}`);
      }
    }
  }

  /** Matches the pages and lays out one row per pair; nothing is drawn yet. */
  #layout() {
    const profile = (side) => this.#pages[side].map((p) => pageProfile(p.words));
    this.rows = alignPages(profile('a'), profile('b'));
    this.pagesEl.replaceChildren();
    this.#rowEls = this.rows.map((row, i) => {
      const el = this.#rowElement(row, i);
      this.pagesEl.append(el);
      return el;
    });
    this.#observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        const i = Number(entry.target.dataset.row);
        if (entry.isIntersecting) this.#visible.add(i);
        else {
          this.#visible.delete(i);
          this.#release(i);
        }
      }
      this.#renderVisible();
    }, { root: this.pagesEl, rootMargin: '700px 0px' });
    for (const el of this.#rowEls) this.#observer.observe(el);
    this.#resize = new ResizeObserver(debounce(() => this.#renderVisible(), 200));
    this.#resize.observe(this.pagesEl);
  }

  /** Diffs the rows a few at a time, listing changes as they're found. */
  async #compare() {
    this.status = 'comparing';
    for (let i = 0; i < this.rows.length; i++) {
      if (this.#closed) return;
      const row = this.rows[i];
      const found = rowChanges(row, i, this.#pages.a[row.a]?.words ?? [], this.#pages.b[row.b]?.words ?? []);
      for (const change of found) this.#addChange(change);
      if (i % 10 === 9) {
        this.#updateCount(`Comparing… page ${i + 1} of ${this.rows.length}`);
        await new Promise((resolve) => setTimeout(resolve));
      }
    }
    this.status = 'ready';
    this.#updateCount();
    if (!this.changes.length) {
      this.list.append(h('li', { class: 'cmp-empty' },
        h('strong', { text: 'No differences found' }),
        h('span', { text: 'The text and the order of the pages are the same. Changes to pictures or drawings aren’t listed: Overlay and Blink show how the pages look.' })));
    }
  }

  #addChange(change) {
    const index = this.changes.push(change) - 1;
    const { label, tone } = KINDS[change.kind];
    const row = this.rows[change.row];
    const where = [row.a != null && `A p.${row.a + 1}`, row.b != null && `B p.${row.b + 1}`].filter(Boolean).join(' · ');
    const detail = {
      'text-added': () => quote(change.after),
      'text-removed': () => quote(change.before),
      'text-changed': () => `${quote(change.before, 28)} → ${quote(change.after, 28)}`,
      'page-added': () => `Page ${row.b + 1} is only in B`,
      'page-removed': () => `Page ${row.a + 1} is only in A`,
      'page-moved': () => `Page ${row.a + 1} in A is page ${row.b + 1} in B`,
    }[change.kind]();
    this.list.append(h('li', { class: `cmp-item ${tone}`, dataset: { change: index } },
      h('button', { class: 'cmp-item-btn', onClick: () => this.select(index) },
        h('span', { class: 'cmp-item-head' }, h('span', { class: 'cmp-kind', text: label }), h('span', { class: 'cmp-where', text: where })),
        h('span', { class: 'cmp-detail', text: detail }))));

    const rowEl = this.#rowEls[change.row];
    if (change.kind.startsWith('page-')) {
      for (const pageEl of rowEl.querySelectorAll('.cmp-page')) {
        pageEl.classList.add(`whole-${tone}`);
        pageEl.dataset.change = index;
      }
      return;
    }
    for (const side of ['a', 'b']) {
      const marks = rowEl.querySelector(`.cmp-slot.${side} .cmp-marks`);
      const boxes = change[`${side}Rects`].map((rect) => ['', rect]);
      // Where text was added or taken away on the other page: a caret after the word before it.
      const anchor = change[`${side}Anchor`];
      if (anchor) boxes.push([' anchor', [anchor[2], anchor[1], anchor[2], anchor[3]]]);
      for (const [extra, rect] of boxes) {
        const { left, top, width, height } = this.#box(side, row[side], rect);
        marks.append(h('div', {
          class: `cmp-mark ${tone}${extra}`, dataset: { change: index }, title: `${label}: ${detail}`,
          style: { left: `${left}%`, top: `${top}%`, width: `${width}%`, height: `${height}%` },
          onClick: () => this.select(index),
        }));
      }
    }
  }

  /** A box in PDF user space as percentages of the shown page. */
  #box(side, pageIndex, rect) {
    const { viewport } = this.#pages[side][pageIndex];
    const [x0, y0] = viewport.convertToViewportPoint(rect[0], rect[1]);
    const [x1, y1] = viewport.convertToViewportPoint(rect[2], rect[3]);
    const pad = 1.5;
    const left = Math.min(x0, x1) - pad;
    const top = Math.min(y0, y1) - pad;
    return {
      left: (left / viewport.width) * 100,
      top: (top / viewport.height) * 100,
      width: ((Math.abs(x1 - x0) + 2 * pad) / viewport.width) * 100,
      height: ((Math.abs(y1 - y0) + 2 * pad) / viewport.height) * 100,
    };
  }

  #rowElement(row, i) {
    const size = (side) => this.#pages[side][row[side]]?.viewport;
    const shape = size('b') ?? size('a');
    const slot = (side) => {
      const viewport = size(side);
      if (!viewport) {
        return h('div', { class: `cmp-slot ${side} missing` },
          h('div', { class: 'cmp-page-missing', style: { aspectRatio: `${shape.width} / ${shape.height}` } },
            h('span', { text: side === 'a' ? 'Not in A' : 'Not in B' })));
      }
      return h('div', { class: `cmp-slot ${side}` },
        h('div', { class: 'cmp-page', style: { aspectRatio: `${viewport.width} / ${viewport.height}` } },
          h('canvas', { class: 'cmp-canvas' }),
          side === 'a' ? h('canvas', { class: 'cmp-diff' }) : null,
          h('div', { class: 'cmp-marks' })));
    };
    const label = (side) => (row[side] == null ? '—' : `${side.toUpperCase()} · page ${row[side] + 1}`);
    const textless = row.a != null && row.b != null && !this.#pages.a[row.a].words.length && !this.#pages.b[row.b].words.length;
    return h('section', { class: `cmp-row ${row.kind}`, dataset: { row: i } },
      h('div', { class: 'cmp-row-head' },
        h('span', { text: label('a') }),
        row.kind !== 'same' ? h('span', { class: `cmp-badge ${row.kind}`, text: { moved: 'Moved', added: 'Added', removed: 'Removed' }[row.kind] }) : null,
        textless ? h('span', { class: 'cmp-note', text: 'No text to compare: see Overlay' }) : null,
        h('span', { text: label('b') })),
      h('div', { class: `cmp-pair${row.a == null || row.b == null ? ' single' : ''}` }, slot('a'), slot('b')));
  }

  // ---- drawing --------------------------------------------------------------------------------

  async #renderVisible() {
    if (this.#rendering) {
      this.#again = true;
      return;
    }
    this.#rendering = true;
    try {
      do {
        this.#again = false;
        for (const i of [...this.#visible].sort((x, y) => x - y)) {
          if (this.#closed) return;
          if (this.#visible.has(i)) await this.#renderRow(i);
        }
      } while (this.#again);
    } finally {
      this.#rendering = false;
    }
  }

  async #renderRow(i) {
    const el = this.#rowEls[i];
    const row = this.rows[i];
    const mode = this.mode;
    const key = `${mode}:${el.clientWidth}`;
    if (el.dataset.rendered === key) return;
    const drawn = {};
    for (const side of ['a', 'b']) {
      if (row[side] == null) continue;
      const pageEl = el.querySelector(`.cmp-slot.${side} .cmp-page`);
      const canvas = pageEl.querySelector('.cmp-canvas');
      if (await this.#paint(side, row[side], canvas, pageEl.clientWidth)) drawn[side] = canvas;
    }
    const diff = el.querySelector('.cmp-diff');
    if (diff) {
      if (mode === 'overlay' && drawn.a && drawn.b) {
        // Freed (canvases emptied) while page B was drawing: skip this pass, unmarked, so it's drawn again when seen.
        if (!this.#visible.has(i) || !hasPixels(drawn.a) || !hasPixels(drawn.b)) return;
        paintDifference(drawn.a, drawn.b, diff);
      } else Object.assign(diff, { width: 0, height: 0 });
    }
    if (!this.#closed && this.mode === mode) el.dataset.rendered = key;
  }

  async #paint(side, pageIndex, canvas, cssWidth) {
    if (!cssWidth) return false;
    const page = await this.#docs[side].getPage(pageIndex + 1);
    const base = this.#pages[side][pageIndex].viewport;
    const viewport = page.getViewport({ scale: (cssWidth / base.width) * Math.min(window.devicePixelRatio || 1, 2) });
    // Drawn off screen first, so a page never flashes blank while it's redrawn at a new size.
    const work = document.createElement('canvas');
    work.width = Math.max(1, Math.floor(viewport.width));
    work.height = Math.max(1, Math.floor(viewport.height));
    const ctx = work.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, work.width, work.height);
    const task = page.render({ canvas: work, canvasContext: ctx, viewport });
    this.#renders.add(task);
    try {
      await task.promise;
    } catch {
      return false; // cancelled (closed) or the page couldn't be drawn
    } finally {
      this.#renders.delete(task);
    }
    if (this.#closed) return false;
    canvas.width = work.width;
    canvas.height = work.height;
    canvas.getContext('2d').drawImage(work, 0, 0);
    return true;
  }

  /** Frees a row's pictures once it's far out of view. */
  #release(i) {
    const el = this.#rowEls[i];
    if (!el?.dataset.rendered) return;
    for (const canvas of el.querySelectorAll('canvas')) Object.assign(canvas, { width: 0, height: 0 });
    delete el.dataset.rendered;
  }

  // ---- status ---------------------------------------------------------------------------------

  #progress(message) {
    this.countEl.textContent = message;
    const text = this.pagesEl.querySelector('.cmp-progress span:last-child');
    if (text) text.textContent = message;
  }

  #updateCount(busy) {
    const n = this.changes.length;
    this.countEl.textContent = busy ?? (n ? plural(n, 'change') : 'No differences');
    this.countEl.classList.toggle('none', !busy && !n);
    this.#updatePosition();
  }

  #updatePosition() {
    const { at, total } = positionOf(this.changes, this.index, this.filter);
    this.prevBtn.disabled = this.nextBtn.disabled = !total;
    this.positionEl.textContent = total ? `${at || '–'} / ${total}` : '';
    const counts = countByFilter(this.changes);
    for (const b of this.filterButtons) {
      const n = counts[b.dataset.filter];
      b.querySelector('.cmp-filter-n').textContent = n;
      b.disabled = b.dataset.filter !== 'all' && !n;
    }
  }

  #fail(message) {
    this.status = 'failed';
    this.countEl.textContent = 'Couldn’t compare';
    this.pagesEl.replaceChildren(h('div', { class: 'cmp-progress failed' },
      h('span', { html: icon('triangle-alert', 22) }), h('span', { text: message })));
  }
}

const hasPixels = (canvas) => canvas?.width > 0 && canvas?.height > 0;

/**
 * Overlay: A and B at the same size, pixel by pixel. Where they agree the page is shown faded; ink only
 * in A (or darker there) is red, ink only in B green.
 */
function paintDifference(a, b, out) {
  const width = a.width;
  const height = a.height;
  const pixels = (source) => {
    const c = document.createElement('canvas');
    c.width = width;
    c.height = height;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(source, 0, 0, width, height);
    return ctx.getImageData(0, 0, width, height).data;
  };
  const pa = pixels(a);
  const pb = pixels(b);
  out.width = width;
  out.height = height;
  const ctx = out.getContext('2d');
  const image = ctx.createImageData(width, height);
  const d = image.data;
  for (let p = 0; p < d.length; p += 4) {
    const la = (pa[p] * 299 + pa[p + 1] * 587 + pa[p + 2] * 114) / 1000;
    const lb = (pb[p] * 299 + pb[p + 1] * 587 + pb[p + 2] * 114) / 1000;
    const delta = la - lb;
    if (Math.abs(delta) < 48) {
      const v = 255 - (255 - Math.min(la, lb)) * 0.3;
      d[p] = d[p + 1] = d[p + 2] = v;
    } else {
      const [r, g, bl] = delta < 0 ? INK_REMOVED : INK_ADDED;
      const t = Math.min(1, Math.abs(delta) / 160);
      d[p] = 255 + (r - 255) * t;
      d[p + 1] = 255 + (g - 255) * t;
      d[p + 2] = 255 + (bl - 255) * t;
    }
    d[p + 3] = 255;
  }
  ctx.putImageData(image, 0, 0);
}
