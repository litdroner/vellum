// What is selected on a page, and what may be selected at all.
//
// The state is identity and nothing else:
//
//   { page, key }     page as it is displayed (1-based); key the object model's ref.key
//
// No quad, box, frame, coordinate, analysis or object is kept here. Geometry is resolved from the
// current analysis every time it is wanted, so a selection can never draw an outline from a page
// that has since been rewritten: after a rebuild these two fields either find the object again or
// find nothing at all, and there is no third case where they find something stale.
//
// The model is read-only throughout. Selecting changes nothing about a page; it only remembers
// which object a later phase would act on.

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

/**
 * The selected object of one document: its identity, and a `change` event when that moves.
 *
 * Nothing else lives here. `resolve()` is given the analysis of the page it is asked about, which
 * is what keeps this module clear of the viewer, of pdf.js and of any page cache of its own.
 */
export class ObjectSelection extends EventTarget {
  #current = null;

  /** The selection as plain identity — a frozen { page, key } — or null. */
  get current() { return this.#current; }

  get page() { return this.#current?.page ?? null; }

  get key() { return this.#current?.key ?? null; }

  /** Is exactly this selected? */
  has(page, key) { return this.#current !== null && this.#current.page === page && this.#current.key === key; }

  /**
   * Selects one object by identity, and reports whether that changed anything. Only the two fields
   * are kept, and selecting what is already selected fires nothing.
   */
  select(page, key) {
    if (page == null || !key) return this.clear();
    if (this.has(page, key)) return false;
    this.#current = Object.freeze({ page, key });
    this.dispatchEvent(new Event('change'));
    return true;
  }

  clear() {
    if (!this.#current) return false;
    this.#current = null;
    this.dispatchEvent(new Event('change'));
    return true;
  }

  /**
   * The selected object as it is now, read out of the analysis given — or null when this page isn't
   * the selected one, or the object is no longer there to be selected.
   */
  resolve(analysis) {
    if (!this.#current || !analysis) return null;
    const object = objectByKey(analysis, this.#current.key);
    return object && isSelectable(object, analysis) ? object : null;
  }

  /** Drops the selection when its object is no longer on its page (after a rebuild). */
  reconcile(analysis) {
    if (this.#current && !this.resolve(analysis)) this.clear();
  }
}
