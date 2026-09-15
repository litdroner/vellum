// The handler for new text put onto a page in Edit mode: a new object, not a change to text the page
// already draws. Registered in registry.js, which is what makes the `inserted-text` kind writable.
//
//   { id, kind: 'inserted-text', entry,
//     text,                        its lines, separated by line breaks; every character one the font's standard encoding writes
//     font, size, underline,       its format (objects/text-format.js): a standard PDF font by its PostScript name
//     align, color, opacity,       (bold and italic are the family's own faces), the size in points, underline,
//     width,                       alignment, '#rrggbb', fill opacity, and the box's width (null: as typed)
//     box: [x1 y1 x2 y2],          the lines' extent in their own text space, in points (text-format.js layoutText)
//     transform: [a b c d e f] }   text space (the first baseline's start at the origin, y up) → the ORIGINAL page's user space
//
// A record from before formatting holds only font and size: it reads as left-aligned, black, opaque,
// not underlined and as wide as typed, which is what it was drawn as.
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
//     1 0 0 1 <x> <y> Tm <codes> Tj   … one per line …   ET [<underline> re f …] Q
//
// in one of the standard PDF fonts, added under a new /Font name (text-run.js addStandardFont, which never
// reuses a name the page already has), with an ExtGState of its own only when it isn't opaque. Every line
// is real text; an underline is a filled rule under its line. The standard fonts are the ones every PDF
// reader has, and are not embedded — so a PDF/A file, which needs every font embedded, is refused new text.
// The codes are the font's own standard (WinAnsi) encoding; a character it doesn't have is refused, never
// drawn in another font. Nothing already on the page is touched. Its family is chosen from the standard
// families (planFormat with a `family`, text-format.js FAMILY_NAMES) — the part of font selection
// (docs/VELLUM_VISION.md §4.3) that needs no font parser. The document's own fonts and bundled fonts are
// not offered and not pretended to be: they must be measured and embedded, which needs the parser.
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
import { DEFAULT_FORMAT, FAMILY_NAMES, FONTS, formatOf, layoutText, rgbOf, standardFace, styledFont } from './text-format.js';
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

const REFUSED_FAMILY = 'New text can only be written in one of the standard PDF fonts, so nothing was changed.';

/**
 * Plans new text: a record, or EditError. Used for new text and for every later change to it (same
 * `id`): retyped, formatted, moved, turned or scaled, a record always holds exactly what is drawn and where.
 * `lib` is pdf-lib, whose standard font tables say which characters the font has and how wide they are.
 */
export function planNewText({ lib, text, transform, entry, id = newId(), ...fields }) {
  const clean = cleanText(text);
  if (!clean.trim()) throw new EditError('content', 'New text needs at least one character.');
  const { format, bad } = formatOf(fields);
  if (bad === 'font') throw new EditError('not-editable', REASONS.unsupported, { reason: 'unsupported', font: fields.font });
  if (bad) throw new EditError('content', REFUSED_FORMAT[bad] ?? 'That formatting couldn’t be used, so nothing was changed.', { field: bad });
  const face = standardFace(lib, format.font);
  const missing = face.missing(clean);
  if (missing.length) {
    throw new EditError('characters', `New text is written in ${format.font.replace(/-/g, ' ')}, which has no ${listOf(missing)}. Vellum can’t embed another font yet.`, { missing });
  }
  const kept = textPlacement(transform ?? []);
  if (!kept) throw new EditError('content', 'That change to the text couldn’t be worked out, so nothing was changed.');
  const reason = textTransformRefusal(kept);
  if (reason) throw new EditError('not-editable', REASONS[reason], { reason, transform: kept });
  const { box } = layoutText(face, { text: clean, ...format });
  return { id, kind, entry, text: clean, ...format, box, transform: kept };
}

/**
 * New text formatted: `record` planned again with `changes` — any of family (one of FAMILY_NAMES), size,
 * bold, italic (the family's own faces), underline, align, color, opacity and width — its top-left corner
 * staying where it is, so a bigger size or a wider font grows down and to the right. A family keeps the
 * bold and italic the text already has, and its lines are laid out and wrapped again in its own widths.
 * The record, or EditError when the format can't be used.
 */
export function planFormat({ lib, record, changes }) {
  const { family, bold, italic, ...rest } = changes;
  if (family !== undefined && !FAMILY_NAMES.includes(family)) throw new EditError('content', REFUSED_FAMILY, { field: 'font' });
  const font = styledFont(record.font, { family, bold, italic }) ?? record.font;
  const planned = planNewText({ lib, ...record, ...rest, font });
  const shift = record.box[3] - planned.box[3];
  if (!shift) return planned;
  return planNewText({ lib, ...planned, transform: quantize(multiply(translate(0, shift), record.transform)) });
}

/**
 * Where new text of extent `box` (its own text space) goes: centred on the page, upright as the page is
 * shown (`basis`, page-space.js displayBasis, whatever the page's or the view's rotation). `page` is the
 * page's crop box in user space. A transform, or null when there is none.
 */
export function defaultTextPlacement({ box, page, basis }) {
  const back = basis ? invert(basis) : null;
  if (!back || !box || !page) return null;
  // Upright on screen: shown space runs downwards, and text space runs up.
  const linear = multiply([1, 0, 0, -1, 0, 0], back);
  const [cx, cy] = applyLinear(linear, (box[0] + box[2]) / 2, (box[1] + box[3]) / 2);
  return quantize([linear[0], linear[1], linear[2], linear[3], (page[0] + page[2]) / 2 - cx, (page[1] + page[3]) / 2 - cy]);
}

/** A PDF/A file is refused new text: the standard fonts aren't embedded, and PDF/A needs every font embedded. */
export function precheck({ lib, doc, records }) {
  if (records.length && pdfaClaim(lib, doc)) {
    throw new EditError('pdfa', 'This PDF follows the PDF/A archiving standard, which needs every font embedded. New text is written in a standard font that isn’t, so nothing was changed.');
  }
}

/** The fill colour operator for '#rrggbb': a grey as `g`, anything else as `rg`. */
const fillOf = (color) => {
  const [r, g, b] = rgbOf(color);
  return r === g && g === b ? `${num(r)} g` : `${num(r)} ${num(g)} ${num(b)} rg`;
};

/** One page's new text: nothing patched, each drawn after the page, in its standard font. */
export function write({ lib, doc, page, index, records }) {
  const fonts = new Map(); // font → its name in this page's /Font resources
  const states = new Map(); // opacity → its name in this page's /ExtGState resources
  const append = records.map((record) => {
    const unusable = () => new EditError('content', `New text on page ${index + 1} can’t be written as it is, so nothing was changed.`);
    const { text, transform } = record;
    const { format, bad } = formatOf(record);
    if (bad || typeof text !== 'string' || !text.trim() || text !== cleanText(text)) throw unusable();
    if (!Array.isArray(transform) || !quantize(transform) || textTransformRefusal(transform)) throw unusable();
    const face = standardFace(lib, format.font);
    if (face.missing(text).length) throw unusable();
    const { size, opacity, underline, color } = format;
    if (!fonts.has(format.font)) fonts.set(format.font, addStandardFont(lib, doc, page, format.font));
    if (opacity < 1 && !states.has(opacity)) {
      const state = doc.context.register(doc.context.obj({ Type: 'ExtGState', ca: opacity, CA: opacity }));
      states.set(opacity, addResource(lib, doc, page, 'ExtGState', 'VlGS', state));
    }
    const { lines } = layoutText(face, { text, ...format });
    const drawn = lines.filter((line) => line.text.trim());
    const out = ['q', `${transform.map(num).join(' ')} cm`];
    if (opacity < 1) out.push(`${pdfName(states.get(opacity))} gs`);
    out.push('BT', `${pdfName(fonts.get(format.font))} ${num(size)} Tf`, fillOf(color), '0 Tc 0 Tw 100 Tz 0 Ts 0 Tr');
    for (const line of drawn) out.push(`1 0 0 1 ${num(line.x)} ${num(line.y)} Tm`, `${hexString(face.codes(line.text))} Tj`);
    out.push('ET');
    if (underline) {
      const thickness = face.underline.thickness * size;
      for (const line of drawn) {
        const y = line.y + face.underline.position * size - thickness / 2;
        out.push(`${[line.x, y, line.advance, thickness].map((v) => num(Math.round(v * 1e4) / 1e4)).join(' ')} re f`);
      }
    }
    out.push('Q');
    return out.join('\n');
  });
  return { patches: [], append };
}
