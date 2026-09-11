// Writes text edits into pages while a document is being composed (annotations/persist.js is the
// only place PDF bytes are produced; it calls this). For each edited page:
//   1. the edited run's original glyphs are taken out of their text operators and replaced by an
//      equal advance ([n] TJ), so every other glyph on the page stays exactly where it was;
//   2. the new text is drawn after the page's own content, from a clean graphics state that
//      repeats the original's position, colour, spacing, transparency and font;
//   3. the page gets one new content stream. Nothing else on the page is touched.
// Each record is checked against the page first; if its text isn't there exactly as recorded,
// nothing is written (EditError) rather than guessing.

import { PdfName, PdfString } from './content/lexer.js';
import { PdfSource, pdfaClaim } from './source.js';
import { analyzePage } from './runs.js';
import { EditError } from './edits.js';

const SPACE_ADVANCE = 250; // a space the font can't draw becomes a gap of ¼ em (thousandths of text space)

/** Applies text edits to arranged pages. pages[i] shows plan[i]. Returns { changed } (pages rewritten). */
export function applyTextEdits({ lib, doc, pages, plan, edits }) {
  const byEntry = new Map();
  for (const e of edits) {
    if (e.kind !== 'text') continue;
    const list = byEntry.get(e.entry) ?? [];
    list.push(e);
    byEntry.set(e.entry, list);
  }
  if (!byEntry.size) return { changed: 0 };
  // PDF/A needs every font embedded; the standard fonts Vellum substitutes aren't.
  if (edits.some((e) => e.kind === 'text' && e.encoding?.mode === 'standard') && pdfaClaim(lib, doc)) {
    throw new EditError('pdfa', 'This PDF follows the PDF/A archiving standard, which needs every font embedded; a change that uses a substitute font would break it, so nothing was changed.');
  }
  const source = new PdfSource(lib, doc);
  let changed = 0;
  plan.forEach((entry, i) => {
    const records = byEntry.get(entry.id);
    if (!records || !pages[i]) return;
    rewritePage(lib, doc, source, pages[i], i, records);
    changed++;
  });
  return { changed };
}

function rewritePage(lib, doc, source, page, index, records) {
  const analysis = analyzePage(source.pageFor(page, index));
  if (analysis.summary.kind === 'unreadable' || analysis.tainted || analysis.unbalanced) {
    throw new EditError('content', `Page ${index + 1}’s content couldn’t be read reliably, so it wasn’t changed.`);
  }
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

  const patches = [...edited].map(([si, set]) => neutralize(analysis, analysis.shows[si], set)).sort((a, b) => a.start - b.start);
  for (let i = 1; i < patches.length; i++) {
    if (patches[i].start < patches[i - 1].end) throw new EditError('content', 'Overlapping text operators; the page wasn’t changed.');
  }

  // The page's own content, wrapped in q … Q (closing anything it leaves open), then the new text.
  const pieces = [ascii('q\n')];
  let at = 0;
  for (const p of patches) {
    pieces.push(analysis.bytes.subarray(at, p.start), ascii(p.text));
    at = p.end;
  }
  pieces.push(analysis.bytes.subarray(at));
  pieces.push(ascii(`\n${analysis.openText ? 'ET\n' : ''}${'Q\n'.repeat(analysis.openStates)}Q\n`));

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
    pieces.push(ascii(`${drawText(analysis, run, fontName, items)}\n`));
  }

  const ctx = doc.context;
  page.node.set(lib.PDFName.of('Contents'), ctx.register(ctx.flateStream(concat(pieces))));
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

// ---- writing operands ----------------------------------------------------------------------

function num(v) {
  if (!Number.isFinite(v)) throw new EditError('content', 'A number on the page couldn’t be written.');
  const r = Math.round(v * 10000) / 10000;
  return Object.is(r, -0) ? '0' : String(r);
}

const hexString = (bytes) => `<${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}>`;

function pdfName(name) {
  let out = '/';
  for (const ch of name) {
    const c = ch.charCodeAt(0);
    out += c < 0x21 || c > 0x7e || '#()<>[]{}/%'.includes(ch) ? `#${c.toString(16).padStart(2, '0')}` : ch;
  }
  return out;
}

function operand(v) {
  if (typeof v === 'number') return num(v);
  if (v instanceof PdfName) return pdfName(v.name);
  if (v instanceof PdfString) return hexString(v.bytes);
  if (Array.isArray(v)) return `[${v.map(operand).join(' ')}]`;
  if (v instanceof Map) return `<<${[...v].map(([k, x]) => `${pdfName(k)} ${operand(x)}`).join(' ')}>>`;
  if (v === true || v === false) return String(v);
  return 'null';
}

const ascii = (s) => Uint8Array.from(s, (c) => c.charCodeAt(0) & 0xff);

function concat(parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}
