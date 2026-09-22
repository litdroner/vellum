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
import { mayContain, nearestMatch, paragraphMatches, replaceInLines } from './find-replace.js';
import { textBlocks } from './objects/text-block.js';
import { selectableObjects } from './objects/selection.js';
import { refusalMessage } from './objects/capabilities.js';
import { planImageEdit, readPicture } from './objects/image.js';
import { defaultPlacement, keyOf as insertedKey, kind as insertedKind, planInsertion } from './objects/inserted-image.js';
import { cleanText, defaultTextPlacement, fontsOf, keyOf as newTextKey, kind as newTextKind, planFormat, planNewText, PLACEHOLDER } from './objects/inserted-text.js';
import { documentKey, embeddedFamilies, fontSet, withDocumentFonts } from './objects/font-set.js';
import { remapSpans } from './objects/text-format.js';
import { planRunFormat, runFormatError, withRunFormat } from './objects/run-format.js';
import { drawnQuadOf, planRunFace, runFaceError, runFamilyOf, runStyleOf, styleName, withRunFace } from './objects/run-face.js';
import { newOverlaps, overlapDepth } from './objects/overlap.js';
import { insertedObject, insertedTextObject, objectsOfKind } from './objects/page-objects.js';
import { planReflow } from './objects/reflow.js';
import { checkShapes, kind as redactKind, planRedaction } from './objects/redaction.js';
import { copiedObject, isCopy, keyOf as copyKey, originKey, planCopy, snapshotOf, TEXT as textCopyKind } from './objects/copies.js';
import { boxQuad, quadBox, quadWithin, transformQuad, unionBox } from './objects/geometry.js';
import { IDENTITY, multiply, translate } from './matrix.js';
import { isIdentity, isValid, quantize } from './objects/transform.js';
import { loadPdfLib } from '../annotations/persist.js';
import { newId } from '../annotations/model.js';

export class TextEditing {
  #view;
  #sources = new Map(); // src → Promise<PdfSource>
  #pages = new Map(); // `${src}:${index}` → verified analysis
  #origins = new Map(); // `${src}:${index}` → Promise<analysis> of a page copies draw from (#origin)
  #fontSet = null; // Promise<font set> (#fonts)

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
    const edits = new Map(this.#view.annotations.edits.filter((e) => e.entry === entry.id && e.kind === 'text').map((e) => [e.target.key, e]));
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
    const analysis = entry.src === 'blank' ? null : await this.#analysis(entry, pageNumber);
    const records = this.#recordsOf(entry);
    const own = analysis ? selectableObjects(analysis) : [];
    // Pictures put on the page from a file, and pasted copies, are objects too: after everything the
    // page draws itself, in the order they were added. A copy is the object it was copied from, drawn
    // again — from this page, or from the page it names in `from`; one whose original isn't there
    // can't be drawn, and the writer refuses it.
    const origins = new Map([['', own]]);
    const analyses = new Map(analysis ? [['', analysis]] : []);
    for (const r of records.values()) {
      if (!isCopy(r.kind) || !r.from || origins.has(originKey(r.from))) continue;
      const origin = await this.#origin(r.from.src, r.from.index).catch(() => null);
      origins.set(originKey(r.from), origin ? selectableObjects(origin) : []);
      if (origin) analyses.set(originKey(r.from), origin);
    }
    const added = [];
    // New text reads its font's family and style off the fonts it may be written in.
    const families = [...records.values()].some((r) => r.kind === newTextKind) ? (await this.#fonts()).families : undefined;
    for (const r of records.values()) {
      if (r.kind === insertedKind) added.push(insertedObject(analysis, r, added.length));
      else if (r.kind === newTextKind) added.push(insertedTextObject(analysis, r, added.length, families));
      else if (isCopy(r.kind)) {
        const source = sourceObject(origins.get(r.from ? originKey(r.from) : ''), r);
        if (source) added.push(copiedObject(source, r, added.length));
      }
    }
    // What a redaction on this page covers is gone from the page, so it is no object to select or change.
    const redacted = this.#view.annotations.edits.filter((e) => e.entry === entry.id && e.kind === redactKind).flatMap((e) => e.rects);
    const shown = (o) => {
      const quad = o.geometry?.quad && records.get(o.ref.key)?.transform ? transformQuad(o.geometry.quad, records.get(o.ref.key).transform) : o.geometry?.quad;
      const box = quad ? quadBox(quad) : o.geometry?.box;
      return !box || !redacted.some((r) => box[0] < r[2] && r[0] < box[2] && box[1] < r[3] && r[1] < box[3]);
    };
    return {
      entry,
      kind: analysis?.summary.kind ?? 'no-text',
      objects: (redacted.length ? [...own, ...added].filter(shown) : [...own, ...added]),
      analysis,
      records,
      // The analysis each copy's run or picture belongs to: '' for this page's own, else by originKey.
      origins: analyses,
    };
  }

  /**
   * This page's content edits, by the object-model key of what each one changes: `run:<key>` for
   * text, `image:<stream>#<opIndex>` for a picture and `inserted:<id>` for a picture put there from a
   * file. One object has at most one record — that is what makes a second drag replace the first
   * rather than pile up — so this is a plain map.
   */
  #recordsOf(entry) {
    const records = new Map();
    for (const e of this.#view.annotations.edits) {
      if (e.entry !== entry.id) continue;
      if (e.kind === 'text') records.set(`run:${e.target.key}`, e);
      else if (e.kind === 'image') records.set(e.target.key, e);
      else if (e.kind === insertedKind) records.set(insertedKey(e), e);
      else if (e.kind === newTextKind) records.set(newTextKey(e), e);
      else if (isCopy(e.kind)) records.set(copyKey(e), e);
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
    if (isCopyKey(runKey)) return this.#retypeCopy(pageNumber, runKey, text);
    if (isNewTextKey(runKey)) return this.#retypeNewText(pageNumber, runKey, text);
    const { entry, runs } = await this.page(pageNumber);
    const item = runs.find((r) => r.run.key === runKey);
    if (!item) throw new EditError('missing', 'That text isn’t on this page any more.');
    const pair = await this.#retypePair(entry, item, text);
    if (!pair) return false;
    view.annotations.applyEdit(...pair);
    return true;
  }

  /**
   * What retyping a page's run (an item of page()) to `text` changes: [before, after] for the edit
   * store, or null when nothing changes. Throws EditError when it can't be done safely.
   */
  async #retypePair(entry, item, text) {
    const next = text.replace(/[\r\n\t\f\v]+/g, ' ').normalize('NFC');
    if (next === item.text) return null;
    if (next === item.run.text) {
      // Back to exactly what the file says: the edit simply goes away. A placement isn’t about
      // the text, though, so a run that has also been moved keeps its one record — holding the
      // file’s own glyphs again, which is what it would have had if it had only ever been moved.
      if (!item.edit) return null;
      const placed = item.edit.transform || item.edit.format || item.edit.face
        ? planTextTransform({
          run: item.run, transform: item.edit.transform ?? null, entry: entry.id, id: item.edit.id, format: item.edit.format ?? null, face: item.edit.face ?? null,
        })
        : null;
      return [item.edit, placed];
    }
    // Another face draws the file's own glyphs of the line (objects/run-face.js): retyped text has none.
    if (item.edit?.face) throw runFaceError('retype');
    const source = await this.#source(entry.src);
    // The run's placement is carried through: retyping text that has been moved must not move it
    // back, and must not become a second record either.
    const record = planTextEdit({
      run: item.run, text: next, entry: entry.id, glyphs: source.glyphs,
      id: item.edit?.id, transform: item.edit?.transform ?? null, format: item.edit?.format ?? null, ...(await this.#constraints()),
    });
    return [item.edit, record];
  }

  // ---- find and replace ------------------------------------------------------------------------------
  //
  // Replacing is retyping: each line of text a match is in is planned exactly as edit() plans it — a
  // page's own run and a pasted copy of one in its font's codes, a standard font of the same style, or a
  // refusal; new text in its own font or a refusal — and all of it goes into the store as ONE undo step.
  // A match inside one line is replaced in that line. A match that runs on from one line of a paragraph
  // (objects/text-block.js) to the next is replaced in both: the replacement ends the first line and
  // the rest of the second stays where it is. A match across more lines, or one that would empty a
  // line, isn't. A match the engine can't change safely is left as it is, and counted with the reason.

  /**
   * Replaces `query` with `replacement` in the document's text: its own text, pasted copies of text and
   * new text. With `at` ({ pageNumber, point } in that page's user space) only the match nearest that
   * point, in the line drawn under it; otherwise every match on every page. Returns { replaced, skipped,
   * reasons }: how many matches were replaced and left, and why they were left, each reason once.
   */
  async replaceText(query, replacement, { caseSensitive = false, entireWord = false } = {}, at = null) {
    const view = this.#view;
    if (view.rebuilding) throw new EditError('busy', 'Vellum is still updating the pages. Try again in a moment.');
    const options = { caseSensitive, entireWord };
    const pairs = [];
    const reasons = new Set();
    let replaced = 0;
    let skipped = 0;
    const pageNumbers = at ? [at.pageNumber] : view.shownPlan.map((_, i) => i + 1);
    for (const n of pageNumbers) {
      const added = [...this.#recordsOf(view.shownPlan[n - 1]).values()]
        .some((r) => (r.kind === textCopyKind || r.kind === newTextKind) && !isRemoved(r));
      if (!at && !added) {
        // Only pages whose text might hold the query are analyzed: reading a page isn't free.
        const content = await (await view.pdf.getPage(n)).getTextContent();
        if (!mayContain(content.items.map((i) => i.str).join(''), query)) continue;
      }
      const { entry, runs } = await this.page(n);
      const lines = runs.map((item) => ({
        key: `run:${item.run.key}`,
        text: item.text,
        quad: transformQuad(item.run.quad, item.edit?.transform ?? null),
        pair: (text) => this.#retypePair(entry, item, text),
      }));
      if (added) lines.push(...(await this.#addedLines(n)));
      // Each paragraph is matched as one text, so a match may run on from one of its lines to the next.
      let found = (await this.#lineGroups(n, lines)).flatMap((group) => {
        const { matches, offsets } = paragraphMatches(group.map((line) => line.text), query, options);
        return matches.map((m) => ({ group, offsets, m, unsafe: crossLineRefusal(group, offsets, m, replacement) }));
      });
      if (at) {
        // The highlighted match is marked from the line it begins on.
        const byLine = new Map();
        for (const f of found) {
          const line = f.group[f.m.first];
          const start = f.m.start - f.offsets[f.m.first];
          const local = { start, end: Math.min(f.m.end - f.offsets[f.m.first], line.text.length), found: f };
          byLine.set(line, [...(byLine.get(line) ?? []), local]);
        }
        const one = nearestLine([...byLine].map(([line, matches]) => ({ line, matches })), at.point);
        if (!one) throw new EditError('missing', 'Vellum can’t change this match: only text on the page, pasted text and new text are replaced.');
        if (one.match.found.unsafe) throw new EditError('cross-line', one.match.found.unsafe);
        found = [one.match.found];
      }
      for (const f of found.filter((f) => f.unsafe)) {
        skipped += 1;
        reasons.add(f.unsafe);
      }
      // Lines a match runs across are retyped together, or not at all.
      for (const unit of replacementUnits(found.filter((f) => !f.unsafe))) {
        const { group, offsets } = unit[0];
        const texts = group.map((line) => line.text);
        const next = replaceInLines(texts, offsets, unit.map((f) => f.m), replacement);
        try {
          const planned = [];
          for (let i = 0; i < group.length; i++) {
            if (next[i] === texts[i]) continue;
            const pair = await group[i].pair(next[i]);
            if (pair) planned.push(pair);
          }
          pairs.push(...planned);
          replaced += unit.length;
        } catch (err) {
          if (!(err instanceof EditError) || at) throw err;
          skipped += unit.length;
          reasons.add(err.message);
        }
      }
    }
    if (pairs.length) view.annotations.applyEdits(pairs);
    return { replaced, skipped, reasons: [...reasons] };
  }

  /**
   * replaceText's lines of a page grouped: the lines of each of the page's own paragraphs together, top
   * line first, as grouping finds them where they are now (objects/text-block.js); every other line —
   * pasted copies and new text among them — on its own.
   */
  async #lineGroups(pageNumber, lines) {
    const byKey = new Map(lines.filter((line) => line.key).map((line) => [line.key, line]));
    const { objects, analysis, records } = await this.objects(pageNumber);
    const live = [];
    for (const object of objects) {
      if (object.ref.copy || object.ref.newText) continue;
      const edit = records.get(object.ref.key) ?? null;
      if (!object.geometry?.quad) live.push(object);
      else if (!isRemoved(edit)) live.push({ ...object, geometry: { ...object.geometry, quad: transformQuad(object.geometry.quad, edit?.transform ?? null) }, edit });
    }
    const grouped = new Set();
    const groups = [];
    for (const { keys } of textBlocks([...live, ...(analysis ? objectsOfKind(analysis, 'path') : [])])) {
      const group = keys.map((key) => byKey.get(key));
      if (group.some((line) => !line)) continue;
      group.forEach((line) => grouped.add(line));
      groups.push(group);
    }
    return [...groups, ...lines.filter((line) => !grouped.has(line)).map((line) => [line])];
  }

  /**
   * A page's pasted copies of text and new text, as replaceText reads its lines: { text, quad, pair },
   * `pair(text)` planning the retyping exactly as #retypeCopy and #retypeNewText do.
   */
  async #addedLines(pageNumber) {
    const { entry, objects, records } = await this.objects(pageNumber);
    const lines = [];
    let fonts = null;
    let constraints = null;
    const glyphs = new Map();
    for (const object of objects) {
      const record = records.get(object.ref.key);
      if (object.kind !== 'text-run' || !record || isRemoved(record)) continue;
      const quad = object.geometry?.quad ? transformQuad(object.geometry.quad, record.transform ?? null) : null;
      if (object.ref.copy && record.kind === textCopyKind) {
        lines.push({
          text: record.text,
          quad,
          pair: async (text) => {
            const next = text.replace(/[\r\n\t\f\v]+/g, ' ').normalize('NFC');
            constraints ??= await this.#constraints();
            const src = record.from?.src ?? entry.src;
            if (src !== 'blank' && !glyphs.has(src)) glyphs.set(src, (await this.#source(src)).glyphs);
            const planned = this.#retyped(object, record, next, glyphsFor(glyphs, record, entry), constraints);
            return planned && planned.text === record.text && planned.encoding.mode === record.encoding.mode ? null : [record, planned];
          },
        });
      } else if (object.ref.newText && record.kind === newTextKind) {
        lines.push({
          text: record.text,
          quad,
          pair: async (text) => {
            fonts ??= await this.#fonts();
            const planned = this.#retypedNewText(fonts, object, record, text);
            return planned && planned.text === record.text ? null : [record, planned];
          },
        });
      }
    }
    return lines;
  }

  // ---- retyping pasted text ------------------------------------------------------------------------
  //
  // A pasted copy of text (`copy:<id>`) is retyped through its one record, on exactly the terms its
  // original is: the text is planned against the run it draws (planTextEdit — its own font's codes, a
  // standard font of the same style, or a refusal), and the copy record takes that text and encoding,
  // keeping its id, target, origin and placement. The copy writer already draws text in any of those
  // encodings. Emptied, the copy goes, as deleting it does; typed back to the run's own text it draws
  // the file's own glyph bytes again.

  /** Retypes one pasted copy of text: one undo step, false when nothing changed. */
  async #retypeCopy(pageNumber, key, text) {
    const next = text.replace(/[\r\n\t\f\v]+/g, ' ').normalize('NFC');
    const { glyphs, constraints } = await this.#copyPlanning(pageNumber, [key]);
    const { entry, found: [{ object, record }] } = await this.#objectsAt(pageNumber, [key]);
    const planned = this.#retyped(object, record, next, glyphsFor(glyphs, record, entry), constraints);
    if (planned && planned.text === record.text && planned.encoding.mode === record.encoding.mode) return false;
    this.#view.annotations.applyEdits([[record, planned]]);
    return true;
  }

  /** The copy record that retypes `object` (a text copy) to `text`, null when it empties it. EditError when it can't. */
  #retyped(object, record, text, glyphs, constraints) {
    if (object.kind !== 'text-run' || !object.ref.copy || record?.kind !== textCopyKind) {
      throw new EditError('missing', 'That text isn’t on this page any more.');
    }
    this.#refuse(object, 'editText');
    const run = object.record;
    if (text === run.text) return planCopy({ ...record, text: run.text, encoding: { mode: 'original' } });
    if (record.face) throw runFaceError('retype');
    const planned = planTextEdit({ run, text, entry: record.entry, glyphs, id: record.id, ...constraints });
    if (planned.encoding.mode === 'none') return null;
    return planCopy({ ...record, text: planned.text, encoding: planned.encoding });
  }

  // ---- new text ------------------------------------------------------------------------------------
  //
  // New text (`text:<id>`, objects/inserted-text.js) is its record: retyping plans the record again with
  // the new text, in its own standard font, keeping its id, font, size and placement; emptied, it goes, as
  // deleting it does. A character the font doesn't have is refused, never drawn in another font.

  /** Retypes new text: one undo step, false when nothing changed. */
  async #retypeNewText(pageNumber, key, text) {
    const fonts = await this.#fonts();
    const { found: [{ object, record }] } = await this.#objectsAt(pageNumber, [key]);
    const planned = this.#retypedNewText(fonts, object, record, text);
    if (planned && planned.text === record.text) return false;
    this.#view.annotations.applyEdits([[record, planned]]);
    return true;
  }

  /** The record retyping new text to `text` makes, null when it empties it. EditError when it can't. */
  #retypedNewText(fonts, object, record, text) {
    if (!object.ref.newText || record?.kind !== newTextKind) throw new EditError('missing', 'That text isn’t on this page any more.');
    this.#refuse(object, 'editText');
    const clean = cleanText(text);
    if (!clean.trim()) return null;
    // What stayed keeps how it read; what was typed takes the format around it (objects/text-format.js).
    return planNewText({ fonts, ...record, text: clean, spans: remapSpans(record.text, clean, record.spans ?? null) });
  }

  /**
   * The fonts new text may be written in (objects/font-set.js): the standard families, the opened PDF's
   * own fonts as far as its pages read so far have confirmed their glyphs, and the bundled families whose
   * files could be read (those read once; a failure is tried again next time). A bundled face is read when
   * it is needed: the faces this document's new text is written in, and those of `wanted` (font keys or a
   * family's id — a family being chosen, text being pasted).
   */
  async #fonts(wanted = []) {
    if (!this.#fontSet) {
      this.#fontSet = loadPdfLib().then((lib) => fontSet(lib));
      this.#fontSet.catch(() => { this.#fontSet = null; });
    }
    const set = await this.#fontSet;
    const used = this.#view.annotations.edits.filter((e) => e.kind === newTextKind).flatMap(fontsOf);
    await set.load([...used, ...wanted]);
    const base = this.#sources.has('base') ? await this.#sources.get('base').catch(() => null) : null;
    if (!base) return set;
    // The name pdf.js loaded each of the file's fonts under, from the base pages it has drawn.
    const loaded = new Map();
    for (const [key, analysis] of this.#pages) {
      if (!key.startsWith('base:')) continue;
      for (const run of analysis.runs) if (run.font && run.loadedFont && !loaded.has(run.font.key)) loaded.set(run.font.key, run.loadedFont);
    }
    return withDocumentFonts(set, base.fonts.values(), loaded);
  }

  /** The font families new text may be written in, for a font selector: [{ id, name, faces }]. */
  async fontFamilies() {
    return (await this.#fonts()).families;
  }

  /**
   * Formats new text (objects/inserted-text.js planFormat): `changes` holds any of family (the id of one of
   * fontFamilies()), size, bold, italic, underline, align, color, opacity and width, and applies to
   * every one of `keys`, which must all be new text — one undo step, false when nothing changed. Throws
   * EditError, with nothing changed, when any of them can't take it (a character the chosen face doesn't
   * have, a family that isn’t offered, a face the family hasn’t got, a size out of range).
   *
   * `range` ([from, to) over the box's text) formats only that much of it — the face, size, underline,
   * colour and opacity of those characters alone; alignment and width stay the whole box's. `text`
   * retypes the box in the same step, so typing and formatting in the open editor is one undo step.
   * Both are for one box at a time: they mean nothing across a selection of several.
   */
  async formatText(pageNumber, keys, changes, { range = null, text } = {}) {
    const view = this.#view;
    if (view.rebuilding) throw new EditError('busy', 'Vellum is still updating the pages. Try again in a moment.');
    if ((range || text !== undefined) && keys.length !== 1) {
      throw new EditError('format', 'Part of a text box is formatted one box at a time, so nothing was changed.');
    }
    const fonts = await this.#fonts(typeof changes?.family === 'string' ? [changes.family] : []);
    const constraints = await this.#constraints();
    // The opened PDF's own fonts, another face of which a line of the page may be set in (objects/run-face.js).
    const models = changes?.bold !== undefined || changes?.italic !== undefined || changes?.family !== undefined
      ? (await this.#source('base').catch(() => null))?.fonts ?? null
      : null;
    const page = await this.#objectsAt(pageNumber, keys);
    const { entry, found } = page;
    // The page's own text (and pasted copies of it) is formatted on its own terms (objects/run-format.js).
    if (found.some(({ object }) => !object.ref.newText)) return this.#formatRuns(page, changes, { range, text, constraints, fonts, models });
    const pairs = [];
    for (const { object, record } of found) {
      if (!object.ref.newText || record?.kind !== newTextKind) {
        throw new EditError('format', 'Only new text can be formatted here, so nothing was changed.', { key: object.ref.key });
      }
      this.#refuse(object, 'editText', found.length);
      const planned = planFormat({ fonts, record, changes, range, text });
      const { id, entry, ...before } = record;
      const { id: _id, entry: _entry, ...after } = planned;
      if (JSON.stringify(before) !== JSON.stringify(after)) pairs.push([record, planned]);
    }
    if (!pairs.length) return false;
    view.annotations.applyEdits(pairs);
    return true;
  }

  /**
   * Formats text the page already draws — runs, and pasted copies of them — with `changes` holding any of
   * size, color, opacity and underline (objects/run-format.js planRunFormat), and bold and italic — the face
   * of its font the same PDF has in that style (objects/run-face.js planRunFace; refused where the wider or
   * narrower line isn't safe, #refuseFaceGeometry): ONE undo step for all of
   * `found`, false when nothing changed, EditError with nothing changed when any of them refuses. Each
   * keeps its one record: a text record takes the format and a size's scale into its own (planTextTransform,
   * so it is checked as any placement is), a copy into its copy record. A run's record that ends up saying
   * nothing — no transform, no format, its own glyphs — goes, as a move back to where it started does.
   * New text isn't formatted in the same step: it has its own format and fonts.
   */
  #formatRuns(page, changes, { range, text, constraints, fonts, models }) {
    const { entry, found, origins } = page;
    if (found.some(({ object }) => object.ref.newText)) {
      throw new EditError('format', 'New text and the page’s own text are formatted separately, so nothing was changed.');
    }
    if (range || text !== undefined) throw runFormatError('range');
    const { bold, italic, family, ...rest } = changes && typeof changes === 'object' ? changes : {};
    const style = bold !== undefined || italic !== undefined || family !== undefined ? { bold, italic, family } : null;
    const pairs = [];
    const refaced = [];
    for (const { object, record } of found) {
      if (object.kind !== 'text-run') throw new EditError('format', 'Only text can be formatted, so nothing was changed.', { key: object.ref.key });
      this.#refuse(object, 'editText', found.length);
      const run = object.record;
      // A copy's run is read from the page it names, or from this page's own content.
      const from = object.ref.copy ? record.from ?? null : null;
      const face = style
        ? planRunFace({ run, record, analysis: origins.get(from ? originKey(from) : ''), changes: style, fonts, models: (from?.src ?? entry.src) === 'base' ? models : null })
        : record?.face ?? null;
      const { format, transform } = planRunFormat({ run, record, changes: style ? rest : changes, pdfa: constraints.embeddedFontsOnly });
      let next;
      if (object.ref.copy) next = planCopy({ ...record, transform, format, face });
      else {
        const base = record ?? planTextTransform({ run, transform: null, entry: entry.id });
        next = planTextTransform({ record: withRunFace(withRunFormat(base, format), face), transform, entry: entry.id });
        if (!next.transform && !next.format && !next.face && next.encoding.mode === 'original') next = null;
      }
      if (JSON.stringify(record) === JSON.stringify(next)) continue;
      pairs.push([record, next]);
      if (JSON.stringify(record?.face ?? null) !== JSON.stringify(face)) refaced.push({ object, record, next });
    }
    if (refaced.length) this.#refuseFaceGeometry(page, refaced);
    if (!pairs.length) return false;
    this.#view.annotations.applyEdits(pairs);
    return true;
  }

  /**
   * Puts a line of new text on a page, in a standard font, centred and upright as the page is shown
   * (`basis`, page-space.js displayBasis; `box`, the page's crop box), or with its top-left at `at` (a
   * user-space point, where the page was right-clicked): one undo step, one record, and the
   * new text's object key back, so it can be selected and typed over. Throws EditError when it can't be
   * done: a page whose content can't be rewritten, a PDF/A document (the standard fonts aren't embedded).
   */
  async insertText(pageNumber, { basis, box, at = null, text = PLACEHOLDER }) {
    const view = this.#view;
    if (view.rebuilding) throw new EditError('busy', 'Vellum is still updating the pages. Try again in a moment.');
    const lib = await loadPdfLib();
    if ((await this.#constraints()).embeddedFontsOnly) {
      throw new EditError('pdfa', 'This PDF follows the PDF/A archiving standard, which needs every font embedded. New text is written in a standard font that isn’t, so no text was added.');
    }
    const { entry, analysis } = await this.objects(pageNumber);
    const blocked = analysis?.tainted || analysis?.summary.kind === 'unreadable' ? 'unreadable' : analysis?.unbalanced ? 'structure' : null;
    if (blocked) throw new EditError('not-editable', REASONS[blocked], { reason: blocked });
    const upright = planNewText({ lib, text, transform: IDENTITY, entry: entry.id });
    const transform = defaultTextPlacement({ box: upright.box, page: box, basis, at });
    if (!transform) throw new EditError('content', 'Vellum couldn’t work out where to put the text on this page, so nothing was added.');
    const record = planNewText({ lib, text, transform, entry: entry.id, id: upright.id });
    view.annotations.applyEdits([[null, record]]);
    return newTextKey(record);
  }

  /**
   * What planning text for these copies needs, read BEFORE the records are read: the glyph data of each
   * PDF they draw from, by src, and the document's constraints — so nothing is awaited between reading
   * the records and storing what replaces them.
   */
  async #copyPlanning(pageNumber, keys) {
    const constraints = await this.#constraints();
    const { entry, found } = await this.#objectsAt(pageNumber, keys);
    const glyphs = new Map();
    for (const { record } of found) {
      const src = record?.from?.src ?? entry.src;
      if (src !== 'blank' && !glyphs.has(src)) glyphs.set(src, (await this.#source(src)).glyphs);
    }
    return { glyphs, constraints };
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
    const { entry, objects, records, analysis, origins } = await this.objects(pageNumber);
    const byKey = new Map(objects.map((o) => [o.ref.key, o]));
    const found = keys.map((key) => {
      const object = byKey.get(key) ?? null;
      const record = records.get(key) ?? null;
      if (!object || isRemoved(record)) {
        throw new EditError('missing', keys.length > 1 ? 'One of the selected objects isn’t on this page any more, so nothing was changed.' : 'That object isn’t on this page any more.');
      }
      return { object, record };
    });
    return { entry, found, analysis, origins, objects, records };
  }

  /**
   * The families of the opened PDF's own fonts one line of the page's own text (a run, or a pasted copy of
   * one: `key`) could be set in, from the edit bar's font menu: [{ id, name, css, current, refusal }],
   * `refusal` the reason choosing it would be refused (objects/run-face.js planRunFace, and the new width
   * checked as formatText checks it), null when it can be chosen. Only the document's own families: the
   * standard and bundled fonts aren't used for text the PDF already draws. Every embedded text font family
   * the PDF names is listed (PdfSource.scanFonts), also those on pages not read yet or never seen drawing:
   * those have no face that can be chosen, so they are refused.
   */
  async runFontFamilies(pageNumber, key) {
    const base = await this.#source('base').catch(() => null);
    base?.scanFonts();
    const fonts = await this.#fonts();
    const models = base?.fonts ?? null;
    const page = await this.#objectsAt(pageNumber, [key]);
    const [{ object, record }] = page.found;
    if (object.kind !== 'text-run' || object.ref.newText) return [];
    const run = object.record;
    const from = object.ref.copy ? record?.from ?? null : null;
    const analysis = page.origins.get(from ? originKey(from) : '');
    const current = runFamilyOf(run, record, fonts);
    const listed = fonts.families.filter((f) => f.group === 'document');
    const unseen = embeddedFamilies(models?.values() ?? []).filter((f) => !listed.some((l) => l.id === f.id)).map(({ id, name }) => ({
      id, name, css: null, current: id === current,
      refusal: id === current ? null : runFaceError('face', { style: styleName(runStyleOf(run, record)) }).message,
    }));
    return listed.map(({ id, name, css }) => {
      let refusal = null;
      if (id !== current) {
        try {
          const face = planRunFace({ run, record, analysis, changes: { family: id }, fonts, models: (from?.src ?? page.entry.src) === 'base' ? models : null });
          this.#refuseFaceGeometry(page, [{ object, record, next: withRunFace(record ?? {}, face) }]);
        } catch (err) {
          if (!(err instanceof EditError)) throw err;
          refusal = err.message;
        }
      }
      return { id, name, css, current: id === current, refusal };
    }).concat(unseen);
  }

  /**
   * Refuses, with nothing changed, lines set in another face (`changed`: [{ object, record, next }], from
   * #formatRuns) whose new width can't be shown to be safe: a line that would newly cover another object on
   * the page, or another of the lines changed with it (objects/overlap.js, as a gesture's warning judges it,
   * a tenth of the line's height being the depth that counts), or reach further past the page's box or the
   * shape clipping it than it did. Nothing else on the page is ever moved to make room.
   */
  #refuseFaceGeometry({ analysis, origins, objects, records }, changed) {
    const drawn = (object, record) => drawnQuadOf(object, record, origins.get(object.ref.copy && record?.from ? originKey(record.from) : ''));
    const moving = changed.map(({ object, record, next }) => {
      const before = drawn(object, record);
      const after = drawn(object, next);
      if (!before || !after) throw runFaceError('bounds');
      // The shape clipping the line where the page draws it, in that page's space, before any transform.
      const clip = object.record.first?.clip?.box;
      if (clip && !quadWithin(after, unionBox([boxQuad(clip), before]))) throw runFaceError('bounds');
      const to = transformQuad(after, next?.transform ?? null);
      return { key: object.ref.key, from: transformQuad(before, record?.transform ?? null), to, height: Math.hypot(to[6] - to[0], to[7] - to[1]) };
    });
    const box = analysis?.box ?? null;
    for (const m of moving) if (!box || !quadWithin(m.to, unionBox([boxQuad(box), m.from]))) throw runFaceError('bounds');
    const tolerance = Math.max(0.5, 0.1 * Math.min(...moving.map((m) => m.height)));
    const others = objects
      .filter((o) => !o.reasons?.some((r) => r === 'blank' || r === 'invisible'))
      .map((o) => {
        const record = records.get(o.ref.key) ?? null;
        return { key: o.ref.key, quad: isRemoved(record) ? null : transformQuad(drawn(o, record) ?? o.geometry.quad, record?.transform ?? null) };
      });
    if (newOverlaps(moving, others, tolerance).length) throw runFaceError('overlap');
    for (let i = 0; i < moving.length; i++) {
      for (let j = i + 1; j < moving.length; j++) {
        const [a, b] = [moving[i], moving[j]];
        if (overlapDepth(a.to, b.to) > tolerance && !(overlapDepth(a.from, b.from) > tolerance)) throw runFaceError('overlap');
      }
    }
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
    const fonts = await this.#fonts(); // new text is planned in its fonts' own widths
    const { entry, found } = await this.#objectsAt(pageNumber, moves.map((m) => m.key));
    for (const { object } of found) this.#refuse(object, verb, found.length);
    const pairs = [];
    found.forEach(({ object, record }, i) => {
      const absolute = quantize(multiply(record?.transform ?? IDENTITY, moves[i].delta));
      if (!absolute) throw new EditError('content', 'That change couldn’t be worked out, so nothing was changed.');
      if (record ? sameAs(record.transform, absolute) : isIdentity(absolute)) return;
      pairs.push([record, this.#plan(entry, object, record, absolute, fonts)]);
    });
    if (!pairs.length) return false;
    view.annotations.applyEdits(pairs, coalesce);
    return true;
  }

  /**
   * Redacts these areas of a page ([x1, y1, x2, y2] in its user space, objects/redaction.js): one undo
   * step. When the document is composed, the text and pictures in them are taken out of the page and the
   * areas painted black; what can't be removed for certain refuses the save instead. Forms, drawn shapes
   * and shadings in an area are refused here, before anything is marked.
   */
  async redactAreas(pageNumber, rects) {
    const view = this.#view;
    if (view.rebuilding) throw new EditError('busy', 'Vellum is still updating the pages. Try again in a moment.');
    const entry = view.shownPlan?.[pageNumber - 1];
    if (!entry) throw new EditError('missing', 'That page isn’t in the document.');
    const record = planRedaction({ entry: entry.id, rects });
    if (entry.src !== 'blank') checkShapes(await this.#analysis(entry, pageNumber), record.rects, pageNumber - 1, 'it wasn’t redacted');
    view.annotations.applyEdits([[null, record]]);
    return true;
  }

  /** Deletes one object: text loses its glyphs, a picture loses its draw. One undo step. */
  removeObject(pageNumber, key) {
    return this.removeObjects(pageNumber, [key]);
  }

  /**
   * Reflows a paragraph — these text lines of one page — to `width`, measured along the text as the
   * paragraph is shown now, in its own font and on its own lines (objects/reflow.js): ONE undo step.
   * false when nothing changed; EditError, with the reason, whenever it can't be done exactly.
   */
  async reflowParagraph(pageNumber, keys, width) {
    const view = this.#view;
    const { glyphs, constraints } = await this.#copyPlanning(pageNumber, keys);
    const { entry: current, found, analysis: own, origins } = await this.#objectsAt(pageNumber, keys);
    for (const { object } of found) {
      if (object.kind !== 'text-run') throw new EditError('reflow', 'Only text can be reflowed.', { key: object.ref.key });
      if (object.ref.newText) throw new EditError('reflow', 'New text wraps within its own box, so it isn’t reflowed with other lines.', { key: object.ref.key, reason: 'new-text' });
      // Text a Form XObject draws is edited line by line inside a private copy of that form
      // (objects/form-copy.js); re-wrapping a paragraph across its lines isn't written yet.
      if (object.record?.formEdit) throw new EditError('reflow', REASONS.form, { key: object.ref.key, reason: 'form' });
      this.#refuse(object, 'editText', found.length);
    }
    // Pasted lines are reflowed as the paragraph they were copied from, in that page's analysis, and only
    // together: all of them copies drawn from one page, or none of them.
    const copies = found.filter(({ object }) => object.ref.copy);
    const drawnFrom = new Set(found.map(({ object, record }) => (object.ref.copy ? (record.from ? originKey(record.from) : '') : null)));
    if (copies.length && (copies.length !== found.length || drawnFrom.size !== 1)) {
      throw new EditError('reflow', 'Pasted text can be reflowed only with the lines pasted from the same paragraph.', { reason: 'copy' });
    }
    const analysis = copies.length ? origins.get([...drawnFrom][0]) : own;
    if (!analysis) throw new EditError('missing', 'The page this text was pasted from isn’t available any more, so it can’t be reflowed.');
    const lines = found.map(({ object, record }) => ({ run: object.record, record }));
    const planned = planReflow({ analysis, lines, width, entry: current.id, glyphs: glyphsFor(glyphs, found[0].record, current), ...constraints });
    // A copy takes the reflowed line's text and encoding into its own record; an emptied copy goes.
    const pairs = planned.map(([record, next]) => (record && isCopy(record.kind)
      ? [record, next && next.encoding.mode !== 'none' ? planCopy({ ...record, text: next.text, encoding: next.encoding }) : null]
      : [record, next]));
    if (!pairs.length) return false;
    view.annotations.applyEdits(pairs);
    return true;
  }

  /** Deletes several objects on one page as ONE undo step — all of them, or none if any refuses. */
  async removeObjects(pageNumber, keys) {
    this.#view.annotations.applyEdits(await this.#removals(pageNumber, keys));
    return true;
  }

  /** The [record, replacement] pairs that delete these objects of one page; EditError if any refuses. */
  async #removals(pageNumber, keys) {
    const view = this.#view;
    const entry = view.shownPlan?.[pageNumber - 1];
    // What planning needs is read first, so nothing is awaited between reading the records and
    // storing what replaces them.
    const glyphs = entry && entry.src !== 'blank' ? (await this.#source(entry.src)).glyphs : null;
    const constraints = await this.#constraints();
    const { entry: current, found } = await this.#objectsAt(pageNumber, keys);
    for (const { object } of found) this.#refuse(object, 'delete', found.length);
    // A pasted copy is its record, like a picture put there from a file: deleting it takes the record away.
    const pairs = found.map(({ object, record }) => [record, object.ref.copy || object.ref.newText ? null : object.kind === 'text-run'
      // Empty text has always been how text is removed (encoding.mode 'none'); a placement stays
      // on the record because it is not about the text, exactly as retyping keeps it.
      ? planTextEdit({
        run: object.record, text: '', entry: current.id, glyphs,
        id: record?.id, transform: record?.transform ?? null, format: record?.format ?? null, ...constraints,
      })
      // A picture put there from a file is its record, so deleting it is taking the record away.
      : object.ref.inserted ? null
        : planImageEdit({ object, removed: true, entry: current.id, id: record?.id })]);
    return pairs;
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
    // A pasted copy keeps its record — origin, fingerprint and placement — with the new image in it.
    const next = object.ref.copy ? planCopy({ ...record, replacement: { source, ...picture } })
      : object.ref.inserted
      ? planInsertion({ picture: { source, ...picture }, transform: record.transform, entry: entry.id, id: record.id })
      : planImageEdit({
        object, transform: record?.transform ?? null, replacement: { source, ...picture }, entry: entry.id, id: record?.id,
      });
    view.sources.set(source, bytes);
    view.annotations.applyEdits([[record, next]]);
    return true;
  }

  /**
   * Puts a PNG or JPEG image (`bytes`) on a page as a new picture: one undo step, one record, and
   * the new picture's object key back, so it can be selected. `basis` (page-space.js displayBasis)
   * and `box` (the page's crop box) say how the page is shown, so the picture starts centred and
   * upright on screen (inserted-image.js defaultPlacement).
   *
   * The bytes are kept in the document's sources, as a replacement's are. Throws EditError when it
   * can't be done: an unusable file, a page whose content can't be rewritten, a PDF/A document.
   */
  async insertImage(pageNumber, bytes, { basis, box, pointsPerPixel }) {
    const view = this.#view;
    if (view.rebuilding) throw new EditError('busy', 'Vellum is still updating the pages. Try again in a moment.');
    const lib = await loadPdfLib();
    const picture = await readPicture(lib, bytes);
    if ((await this.#constraints()).embeddedFontsOnly) {
      throw new EditError('pdfa', 'This PDF follows the PDF/A archiving standard, and Vellum can’t check that a new picture meets it, so the picture wasn’t added.');
    }
    const { entry, analysis } = await this.objects(pageNumber);
    // The page writer rewrites a page only when it can read all of it; say so now rather than at save.
    const blocked = analysis?.tainted || analysis?.summary.kind === 'unreadable' ? 'unreadable' : analysis?.unbalanced ? 'structure' : null;
    if (blocked) throw new EditError('not-editable', REASONS[blocked], { reason: blocked });
    const transform = defaultPlacement({ ...picture, box, basis, pointsPerPixel });
    if (!transform) throw new EditError('content', 'Vellum couldn’t work out where to put the picture on this page, so nothing was added.');
    const source = newId();
    const record = planInsertion({ picture: { source, ...picture }, transform, entry: entry.id });
    view.sources.set(source, bytes);
    view.annotations.applyEdits([[null, record]]);
    return insertedKey(record);
  }

  // ---- copying and pasting objects -----------------------------------------------------------------
  //
  // Copying reads; it changes nothing. It takes each selected object as it is now — retyped, moved,
  // replaced — into plain data (objects/copies.js snapshotOf), all of them or none if any refuses, so a
  // later change to the document doesn't change what was copied. Pasting turns that into new records
  // on a page, as ONE undo step, and hands back their keys so they can be selected.

  /**
   * What copying these objects of one page takes: { owner, from: { entry, src, index }, items,
   * sources, documents }, to give to pasteObjects(). Each item of the page's own content names the page
   * whose original content it draws from (`from`); `sources` holds the bytes of any picture from a
   * file among them and `documents` those of the PDFs that content is in, so they can be pasted into
   * another document too. EditError when one of them can't be copied.
   */
  async copyObjects(pageNumber, keys) {
    const view = this.#view;
    const { entry, found } = await this.#objectsAt(pageNumber, keys);
    for (const { object } of found) this.#refuse(object, 'copy', found.length);
    const items = found.map(({ object, record }) => snapshotOf(object, record));
    const sources = new Map();
    const documents = new Map();
    const analyses = new Map(); // `${src}:${index}` → the verified analysis of a page they draw from
    for (const item of items) {
      const picture = item.kind === insertedKind ? item.picture : item.replacement;
      if (picture) {
        const bytes = view.sources.get(picture.source);
        if (!bytes) throw new EditError('missing', 'A picture being copied isn’t available any more, so nothing was copied.');
        sources.set(picture.source, bytes);
      }
      if (item.kind === insertedKind || item.kind === newTextKind) continue;
      item.from ??= { src: entry.src, index: entry.index };
      const verified = this.#pages.get(originKey(item.from));
      if (verified) analyses.set(originKey(item.from), verified);
      if (documents.has(item.from.src)) continue;
      const bytes = item.from.src === 'base' ? await view.baseBytes() : view.sources.get(item.from.src);
      if (!bytes) throw new EditError('missing', 'The PDF these objects come from isn’t available any more, so nothing was copied.');
      documents.set(item.from.src, bytes);
    }
    return { owner: view, from: { entry: entry.id, src: entry.src, index: entry.index }, items, sources, documents, analyses };
  }

  /**
   * Pastes what copyObjects() took onto a page, each object moved by `offset` (a page-space transform)
   * from where it was copied: ONE undo step, and the new objects' keys, in the order copied.
   *
   * Text and pictures a page draws are drawn again from that page's ORIGINAL content: on the page they
   * came from or a duplicate of it, by that page's own resources; on any other page, carrying those
   * resources along (objects/copies.js). From another document, that document's PDF is kept in this
   * one's sources, as a PDF pages were inserted from is — refused for a PDF/A document, whose fonts and
   * colours Vellum can't check. A picture put there from a file carries its own image.
   *
   * Pasted on a page other than the one they were copied from, objects that would land wholly off it
   * (a smaller page, an offset crop box) are brought to its middle, together. All or nothing: EditError,
   * with nothing stored, when any of them can't be pasted.
   */
  async pasteObjects(pageNumber, clip, offset = IDENTITY) {
    const view = this.#view;
    const { records, adopt } = await this.#pasted(pageNumber, clip, offset, { fit: true });
    for (const [id, bytes] of adopt) if (!view.sources.has(id)) view.sources.set(id, bytes);
    view.annotations.applyEdits(records.map((r) => [null, r]));
    return records.map(keyOfRecord);
  }

  /**
   * Moves objects of one page onto another page, each moved by `delta` (a transform in the page
   * spaces' shared coordinates): ONE undo step that takes them off their page and puts them, as they
   * are now, on the other — on the terms of copying and pasting them, and only when every one of them
   * may be moved, copied and deleted. Resolves the moved objects' keys on the new page. On the same
   * page this is an ordinary move, and resolves the same keys.
   */
  async moveObjectsToPage(pageNumber, keys, toPageNumber, delta = IDENTITY) {
    const view = this.#view;
    if (toPageNumber === pageNumber) {
      await this.transformObjects(pageNumber, keys.map((key) => ({ key, delta })));
      return [...keys];
    }
    if (!view.shownPlan?.[toPageNumber - 1]) throw new EditError('missing', 'That page isn’t in the document.');
    const { found } = await this.#objectsAt(pageNumber, keys);
    for (const verb of ['move', 'copy', 'delete']) for (const { object } of found) this.#refuse(object, verb, found.length);
    const clip = await this.copyObjects(pageNumber, keys);
    const { records, adopt } = await this.#pasted(toPageNumber, clip, delta, { fit: false });
    // Read last, so nothing is awaited between reading the records and storing what replaces them.
    const removals = await this.#removals(pageNumber, keys);
    for (const [id, bytes] of adopt) if (!view.sources.has(id)) view.sources.set(id, bytes);
    view.annotations.applyEdits([...removals, ...records.map((r) => [null, r])]);
    return records.map(keyOfRecord);
  }

  /**
   * The records pasting `clip` on a page makes, and the bytes this document's sources must `adopt`
   * ([id, bytes]) for them to be written. Nothing is stored here.
   */
  async #pasted(pageNumber, clip, offset, { fit }) {
    const view = this.#view;
    if (view.rebuilding) throw new EditError('busy', 'Vellum is still updating the pages. Try again in a moment.');
    if (!clip?.items?.length) throw new EditError('missing', 'Nothing has been copied.');
    if (!isValid(offset)) throw new EditError('content', 'That change couldn’t be worked out, so nothing was changed.');
    const constraints = await this.#constraints();
    const fonts = await this.#fonts(clip.items.filter((item) => item.kind === newTextKind).flatMap(fontsOf));
    const { entry, analysis } = await this.objects(pageNumber);
    const blocked = analysis?.tainted || analysis?.summary.kind === 'unreadable' ? 'unreadable' : analysis?.unbalanced ? 'structure' : null;
    if (blocked) throw new EditError('not-editable', REASONS[blocked], { reason: blocked });
    const foreign = clip.owner !== view;
    const count = clip.items.length;
    const adopt = new Map();

    // Where each item's content is, in this document's terms, and the object it is drawn from.
    const placed = [];
    for (const item of clip.items) {
      if (item.kind === insertedKind) {
        if (constraints.embeddedFontsOnly) {
          throw new EditError('pdfa', 'This PDF follows the PDF/A archiving standard, and Vellum can’t check that a new picture meets it, so nothing was pasted.');
        }
        const bytes = clip.sources?.get(item.picture.source) ?? view.sources.get(item.picture.source);
        if (!bytes) throw new EditError('missing', 'A picture being pasted isn’t available any more, so nothing was pasted.');
        adopt.set(item.picture.source, bytes);
        placed.push({ item, quad: UNIT_QUAD });
        continue;
      }
      if (item.kind === newTextKind) {
        // New text carries its text and font name, so it goes on any page of any document — but not
        // into a PDF/A one, which needs every font embedded, and not in a font of the PDF it was copied
        // from into another one, where that font isn't.
        if (constraints.embeddedFontsOnly) {
          throw new EditError('pdfa', 'This PDF follows the PDF/A archiving standard, which needs every font embedded. New text is written in a standard font that isn’t, so nothing was pasted.');
        }
        if (foreign && fontsOf(item).some((font) => documentKey(font))) {
          throw new EditError('paste', 'New text written in its own PDF’s fonts can’t be pasted into another document, so nothing was pasted.');
        }
        const [x1, y1, x2, y2] = item.box;
        placed.push({ item, quad: [x1, y1, x2, y1, x2, y2, x1, y2] });
        continue;
      }
      if (!item.from) throw new EditError('paste', 'What was copied can’t be pasted, so nothing was pasted.');
      let src = item.from.src;
      if (foreign) {
        if (constraints.embeddedFontsOnly) {
          throw new EditError('pdfa', 'This PDF follows the PDF/A archiving standard, and Vellum can’t check that text or pictures from another PDF meet it, so nothing was pasted.');
        }
        const bytes = clip.documents?.get(src);
        if (!bytes) throw new EditError('missing', 'The PDF these objects were copied from isn’t available any more, so nothing was pasted.');
        // The same PDF is kept once, however many times something is pasted from it.
        src = [...view.sources].find(([, b]) => b === bytes)?.[0] ?? [...adopt].find(([, b]) => b === bytes)?.[0] ?? newId();
        adopt.set(src, bytes);
        // That document already checked this very page, from these very bytes, against what pdf.js
        // drew: its verified analysis is this page's here too.
        const verified = clip.analyses?.get(originKey(item.from));
        const here = `${src}:${item.from.index}`;
        if (verified?.verified && !this.#pages.has(here)) this.#pages.set(here, verified);
      }
      if (item.replacement) {
        const bytes = clip.sources?.get(item.replacement.source) ?? view.sources.get(item.replacement.source);
        if (!bytes) throw new EditError('missing', 'A picture being pasted isn’t available any more, so nothing was pasted.');
        adopt.set(item.replacement.source, bytes);
      }
      const origin = await this.#origin(src, item.from.index, adopt.get(src));
      const originBlocked = origin.tainted || origin.summary.kind === 'unreadable' ? 'unreadable' : origin.unbalanced ? 'structure' : null;
      if (originBlocked) throw new EditError('not-editable', REASONS[originBlocked], { reason: originBlocked });
      // Drawn from that page's own object, so that object has to allow it still.
      const source = sourceObject(selectableObjects(origin), item);
      if (!source) throw new EditError('missing', 'What was copied isn’t in the page it came from any more, so nothing was pasted.');
      this.#refuse(source, 'copy', count);
      if (item.encoding?.mode === 'standard' && constraints.embeddedFontsOnly) {
        throw new EditError('pdfa', 'This PDF follows the PDF/A archiving standard, which needs every font embedded; this text uses a substitute font, so it wasn’t pasted.');
      }
      if ((item.format?.color !== undefined || item.format?.opacity !== undefined) && constraints.embeddedFontsOnly) throw runFormatError('pdfa');
      // Another face is a font object of the PDF the line was copied in (objects/run-face.js), and of no other.
      if (item.face && (foreign || src !== 'base')) throw runFaceError('source');
      const sameContent = entry.src === src && entry.index === item.from.index;
      placed.push({ item, quad: source.geometry.quad, from: sameContent ? null : { src, index: item.from.index } });
    }

    // Brought onto the page, together, when all of them would land off it.
    let shift = IDENTITY;
    const page = analysis?.box ?? (entry.width && entry.height ? [0, 0, entry.width, entry.height] : null);
    const moved = foreign || clip.from?.entry !== entry.id;
    const bounds = unionBox(placed.map(({ item, quad }) => transformQuad(quad, multiply(item.transform, offset))));
    if (fit && moved && page && bounds && !overlaps(bounds, page)) {
      shift = translate((page[0] + page[2] - bounds[0] - bounds[2]) / 2, (page[1] + page[3] - bounds[1] - bounds[3]) / 2);
    }

    const records = placed.map(({ item, from }) => {
      const transform = quantize(multiply(multiply(item.transform, offset), shift));
      if (!transform) throw new EditError('content', 'That copy couldn’t be worked out, so nothing was pasted.');
      if (item.kind === insertedKind) return planInsertion({ picture: item.picture, transform, entry: entry.id });
      if (item.kind === newTextKind) return planNewText({ fonts, ...item, transform, entry: entry.id });
      return planCopy({ ...item, from, transform, entry: entry.id });
    });
    return { records, adopt: [...adopt] };
  }

  /**
   * The record for one absolute placement — or null when there is nothing left to say, which is
   * what "back where it started" means. Text that was only ever moved has no record without its
   * transform; text that was retyped keeps its own record, untransformed. A replaced picture keeps
   * its replacement wherever it is put, and so keeps its record even back where it started.
   */
  #plan(entry, object, record, absolute, fonts) {
    // A picture put there from a file, new text, or a copy, has no "where it started": its record is where it is.
    if (object.ref.copy) return planCopy({ ...record, transform: absolute });
    if (object.ref.newText) return planNewText({ fonts, ...record, transform: absolute });
    if (object.ref.inserted) return planInsertion({ picture: record.picture, transform: absolute, entry: entry.id, id: record.id });
    if (object.kind !== 'text-run') {
      const replacement = record?.removed ? null : record?.replacement ?? null;
      if (isIdentity(absolute) && !replacement) return null;
      return planImageEdit({ object, transform: absolute, replacement, entry: entry.id, id: record?.id });
    }
    const next = planTextTransform({
      run: record ? null : object.record, record, transform: absolute, entry: entry.id, id: record?.id,
    });
    return !next.transform && !next.format && !next.face && next.encoding?.mode === 'original' ? null : next;
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
    if (isCopyKey(runKey)) return this.#previewCopy(pageNumber, runKey, text);
    if (isNewTextKey(runKey)) return this.#previewNewText(pageNumber, runKey, text);
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

  /** preview() for a pasted copy of text: what retyping it to `text` would do. */
  async #previewCopy(pageNumber, key, text) {
    try {
      const clean = text.replace(/[\r\n\t\f\v]+/g, ' ').normalize('NFC');
      const { glyphs, constraints } = await this.#copyPlanning(pageNumber, [key]);
      const { entry, found: [{ object, record }] } = await this.#objectsAt(pageNumber, [key]);
      const planned = this.#retyped(object, record, clean, glyphsFor(glyphs, record, entry), constraints);
      if (!planned) return { ok: true, mode: 'none', font: null, missing: [] };
      return { ok: true, mode: planned.encoding.mode, font: planned.encoding.font ?? null, missing: planned.encoding.missing ?? [] };
    } catch (err) {
      if (err instanceof EditError) return { ok: false, kind: err.kind, message: err.message };
      throw err;
    }
  }

  /** preview() for new text: 'new' in its standard font, 'none' when emptied, or why it can't be. */
  async #previewNewText(pageNumber, key, text) {
    try {
      const fonts = await this.#fonts();
      const { found: [{ object, record }] } = await this.#objectsAt(pageNumber, [key]);
      const planned = this.#retypedNewText(fonts, object, record, text);
      return planned ? { ok: true, mode: 'new', font: planned.font, missing: [] } : { ok: true, mode: 'none', font: null, missing: [] };
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

  /**
   * The ORIGINAL content of a page of one of this document's PDFs, whether or not the plan still shows
   * it — what a copy with `from` draws from. The verified analysis when that page has been read on
   * screen; otherwise read here, once. `bytes` is the PDF when it isn't in the sources yet (a paste
   * from another document, about to be kept there).
   */
  #origin(src, index, bytes = null) {
    const key = `${src}:${index}`;
    const verified = this.#pages.get(key);
    if (verified) return Promise.resolve(verified);
    if (!this.#origins.has(key)) {
      const pending = this.#source(src, bytes).then((source) => {
        if (!Number.isInteger(index) || index < 0 || index >= source.pageCount) throw new EditError('missing', 'The page these objects come from isn’t in its PDF.');
        return analyzePage(source.page(index));
      });
      pending.catch(() => this.#origins.delete(key));
      this.#origins.set(key, pending);
    }
    return this.#origins.get(key);
  }

  /** The PDF a page comes from (the opened file, or one pages were inserted from), read once. */
  #source(src, given = null) {
    if (!this.#sources.has(src)) {
      const pending = (async () => {
        const lib = await loadPdfLib();
        const bytes = src === 'base' ? await this.#view.baseBytes() : this.#view.sources.get(src) ?? given;
        if (!bytes) throw new EditError('missing', 'The PDF these pages came from is no longer available.');
        return openSource(lib, bytes);
      })();
      pending.catch(() => this.#sources.delete(src)); // a failure may be temporary: try again next time
      this.#sources.set(src, pending);
    }
    return this.#sources.get(src);
  }
}

/**
 * Of the lines with matches ([{ line, matches }]), the one drawn under `point` (where it is now, moved
 * or not), and in it the match nearest the point along the line: { line, match }, or null.
 */
function nearestLine(found, point) {
  let best = null;
  for (const { line, matches } of found) {
    const { quad } = line;
    if (!quad) continue;
    const [ux, uy, vx, vy] = [quad[2] - quad[0], quad[3] - quad[1], quad[6] - quad[0], quad[7] - quad[1]];
    const [px, py] = [point[0] - quad[0], point[1] - quad[1]];
    const along = (px * ux + py * uy) / Math.max(1e-9, ux * ux + uy * uy);
    const across = (px * vx + py * vy) / Math.max(1e-9, vx * vx + vy * vy);
    // How far outside the line's box the point is, in line heights (0 inside it).
    const outside = Math.max(0, -along, along - 1) * Math.hypot(ux, uy) / Math.max(1e-9, Math.hypot(vx, vy)) + Math.max(0, -across, across - 1);
    if (outside > 1 || (best && outside >= best.outside)) continue;
    best = { line, outside, match: nearestMatch(line.text, matches, Math.min(1, Math.max(0, along))) };
  }
  return best && { line: best.line, match: best.match };
}

/**
 * Why a match found in a paragraph's lines (`group`, from #lineGroups) can't be replaced there, or null
 * when it can: only a match that runs on from one line to the very next, leaving neither line empty.
 */
function crossLineRefusal(group, offsets, m, replacement) {
  if (m.first === m.last) return null;
  if (m.last - m.first > 1) return 'Vellum replaces a match across two lines of a paragraph, not more.';
  const before = group[m.first].text.slice(0, m.start - offsets[m.first]) + replacement;
  const after = group[m.last].text.slice(m.end - offsets[m.last]);
  if (!before.trim() || !after.trim()) return 'A match across two lines that takes up a whole line isn’t replaced: it would leave an empty line in the paragraph.';
  return null;
}

/**
 * Matches (from replaceText) as the units they are retyped in: all the matches of one line, and of the
 * lines a match runs across, together. Each unit is changed whole, or left whole.
 */
function replacementUnits(found) {
  const units = [];
  const byGroup = new Map();
  for (const f of found) byGroup.set(f.group, [...(byGroup.get(f.group) ?? []), f]);
  for (const list of byGroup.values()) {
    let unit = null;
    let last = -1;
    for (const f of list.sort((a, b) => a.m.start - b.m.start)) {
      if (!unit || f.m.first > last) units.push(unit = []);
      unit.push(f);
      last = Math.max(last, f.m.last);
    }
  }
  return units;
}

/** The object of a page (`objects`) that a copy's record or clip item draws again, or null. */
const sourceObject = (objects, item) => {
  const key = item.kind === textCopyKind ? `run:${item.target.key}` : item.target.key;
  return objects?.find((o) => o.ref.key === key) ?? null;
};

/** Is this object key a pasted copy's? (A run key is `<show>:<glyph>`, never this.) */
const isCopyKey = (key) => typeof key === 'string' && key.startsWith('copy:');

/** The glyph data #copyPlanning read for the PDF a copy's run is in; EditError when it read another. */
const glyphsFor = (glyphs, record, entry) => {
  const found = glyphs.get(record?.from?.src ?? entry.src);
  if (!found) throw new EditError('changed', 'That text changed while it was being retyped, so nothing was changed.');
  return found;
};

/** The object-model key of a record pasted or moved onto a page. */
const keyOfRecord = (r) => (r.kind === insertedKind ? insertedKey(r) : r.kind === newTextKind ? newTextKey(r) : copyKey(r));

/** Is this object key new text's? */
const isNewTextKey = (key) => typeof key === 'string' && key.startsWith('text:');

const UNIT_QUAD = Object.freeze([0, 0, 1, 0, 1, 1, 0, 1]);

/** Do two boxes [x1, y1, x2, y2] share any area? */
const overlaps = (a, b) => a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3];

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
