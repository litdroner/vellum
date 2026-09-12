import { h, clamp } from '../dom.js';
import { icon } from '../icons.js';
import { PAGE_KINDS, explainRun } from '../editing/runs.js';
import { EditError } from '../editing/edits.js';
import { quadArea, quadContains, hitTest } from '../editing/objects/geometry.js';
import { pageViewAt, toPdfPoint, toClientQuad, tolerancePoints } from '../page-space.js';

// Edit mode ("Edit text", E): shows what on a page can be selected and changed, and edits text in
// place. The engine (editing/) finds, checks and writes the text; this module is only the
// interaction:
//   - outlines around editable text, drawn through the annotation layer's page overlays
//   - selection: clicking a text run or an image selects that object, outlined where it is. The
//     selection is identity alone ({ page, key }, editing/objects/selection.js); its geometry is
//     resolved from the page's current analysis every time it is drawn, never remembered.
//   - a floating editor over the text (in the scroll container, like the note editor), in the
//     page's own font and paper colour, so what you type looks like the page
//   - a small glass bar: which font the text will use, and Cancel / Done
// Enter keeps the change, Escape cancels, Tab moves to the next text (Shift+Tab to the previous).
//
// Selecting an image is as far as Phase 2 goes: nothing moves, scales, rotates or deletes an
// object yet, so nothing here offers to. Tab's itinerary is the editable text it has always been.

const SVG_NS = 'http://www.w3.org/2000/svg';
const STANDARD_CSS = { Helvetica: 'Arial, Helvetica, sans-serif', Times: '"Times New Roman", Times, serif', Courier: '"Courier New", Courier, monospace' };

function svg(tag, attrs) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, value);
  return el;
}

const quadPoints = (q) => `${q[0]},${q[1]} ${q[2]},${q[3]} ${q[4]},${q[5]} ${q[6]},${q[7]}`;

/** A text run's object key in the model: the one place the two namings meet. */
const runKeyOf = (key) => `run:${key}`;

/** The run's fill colour as CSS (DeviceGray / RGB / CMYK; anything else shows as ink). */
function cssColor(fill) {
  const c = fill?.color;
  const v = c ? c.args.filter((a) => typeof a === 'number') : [];
  const rgb = (r, g, b) => `rgb(${[r, g, b].map((x) => Math.round(clamp(x, 0, 1) * 255)).join(' ')})`;
  const cmyk = (k0, k1, k2, k3) => rgb((1 - k0) * (1 - k3), (1 - k1) * (1 - k3), (1 - k2) * (1 - k3));
  if (!c) return '#000';
  if (c.op === 'g' || ((c.op === 'sc' || c.op === 'scn') && v.length === 1)) return rgb(v[0], v[0], v[0]);
  if (c.op === 'rg' || ((c.op === 'sc' || c.op === 'scn') && v.length === 3)) return rgb(...v);
  if (c.op === 'k' || ((c.op === 'sc' || c.op === 'scn') && v.length === 4)) return cmyk(...v);
  return '#000';
}

const generic = (font) => (font?.flags.fixedPitch ? 'monospace' : font?.flags.serif ? 'serif' : 'sans-serif');
const standardFamily = (name) => STANDARD_CSS[name.split('-')[0]] ?? 'sans-serif';
const prettyFont = (name) => name.replace(/-/g, ' ').replace(/\b(MT|PSMT|PS)\b/g, '').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/\s+/g, ' ').trim();
const quoteChars = (chars) => chars.map((c) => `“${c}”`).join(', ');

export class TextEditor {
  #view;
  #notify;
  #pages = new Map(); // page number → { n, data, objects, error, loading }
  #hover = null; // { n, key }
  #editor = null; // { n, key, item, el, paper, input, bar, status, done, pending }
  #committing = null;
  #tip = null;
  #hoverQueued = false;
  #previewTimer = 0;
  #announcer;
  #warnedTagged = false;

  constructor(view, { notify }) {
    this.#view = view;
    this.#notify = notify;
    this.#announcer = h('div', { class: 'vl-sr-only', role: 'status', 'aria-live': 'polite' });
    view.el.append(this.#announcer);
    const { signal } = view;
    view.annotLayer.addEventListener('toolchange', () => this.#toolChanged());
    view.eventBus.on('pagerendered', ({ pageNumber }) => { if (this.active) this.#showPage(pageNumber); });
    view.eventBus.on('scalechanging', () => requestAnimationFrame(() => this.#reposition()));
    view.eventBus.on('rotationchanging', () => requestAnimationFrame(() => this.#reposition()));
    view.addEventListener('documentchange', () => this.#documentChanged());
    const c = view.container;
    c.addEventListener('pointermove', (e) => this.#onHover(e), { signal });
    c.addEventListener('click', (e) => this.#onClick(e), { signal });
    // Captured, so Escape can clear a selection before AnnotationLayer's own handler reads it as
    // "leave this tool". With nothing selected it falls through to that, exactly as it always did.
    c.addEventListener('keydown', (e) => this.#onKey(e), { signal, capture: true });
    document.addEventListener('pointerdown', (e) => this.#onPointerDownAnywhere(e), { signal, capture: true });
  }

  get active() { return this.#view.annotLayer?.tool === 'edit'; }

  /** The document's selection: identity only, and the single record of what Edit mode is on. */
  get #selection() { return this.#view.objectSelection; }

  /** Keeps what's being typed (called before saving, closing or quitting). False if it can't be kept. */
  async commitPending() {
    if (this.#committing) return this.#committing;
    if (!this.#editor) return true;
    return this.#commit();
  }

  // ---- entering and leaving edit mode ---------------------------------------------------

  async #toolChanged() {
    const view = this.#view;
    if (!this.active) {
      await this.commitPending();
      this.#closeEditor();
      this.#hideTip();
      this.#hover = null;
      this.#selection.clear();
      view.annotLayer.clearDecorations();
      view.container.classList.remove('vl-edit-hover', 'vl-edit-locked');
      return;
    }
    const reason = view.textEditing.unavailableReason;
    if (reason) {
      this.#notify(reason);
      view.setTool('select');
      return;
    }
    // A digitally signed PDF: saving changes invalidates the signature, so ask first (once).
    if (!(await view.confirmChanges())) {
      if (this.active) view.setTool('select');
      return;
    }
    if (!this.active) return;
    this.#announce('Edit text. Click text to change it, or press Tab to move between editable text.');
    for (const n of this.#renderedPages()) this.#showPage(n);
  }

  #renderedPages() {
    const out = [];
    for (let n = 1; n <= (this.#view.pdf?.numPages ?? 0); n++) {
      if (this.#view.viewer.getPageView(n - 1)?.renderingState === 3 /* finished */) out.push(n);
    }
    return out;
  }

  #documentChanged() {
    // The pages were rebuilt (an edit, undo, page changes): read them afresh as they render. The
    // selection is two fields, so it survives this on its own terms — #showPage looks for its
    // object in the new analysis and drops it if it has gone. A page change clears it outright,
    // where the page plan changes (document-view.js).
    this.#pages.clear();
    this.#hover = null;
    this.#hideTip();
    if (this.#editor) this.#closeEditor({ refocus: false });
  }

  // ---- page data and outlines -------------------------------------------------------------

  async #showPage(n) {
    const page = await this.#ensurePage(n);
    if (!page || !this.active) return;
    if (this.#selection.page === n) this.#selection.reconcile(page.objects?.analysis ?? null);
    this.#draw(page);
  }

  #ensurePage(n) {
    let page = this.#pages.get(n);
    if (!page) {
      page = { n, data: null, objects: null, error: null, loading: null };
      this.#pages.set(n, page);
    }
    if (page.data || page.error) return Promise.resolve(page);
    // Both readings come from the one verified analysis the session keeps per page; asking for them
    // one after the other lets the second find it already there. They are published together, at
    // the end: `data` is what everything else tests for readiness, so a page must never be able to
    // show its text while its objects are still on the way — a hit test would then run against no
    // objects and find nothing.
    page.loading ??= (async () => {
      const data = await this.#view.textEditing.page(n);
      const objects = await this.#view.textEditing.objects(n);
      page.objects = objects;
      page.data = data;
    })()
      .catch((err) => { page.error = err; })
      .then(() => (this.#pages.get(n) === page ? page : null));
    return page.loading;
  }

  #draw(page) {
    const layer = this.#view.annotLayer;
    if (!this.active || !page.data) {
      layer.decorate(page.n, []);
      return;
    }
    const selectedKey = this.#selection.page === page.n ? this.#selection.key : null;
    const shapes = [];
    for (const item of page.data.runs) {
      const { run } = item;
      const hovered = this.#hover?.n === page.n && this.#hover.key === run.key;
      const focused = selectedKey === runKeyOf(run.key);
      if (this.#editor?.n === page.n && this.#editor.key === run.key) continue; // the editor covers it
      if (run.reasons.has('blank') || (!run.editable && !hovered && !focused)) continue;
      const cls = ['vl-edit-run', !run.editable && 'locked', hovered && 'hover', focused && 'focus', item.edit && 'edited'].filter(Boolean).join(' ');
      shapes.push(svg('polygon', { class: cls, points: quadPoints(run.quad) }));
    }
    // Anything else selected — an image — outlined where it is NOW: its quad is read out of this
    // page's current analysis on every draw, so zoom, rotation and a rebuild all take care of
    // themselves, and nothing here remembers a coordinate between draws. Selected text is already
    // drawn above, in the outline Edit mode has always used for it.
    const object = selectedKey ? this.#selection.resolve(page.objects?.analysis) : null;
    if (object && object.kind !== 'text-run') {
      shapes.push(svg('polygon', { class: 'vl-object-sel', points: quadPoints(object.geometry.quad) }));
    }
    layer.decorate(page.n, shapes);
  }

  /** Moves the selection and redraws whatever that changed. Only identity ever goes in. */
  #select(to) {
    const from = this.#selection.current;
    const changed = to ? this.#selection.select(to.n, to.key) : this.#selection.clear();
    if (!changed) return;
    for (const n of new Set([from?.page, to?.n].filter(Boolean))) {
      const page = this.#pages.get(n);
      if (page) this.#draw(page);
    }
  }

  /**
   * What's under a point: { n, page, object, item } — `object` the topmost thing that can be
   * selected there, `item` its run when it is text. Both null over empty paper; null off the pages.
   *
   * Hit-testing happens in PDF user space (editing/objects/geometry.js): the pointer is converted
   * once, and nothing is measured on screen, so a rotated page, a turned image and a crop box that
   * doesn't start at the origin all need no special case.
   *
   * When nothing selectable is there, the runs are searched again for one that can be EXPLAINED —
   * the invisible text layer of a scanned page, or text used as a clipping shape. Neither is worth
   * selecting, but Edit mode has always said why they can't be edited, and still does.
   */
  async #hitAt(target, clientX, clientY) {
    const at = pageViewAt(this.#view, target);
    if (!at) return null;
    const page = await this.#ensurePage(at.n);
    if (!page?.data) return { n: at.n, page, object: null, item: null };
    const point = toPdfPoint(at.pageView, clientX, clientY);
    const tol = tolerancePoints(at.pageView, 2);
    const object = hitTest(page.objects?.objects ?? [], point, tol);
    if (object) {
      const item = object.kind === 'text-run'
        ? page.data.runs.find((r) => r.run.key === object.ref.runKey) ?? null
        : null;
      return { n: at.n, page, object, item };
    }
    return { n: at.n, page, object: null, item: this.#explainableAt(page, point, tol) };
  }

  /** The smallest run under a point that isn't blank, whether or not it can be selected or edited. */
  #explainableAt(page, point, tol) {
    let best = null;
    for (const item of page.data.runs) {
      const { run } = item;
      if (run.reasons.has('blank') || !quadContains(run.quad, point, tol)) continue;
      const area = quadArea(run.quad);
      if (!best || area < best.area) best = { item, area };
    }
    return best?.item ?? null;
  }

  // ---- pointer and keyboard ---------------------------------------------------------------

  #onHover(e) {
    if (!this.active || this.#hoverQueued || e.buttons) return;
    this.#hoverQueued = true;
    const { clientX, clientY, target } = e;
    requestAnimationFrame(async () => {
      this.#hoverQueued = false;
      const hit = await this.#hitAt(target, clientX, clientY);
      if (!this.active) return;
      const previous = this.#hover;
      const item = hit?.item ?? null;
      this.#hover = item ? { n: hit.n, key: item.run.key } : null;
      const c = this.#view.container;
      c.classList.toggle('vl-edit-hover', Boolean(item?.run.editable));
      c.classList.toggle('vl-edit-locked', Boolean(item && !item.run.editable));
      if (previous?.n === this.#hover?.n && previous?.key === this.#hover?.key) return;
      if (previous && previous.n !== hit?.n) {
        const old = this.#pages.get(previous.n);
        if (old) this.#draw(old);
      }
      if (hit?.page) this.#draw(hit.page);
    });
  }

  async #onClick(e) {
    if (!this.active || e.button !== 0 || e.target.closest?.('.vl-text-editor, .vl-edit-bar, .vl-edit-tip')) return;
    const hit = await this.#hitAt(e.target, e.clientX, e.clientY);
    if (!hit) return;
    // A click selects what it lands on, and clears the selection when it lands on nothing.
    this.#select(hit.object ? { n: hit.n, key: hit.object.ref.key } : null);
    if (hit.item) {
      if (!hit.item.run.editable) {
        this.#showTip(e.clientX, e.clientY, explainRun(hit.item.run)[0] ?? 'This text can’t be edited.');
        return;
      }
      await this.#open(hit.n, hit.item.run.key);
      return;
    }
    // No text here — an image, or bare paper. Either way this is a click away from whatever was
    // being typed, so it is kept, exactly as clicking bare paper always did.
    if (!(await this.commitPending())) return;
    this.#closeEditor();
    // Edit mode is about text, so a page that has none still says so — selecting the picture on a
    // scanned page answers a different question from the one the person asked by coming here.
    const kind = hit.page?.data?.kind;
    if (hit.page?.error) this.#showTip(e.clientX, e.clientY, hit.page.error.message);
    else if (kind && kind !== 'text') this.#showTip(e.clientX, e.clientY, PAGE_KINDS[kind]);
  }

  #onKey(e) {
    if (!this.active || this.#editor || e.target.closest?.('input, textarea, button')) return;
    if (e.key === 'Tab') {
      e.preventDefault();
      this.#move(e.shiftKey ? -1 : 1);
      return;
    }
    if (e.key === 'Escape') {
      // Clearing a selection first, then — with nothing selected — Escape means what it always
      // meant, and AnnotationLayer's handler leaves Edit mode.
      if (!this.#selection.current) return;
      e.preventDefault();
      e.stopPropagation();
      this.#select(null);
      return;
    }
    if (e.key === 'Enter') {
      const run = this.#focusRun();
      if (!run) return; // an image is selected: nothing can be done to one yet
      e.preventDefault();
      this.#open(run.n, run.key);
    }
  }

  /**
   * The selection as a run, when it is one. Tab's itinerary is the editable text it has always
   * been, so everything that walks it speaks in run keys and stops here if the selection is not
   * text.
   */
  #focusRun() {
    const current = this.#selection.current;
    if (!current || !current.key.startsWith('run:')) return null;
    return { n: current.page, key: current.key.slice('run:'.length) };
  }

  #onPointerDownAnywhere(e) {
    if (this.#tip && !this.#tip.el.contains(e.target)) this.#hideTip();
    const ed = this.#editor;
    if (!ed || ed.pending || ed.el.contains(e.target) || ed.bar.contains(e.target)) return;
    // A click on the pages is handled by #onClick (which keeps the text first); elsewhere, keep it now.
    if (!e.target.closest?.('.page')) this.#commit();
  }

  #onEditorKey(e) {
    if (e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      this.#commit();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      this.#cancel();
    } else if (e.key === 'Tab') {
      e.preventDefault();
      e.stopPropagation();
      this.#move(e.shiftKey ? -1 : 1, { edit: true });
    }
  }

  // ---- moving between texts (Tab) ------------------------------------------------------------

  async #move(delta, { edit = false } = {}) {
    const from = this.#editor ? { n: this.#editor.n, key: this.#editor.key } : this.#focusRun();
    // Find where to go first: at the last (or first) text there's nowhere to go, and an open
    // editor simply stays open.
    const target = await this.#neighbour(from, delta);
    if (!target) {
      this.#announce(delta > 0 ? 'No more editable text after this.' : 'No editable text before this.');
      return;
    }
    if (this.#editor && !(await this.#commit())) return;
    await this.#settled();
    this.#select({ n: target.n, key: runKeyOf(target.key) });
    this.#reveal(target);
    if (edit) {
      await this.#open(target.n, target.key);
      return;
    }
    this.#announce(`Editable text: ${target.text}. Press Enter to change it.`);
  }

  /** The next (delta 1) or previous (-1) editable text in reading order, crossing pages. */
  async #neighbour(from, delta) {
    const count = this.#view.pdf?.numPages ?? 0;
    let n = from?.n ?? this.#view.state.pageNumber;
    let list = await this.#ordered(n);
    let index = from ? list.findIndex((x) => x.key === from.key) : -1;
    index = index < 0 ? (delta > 0 ? -1 : list.length) : index;
    for (let hops = 0; hops < count; hops++) {
      const next = index + delta;
      if (next >= 0 && next < list.length) return { n, key: list[next].key, text: list[next].text };
      n += delta;
      if (n < 1 || n > count) return null;
      list = await this.#ordered(n);
      index = delta > 0 ? -1 : list.length;
    }
    return null;
  }

  /** A page's editable runs in reading order (top to bottom, then left to right, as displayed). */
  async #ordered(n) {
    const page = await this.#ensurePage(n);
    const pageView = this.#view.viewer.getPageView(n - 1);
    if (!page?.data || !pageView) return [];
    const vp = pageView.viewport;
    return page.data.runs
      .filter((item) => item.run.editable)
      .map((item) => {
        const [x, y] = vp.convertToViewportPoint(item.run.quad[6], item.run.quad[7]);
        return { key: item.run.key, text: item.text, x, y };
      })
      .sort((a, b) => (Math.abs(a.y - b.y) > 4 ? a.y - b.y : a.x - b.x));
  }

  #reveal({ n, key }) {
    const item = this.#pages.get(n)?.data?.runs.find((r) => r.run.key === key);
    const pts = item && this.#screenQuad(n, item.run);
    if (!pts) {
      this.#view.goToPage(n);
      return;
    }
    const c = this.#view.container;
    const box = c.getBoundingClientRect();
    const ys = pts.map((p) => p[1]);
    const top = Math.min(...ys);
    const bottom = Math.max(...ys);
    if (top < box.top + 40) c.scrollTop -= box.top + 40 - top;
    else if (bottom > box.bottom - 90) c.scrollTop += bottom - (box.bottom - 90);
  }

  // ---- the editor -----------------------------------------------------------------------------

  async #open(n, key) {
    if (this.#editor) {
      if (this.#editor.n === n && this.#editor.key === key) return;
      if (!(await this.#commit())) return; // its text can't be kept: leave it open to fix
    }
    await this.#settled();
    const page = await this.#ensurePage(n);
    const item = page?.data?.runs.find((r) => r.run.key === key);
    if (!item?.run.editable || !this.active || this.#editor) return;
    this.#hideTip();
    const input = h('input', {
      class: 'vl-text-input', type: 'text', spellcheck: 'true', autocomplete: 'off', 'aria-label': `Edit text: ${item.text}`,
    });
    input.value = item.text;
    const el = h('div', { class: 'vl-text-editor ui' }, h('div', { class: 'vl-text-paper' }, input));
    const status = h('span', { class: 'vl-edit-status', role: 'status', 'aria-live': 'polite' });
    const keep = (e) => e.preventDefault(); // buttons don't take focus from the text
    const cancel = h('button', { class: 'tb-btn small', title: 'Cancel (Esc)', 'aria-label': 'Cancel', html: icon('x', 16), onMousedown: keep, onClick: () => this.#cancel() });
    const done = h('button', { class: 'btn primary small', title: 'Keep this text (Enter)', onMousedown: keep, onClick: () => this.#commit() }, 'Done');
    const bar = h('div', { class: 'vl-pop vl-edit-bar ui', role: 'toolbar', 'aria-label': 'Text editing' },
      h('span', { class: 'vl-pop-icon', html: icon('type', 15) }),
      h('span', { class: 'vl-edit-font', text: `${prettyFont(item.run.font?.name || 'Font')} · ${Math.round(item.run.frame.size * 10) / 10} pt` }),
      h('div', { class: 'vl-sep' }), status, cancel, done);
    const ed = { n, key, item, el, paper: el.firstChild, input, bar, status, done, pending: false };
    this.#editor = ed;
    this.#view.container.append(el, bar);
    input.addEventListener('keydown', (e) => this.#onEditorKey(e));
    input.addEventListener('input', () => this.#schedulePreview());
    // Going to anything else (a menu, the command palette, another control) keeps the text, as
    // clicking elsewhere does — so a page change made from there can't discard it. Switching to
    // another window doesn't.
    input.addEventListener('focusout', () => setTimeout(() => {
      if (this.#editor !== ed || ed.pending || !document.hasFocus()) return;
      if (!ed.el.contains(document.activeElement) && !ed.bar.contains(document.activeElement)) this.#commit();
    }));
    this.#layout(ed);
    this.#draw(page);
    input.focus({ preventScroll: true });
    input.select();
    this.#preview();
    if (item.run.tagged) this.#warnTagged();
  }

  /** Tagged PDFs (an accessibility structure): said once, the first time tagged text is opened. */
  async #warnTagged() {
    if (this.#warnedTagged) return;
    const profile = await this.#view.profile().catch(() => null);
    if (!profile?.tagged || this.#warnedTagged) return;
    this.#warnedTagged = true;
    this.#notify('This PDF is tagged for accessibility. Vellum doesn’t update those tags when it changes text, so screen readers may not read the changed text correctly.');
  }

  async #commit() {
    const ed = this.#editor;
    if (!ed) return true;
    if (this.#committing) return this.#committing;
    this.#committing = (async () => {
      const text = ed.input.value;
      if (text === ed.item.text) {
        this.#closeEditor();
        return true;
      }
      ed.pending = true;
      ed.input.readOnly = true;
      ed.el.classList.add('saving');
      try {
        const changed = await this.#view.textEditing.edit(ed.n, ed.key, text);
        if (changed) {
          this.#announce('Text changed.');
          await this.#settled(); // keep showing the new text until the page is rebuilt with it
        }
        if (this.#editor === ed) this.#closeEditor();
        return true;
      } catch (err) {
        if (this.#editor !== ed) return false;
        ed.pending = false;
        ed.input.readOnly = false;
        ed.el.classList.remove('saving');
        this.#setStatus(err instanceof EditError ? err.message : `The text couldn’t be changed: ${err.message}`, 'error');
        ed.input.focus({ preventScroll: true });
        return false;
      }
    })();
    try {
      return await this.#committing;
    } finally {
      this.#committing = null;
    }
  }

  #cancel() {
    this.#closeEditor();
    this.#announce('Change cancelled.');
  }

  #closeEditor({ refocus = true } = {}) {
    const ed = this.#editor;
    if (!ed) return;
    this.#editor = null;
    clearTimeout(this.#previewTimer);
    const hadFocus = ed.el.contains(document.activeElement);
    ed.el.remove();
    ed.bar.remove();
    const page = this.#pages.get(ed.n);
    if (page) this.#draw(page);
    if (refocus && hadFocus) this.#view.focus();
  }

  /** Waits until the document isn't being rebuilt. */
  async #settled() {
    const until = performance.now() + 20000;
    while (this.#view.rebuilding && performance.now() < until) await new Promise((r) => requestAnimationFrame(r));
  }

  // ---- live checks while typing ----------------------------------------------------------------

  #schedulePreview() {
    clearTimeout(this.#previewTimer);
    this.#previewTimer = setTimeout(() => this.#preview(), 120);
  }

  async #preview() {
    const ed = this.#editor;
    if (!ed || ed.pending) return;
    const text = ed.input.value;
    let result;
    try {
      result = await this.#view.textEditing.preview(ed.n, ed.key, text);
    } catch (err) {
      result = { ok: false, message: err.message };
    }
    if (this.#editor !== ed || ed.input.value !== text) return;
    ed.done.disabled = !result.ok;
    const run = ed.item.run;
    const family = result.mode === 'standard' ? standardFamily(result.font) : run.loadedFont ? `"${run.loadedFont}", ${generic(run.font)}` : generic(run.font);
    ed.input.style.fontFamily = family;
    if (!result.ok) this.#setStatus(result.message, 'error');
    else if (result.mode === 'standard') this.#setStatus(`The original font doesn’t have ${quoteChars(result.missing)}, so this text will use ${prettyFont(result.font)}.`, 'warn');
    else if (result.mode === 'none') this.#setStatus('The text will be removed.', 'warn');
    else this.#setStatus('Same font as the original.', '');
  }

  #setStatus(text, tone) {
    const ed = this.#editor;
    if (!ed) return;
    ed.status.textContent = text;
    ed.status.className = `vl-edit-status${tone ? ` ${tone}` : ''}`;
    this.#placeBar(ed);
  }

  // ---- geometry ----------------------------------------------------------------------------------

  /** The run's corners on screen (client pixels): ll, lr, ur, ul. */
  #screenQuad(n, run) {
    const pageView = this.#view.viewer.getPageView(n - 1);
    if (!pageView?.div) return null;
    return toClientQuad(pageView, run.quad);
  }

  /** Sizes, rotates and styles the editor to sit exactly over its text. */
  #layout(ed) {
    const { run } = ed.item;
    const pts = this.#screenQuad(ed.n, run);
    if (!pts) return;
    const [ll, , ur, ul] = pts;
    const width = Math.hypot(ur[0] - ul[0], ur[1] - ul[1]);
    const height = Math.hypot(ll[0] - ul[0], ll[1] - ul[1]);
    const angle = Math.atan2(ur[1] - ul[1], ur[0] - ul[0]);
    const em = (run.font?.ascent ?? 0.8) - (run.font?.descent ?? -0.2) || 1;
    const perPoint = height / (run.frame.size * em); // screen pixels per PDF point
    const c = this.#view.container;
    const cb = c.getBoundingClientRect();
    const pad = 2;
    Object.assign(ed.el.style, {
      left: `${ul[0] - cb.left + c.scrollLeft}px`,
      top: `${ul[1] - cb.top + c.scrollTop}px`,
      transform: `rotate(${angle}rad) translate(${-pad}px, ${-pad}px)`,
      minWidth: `${width + pad * 2}px`,
      height: `${height + pad * 2}px`,
    });
    const first = run.first;
    Object.assign(ed.input.style, {
      fontSize: `${height / em}px`,
      lineHeight: `${height}px`,
      fontFamily: run.loadedFont ? `"${run.loadedFont}", ${generic(run.font)}` : generic(run.font),
      color: cssColor(first.fill),
      letterSpacing: `${(first.tc ?? 0) * (first.th ?? 1) * perPoint}px`,
      paddingInline: `${pad}px`,
    });
    const paper = this.#paperColor(ed.n, pts);
    if (paper) ed.paper.style.background = paper;
    this.#placeBar(ed);
  }

  /** The page colour right around the text (sampled from the rendered page), so the editor hides the original. */
  #paperColor(n, [ll, lr, ur, ul]) {
    try {
      const canvas = this.#view.viewer.getPageView(n - 1)?.div.querySelector('canvas');
      if (!canvas?.width) return null;
      const r = canvas.getBoundingClientRect();
      const ctx = canvas.getContext('2d');
      const unit = (a, b) => {
        const d = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
        return [(b[0] - a[0]) / d, (b[1] - a[1]) / d];
      };
      const along = unit(ul, ur);
      const down = unit(ul, ll);
      const mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      const out = (p, v, k) => [p[0] + v[0] * k, p[1] + v[1] * k];
      const probes = [out(mid(ul, ll), along, -4), out(mid(ur, lr), along, 4), out(mid(ul, ur), down, -3), out(mid(ll, lr), down, 3)];
      const colours = [];
      for (const [x, y] of probes) {
        const px = Math.floor((x - r.left) * (canvas.width / r.width));
        const py = Math.floor((y - r.top) * (canvas.height / r.height));
        if (px < 0 || py < 0 || px >= canvas.width || py >= canvas.height) continue;
        colours.push([...ctx.getImageData(px, py, 1, 1).data.slice(0, 3)]);
      }
      if (!colours.length) return null;
      const median = (i) => colours.map((c) => c[i]).sort((a, b) => a - b)[Math.floor(colours.length / 2)];
      return `rgb(${median(0)} ${median(1)} ${median(2)})`;
    } catch {
      return null; // the editor keeps its plain paper background
    }
  }

  #placeBar(ed) {
    this.#placeNear(ed.bar, ed.el.getBoundingClientRect(), 'above');
  }

  #reposition() {
    this.#hideTip();
    if (this.#editor) this.#layout(this.#editor);
  }

  /** Positions an element inside the scroll container near a screen rectangle (so it scrolls with the page). */
  #placeNear(el, rect, prefer) {
    const c = this.#view.container;
    const box = c.getBoundingClientRect();
    const w = el.offsetWidth;
    const hgt = el.offsetHeight;
    const gap = 10;
    let top = prefer === 'above' ? rect.top - hgt - gap : rect.bottom + gap;
    if (top < box.top + 6) top = rect.bottom + gap;
    if (top + hgt > box.bottom - 6) top = Math.max(box.top + 6, rect.top - hgt - gap);
    const left = clamp(rect.left + rect.width / 2 - w / 2, box.left + 8, Math.max(box.left + 8, box.left + c.clientWidth - w - 8));
    el.style.left = `${left - box.left + c.scrollLeft}px`;
    el.style.top = `${top - box.top + c.scrollTop}px`;
  }

  // ---- explanations ---------------------------------------------------------------------------------

  #showTip(clientX, clientY, message) {
    this.#hideTip();
    const el = h('div', { class: 'vl-pop vl-edit-tip ui', role: 'status' },
      h('span', { class: 'vl-pop-icon', html: icon('info', 15) }), h('span', { text: message }));
    this.#view.container.append(el);
    this.#placeNear(el, new DOMRect(clientX, clientY, 0, 0), 'above');
    this.#tip = { el, timer: setTimeout(() => this.#hideTip(), 5500) };
    this.#announce(message);
  }

  #hideTip() {
    if (!this.#tip) return;
    clearTimeout(this.#tip.timer);
    this.#tip.el.remove();
    this.#tip = null;
  }

  #announce(message) {
    this.#announcer.textContent = '';
    requestAnimationFrame(() => { this.#announcer.textContent = message; });
  }
}
