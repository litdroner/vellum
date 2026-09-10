// Per-document annotation store with undo/redo and "unsaved changes" tracking.
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
  #items = new Map();
  #undo = [];
  #redo = [];
  #savedAt = 0;

  constructor({ author = '' } = {}) {
    super();
    this.author = author;
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

  /** Applies a group of changes as one undo step. */
  apply(changes) {
    if (!changes.length) return;
    this.#write(changes, 'after');
    this.#undo.push({ seq: ++opSeq, changes });
    this.#redo.length = 0;
    this.#emitFor(changes);
  }

  undo() {
    const entry = this.#undo.pop();
    if (!entry) return false;
    this.#write(entry.changes, 'before');
    this.#redo.push(entry);
    this.#emitFor(entry.changes);
    return true;
  }

  redo() {
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
      const value = change[side];
      const id = (change.after ?? change.before).id;
      if (value) this.#items.set(id, value);
      else this.#items.delete(id);
    }
  }

  #emitFor(changes) {
    const pages = new Set();
    for (const c of changes) {
      if (c.before) pages.add(c.before.page);
      if (c.after) pages.add(c.after.page);
    }
    this.#emit(pages);
  }

  #emit(pages) {
    this.dispatchEvent(new CustomEvent('change', { detail: { pages } }));
  }
}
