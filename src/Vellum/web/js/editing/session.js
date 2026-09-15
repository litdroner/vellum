// Content editing for one open document: finds the editable text and the selectable objects on a
// page (from the page's ORIGINAL content, confirmed against what pdf.js drew) and turns a change
// into an edit record in the document's edit store — one undo step — after which the document view
// rebuilds to show it. No UI here (see ui/text-editor.js).
//
// Everything is read from the original page, never from what a save produced: that is what lets one
// { page, key } keep naming the same object across any number of edits, and it is why a record's
// transform is ABSOLUTE. Where an object is NOW is its own quad plus its record's transform, which
// is the caller's to work out (objects/geometry.js transformQuad) and never something kept here.

import { openSource } from './source.js';
import { analyzePage, verifyPage } from './runs.js';
import { planTextEdit, planTextTransform, EditError } from './edits.js';
import { selectableObjects } from './objects/selection.js';
import { refusalMessage } from './objects/capabilities.js';
import { planImageEdit, readPicture } from './objects/image.js';
import { IDENTITY, multiply } from './matrix.js';
import { isIdentity, isValid, quantize } from './objects/transform.js';
import { loadPdfLib } from '../annotations/persist.js';
import { newId } from '../annotations/model.js';

export class TextEditing {
  #view;
  #sources = new Map(); // src → Promise<PdfSource>
  #pages = new Map(); // `${src}:${index}` → verified analysis

  constructor(view) {
    this.#view = view;
  }

  /** Why this document's text can't be edited at all, or null. */
  get unavailableReason() {
    const view = this.#view;
    if (view.status !== 'ready') return 'The document isn’t ready yet.';
    if (view.encrypted) {
      return 'This PDF is protected (encrypted). Vellum opens it with the right password but can’t rewrite it, so its text can’t be edited.';
    }
    return null;
  }

  /**
   * The text of a page: { entry, kind, runs: [{ run, edit, text }] } where `text` is what the run
   * reads now (its edit's text, if it has one) and `run.editable` / `run.reasons` say whether it
   * can be changed. `kind` is the page summary (text, scanned, scanned-ocr, no-text, unreadable).
   */
  async page(pageNumber) {
    const reason = this.unavailableReason;
    if (reason) throw new EditError('document', reason);
    const entry = this.#view.shownPlan?.[pageNumber - 1];
    if (!entry) throw new EditError('missing', 'That page isn’t in the document.');
    if (entry.src === 'blank') return { entry, kind: 'no-text', runs: [] };
    const analysis = await this.#analysis(entry, pageNumber);
    const edits = new Map(this.#view.annotations.edits.filter((e) => e.entry === entry.id).map((e) => [e.target.key, e]));
    return {
      entry,
      kind: analysis.summary.kind,
      runs: analysis.runs.map((run) => {
        const edit = edits.get(run.key) ?? null;
        return { run, edit, text: edit ? edit.text : run.text };
      }),
    };
  }

  /**
   * The objects on a page that can be selected: { entry, kind, objects, analysis }, in drawing
   * order. Read-only throughout — the object model derives this from the analysis and changes
   * nothing — and it is the same verified analysis the text uses, because a page is analyzed once
   * and not once per feature.
   *
   * `analysis` comes back so a caller can resolve a selection's geometry against the page as it is
   * now; it is meant to be used and dropped, never stored.
   */
  async objects(pageNumber) {
    const reason = this.unavailableReason;
    if (reason) throw new EditError('document', reason);
    const entry = this.#view.shownPlan?.[pageNumber - 1];
    if (!entry) throw new EditError('missing', 'That page isn’t in the document.');
    if (entry.src === 'blank') return { entry, kind: 'no-text', objects: [], analysis: null };
    const analysis = await this.#analysis(entry, pageNumber);
    return {
      entry,
      kind: analysis.summary.kind,
      objects: selectableObjects(analysis),
      analysis,
      records: this.#recordsOf(entry),
    };
  }

  /**
   * This page's content edits, by the object-model key of what each one changes: `run:<key>` for
   * text and `image:<stream>#<opIndex>` for a picture. One object has at most one record — that is
   * what makes a second drag replace the first rather than pile up — so this is a plain map.
   */
  #recordsOf(entry) {
    const records = new Map();
    for (const e of this.#view.annotations.edits) {
      if (e.entry !== entry.id) continue;
      if (e.kind === 'text') records.set(`run:${e.target.key}`, e);
      else if (e.kind === 'image') records.set(e.target.key, e);
    }
    return records;
  }

  /**
   * Changes the text of a run (identified by its key) to `text`: one undo step. Returns false when
   * nothing changed. Throws EditError when it can't be done safely (the message says why).
   */
  async edit(pageNumber, runKey, text) {
    const view = this.#view;
    if (view.rebuilding) throw new EditError('busy', 'Vellum is still updating the pages. Try again in a moment.');
    const { entry, runs } = await this.page(pageNumber);
    const item = runs.find((r) => r.run.key === runKey);
    if (!item) throw new EditError('missing', 'That text isn’t on this page any more.');
    const next = text.replace(/[\r\n\t\f\v]+/g, ' ').normalize('NFC');
    const store = view.annotations;
    if (next === item.text) return false;
    if (next === item.run.text) {
      // Back to exactly what the file says: the edit simply goes away. A placement isn’t about
      // the text, though, so a run that has also been moved keeps its one record — holding the
      // file’s own glyphs again, which is what it would have had if it had only ever been moved.
      if (!item.edit) return false;
      const placed = item.edit.transform
        ? planTextTransform({ run: item.run, transform: item.edit.transform, entry: entry.id, id: item.edit.id })
        : null;
      store.applyEdit(item.edit, placed);
      return true;
    }
    const source = await this.#source(entry.src);
    // The run's placement is carried through: retyping text that has been moved must not move it
    // back, and must not become a second record either.
    const record = planTextEdit({
      run: item.run, text: next, entry: entry.id, glyphs: source.glyphs,
      id: item.edit?.id, transform: item.edit?.transform ?? null, ...(await this.#constraints()),
    });
    store.applyEdit(item.edit, record);
    return true;
  }

  // ---- moving, scaling, turning, flipping and deleting objects ----------------------------------
  //
  // Both kinds go through here, one object or several selected together, and every object keeps
  // exactly one record. A gesture is given as DELTAS — "what this drag just did" to each object —
  // because that is what an interaction knows; each record keeps the ABSOLUTE transform, in the
  // ORIGINAL page's user space, which is what the writers need and what makes a second gesture
  // replace the first instead of stacking another record.
  //
  // A gesture on several objects is all or nothing. Every object is found, asked and planned before
  // anything is stored, so one refusal — or one object that has gone — changes nothing at all; and
  // the records then go into the edit store together, as ONE undo step.

  /**
   * The objects with these keys on one page, each with its record, and the page entry they belong
   * to. An object whose record has already removed it is not on the page any more, however much the
   * original content still holds it, and nothing may be done to it: moving a deleted picture must
   * not put it back.
   */
  async #objectsAt(pageNumber, keys) {
    const view = this.#view;
    if (view.rebuilding) throw new EditError('busy', 'Vellum is still updating the pages. Try again in a moment.');
    if (!keys.length) throw new EditError('missing', 'Nothing is selected.');
    if (new Set(keys).size !== keys.length) throw new EditError('changed', 'One object was asked for twice, so nothing was changed.');
    const { entry, objects, records } = await this.objects(pageNumber);
    const byKey = new Map(objects.map((o) => [o.ref.key, o]));
    const found = keys.map((key) => {
      const object = byKey.get(key) ?? null;
      const record = records.get(key) ?? null;
      if (!object || isRemoved(record)) {
        throw new EditError('missing', keys.length > 1 ? 'One of the selected objects isn’t on this page any more, so nothing was changed.' : 'That object isn’t on this page any more.');
      }
      return { object, record };
    });
    return { entry, found };
  }

  /** Refuses a verb in the words the capability already answered with — for a group, saying so. */
  #refuse(object, verb, count = 1) {
    const reason = object.capabilities[verb];
    if (reason === true) return;
    throw new EditError('not-editable', refusalMessage(verb, reason, count), { reason, key: object.ref.key });
  }

  /**
   * Applies `delta` — a page-space transform — to where an object is NOW: one undo step, one
   * record, an absolute transform inside it. Returns false when nothing changed. The one-object
   * form of transformObjects(), which says everything else.
   */
  transformObject(pageNumber, key, delta, options = {}) {
    return this.transformObjects(pageNumber, [{ key, delta }], options);
  }

  /**
   * Applies a delta to each of several objects on one page — `moves` is [{ key, delta }] — as ONE
   * undo step. Returns false when nothing changed.
   *
   * `verb` is the capability the gesture claims ('move', 'scale' or 'rotate'), and every object has
   * to allow it: a refusal is the one the object already published rather than a second opinion.
   * `coalesce`, when given, joins this change to the previous one carrying the same token — an
   * arrow-key burst is one gesture and so one undo (annotations/model.js).
   *
   * A delta that puts an object back exactly where the file has it removes that object's record
   * altogether, so "move it and move it back" leaves the document as it found it.
   */
  async transformObjects(pageNumber, moves, { verb = 'move', coalesce = null } = {}) {
    const view = this.#view;
    if (moves.some((m) => !isValid(m?.delta))) throw new EditError('content', 'That change couldn’t be worked out, so nothing was changed.');
    const { entry, found } = await this.#objectsAt(pageNumber, moves.map((m) => m.key));
    for (const { object } of found) this.#refuse(object, verb, found.length);
    const pairs = [];
    found.forEach(({ object, record }, i) => {
      const absolute = quantize(multiply(record?.transform ?? IDENTITY, moves[i].delta));
      if (!absolute) throw new EditError('content', 'That change couldn’t be worked out, so nothing was changed.');
      if (record ? sameAs(record.transform, absolute) : isIdentity(absolute)) return;
      pairs.push([record, this.#plan(entry, object, record, absolute)]);
    });
    if (!pairs.length) return false;
    view.annotations.applyEdits(pairs, coalesce);
    return true;
  }

  /** Deletes one object: text loses its glyphs, a picture loses its draw. One undo step. */
  removeObject(pageNumber, key) {
    return this.removeObjects(pageNumber, [key]);
  }

  /** Deletes several objects on one page as ONE undo step — all of them, or none if any refuses. */
  async removeObjects(pageNumber, keys) {
    const view = this.#view;
    const entry = view.shownPlan?.[pageNumber - 1];
    // What planning needs is read first, so nothing is awaited between reading the records and
    // storing what replaces them.
    const glyphs = entry && entry.src !== 'blank' ? (await this.#source(entry.src)).glyphs : null;
    const constraints = await this.#constraints();
    const { entry: current, found } = await this.#objectsAt(pageNumber, keys);
    for (const { object } of found) this.#refuse(object, 'delete', found.length);
    const pairs = found.map(({ object, record }) => [record, object.kind === 'text-run'
      // Empty text has always been how text is removed (encoding.mode 'none'); a placement stays
      // on the record because it is not about the text, exactly as retyping keeps it.
      ? planTextEdit({
        run: object.record, text: '', entry: current.id, glyphs,
        id: record?.id, transform: record?.transform ?? null, ...constraints,
      })
      : planImageEdit({ object, removed: true, entry: current.id, id: record?.id })]);
    view.annotations.applyEdits(pairs);
    return true;
  }

  /**
   * Replaces a picture's image with one from a file (`bytes`, PNG or JPEG), in exactly the frame it
   * has now — placed, sized, turned and mirrored as it is, and still where it was in the drawing
   * order. One undo step, and the picture's one record: a moved picture stays where it was moved to,
   * and a replaced picture replaced again holds only the latest image.
   *
   * The bytes are kept in the document's sources (where pages inserted from other PDFs keep theirs)
   * for as long as the document is open, so undo, redo and every later save can still reach them.
   * Throws EditError when it can't be done: an unusable file, a picture that can't be replaced, a
   * PDF/A document.
   */
  async replaceImage(pageNumber, key, bytes) {
    const view = this.#view;
    const lib = await loadPdfLib();
    const picture = await readPicture(lib, bytes);
    if ((await this.#constraints()).embeddedFontsOnly) {
      throw new EditError('pdfa', 'This PDF follows the PDF/A archiving standard, and Vellum can’t check that a new picture meets it, so the picture wasn’t replaced.');
    }
    const { entry, found: [{ object, record }] } = await this.#objectsAt(pageNumber, [key]);
    this.#refuse(object, 'replace'); // never true for text, which is not a picture
    const source = newId();
    const next = planImageEdit({
      object, transform: record?.transform ?? null, replacement: { source, ...picture }, entry: entry.id, id: record?.id,
    });
    view.sources.set(source, bytes);
    view.annotations.applyEdits([[record, next]]);
    return true;
  }

  /**
   * The record for one absolute placement — or null when there is nothing left to say, which is
   * what "back where it started" means. Text that was only ever moved has no record without its
   * transform; text that was retyped keeps its own record, untransformed. A replaced picture keeps
   * its replacement wherever it is put, and so keeps its record even back where it started.
   */
  #plan(entry, object, record, absolute) {
    if (object.kind !== 'text-run') {
      const replacement = record?.removed ? null : record?.replacement ?? null;
      if (isIdentity(absolute) && !replacement) return null;
      return planImageEdit({ object, transform: absolute, replacement, entry: entry.id, id: record?.id });
    }
    const next = planTextTransform({
      run: record ? null : object.record, record, transform: absolute, entry: entry.id, id: record?.id,
    });
    return !next.transform && next.encoding?.mode === 'original' ? null : next;
  }

  /** What the whole document requires of an edit (PDF/A: embedded fonts only). */
  async #constraints() {
    const profile = await this.#view.profile().catch(() => null);
    return { embeddedFontsOnly: Boolean(profile?.pdfa) };
  }

  /**
   * What committing `text` would do, without doing it: { ok, mode: 'font' | 'standard' | 'none',
   * font, missing } or { ok: false, message } — so the editor can say so while you type.
   */
  async preview(pageNumber, runKey, text) {
    const { entry, runs } = await this.page(pageNumber);
    const item = runs.find((r) => r.run.key === runKey);
    if (!item) return { ok: false, message: 'That text isn’t on this page any more.' };
    const source = await this.#source(entry.src);
    const constraints = await this.#constraints();
    try {
      const record = planTextEdit({ run: item.run, text, entry: entry.id, glyphs: source.glyphs, ...constraints });
      return { ok: true, mode: record.encoding.mode, font: record.encoding.font ?? null, missing: record.encoding.missing ?? [] };
    } catch (err) {
      if (err instanceof EditError) return { ok: false, kind: err.kind, message: err.message };
      throw err;
    }
  }

  /** True when the file is digitally signed (any change invalidates the signature). See DocumentView.profile(). */
  signed() {
    return this.#view.profile().then((p) => p.signed, () => false);
  }

  async #analysis(entry, pageNumber) {
    const key = `${entry.src}:${entry.index}`;
    const cached = this.#pages.get(key);
    if (cached) return cached;
    const source = await this.#source(entry.src);
    const analysis = analyzePage(source.page(entry.index));
    // pdf.js's reading can only be compared while the page on screen shows its original content.
    // (A page is always checked before it can be edited, so this only skips pages restored from elsewhere.)
    if (!this.#view.annotations.edits.some((e) => e.entry === entry.id)) {
      const pdfjsLib = this.#view.pdfjsLib;
      const page = await this.#view.pdf.getPage(pageNumber);
      const [operatorList, textContent] = await Promise.all([
        page.getOperatorList({ annotationMode: pdfjsLib.AnnotationMode.DISABLE }),
        page.getTextContent(),
      ]);
      verifyPage(analysis, { operatorList, textContent, OPS: pdfjsLib.OPS });
      nameFonts(analysis, textContent);
      this.#pages.set(key, analysis);
    }
    return analysis;
  }

  /** The PDF a page comes from (the opened file, or one pages were inserted from), read once. */
  #source(src) {
    if (!this.#sources.has(src)) {
      const pending = (async () => {
        const lib = await loadPdfLib();
        const bytes = src === 'base' ? await this.#view.baseBytes() : this.#view.sources.get(src);
        if (!bytes) throw new EditError('missing', 'The PDF these pages came from is no longer available.');
        return openSource(lib, bytes);
      })();
      pending.catch(() => this.#sources.delete(src)); // a failure may be temporary: try again next time
      this.#sources.set(src, pending);
    }
    return this.#sources.get(src);
  }
}

/** Are these the same stored placement? Both may be absent, which is also the same. */
const sameAs = (a, b) => (!a && isIdentity(b)) || Boolean(a && b && a.every((v, i) => v === b[i]));

/** Has this record taken its object off the page: a picture's draw removed, or a run's text emptied? */
export const isRemoved = (record) => Boolean(record?.removed) || record?.encoding?.mode === 'none';

/**
 * Notes pdf.js's own name for each run's font (run.loadedFont): pdf.js loads embedded fonts into
 * the page under that name, so an editor can show the text in the very same face while typing.
 */
function nameFonts(analysis, textContent) {
  const byFont = new Map();
  for (const run of analysis.runs) {
    const [x, y] = run.origin;
    const item = textContent.items.find((i) => i.fontName && Math.abs(i.transform[4] - x) < 0.5 && Math.abs(i.transform[5] - y) < 0.5);
    if (!item) continue;
    run.loadedFont = item.fontName;
    if (run.font) byFont.set(run.font.key, item.fontName);
  }
  for (const run of analysis.runs) if (!run.loadedFont && run.font) run.loadedFont = byFont.get(run.font.key) ?? null;
}
