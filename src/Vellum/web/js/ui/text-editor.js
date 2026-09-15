import { h, clamp } from '../dom.js';
import { bridge } from '../bridge.js';
import { icon } from '../icons.js';
import { PAGE_KINDS, explainRun } from '../editing/runs.js';
import { EditError } from '../editing/edits.js';
import { isRemoved } from '../editing/session.js';
import { sharedCapability, refusalMessage } from '../editing/objects/capabilities.js';
import { ALIGNMENTS, DISTRIBUTIONS, MINIMUM, alignMoves, distributeMoves } from '../editing/objects/arrange.js';
import { snapMove } from '../editing/objects/snap.js';
import {
  quadArea, quadContains, hitTest, transformQuad, quadBox, quadCentre, handlePoints, unionBox, boxQuad, quadWithin, quadBasis,
} from '../editing/objects/geometry.js';
import { IDENTITY, apply, applyLinear, invert, multiply, translate } from '../editing/matrix.js';
import { scaleAbout, quarterTurn, flip, stretch, isIdentity } from '../editing/objects/transform.js';
import { pageViewAt, toPdfPoint, toClientPoint, toClientQuad, tolerancePoints, displayBasis } from '../page-space.js';

// Edit mode ("Edit text", E): shows what on a page can be selected and changed, and edits text in
// place. The engine (editing/) finds, checks and writes the text; this module is only the
// interaction:
//   - outlines around editable text, drawn through the annotation layer's page overlays
//   - selection: clicking a text run or an image selects that object, outlined where it is. The
//     selection is identity alone ({ page, keys }, editing/objects/selection.js); its geometry is
//     resolved from the page's current analysis every time it is drawn, never remembered.
//   - a floating editor over the text (in the scroll container, like the note editor), in the
//     page's own font and paper colour, so what you type looks like the page
//   - a small glass bar: which font the text will use, and Cancel / Done
// Enter keeps the change, Escape cancels, Tab moves to the next text (Shift+Tab to the previous).
//
//   - manipulation: dragging a selected object moves it, a corner handle scales it uniformly, an
//     edge handle stretches a picture along its own width or height, and the keyboard nudges,
//     turns, flips and deletes it. Every gesture ends as ONE edit record per object with an
//     ABSOLUTE transform, so one gesture is one undo and a second gesture replaces the first.
//     A move drag snaps to other objects' and the page's edges and centres (editing/objects/snap.js),
//     with guide lines while it does; Alt held drags freely.
//   - several objects on one page: Shift- or Ctrl-click adds an object to the selection or takes it
//     out, dragging over bare paper draws a rectangle that selects what it encloses (with Shift or
//     Ctrl, adds it), and Ctrl+A selects everything on the page. A drag, the handles around the whole
//     group and every key then act on all of them together — as one undo step, and only when every
//     one of them allows it.
//   - replacing a picture: with one picture selected, the bar over it (or the command palette) asks
//     the host for a PNG or JPEG file, and the picture's image becomes that one, in the same frame.
//
// Tab's itinerary is the editable text it has always been, and Enter still opens the editor on it.
//
// Where an object IS matters here, and it is never remembered. The analysis always describes the
// ORIGINAL page - that is what keeps a { page, key } naming the same object across any number of
// edits - so an object that has been moved is drawn, hit-tested and dragged from its own quad with
// its record's transform applied (#liveOf). Nothing in this module stores a coordinate between two
// frames except the gesture currently under the pointer.
//
// Only what an object's capabilities allow is offered: a locked run is never dragged, a clipped
// picture is never turned, and text is never rotated. The engine refuses all of that again anyway
// (editing/edits.js, editing/objects/image.js) - the UI simply does not ask.

const SVG_NS = 'http://www.w3.org/2000/svg';
/** Screen pixels the pointer may wander before a press becomes a drag rather than a click. */
const DRAG_THRESHOLD = 3;
/** Screen pixels around a corner handle that count as grabbing it. */
const HANDLE_GRAB = 8;
/** Screen pixels within which a dragged object's edge or centre snaps to another's, or the page's. */
const SNAP_DISTANCE = 5;
/** What one arrow key moves an object, in points; with Shift, ten times as far. */
const NUDGE_STEP = 1;
/** Bounds on a corner or edge drag, so a slip of the hand can't collapse an object or throw it off the page. */
const SCALE_LIMITS = [0.05, 20];
/**
 * What each edge handle stretches, in the order handlePoints() lists the edge midpoints — bottom,
 * right, top, left — as [the picture's own axis, the edge that stays put along it].
 */
const EDGES = Object.freeze([['y', 1], ['x', 0], ['y', 0], ['x', 1]]);
/** The arrange bar's buttons, in order: what each does, what it is called, its icon. */
const ARRANGE_BUTTONS = Object.freeze([
  ['left', 'Align left edges', 'align-start-vertical'],
  ['center', 'Align centres', 'align-center-vertical'],
  ['right', 'Align right edges', 'align-end-vertical'],
  null,
  ['top', 'Align top edges', 'align-start-horizontal'],
  ['middle', 'Align middles', 'align-center-horizontal'],
  ['bottom', 'Align bottom edges', 'align-end-horizontal'],
  null,
  ['horizontal', 'Space evenly across', 'align-horizontal-space-between'],
  ['vertical', 'Space evenly down', 'align-vertical-space-between'],
]);
let nudgeSeq = 0;
const STANDARD_CSS = { Helvetica: 'Arial, Helvetica, sans-serif', Times: '"Times New Roman", Times, serif', Courier: '"Courier New", Courier, monospace' };

function svg(tag, attrs) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, value);
  return el;
}

const quadPoints = (q) => `${q[0]},${q[1]} ${q[2]},${q[3]} ${q[4]},${q[5]} ${q[6]},${q[7]}`;
const distance = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
/** The same objects, in any order. */
const sameKeys = (a, b) => a.length === b.length && a.every((key) => b.includes(key));
const counted = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/** A file's bytes as the host sends them (base64). */
function decodeBase64(data) {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** A text run's object key in the model: the one place the two namings meet. */
const runKeyOf = (key) => `run:${key}`;

/** Shift or Ctrl held: a click adds to the selection, and a rectangle adds what it encloses. */
const additive = (e) => e.shiftKey || e.ctrlKey || e.metaKey;

/**
 * The stretch an edge drag asks for with the pointer at `to` (PDF user space): where the pointer is
 * along the picture's own axis, measured in the picture's own unit square from the edge that stays.
 * Past that edge is not a stretch but a mirror, so the factor is kept to the scale limits.
 */
function stretchTo(drag, to) {
  const inverse = invert(drag.basis);
  if (!inverse) return null;
  const [u, v] = apply(inverse, to[0], to[1]);
  const along = drag.axis === 'x' ? u : v;
  return stretch(drag.basis, drag.axis, clamp(drag.fixedAt === 0 ? along : 1 - along, ...SCALE_LIMITS), drag.fixedAt);
}

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
  #drag = null; // the gesture under the pointer: { n, mode, keys, quads, from, client, moved, ... }
  #shownAt = null; // { n, quads: key → quad } - where a pending or just-committed gesture puts objects
  #nudge = null; // an arrow-key burst not yet written: { n, keys, base, token, transform, flush, end }
  #gesture = 0; // serial number: an async hit test whose gesture has moved on is dropped
  #clickAfterDrag = false;
  #editor = null; // { n, key, item, el, paper, input, bar, status, done, pending }
  #arrangeBar = null; // { el, arrange, spacing, replace } - over several objects, or one picture
  #committing = null;
  #tip = null;
  #hoverQueued = false;
  #previewTimer = 0;
  #announcer;
  #warnedTagged = new Set(); // what the tagged-PDF warning has been given for: 'text', 'picture'

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
    c.addEventListener('pointerdown', (e) => this.#onPointerDown(e), { signal });
    c.addEventListener('pointermove', (e) => this.#onHover(e), { signal });
    c.addEventListener('pointerup', (e) => this.#onPointerUp(e), { signal });
    c.addEventListener('lostpointercapture', () => this.#cancelGesture(), { signal });
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

  /**
   * Lines the selected objects up — `left`, `center`, `right`, `top`, `middle` or `bottom` — or spaces
   * them evenly, `horizontal` or `vertical`, as ONE undo step, and only when every one of them can be
   * moved. Edges are the ones a person sees, whatever the page's rotation or the view's. The arrange
   * bar and the commands (commands.js) both call this, so the two can't do different things.
   * Resolves true when anything moved.
   */
  async arrange(kind) {
    const distribute = DISTRIBUTIONS.includes(kind);
    if (!distribute && !ALIGNMENTS.includes(kind)) return false;
    const current = this.#selection.current;
    if (!this.active || !current || current.keys.length < (distribute ? MINIMUM.distribute : MINIMUM.align)) {
      this.#notify(distribute ? 'Select three or more objects in Edit mode to space them evenly.' : 'Select two or more objects in Edit mode to line them up.');
      return false;
    }
    if (!(await this.commitPending())) return false;
    this.#closeEditor();
    await this.#settled();
    const page = await this.#ensurePage(current.page);
    const pageView = this.#view.viewer.getPageView(current.page - 1);
    const objects = current.keys.map((key) => this.#liveObject(current.page, key));
    if (!page?.data || !pageView || objects.some((o) => !o) || !this.#allow(objects, 'move')) return false;
    this.#flushNudge();
    // Measured as the page is shown, moved in the page's own user space.
    const shown = displayBasis(pageView);
    const back = invert(shown);
    const quads = new Map(objects.map((o) => [o.ref.key, this.#shownQuad(page, o.ref.key, o.geometry.quad)]));
    if (!back || [...quads.values()].some((q) => !q)) return false;
    const boxes = objects.map((o) => ({ key: o.ref.key, box: quadBox(transformQuad(quads.get(o.ref.key), shown)) }));
    const moves = (distribute ? distributeMoves(boxes, kind) : alignMoves(boxes, kind)) ?? [];
    const deltas = moves.map(({ key, dx, dy }) => ({ key, delta: translate(...applyLinear(back, dx, dy)) }));
    if (!deltas.length) return false;
    this.#showPreview(current.page, new Map(deltas.map(({ key, delta }) => [key, transformQuad(quads.get(key), delta)])));
    const changed = await this.#write(current.page, deltas, 'move', { said: distribute ? 'Spaced evenly.' : 'Lined up.' });
    if (!changed) this.#announce(distribute ? 'They were already evenly spaced.' : 'They were already lined up.');
    return changed;
  }

  /**
   * Replaces the one selected picture's image with a PNG or JPEG the host's file dialog picks. The bar
   * over a selected picture and the command (commands.js) both call this. Resolves true when replaced.
   */
  async replacePicture() {
    if (!this.#replaceable()) return false;
    let file;
    try {
      ({ file } = await bridge.request('pictureDialog'));
    } catch (err) {
      this.#notify(`That picture couldn’t be opened: ${err.message}`);
      return false;
    }
    if (!file) return false;
    return this.replacePictureWith({ name: file.name, bytes: decodeBase64(file.data) });
  }

  /**
   * Puts a PNG or JPEG the host's file dialog picks on a page as a new picture, centred and upright,
   * and selects it. `n` is the page (1-based); by default the selection's page, else the page in
   * view. The command (commands.js) and the page's context menu in Edit mode call this. Resolves true
   * when the picture was added.
   */
  async insertPicture(n = null) {
    const page = this.#insertionPage(n);
    if (!page) return false;
    let file;
    try {
      ({ file } = await bridge.request('pictureDialog', { purpose: 'insert' }));
    } catch (err) {
      this.#notify(`That picture couldn’t be opened: ${err.message}`);
      return false;
    }
    if (!file) return false;
    return this.insertPictureWith({ name: file.name, bytes: decodeBase64(file.data) }, page);
  }

  /**
   * Puts `bytes` (a PNG or JPEG file's contents, named `name`) on page `n` as a new picture: one undo
   * step, and the new picture selected. What insertPicture() does once the file has been chosen.
   */
  async insertPictureWith({ name, bytes }, n = null) {
    const page = this.#insertionPage(n);
    if (!page) return false;
    if (!(await this.commitPending())) return false;
    this.#closeEditor();
    this.#flushNudge();
    await this.#settled();
    const pageView = this.#view.viewer.getPageView(page - 1);
    if (!pageView?.pdfPage) {
      this.#notify('That page isn’t ready yet. Try again in a moment.');
      return false;
    }
    try {
      const key = await this.#view.textEditing.insertImage(page, bytes, { basis: displayBasis(pageView), box: pageView.pdfPage.view });
      this.#announce(`Picture “${name}” added.`);
      this.#warnTagged('inserted');
      // Selected once the rebuilt page has it: until then the page data is the old one, and
      // reconciling against it would drop a key it has never heard of.
      const until = performance.now() + 20000;
      while (performance.now() < until) {
        await this.#settled();
        const now = this.#view.rebuilding ? null : await this.#ensurePage(page);
        if (now?.data && this.#liveOf(now).byKey.has(key)) break;
        await new Promise((r) => requestAnimationFrame(r));
      }
      if (this.active) this.#changeSelection((s) => s.set(page, [key]));
      return true;
    } catch (err) {
      this.#notify(err instanceof EditError ? err.message : `That picture couldn’t be added: ${err.message}`);
      return false;
    }
  }

  /** The page a new picture goes on, when Edit mode is on: `n`, the selection's page, or the page in view. */
  #insertionPage(n) {
    if (!this.active) {
      this.#notify('Switch to Edit mode (E) to insert a picture.');
      return null;
    }
    return n ?? this.#selection.page ?? this.#view.viewer.currentPageNumber ?? null;
  }

  /**
   * Replaces the one selected picture's image with `bytes` (a PNG or JPEG file's contents, named
   * `name`): the picture keeps its frame and its selection, and the change is one undo step. What
   * replacePicture() does once the file has been chosen.
   */
  async replacePictureWith({ name, bytes }) {
    const target = this.#replaceable();
    if (!target) return false;
    if (!(await this.commitPending())) return false;
    this.#flushNudge();
    await this.#settled();
    try {
      await this.#view.textEditing.replaceImage(target.page, target.key, bytes);
      this.#announce(`Picture replaced with “${name}”.`);
      this.#warnTagged('picture');
      return true;
    } catch (err) {
      this.#notify(err instanceof EditError ? err.message : `That picture couldn’t be replaced: ${err.message}`);
      return false;
    }
  }

  /** The one selected picture as { page, key } when it can be replaced; otherwise says why, and null. */
  #replaceable() {
    const current = this.#selection.current;
    const object = this.active && current?.keys.length === 1 ? this.#liveObject(current.page, current.keys[0]) : null;
    if (object?.kind !== 'image') {
      this.#notify('Select one picture in Edit mode to replace it.');
      return null;
    }
    return this.#allow([object], 'replace') ? { page: current.page, key: current.keys[0] } : null;
  }

  // ---- entering and leaving edit mode ---------------------------------------------------

  async #toolChanged() {
    const view = this.#view;
    if (!this.active) {
      await this.commitPending();
      this.#flushNudge();
      this.#cancelGesture();
      this.#closeEditor();
      this.#hideTip();
      this.#hover = null;
      this.#selection.clear();
      this.#syncArrangeBar();
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
    this.#announce('Edit. Click text to change it, drag an object to move it, or press Tab to move between editable text.');
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
    this.#shownAt = null; // the rebuilt pages carry the change the preview was standing in for
    this.#hideTip();
    if (this.#editor) this.#closeEditor({ refocus: false });
  }

  // ---- page data and outlines -------------------------------------------------------------

  async #showPage(n) {
    const page = await this.#ensurePage(n);
    if (!page || !this.active) return;
    if (this.#selection.page === n) this.#reconcile(page);
    this.#draw(page);
  }

  /**
   * Drops from the selection whatever is no longer on its page: an object the analysis no longer
   * has, and one an edit has taken away — the analysis is of the ORIGINAL page, so it still lists
   * what a deletion removed, and redoing a deletion must not leave a selection nothing draws.
   */
  #reconcile(page) {
    const selection = this.#selection;
    // The live objects are the page's selectable ones — its own and any picture put on it from a
    // file, which the analysis of the original page can't know — less what an edit has removed.
    if (!page.data) {
      selection.clear();
      return;
    }
    const { quads } = this.#liveOf(page);
    selection.retain((key) => Boolean(quads.get(key)));
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

  /**
   * The page's selectable objects where they are NOW, in drawing order, and a quad for every one of
   * them by key: its own quad with the absolute transform its edit record holds applied, or null
   * when the record removed it altogether.
   *
   * This is the only place the original page and the edits made to it are put together. The
   * analysis is always of the ORIGINAL content — which is exactly why { page, key } keeps naming
   * the same object however often the file is rewritten — so an object that has been dragged is
   * nowhere near its analysed quad, and drawing or hit-testing from that quad would point at where
   * it used to be. Worked out once per page load and thrown away with it: a rebuild clears #pages.
   */
  #liveOf(page) {
    if (page.live) return page.live;
    const records = page.objects?.records ?? new Map();
    const objects = [];
    const quads = new Map();
    const byKey = new Map();
    for (const object of page.objects?.objects ?? []) {
      const edit = records.get(object.ref.key) ?? null;
      // A picture whose draw is gone, and text whose glyphs are gone, are not on the page to point at.
      const quad = isRemoved(edit) ? null : transformQuad(object.geometry.quad, edit?.transform ?? null);
      quads.set(object.ref.key, quad);
      if (!quad) continue;
      const live = { ...object, geometry: { ...object.geometry, quad, box: quadBox(quad) }, edit };
      objects.push(live);
      byKey.set(object.ref.key, live);
    }
    page.live = { objects, quads, byKey };
    return page.live;
  }

  /** One live object by key, or null: what a gesture and the keyboard both act on. */
  #liveObject(n, key) {
    const page = this.#pages.get(n);
    return page?.data ? this.#liveOf(page).byKey.get(key) ?? null : null;
  }

  /** Where an object is drawn right now: a pending gesture's preview if it has one, else its quad. */
  #shownQuad(page, key, fallback = null) {
    if (this.#shownAt?.n === page.n && this.#shownAt.quads.has(key)) return this.#shownAt.quads.get(key);
    const quads = this.#liveOf(page).quads;
    return quads.has(key) ? quads.get(key) : fallback;
  }

  /**
   * The keys drawn as selected on a page: the selection, and while a selection rectangle is being
   * dragged out, what letting go would select — so the rectangle shows what it will take before it
   * takes it.
   */
  #selectedOn(page) {
    const selection = this.#selection;
    const drag = this.#drag;
    const current = selection.page === page.n ? [...selection.keys] : [];
    if (drag?.mode !== 'marquee' || drag.n !== page.n || !drag.box) return current;
    const enclosed = this.#enclosed(page, drag.box);
    return drag.additive ? [...new Set([...current, ...enclosed])] : enclosed;
  }

  /** The objects a selection rectangle encloses, where they are now, in drawing order. */
  #enclosed(page, box) {
    return this.#liveOf(page).objects.filter((o) => quadWithin(o.geometry.quad, box)).map((o) => o.ref.key);
  }

  /**
   * The quad the corner handles sit on, or null when there are to be none. For one object it is the
   * object's own quad; for several, the box around all of them. Either way only where every one of
   * them can really be scaled — a handle promises a uniform scale, and is never offered for a drag
   * that would be refused — and not while the text editor is open over one of them.
   */
  #handleFrame(page, objects) {
    if (!objects.length || sharedCapability(objects, 'scale') !== true) return null;
    if (this.#editor?.n === page.n && objects.some((o) => o.ref.key === runKeyOf(this.#editor.key))) return null;
    const quads = objects.map((o) => this.#shownQuad(page, o.ref.key, o.geometry.quad));
    if (quads.some((q) => !q)) return null;
    return quads.length === 1 ? quads[0] : boxQuad(unionBox(quads));
  }

  /**
   * May these selected objects be stretched from an edge handle? Only one object at a time — a group
   * stretched along the page's axes would shear any picture in it that is turned — and only an object
   * whose capabilities allow it, which is a picture and never text.
   */
  #stretchable(objects) {
    return objects.length === 1 && objects[0].capabilities.stretch === true;
  }

  #draw(page) {
    const layer = this.#view.annotLayer;
    if (!this.active || !page.data) {
      layer.decorate(page.n, []);
      return;
    }
    const selectedKeys = this.#selectedOn(page);
    const chosen = new Set(selectedKeys);
    const shapes = [];
    for (const item of page.data.runs) {
      const { run } = item;
      const key = runKeyOf(run.key);
      const hovered = this.#hover?.n === page.n && this.#hover.key === run.key;
      const focused = chosen.has(key);
      if (this.#editor?.n === page.n && this.#editor.key === run.key) continue; // the editor covers it
      if (run.reasons.has('blank') || (!run.editable && !hovered && !focused)) continue;
      // Its own quad only for a run the object model doesn't offer (invisible or clipping text,
      // which is still explained when it is hovered); everything else is drawn where it is now.
      const quad = this.#shownQuad(page, key, run.quad);
      if (!quad) continue; // its text has been removed: there is nothing there any more
      const cls = ['vl-edit-run', !run.editable && 'locked', hovered && 'hover', focused && 'focus', item.edit && 'edited'].filter(Boolean).join(' ');
      shapes.push(svg('polygon', { class: cls, points: quadPoints(quad) }));
    }
    // Anything else selected — pictures — outlined where each is NOW. Selected text is already
    // drawn above, in the outline Edit mode has always used for it.
    const selected = selectedKeys.map((key) => this.#liveObject(page.n, key)).filter(Boolean);
    for (const object of selected) {
      if (object.kind === 'text-run') continue;
      const quad = this.#shownQuad(page, object.ref.key, object.geometry.quad);
      if (quad) shapes.push(svg('polygon', { class: 'vl-object-sel', points: quadPoints(quad) }));
    }
    // Corner handles, and only where a corner drag can really be honoured (#handleFrame). Several
    // objects share one frame around all of them, drawn so the handles plainly belong to the group.
    const frame = this.#drag?.mode === 'marquee' ? null : this.#handleFrame(page, selected);
    if (frame) {
      if (selected.length > 1) shapes.push(svg('polygon', { class: 'vl-object-group', points: quadPoints(frame) }));
      const r = tolerancePoints(this.#view.viewer.getPageView(page.n - 1), 4);
      const points = handlePoints(frame) ?? [];
      for (const [x, y] of points.slice(0, 4)) shapes.push(svg('circle', { class: 'vl-object-handle', cx: x, cy: y, r }));
      // Edge handles stretch, so they are only for one object that can be stretched: a picture.
      if (this.#stretchable(selected)) {
        for (const [x, y] of points.slice(4)) shapes.push(svg('circle', { class: 'vl-object-handle edge', cx: x, cy: y, r }));
      }
    }
    // The selection rectangle being dragged out over the paper.
    const drag = this.#drag;
    if (drag?.mode === 'marquee' && drag.n === page.n && drag.box) {
      shapes.push(svg('polygon', { class: 'vl-object-marquee', points: quadPoints(boxQuad(drag.box)) }));
    }
    // Guide lines where a move drag has snapped into line, measured in display axes and drawn back in
    // user space: a line that is vertical on screen stays vertical whatever the rotation.
    if (drag?.mode === 'move' && drag.n === page.n && drag.guides?.length && drag.snap) {
      for (const { axis, at, from, to } of drag.guides) {
        const [x1, y1] = applyLinear(drag.snap.back, ...(axis === 'x' ? [at, from] : [from, at]));
        const [x2, y2] = applyLinear(drag.snap.back, ...(axis === 'x' ? [at, to] : [to, at]));
        shapes.push(svg('line', { class: 'vl-snap-guide', x1, y1, x2, y2 }));
      }
    }
    layer.decorate(page.n, shapes);
    if (page.n === this.#selection.page || this.#arrangeBar) this.#syncArrangeBar();
  }

  /** Selects exactly one object — or nothing, given nothing. Only identity ever goes in. */
  #select(to) {
    return this.#changeSelection((s) => (to ? s.select(to.n, to.key) : s.clear()));
  }

  /**
   * Changes the selection through `change(selection)` and redraws whatever that touched. A keyboard
   * burst is written first when the objects it was moving are no longer the ones selected: another
   * selection is another gesture, and another undo step.
   */
  #changeSelection(change) {
    const selection = this.#selection;
    const before = selection.current;
    if (!change(selection)) return false;
    const after = selection.current;
    const nudge = this.#nudge;
    if (nudge && !(after?.page === nudge.n && sameKeys(after.keys, nudge.keys))) this.#flushNudge();
    for (const n of new Set([before?.page, after?.page].filter(Boolean))) {
      const page = this.#pages.get(n);
      if (page) this.#draw(page);
    }
    if (after && after.keys.length > 1) this.#announce(`${counted(after.keys.length, 'object', 'objects')} selected.`);
    this.#syncArrangeBar();
    return true;
  }

  // ---- the arrange bar ---------------------------------------------------------------------------------
  // Over a selection of several objects, a small floating bar lines them up or spaces them evenly
  // (arrange()); over one picture that can be replaced, the same bar holds only "Replace picture…"
  // (replacePicture()). It sits by the frame around the selection, steps aside while a drag is under
  // way or text is being typed, and never takes the keyboard focus from the page, so the object keys
  // keep working with it on screen. Every one of its actions is also a command, for the palette.

  #syncArrangeBar() {
    const selection = this.#selection;
    const single = selection.size === 1 ? this.#liveObject(selection.page, selection.keys[0]) : null;
    const replacing = single?.kind === 'image' && single.capabilities.replace === true;
    const page = this.active && !this.#editor && !this.#drag?.moved && (selection.size >= MINIMUM.align || replacing)
      ? this.#pages.get(selection.page) : null;
    const pageView = page?.data ? this.#view.viewer.getPageView(page.n - 1) : null;
    const quads = pageView ? selection.keys.map((key) => {
      const object = this.#liveObject(page.n, key);
      return object ? this.#shownQuad(page, key, object.geometry.quad) : null;
    }) : [];
    const box = quads.length && quads.every(Boolean) ? unionBox(quads) : null;
    const corners = box ? toClientQuad(pageView, boxQuad(box)) : null;
    if (!corners) {
      this.#arrangeBar?.el.remove();
      this.#arrangeBar = null;
      return;
    }
    const bar = this.#arrangeBar ??= this.#buildArrangeBar();
    for (const el of bar.arrange) el.hidden = replacing;
    for (const el of bar.spacing) el.hidden = replacing || selection.size < MINIMUM.distribute;
    bar.replace.hidden = !replacing;
    bar.el.setAttribute('aria-label', replacing ? 'The selected picture' : 'Arrange the selected objects');
    const xs = corners.map((p) => p[0]);
    const ys = corners.map((p) => p[1]);
    const left = Math.min(...xs);
    const top = Math.min(...ys);
    this.#placeNear(bar.el, new DOMRect(left, top, Math.max(...xs) - left, Math.max(...ys) - top), 'above');
  }

  #buildArrangeBar() {
    const keep = (e) => e.preventDefault(); // pressing a button leaves the focus where it was
    const children = ARRANGE_BUTTONS.map((entry) => {
      if (!entry) return h('div', { class: 'vl-sep' });
      const [kind, label, iconName] = entry;
      return h('button', {
        class: 'tb-btn small', title: label, 'aria-label': label, html: icon(iconName, 16), onMousedown: keep, onClick: () => this.arrange(kind),
      });
    });
    // Spacing evenly needs three objects: those buttons, and the separator before them, come and go.
    const first = ARRANGE_BUTTONS.findIndex((entry) => entry && DISTRIBUTIONS.includes(entry[0]));
    const spacing = children.slice(ARRANGE_BUTTONS[first - 1] === null ? first - 1 : first);
    const replace = h('button', {
      class: 'tb-btn small vl-replace-picture', title: 'Replace picture…', 'aria-label': 'Replace picture…',
      html: icon('image', 16), onMousedown: keep, onClick: () => this.replacePicture(),
    });
    const el = h('div', { class: 'vl-pop vl-arrange-bar ui', role: 'toolbar', 'aria-label': 'Arrange the selected objects' }, ...children, replace);
    this.#view.container.append(el);
    return { el, arrange: children, spacing, replace };
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
    // Where the pointer is, not what the event was aimed at: a captured pointer retargets its
    // events to the element holding the capture, which is not the page the person is pointing at.
    const at = pageViewAt(this.#view, target) ?? pageViewAt(this.#view, document.elementFromPoint(clientX, clientY));
    if (!at) return null;
    const page = await this.#ensurePage(at.n);
    if (!page?.data) return { n: at.n, page, object: null, item: null, pageView: at.pageView };
    const point = toPdfPoint(at.pageView, clientX, clientY);
    const tol = tolerancePoints(at.pageView, 2);
    const object = hitTest(this.#liveOf(page).objects, point, tol);
    if (object) {
      const item = object.kind === 'text-run'
        ? page.data.runs.find((r) => r.run.key === object.ref.runKey) ?? null
        : null;
      return { n: at.n, page, object, item, pageView: at.pageView };
    }
    return { n: at.n, page, object: null, item: this.#explainableAt(page, point, tol), pageView: at.pageView };
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
    if (!this.active) return;
    if (this.#drag) {
      this.#onDragMove(e);
      return;
    }
    if (this.#hoverQueued || e.buttons) return;
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
      // A picture says "drag me"; text keeps the caret, because clicking it types rather than moves.
      c.classList.toggle('vl-edit-move', hit?.object?.kind === 'image' && hit.object.capabilities.move === true);
      if (previous?.n === this.#hover?.n && previous?.key === this.#hover?.key) return;
      if (previous && previous.n !== hit?.n) {
        const old = this.#pages.get(previous.n);
        if (old) this.#draw(old);
      }
      if (hit?.page) this.#draw(hit.page);
    });
  }

  async #onClick(e) {
    if (this.#clickAfterDrag) {
      this.#clickAfterDrag = false; // the pointerup that ended a drag: it selected and moved already
      return;
    }
    if (!this.active || e.button !== 0 || e.target.closest?.('.vl-text-editor, .vl-edit-bar, .vl-edit-tip, .vl-arrange-bar')) return;
    const hit = await this.#hitAt(e.target, e.clientX, e.clientY);
    if (!hit) return;
    // Shift or Ctrl: the object clicked joins the selection, or leaves it if it was already in.
    // Nothing is opened, and a click on bare paper leaves the selection exactly as it is.
    if (additive(e)) {
      if (!(await this.commitPending())) return;
      this.#closeEditor();
      if (hit.object) this.#changeSelection((s) => s.toggle(hit.n, hit.object.ref.key));
      return;
    }
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

  // ---- moving and scaling with the pointer, and selecting with a rectangle -------------------------
  //
  // One gesture is one undo step, with one edit record per object, and a record holds where its
  // object ENDS UP rather than how far it just went — so dragging the same picture twice replaces the
  // first record instead of stacking a second. The pointer is converted to PDF user space once
  // (page-space.js) and every distance is measured there; the only thing measured on screen is the
  // 3-pixel threshold, because "did the hand move?" is a question about the screen.
  //
  // With several objects selected a gesture acts on all of them, and is offered only when every one
  // allows it (sharedCapability). Nothing is written that the engine wouldn't accept: it checks
  // again, and refuses the whole gesture, whatever this module asked.

  async #onPointerDown(e) {
    if (!this.active || e.button !== 0) return;
    if (e.target.closest?.('.vl-text-editor, .vl-edit-bar, .vl-edit-tip, .vl-arrange-bar')) return;
    this.#clickAfterDrag = false;
    const seq = ++this.#gesture;
    // Something is being typed and the press is elsewhere on the page: keep it first, exactly as
    // clicking away has always kept it. If it can't be kept, the editor stays open to be fixed and
    // no gesture starts on top of it.
    if (this.#editor) {
      if (!(await this.commitPending())) return;
      this.#closeEditor();
    }
    // A corner handle first: it sits on the objects it scales, so hit-testing them would win.
    const start = (additive(e) ? null : this.#handleAt(e.clientX, e.clientY)) ?? await this.#pressAt(e);
    if (!start || seq !== this.#gesture || !this.active || this.#editor) return;
    this.#flushNudge(); // a keyboard burst and a drag are two gestures, and so two undo steps
    // The pointer is NOT captured here. A press that turns out to be a click has to reach the page
    // as a click on the page - that is what opens the text editor - and a captured pointer would
    // send it to the container instead. Capture is taken when the drag actually starts.
    this.#drag = { ...start, client: [e.clientX, e.clientY], moved: false, transform: IDENTITY, pointerId: e.pointerId };
  }

  /**
   * A corner handle of the selection under the pointer, as the start of a uniform scale: the corner
   * opposite the one being pulled is the anchor, so the two corners a person can see behave as they
   * look — one follows the pointer, the other stays exactly where it is. For several objects the
   * corners are those of the frame around all of them, and every object scales about the same anchor.
   */
  #handleAt(clientX, clientY) {
    const current = this.#selection.current;
    const page = current && this.#pages.get(current.page);
    const pageView = current && this.#view.viewer.getPageView(current.page - 1);
    if (!page?.data || !pageView) return null;
    const objects = current.keys.map((key) => this.#liveObject(current.page, key));
    if (objects.some((o) => !o)) return null;
    const frame = this.#handleFrame(page, objects);
    const points = frame ? handlePoints(frame) : null;
    if (!points) return null;
    const grabbed = (i) => {
      const at = toClientPoint(pageView, points[i][0], points[i][1]);
      return Boolean(at) && Math.hypot(at[0] - clientX, at[1] - clientY) <= HANDLE_GRAB;
    };
    for (let i = 0; i < 4; i++) {
      if (!grabbed(i)) continue;
      return {
        mode: 'scale', verb: 'scale', n: current.page, keys: [...current.keys], pageView,
        quads: this.#quadsOf(page, objects), from: points[i], anchor: points[(i + 2) % 4],
      };
    }
    // An edge handle stretches the picture along its own axis, from the opposite edge. The basis is
    // read from the quad it is drawn with now, which for a picture is its placement exactly.
    const basis = this.#stretchable(objects) ? quadBasis(frame) : null;
    for (let i = 0; basis && i < 4; i++) {
      if (!grabbed(4 + i)) continue;
      const [axis, fixedAt] = EDGES[i];
      return {
        mode: 'stretch', verb: 'stretch', n: current.page, keys: [...current.keys], pageView,
        quads: this.#quadsOf(page, objects), basis, axis, fixedAt,
      };
    }
    return null;
  }

  /** Where each of these objects is drawn right now, by key. */
  #quadsOf(page, objects) {
    return new Map(objects.map((o) => [o.ref.key, this.#shownQuad(page, o.ref.key, o.geometry.quad)]));
  }

  /**
   * What a press away from the handles starts:
   *
   *  - on an object, a move: of the whole selection when the object is one of several selected
   *    (a click without a drag then selects it alone, in #onClick), otherwise of that object, which
   *    is selected there and then so the drag is visibly on it. With Shift or Ctrl held nothing
   *    starts — the click adds the object to the selection or takes it out instead.
   *  - on bare paper, a selection rectangle, which a click without a drag never becomes.
   *
   * A move that can't be honoured still becomes a gesture: one that says why, once, when the hand
   * actually moves, rather than leaving a drag that silently does nothing.
   */
  async #pressAt(e) {
    const hit = await this.#hitAt(e.target, e.clientX, e.clientY);
    if (!hit?.page?.data) return null;
    const { object } = hit;
    if (!object) {
      return { mode: 'marquee', n: hit.n, pageView: hit.pageView, from: toPdfPoint(hit.pageView, e.clientX, e.clientY), box: null, additive: additive(e) };
    }
    if (additive(e)) return null;
    const key = object.ref.key;
    const inGroup = this.#selection.size > 1 && this.#selection.has(hit.n, key);
    if (!inGroup) this.#select({ n: hit.n, key });
    const keys = inGroup ? [...this.#selection.keys] : [key];
    const objects = keys.map((k) => this.#liveObject(hit.n, k));
    if (objects.some((o) => !o)) return null;
    const answer = sharedCapability(objects, 'move');
    if (answer !== true) return { mode: 'refused', n: hit.n, message: refusalMessage('move', answer.reason, objects.length) };
    return {
      mode: 'move', verb: 'move', n: hit.n, keys, pageView: hit.pageView,
      quads: this.#quadsOf(hit.page, objects), from: toPdfPoint(hit.pageView, e.clientX, e.clientY),
    };
  }

  #onDragMove(e) {
    const drag = this.#drag;
    if (!(e.buttons & 1)) {
      this.#cancelGesture();
      return;
    }
    if (!drag.moved && Math.hypot(e.clientX - drag.client[0], e.clientY - drag.client[1]) < DRAG_THRESHOLD) return;
    if (!drag.moved) {
      drag.moved = true;
      this.#syncArrangeBar(); // out of the way while the hand is moving
      if (drag.mode === 'refused') {
        this.#notify(drag.message);
        return;
      }
      try {
        // Now that this is certainly a drag, follow the pointer even off the page.
        this.#view.container.setPointerCapture(drag.pointerId);
      } catch {
        // No capture (a synthesised pointer, say): the drag still works, it just can't leave the page.
      }
    }
    if (drag.mode === 'refused') return;
    const to = toPdfPoint(drag.pageView, e.clientX, e.clientY);
    if (drag.mode === 'marquee') {
      drag.box = [Math.min(drag.from[0], to[0]), Math.min(drag.from[1], to[1]), Math.max(drag.from[0], to[0]), Math.max(drag.from[1], to[1])];
      const page = this.#pages.get(drag.n);
      if (page) this.#draw(page);
      return;
    }
    const transform = drag.mode === 'scale'
      ? scaleAbout(drag.anchor, clamp(distance(to, drag.anchor) / (distance(drag.from, drag.anchor) || 1), ...SCALE_LIMITS))
      : drag.mode === 'stretch' ? stretchTo(drag, to)
        : this.#snappedMove(drag, to[0] - drag.from[0], to[1] - drag.from[1], e.altKey);
    if (!transform) return;
    drag.transform = transform;
    this.#showPreview(drag.n, new Map([...drag.quads].map(([key, quad]) => [key, transformQuad(quad, transform)])));
  }

  /**
   * The move a drag makes, pointer delta (ux, uy) in user space, snapped so that the dragged objects'
   * edges or centre line up with another object's or the page's when one is within a few screen
   * pixels — measured as the page is shown, so it follows the page's rotation and the view's. With
   * `free` (Alt held) it is the pointer's move exactly. Only the move changes; drag.guides is what to
   * draw for it.
   */
  #snappedMove(drag, ux, uy, free) {
    drag.guides = null;
    const snap = free ? null : this.#snapContext(drag);
    if (!snap) return translate(ux, uy);
    const [dx, dy] = applyLinear(snap.shown, ux, uy);
    const [x1, y1, x2, y2] = snap.box;
    const result = snapMove([x1 + dx, y1 + dy, x2 + dx, y2 + dy], snap.targets, tolerancePoints(drag.pageView, SNAP_DISTANCE));
    drag.guides = result.guides;
    return result.dx || result.dy ? translate(...applyLinear(snap.back, dx + result.dx, dy + result.dy)) : translate(ux, uy);
  }

  /**
   * What a move drag may snap to, worked out once when it is first needed and kept for the drag: the
   * dragged objects' box and every other visible object's, and the page's own, all in display axes.
   * null when there is nothing to measure against.
   */
  #snapContext(drag) {
    if (drag.snap !== undefined) return drag.snap;
    const page = this.#pages.get(drag.n);
    const shown = displayBasis(drag.pageView);
    const back = invert(shown);
    drag.snap = null;
    if (!page?.data || !back) return null;
    const inShown = (quad) => quadBox(transformQuad(quad, shown));
    const dragged = new Set(drag.keys);
    const targets = this.#liveOf(page).objects
      .filter((o) => !dragged.has(o.ref.key) && !o.reasons?.some((r) => r === 'blank' || r === 'invisible'))
      .map((o) => inShown(this.#shownQuad(page, o.ref.key, o.geometry.quad)))
      .filter(Boolean);
    targets.push(inShown(boxQuad(drag.pageView.viewport.viewBox)));
    const box = unionBox([...drag.quads.values()].map((quad) => transformQuad(quad, shown)));
    if (box) drag.snap = { shown, back, box, targets };
    return drag.snap;
  }

  async #onPointerUp(e) {
    const drag = this.#drag;
    if (!drag) return;
    this.#drag = null;
    const guided = drag.guides?.length && this.#pages.get(drag.n);
    if (guided) this.#draw(guided); // the guides go when the hand lets go
    if (drag.moved) this.#syncArrangeBar();
    if (drag.moved && drag.mode !== 'refused') {
      try {
        this.#view.container.releasePointerCapture(drag.pointerId ?? e.pointerId);
      } catch { /* it was released with the pointer */ }
    }
    if (!drag.moved) {
      this.#clearPreview(); // under the threshold: this was a click, and the click handler has it
      return;
    }
    this.#clickAfterDrag = true;
    if (drag.mode === 'refused') return;
    if (drag.mode === 'marquee') {
      this.#finishMarquee(drag);
      return;
    }
    await this.#write(drag.n, drag.keys.map((key) => ({ key, delta: drag.transform })), drag.verb);
  }

  /** Selects what a selection rectangle enclosed: instead of the selection, or added to it. */
  #finishMarquee(drag) {
    const page = this.#pages.get(drag.n);
    const keys = page && drag.box ? this.#enclosed(page, drag.box) : [];
    const changed = this.#changeSelection((s) => (drag.additive ? s.add(drag.n, keys) : s.set(drag.n, keys)));
    if (!changed && page) this.#draw(page); // the rectangle itself still has to go
    const size = this.#selection.size;
    if (size <= 1) this.#announce(size ? '1 object selected.' : 'Nothing is selected.');
  }

  /** Drops a gesture in progress without writing it. True when there was one. */
  #cancelGesture() {
    const drag = this.#drag;
    if (!drag) return false;
    this.#drag = null;
    this.#clearPreview();
    const page = drag.mode === 'marquee' || drag.guides?.length ? this.#pages.get(drag.n) : null;
    if (page) this.#draw(page);
    this.#syncArrangeBar();
    this.#announce('Cancelled.');
    return true;
  }

  // ---- where a pending gesture puts objects ------------------------------------------------------------
  // The preview is the only coordinate this module keeps between frames, and it is kept for exactly
  // as long as the pages don't yet show the change: #documentChanged clears it when the rebuilt page
  // arrives with the objects in their new places, so nothing ever snaps back and then forward again.

  #showPreview(n, quads) {
    if (!quads.size || [...quads.values()].some((quad) => !quad)) return;
    this.#shownAt = { n, quads };
    const page = this.#pages.get(n);
    if (page) this.#draw(page);
  }

  #clearPreview() {
    if (!this.#shownAt) return;
    const page = this.#pages.get(this.#shownAt.n);
    this.#shownAt = null;
    if (page) this.#draw(page);
  }

  /**
   * Writes one gesture through the engine, which decides whether it may happen at all: `moves` is
   * [{ key, delta }], one for each object the gesture acts on, and they are written together or not
   * at all.
   *
   * A gesture made while the pages are still being rebuilt from the last one waits for them: two
   * gestures in quick succession are perfectly ordinary, and "Vellum is still updating the pages"
   * is an answer for a person who asked twice, not for a person who turned a picture twice.
   */
  async #write(n, moves, verb, { coalesce = null, said = null } = {}) {
    if (!moves.length || moves.some((m) => !m.delta)) return false;
    await this.#settled();
    try {
      const changed = await this.#view.textEditing.transformObjects(n, moves, { verb, coalesce });
      if (changed) this.#announce(said ?? { move: 'Moved.', scale: 'Resized.', stretch: 'Resized.', rotate: 'Turned.' }[verb] ?? 'Changed.');
      else this.#clearPreview();
      return changed;
    } catch (err) {
      this.#clearPreview();
      this.#notify(err instanceof EditError ? err.message : `That change couldn’t be made: ${err.message}`);
      return false;
    }
  }

  /**
   * True when every one of these objects allows `verb`. Otherwise says why, in the words the object
   * model already answered with, and false.
   */
  #allow(objects, verb) {
    const answer = sharedCapability(objects, verb);
    if (answer === true) return true;
    this.#notify(refusalMessage(verb, answer.reason, objects.length));
    return false;
  }

  // ---- the keyboard: nudging, turning, flipping, deleting -------------------------------------------

  /** The keys that act on the selected objects, and nothing else. */
  static #OBJECT_KEYS = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Delete', 'Backspace', '[', ']']);

  /**
   * Handles a key that acts on the selected objects. False when the key means nothing here — which
   * is decided from the key and the selection alone, so that the answer is immediate and the page it
   * acts on can be waited for.
   */
  #onObjectKey(e) {
    const current = this.#selection.current;
    if (!current) return false;
    const flips = e.shiftKey && (e.key === 'H' || e.key === 'V');
    if (!flips && !TextEditor.#OBJECT_KEYS.has(e.key)) return false;
    this.#actOnSelected(current, { key: e.key, shiftKey: e.shiftKey });
    return true;
  }

  /**
   * Does what the key asked to every selected object, once the page they are on has been read. The
   * wait matters: a change rebuilds the document, and a key pressed while the pages are still coming
   * back would otherwise find no objects and do nothing at all. Every object has to allow what is
   * asked, or nothing happens and the reason is said.
   */
  async #actOnSelected({ page, keys }, e) {
    await this.#ensurePage(page);
    const objects = keys.map((key) => this.#liveObject(page, key));
    const current = this.#selection.current;
    if (objects.some((o) => !o) || !this.active || current?.page !== page || !sameKeys(current.keys, keys)) return;

    const arrow = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
    if (arrow) {
      if (!this.#allow(objects, 'move')) return;
      const step = NUDGE_STEP * (e.shiftKey ? 10 : 1);
      const offset = this.#screenStep(page, arrow[0] * step, arrow[1] * step);
      if (offset) this.#nudgeBy(page, keys, translate(offset[0], offset[1]));
      return;
    }
    if (e.key === 'Delete' || e.key === 'Backspace') {
      if (!this.#allow(objects, 'delete')) return;
      await this.#deleteSelected(page, objects);
      return;
    }
    if (e.key === '[' || e.key === ']') {
      if (!this.#allow(objects, 'rotate')) return;
      // PDF user space has y pointing up and the page is drawn with y pointing down, so the turn
      // that looks counter-clockwise on screen is the clockwise one here. Several pictures each turn
      // about their own centre: a selection is several objects, not one shape.
      const turns = e.key === '[' ? -1 : 1;
      await this.#gestureNow(page, objects, (o) => quarterTurn(quadCentre(o.geometry.quad), turns), 'rotate');
      return;
    }
    if (e.shiftKey && (e.key === 'H' || e.key === 'V')) {
      if (!this.#allow(objects, 'rotate')) return;
      // Mirrored in each picture's OWN axes, which is what its current placement says they are:
      // its CTM, with everything already done to it.
      const axis = e.key === 'H' ? 'horizontal' : 'vertical';
      await this.#gestureNow(page, objects, (o) => flip(multiply(o.record.ctm, o.edit?.transform ?? IDENTITY), axis), 'rotate');
    }
  }

  /** One keyboard gesture on these objects, written at once: previewed, then handed to the engine. */
  async #gestureNow(n, objects, deltaOf, verb) {
    const moves = objects.map((o) => ({ key: o.ref.key, delta: deltaOf(o), quad: o.geometry.quad }));
    if (moves.some((m) => !m.delta)) return;
    this.#flushNudge();
    this.#showPreview(n, new Map(moves.map((m) => [m.key, transformQuad(m.quad, m.delta)])));
    await this.#write(n, moves, verb);
  }

  async #deleteSelected(n, objects) {
    this.#flushNudge();
    await this.#settled();
    try {
      await this.#view.textEditing.removeObjects(n, objects.map((o) => o.ref.key));
      this.#select(null); // they aren't there any more, so nothing is selected
      const [only] = objects;
      this.#announce(objects.length > 1 ? `${counted(objects.length, 'object', 'objects')} deleted.` : only.kind === 'text-run' ? 'Text deleted.' : 'Picture deleted.');
    } catch (err) {
      this.#notify(err instanceof EditError ? err.message : `That couldn’t be deleted: ${err.message}`);
    }
  }

  /**
   * A step of `sx`, `sy` POINTS along the SCREEN's own axes, as an offset in the page's user space.
   * The arrow keys mean what they look like — Right moves the object right on screen — whatever the
   * page's own /Rotate, the viewer's rotation, the zoom or an offset crop box, because all four live
   * in the viewport that page-space.js converts through.
   */
  #screenStep(n, sx, sy) {
    const pageView = this.#view.viewer.getPageView(n - 1);
    if (!pageView) return null;
    const px = pageView.viewport.scale; // screen pixels in one point
    const origin = toPdfPoint(pageView, 0, 0);
    const right = toPdfPoint(pageView, px, 0);
    const down = toPdfPoint(pageView, 0, px);
    const offset = [(right[0] - origin[0]) * sx + (down[0] - origin[0]) * sy,
      (right[1] - origin[1]) * sx + (down[1] - origin[1]) * sy];
    return offset.every(Number.isFinite) ? offset : null;
  }

  // ---- an arrow-key burst is one gesture, and so one undo -------------------------------------------
  // Keys arrive one at a time but a burst is one movement, so they share a token and the edit store
  // folds them into a single undo step (annotations/model.js). What is written is still absolute, so
  // the last key of a burst says where the objects ended up and undoing it puts them back at the start.

  #nudgeBy(n, keys, delta) {
    let nudge = this.#nudge;
    if (!nudge || nudge.n !== n || !sameKeys(nudge.keys, keys)) {
      this.#flushNudge();
      const page = this.#pages.get(n);
      const quads = page ? this.#liveOf(page).quads : null;
      const base = new Map(keys.map((key) => [key, quads?.get(key) ?? null]));
      if ([...base.values()].some((quad) => !quad)) return;
      nudge = { n, keys: [...keys], base, token: `nudge:${++nudgeSeq}`, transform: IDENTITY, flush: 0, end: 0 };
    }
    clearTimeout(nudge.flush);
    clearTimeout(nudge.end);
    nudge.transform = multiply(nudge.transform, delta);
    nudge.flush = setTimeout(() => this.#writeNudge(), 170);
    nudge.end = setTimeout(() => this.#flushNudge(), 900);
    this.#nudge = nudge;
    this.#showPreview(n, new Map([...nudge.base].map(([key, quad]) => [key, transformQuad(quad, nudge.transform)])));
  }

  /** Writes what the burst has moved so far and stays in the same burst, so it is still one undo. */
  #writeNudge() {
    const nudge = this.#nudge;
    if (!nudge || isIdentity(nudge.transform)) return;
    const transform = nudge.transform;
    // The preview goes on from where it already is, so a write in the middle of a burst shows nothing.
    for (const [key, quad] of nudge.base) nudge.base.set(key, transformQuad(quad, transform) ?? quad);
    nudge.transform = IDENTITY;
    this.#write(nudge.n, nudge.keys.map((key) => ({ key, delta: transform })), 'move', { coalesce: nudge.token });
  }

  /** Ends a burst, writing whatever it has left. Called before any other change, and on leaving. */
  #flushNudge() {
    const nudge = this.#nudge;
    if (!nudge) return;
    clearTimeout(nudge.flush);
    clearTimeout(nudge.end);
    this.#writeNudge();
    this.#nudge = null;
  }

  #onKey(e) {
    if (!this.active || this.#editor || e.target.closest?.('input, textarea, button')) return;
    if (e.key === 'Tab') {
      e.preventDefault();
      this.#move(e.shiftKey ? -1 : 1);
      return;
    }
    if (e.key === 'Escape') {
      // A gesture under way is cancelled first and nothing is written; then the selection; then,
      // with nothing selected, Escape means what it always meant and AnnotationLayer's handler
      // leaves Edit mode.
      if (this.#cancelGesture()) {
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      if (!this.#selection.current) return;
      e.preventDefault();
      e.stopPropagation();
      this.#flushNudge();
      this.#select(null);
      return;
    }
    // Ctrl+A in Edit mode selects the objects on the page, not the words of the whole document.
    if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.code === 'KeyA') {
      e.preventDefault();
      e.stopPropagation();
      this.#selectAll();
      return;
    }
    // Acting on the selected objects: nudging, turning, flipping, deleting. Never with a modifier
    // that belongs to something else — Ctrl+Z is undo, and stays undo.
    if (!e.ctrlKey && !e.metaKey && !e.altKey && this.#onObjectKey(e)) {
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    if (e.key === 'Enter') {
      // A picture, or several objects: Enter has no one line of text to open, and does nothing.
      const run = this.#selection.size === 1 ? this.#focusRun() : null;
      if (!run) return;
      e.preventDefault();
      this.#open(run.n, run.key);
    }
  }

  /**
   * Selects every object on the page the selection is on — or, with nothing selected, on the page
   * in view — that can be selected at all: what is on show there, where it is now.
   */
  async #selectAll() {
    const n = this.#selection.page ?? this.#view.state.pageNumber;
    const page = await this.#ensurePage(n);
    if (!page?.data || !this.active) return;
    const keys = this.#liveOf(page).objects.map((o) => o.ref.key);
    if (!keys.length) {
      this.#announce('There’s nothing on this page to select.');
      return;
    }
    if (!this.#changeSelection((s) => s.set(n, keys)) || keys.length === 1) this.#announce(`${counted(keys.length, 'object', 'objects')} selected.`);
  }

  /**
   * The selected run Tab and Enter start from: the most recently selected object, when that is text.
   * Tab's itinerary is the editable text it has always been, so everything that walks it speaks in
   * run keys and stops here if the selection is not text.
   */
  #focusRun() {
    const { page, primary } = this.#selection;
    if (!primary?.startsWith('run:')) return null;
    return { n: page, key: primary.slice('run:'.length) };
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
    if (item.run.tagged) this.#warnTagged('text');
  }

  /**
   * Tagged PDFs (an accessibility structure): said once, the first time tagged text is opened, and
   * once each the first time a picture is replaced and the first time one is added.
   */
  async #warnTagged(what) {
    if (this.#warnedTagged.has(what)) return;
    const profile = await this.#view.profile().catch(() => null);
    if (!profile?.tagged || this.#warnedTagged.has(what)) return;
    this.#warnedTagged.add(what);
    this.#notify({
      picture: 'This PDF is tagged for accessibility. Vellum doesn’t update those tags when it replaces a picture, so a description of the old picture may still be read out.',
      inserted: 'This PDF is tagged for accessibility. Vellum doesn’t add a new picture to those tags, so screen readers won’t describe it.',
    }[what] ?? 'This PDF is tagged for accessibility. Vellum doesn’t update those tags when it changes text, so screen readers may not read the changed text correctly.');
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

  /**
   * A run's corners on screen (client pixels): ll, lr, ur, ul — where it is NOW, so the editor and
   * the scroll-into-view both follow text that has been moved or scaled rather than opening over
   * the place the file happens to draw it.
   */
  #screenQuad(n, run) {
    const pageView = this.#view.viewer.getPageView(n - 1);
    const page = this.#pages.get(n);
    if (!pageView?.div) return null;
    const quad = page ? this.#shownQuad(page, runKeyOf(run.key), run.quad) : run.quad;
    return quad ? toClientQuad(pageView, quad) : null;
  }

  /** Sizes, rotates and styles the editor to sit exactly over its text. */
  #layout(ed) {
    const { run } = ed.item;
    const pts = this.#screenQuad(ed.n, run); // where it is now: a scaled run gets a scaled editor
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
    this.#syncArrangeBar();
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
