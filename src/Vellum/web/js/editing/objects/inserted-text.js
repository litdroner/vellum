// The handler for new text put onto a page in Edit mode: a new object, not a change to text the page
// already draws. Registered in registry.js, which is what makes the `inserted-text` kind writable.
//
//   { id, kind: 'inserted-text', entry,
//     text,                        its lines, separated by line breaks; every character one its font has
//     font, size, underline,       its format (objects/text-format.js): a font by its key — a standard PDF font or a bundled font
//     align, color, opacity,       (bold and italic are the family's own faces), the size in points, underline,
//     width,                       alignment, '#rrggbb', fill opacity, and the box's width (null: as typed)
//     spans,                       where part of the box reads in another face, size, underline, colour or
//                                  opacity — [{ n, … }] over the text, or absent when it reads alike all through
//     glyphs,                      for a font of the document itself: { key: { character: [code, byteLength, width] } },
//                                  the glyphs pdf.js confirmed it draws that the text is written with (a space it
//                                  doesn't draw [null, 0, width], a gap) — checked against the font when written;
//                                  absent when the text uses no document font
//     box: [x1 y1 x2 y2],          the lines' extent in their own text space, in points (text-format.js layoutText)
//     transform: [a b c d e f] }   text space (the first baseline's start at the origin, y up) → the ORIGINAL page's user space
//
// A record from before formatting holds only font and size: it reads as left-aligned, black, opaque,
// not underlined and as wide as typed, which is what it was drawn as. One from before spans has no
// `spans`, which is a box that reads alike all through — so neither needs converting.
//
// Like a picture put there from a file (inserted-image.js), it has nothing in the page's content to
// fingerprint, so the record itself is the object: its identity is `text:<id>`, `transform` is its whole
// placement, retyping replaces `text` (and `box`, which follows it), formatting replaces its format,
// deleting removes the record, and undo and redo are the edit store's. `transform` is a similarity,
// exactly as for moved text (edits.js textPlacement), so the glyphs are only ever moved, turned and
// scaled uniformly.
//
// It is drawn AFTER the page's own content, in a graphics state of its own:
//
//   q <transform> cm [/VlGSn gs] BT /VlFn <size> Tf <colour> 0 Tc 0 Tw 100 Tz 0 Ts 0 Tr
//     1 0 0 1 <x> <y> Tm <codes> Tj   … one Tm per line, one Tj per piece …   ET [<underline> re f …] Q
//
// each font added under a new /Font name (text-run.js addStandardFont and addResource, which never reuse a
// name the page already has), with an ExtGState of its own only when it isn't opaque. A line that
// reads in several formats is several `Tj`s after its one `Tm` — each `Tj` advances the text position by
// what it drew, so the pieces follow one another — with the face, size, colour or state set again only
// where it changes. Every line is real text; an underline is a filled rule under its piece.
//
// The fonts are a font set's (objects/font-set.js), chosen by family (planFormat with a `family`). The
// standard fonts are the ones every PDF reader has, and are not embedded: their codes are the font's own
// standard (WinAnsi) encoding. A bundled font is embedded once for the document before any page is
// written (prepare), a subset of the glyphs its text shows, which are its glyph ids (Identity-H). A font of
// the document itself is its own font object, added to the page's resources: the codes are the record's
// `glyphs`, each checked against that font first (font-set.js checkedDocumentFaces), and the font program is
// never changed. A character a face doesn't have is refused, never drawn in another font. A PDF/A file is still refused new
// text: the standard fonts aren't embedded, and an embedded subset hasn't been checked against the
// standard. Nothing already on the page is touched.
//
// To the object model it is text (kind 'text-run', page-objects.js insertedTextObject), so selecting,
// moving, scaling, turning, snapping, arranging, copying, deleting and retyping it all go through what
// already exists. It is ordinary page text once saved: its lines are lines of text, its underline a rule.

import { EditError, textPlacement, textTransformRefusal } from '../edits.js';
import { REASONS } from '../runs.js';
import { pdfaClaim } from '../source.js';
import { hexString, num, pdfName } from '../content/writer.js';
import { applyLinear, invert, multiply, translate } from '../matrix.js';
import { quantize } from './transform.js';
import { addResource, addStandardFont } from './text-run.js';
import {
  DEFAULT_FORMAT, FAMILY_NAMES, FONTS, applyChanges, bundledKey, documentKey, formatOf, formatRuns, layoutText, normalizeRuns, remapSpans,
  rgbOf, runRanges,
} from './text-format.js';
import { checkedDocumentFaces, embedBundledFonts, standardFontSet } from './font-set.js';
import { newId } from '../../annotations/model.js';

export { FAMILY_NAMES, FONTS };

/** The kind of edit record this handler writes. */
export const kind = 'inserted-text';

/** The object-model key of new text. */
export const keyOf = (record) => `text:${record.id}`;

/** The font new text is written in until another family is chosen for it. */
export const DEFAULT_FONT = DEFAULT_FORMAT.font;

/** The size new text starts at, in points. */
export const DEFAULT_SIZE = DEFAULT_FORMAT.size;

/** What new text says until it is typed over. */
export const PLACEHOLDER = 'New text';

const listOf = (chars) => chars.map((c) => `“${c}”`).join(', ');

/** Its lines: line breaks kept (as \n), tabs and other breaks become spaces, as for retyped text. */
export const cleanText = (text) => String(text ?? '').replace(/\r\n?/g, '\n').replace(/[\t\f\v\u2028\u2029]+/g, ' ').normalize('NFC');

const REFUSED_FORMAT = {
  size: 'That text size couldn’t be used, so nothing was changed.',
  width: 'That width couldn’t be used, so nothing was changed.',
};

const REFUSED_FAMILY = 'That font isn’t one Vellum can write new text in, so nothing was changed.';
const REFUSED_FACE = 'That font hasn’t got a face in the style asked for, so nothing was changed.';

/** The refusal for a format field that can't be used, wherever it was asked for. */
const refuseFormat = (bad, fields = {}) => (bad === 'font'
  ? new EditError('not-editable', REASONS.unsupported, { reason: 'unsupported', font: fields.font })
  : new EditError('content', REFUSED_FORMAT[bad] ?? 'That formatting couldn’t be used, so nothing was changed.', { field: bad }));

/** Every font key a record's text is written in: the box's own and its spans'. */
export const fontsOf = (record) => [record.font, ...(Array.isArray(record.spans) ? record.spans.map((s) => s?.font).filter(Boolean) : [])];

/**
 * Plans new text: a record, or EditError. Used for new text and for every later change to it (same
 * `id`): retyped, formatted, moved, turned or scaled, a record always holds exactly what is drawn and where.
 * `fonts` is the font set (objects/font-set.js) whose faces say which characters a font has and how wide
 * they are — the standard fonts from `lib`, pdf-lib, when not given. `spans` (objects/text-format.js) is
 * where part of the box reads differently; it is normalized here, so a record always holds the one set of
 * fields that says what it reads as.
 */
export function planNewText({ lib, fonts = standardFontSet(lib), text, transform, entry, id = newId(), spans = null, glyphs: _glyphs, ...fields }) {
  const clean = cleanText(text);
  if (!clean.trim()) throw new EditError('content', 'New text needs at least one character.');
  const { format, bad } = formatOf(fields);
  if (bad) throw refuseFormat(bad, fields);
  const { runs, bad: badSpan } = formatRuns(clean, format, spans);
  if (badSpan) throw refuseFormat(badSpan, fields);
  const faces = fonts.face;
  const glyphs = {}; // a document font's key → the glyphs this text is written with (objects/font-set.js)
  // Every stretch of the box is written in its OWN face, so each is checked against that face alone.
  for (const range of runRanges(runs)) {
    const face = faces(range.format.font);
    if (face?.document) {
      const part = clean.slice(range.start, range.end);
      const missing = face.missing(part);
      if (missing.length) {
        throw new EditError('characters', `${face.name} is this PDF’s own font, and Vellum can only write the characters it has seen the document draw in it — not ${listOf(missing)} — so nothing was changed.`, { missing });
      }
      glyphs[range.format.font] = { ...glyphs[range.format.font], ...face.glyphs(part) };
    }
    if (!face) throw new EditError('content', REFUSED_FAMILY, { field: 'font', font: range.format.font });
    if (face.refusal) throw new EditError('font', face.refusal, { font: range.format.font });
    const unshaped = face.unshaped?.(clean.slice(range.start, range.end)) ?? [];
    if (unshaped.length) {
      throw new EditError('characters', `Vellum can’t write ${listOf(unshaped)} in ${face.name} yet: that script needs its letters shaped together, so nothing was changed.`, { missing: unshaped });
    }
    const missing = face.missing(clean.slice(range.start, range.end));
    if (missing.length) {
      throw new EditError('characters', `New text is written in ${face.name.replace(/-/g, ' ')}, which has no ${listOf(missing)}, so nothing was changed.`, { missing });
    }
  }
  const kept = textPlacement(transform ?? []);
  if (!kept) throw new EditError('content', 'That change to the text couldn’t be worked out, so nothing was changed.');
  const reason = textTransformRefusal(kept);
  if (reason) throw new EditError('not-editable', REASONS[reason], { reason, transform: kept });
  const normal = normalizeRuns(runs);
  const { box } = layoutText(faces, { text: clean, spans: normal.spans, ...normal.format });
  // Kept in the order the text first uses each character, so the same text and fonts always make the same record.
  const keptGlyphs = Object.keys(glyphs).length
    ? Object.fromEntries(Object.keys(glyphs).sort().map((key) => [key, Object.fromEntries(Object.entries(glyphs[key]).sort(([a], [b]) => clean.indexOf(a) - clean.indexOf(b)))]))
    : null;
  return {
    id, kind, entry, text: clean, ...normal.format, ...(normal.spans ? { spans: normal.spans } : {}), ...(keptGlyphs ? { glyphs: keptGlyphs } : {}), box, transform: kept,
  };
}

/**
 * New text formatted: `record` planned again with `changes` — any of family (the id of one of the font set's families), size,
 * bold, italic (the family's own faces), underline, align, color, opacity and width — its top-left corner
 * staying where it is, so a bigger size or a wider font grows down and to the right. A family keeps the
 * bold and italic the text already has, and its lines are laid out and wrapped again in its own widths.
 *
 * `range` ([from, to) over the text) formats only that much of the box, leaving the rest as it reads:
 * the face, size, underline, colour and opacity are each character's own (objects/text-format.js spans),
 * while alignment and width are the box's and always apply to all of it. `text` retypes the box in the
 * same step, carrying the formatting of what stayed and giving what was typed the format around it — so
 * typing and formatting from the open editor is one record and one undo step.
 *
 * The record, or EditError when the format can't be used.
 */
export function planFormat({ lib, fonts = standardFontSet(lib), record, changes, range = null, text }) {
  const known = changes.family === undefined || fonts.families.some((f) => f.id === changes.family);
  if (!known) throw new EditError('content', REFUSED_FAMILY, { field: 'font' });
  const { format, bad } = formatOf(record);
  if (bad) throw refuseFormat(bad, record);
  const retyped = text === undefined ? null : cleanText(text);
  const next = retyped === null || retyped === record.text ? record.text : retyped;
  const carried = next === record.text ? record.spans ?? null : remapSpans(record.text, next, record.spans ?? null);
  const applied = applyChanges(next, format, carried, changes, range, fonts.families);
  if (applied.bad === 'font') {
    const face = changes.bold !== undefined || changes.italic !== undefined || changes.family !== undefined;
    throw new EditError('content', face ? REFUSED_FACE : REFUSED_FAMILY, { field: 'font' });
  }
  if (applied.bad) throw refuseFormat(applied.bad, changes);
  const planned = planNewText({ lib, fonts, ...record, text: next, spans: applied.spans, ...applied.format });
  const shift = record.box[3] - planned.box[3];
  if (!shift) return planned;
  return planNewText({ lib, fonts, ...planned, transform: quantize(multiply(translate(0, shift), record.transform)) });
}

/**
 * Where new text of extent `box` (its own text space) goes: centred on the page, upright as the page is
 * shown (`basis`, page-space.js displayBasis, whatever the page's or the view's rotation). `page` is the
 * page's crop box in user space. Given `at`, a user-space point (where the page was right-clicked), the
 * box's top-left corner as shown goes there instead, moved back onto the page where it would run off.
 * A transform, or null when there is none.
 */
export function defaultTextPlacement({ box, page, basis, at = null }) {
  const back = basis ? invert(basis) : null;
  if (!back || !box || !page) return null;
  // Upright on screen: shown space runs downwards, and text space runs up.
  const linear = multiply([1, 0, 0, -1, 0, 0], back);
  if (at) {
    // In shown axes the box is as wide and tall as in its own space, with its top-left at `at`.
    const corners = [[page[0], page[1]], [page[2], page[3]]].map(([x, y]) => applyLinear(basis, x, y));
    const [left, right] = [Math.min(corners[0][0], corners[1][0]), Math.max(corners[0][0], corners[1][0])];
    const [top, bottom] = [Math.min(corners[0][1], corners[1][1]), Math.max(corners[0][1], corners[1][1])];
    const within = (v, lo, hi) => (hi < lo ? lo : Math.min(Math.max(v, lo), hi));
    const [sx, sy] = applyLinear(basis, at[0], at[1]);
    const [ux, uy] = applyLinear(back, within(sx, left, right - (box[2] - box[0])), within(sy, top, bottom - (box[3] - box[1])));
    const [lx, ly] = applyLinear(linear, box[0], box[3]);
    return quantize([linear[0], linear[1], linear[2], linear[3], ux - lx, uy - ly]);
  }
  const [cx, cy] = applyLinear(linear, (box[0] + box[2]) / 2, (box[1] + box[3]) / 2);
  return quantize([linear[0], linear[1], linear[2], linear[3], (page[0] + page[2]) / 2 - cx, (page[1] + page[3]) / 2 - cy]);
}

/** A PDF/A file is refused new text: the standard fonts aren't embedded, and PDF/A needs every font embedded. */
export function precheck({ lib, doc, records }) {
  if (records.length && pdfaClaim(lib, doc)) {
    throw new EditError('pdfa', 'This PDF follows the PDF/A archiving standard, which needs every font embedded. New text is written in a standard font that isn’t, so nothing was changed.');
  }
}

/** The bundled fonts the records are written in, embedded once for the whole document (objects/font-set.js). */
export function prepare({ lib, doc, records }) {
  return embedBundledFonts(lib, doc, records.flatMap(fontsOf).filter((font) => bundledKey(font)));
}

/** The fill colour operator for '#rrggbb': a grey as `g`, anything else as `rg`. */
const fillOf = (color) => {
  const [r, g, b] = rgbOf(color);
  return r === g && g === b ? `${num(r)} g` : `${num(r)} ${num(g)} ${num(b)} rg`;
};

/** One page's new text: nothing patched, each drawn after the page, in its own fonts. `prepared` is prepare()'s. */
export function write({ lib, doc, source, page, index, records, prepared = null }) {
  const fonts = new Map(); // font → its name in this page's /Font resources
  const states = new Map(); // opacity → its name in this page's /ExtGState resources
  const refs = new Map(); // a document font → its object, once a record's glyphs have been checked against it
  const standard = standardFontSet(lib);
  const nameFor = (font) => {
    if (!fonts.has(font)) {
      const ref = refs.get(font) ?? prepared?.get(font)?.font.ref;
      fonts.set(font, ref ? addResource(lib, doc, page, 'Font', 'VlF', ref) : addStandardFont(lib, doc, page, font));
    }
    return pdfName(fonts.get(font));
  };
  const stateFor = (opacity) => {
    if (!states.has(opacity)) {
      const state = doc.context.register(doc.context.obj({ Type: 'ExtGState', ca: opacity, CA: opacity }));
      states.set(opacity, addResource(lib, doc, page, 'ExtGState', 'VlGS', state));
    }
    return pdfName(states.get(opacity));
  };
  const append = records.map((record) => {
    const unusable = () => new EditError('content', `New text on page ${index + 1} can’t be written as it is, so nothing was changed.`);
    const { text, transform, spans = null } = record;
    const { format, bad } = formatOf(record);
    if (bad || typeof text !== 'string' || !text.trim() || text !== cleanText(text)) throw unusable();
    if (!Array.isArray(transform) || !quantize(transform) || textTransformRefusal(transform)) throw unusable();
    // A record always says exactly how every one of its characters reads: one that doesn't is never written.
    if (spans !== null && (!Array.isArray(spans)
      || spans.reduce((n, s) => n + (Number.isFinite(s?.n) ? Math.floor(s.n) : NaN), 0) !== text.length)) throw unusable();
    const { runs, bad: badSpan } = formatRuns(text, format, spans);
    if (badSpan) throw unusable();
    // A document font draws only the glyphs the record was planned with, each checked against the font here.
    const own = [...new Set(runs.map((r) => r.format.font))].filter((font) => documentKey(font));
    const checked = own.length ? checkedDocumentFaces(lib, source, record, own) : new Map();
    if (!checked) throw unusable();
    for (const [font, { ref }] of checked) refs.set(font, ref);
    const faces = (font) => checked.get(font)?.face ?? standard.face(font) ?? prepared?.get(font)?.face ?? null;
    for (const range of runRanges(runs)) {
      const face = faces(range.format.font);
      const part = text.slice(range.start, range.end);
      if (!face || face.refusal || face.missing(part).length || face.unshaped?.(part).length) throw unusable();
    }
    const { lines } = layoutText(faces, { text, spans, ...format });
    const drawn = lines.filter((line) => line.text.trim());
    const first = drawn[0]?.pieces[0]?.format ?? format;
    const out = ['q', `${transform.map(num).join(' ')} cm`];
    // The state the box opens in is its first piece's, set where it always was; anything else the box
    // reads in is set again where it changes, which for a box that reads alike all through is nowhere.
    if (first.opacity < 1) out.push(`${stateFor(first.opacity)} gs`);
    out.push('BT', `${nameFor(first.font)} ${num(first.size)} Tf`, fillOf(first.color), '0 Tc 0 Tw 100 Tz 0 Ts 0 Tr');
    let now = { font: first.font, size: first.size, color: first.color, opacity: first.opacity };
    for (const line of drawn) {
      out.push(`1 0 0 1 ${num(line.x)} ${num(line.y)} Tm`);
      for (const piece of line.pieces) {
        const f = piece.format;
        if (!piece.text) continue;
        if (f.opacity !== now.opacity) out.push(`${stateFor(f.opacity)} gs`);
        if (f.font !== now.font || f.size !== now.size) out.push(`${nameFor(f.font)} ${num(f.size)} Tf`);
        if (f.color !== now.color) out.push(fillOf(f.color));
        now = { font: f.font, size: f.size, color: f.color, opacity: f.opacity };
        const face = faces(f.font);
        out.push(face.show ? face.show(piece.text) : `${hexString(face.codes(piece.text))} Tj`);
      }
    }
    out.push('ET');
    for (const line of drawn) {
      const limit = line.x + line.advance; // the spaces a line ends with are never underlined
      for (const piece of line.pieces) {
        const f = piece.format;
        if (!f.underline) continue;
        const face = faces(f.font);
        const thickness = face.underline.thickness * f.size;
        const width = Math.min(piece.x + piece.advance, limit) - piece.x;
        if (!(width > 0) || !(thickness > 0)) continue;
        if (f.opacity !== now.opacity) out.push(`${stateFor(f.opacity)} gs`);
        if (f.color !== now.color) out.push(fillOf(f.color));
        now = { ...now, color: f.color, opacity: f.opacity };
        const y = line.y + face.underline.position * f.size - thickness / 2;
        out.push(`${[piece.x, y, width, thickness].map((v) => num(Math.round(v * 1e4) / 1e4)).join(' ')} re f`);
      }
    }
    out.push('Q');
    return out.join('\n');
  });
  return { patches: [], append };
}
