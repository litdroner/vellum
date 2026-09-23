import { bridge, writePdfFile } from './bridge.js';
import { h, clamp, reducedMotion } from './dom.js';
import { icon } from './icons.js';
import { documentAssetOptions } from './pdfjs.js';
import { AnnotationStore } from './annotations/model.js';
import { AnnotationLayer } from './annotations/layer.js';
import { extractAnnotations, composeDocument, countPages, loadPdfLib, readEmbeddedFiles } from './annotations/persist.js';
import { inspectDocument, mayBeSigned } from './editing/source.js';
import { paintAnnotations as paintOnCanvas } from './annotations/paint.js';
import { newId } from './annotations/model.js';
import {
  identityPlan, setPageSetting, rotateEntries, removeEntries, moveEntries, insertEntries, duplicateEntries, copyEntries, followPages,
} from './pages/plan.js';
import { followOutlinePages, readOutline } from './pages/outline.js';
import { followEdits, editSignature } from './editing/edits.js';
import { TextEditing } from './editing/session.js';
import { ObjectSelection } from './editing/objects/selection.js';
import { FILLABLE, NO_FORM_FIELDS, readFields, valueOfInput } from './forms/fields.js';
import { nextSpreadPage, previousSpreadPage } from './spread.js';

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
  /** Pages shown side by side in two-page spreads (1–2, 3–4…); only the layout changes, never the file. */
  spread = false;
  encrypted = false;
  find = { query: '', caseSensitive: false, entireWord: false, current: 0, total: 0, state: null };
  /** Called when the view asks to be closed (e.g. "Close" on the error panel). Set by the app. */
  onRequestClose = null;
  /** Asks the person whether to change a digitally signed PDF; resolves true to go ahead. Set by the app. */
  onConfirmSignedChanges = null;

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
  /** Bytes of the opened file, fetched once when first needed; page plans refer to its pages. */
  #base = null;
  /** What kind of file it is (see profile()). */
  #profile = null;
  /** Known from the profile: whether the file is signed (null until read). */
  #knownSigned = null;
  /** The raw bytes proved the file can't be signed, so changes never need confirming. */
  #surelyUnsigned = false;
  /** Changes to this document were confirmed (or needed no confirmation). */
  #changesAllowed = false;
  #confirming = null;
  #destroyed = false;
  /** The plan the pages on screen were built from (the store's plan runs ahead while rebuilding). */
  #shownPlan = null;
  #rebuildQueued = false;
  #restore = null;
  /** Pictures of the pages that were on screen, held over a rebuild until each page renders again (#holdPages). */
  #held = null;
  #resizeObserver = null;
  #refitFrame = 0;
  /** The document is to start at the very top, and hasn't been able to yet (see #toStart). */
  #startAtTop = false;
  /** The PDF's own form fields on screen, by widget id (forms/fields.js). */
  #fields = new Map();
  /** Other PDFs pages were inserted from: sourceId → bytes. */
  sources = new Map();
  rebuilding = false;

  constructor(file, libs, { author = '' } = {}) {
    super();
    this.file = file;
    this.#libs = libs;
    this.firstRender = new Promise((resolve) => { this.#resolveFirstRender = resolve; });
    this.annotations = new AnnotationStore({ author });
    // Every change passes here first: the first change to a signed PDF is confirmed.
    this.annotations.guard = () => this.#mayChange();
    /** Finding and changing text on the pages (engine in editing/, no UI). */
    this.textEditing = new TextEditing(this);
    /** Which object on a page is selected, as identity alone: { page, key }. Geometry is never kept. */
    this.objectSelection = new ObjectSelection();
    this.annotations.addEventListener('change', (e) => {
      if (e.detail.plan || e.detail.edits) this.#rebuild();
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
      spread: this.spread,
      find: { ...this.find },
      tool: this.annotLayer?.tool ?? 'select',
      dirty: this.annotations.dirty,
      canUndo: this.annotations.canUndo,
      canRedo: this.annotations.canRedo,
      selectedAnnotation: this.annotLayer?.selectedId ?? null,
      canEditPages: this.canEditPages,
      rebuilding: this.rebuilding,
    };
  }

  /** Names of the PDF's own form fields on screen (a created field must not reuse one). */
  get fieldNames() { return new Set([...this.#fields.values()].map((f) => f.name)); }

  /** The PDF has a form field of its own that can be filled in (known a moment after it opens). */
  get hasFormFields() {
    for (const field of this.#fields.values()) if (FILLABLE.has(field.type) && field.editable) return true;
    return false;
  }

  /**
   * Fill in form: brings the first field still to fill into sight and puts the cursor in it, in Select
   * mode: the first empty text field or list in page order, or the first field when each has a value.
   * Changes nothing in the document. False, with the reason shown, when there is no field to fill.
   */
  async focusFormField() {
    const fields = [...this.#fields].map(([id, field]) => ({ id, ...field }))
      .filter((f) => FILLABLE.has(f.type) && f.editable && f.page !== null)
      // Page by page, then top to bottom and left to right (PDF y grows upwards).
      .sort((a, b) => a.page - b.page || (b.rect?.[3] ?? 0) - (a.rect?.[3] ?? 0) || (a.rect?.[0] ?? 0) - (b.rect?.[0] ?? 0));
    if (!fields.length) {
      this.notify(NO_FORM_FIELDS);
      return false;
    }
    const kept = new Map(this.annotations.formValues.map((entry) => [entry.name, entry.value]));
    const blank = (f) => {
      if (f.type !== 'text' && f.type !== 'combobox' && f.type !== 'listbox') return false;
      const value = kept.has(f.name) ? kept.get(f.name) : f.value;
      return value === null || value === '' || (Array.isArray(value) && !value.length);
    };
    const target = fields.find(blank) ?? fields[0];
    if (this.annotLayer.tool !== 'select') this.setTool('select');
    this.goToPage(target.page + 1);
    await this.pageShown(target.page + 1);
    const element = await this.#formElement(target.id);
    element?.focus({ preventScroll: true });
    element?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    return true;
  }

  /** The input pdf.js draws for form widget `id`, once its page's form layer is drawn; null after `ms`. */
  #formElement(id, ms = 3000) {
    const find = () => this.viewerEl.querySelector(`[data-element-id="${CSS.escape(id)}"]`);
    if (find()) return Promise.resolve(find());
    return new Promise((resolve) => {
      const finish = () => {
        clearTimeout(timer);
        this.eventBus.off('annotationlayerrendered', onLayer);
        resolve(find());
      };
      const onLayer = () => { if (find()) finish(); };
      const timer = setTimeout(finish, ms);
      this.eventBus.on('annotationlayerrendered', onLayer);
    });
  }

  /** Shows a message about this document (as its own notices are shown). */
  notify(message) { this.#notice(message); }

  /** Pages can be rearranged unless the file is protected (it can't be rewritten). */
  get canEditPages() { return this.status === 'ready' && !this.encrypted; }

  /** The page plan the pages currently on screen were built from. */
  get shownPlan() { return this.#shownPlan; }

  /** The pdf.js library this view renders with. */
  get pdfjsLib() { return this.#libs.pdfjsLib; }

  /** Bytes of the file as it is on disk (read once). */
  baseBytes() { return this.#baseBytes(); }

  /**
   * What kind of file this is, for decisions about the whole document:
   * { encrypted, signed, certified, tagged, pdfa } (see editing/source.js inspectDocument). Read once
   * from the original file, which isn't kept in memory just for this.
   */
  profile() {
    this.#profile ??= (async () => inspectDocument(await loadPdfLib(), this.#base ?? (await this.#readFile())))()
      .then((profile) => {
        this.#knownSigned = profile.signed;
        return profile;
      }, (err) => {
        this.#profile = null; // e.g. the file was moved: try again next time
        throw err;
      });
    return this.#profile;
  }

  /**
   * Before the first change to a digitally signed PDF: asks whether to go ahead, since saving will
   * invalidate the signature. Resolves true when changes may be made (asks again next time if not).
   */
  confirmChanges() {
    if (this.#changesFree()) return Promise.resolve(true);
    this.#confirming ??= (async () => {
      let signed = true; // if the file can't be checked, ask anyway
      try {
        signed = (await this.profile()).signed;
      } catch { /* ask */ }
      const ok = !signed || (await (this.onConfirmSignedChanges?.() ?? false)) === true;
      if (ok) this.#changesAllowed = true;
      return ok && !this.#destroyed; // a closed document takes no more changes
    })().finally(() => { this.#confirming = null; });
    return this.#confirming;
  }

  /** Changes need no confirmation: already confirmed, protected (never rewritten), or not signed. */
  #changesFree() {
    if (this.#changesAllowed || this.encrypted || this.#surelyUnsigned || this.#knownSigned === false) {
      this.#changesAllowed = true;
      return true;
    }
    return false;
  }

  /** The edit store's guard: true when a change may be applied now; otherwise the confirmation. */
  #mayChange() {
    if (this.#destroyed) return false;
    return this.#changesFree() || this.confirmChanges();
  }

  /** Changes whenever a page's content edits change (for caches such as thumbnails). */
  editVersion(entryId) { return editSignature(this.annotations.edits, entryId); }

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
    // A value typed or chosen in one of the PDF's own form fields (drawn by pdf.js) is kept for saving.
    const keepField = (e) => {
      const entry = valueOfInput(e.target, this.#fields);
      if (!entry) return;
      if (!this.encrypted) this.annotations.setFormValue(entry);
      else if (!warnedProtected.has(`form:${this.file.path}`)) {
        warnedProtected.add(`form:${this.file.path}`);
        this.#notice('This PDF is protected, so Vellum can’t save what’s filled in its form.');
      }
    };
    this.viewerEl.addEventListener('input', keepField);
    this.viewerEl.addEventListener('change', keepField);
    this.annotLayer.addEventListener('toolchange', () => this.#changed());
    this.annotLayer.addEventListener('selectionchange', () => this.#changed());

    // The fitted zooms (automatic, fit page, fit width) follow the window and the sidebar as they
    // change size, as in pdf.js's own viewer; a chosen percentage stays put. The border box is
    // watched, so a scrollbar appearing after a re-fit doesn't trigger another one.
    let size = '';
    this.#resizeObserver = new ResizeObserver(([entry]) => {
      const box = entry.borderBoxSize?.[0];
      if (!box?.inlineSize || !box.blockSize) {
        size = ''; // a background tab has no size, so being shown again is always a change
        return;
      }
      const next = `${Math.round(box.inlineSize)}x${Math.round(box.blockSize)}`;
      if (next === size) return;
      size = next;
      cancelAnimationFrame(this.#refitFrame);
      this.#refitFrame = requestAnimationFrame(() => {
        this.#refit();
        this.#toStart();
      });
    });
    this.#resizeObserver.observe(this.container);

    eventBus.on('pagesinit', () => {
      // After pages were rearranged: stay on the same page, at the same zoom and layout.
      const restore = this.#restore;
      if (restore) {
        this.#restore = null;
        this.viewer.currentScaleValue = restore.scaleValue || 'auto';
        this.viewer.pagesRotation = restore.rotation;
        if (this.viewMode === 'single') this.viewer.scrollMode = this.#libs.viewerLib.ScrollMode.PAGE;
        if (this.spread) this.viewer.spreadMode = this.#libs.viewerLib.SpreadMode.ODD;
        this.viewer.currentPageNumber = restore.page;
        // The same pages came back (a content edit): stay exactly where the reader was, under the held pictures.
        if (this.#held) Object.assign(this.container, { scrollTop: this.#held.scrollTop, scrollLeft: this.#held.scrollLeft });
        return;
      }
      // Reopen where you left off (page, zoom, layout), remembered per file by the host.
      const resume = this.file.resume;
      this.viewer.currentScaleValue = resume?.scaleValue || 'auto';
      if (resume?.viewMode === 'single') this.setViewMode('single');
      if (resume?.spread === true) this.setSpread(true);
      if (resume?.page > 1 && resume.page <= this.pdf.numPages) {
        this.viewer.currentPageNumber = resume.page;
      } else {
        // pdf.js scrolls page 1 flush to the top edge; start at the very top so its margin shows.
        this.#startAtTop = true;
        requestAnimationFrame(() => this.#toStart());
      }
    });
    eventBus.on('pagechanging', ({ pageNumber, previous }) => {
      this.#animatePageTurn(pageNumber, previous);
      this.#changed();
    });
    eventBus.on('scalechanging', () => this.#changed());
    eventBus.on('rotationchanging', () => this.#changed());
    eventBus.on('pagerendered', ({ pageNumber }) => {
      this.#resolveFirstRender();
      this.#releasePage(pageNumber);
    });
    // Restoring the zoom after a rebuild re-announces the same scale; only a real change moves the pages.
    eventBus.on('scalechanging', ({ scale }) => { if (this.#held && Math.abs(scale - this.#held.scale) > 1e-6) this.#releaseHeld(); });
    eventBus.on('rotationchanging', ({ pagesRotation }) => { if (this.#held && pagesRotation !== this.#held.rotation) this.#releaseHeld(); });
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
    // Most files can be seen not to be signed from their bytes alone (before pdf.js takes them).
    this.#surelyUnsigned = !mayBeSigned(data);

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

    this.annotations.initPlan(identityPlan(this.pdf.numPages));
    // The outline is read once, here, and edited as one list from then on (pages/outline.js).
    readOutline(this.pdf).then((list) => { this.annotations.initOutline(list); });
    // The embedded files are read the same way, from the file's own bytes (attachments/attachments.js).
    this.#readAttachments();
    this.#shownPlan = this.annotations.plan;
    this.viewer.setDocument(this.pdf);
    readFields(this.pdf).then((fields) => { this.#fields = fields; });
    this.linkService.setDocument(this.pdf, null);
    try {
      const { info } = await this.pdf.getMetadata();
      this.encrypted = Boolean(info?.EncryptFilterName);
    } catch { /* metadata is optional */ }
    if (this.encrypted) await this.#loadSidecar();

    this.#setStatus('ready');
    this.dispatchEvent(new Event('ready'));
    // A file that may be signed: find out in idle time, so the first change doesn't wait for it.
    if (!this.#surelyUnsigned && !this.encrypted) {
      this.firstRender.then(() => requestIdleCallback(() => this.profile().catch(() => {}), { timeout: 4000 }));
    }
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
    this.#startAtTop = false; // a page was asked for, which wins over where the document opened
    const page = clamp(Math.round(pageNumber), 1, this.pdf.numPages);
    this.viewer.currentPageNumber = page;
    // Leave a little breathing room above the page instead of butting it against the toolbar.
    if (this.viewMode === 'continuous') this.container.scrollTop = Math.max(0, this.container.scrollTop - 12);
    if (pulse) this.#pulsePage(page);
  }

  nextPage() {
    if (!this.pdf) return;
    // In spreads a turn is always a whole spread (pdf.js turns one page when the pair isn't fully in view).
    if (!this.spread) { this.viewer.nextPage(); return; }
    const next = nextSpreadPage(this.viewer.currentPageNumber, this.pdf.numPages);
    if (next) this.viewer.currentPageNumber = next;
  }

  prevPage({ toBottom = false } = {}) {
    if (!this.pdf) return;
    if (this.spread) {
      const previous = previousSpreadPage(this.viewer.currentPageNumber);
      if (!previous) return;
      this.viewer.currentPageNumber = previous;
    } else if (!this.viewer.previousPage()) return;
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

  /** Two-page spreads on or off, staying on the same page (a fitted zoom refits to the new width). */
  setSpread(on) {
    if (!this.pdf || on === this.spread) return;
    const { SpreadMode } = this.#libs.viewerLib;
    const page = this.viewer.currentPageNumber;
    this.spread = on;
    this.viewer.spreadMode = on ? SpreadMode.ODD : SpreadMode.NONE;
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
    const bytes = await composeDocument({
      base: await this.#baseBytes(), plan: this.annotations.plan, sources: this.sources,
      annotations: this.annotations.all, edits: this.annotations.edits, forms: this.annotations.formValues,
      outline: this.annotations.outline, attachments: this.annotations.attachments,
    });
    await this.writeFile(target, bytes);
    this.annotations.markSaved();
  }

  /** Sends finished PDF bytes to the host, which writes them to a file it registered (atomically). */
  writeFile(target, bytes) {
    return writePdfFile(target, bytes);
  }

  // ---- page editing -----------------------------------------------------
  // Every operation takes plan entry ids (from shownPlan), changes the page plan in the edit store
  // (one undo step, annotations following their pages) and the document is rebuilt to match.

  /** Applies fn(plan) → { plan, copies? }. Returns false if nothing changed. */
  #editPlan(fn) {
    if (!this.canEditPages) return false;
    const before = this.annotations.plan;
    const { plan, copies = [] } = fn(before);
    const unchanged = plan.length === before.length && plan.every((e, i) => e === before[i] || JSON.stringify(e) === JSON.stringify(before[i]));
    if (unchanged) return false;
    if (!plan.length) {
      this.#notice('A PDF needs at least one page, so the last page can’t be deleted.');
      return false;
    }
    // A selection is a page number and a key. That is enough to find an object again after the
    // page is rewritten, but not enough to tell a reordered page from where it used to be — so a
    // plan change drops it rather than leaving it pointing somewhere plausible and wrong.
    this.objectSelection.clear();
    this.annotations.applyPlan(plan, [
      ...followPages(this.annotations.all, before, plan, copies),
      ...followEdits(this.annotations.edits, plan, copies),
      ...(this.annotations.outline?.length ? [{ outline: { before: this.annotations.outline, after: followOutlinePages(this.annotations.outline, before, plan) } }] : []),
    ]);
    return true;
  }

  rotatePages(ids, delta) {
    return this.#editPlan((plan) => ({ plan: rotateEntries(plan, new Set(ids), delta) }));
  }

  /** Sets 'crop', 'pageNumber' or 'watermark' on pages (null removes it); value may be a function of the entry. */
  setPageSetting(ids, key, value) {
    return this.#editPlan((plan) => ({ plan: setPageSetting(plan, new Set(ids), key, value) }));
  }

  deletePages(ids) {
    return this.#editPlan((plan) => ({ plan: removeEntries(plan, new Set(ids)) }));
  }

  duplicatePages(ids) {
    return this.#editPlan((plan) => duplicateEntries(plan, new Set(ids)));
  }

  /** Puts copies of pages at insertion point `toIndex`, with their annotations and edits. */
  copyPages(ids, toIndex) {
    return this.#editPlan((plan) => copyEntries(plan, new Set(ids), toIndex));
  }

  /** Moves pages to insertion point `toIndex` (0 = before the first page). */
  movePages(ids, toIndex) {
    return this.#editPlan((plan) => ({ plan: moveEntries(plan, new Set(ids), toIndex) }));
  }

  /** Inserts a blank page at `index`, the same size as the page before it. */
  insertBlankPage(index) {
    const near = this.viewer.getPageView(Math.max(0, index - 1))?.pdfPage?.view ?? [0, 0, 612, 792];
    const entry = { id: newId(), src: 'blank', width: near[2] - near[0], height: near[3] - near[1], rotate: 0 };
    return this.#editPlan((plan) => ({ plan: insertEntries(plan, index, [entry]) }));
  }

  /** Inserts every page of another PDF (described by the host) at `index`. Resolves with the page count. */
  async insertFile(file, index) {
    if (!this.canEditPages) return 0;
    const response = await fetch(file.url);
    if (!response.ok) throw new Error(`“${file.name}” couldn’t be read.`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    const count = await countPages(bytes);
    const sourceId = newId();
    this.sources.set(sourceId, bytes);
    const entries = Array.from({ length: count }, (_, i) => ({ id: newId(), src: sourceId, index: i, rotate: 0 }));
    this.#editPlan((plan) => ({ plan: insertEntries(plan, index, entries) }));
    return count;
  }

  /** A new PDF holding just these pages (in document order), with their annotations. */
  async exportPages(ids) {
    const wanted = new Set(ids);
    const current = this.annotations.plan;
    const plan = current.filter((e) => wanted.has(e.id));
    const position = new Map(plan.map((e, i) => [e.id, i + 1]));
    const annotations = [];
    for (const a of this.annotations.all) {
      const page = position.get(current[a.page - 1]?.id);
      if (page) annotations.push({ ...a, page });
    }
    return composeDocument({
      base: await this.#baseBytes(), plan, sources: this.sources, annotations,
      edits: this.annotations.edits, forms: this.annotations.formValues,
      outline: followOutlinePages(this.annotations.outline ?? [], current, plan),
      attachments: this.annotations.attachments,
    });
  }

  /** Reads the document's embedded files once, for the inspector. A failure just means "none known". */
  async #readAttachments() {
    try {
      this.annotations.initAttachments(this.encrypted ? [] : await readEmbeddedFiles(await this.#baseBytes()));
    } catch {
      this.annotations.initAttachments([]);
    }
  }

  async #baseBytes() {
    this.#base ??= await this.#readFile();
    return this.#base;
  }

  async #readFile() {
    const response = await fetch(this.file.url);
    if (!response.ok) throw new Error('The original file couldn’t be read. It may have been moved or deleted.');
    return new Uint8Array(await response.arrayBuffer());
  }

  /**
   * Rebuilds what's on screen from the current plan. Edits made while a rebuild is running are
   * folded into one more rebuild afterwards, so rapid clicks don't queue up slow work.
   */
  async #rebuild() {
    if (this.rebuilding) {
      this.#rebuildQueued = true;
      return;
    }
    this.rebuilding = true;
    this.el.classList.add('rebuilding');
    this.annotLayer.reset();
    this.#changed();
    try {
      do {
        this.#rebuildQueued = false;
        const plan = this.annotations.plan;
        const keepId = this.#shownPlan?.[this.viewer.currentPageNumber - 1]?.id;
        const keepIndex = this.viewer.currentPageNumber;
        const bytes = await composeDocument({
          base: await this.#baseBytes(), plan, sources: this.sources, edits: this.annotations.edits, forms: this.annotations.formValues, clean: false,
        });
        if (this.#rebuildQueued) continue;
        const found = plan.findIndex((e) => e.id === keepId);
        await this.#swapDocument(bytes, plan, found >= 0 ? found + 1 : Math.min(keepIndex, plan.length));
      } while (this.#rebuildQueued);
    } catch (err) {
      this.#notice(`The pages couldn’t be updated: ${err.message}`);
    } finally {
      this.rebuilding = false;
      this.el.classList.remove('rebuilding');
      this.annotLayer.refresh();
      this.#changed();
    }
  }

  async #swapDocument(bytes, plan, page) {
    const task = this.#libs.pdfjsLib.getDocument({ data: bytes, ...documentAssetOptions });
    const pdf = await task.promise;
    const previous = this.#documentTask;
    this.#restore = { scaleValue: this.viewer.currentScaleValue, rotation: this.viewer.pagesRotation, page };
    // The same pages in the same order come back where they were: until each renders, show it as it was.
    const samePages = JSON.stringify(plan) === JSON.stringify(this.#shownPlan);
    this.#releaseHeld();
    if (samePages) this.#holdPages();
    this.pdf = pdf;
    this.#documentTask = task;
    this.#shownPlan = plan;
    Object.assign(this.find, { current: 0, total: 0, state: null });
    this.viewer.setDocument(pdf);
    if (this.#held) this.#held.armed = true; // only the new document's renders release it
    readFields(pdf).then((fields) => { if (this.pdf === pdf) this.#fields = fields; });
    this.linkService.setDocument(pdf, null);
    previous?.destroy();
    this.dispatchEvent(new Event('documentchange'));
  }

  /**
   * Copies the pages on screen into a layer over them, in the scroller's own coordinates, before
   * pdf.js empties them: a rebuild then shows each page as it was until its new rendering arrives,
   * instead of a blank page. Only visible, rendered pages are copied. The layer also keeps the
   * scroller's height while the new pages are laid out, so the scroll position stays put.
   */
  #holdPages() {
    const box = this.container.getBoundingClientRect();
    const layer = h('div', { class: 'vl-held-pages', 'aria-hidden': 'true' });
    const pages = new Map();
    for (let i = 0; i < (this.pdf?.numPages ?? 0); i++) {
      const pv = this.viewer.getPageView(i);
      if (pv?.renderingState !== 3 /* finished */) continue;
      const r = pv.div.getBoundingClientRect();
      if (r.bottom <= box.top || r.top >= box.bottom || r.right <= box.left || r.left >= box.right) continue;
      const page = h('div', { class: 'vl-held-page' });
      Object.assign(page.style, {
        left: `${r.left - box.left + this.container.scrollLeft}px`, top: `${r.top - box.top + this.container.scrollTop}px`,
        width: `${r.width}px`, height: `${r.height}px`,
      });
      for (const src of pv.div.querySelectorAll('.canvasWrapper canvas')) {
        if (!src.width || !src.height) continue;
        const c = src.getBoundingClientRect();
        const copy = h('canvas', { width: src.width, height: src.height });
        Object.assign(copy.style, { left: `${c.left - r.left}px`, top: `${c.top - r.top}px`, width: `${c.width}px`, height: `${c.height}px` });
        try { copy.getContext('2d').drawImage(src, 0, 0); } catch { continue; }
        page.append(copy);
      }
      if (!page.childElementCount) continue;
      pages.set(i + 1, page);
      layer.append(page);
    }
    if (!pages.size) return;
    this.viewerEl.after(layer); // over the pages, under what sits over them (the text editor)
    this.#held = {
      layer, pages, armed: false, scale: this.viewer.currentScale, rotation: this.viewer.pagesRotation,
      scrollTop: this.container.scrollTop, scrollLeft: this.container.scrollLeft,
      // A page that never renders again (it failed, or was scrolled away) mustn't keep old pixels.
      timer: setTimeout(() => this.#releaseHeld(), 4000),
    };
  }

  #releasePage(n) {
    const held = this.#held;
    if (!held?.armed) return;
    held.pages.get(n)?.remove();
    held.pages.delete(n);
    if (!held.pages.size) this.#releaseHeld();
  }

  #releaseHeld() {
    if (!this.#held) return;
    clearTimeout(this.#held.timer);
    this.#held.layer.remove();
    this.#held = null;
  }

  /**
   * Resolves once page `n` of the document now shown has rendered (at once if it has), or after
   * `ms` at the latest: what an overlay waits for before it lets the page show itself again.
   */
  pageShown(n, ms = 4000) {
    const done = () => !this.rebuilding && this.viewer.getPageView(n - 1)?.renderingState === 3;
    if (done()) return Promise.resolve();
    return new Promise((resolve) => {
      const finish = () => {
        clearTimeout(timer);
        this.eventBus.off('pagerendered', onRendered);
        resolve();
      };
      const onRendered = () => { if (done()) finish(); };
      const timer = setTimeout(finish, ms);
      this.eventBus.on('pagerendered', onRendered);
    });
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

  /**
   * Re-applies a fitted zoom for the viewer's current size (pdf.js skips it if nothing changed).
   *
   * A document still at its very start stays there. When the scale changes, pdf.js scrolls back to
   * where it thinks the reader was, and for the start of a document that is page 1's own top edge,
   * flush against the tool bar: a tab shown for the first time, or the sidebar opened at the top
   * of a document, would lose the margin above the first page for no reason the reader gave.
   */
  #refit() {
    const value = this.pdf ? this.viewer.currentScaleValue : null;
    if (value !== 'auto' && value !== 'page-fit' && value !== 'page-width') return;
    const first = this.viewer.getPageView(0)?.div;
    const top = first ? first.getBoundingClientRect().top - this.container.getBoundingClientRect().top + this.container.scrollTop : 0;
    const atStart = this.viewer.currentPageNumber === 1 && this.container.scrollTop < top;
    this.viewer.currentScaleValue = value;
    if (atStart) this.container.scrollTop = 0;
  }

  /**
   * Scrolls to the very top of the document as it opens, once it can be scrolled. A document opened
   * behind another tab is hidden before this runs, and a hidden container ignores scrolling (and
   * keeps the offset pdf.js gave it), so it waits for the resize observer to see the tab shown.
   */
  #toStart() {
    if (!this.#startAtTop || !this.container.clientHeight) return;
    this.#startAtTop = false;
    if (this.pdf && this.viewer.currentPageNumber === 1) this.container.scrollTop = 0;
  }

  destroy() {
    this.#destroyed = true;
    this.#releaseHeld();
    this.#resizeObserver?.disconnect();
    cancelAnimationFrame(this.#refitFrame);
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
    const page = this.viewer.getPageView(pageNumber - 1)?.div;
    const div = page?.parentElement?.classList.contains('spread') ? page.parentElement : page; // a spread turns as one
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
