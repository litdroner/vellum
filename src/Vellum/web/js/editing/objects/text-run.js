// The text handler for the page writer: everything about turning a text edit into content-stream
// bytes. It is the only handler registered today (see registry.js).
//
// For one page it:
//   1. checks each record against the page's ORIGINAL content — the run must still be there with
//      exactly the text and glyphs the record was made from, or nothing is written at all;
//   2. takes the edited glyphs out of their text operators, replacing each with the exact advance
//      it had, so every other glyph on the page stays precisely where it was;
//   3. draws the new text after the page's own content, from a clean graphics state that repeats
//      the original's position, colour, spacing, transparency and font.
//
// A record may also carry a `transform` (editing/edits.js): an absolute affine transform in the
// ORIGINAL page's user space, saying where the text ends up. Because the text is redrawn after the
// page rather than patched in place, that is simply a different `cm` in step 3 — multiply(ctm, T)
// where the original's own CTM used to go, so the transform happens AFTER the text's own placement
// — and step 2 is unchanged: the original glyphs are neutralised where they were, as always. A
// record without a transform writes the very same bytes it wrote before transforms existed.
//
// `encoding.mode: 'original'` belongs with it: a run that is only being moved or scaled is redrawn
// from the codes the file already holds, so no font is looked up, nothing is re-encoded, no text
// is reflowed and no glyph changes. Moved text is the same text.
//
// A record may also carry a `format` (objects/run-format.js): a fill colour, an opacity or an underline.
// Those change only step 3 — the fill replayed is the new colour, an ExtGState of the page's own follows
// the original's to set the opacity, and the underline is a filled rule in the text's own text space,
// as wide as the glyphs drawn — and are checked again here (runFormatRefusal), whatever the planner said.
//
// A record may also carry a `face` (objects/run-face.js): another face of the run's font family in the same
// document. That too changes only step 3, and only for `encoding.mode: 'original'`: the font set is the
// sibling font object, added to the page's resources, and each glyph is drawn with the code and width that
// font's table in the record gives its character — the table checked here against the font object first
// (font-set.js checkedDocumentFaces), and every glyph of the run found in it, or nothing is written.
//
// The page writer does the rest: splicing the patches in, closing what the page leaves open, and
// making the new content stream.

import { EditError, textTransformRefusal } from '../edits.js';
import { pdfaClaim } from '../source.js';
import { multiply } from '../matrix.js';
import { num, hexString, pdfName, operand } from '../content/writer.js';
import { PdfName } from '../content/lexer.js';
import { RUN_UNDERLINE, runFormatRefusal } from './run-format.js';
import { rgbOf } from './text-format.js';
import { checkedDocumentFaces } from './font-set.js';
import { faceGlyphsOf, runFaceRefusal } from './run-face.js';

const SPACE_ADVANCE = 250; // a space the font can't draw becomes a gap of ¼ em (thousandths of text space)

/** The kind of edit record this handler writes. */
export const kind = 'text';

/** Checked once for the whole document, before anything is written. */
export function precheck({ lib, doc, records }) {
  // PDF/A needs every font embedded; the standard fonts Vellum substitutes aren't.
  if (records.some((e) => e.encoding?.mode === 'standard') && pdfaClaim(lib, doc)) {
    throw new EditError('pdfa', 'This PDF follows the PDF/A archiving standard, which needs every font embedded; a change that uses a substitute font would break it, so nothing was changed.');
  }
  refuseFormatsInPdfa(lib, doc, records);
}

/** A new colour or opacity isn't written into a PDF/A document (objects/run-format.js). */
export function refuseFormatsInPdfa(lib, doc, records) {
  if (records.some((e) => e.format && (e.format.color !== undefined || e.format.opacity !== undefined)) && pdfaClaim(lib, doc)) {
    throw new EditError('pdfa', 'This PDF follows the PDF/A archiving standard. Vellum doesn’t check a new colour or transparency against it, so nothing was changed.');
  }
}

/**
 * The changes one page's text edits make: byte patches into the page's own content, and the text
 * to draw after it. Throws (and nothing is written) if a record no longer matches the file.
 */
export function write({ lib, doc, source, page, index, analysis, records }) {
  const targets = [];
  const edited = new Map(); // show index → Set of glyph indexes taken out
  for (const record of records) {
    const run = analysis.runs.find((r) => r.key === record.target.key);
    if (!run || run.text !== record.target.text || !sameGlyphs(run.glyphs, record.target.glyphs)) {
      throw new EditError('changed', `The text being edited on page ${index + 1} isn’t in the file as expected any more, so nothing was changed.`);
    }
    // A transform is checked again here, after the planner, the way a PDF/A-breaking font change
    // is: what goes into the file must not depend on the UI having asked the right question.
    if (record.transform && textTransformRefusal(record.transform)) {
      throw new EditError('content', `Text on page ${index + 1} is being moved or scaled in a way Vellum can’t write, so nothing was changed.`);
    }
    if (runFormatRefusal(run, record.format)) {
      throw new EditError('content', `Text on page ${index + 1} is formatted in a way Vellum can’t write, so nothing was changed.`);
    }
    if (runFaceRefusal(record.face) || (record.face && record.encoding?.mode !== 'original')) {
      throw new EditError('content', `Text on page ${index + 1} is set in a font Vellum can’t write, so nothing was changed.`);
    }
    for (const [si, gi] of run.glyphs) {
      const set = edited.get(si) ?? new Set();
      if (set.has(gi)) throw new EditError('changed', 'Two edits refer to the same text.');
      set.add(gi);
      edited.set(si, set);
    }
    targets.push({ record, run });
  }

  const patches = [...edited].map(([si, set]) => neutralize(analysis, analysis.shows[si], set));

  const append = [];
  const standardFonts = new Map();
  const states = opacityStates(lib, doc, page);
  const faces = documentFaces(lib, doc, source, page);
  for (const { record, run } of targets) {
    if (record.encoding.mode === 'none') continue;
    let fontName = run.fontName;
    let items = record.encoding.items;
    if (record.encoding.mode === 'standard') {
      const name = record.encoding.font;
      if (!standardFonts.has(name)) standardFonts.set(name, addStandardFont(lib, doc, page, name));
      fontName = standardFonts.get(name);
      items = encodeStandard(lib, name, record.text);
    } else if (record.encoding.mode === 'original') {
      items = originalItems(analysis, run);
      if (record.face) ({ fontName, items } = faces(analysis, run, record.face, items, index));
    }
    const style = styleOf(record, run, states, record.encoding.mode === 'standard' ? lib.StandardFontEmbedder.for(record.encoding.font) : null);
    append.push(drawText(analysis, run, fontName, items, record.transform ?? null, null, style));
  }
  return { patches, append };
}

export const sameGlyphs = (a, b) => a.length === b.length && a.every(([s, g], i) => s === b[i][0] && g === b[i][1]);

/**
 * The replacement for one text operator: its glyphs as a TJ array, with every edited glyph turned
 * into the exact advance it had (so later glyphs in the same text object don't move). The glyphs
 * taken out are gone from the bytes, not hidden: redaction (objects/redaction.js) relies on that.
 */
export function neutralize(analysis, show, editedGlyphs) {
  const op = analysis.ops[show.opIndex];
  const factor = -1000 / (show.fontSize * show.th);
  if (!Number.isFinite(factor)) throw new EditError('content', 'Text with no size can’t be edited.');
  const byElement = new Map();
  show.glyphs.forEach((g, gi) => {
    const list = byElement.get(g.el) ?? [];
    list.push([g, gi]);
    byElement.set(g.el, list);
  });
  const parts = [];
  let bytes = [];
  let gap = 0;
  let hasGap = false;
  const flushBytes = () => {
    if (bytes.length) parts.push(Uint8Array.from(bytes));
    bytes = [];
  };
  const flushGap = () => {
    if (hasGap) parts.push(gap);
    gap = 0;
    hasGap = false;
  };
  show.elements.forEach((element, i) => {
    if (typeof element === 'number') {
      flushBytes();
      gap += element;
      hasGap = true;
      return;
    }
    for (const [g, gi] of byElement.get(i) ?? []) {
      if (editedGlyphs.has(gi)) {
        flushBytes();
        gap += g.advance * factor;
        hasGap = true;
      } else {
        flushGap();
        for (let k = 0; k < g.byteLength; k++) bytes.push(element.bytes[g.byteStart + k]);
      }
    }
  });
  flushBytes();
  flushGap();
  let text = `[${parts.map((p) => (typeof p === 'number' ? num(p) : hexString(p))).join(' ')}] TJ`;
  if (show.op === "'") {
    text = `T* ${text}`;
  } else if (show.op === '"') {
    const { args } = op;
    text = `${num(args[args.length - 3])} Tw ${num(args[args.length - 2])} Tc T* ${text}`;
  }
  return { start: op.start, end: op.end, text };
}

/**
 * The run's own glyphs as TJ items: the codes the file already holds, with the displacement the
 * original had between one glyph and the next written back as the number that produces it.
 *
 * This is all `encoding.mode: 'original'` means. The codes are the ones the page's own bytes
 * decoded to, and write() has already checked this run glyph for glyph against the page, so they
 * are provably the glyphs the record was made from — no font is consulted, nothing is re-encoded.
 *
 * The run is redrawn from its FIRST glyph's placement, as every other mode is: a run spread over
 * several text operators keeps the spacing between them (each gap is measured and re-emitted) but
 * not a baseline shift between them, which one TJ array cannot hold and this writer never kept.
 */
export function originalItems(analysis, run) {
  const first = analysis.shows[run.glyphs[0][0]];
  const factor = -1000 / (first.fontSize * first.th); // the TJ number that moves the pen by one unit
  if (!Number.isFinite(factor)) throw new EditError('content', 'Text with no size can’t be edited.');
  const items = [];
  let previous = null;
  for (const [si, gi] of run.glyphs) {
    const glyph = analysis.shows[si].glyphs[gi];
    const adjust = previous ? gapBefore(previous, glyph) * factor : 0;
    if (Math.abs(adjust) >= 5e-5) items.push({ adjust }); // below this num() would write a zero
    items.push({ code: glyph.code, byteLength: glyph.byteLength });
    previous = glyph;
  }
  return items;
}

/**
 * How much further along the text `glyph` starts than `previous`'s own advance would have taken
 * it, in text-space units: the TJ numbers and pen moves the original had between the two. Measured
 * from the text matrices the interpreter recorded, along the text's own x axis; a component across
 * that axis is a baseline shift, which a TJ number cannot express.
 */
function gapBefore(previous, glyph) {
  const natural = multiply([1, 0, 0, 1, previous.advance, 0], previous.tm);
  const [a, b] = previous.tm;
  const length = a * a + b * b;
  if (!length) return 0;
  return ((glyph.tm[4] - natural[4]) * a + (glyph.tm[5] - natural[5]) * b) / length;
}

/**
 * The new text, in a clean graphics state repeating the original's placement and style — and then
 * `transform`, which is why it is applied to the CTM and not to the text matrix: multiply(ctm, T)
 * is "the original placement, then T", and T is in the page's own user space.
 */
export function drawText(analysis, run, fontName, items, transform = null, rename = null, style = null) {
  const [si, gi] = run.glyphs[0];
  const show = analysis.shows[si];
  const first = show.glyphs[gi];
  const lines = ['q', ...(style?.color ? [fillOf(style.color)] : replayColour(show.fill, rename))];
  if (show.tr === 1 || show.tr === 2) lines.push(...replayColour(show.stroke, rename), `${num(show.lineWidth)} w`);
  for (const name of show.gsNames) lines.push(`${pdfName(rename ? rename('ExtGState', name) : name)} gs`);
  // After the original's own states, so only the opacity is replaced: blend mode and the rest stay.
  if (style?.opacityState) lines.push(`${pdfName(style.opacityState)} gs`);
  const placed = transform ? multiply(show.ctm, transform) : show.ctm;
  lines.push(
    `${placed.map(num).join(' ')} cm`,
    'BT',
    `${pdfName(fontName)} ${num(show.fontSize)} Tf`,
    `${num(show.tc)} Tc ${num(show.tw)} Tw ${num(show.th * 100)} Tz ${num(show.ts)} Ts ${show.tr} Tr`,
    `${first.tm.map(num).join(' ')} Tm`,
    `${textArray(items)} TJ`,
    'ET',
  );
  if (style?.underline) lines.push(underlineOf(show, first, items, style.widthOf));
  lines.push('Q');
  return lines.join('\n');
}

/** The fill colour operator for '#rrggbb', in DeviceRGB. */
const fillOf = (color) => `${rgbOf(color).map(num).join(' ')} rg`;

/**
 * The underline under `items` as drawn from `first`: a filled rule in the text's own text space, from
 * the first glyph's origin to where the pen ends — measured by the PDF text model itself
 * (tx = (w0·Tfs + Tc + Tw·[single-byte 32])·Th, a TJ number n moving it −n/1000·Tfs·Th) over the
 * widths `widthOf(item)` gives in thousandths of an em — below the baseline (and its rise).
 */
function underlineOf(show, first, items, widthOf) {
  const { fontSize: fs, tc, tw, th, ts } = show;
  let width = 0;
  for (const item of items) {
    if (item.space) width += (SPACE_ADVANCE / 1000) * fs * th;
    else if (item.adjust !== undefined) width += (-item.adjust / 1000) * fs * th;
    else {
      const w = widthOf(item);
      if (!Number.isFinite(w)) throw new EditError('content', 'The width of this text couldn’t be measured, so it can’t be underlined.');
      width += ((w / 1000) * fs + tc + (item.byteLength === 1 && item.code === 32 ? tw : 0)) * th;
    }
  }
  const thickness = RUN_UNDERLINE.thickness * fs;
  const y = ts + RUN_UNDERLINE.position * fs - thickness / 2;
  const rule = [0, y, width, thickness].map((v) => num(Math.round(v * 1e4) / 1e4)).join(' ');
  return `${first.tm.map(num).join(' ')} cm\n${rule} re f`;
}

/** The ExtGStates a page's formatted text sets its opacity with: one per opacity, added when first asked. */
export function opacityStates(lib, doc, page) {
  const names = new Map();
  return (opacity) => {
    if (!names.has(opacity)) {
      const state = doc.context.register(doc.context.obj({ Type: 'ExtGState', ca: opacity, CA: opacity }));
      names.set(opacity, addResource(lib, doc, page, 'ExtGState', 'VlGS', state));
    }
    return names.get(opacity);
  };
}

/**
 * A page's writer of runs set in another face of their font (objects/run-face.js): (analysis, run, face,
 * items, index) → { fontName, items }, `items` the run's own (originalItems) with each glyph's code, length
 * and width replaced by its character's in the face — the face's table checked against its font object
 * first, the font added to the page's resources once. EditError, and nothing is written, when the table
 * doesn't match the font or a glyph of the run isn't in it.
 */
export function documentFaces(lib, doc, source, page) {
  const names = new Map();
  return (analysis, run, face, items, index) => {
    const checked = source ? checkedDocumentFaces(lib, source, { glyphs: { [face.font]: face.glyphs } }, [face.font])?.get(face.font) : null;
    const found = checked ? faceGlyphsOf(analysis, run, face.glyphs) : null;
    if (!found?.entries) {
      throw new EditError('changed', `The font text on page ${index + 1} is set in isn’t in the file as expected any more, so nothing was changed.`);
    }
    if (!names.has(face.font)) names.set(face.font, addResource(lib, doc, page, 'Font', 'VlF', checked.ref));
    const first = analysis.shows[run.glyphs[0][0]];
    let i = 0;
    const drawn = items.map((item) => {
      if (item.adjust !== undefined) return item;
      const [si, gi] = run.glyphs[i];
      const [code, byteLength, width] = found.entries[i++];
      if (code !== null) return { code, byteLength, width };
      // A space the face hasn't drawn: its width, and the spacing the line's own space had, as a TJ gap.
      const glyph = analysis.shows[si].glyphs[gi];
      const spacing = first.tc + (glyph.byteLength === 1 && glyph.code === 32 ? first.tw : 0);
      return { adjust: -(width + (spacing * 1000) / first.fontSize) };
    });
    return { fontName: names.get(face.font), items: drawn };
  };
}

/**
 * How drawText formats a record's run (objects/run-format.js), or null when it isn't formatted. `standard`
 * is the standard font's embedder when the text is written in one, whose widths the underline is measured
 * in; otherwise the width an item carries (a glyph in another face, documentFaces), else the run's own
 * font's — the widths pdf.js confirmed it draws.
 */
export function styleOf(record, run, states, standard = null) {
  const format = record.format;
  if (!format) return null;
  const font = run.font;
  const widthOf = standard
    ? (item) => standard.widthOfTextAtSize(item.char, 1000)
    : (item) => item.width ?? (font.widthOf(item.code) ?? NaN) * font.widthScale * 1000;
  return {
    color: format.color ?? null,
    opacityState: format.opacity !== undefined ? states(format.opacity) : null,
    underline: format.underline === true,
    widthOf,
  };
}

const DEVICE_SPACES = new Set(['DeviceGray', 'DeviceRGB', 'DeviceCMYK', 'Pattern']);

/**
 * The operators that set a colour (the interpreter's { space, color } state), written again. With
 * `rename(category, name)`, the resources they name — a colour space set by cs/CS, a pattern painted
 * by scn/SCN — are written under the names `rename` gives them (objects/copies.js, drawing another
 * page's content); the device spaces are operators' own names, not resources.
 */
export function replayColour(state, rename = null) {
  return [state?.space, state?.color].filter(Boolean).map(({ op, args }) => {
    const category = op === 'cs' || op === 'CS' ? 'ColorSpace' : op === 'scn' || op === 'SCN' ? 'Pattern' : null;
    const written = args.map((a) => (rename && category && a instanceof PdfName && !(category === 'ColorSpace' && DEVICE_SPACES.has(a.name))
      ? new PdfName(rename(category, a.name))
      : a));
    return `${written.map(operand).join(' ')} ${op}`.trim();
  });
}

function textArray(items) {
  const parts = [];
  let codes = '';
  for (const item of items) {
    if (item.space || item.adjust !== undefined) {
      if (codes) parts.push(`<${codes}>`);
      codes = '';
      parts.push(num(item.space ? -SPACE_ADVANCE : item.adjust));
    } else {
      codes += item.code.toString(16).padStart(item.byteLength * 2, '0');
    }
  }
  if (codes) parts.push(`<${codes}>`);
  return `[${parts.join(' ')}]`;
}

/** A standard font added to this page's resources (a copy of them: other pages are unaffected). */
export function addStandardFont(lib, doc, page, name) {
  return addResource(lib, doc, page, 'Font', 'VlF', doc.embedStandardFont(name).ref);
}

/**
 * `value` added to this page's resources of `category` (/Font, /ExtGState…) under a new name starting
 * `prefix`, never one the page already has (a copy of its resources: other pages are unaffected). The name.
 */
export function addResource(lib, doc, page, category, prefix, value) {
  const { PDFName, PDFDict } = lib;
  const ctx = doc.context;
  const inherited = page.node.Resources();
  const resources = inherited ? inherited.clone(ctx) : ctx.obj({});
  const current = resources.lookup(PDFName.of(category));
  const entries = current instanceof PDFDict ? current.clone(ctx) : ctx.obj({});
  let n = 1;
  while (entries.has(PDFName.of(`${prefix}${n}`))) n++;
  const key = `${prefix}${n}`;
  entries.set(PDFName.of(key), value);
  resources.set(PDFName.of(category), entries);
  page.node.set(PDFName.of('Resources'), resources);
  return key;
}

export function encodeStandard(lib, name, text) {
  const encoding = lib.StandardFontEmbedder.for(name).encoding;
  return [...text].map((ch) => ({ code: encoding.encodeUnicodeCodePoint(ch.codePointAt(0)).code, byteLength: 1, char: ch }));
}
