// How new text (objects/inserted-text.js) is formatted and laid out, apart from how it is written.
//
//   format: { font, size, underline, align, color, opacity, width }
//     font        a font by its name; today one of the standard PDF fonts, whose bold and italic are
//                 the family's own faces (styledFont) — never a synthesized slant or a thicker stroke
//     size        points
//     underline   true or false: a filled rule under each line, in the text's colour
//     align       'left' | 'center' | 'right', within the box
//     color       '#rrggbb', the fill colour
//     opacity     0.05–1, the fill opacity (an ExtGState's /ca)
//     width       null: each line as wide as it is typed; a number: the box's width in points, lines
//                 wrapping at spaces to fit it (a word wider than the box is broken between characters)
//
// Layout only asks a `face` what it measures — { name, ascent, descent, underline: { position,
// thickness } (all per point of size), missing(text), advance(text) (per point of size), codes(text) } —
// so a font read from a file by a font parser (docs/VELLUM_VISION.md §4.3) can be laid out the same way
// by supplying another face. standardFace() is the face of a standard PDF font, from pdf-lib's own
// metrics tables: nothing is fetched, no font file is read.

/** The standard font families new text may be written in, and each one's faces: regular, bold, italic, bold italic. */
const FAMILIES = Object.freeze({
  Helvetica: ['Helvetica', 'Helvetica-Bold', 'Helvetica-Oblique', 'Helvetica-BoldOblique'],
  Times: ['Times-Roman', 'Times-Bold', 'Times-Italic', 'Times-BoldItalic'],
  Courier: ['Courier', 'Courier-Bold', 'Courier-Oblique', 'Courier-BoldOblique'],
});

/**
 * The standard PDF fonts new text may be written in: the Latin ones. Symbol and ZapfDingbats draw
 * pictograms under Latin codes, which is not what a person typing text means.
 */
export const FONTS = Object.freeze(Object.values(FAMILIES).flat());

export const ALIGNS = Object.freeze(['left', 'center', 'right']);

/** Lines are this many times the size apart, baseline to baseline. */
export const LINE_SPACING = 1.2;

export const LIMITS = Object.freeze({ size: [1, 1000], opacity: [0.05, 1], width: [1, 10000] });

export const DEFAULT_FORMAT = Object.freeze({
  font: 'Helvetica', size: 12, underline: false, align: 'left', color: '#000000', opacity: 1, width: null,
});

/** A font's style: its family and whether it is the bold or italic face. Null for a font that isn't one of FONTS. */
export function styleOf(font) {
  for (const [family, faces] of Object.entries(FAMILIES)) {
    const i = faces.indexOf(font);
    if (i >= 0) return { family, bold: (i & 1) === 1, italic: (i & 2) === 2 };
  }
  return null;
}

/** The face of `font`'s family with `bold` and `italic` changed as asked (unchanged when not given); null for an unknown font. */
export function styledFont(font, { bold, italic } = {}) {
  const style = styleOf(font);
  if (!style) return null;
  return FAMILIES[style.family][(bold ?? style.bold ? 1 : 0) + (italic ?? style.italic ? 2 : 0)];
}

const round = (v, digits = 4) => {
  const k = 10 ** digits;
  return Math.round(v * k) / k || 0;
};

const inRange = (v, [lo, hi]) => Number.isFinite(v) && v >= lo && v <= hi;

/**
 * The format a record holds, from what it has (a record from before formatting holds only font and size),
 * or the name of the first field that can't be used. Numbers are rounded here, so a record always holds
 * what the writer will write.
 */
export function formatOf(fields) {
  const f = { ...DEFAULT_FORMAT };
  for (const key of Object.keys(DEFAULT_FORMAT)) if (fields[key] !== undefined) f[key] = fields[key];
  if (typeof f.color === 'string') f.color = f.color.toLowerCase();
  if (typeof f.size === 'number') f.size = round(f.size, 2);
  if (typeof f.opacity === 'number') f.opacity = round(f.opacity, 2);
  if (typeof f.width === 'number') f.width = round(f.width, 2);
  const bad = !FONTS.includes(f.font) ? 'font'
    : !inRange(f.size, LIMITS.size) ? 'size'
      : typeof f.underline !== 'boolean' ? 'underline'
        : !ALIGNS.includes(f.align) ? 'align'
          : !(typeof f.color === 'string' && /^#[0-9a-f]{6}$/.test(f.color)) ? 'color'
            : !inRange(f.opacity, LIMITS.opacity) ? 'opacity'
              : !(f.width === null || inRange(f.width, LIMITS.width)) ? 'width' : null;
  return bad ? { bad } : { format: f };
}

/** '#rrggbb' as PDF colour components, 0–1. */
export const rgbOf = (color) => [1, 3, 5].map((i) => round(parseInt(color.slice(i, i + 2), 16) / 255));

/** A standard PDF font's face, from pdf-lib's metrics. `lib` is pdf-lib. */
export function standardFace(lib, font) {
  const embedder = lib.StandardFontEmbedder.for(font);
  const { encoding } = embedder;
  const metrics = embedder.font;
  return {
    name: font,
    ascent: metrics.Ascender / 1000,
    descent: metrics.Descender / 1000,
    underline: { position: metrics.UnderlinePosition / 1000, thickness: metrics.UnderlineThickness / 1000 },
    /** The characters of `text` the font's standard encoding can't write, each once. */
    missing: (text) => [...new Set([...text].filter((ch) => ch !== '\n' && !encoding.canEncodeUnicodeCodePoint(ch.codePointAt(0))))],
    /** The glyphs' own widths added up — what `Tj` draws, with no kerning, which a `Tj` never applies. */
    advance: (text) => embedder.encodeTextAsGlyphs(text).reduce((sum, glyph) => sum + metrics.getWidthOfGlyph(glyph.name), 0) / 1000,
    /** The font's codes for `text` (every character must be one it has). */
    codes: (text) => [...text].map((ch) => encoding.encodeUnicodeCodePoint(ch.codePointAt(0)).code),
  };
}

/** The pieces a line breaks between: runs of spaces and runs of anything else. */
const pieces = (line) => line.match(/ +|[^ ]+/g) ?? [];

/** Lines of one typed paragraph, each one `fits` (the box's width), without the spaces it wrapped at. */
function wrap(paragraph, fits) {
  const lines = [];
  let line = '';
  for (const piece of pieces(paragraph)) {
    if (piece.startsWith(' ')) {
      line += piece; // spaces never start a wrapped line, and hang past the edge at its end
      continue;
    }
    if (fits(line + piece)) {
      line += piece;
      continue;
    }
    if (line.trim()) lines.push(line.trimEnd());
    line = line.trim() ? '' : line; // a paragraph's own leading spaces stay with its first word
    // A word wider than the box on its own is broken between characters, at least one per line.
    for (const ch of piece) {
      if (line.trim() && !fits(line + ch)) {
        lines.push(line);
        line = '';
      }
      line += ch;
    }
  }
  lines.push(line.trimEnd());
  return lines;
}

/**
 * Lays `text` out in `face`: its lines, each with where its baseline starts in the text's own space
 * (the first line's baseline at y 0, lines below it, y up), and the box they fill: [0, bottom, width, top].
 * Lines break where `text` has line breaks, and — with a width — at spaces to fit it.
 */
export function layoutText(face, { text, size, align = 'left', width = null }) {
  const measure = (s) => face.advance(s.trimEnd()) * size;
  const fits = (s) => measure(s) <= width + 1e-6;
  const lines = text.split('\n').flatMap((paragraph) => (width === null ? [paragraph] : wrap(paragraph, fits)));
  const advances = lines.map(measure);
  const boxWidth = width ?? Math.max(0, ...advances);
  const leading = LINE_SPACING * size;
  const laid = lines.map((line, i) => {
    const spare = boxWidth - advances[i];
    const x = align === 'center' ? spare / 2 : align === 'right' ? spare : 0;
    return { text: line, x: round(x), y: round(-i * leading), advance: round(advances[i]) };
  });
  const box = [0, round(-(lines.length - 1) * leading + face.descent * size), round(boxWidth), round(face.ascent * size)];
  return { lines: laid, box, leading };
}
