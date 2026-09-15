// Copies of objects a page already draws — text runs and pictures — pasted onto that page again.
// Registered in registry.js, which is what makes the two kinds here writable.
//
//   { id, kind: 'text-copy', entry, from?, target: { key, text, glyphs }, text, encoding, transform }
//   { id, kind: 'image-copy', entry, from?, target: { key, stream, opIndex, name, inline, ctm, width, height },
//     transform, replacement? }
//
// A copy is a new object, not a change to the one it was copied from, so it never touches that one:
// nothing is patched, and the copy is drawn AFTER the page's own content, the way moved text and
// inserted pictures are. What it draws is still the file's own, found and checked the same way:
//
//   `target` is the very fingerprint a text or image record keeps (edits.js, image.js targetOf), and
//            is checked against the page's ORIGINAL content every time the document is composed — the
//            run must still have exactly those glyphs, the draw exactly that resource, place and size,
//            or nothing at all is written.
//   text     is drawn by the text writer's own drawText() (text-run.js): the run's font, size,
//            colour, spacing and ExtGStates, with `encoding` exactly as a text record holds it — the
//            file's own glyph codes ('original'), codes proven present in the run's font ('font') or a
//            standard font ('standard'). A copy of retyped text is that retyped text.
//   a picture is drawn by its resource name, with the fill colour and ExtGStates it was drawn with, or
//            with `replacement`'s image when the picture copied had been replaced (image.js embeds it).
//            An inline image has no name to draw it again by, so it can't be copied (capabilities.js).
//   transform is ABSOLUTE and in the ORIGINAL page's user space, applied after the object's own
//            placement, exactly as for a moved object: so moving a copy replaces its transform, and
//            deleting it takes the record away. It is always present; a copy has no "where it started".
//
// A copy on a page that draws the same original content as the page it was copied from — that page,
// or a duplicate of it — draws from that content by the page's own resource names. A copy on any
// other page carries `from: { src, index }`, the page whose ORIGINAL content it draws from (a page of
// the opened file, or of a PDF kept in the document's sources: pages inserted from it, or text and
// pictures pasted from it), whether or not that page is still in the document:
//
//   the page writer reads that page as the file has it, before any page is rewritten (page-writer.js
//   origins), the fingerprint is checked against it, and every resource the copy draws with — its
//   font, image, ExtGStates, and a named colour space or pattern — is added to the destination page's
//   own resources under a name that page doesn't use (importResources), the same objects, never a
//   re-encoding. Anything missing refuses the save; nothing is guessed.
//
// A picture put on a page from a file needs none of this: its record holds everything, so a copy of it
// is simply another inserted-image record (inserted-image.js), which can go on any page.
//
// To the object model a copy is the object it was copied from under a key of its own, `copy:<id>`
// (copiedObject): same kind, geometry and capabilities. Retyping, reflowing and replacing a copy change
// `text` and `encoding`, or `replacement`, in its record and nothing else (session.js).

import { EditError, textPlacement, textTransformRefusal } from '../edits.js';
import { REASONS } from '../runs.js';
import { pdfaClaim } from '../source.js';
import { num, pdfName } from '../content/writer.js';
import { IDENTITY, multiply } from '../matrix.js';
import { determinant, isValid, quantize } from './transform.js';
import { addStandardFont, drawText, encodeStandard, originalItems, replayColour, sameGlyphs } from './text-run.js';
import { embedPictures, replacementOf, targetOf as imageTargetOf, updateResources, verify as verifyImage } from './image.js';
import { kind as insertedKind } from './inserted-image.js';
import { newId } from '../../annotations/model.js';

export const TEXT = 'text-copy';
export const IMAGE = 'image-copy';

/** Is this a kind of record written here? */
export const isCopy = (kind) => kind === TEXT || kind === IMAGE;

/** The object-model key of a copy. */
export const keyOf = (record) => `copy:${record.id}`;

/** Below this (square points) a placement has no usable area. */
const MIN_AREA = 1e-6;

const unusable = () => new EditError('content', 'That copy couldn’t be worked out, so nothing was pasted.');

/**
 * What copying one object takes: plain data, independent of the document's later changes, from which
 * planCopy() makes a record wherever it is pasted. `object` is the object model's (a live one on its
 * page) and `record` its edit record, if it has one — so what is copied is the object as it is NOW:
 * retyped text as retyped, a moved picture where it was moved to, a replaced one with its new image.
 */
export function snapshotOf(object, record = null) {
  if (object.ref.inserted) return { kind: insertedKind, picture: { ...record.picture }, transform: [...record.transform] };
  if (record && isCopy(record.kind)) {
    const { id, entry, ...rest } = record;
    return structuredClone(rest);
  }
  if (object.kind === 'text-run') {
    const run = object.record;
    return structuredClone({
      kind: TEXT,
      target: { key: run.key, text: run.text, glyphs: run.glyphs.map(([s, g]) => [s, g]) },
      text: record?.text ?? run.text,
      encoding: record?.encoding ?? { mode: 'original' },
      transform: record?.transform ?? IDENTITY,
    });
  }
  if (object.kind === 'image') {
    return structuredClone({
      kind: IMAGE,
      target: imageTargetOf(object),
      transform: record?.transform ?? IDENTITY,
      ...(record?.replacement ? { replacement: record.replacement } : {}),
    });
  }
  throw new EditError('not-editable', REASONS.unsupported, { reason: 'unsupported' });
}

/**
 * A copy's record at `transform` (absolute, as a moved object's): for a new copy and for every later
 * change to one (same `id`). EditError when it can't be written.
 */
export function planCopy({ kind, target, text, encoding, replacement = null, transform, entry, from = null, id = newId() }) {
  const kept = kind === TEXT ? textPlacement(transform ?? []) : quantize(transform ?? []);
  if (!kept || !target) throw unusable();
  if (from && !(typeof from.src === 'string' && from.src !== 'blank' && Number.isInteger(from.index) && from.index >= 0)) throw unusable();
  const origin = from ? { from: { src: from.src, index: from.index } } : {};
  if (kind === TEXT) {
    const reason = textTransformRefusal(kept);
    if (reason) throw new EditError('not-editable', REASONS[reason], { reason, transform: kept });
    if (!['original', 'font', 'standard'].includes(encoding?.mode) || typeof text !== 'string') throw unusable();
    return structuredClone({ id, kind, entry, ...origin, target, text, encoding, transform: kept });
  }
  if (kind === IMAGE) {
    if (target.inline || !target.name) throw new EditError('not-editable', REASONS.unsupported, { reason: 'unsupported' });
    if (!(Math.abs(determinant(kept)) >= MIN_AREA)) throw new EditError('not-editable', REASONS.degenerate, { reason: 'degenerate' });
    return structuredClone({ id, kind, entry, ...origin, target, transform: kept, ...(replacement ? { replacement: replacementOf(replacement) } : {}) });
  }
  throw new EditError('unsupported', REASONS.unsupported, { kind });
}

/**
 * A copy as an object on its page: the object it was copied from (`source`, the page's own), under
 * the copy's key, drawn after everything the page has. It can be moved, scaled, turned, deleted, copied,
 * retyped and reflowed (text) or replaced (a picture) on the terms its original can: each of those
 * changes its one record (session.js), which this writer already draws in any encoding or image.
 */
export function copiedObject(source, record, index = 0) {
  return Object.freeze({
    ...source,
    ...(record.kind === TEXT ? { text: record.text } : {}),
    ref: Object.freeze({ ...source.ref, key: keyOf(record), copy: true }),
    order: Object.freeze([Number.MAX_SAFE_INTEGER, index]),
  });
}

/** Copied text: the text writer's own drawing, from the run the copy was made from. */
export const textCopy = Object.freeze({
  kind: TEXT,

  precheck({ lib, doc, records }) {
    if (records.some((e) => e.encoding?.mode === 'standard') && pdfaClaim(lib, doc)) {
      throw new EditError('pdfa', 'This PDF follows the PDF/A archiving standard, which needs every font embedded; a copy that uses a substitute font would break it, so nothing was changed.');
    }
  },

  write({ lib, doc, page, index, analysis: own, records, origins }) {
    const standardFonts = new Map();
    const imports = importer(lib, doc, page, index);
    const append = records.map((record) => {
      const origin = originOf(record, own, origins, index);
      const { analysis } = origin;
      const rename = origin.resources ? (category, name) => imports.take(origin, category, name) : null;
      const run = analysis.runs.find((r) => r.key === record.target?.key);
      if (!run || run.text !== record.target.text || !sameGlyphs(run.glyphs, record.target.glyphs)) {
        throw new EditError('changed', `The text copied on page ${index + 1} isn’t in the file as expected any more, so nothing was changed.`);
      }
      if (!isValid(record.transform) || textTransformRefusal(record.transform)) {
        throw new EditError('content', `Text copied on page ${index + 1} is placed in a way Vellum can’t write, so nothing was changed.`);
      }
      const { mode } = record.encoding ?? {};
      let fontName = run.fontName;
      let items;
      if ((mode === 'original' || mode === 'font') && rename) {
        if (!fontName) throw new EditError('content', `Text pasted on page ${index + 1} has no font Vellum can carry over, so nothing was changed.`);
        fontName = rename('Font', fontName);
      }
      if (mode === 'original') {
        items = originalItems(analysis, run);
      } else if (mode === 'font' && Array.isArray(record.encoding.items)) {
        items = record.encoding.items;
      } else if (mode === 'standard') {
        const name = record.encoding.font;
        if (!standardFonts.has(name)) standardFonts.set(name, addStandardFont(lib, doc, page, name));
        fontName = standardFonts.get(name);
        items = encodeStandard(lib, name, record.text);
      } else {
        throw new EditError('content', `Text copied on page ${index + 1} can’t be written, so nothing was changed.`);
      }
      return drawText(analysis, run, fontName, items, record.transform, rename);
    });
    return { patches: [], append };
  },
});

/** A copied picture: drawn again by its name — or its replacement's — as the page drew it. */
export const imageCopy = Object.freeze({
  kind: IMAGE,

  precheck({ lib, doc, records }) {
    if (records.some((r) => r.replacement) && pdfaClaim(lib, doc)) {
      throw new EditError('pdfa', 'This PDF follows the PDF/A archiving standard, and Vellum can’t check that a new picture meets it, so nothing was changed.');
    }
  },

  prepare({ lib, doc, records, sources }) {
    return embedPictures(lib, doc, records.map((r) => r.replacement), sources);
  },

  write({ lib, doc, page, index, analysis: own, records, prepared, origins }) {
    const imports = importer(lib, doc, page, index);
    const draws = records.map((record) => {
      const origin = originOf(record, own, origins, index);
      const rename = origin.resources ? (category, name) => imports.take(origin, category, name) : null;
      // The same fingerprint and the same refusals as a moved picture, checked again here.
      const image = verifyImage(origin.analysis, record, index);
      if (image.inline || !image.name) throw new EditError('not-editable', REASONS.unsupported, { reason: 'unsupported' });
      const placed = isValid(record.transform) ? multiply(image.ctm, record.transform) : null;
      if (!placed || !isValid(placed) || !(Math.abs(determinant(placed)) >= MIN_AREA)) {
        throw new EditError('content', `A picture copied on page ${index + 1} has no usable placement, so nothing was changed.`);
      }
      const ref = record.replacement ? prepared?.embedded?.get(record.replacement.source) : null;
      if (record.replacement && !ref) throw new EditError('missing', `A picture copied on page ${index + 1} isn’t available, so nothing was changed.`);
      return { image, placed, ref, rename };
    });
    const names = updateResources(lib, doc, page, own, [], draws.filter((d) => d.ref).map((d) => d.ref));
    let next = 0;
    const append = draws.map(({ image, placed, ref, rename }) => {
      const replay = replayColour(image.fill, rename);
      const states = (image.gsNames ?? []).map((name) => `${pdfName(rename ? rename('ExtGState', name) : name)} gs`);
      const name = ref ? names[next++] : rename ? rename('XObject', image.name) : image.name;
      return ['q', ...replay, ...states, `${placed.map(num).join(' ')} cm`, `${pdfName(name)} Do`, 'Q'].join('\n');
    });
    return { patches: [], append };
  },
});

/** The key a page's origin is kept under (page-writer.js origins). */
export const originKey = ({ src, index }) => `${src}:${index}`;

/**
 * What a copy draws from: the page's own original content, or — for a copy with `from` — the origin
 * page the page writer read for it, { key, analysis, resources }. EditError when it wasn't read.
 */
function originOf(record, analysis, origins, index) {
  if (!record.from) return { analysis, resources: null };
  const origin = origins?.get(originKey(record.from));
  if (!origin) throw new EditError('missing', `Text or a picture pasted on page ${index + 1} comes from a page that isn’t available any more, so nothing was changed.`);
  return origin;
}

/** The names imported resources are given on a page, by category. */
const PREFIX = Object.freeze({ Font: 'VlCpF', ExtGState: 'VlCpGS', XObject: 'VlCpIm', ColorSpace: 'VlCpCS', Pattern: 'VlCpP' });

/**
 * Carries resources of origin pages onto one page: take(origin, category, name) is the name this page
 * draws that resource by. The first time, the origin's own entry — the same object, or the same direct
 * value — is added to the page's resources under a name no entry of the page's has, so nothing the
 * page already draws can find something else under it, and no name the page's other writers release
 * is ever one a copy draws. The resources are cloned before being changed, as adding a font to a page
 * clones them: a page may inherit its /Resources, and other pages must not be touched.
 */
function importer(lib, doc, page, index) {
  const { PDFName, PDFDict } = lib;
  const ctx = doc.context;
  const given = new Map();
  return {
    take(origin, category, name) {
      const key = `${origin.key}\n${category}\n${name}`;
      if (given.has(key)) return given.get(key);
      const group = origin.resources.lookup(PDFName.of(category));
      const value = PREFIX[category] && group instanceof PDFDict ? group.get(PDFName.of(name)) : undefined;
      if (!value) {
        throw new EditError('changed', `Something that text or a picture pasted on page ${index + 1} is drawn with isn’t in the page it came from, so nothing was changed.`);
      }
      const inherited = page.node.Resources();
      const resources = inherited ? inherited.clone(ctx) : ctx.obj({});
      const current = resources.lookup(PDFName.of(category));
      const entries = current instanceof PDFDict ? current.clone(ctx) : ctx.obj({});
      let n = 1;
      while (entries.has(PDFName.of(`${PREFIX[category]}${n}`))) n++;
      const local = `${PREFIX[category]}${n}`;
      entries.set(PDFName.of(local), value);
      resources.set(PDFName.of(category), entries);
      page.node.set(PDFName.of('Resources'), resources);
      given.set(key, local);
      return local;
    },
  };
}
