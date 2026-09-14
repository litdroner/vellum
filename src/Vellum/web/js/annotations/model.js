// Per-document edit store with undo/redo and "unsaved changes" tracking. It holds the annotations,
// the page plan (see pages/plan.js) and content edits such as changed text (see editing/edits.js),
// so one Ctrl+Z undoes any kind of edit.
//
// An annotation is plain data. Geometry is in PDF user space (points, y pointing up), so it's
// independent of zoom and rotation and can be written straight into the file.
//   { id, type: 'highlight' | 'underline' | 'ink' | 'note', page, color,
//     quads?: [[ulx,uly, urx,ury, llx,lly, lrx,lry], ...]   highlight / underline
//     paths?: [[x,y, x,y, ...], ...], width?                ink
//     point?: [x, y]                                        note (icon's top-left corner)
//     contents, author, created, modified }

export const PALETTES = {
  highlight: ['#ffd84d', '#a3eab9', '#9ad7f2', '#ffb38f', '#f5a8d4'],
  pen: ['#e5484d', '#2f6fd6', '#1f9e6b', '#231f1b', '#f0892b'],
};
PALETTES.underline = PALETTES.pen;
PALETTES.ink = PALETTES.pen;
PALETTES.note = PALETTES.highlight;

let idCounter = 0;
export function newId() {
  return `${Date.now().toString(36)}-${(idCounter++).toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

let opSeq = 0;

export class AnnotationStore extends EventTarget {
  /**
   * Optional check before any change is applied: returns true to apply it now, or false / a promise.
   * With a promise the change — and any made meanwhile, in order — waits, and is applied if it
   * resolves true or dropped if not. DocumentView uses it to confirm the first change to a signed PDF.
   */
  guard = null;

  #items = new Map();
  #edits = new Map();
  #plan = null;
  #undo = [];
  #redo = [];
  #savedAt = 0;
  #held = null;

  constructor({ author = '' } = {}) {
    super();
    this.author = author;
  }

  /** The current page plan (null until the document has loaded). */
  get plan() { return this.#plan; }

  /** Sets the starting page plan. Not undoable, not dirty. */
  initPlan(plan) { this.#plan = plan; }

  /** Changes the page plan, plus the annotation changes that go with it, as one undo step. */
  applyPlan(plan, changes = []) {
    this.apply([{ plan: { before: this.#plan, after: plan } }, ...changes]);
  }

  /** Content edits (changed text), in the order they were first made. */
  get edits() { return [...this.#edits.values()]; }

  /**
   * Adds (before = null), replaces (same id) or removes (after = null) a content edit: one undo step.
   *
   * `coalesce` is a token that joins this change to the one before it when both carry the same
   * token — the arrow-key nudges of one burst, which are one gesture and so must be one undo. It
   * folds the two into a single entry that still goes back to where the burst started; it never
   * makes a new kind of history, and any other change (a different token, or none) ends the run.
   */
  applyEdit(before, after, coalesce = null) {
    this.applyEdits([[before, after]], coalesce);
  }

  /**
   * Several content edits as ONE undo step: `pairs` is [[before, after], ...], each as applyEdit
   * takes it. A gesture on several selected objects is one gesture, so it is written, undone and
   * redone together — never half of it. `coalesce` joins it to the previous step exactly as above.
   */
  applyEdits(pairs, coalesce = null) {
    this.apply(pairs.map(([before, after]) => ({ edit: { before, after } })), coalesce);
  }

  get all() { return [...this.#items.values()]; }
  get size() { return this.#items.size; }
  get canUndo() { return this.#undo.length > 0; }
  get canRedo() { return this.#redo.length > 0; }
  /** True when the annotations differ from what's in the file. Undoing back to the saved state clears it. */
  get dirty() { return (this.#undo.at(-1)?.seq ?? 0) !== this.#savedAt; }

  get(id) { return this.#items.get(id) ?? null; }

  forPage(page) {
    const out = [];
    for (const a of this.#items.values()) if (a.page === page) out.push(a);
    return out;
  }

  /** Replaces everything (e.g. annotations read from the file). Not undoable, not dirty. */
  load(list) {
    this.#items.clear();
    this.#edits.clear();
    for (const a of list) this.#items.set(a.id, a);
    this.#undo = [];
    this.#redo = [];
    this.#savedAt = 0;
    this.#emit(new Set(list.map((a) => a.page)));
  }

  /** A new annotation with id, author and timestamps filled in (not yet added). */
  create(fields) {
    const now = new Date().toISOString();
    return { id: newId(), contents: '', author: this.author, created: now, modified: now, ...fields };
  }

  add(...annotations) {
    this.apply(annotations.map((a) => ({ before: null, after: a })));
  }

  update(id, patch) {
    const before = this.get(id);
    if (!before) return;
    this.apply([{ before, after: { ...before, ...patch, modified: new Date().toISOString() } }]);
  }

  remove(id) {
    const before = this.get(id);
    if (before) this.apply([{ before, after: null }]);
  }

  /** True while changes wait for the guard. */
  get pending() { return this.#held !== null; }

  /** Applies a group of changes as one undo step (after the guard, if there is one). */
  apply(changes, coalesce = null) {
    if (!changes.length) return;
    if (this.#held) {
      this.#held.push([changes, coalesce]);
      return;
    }
    const verdict = this.guard ? this.guard(changes) : true;
    if (verdict === true) {
      this.#commit(changes, coalesce);
      return;
    }
    this.#held = [[changes, coalesce]];
    Promise.resolve(verdict).catch(() => false).then((ok) => {
      const held = this.#held ?? [];
      this.#held = null;
      if (ok === true) for (const [group, token] of held) this.#commit(group, token);
      else this.#emit(new Set()); // nothing changed, but views may show that nothing is waiting any more
    });
  }

  #commit(changes, coalesce = null) {
    this.#write(changes, 'after');
    const last = this.#undo.at(-1);
    if (coalesce && last?.coalesce === coalesce && last.changes.every((c) => c.edit) && changes.every((c) => c.edit)) {
      // The same gesture, continued: one entry, still holding what the gesture started from. The
      // sequence number moves on so that "unsaved changes" still notices the file has changed. A
      // gesture that has come back to exactly where it started leaves no step behind at all.
      last.changes = foldEdits(last.changes, changes);
      if (last.changes.length) last.seq = ++opSeq;
      else this.#undo.pop();
    } else {
      this.#undo.push({ seq: ++opSeq, changes, coalesce });
    }
    this.#redo.length = 0;
    this.#emitFor(changes);
  }

  undo() {
    if (this.#held) return false; // changes are waiting to be confirmed
    const entry = this.#undo.pop();
    if (!entry) return false;
    this.#write(entry.changes, 'before');
    this.#redo.push(entry);
    this.#emitFor(entry.changes);
    return true;
  }

  redo() {
    if (this.#held) return false;
    const entry = this.#redo.pop();
    if (!entry) return false;
    this.#write(entry.changes, 'after');
    this.#undo.push(entry);
    this.#emitFor(entry.changes);
    return true;
  }

  markSaved() {
    this.#savedAt = this.#undo.at(-1)?.seq ?? 0;
    this.#emit(new Set());
  }

  #write(changes, side) {
    for (const change of changes) {
      if (change.plan) {
        this.#plan = change.plan[side];
        continue;
      }
      if (change.edit) {
        const value = change.edit[side];
        const id = (change.edit.after ?? change.edit.before).id;
        if (value) this.#edits.set(id, value);
        else this.#edits.delete(id);
        continue;
      }
      const value = change[side];
      const id = (change.after ?? change.before).id;
      if (value) this.#items.set(id, value);
      else this.#items.delete(id);
    }
  }

  #emitFor(changes) {
    const pages = new Set();
    let plan = false;
    let edits = false;
    for (const c of changes) {
      if (c.plan) plan = true;
      if (c.edit) edits = true;
      if (c.before) pages.add(c.before.page);
      if (c.after) pages.add(c.after.page);
    }
    this.#emit(pages, plan, edits);
  }

  /**
   * detail.plan: the page list itself changed; detail.edits: page content changed. Either way the
   * document must be rebuilt.
   */
  #emit(pages, plan = false, edits = false) {
    this.dispatchEvent(new CustomEvent('change', { detail: { pages, plan, edits } }));
  }
}

/**
 * Two steps of one gesture as one: for each record, what it was before the first step and what it
 * is after the second. Folded by record id, never by position, because a step can end one record
 * and start another — a nudge that brings an object back to where the file has it removes its
 * record, and the next nudge makes a new one with a new id — and each must be undone as itself.
 * A record that ends the gesture exactly as it began it has nothing left to undo, and is dropped.
 */
function foldEdits(earlier, later) {
  const byId = new Map();
  for (const { edit } of [...earlier, ...later]) {
    const record = edit.after ?? edit.before;
    if (!record) continue;
    const seen = byId.get(record.id);
    if (seen) seen.after = edit.after;
    else byId.set(record.id, { before: edit.before, after: edit.after });
  }
  const folded = [];
  for (const edit of byId.values()) {
    if (!edit.before && !edit.after) continue;
    if (edit.before && edit.after && JSON.stringify(edit.before) === JSON.stringify(edit.after)) continue;
    folded.push({ edit });
  }
  return folded;
}
