// A private copy of a Form XObject, made when text inside one occurrence of it is edited.
//
// A Form XObject is one stream that any number of `Do` operators draw: several times on this page,
// on other pages, and inside other forms. Rewriting its content would change every one of them, so
// an edit to text inside ONE occurrence copies the form first:
//
//   1. the form is copied — its dictionary as the file holds it (Type, Subtype, BBox, Matrix, Group
//      and everything else), with a clone of its own /Resources, so the copy can be given fonts and
//      graphics states without touching the resources the original shares;
//   2. the edit is written INSIDE the copy: the old glyphs neutralised in the form's own bytes,
//      where they stand, and the new text drawn after the form's own content — so it keeps the
//      form's BBox clip, its transparency group, and its place in the page's drawing order;
//   3. only the one `Do` that drew this occurrence is repointed at the copy, by name, in the page's
//      own content — a byte patch like any other the page writer splices in.
//
// The original form object is never changed. Every other occurrence of it — elsewhere on this page,
// on any other page, inside any other form — still draws exactly the bytes it drew before.
//
// The text inside the copy is drawn by the same drawText() as every other text edit, from the same
// records. All it needs is the form's own space instead of the page's, and that is one matrix:
// `base`, the inverse of the matrix the occurrence is drawn under, which takes the page-space
// placement drawText computes back into the form. Nothing else about writing text changes here.
//
// Which runs may be edited this way is decided once, from the verified analysis, in editing/runs.js
// (run.formEdit). The structural half of that decision — depth, own resources, a readable and
// balanced stream, no layer, no soft mask, no tagged content — is asked AGAIN here, from the file
// itself, before a byte is written: a writer never trusts an analysis to have asked.

import { EditError } from '../edits.js';
import { invert } from '../matrix.js';
import { pdfName, spliceContent } from '../content/writer.js';
import { addResource } from './text-run.js';

/** Stream dictionary entries that say how the ORIGINAL was stored. A copy stores itself. */
const STREAM_KEYS = new Set(['Length', 'Filter', 'DecodeParms', 'DL', 'F', 'FFilter', 'FDecodeParms', 'Resources']);

/**
 * The private copies one page's text edits need: `of(occurrence)` makes at most one per form
 * occurrence, and `finish()` registers them and gives back the page patches that repoint each
 * occurrence's own `Do`. Nothing is written to the document until finish() is called.
 */
export function formCopies({ lib, doc, page, analysis, index }) {
  return new FormCopies(lib, doc, page, analysis, index);
}

class FormCopies {
  #lib;
  #doc;
  #page;
  #analysis;
  #index;
  #copies = new Map(); // occurrence index → FormCopy

  constructor(lib, doc, page, analysis, index) {
    this.#lib = lib;
    this.#doc = doc;
    this.#page = page;
    this.#analysis = analysis;
    this.#index = index;
  }

  /** How many forms this page's edits have copied. */
  get size() { return this.#copies.size; }

  /**
   * The copy of one form occurrence, made the first time it is asked for: two edits inside the same
   * occurrence share one copy, and two occurrences of the same form get one copy each.
   */
  of(occurrence) {
    const found = this.#copies.get(occurrence);
    if (found) return found;
    const { PDFDict, PDFName, PDFRef, PDFStream } = this.#lib;
    const form = this.#analysis.forms[occurrence] ?? null;
    // Everything runs.js asked of this occurrence that can be asked again without pdf.js.
    if (!form || form.depth !== 1 || form.stream !== 'page' || !form.ownResources || !form.safety?.safe) this.#refuse();
    if (!(form.bytes instanceof Uint8Array) || !Array.isArray(form.ops)) this.#refuse();
    // The `Do` that drew it, still the operator and still the bytes the analysis read it from.
    const op = this.#analysis.ops[form.opIndex];
    if (!op || op.op !== 'Do' || op.start !== form.range[0] || op.end !== form.range[1]) this.#refuse();
    // The form as the file holds it: the very object the page's resources give the name it was
    // drawn by, and no other — a name that now leads somewhere else is not this occurrence's form.
    const ref = xobjectRef(this.#lib, this.#doc, this.#page, form.name);
    if (!(ref instanceof PDFRef) || ref.toString() !== form.key) this.#refuse();
    const stream = this.#doc.context.lookup(ref);
    if (!(stream instanceof PDFStream)) this.#refuse();
    const resources = this.#doc.context.lookup(stream.dict.get(PDFName.of('Resources')));
    if (!(resources instanceof PDFDict)) this.#refuse(); // ownResources, checked against the file
    const base = invert(form.ctm);
    if (!base) this.#refuse();
    const copy = new FormCopy(this.#lib, this.#doc, form, stream, resources, base);
    this.#copies.set(occurrence, copy);
    return copy;
  }

  /**
   * Registers every copy, adds it to the page's resources under a name the page doesn't use, and
   * gives back one patch per copy: the occurrence's own `Do`, drawing the copy instead. Any other
   * `Do` of the same form, on this page or any other, is left exactly as it was.
   */
  finish() {
    const ctx = this.#doc.context;
    const patches = [];
    for (const copy of this.#copies.values()) {
      const ref = ctx.register(copy.stream(ctx));
      const name = addResource(this.#lib, this.#doc, this.#page, 'XObject', 'VlX', ref);
      patches.push({ start: copy.form.range[0], end: copy.form.range[1], text: `${pdfName(name)} Do` });
    }
    return patches;
  }

  #refuse() {
    throw new EditError('changed', `The graphic text on page ${this.#index + 1} is drawn by isn’t in the file as expected any more, so nothing was changed.`);
  }
}

/**
 * One copy: where the edit's patches and drawing go, and the resources they may name. It is also the
 * resource holder addResource writes to (objects/text-run.js), so a substitute font or an opacity
 * needed by text inside a form is added to the COPY's resources and not to the page's.
 */
class FormCopy {
  #lib;
  #doc;
  #original;
  #resources;

  constructor(lib, doc, form, original, resources, base) {
    this.#lib = lib;
    this.#doc = doc;
    this.#original = original;
    this.#resources = resources.clone(doc.context);
    /** The occurrence being copied (editing/content/interpreter.js). */
    this.form = form;
    /** Page user space back into the form's own: what drawText's placement is multiplied by. */
    this.base = base;
    /** Byte patches into the FORM's own content, never the page's. */
    this.patches = [];
    /** What is drawn after the form's own content, inside the copy. */
    this.append = [];
  }

  /** addResource's resource holder: the copy's own /Resources, read and replaced. */
  resources() { return this.#resources; }

  setResources(dict) { this.#resources = dict; }

  /**
   * Does the form itself hold this resource? A page can set a font, an ExtGState or a colour space
   * BEFORE the `Do`, and the form's content inherits it — but a copy of the form reads only the
   * form's own /Resources, so a name that was never there can't be redrawn (see text-run.js).
   */
  has(category, name) {
    const { PDFDict, PDFName } = this.#lib;
    const group = this.#doc.context.lookup(this.#resources.get(PDFName.of(category)));
    return group instanceof PDFDict && group.get(PDFName.of(name)) !== undefined;
  }

  /**
   * The copy as a stream object: the edited content, the original's dictionary entries, and its own
   * resources. The original stream is only read.
   */
  stream(ctx) {
    const { PDFName, PDFRef } = this.#lib;
    // The form's own content, wrapped in q … Q, with the edit spliced in and drawn after it — the
    // page writer's own assembly (content/writer.js). The form's stream is balanced and leaves
    // nothing open, which is what safetyOf()'s 'structure' blocker guarantees.
    const made = ctx.flateStream(spliceContent(this.form.bytes, this.patches, this.append));
    for (const [name, value] of this.#original.dict.entries()) {
      if (STREAM_KEYS.has(name.decodeText())) continue;
      made.dict.set(name, value instanceof PDFRef ? value : value.clone(ctx));
    }
    made.dict.set(PDFName.of('Resources'), this.#resources);
    return made;
  }
}

/** What a page's resources give /XObject `name`, as the file holds it (a reference, or nothing). */
function xobjectRef(lib, doc, page, name) {
  const { PDFDict, PDFName } = lib;
  const resources = page.node.Resources();
  const xobjects = resources ? doc.context.lookup(resources.get(PDFName.of('XObject'))) : null;
  return xobjects instanceof PDFDict ? xobjects.get(PDFName.of(name)) ?? null : null;
}
