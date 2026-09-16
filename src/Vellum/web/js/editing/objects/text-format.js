// How new text (objects/inserted-text.js) is formatted and laid out, apart from how it is written.
//
//   format: { font, size, underline, align, color, opacity, width }
//     font        a font by its key (isFontKey): a standard PDF font by its PostScript name, or a font
//                 bundled with Vellum as 'bundled:<family>/<style>', or a font of the document itself as
//                 'doc:<object>-<generation>' (objects/font-set.js). Its family is
//                 chosen (styledFont with a `family`) and its bold and italic are the family's own faces —
//                 never a synthesized slant or a thicker stroke
//     size        points
//     underline   true or false: a filled rule under each line, in the text's colour
//     align       'left' | 'center' | 'right', within the box
//     color       '#rrggbb', the fill colour
//     opacity     0.05–1, the fill opacity (an ExtGState's /ca)
//     width       null: each line as wide as it is typed; a number: the box's width in points, lines
//                 wrapping at spaces to fit it (a word wider than the box is broken between characters)
//
// One box may be formatted a word at a time. The format above is the WHOLE box's, and `spans` says where
// part of it reads differently:
//
//   spans: [{ n, font?, size?, underline?, color?, opacity? }, …]
//     n           how many characters of the box's text this span covers, in order; the spans always
//                 add up to exactly the text's length (a record is normalized, formatRuns clamps one
//                 that doesn't). A field a span doesn't name is the box's own.
//     null        the box reads in one format all through — which is what every record held before
//                 spans existed, so an older record needs no conversion.
//
// SPAN_FIELDS are the per-character ones: the face, its size, underline, colour and opacity. `align` and
// `width` belong to the box (a line is aligned, a box wraps), so they are never a span's. Records are kept
// in a normal form (normalizeRuns): adjacent runs that read alike are one, a field every run shares is the
// box's own rather than an override, and a box that reads alike all through has no `spans` at all.
//
// Layout only asks a `face` what it measures — { name, ascent, descent, underline: { position,
// thickness } (all per point of size), missing(text), advance(text) (per point of size) } — and the
// writer asks it for what a `Tj` shows: codes(text), the font's own codes, or show(text), the operand
// itself. layoutText() takes either one face or a face resolver (a font key → its face), which is what
// lets one box mix faces. standardFace() is the face of a standard PDF font, from pdf-lib's own metrics
// tables: nothing is fetched, no font file is read. A bundled font's face is read by fontkit
// (objects/font-set.js), and plugs into the same resolver under its own key.
//
// A family is { id, name, faces: [regular, bold, italic, bold italic] } — each a font key, or null
// when the family hasn't got that face. STANDARD_FAMILIES are the standard ones; a font set
// (objects/font-set.js) adds the bundled ones, and every function that chooses a face takes the
// families it chooses among.

/** The standard font families new text may be written in, and each one's faces: regular, bold, italic, bold italic. */
export const FAMILIES = Object.freeze({
  Helvetica: ['Helvetica', 'Helvetica-Bold', 'Helvetica-Oblique', 'Helvetica-BoldOblique'],
  Times: ['Times-Roman', 'Times-Bold', 'Times-Italic', 'Times-BoldItalic'],
  Courier: ['Courier', 'Courier-Bold', 'Courier-Oblique', 'Courier-BoldOblique'],
});

/**
 * The standard PDF fonts new text may be written in: the Latin ones. Symbol and ZapfDingbats draw
 * pictograms under Latin codes, which is not what a person typing text means.
 */
export const FONTS = Object.freeze(Object.values(FAMILIES).flat());

/**
 * The families a font selector offers for new text, in the order it lists them. Only the standard PDF
 * fonts are here: the document's own fonts and bundled fonts (docs/VELLUM_VISION.md §4.3, §4.4) need a
 * font parser to be measured and embedded, which the repository doesn't have, so they aren't offered.
 */
export const FAMILY_NAMES = Object.freeze(Object.keys(FAMILIES));

/** The standard families as families: { id, name, faces }, id and name both the family's own name. */
export const STANDARD_FAMILIES = Object.freeze(Object.entries(FAMILIES).map(([id, faces]) => Object.freeze({ id, name: id, faces })));

/** A face's style, as a bundled font's key names it: regular, bold, italic, bold italic — the faces' order. */
export const STYLES = Object.freeze(['regular', 'bold', 'italic', 'bold-italic']);

const BUNDLED_KEY = /^bundled:([a-z0-9]+(?:-[a-z0-9]+)*)\/(regular|bold|italic|bold-italic)$/;

/** A bundled font's key read: { family, style } (family the family's id), or null for any other key. */
export function bundledKey(font) {
  const match = typeof font === 'string' ? BUNDLED_KEY.exec(font) : null;
  return match ? { family: `bundled:${match[1]}`, style: match[2] } : null;
}

const DOCUMENT_KEY = /^doc:(\d+)-(\d+)$/;

/** A document font's key ('doc:<object>-<generation>') read: { ref: '12 0 R', objectNumber, generation }, or null. */
export function documentKey(font) {
  const match = typeof font === 'string' ? DOCUMENT_KEY.exec(font) : null;
  return match ? { ref: `${match[1]} ${match[2]} R`, objectNumber: Number(match[1]), generation: Number(match[2]) } : null;
}

/**
 * Can a record name this font: a standard PDF font, a bundled font's key, or a font of the document
 * (objects/font-set.js)? Whether it is there is the font set's to say.
 */
export const isFontKey = (font) => FONTS.includes(font) || Boolean(bundledKey(font)) || Boolean(documentKey(font));

export const ALIGNS = Object.freeze(['left', 'center', 'right']);

/** Lines are this many times the size apart, baseline to baseline. */
export const LINE_SPACING = 1.2;

export const LIMITS = Object.freeze({ size: [1, 1000], opacity: [0.05, 1], width: [1, 10000] });

export const DEFAULT_FORMAT = Object.freeze({
  font: 'Helvetica', size: 12, underline: false, align: 'left', color: '#000000', opacity: 1, width: null,
});

/** The format fields one span of a box may differ in; the rest (align, width) are the box's own. */
export const SPAN_FIELDS = Object.freeze(['font', 'size', 'underline', 'color', 'opacity']);

/**
 * A font's style: its family (the family's id) and whether it is the bold or italic face. A bundled
 * font's key says its own; any other font is looked for in `families`. Null for a font that is neither.
 */
export function styleOf(font, families = STANDARD_FAMILIES) {
  for (const { id, faces } of families) {
    const i = faces.indexOf(font);
    if (i >= 0) return { family: id, bold: (i & 1) === 1, italic: (i & 2) === 2 };
  }
  const bundled = bundledKey(font);
  if (!bundled) return null;
  const i = STYLES.indexOf(bundled.style);
  return { family: bundled.family, bold: (i & 1) === 1, italic: (i & 2) === 2 };
}

/**
 * The face asked for: `font`'s own family, or `family` when another one is named (choosing a font), with
 * `bold` and `italic` changed as asked and kept as they are when not given. Null for a font or a family
 * that isn't one of `families`, or a face the family hasn't got — nothing is ever substituted.
 */
export function styledFont(font, { family, bold, italic } = {}, families = STANDARD_FAMILIES) {
  const style = styleOf(font, families);
  const faces = families.find((f) => f.id === (family ?? style?.family))?.faces;
  if (!style || !faces) return null;
  return faces[(bold ?? style.bold ? 1 : 0) + (italic ?? style.italic ? 2 : 0)] ?? null;
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
  const bad = !isFontKey(f.font) ? 'font'
    : !inRange(f.size, LIMITS.size) ? 'size'
      : typeof f.underline !== 'boolean' ? 'underline'
        : !ALIGNS.includes(f.align) ? 'align'
          : !(typeof f.color === 'string' && /^#[0-9a-f]{6}$/.test(f.color)) ? 'color'
            : !inRange(f.opacity, LIMITS.opacity) ? 'opacity'
              : !(f.width === null || inRange(f.width, LIMITS.width)) ? 'width' : null;
  return bad ? { bad } : { format: f };
}

/** Do two formats read the same, character for character? (align and width are the box's, not a span's.) */
export const sameSpanFormat = (a, b) => SPAN_FIELDS.every((key) => a[key] === b[key]);

/** Adjacent runs that read alike, joined. */
const merge = (runs) => runs.reduce((out, run) => {
  const last = out.at(-1);
  if (last && sameSpanFormat(last.format, run.format)) last.n += run.n;
  else if (run.n > 0 || !out.length) out.push({ n: run.n, format: run.format });
  return out;
}, []);

/**
 * How every character of `text` reads: [{ n, format }], each run's FULL format, adding up to exactly
 * `text.length`. `base` is the box's format and `spans` its overrides (null: it reads alike all through).
 * `{ bad: field }` when a span names a field a format can't hold — spans that don't add up are clamped,
 * so a record stored by another version is read rather than lost.
 */
export function formatRuns(text, base, spans) {
  const len = String(text ?? '').length;
  const { format: box, bad: badBox } = formatOf(base ?? {});
  if (badBox) return { bad: badBox };
  if (spans === null || spans === undefined) return { runs: [{ n: len, format: box }] };
  if (!Array.isArray(spans)) return { bad: 'spans' };
  const runs = [];
  let used = 0;
  for (const span of spans) {
    if (!span || typeof span !== 'object' || Array.isArray(span)) return { bad: 'spans' };
    for (const key of Object.keys(span)) if (key !== 'n' && !SPAN_FIELDS.includes(key)) return { bad: 'spans' };
    const { format, bad } = formatOf({ ...box, ...span });
    if (bad) return { bad };
    if (!Number.isFinite(span.n)) return { bad: 'spans' };
    const n = Math.min(Math.floor(span.n), len - used);
    if (n <= 0) continue;
    runs.push({ n, format });
    used += n;
    if (used >= len) break;
  }
  if (used < len) runs.push({ n: len - used, format: box }); // what the spans leave uncovered is the box's own
  if (!runs.length) runs.push({ n: len, format: box });
  return { runs: merge(runs) };
}

/**
 * Runs as a record holds them: the box's own format — for each field, what MOST of its characters read
 * in, so the format bar over the whole box shows what it mostly is — and the rest as overrides, or null
 * when the box reads alike all through. The normal form: two records that read the same hold the same
 * fields, which is what lets a format that changes nothing be seen as one.
 */
export function normalizeRuns(runs) {
  const merged = merge(runs);
  const format = { ...merged[0].format };
  for (const key of SPAN_FIELDS) {
    const totals = new Map();
    for (const run of merged) totals.set(run.format[key], (totals.get(run.format[key]) ?? 0) + run.n);
    for (const [value, n] of totals) if (n > totals.get(format[key])) format[key] = value;
  }
  if (merged.length < 2) return { format, spans: null };
  const spans = merged.map((run) => {
    const span = { n: run.n };
    for (const key of SPAN_FIELDS) if (run.format[key] !== format[key]) span[key] = run.format[key];
    return span;
  });
  return { format, spans };
}

/** Where each run of `runs` starts and ends in the text: [{ start, end, format }]. */
export function runRanges(runs) {
  let at = 0;
  return runs.map((run) => {
    const start = at;
    at += run.n;
    return { start, end: at, format: run.format };
  });
}

/**
 * One format changed: `changes` may name a `family` (the id of one of `families`), `bold` and `italic` —
 * the family's own faces — or any format field directly. The changed format, or { bad: field }.
 */
export function changedFormat(format, changes, families = STANDARD_FAMILIES) {
  const { family, bold, italic, ...fields } = changes;
  let font = fields.font ?? format.font;
  if (fields.font === undefined && (family !== undefined || bold !== undefined || italic !== undefined)) {
    font = styledFont(format.font, { family, bold, italic }, families);
    if (!font) return { bad: 'font' };
  }
  return formatOf({ ...format, ...fields, font });
}

/**
 * `changes` applied to the characters of `text` in `range` ([from, to), the whole text when null), over
 * the box's `base` format and its `spans`, choosing faces among `families`. Alignment and width are the
 * box's, so they always apply to all of it. Gives { format, spans } in the normal form, or { bad: field }
 * when the change can't be used.
 */
export function applyChanges(text, base, spans, changes, range = null, families = STANDARD_FAMILIES) {
  const { align, width, ...span } = changes;
  const boxed = { ...base };
  if (align !== undefined) boxed.align = align;
  if (width !== undefined) boxed.width = width;
  const { runs, bad } = formatRuns(text, boxed, spans);
  if (bad) return { bad };
  const len = String(text ?? '').length;
  const clamp = (v, fallback) => (Number.isFinite(v) ? Math.max(0, Math.min(Math.floor(v), len)) : fallback);
  const from = range ? clamp(range[0], 0) : 0;
  const to = Math.max(from, range ? clamp(range[1], len) : len);
  const touched = Object.keys(span).length > 0;
  const next = [];
  let at = 0;
  for (const run of runs) {
    const start = at;
    const end = at + run.n;
    at = end;
    const lo = Math.max(start, from);
    const hi = Math.min(end, to);
    if (!touched || hi <= lo) {
      next.push(run);
      continue;
    }
    const { format, bad: badChange } = changedFormat(run.format, span, families);
    if (badChange) return { bad: badChange };
    if (lo > start) next.push({ n: lo - start, format: run.format });
    next.push({ n: hi - lo, format });
    if (end > hi) next.push({ n: end - hi, format: run.format });
  }
  // Alignment and width are the box's: every run carries them, so they are set on all of them.
  const boxFields = { align: boxed.align, width: boxed.width };
  return normalizeRuns(next.map((run) => ({ n: run.n, format: { ...run.format, ...boxFields } })));
}

/**
 * The spans of `oldText` carried onto `newText`: what stayed keeps its format, and what was typed takes
 * the format of the character before it (the character after it, when it was typed at the very start) —
 * so typing inside a bold word stays bold. Null when there is nothing to carry.
 */
export function remapSpans(oldText, newText, spans) {
  if (!Array.isArray(spans) || spans.length < 2) return null;
  const before = String(oldText ?? '');
  const after = String(newText ?? '');
  if (before === after) return spans;
  const owners = [];
  spans.forEach((span, i) => {
    for (let k = 0; k < Math.max(0, Math.floor(span.n) || 0); k++) owners.push(i);
  });
  while (owners.length < before.length) owners.push(spans.length - 1);
  owners.length = before.length;
  let head = 0;
  const shortest = Math.min(before.length, after.length);
  while (head < shortest && before[head] === after[head]) head++;
  let tail = 0;
  while (tail < shortest - head && before[before.length - 1 - tail] === after[after.length - 1 - tail]) tail++;
  const removed = before.length - head - tail;
  const added = after.length - head - tail;
  const inherit = head > 0 ? owners[head - 1] : owners[head + removed] ?? owners.at(-1) ?? 0;
  const next = [...owners.slice(0, head), ...Array(Math.max(0, added)).fill(inherit), ...owners.slice(head + removed)];
  const out = [];
  for (const owner of next) {
    if (out.at(-1)?.owner === owner) out.at(-1).n += 1;
    else out.push({ owner, n: 1 });
  }
  return out.map(({ owner, n }) => ({ ...spans[owner], n }));
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
    /** The font's codes for `text` (every character must be one it has): what its `Tj` shows. */
    codes: (text) => [...text].map((ch) => encoding.encodeUnicodeCodePoint(ch.codePointAt(0)).code),
  };
}

const FACES = new WeakMap();

/**
 * A resolver for the standard PDF fonts: a font name → its face, each made once per pdf-lib. This is
 * what a box of mixed faces is laid out and written through; another resolver (a parsed font's faces)
 * plugs into the same place.
 */
export function standardFaces(lib) {
  let cache = FACES.get(lib);
  if (!cache) FACES.set(lib, (cache = new Map()));
  return (font) => {
    if (!cache.has(font)) cache.set(font, standardFace(lib, font));
    return cache.get(font);
  };
}

/** A face resolver from whatever layoutText() was given: one face stands for every font. */
const resolver = (faces) => (typeof faces === 'function' ? faces : () => faces);

/** The characters of a paragraph, each with the format it reads in. */
const charsOf = (text, runs) => {
  const chars = [];
  let i = 0;
  for (const run of runs) for (let k = 0; k < run.n; k++) chars.push({ ch: text[i++], format: run.format });
  return chars;
};

/** The pieces a line breaks between: runs of spaces and runs of anything else. */
function pieces(chars) {
  const out = [];
  for (const c of chars) {
    const space = c.ch === ' ';
    const last = out.at(-1);
    if (last && last.space === space) last.chars.push(c);
    else out.push({ space, chars: [c] });
  }
  return out;
}

const typed = (chars) => chars.some((c) => c.ch !== ' ');
const trimEnd = (chars) => {
  let end = chars.length;
  while (end > 0 && chars[end - 1].ch === ' ') end--;
  return chars.slice(0, end);
};

/** Lines of one typed paragraph, each one `fits` (the box's width), without the spaces it wrapped at. */
function wrap(paragraph, fits) {
  const lines = [];
  let line = [];
  for (const piece of pieces(paragraph)) {
    if (piece.space) {
      line = line.concat(piece.chars); // spaces never start a wrapped line, and hang past the edge at its end
      continue;
    }
    if (fits(line.concat(piece.chars))) {
      line = line.concat(piece.chars);
      continue;
    }
    if (typed(line)) lines.push(trimEnd(line));
    line = typed(line) ? [] : line; // a paragraph's own leading spaces stay with its first word
    // A word wider than the box on its own is broken between characters, at least one per line.
    for (const c of piece.chars) {
      if (typed(line) && !fits(line.concat([c]))) {
        lines.push(line);
        line = [];
      }
      line = line.concat([c]);
    }
  }
  lines.push(trimEnd(line));
  return lines;
}

/**
 * Lays `text` out in `faces` — one face, or a font name → face resolver when the box mixes faces: its
 * lines, each with where its baseline starts in the text's own space (the first line's baseline at y 0,
 * lines below it, y up) and the pieces it is drawn in, and the box they fill: [0, bottom, width, top].
 * Lines break where `text` has line breaks, and — with a width — at spaces to fit it. A line of mixed
 * sizes sits one line spacing of its LARGEST size below the line above, and the box reaches from the
 * tallest ascent of its first line to the deepest descent of its last.
 */
export function layoutText(faces, { text, spans = null, ...fields }) {
  const faceFor = resolver(faces);
  const base = formatOf(fields).format ?? { ...DEFAULT_FORMAT };
  const { size, align = base.align, width = base.width } = base;
  const { runs } = formatRuns(text, base, spans);
  const all = charsOf(text, runs ?? [{ n: text.length, format: base }]);

  /**
   * What a stretch of characters advances, in points. Measured a stretch that reads alike at a time —
   * exactly the pieces a line is drawn in, one `Tj` each, so a font that shapes its glyphs is measured as
   * it is drawn — which for a box that reads alike all through is one measurement of the whole stretch.
   */
  const advanceOf = (chars) => {
    let total = 0;
    let i = 0;
    while (i < chars.length) {
      const { font, size: pt } = chars[i].format;
      let j = i;
      let word = '';
      while (j < chars.length && sameSpanFormat(chars[j].format, chars[i].format)) word += chars[j++].ch;
      total += faceFor(font).advance(word) * pt;
      i = j;
    }
    return total;
  };
  /** What a line advances: the spaces it ends with hang past its edge, as they always have. */
  const measure = (chars) => advanceOf(trimEnd(chars));
  const fits = (chars) => measure(chars) <= width + 1e-6;

  const paragraphs = [];
  let paragraph = [];
  for (const c of all) {
    if (c.ch === '\n') {
      paragraphs.push(paragraph);
      paragraph = [];
    } else paragraph.push(c);
  }
  paragraphs.push(paragraph);
  const lines = paragraphs.flatMap((p) => (width === null ? [p] : wrap(p, fits)));

  const advances = lines.map(measure);
  const boxWidth = width ?? Math.max(0, ...advances);
  let carried = base;
  let y = 0;
  let top = 0;
  let bottom = 0;
  const laid = lines.map((chars, i) => {
    const formats = chars.length ? chars.map((c) => c.format) : [carried];
    if (chars.length) carried = chars.at(-1).format;
    if (i > 0) y -= LINE_SPACING * Math.max(...formats.map((f) => f.size));
    const spare = boxWidth - advances[i];
    const x = align === 'center' ? spare / 2 : align === 'right' ? spare : 0;
    // The pieces the line is drawn in: one per stretch that reads alike, where it starts along the line.
    const parts = [];
    for (const c of chars) {
      const last = parts.at(-1);
      if (last && sameSpanFormat(last[0].format, c.format)) last.push(c);
      else parts.push([c]);
    }
    let cursor = x;
    const drawn = parts.map((part) => {
      const advance = advanceOf(part);
      const piece = { text: part.map((c) => c.ch).join(''), x: round(cursor), advance: round(advance), format: part[0].format };
      cursor += advance;
      return piece;
    });
    if (i === 0) top = Math.max(...formats.map((f) => faceFor(f.font).ascent * f.size));
    bottom = y + Math.min(...formats.map((f) => faceFor(f.font).descent * f.size));
    return { text: chars.map((c) => c.ch).join(''), x: round(x), y: round(y), advance: round(advances[i]), pieces: drawn };
  });
  const box = [0, round(bottom), round(boxWidth), round(top)];
  return { lines: laid, box, leading: LINE_SPACING * size };
}
