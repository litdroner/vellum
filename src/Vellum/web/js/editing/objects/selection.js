// What is selected on a page, and what may be selected at all.
//
// The state is identity and nothing else:
//
//   { page, keys }    page as it is displayed (1-based); keys the object model's ref.keys, in the
//                     order they were selected — the last is the one most recently chosen
//
// One page at a time: a selection spans the objects of a single page, and choosing something on
// another page starts a new selection there. A gesture on several objects is one change to one
// page's content, so that is what a selection can name.
//
// No quad, box, frame, coordinate, analysis or object is kept here. Geometry is resolved from the
// current analysis every time it is wanted, so a selection can never draw an outline from a page
// that has since been rewritten: after a rebuild each key either finds its object again or finds
// nothing at all, and there is no third case where it finds something stale.
//
// The model is read-only throughout. Selecting changes nothing about a page; it only remembers
// which objects a gesture would act on.

import { objectsOf, objectByKey } from './page-objects.js';

/** The kinds the object model gives an oriented outline, and so the only ones worth pointing at. */
const SELECTABLE_KINDS = new Set(['text-run', 'image']);

/** Text that is on the page but not on show: there is nothing there for a person to click. */
const UNSHOWN = ['blank', 'invisible', 'clip-mode'];

/** Is any of a run's text drawn inside a layer that is currently switched off? */
const onHiddenLayer = (run, analysis) => run.shows.some((si) => analysis.shows[si]?.oc?.hidden);

/**
 * May this object be selected? It has to be something a person can see and point at:
 *
 *  - a text run or an image. A painted path or a form XObject has no oriented outline, only a
 *    bounding box, and hit-testing a diagonal hairline by its box would select it across half the
 *    page — so neither is offered, and neither can be acted on anyway.
 *  - not on a layer that is switched off: pdf.js doesn't draw that content, so there is nothing
 *    under the pointer to select.
 *  - not the invisible text layer of a scanned page, text used only as a clipping shape, or white
 *    space.
 *
 * The reasons come from the set classify() has already filled in (editing/runs.js). Nothing here
 * decides afresh what the engine has decided once, and no new reason vocabulary is introduced.
 */
export function isSelectable(object, analysis) {
  if (!object || !SELECTABLE_KINDS.has(object.kind)) return false;
  if (!object.geometry?.quad) return false;
  if (object.kind === 'image') return !object.record?.oc?.hidden;
  if (UNSHOWN.some((reason) => object.record.reasons.has(reason))) return false;
  return !(analysis && onHiddenLayer(object.record, analysis));
}

/** A page's selectable objects, in drawing order. */
export const selectableObjects = (analysis) => objectsOf(analysis).filter((o) => isSelectable(o, analysis));

/** Keys as a selection keeps them: strings only, each once, in the order given. */
const distinct = (keys) => [...new Set((keys ?? []).filter((key) => typeof key === 'string' && key))];

/**
 * The selected objects of one document: their identity, and a `change` event when that moves.
 *
 * Nothing else lives here. `resolve()` is given the analysis of the page it is asked about, which
 * is what keeps this module clear of the viewer, of pdf.js and of any page cache of its own.
 */
export class ObjectSelection extends EventTarget {
  #current = null;

  /** The selection as plain identity — a frozen { page, keys } — or null when nothing is selected. */
  get current() { return this.#current; }

  get page() { return this.#current?.page ?? null; }

  /** The selected keys, in the order they were selected (frozen; empty when nothing is). */
  get keys() { return this.#current?.keys ?? Object.freeze([]); }

  /** How many objects are selected. */
  get size() { return this.#current?.keys.length ?? 0; }

  /** The object chosen most recently — the one a keyboard action about a single object starts from. */
  get primary() { return this.#current?.keys.at(-1) ?? null; }

  /** Is this object one of the selected ones? */
  has(page, key) { return this.#current !== null && this.#current.page === page && this.#current.keys.includes(key); }

  /**
   * Selects exactly one object by identity, and reports whether that changed anything. An
   * incomplete identity — no page or no key — clears rather than selecting something half-known.
   */
  select(page, key) {
    return this.set(page, key ? [key] : []);
  }

  /**
   * Selects exactly these objects on one page, in this order. Nothing, or no page, clears. Selecting
   * what is already selected, in the same order, fires nothing.
   */
  set(page, keys) {
    const list = distinct(keys);
    if (page == null || !list.length) return this.clear();
    if (this.#current?.page === page && sameList(this.#current.keys, list)) return false;
    this.#current = Object.freeze({ page, keys: Object.freeze(list) });
    this.dispatchEvent(new Event('change'));
    return true;
  }

  /**
   * Adds these objects to the selection, after what is already there. On a different page the
   * selection starts over with them: a selection is always of one page.
   */
  add(page, keys) {
    if (page == null) return false;
    const current = this.#current?.page === page ? this.#current.keys : [];
    return this.set(page, [...current, ...distinct(keys).filter((key) => !current.includes(key))]);
  }

  /**
   * Adds one object, or takes it out when it is already selected — what a Shift- or Ctrl-click
   * does. Taking out the last one leaves nothing selected; on another page it starts over.
   */
  toggle(page, key) {
    if (page == null || !key) return false;
    if (this.has(page, key)) return this.set(page, this.#current.keys.filter((k) => k !== key));
    return this.add(page, [key]);
  }

  clear() {
    if (!this.#current) return false;
    this.#current = null;
    this.dispatchEvent(new Event('change'));
    return true;
  }

  /** Keeps only the selected keys `keep(key)` accepts; one `change` when any go. */
  retain(keep) {
    if (!this.#current) return false;
    const kept = this.#current.keys.filter((key) => keep(key));
    return kept.length === this.#current.keys.length ? false : this.set(this.#current.page, kept);
  }

  /**
   * The selected objects as they are now, read out of the analysis given, in selection order —
   * only those still there to be selected. Empty when nothing is selected or there is no analysis.
   * The analysis must be of the selected page: that is the caller's to know, not this module's.
   */
  resolve(analysis) {
    if (!this.#current || !analysis) return [];
    const objects = [];
    for (const key of this.#current.keys) {
      const object = objectByKey(analysis, key);
      if (object && isSelectable(object, analysis)) objects.push(object);
    }
    return objects;
  }

  /** Drops the selected objects that are no longer on their page (after a rebuild). */
  reconcile(analysis) {
    if (!this.#current) return false;
    if (!analysis) return this.clear();
    const present = new Set(this.resolve(analysis).map((o) => o.ref.key));
    return this.retain((key) => present.has(key));
  }
}

const sameList = (a, b) => a.length === b.length && a.every((key, i) => key === b[i]);
