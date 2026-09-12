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
// The page writer does the rest: splicing the patches in, closing what the page leaves open, and
// making the new content stream.

import { EditError } from '../edits.js';
import { pdfaClaim } from '../source.js';
import { num, hexString, pdfName, operand } from '../content/writer.js';

const SPACE_ADVANCE = 250; // a space the font can't draw becomes a gap of ¼ em (thousandths of text space)

/** The kind of edit record this handler writes. */
export const kind = 'text';

/** Checked once for the whole document, before anything is written. */
export function precheck({ lib, doc, records }) {
  // PDF/A needs every font embedded; the standard fonts Vellum substitutes aren't.
  if (records.some((e) => e.encoding?.mode === 'standard') && pdfaClaim(lib, doc)) {
    throw new EditError('pdfa', 'This PDF follows the PDF/A archiving standard, which needs every font embedded; a change that uses a substitute font would break it, so nothing was changed.');
  }
}

/**
 * The changes one page's text edits make: byte patches into the page's own content, and the text
 * to draw after it. Throws (and nothing is written) if a record no longer matches the file.
 */
export function write({ lib, doc, page, index, analysis, records }) {
  const targets = [];
  const edited = new Map(); // show index → Set of glyph indexes taken out
  for (const record of records) {
    const run = analysis.runs.find((r) => r.key === record.target.key);
    if (!run || run.text !== record.target.text || !sameGlyphs(run.glyphs, record.target.glyphs)) {
      throw new EditError('changed', `The text being edited on page ${index + 1} isn’t in the file as expected any more, so nothing was changed.`);
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
  for (const { record, run } of targets) {
    if (record.encoding.mode === 'none') continue;
    let fontName = run.fontName;
    let items = record.encoding.items;
    if (record.encoding.mode === 'standard') {
      const name = record.encoding.font;
      if (!standardFonts.has(name)) standardFonts.set(name, addStandardFont(lib, doc, page, name));
      fontName = standardFonts.get(name);
      items = encodeStandard(lib, name, record.text);
    }
    append.push(drawText(analysis, run, fontName, items));
  }
  return { patches, append };
}

const sameGlyphs = (a, b) => a.length === b.length && a.every(([s, g], i) => s === b[i][0] && g === b[i][1]);

/**
 * The replacement for one text operator: its glyphs as a TJ array, with every edited glyph turned
 * into the exact advance it had (so later glyphs in the same text object don't move).
 */
function neutralize(analysis, show, editedGlyphs) {
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

/** The new text, in a clean graphics state repeating the original's placement and style. */
function drawText(analysis, run, fontName, items) {
  const [si, gi] = run.glyphs[0];
  const show = analysis.shows[si];
  const first = show.glyphs[gi];
  const replay = (state) => [state.space, state.color].filter(Boolean).map(({ op, args }) => `${args.map(operand).join(' ')} ${op}`.trim());
  const lines = ['q', ...replay(show.fill)];
  if (show.tr === 1 || show.tr === 2) lines.push(...replay(show.stroke), `${num(show.lineWidth)} w`);
  for (const name of show.gsNames) lines.push(`${pdfName(name)} gs`);
  lines.push(
    `${show.ctm.map(num).join(' ')} cm`,
    'BT',
    `${pdfName(fontName)} ${num(show.fontSize)} Tf`,
    `${num(show.tc)} Tc ${num(show.tw)} Tw ${num(show.th * 100)} Tz ${num(show.ts)} Ts ${show.tr} Tr`,
    `${first.tm.map(num).join(' ')} Tm`,
    `${textArray(items)} TJ`,
    'ET',
    'Q',
  );
  return lines.join('\n');
}

function textArray(items) {
  const parts = [];
  let codes = '';
  for (const item of items) {
    if (item.space) {
      if (codes) parts.push(`<${codes}>`);
      codes = '';
      parts.push(num(-SPACE_ADVANCE));
    } else {
      codes += item.code.toString(16).padStart(item.byteLength * 2, '0');
    }
  }
  if (codes) parts.push(`<${codes}>`);
  return `[${parts.join(' ')}]`;
}

/** A standard font added to this page's resources (a copy of them: other pages are unaffected). */
function addStandardFont(lib, doc, page, name) {
  const { PDFName, PDFDict } = lib;
  const ctx = doc.context;
  const font = doc.embedStandardFont(name);
  const inherited = page.node.Resources();
  const resources = inherited ? inherited.clone(ctx) : ctx.obj({});
  const current = resources.lookup(PDFName.of('Font'));
  const fonts = current instanceof PDFDict ? current.clone(ctx) : ctx.obj({});
  let n = 1;
  while (fonts.has(PDFName.of(`VlF${n}`))) n++;
  const key = `VlF${n}`;
  fonts.set(PDFName.of(key), font.ref);
  resources.set(PDFName.of('Font'), fonts);
  page.node.set(PDFName.of('Resources'), resources);
  return key;
}

function encodeStandard(lib, name, text) {
  const encoding = lib.StandardFontEmbedder.for(name).encoding;
  return [...text].map((ch) => ({ code: encoding.encodeUnicodeCodePoint(ch.codePointAt(0)).code, byteLength: 1 }));
}
