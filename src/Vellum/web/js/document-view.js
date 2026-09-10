import { bridge } from './bridge.js';
import { h, clamp, reducedMotion } from './dom.js';
import { icon } from './icons.js';
import { documentAssetOptions } from './pdfjs.js';
import { AnnotationStore } from './annotations/model.js';
import { AnnotationLayer } from './annotations/layer.js';
import { extractAnnotations, writeAnnotations } from './annotations/persist.js';
import { paintAnnotations as paintOnCanvas } from './annotations/paint.js';

// One DocumentView per open PDF. It owns a pdf.js viewer plus all per-document state
// (page, zoom, rotation, layout, search) and reports changes with a 'change' event.

export const MIN_SCALE = 0.1;
export const MAX_SCALE = 10;
/** Protected files already told (this session) that their annotations live alongside them. */
const warnedProtected = new Set();

const ZOOM_LADDER = [0.1, 0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5, 6, 8, 10];

function nextZoomStep(current, direction) {
  if (direction > 0) return ZOOM_LADDER.find((s) => s > current + 0.005) ?? MAX_SCALE;
  return [...ZOOM_LADDER].reverse().find((s) => s < current - 0.005) ?? MIN_SCALE;
}

/** Turns a pdf.js / fetch failure into something a person can act on. */
export function describeLoadError(err, { passwordCancelled = false } = {}) {
  const name = err?.name;
  if (passwordCancelled || name === 'PasswordException') {
    return { kind: 'password', title: 'This PDF is password-protected', message: 'It can’t be shown without its password.' };
  }
  if (name === 'InvalidPDFException') {
    return {
      kind: 'invalid',
      title: 'This file can’t be opened as a PDF',
      message: 'It’s either damaged or not really a PDF. Vellum tried to repair it and couldn’t.',
      detail: err.message,
    };
  }
  if (name === 'ResponseException') {
    return err.missing || err.status === 404
      ? { kind: 'missing', title: 'The file is no longer there', message: 'It may have been moved, renamed or deleted.' }
      : { kind: 'unreadable', title: 'The file couldn’t be read', message: 'Another program may be locking it.', detail: err.message };
  }
  return { kind: 'unknown', title: 'Something went wrong opening this PDF', message: 'The file may be damaged.', detail: err?.message ?? String(err) };
}

export class DocumentView extends EventTarget {
  status = 'loading'; // loading | ready | error
  error = null;
  pdf = null;
  viewMode = 'continuous'; // continuous | single
  encrypted = false;
  find = { query: '', caseSensitive: false, entireWord: false, current: 0, total: 0, state: null };
  /** Called when the view asks to be closed (e.g. "Close" on the error panel). Set by the app. */
  onRequestClose = null;

  #libs;
  #loadOptions = null;
  #loadingTask = null;
  #documentTask = null;
  #abort = new AbortController();
  #changeQueued = false;
  #wheelFactor = 1;
  #flipDelta = 0;
  #lastFlip = 0;
  #zoomAnimation = null;
  #resolveFirstRender;

  constructor(file, libs, { author = '' } = {}) {
    super();
    this.file = file;
    this.#libs = libs;
    this.firstRender = new Promise((resolve) => { this.#resolveFirstRender = resolve; });
    this.annotations = new AnnotationStore({ author });
    this.annotations.addEventListener('change', () => {
      this.#changed();
      const fileKey = this.docKey ?? this.file.path;
      if (this.encrypted && this.annotations.dirty && !warnedProtected.has(fileKey)) {
        warnedProtected.add(fileKey);
        this.#notice('This PDF is protected, so Vellum keeps your annotations alongside it instead of inside the file. Save them and they’ll be here next time you open it in Vellum.');
      }
    });

    this.el = h('section', { class: 'doc', 'data-status': 'loading', 'data-tool': 'select' });
    this.container = h('div', { class: 'viewer-container', tabindex: '-1' });
    this.viewerEl = h('div', { class: 'pdfViewer' });
    this.container.append(this.viewerEl);
    this.loader = h('div', { class: 'doc-loader', role: 'status' },
      h('div', { class: 'spinner' }), h('span', { text: `Opening ${file.name}` }));
    this.el.append(this.container, this.loader);
  }

  get state() {
    const v = this.pdf ? this.viewer : null;
    return {
      status: this.status,
      error: this.error,
      name: this.file.name,
      pageNumber: v?.currentPageNumber ?? 1,
      pagesCount: this.pdf?.numPages ?? 0,
      scale: v?.currentScale ?? 1,
      scaleValue: v?.currentScaleValue ?? null,
      rotation: v?.pagesRotation ?? 0,
      viewMode: this.viewMode,
      find: { ...this.find },
      tool: this.annotLayer?.tool ?? 'select',
      dirty: this.annotations.dirty,
      canUndo: this.annotations.canUndo,
      canRedo: this.annotations.canRedo,
      selectedAnnotation: this.annotLayer?.selectedId ?? null,
    };
  }

  get signal() { return this.#abort.signal; }

  /** Must run while the element is in the document: pdf.js measures its container. */
  mount(parent) {
    parent.append(this.el);
    const { EventBus, PDFViewer, PDFLinkService, PDFFindController, LinkTarget } = this.#libs.viewerLib;
    const eventBus = (this.eventBus = new EventBus());
    this.linkService = new PDFLinkService({ eventBus, externalLinkTarget: LinkTarget.BLANK });
    this.findController = new PDFFindController({ eventBus, linkService: this.linkService });
    this.viewer = new PDFViewer({
      container: this.container,
      viewer: this.viewerEl,
      eventBus,
      linkService: this.linkService,
      findController: this.findController,
      abortSignal: this.#abort.signal,
    });
    this.linkService.setViewer(this.viewer);
    this.annotLayer = new AnnotationLayer(this, this.annotations);
    this.annotLayer.addEventListener('toolchange', () => this.#changed());
    this.annotLayer.addEventListener('selectionchange', () => this.#changed());

    eventBus.on('pagesinit', () => {
      // Reopen where you left off (page, zoom, layout), remembered per file by the host.
      const resume = this.file.resume;
      this.viewer.currentScaleValue = resume?.scaleValue || 'auto';
      if (resume?.viewMode === 'single') this.setViewMode('single');
      if (resume?.page > 1 && resume.page <= this.pdf.numPages) {
        this.viewer.currentPageNumber = resume.page;
      } else {
        // pdf.js scrolls page 1 flush to the top edge; start at the very top so its margin shows.
        requestAnimationFrame(() => { this.container.scrollTop = 0; });
      }
    });
    eventBus.on('pagechanging', ({ pageNumber, previous }) => {
      this.#animatePageTurn(pageNumber, previous);
      this.#changed();
    });
    eventBus.on('scalechanging', () => this.#changed());
    eventBus.on('rotationchanging', () => this.#changed());
    eventBus.on('pagerendered', () => this.#resolveFirstRender());
    eventBus.on('updatefindmatchescount', ({ matchesCount }) => {
      this.find.current = matchesCount.current;
      this.find.total = matchesCount.total;
      this.#changed();
    });
    eventBus.on('updatefindcontrolstate', ({ state, matchesCount }) => {
      this.find.state = state;
      if (matchesCount) {
        this.find.current = matchesCount.current;
        this.find.total = matchesCount.total;
      }
      this.#changed();
    });

    this.container.addEventListener('wheel', (e) => this.#onWheel(e), { passive: false, signal: this.#abort.signal });
  }

  async load(options) {
    this.#loadOptions = options;
    const { pdfjsLib } = this.#libs;
    this.#setStatus('loading');

    let data;
    let hasVellumAnnotations = false;
    try {
      const response = await fetch(this.file.url);
      // The host flags files that contain annotations Vellum saved earlier.
      hasVellumAnnotations = response.headers.get('X-Vellum-Annotations') === '1';
      this.docKey = response.headers.get('X-Vellum-Doc-Key');
      if (!response.ok) {
        throw Object.assign(new Error(`HTTP ${response.status}`), {
          name: 'ResponseException', status: response.status, missing: response.status === 404,
        });
      }
      data = new Uint8Array(await response.arrayBuffer());
    } catch (err) {
      this.#fail(describeLoadError(err));
      return;
    }
    if (data.length === 0) {
      this.#fail({ kind: 'empty', title: 'This file is empty', message: 'It contains no data. It may not have finished downloading or copying.' });
      return;
    }

    // Lift Vellum's own annotations out of the file into the editable layer, and give pdf.js a copy
    // without them (otherwise they'd be painted twice, and the painted copy couldn't be edited).
    if (hasVellumAnnotations) {
      try {
        const extracted = await extractAnnotations(data);
        if (extracted.annotations.length) {
          this.annotations.load(extracted.annotations);
          data = extracted.bytes;
        }
      } catch {
        this.#notice('This file’s annotations couldn’t be made editable, so they’re shown as part of the page.');
      }
    }

    let passwordCancelled = false;
    const task = pdfjsLib.getDocument({ data, ...documentAssetOptions });
    this.#loadingTask = task;
    task.onPassword = async (updatePassword, reason) => {
      const incorrect = reason === (pdfjsLib.PasswordResponses?.INCORRECT_PASSWORD ?? 2);
      const password = await options.askPassword({ fileName: this.file.name, incorrect });
      if (password == null) {
        passwordCancelled = true;
        task.destroy();
      } else {
        updatePassword(password);
      }
    };

    try {
      this.pdf = await task.promise;
      this.#documentTask = task; // in pdf.js v6 a document is torn down through its loading task
    } catch (err) {
      this.#fail(describeLoadError(err, { passwordCancelled }));
      return;
    } finally {
      this.#loadingTask = null;
    }

    this.viewer.setDocument(this.pdf);
    this.linkService.setDocument(this.pdf, null);
    try {
      const { info } = await this.pdf.getMetadata();
      this.encrypted = Boolean(info?.EncryptFilterName);
    } catch { /* metadata is optional */ }
    if (this.encrypted) await this.#loadSidecar();

    this.#setStatus('ready');
    this.dispatchEvent(new Event('ready'));
  }

  retry() {
    this.errorEl?.remove();
    this.errorEl = null;
    this.error = null;
    return this.load(this.#loadOptions);
  }

  // ---- navigation -------------------------------------------------------

  goToPage(pageNumber, { pulse = false } = {}) {
    if (!this.pdf) return;
    const page = clamp(Math.round(pageNumber), 1, this.pdf.numPages);
    this.viewer.currentPageNumber = page;
    // Leave a little breathing room above the page instead of butting it against the toolbar.
    if (this.viewMode === 'continuous') this.container.scrollTop = Math.max(0, this.container.scrollTop - 12);
    if (pulse) this.#pulsePage(page);
  }

  nextPage() { if (this.pdf) this.viewer.nextPage(); }

  prevPage({ toBottom = false } = {}) {
    if (!this.pdf || !this.viewer.previousPage()) return;
    // Paging backwards in single-page view lands at the bottom of the previous page, like turning back.
    if (toBottom) requestAnimationFrame(() => { this.container.scrollTop = this.container.scrollHeight; });
  }

  firstPage() { this.goToPage(1); }
  lastPage() { if (this.pdf) this.goToPage(this.pdf.numPages); }

  goToDestination(dest) {
    this.linkService.goToDestination(dest);
  }

  // ---- zoom -------------------------------------------------------------

  zoomIn() { if (this.pdf) this.zoomTo(nextZoomStep(this.viewer.currentScale, 1)); }
  zoomOut() { if (this.pdf) this.zoomTo(nextZoomStep(this.viewer.currentScale, -1)); }

  /** value: a number (1 = 100%) or a pdf.js preset: 'page-width' | 'page-fit' | 'page-actual' | 'auto'. */
  zoomTo(value) {
    if (!this.pdf) return;
    this.#zoomAnimation?.finish();
    if (typeof value === 'string') {
      this.viewer.currentScaleValue = value;
      this.#announceZoom();
      return;
    }
    const from = this.viewer.currentScale;
    const to = clamp(value, MIN_SCALE, MAX_SCALE);
    if (Math.abs(to - from) < 0.001) return;

    const box = this.container.getBoundingClientRect();
    const origin = [box.left + box.width / 2, box.top + box.height / 2];
    const commit = () => {
      this.viewer.updateScale({ scaleFactor: to / from, origin });
      this.#announceZoom();
    };
    if (reducedMotion()) { commit(); return; }

    // Animate a cheap CSS scale around the viewport centre, then commit the real re-render at the end.
    // pdf.js keeps the same point fixed when committing, so the hand-off is seamless.
    const viewerBox = this.viewerEl.getBoundingClientRect();
    this.viewerEl.style.transformOrigin = `${origin[0] - viewerBox.left}px ${origin[1] - viewerBox.top}px`;
    const animation = this.viewerEl.animate(
      [{ transform: 'scale(1)' }, { transform: `scale(${to / from})` }],
      { duration: 170, easing: 'cubic-bezier(.25,.8,.25,1)' });
    this.#zoomAnimation = animation;
    animation.onfinish = () => {
      this.#zoomAnimation = null;
      this.viewerEl.style.transformOrigin = '';
      commit();
    };
  }

  // ---- view -------------------------------------------------------------

  rotate(delta) {
    if (!this.pdf) return;
    this.viewer.pagesRotation = (this.viewer.pagesRotation + delta + 360) % 360;
  }

  setViewMode(mode) {
    if (!this.pdf || mode === this.viewMode) return;
    const { ScrollMode } = this.#libs.viewerLib;
    const page = this.viewer.currentPageNumber;
    this.viewMode = mode;
    this.viewer.scrollMode = mode === 'single' ? ScrollMode.PAGE : ScrollMode.VERTICAL;
    this.el.classList.toggle('single', mode === 'single');
    this.viewer.currentPageNumber = page;
    this.#changed();
  }

  // ---- search -----------------------------------------------------------

  search(query, { caseSensitive = this.find.caseSensitive, entireWord = this.find.entireWord, again = false, findPrevious = false } = {}) {
    if (!this.pdf) return;
    Object.assign(this.find, { query, caseSensitive, entireWord });
    if (!query) {
      this.endSearch();
      return;
    }
    this.eventBus.dispatch('find', {
      source: this, type: again ? 'again' : '', query, caseSensitive, entireWord,
      highlightAll: true, findPrevious, matchDiacritics: false,
    });
  }

  /** Clears highlights but remembers the query for next time. */
  endSearch() {
    this.eventBus?.dispatch('findbarclose', { source: this });
    Object.assign(this.find, { current: 0, total: 0, state: null });
    this.#changed();
  }

  // ---- annotations ------------------------------------------------------

  setTool(tool) {
    if (this.pdf) this.annotLayer.setTool(tool);
  }

  /** Paints this page's annotations onto a print canvas. */
  paintAnnotations(ctx, pageNumber, viewport) {
    paintOnCanvas(ctx, this.annotations.forPage(pageNumber), viewport);
  }

  /**
   * Writes the annotations into a PDF on disk: the file this tab shows, or a Save As target.
   * The original bytes are re-read from disk so the rest of the file is kept exactly as it is.
   */
  async saveTo(target) {
    // Protected PDFs can't be rewritten: keep their annotations in a sidecar instead (see MainWindow).
    if (this.encrypted) {
      if (!this.docKey) throw new Error('Vellum couldn’t identify this protected file, so its annotations can’t be kept.');
      await bridge.request('annotations.saveSidecar', { key: this.docKey, fileName: this.file.name, annotations: this.annotations.all });
      this.annotations.markSaved();
      return;
    }
    const response = await fetch(this.file.url);
    if (!response.ok) throw new Error('The original file couldn’t be read. It may have been moved or deleted.');
    const original = new Uint8Array(await response.arrayBuffer());
    const bytes = await writeAnnotations(original, this.annotations.all);
    const result = await fetch(`${new URL(this.file.url).origin}/save/${target.token}`, {
      method: 'POST', body: bytes, headers: { 'Content-Type': 'application/pdf' },
    });
    const outcome = await result.json().catch(() => ({ ok: false, error: `The file couldn’t be written (${result.status}).` }));
    if (!outcome.ok) throw new Error(outcome.error);
    this.annotations.markSaved();
  }

  /** After Save As, this tab now represents the new file. */
  retarget(file) {
    this.file = { ...file, resume: null };
    this.#changed();
  }

  // ---- selection --------------------------------------------------------

  getSelectedText() {
    const selection = getSelection();
    if (!selection || selection.isCollapsed || !this.container.contains(selection.anchorNode)) return '';
    return selection.toString().trim();
  }

  selectAllText() {
    const range = document.createRange();
    range.selectNodeContents(this.viewerEl);
    const selection = getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  }

  // ---- lifecycle --------------------------------------------------------

  show() { this.el.hidden = false; }
  hide() { this.el.hidden = true; }
  focus() { this.container.focus({ preventScroll: true }); }

  destroy() {
    this.#abort.abort();
    try { this.viewer?.setDocument(null); } catch { /* already torn down */ }
    this.#loadingTask?.destroy();
    this.#documentTask?.destroy();
    this.#documentTask = null;
    this.pdf = null;
    this.el.remove();
  }

  // ---- internals --------------------------------------------------------

  #onWheel(e) {
    if (!this.pdf) return;
    if (e.ctrlKey || e.metaKey) {
      // Ctrl+wheel (and touchpad pinch, which arrives as Ctrl+wheel) zooms around the pointer.
      e.preventDefault();
      const delta = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
      this.#wheelFactor *= clamp(Math.exp(-delta / 450), 0.5, 2);
      const current = this.viewer.currentScale;
      const next = clamp(Math.round(current * this.#wheelFactor * 100) / 100, MIN_SCALE, MAX_SCALE);
      if (next !== current) {
        this.#wheelFactor = 1;
        this.viewer.updateScale({ scaleFactor: next / current, origin: [e.clientX, e.clientY], drawingDelay: 250 });
        this.#announceZoom();
      }
      return;
    }
    if (this.viewMode === 'single') this.#singlePageWheel(e);
  }

  /** In single-page view, scrolling past the top/bottom edge turns the page. */
  #singlePageWheel(e) {
    const c = this.container;
    const atBottom = c.scrollTop + c.clientHeight >= c.scrollHeight - 2;
    const atTop = c.scrollTop <= 1;
    if (!((e.deltaY > 0 && atBottom) || (e.deltaY < 0 && atTop))) {
      this.#flipDelta = 0;
      return;
    }
    e.preventDefault();
    this.#flipDelta += e.deltaY;
    const now = performance.now();
    if (Math.abs(this.#flipDelta) < 80 || now - this.#lastFlip < 350) return;
    const forward = this.#flipDelta > 0;
    this.#flipDelta = 0;
    this.#lastFlip = now;
    if (forward) this.nextPage();
    else this.prevPage({ toBottom: true });
  }

  #animatePageTurn(pageNumber, previous) {
    if (this.viewMode !== 'single' || !previous || previous === pageNumber || reducedMotion()) return;
    const div = this.viewer.getPageView(pageNumber - 1)?.div;
    const direction = pageNumber > previous ? 1 : -1;
    div?.animate(
      [{ opacity: 0, transform: `translateX(${direction * 36}px) scale(.985)` }, { opacity: 1, transform: 'none' }],
      { duration: 260, easing: 'cubic-bezier(.2,.8,.2,1)' });
  }

  /** A brief glow on a page you jumped to, so the eye finds it. */
  #pulsePage(pageNumber) {
    const div = this.viewer.getPageView(pageNumber - 1)?.div;
    if (!div || reducedMotion()) return;
    div.classList.remove('arrive');
    void div.offsetWidth; // restart the animation
    div.classList.add('arrive');
    setTimeout(() => div.classList.remove('arrive'), 1100);
  }

  #announceZoom() {
    this.dispatchEvent(new Event('zoomed'));
  }

  #notice(message) {
    this.dispatchEvent(new CustomEvent('notice', { detail: { message } }));
  }

  /** Annotations previously saved for this protected PDF (keyed by its content hash). */
  async #loadSidecar() {
    if (!this.docKey) return;
    try {
      const { annotations } = await bridge.request('annotations.loadSidecar', { key: this.docKey });
      const valid = (annotations ?? []).filter((a) => a?.id && a.type && a.page >= 1 && a.page <= this.pdf.numPages);
      if (valid.length) this.annotations.load(valid);
    } catch { /* nothing saved for this file yet */ }
  }

  #setStatus(status) {
    this.status = status;
    this.el.dataset.status = status;
    this.#changed();
  }

  #fail(info) {
    this.error = info;
    this.#setStatus('error');
    const actions = [];
    if (info.kind === 'password') {
      actions.push(h('button', { class: 'btn primary', onClick: () => this.retry() }, 'Enter password'));
    }
    actions.push(h('button', { class: 'btn', onClick: () => this.onRequestClose?.() }, 'Close'));
    this.errorEl?.remove();
    this.errorEl = h('div', { class: 'doc-error ui', role: 'alert' },
      h('div', { class: 'doc-error-icon', html: icon(info.kind === 'password' ? 'lock' : 'file-x', 28) }),
      h('h2', { text: info.title }),
      h('p', { text: info.message }),
      h('p', { class: 'doc-error-path', text: this.file.path }),
      info.detail ? h('details', {}, h('summary', { text: 'Technical details' }), h('code', { text: info.detail })) : null,
      h('div', { class: 'doc-error-actions' }, actions));
    this.el.append(this.errorEl);
    this.dispatchEvent(new Event('failed'));
  }

  /** Coalesces bursts of pdf.js events into one 'change' per frame. */
  #changed() {
    if (this.#changeQueued) return;
    this.#changeQueued = true;
    requestAnimationFrame(() => {
      this.#changeQueued = false;
      this.dispatchEvent(new Event('change'));
    });
  }
}
