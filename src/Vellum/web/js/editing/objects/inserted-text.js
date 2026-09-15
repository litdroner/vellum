// The handler for new text put onto a page in Edit mode: a new object, not a change to text the page
// already draws. Registered in registry.js, which is what makes the `inserted-text` kind writable.
//
//   { id, kind: 'inserted-text', entry,
//     text,                        one line, every character one the font's standard encoding writes
//     font, size,                  a standard PDF font by its PostScript name, and its size in points
//     box: [x1 y1 x2 y2],          the line's extent in its own text space, in points: advance, descent, ascent
//     transform: [a b c d e f] }   text space (the baseline's start at the origin, y up) → the ORIGINAL page's user space
//
// Like a picture put there from a file (inserted-image.js), it has nothing in the page's content to
// fingerprint, so the record itself is the object: its identity is `text:<id>`, `transform` is its whole
// placement, retyping replaces `text` (and `box`, which follows it), deleting removes the record, and
// undo and redo are the edit store's. `transform` is a similarity, exactly as for moved text (edits.js
// textPlacement), so the glyphs are only ever moved, turned and scaled uniformly.
//
// It is drawn AFTER the page's own content, in a graphics state of its own:
//
//   q <transform> cm BT /VlFn <size> Tf 0 g 0 Tc 0 Tw 100 Tz 0 Ts 0 Tr <codes> Tj ET Q
//
// in one of the standard PDF fonts, added under a new /Font name (text-run.js addStandardFont, which never
// reuses a name the page already has). The standard fonts are the ones every PDF reader has, and are not
// embedded — so a PDF/A file, which needs every font embedded, is refused new text. The codes are the
// font's own standard (WinAnsi) encoding; a character it doesn't have is refused, never drawn in another
// font. Nothing already on the page is touched. Choosing another font, and fonts that are embedded, is
// font selection (docs/VELLUM_VISION.md §4.3), which this does not pretend to be.
//
// To the object model it is text (kind 'text-run', page-objects.js insertedTextObject), so selecting,
// moving, scaling, turning, snapping, arranging, copying, deleting and retyping it all go through what
// already exists. It is ordinary page text once saved.

import { EditError, textPlacement, textTransformRefusal } from '../edits.js';
import { REASONS } from '../runs.js';
import { pdfaClaim } from '../source.js';
import { hexString, num, pdfName } from '../content/writer.js';
import { applyLinear, invert, multiply } from '../matrix.js';
import { quantize } from './transform.js';
import { addStandardFont } from './text-run.js';
import { newId } from '../../annotations/model.js';

/** The kind of edit record this handler writes. */
export const kind = 'inserted-text';

/** The object-model key of new text. */
export const keyOf = (record) => `text:${record.id}`;

/** The font new text is written in until font selection exists. */
export const DEFAULT_FONT = 'Helvetica';

/** The size new text starts at, in points. */
export const DEFAULT_SIZE = 12;

/** What new text says until it is typed over. */
export const PLACEHOLDER = 'New text';

/**
 * The standard PDF fonts new text may be written in: the Latin ones. Symbol and ZapfDingbats draw
 * pictograms under Latin codes, which is not what a person typing text means.
 */
export const FONTS = Object.freeze([
  'Helvetica', 'Helvetica-Bold', 'Helvetica-Oblique', 'Helvetica-BoldOblique',
  'Times-Roman', 'Times-Bold', 'Times-Italic', 'Times-BoldItalic',
  'Courier', 'Courier-Bold', 'Courier-Oblique', 'Courier-BoldOblique',
]);

/** Sizes a record may hold, in points. */
const SIZES = [1, 1000];

const listOf = (chars) => chars.map((c) => `“${c}”`).join(', ');

/** One line: line breaks and tabs become spaces, as for retyped text (edits.js planTextEdit). */
export const cleanText = (text) => String(text ?? '').replace(/[\r\n\t\f\v]+/g, ' ').normalize('NFC');

/** The font's standard encoding and its metrics, from pdf-lib's own tables (no font file, nothing fetched). */
const embedderFor = (lib, font) => lib.StandardFontEmbedder.for(font);

/** Characters of `text` the font's standard encoding can't write. */
function missingCharacters(lib, font, text) {
  const { encoding } = embedderFor(lib, font);
  return [...new Set([...text].filter((ch) => !encoding.canEncodeUnicodeCodePoint(ch.codePointAt(0))))];
}

/**
 * The line's extent in its own text space, in points: [0, descent, advance, ascent]. The advance is the
 * glyphs' own widths added up — what `Tj` draws, with no kerning, which a `Tj` never applies.
 */
function boxOf(lib, font, size, text) {
  const embedder = embedderFor(lib, font);
  const advance = embedder.encodeTextAsGlyphs(text).reduce((sum, glyph) => sum + embedder.font.getWidthOfGlyph(glyph.name), 0);
  const scale = size / 1000;
  const round = (v) => Math.round(v * 1e4) / 1e4 || 0;
  return [0, round(embedder.font.Descender * scale), round(advance * scale), round(embedder.font.Ascender * scale)];
}

/**
 * Plans new text: a record, or EditError. Used for new text and for every later change to it (same
 * `id`): retyped, moved, turned or scaled, a record always holds exactly what is drawn and where.
 * `lib` is pdf-lib, whose standard font tables say which characters the font has and how wide they are.
 */
export function planNewText({ lib, text, font = DEFAULT_FONT, size = DEFAULT_SIZE, transform, entry, id = newId() }) {
  const clean = cleanText(text);
  if (!clean.trim()) throw new EditError('content', 'New text needs at least one character.');
  if (!FONTS.includes(font)) throw new EditError('not-editable', REASONS.unsupported, { reason: 'unsupported', font });
  if (!(Number.isFinite(size) && size >= SIZES[0] && size <= SIZES[1])) {
    throw new EditError('content', 'That text size couldn’t be used, so nothing was changed.');
  }
  const missing = missingCharacters(lib, font, clean);
  if (missing.length) {
    throw new EditError('characters', `New text is written in ${font.replace(/-/g, ' ')}, which has no ${listOf(missing)}. Vellum can’t embed another font yet.`, { missing });
  }
  const kept = textPlacement(transform ?? []);
  if (!kept) throw new EditError('content', 'That change to the text couldn’t be worked out, so nothing was changed.');
  const reason = textTransformRefusal(kept);
  if (reason) throw new EditError('not-editable', REASONS[reason], { reason, transform: kept });
  return { id, kind, entry, text: clean, font, size, box: boxOf(lib, font, size, clean), transform: kept };
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

/** One page's new text: nothing patched, one line drawn after the page for each, in its standard font. */
export function write({ lib, doc, page, index, records }) {
  const names = new Map(); // font → its name in this page's /Font resources
  const append = records.map((record) => {
    const unusable = () => new EditError('content', `New text on page ${index + 1} can’t be written as it is, so nothing was changed.`);
    const { text, font, size, transform } = record;
    if (typeof text !== 'string' || !text.trim() || text !== cleanText(text) || !FONTS.includes(font)) throw unusable();
    if (!(Number.isFinite(size) && size >= SIZES[0] && size <= SIZES[1])) throw unusable();
    if (!Array.isArray(transform) || !quantize(transform) || textTransformRefusal(transform)) throw unusable();
    if (missingCharacters(lib, font, text).length) throw unusable();
    if (!names.has(font)) names.set(font, addStandardFont(lib, doc, page, font));
    const { encoding } = embedderFor(lib, font);
    const codes = [...text].map((ch) => encoding.encodeUnicodeCodePoint(ch.codePointAt(0)).code);
    return [
      'q',
      `${transform.map(num).join(' ')} cm`,
      'BT',
      `${pdfName(names.get(font))} ${num(size)} Tf`,
      '0 g',
      '0 Tc 0 Tw 100 Tz 0 Ts 0 Tr',
      `${hexString(codes)} Tj`,
      'ET',
      'Q',
    ].join('\n');
  });
  return { patches: [], append };
}
