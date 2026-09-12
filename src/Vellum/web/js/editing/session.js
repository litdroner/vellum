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
import { analyzePage, verifyPage, REASONS } from './runs.js';
import { planTextEdit, planTextTransform, EditError } from './edits.js';
import { selectableObjects } from './objects/selection.js';
import { planImageEdit } from './objects/image.js';
import { IDENTITY, multiply } from './matrix.js';
import { isIdentity, quantize } from './objects/transform.js';
import { loadPdfLib } from '../annotations/persist.js';

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

  // ---- moving, scaling, turning, flipping and deleting one object ------------------------------
  //
  // Both kinds go through here, and both keep exactly one record per object. A gesture is given as
  // a DELTA — "what this drag just did" — because that is what an interaction knows; the record
  // keeps the ABSOLUTE transform, in the ORIGINAL page's user space, which is what the writers
  // need and what makes a second gesture replace the first instead of stacking another record.

  /** The object with this key on a page, and the page entry it belongs to. */
  async #objectAt(pageNumber, key) {
    const view = this.#view;
    if (view.rebuilding) throw new EditError('busy', 'Vellum is still updating the pages. Try again in a moment.');
    const { entry, objects, records } = await this.objects(pageNumber);
    const object = objects.find((o) => o.ref.key === key);
    if (!object) throw new EditError('missing', 'That object isn’t on this page any more.');
    return { entry, object, record: records.get(key) ?? null };
  }

  /** Refuses a verb in the words the capability already answered with. */
  #refuse(object, verb) {
    const reason = object.capabilities[verb];
    if (reason === true) return;
    throw new EditError('not-editable', REASONS[reason] ?? REASONS.unsupported, { reason });
  }

  /**
   * Applies `delta` — a page-space transform — to where an object is NOW: one undo step, one
   * record, an absolute transform inside it. Returns false when nothing changed.
   *
   * `verb` is the capability the gesture claims ('move', 'scale' or 'rotate'), so a refusal is the
   * one the object already published rather than a second opinion. `coalesce`, when given, joins
   * this change to the previous one carrying the same token — an arrow-key burst is one gesture and
   * so one undo (annotations/model.js).
   *
   * A delta that puts the object back exactly where the file has it removes the record altogether,
   * so "move it and move it back" leaves the document as it found it.
   */
  async transformObject(pageNumber, key, delta, { verb = 'move', coalesce = null } = {}) {
    const view = this.#view;
    const { entry, object, record } = await this.#objectAt(pageNumber, key);
    this.#refuse(object, verb);
    const absolute = quantize(multiply(record?.transform ?? IDENTITY, delta));
    if (!absolute) throw new EditError('content', 'That change couldn’t be worked out, so nothing was changed.');
    if (record && sameAs(record.transform, absolute)) return false;
    if (!record && isIdentity(absolute)) return false;
    const after = this.#plan(entry, object, record, absolute);
    view.annotations.applyEdit(record, after, coalesce);
    return true;
  }

  /** Deletes one object: text loses its glyphs, a picture loses its draw. One undo step. */
  async removeObject(pageNumber, key) {
    const view = this.#view;
    const { entry, object, record } = await this.#objectAt(pageNumber, key);
    this.#refuse(object, 'delete');
    const after = object.kind === 'text-run'
      // Empty text has always been how text is removed (encoding.mode 'none'); a placement stays
      // on the record because it is not about the text, exactly as retyping keeps it.
      ? planTextEdit({
        run: object.record, text: '', entry: entry.id, glyphs: (await this.#source(entry.src)).glyphs,
        id: record?.id, transform: record?.transform ?? null, ...(await this.#constraints()),
      })
      : planImageEdit({ object, removed: true, entry: entry.id, id: record?.id });
    view.annotations.applyEdit(record, after);
    return true;
  }

  /**
   * The record for one absolute placement — or null when there is nothing left to say, which is
   * what "back where it started" means. Text that was only ever moved has no record without its
   * transform; text that was retyped keeps its own record, untransformed.
   */
  #plan(entry, object, record, absolute) {
    if (object.kind !== 'text-run') {
      if (isIdentity(absolute)) return null;
      return planImageEdit({ object, transform: absolute, entry: entry.id, id: record?.id });
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
