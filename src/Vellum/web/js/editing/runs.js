// Finds the editable text on a page. A "run" is a stretch of glyphs that reads as one piece of text
// in one style: same font, size, colour and direction, on one baseline, with no large gaps — built
// from the actual glyph positions the interpreter computed, never from operators alone (one
// operator can hold several columns; one word can be spread over many operators).
//
// Every run starts out not editable ("unverified"). verifyPage() compares each text operator,
// glyph by glyph, with what pdf.js drew for the same page — character codes, Unicode text and
// widths — and checks that pdf.js's text positions land on our glyphs. Only runs that agree
// completely, and that have no other problem, become editable. When in doubt: not editable.

import { lex } from './content/lexer.js';
import { interpretContent } from './content/interpreter.js';
import { boundsOf } from './matrix.js';

/** Why a run (or page) can't be edited, in words a person can act on. */
export const REASONS = {
  unverified: 'Vellum hasn’t checked this text yet.',
  mismatch: 'Vellum couldn’t read this text reliably, so it won’t risk changing it.',
  position: 'Vellum couldn’t work out exactly where this text sits, so it won’t risk moving anything.',
  metrics: 'The font’s character widths are missing, so an edit couldn’t be placed exactly.',
  decode: 'Some of these characters can’t be read as text.',
  encoding: 'This text uses a character encoding Vellum can’t edit yet.',
  form: 'This text is part of a reusable graphic in the file, which Vellum can’t edit yet.',
  type3: 'This text is drawn with a picture font (Type 3), which Vellum can’t edit.',
  vertical: 'Vertical text can’t be edited yet.',
  'symbol-font': 'This text uses a symbol font; editing it as letters wouldn’t make sense.',
  invisible: 'This text is invisible (for example the searchable layer of a scanned page). Editing it wouldn’t change what you see.',
  'clip-mode': 'This text is used as a clipping shape, not shown as text.',
  clipped: 'Part of this text is hidden by a clipping shape, so an edit might not look the same.',
  skewed: 'Slanted, mirrored or distorted text can’t be edited yet.',
  degenerate: 'This text has no usable size.',
  'actual-text': 'This text has replacement text for accessibility, so editing the visible text could make them disagree.',
  overlap: 'This text is drawn more than once (for a bold or shadow effect); editing one copy would look wrong.',
  unreadable: 'Part of this page couldn’t be read reliably, so none of its text is edited.',
  blank: 'There’s only white space here.',
  structure: 'This page’s drawing instructions are unbalanced, so Vellum won’t risk rewriting it.',
  'font-resource': 'This text’s font is chosen in an unusual way, so Vellum can’t write with it.',
};

export const PAGE_KINDS = {
  text: 'Editable text may be available.',
  scanned: 'This page is a scanned image. It has no text to edit (text recognition, OCR, isn’t available yet).',
  'scanned-ocr': 'This page is a scanned image with an invisible text layer. Editing that layer wouldn’t change what you see.',
  'no-text': 'There’s no text on this page to edit (it may be drawn as shapes).',
  unreadable: 'This page’s content couldn’t be read reliably, so it can’t be edited.',
};

// Run grouping thresholds, in units of the text's size (em).
const MAX_GAP = 0.8; // a larger gap starts a new run (columns, tab stops)
const MAX_BACKTRACK = 1.0; // moving back further than this starts a new run
const MAX_BASELINE_SHIFT = 0.3;
const SPACE_GAP = 0.12; // a gap this wide reads as a space

/**
 * Analyzes one page (from PdfSource.page()).
 * Returns { page, box, bytes, ops, shows, runs, images, forms, issues, summary, verified: false }.
 */
export function analyzePage(page) {
  let bytes;
  let ops;
  try {
    bytes = page.contentBytes();
    ops = lex(bytes).ops;
  } catch (err) {
    return unreadablePage(page, err);
  }
  const result = interpretContent(ops, { resources: page.resources });
  const runs = groupRuns(result.shows);
  const analysis = {
    page: page.index, box: page.box, bytes, ops,
    shows: result.shows, runs, images: result.images, forms: result.forms, issues: result.issues,
    tainted: result.tainted, unbalanced: result.unbalanced, openStates: result.openStates, openText: result.openText,
    verified: false, summary: null,
  };
  classify(analysis);
  analysis.summary = summarize(analysis);
  return analysis;
}

function unreadablePage(page, err) {
  return {
    page: page.index, box: page.box, bytes: null, ops: [], shows: [], runs: [], images: [], forms: [],
    issues: [{ kind: 'unreadable', message: err?.message ?? String(err) }], tainted: true, verified: false,
    summary: { kind: 'unreadable', runs: 0, editable: 0, visibleGlyphs: 0, invisibleGlyphs: 0, imageCoverage: 0 },
  };
}

// ---- grouping --------------------------------------------------------------------------------

const styleKey = (show) => show.styleKey ??= JSON.stringify([
  show.font?.key, show.fontName, show.fontSize, show.th, show.ts, show.tr, show.tc, show.tw,
  show.fill, show.stroke, show.tr === 1 || show.tr === 2 ? show.lineWidth : null,
  show.gsNames, show.form?.key ?? null, show.actualText, show.clip ? show.clip.box : null,
]);

const isBlank = (text) => !text || /^\s+$/u.test(text);

function sameFrame(a, b) {
  const dot = a.dir[0] * b.dir[0] + a.dir[1] * b.dir[1];
  return dot > 0.9998 && Math.abs(a.size - b.size) <= 0.01 * Math.max(a.size, b.size);
}

function groupRuns(shows) {
  const runs = [];
  let run = null;
  let last = null; // { show, glyph }
  for (const show of shows) {
    if (!show.frame || !show.glyphs.length) continue;
    for (let gi = 0; gi < show.glyphs.length; gi++) {
      const glyph = show.glyphs[gi];
      const gap = run && last ? continuation(last, show, glyph) : null;
      if (gap === null) {
        run = {
          id: runs.length, key: `${show.index}:${gi}`,
          shows: [show.index], glyphs: [[show.index, gi]], text: glyph.unicode ?? '�',
          font: show.font, fontName: show.fontName, fontSize: show.fontSize,
          frame: show.frame, first: show, reasons: new Set(), editable: false,
        };
        runs.push(run);
      } else {
        if (gap > SPACE_GAP * show.frame.size && !isBlank(last.glyph.unicode) && !isBlank(glyph.unicode)) run.text += ' ';
        if (run.shows.at(-1) !== show.index) run.shows.push(show.index);
        run.glyphs.push([show.index, gi]);
        run.text += glyph.unicode ?? '�';
      }
      last = { show, glyph };
    }
  }
  for (const r of runs) placeRun(r, shows);
  return runs;
}

/** The gap (user-space units along the text) if `glyph` continues the run, or null for a new run. */
function continuation(last, show, glyph) {
  if (show.issues.includes('position')) return null;
  if (styleKey(show) !== styleKey(last.show) || !sameFrame(show.frame, last.show.frame)) return null;
  const { dir, up, size } = show.frame;
  const dx = glyph.origin[0] - last.glyph.end[0];
  const dy = glyph.origin[1] - last.glyph.end[1];
  const along = dx * dir[0] + dy * dir[1];
  const ox = glyph.origin[0] - last.glyph.origin[0];
  const oy = glyph.origin[1] - last.glyph.origin[1];
  const across = ox * up[0] + oy * up[1];
  if (Math.abs(across) > MAX_BASELINE_SHIFT * size) return null;
  if (along > MAX_GAP * size || along < -MAX_BACKTRACK * size) return null;
  return along;
}

/** Box of a run, in its own reading direction: quad (ll, lr, ur, ul) and axis-aligned box. */
function placeRun(run, shows) {
  const { dir, up } = run.frame;
  const first = shows[run.glyphs[0][0]].glyphs[run.glyphs[0][1]];
  const [ox, oy] = first.origin;
  let minA = Infinity;
  let maxA = -Infinity;
  let minU = Infinity;
  let maxU = -Infinity;
  for (const [si, gi] of run.glyphs) {
    const q = shows[si].glyphs[gi].quad;
    for (let k = 0; k < 8; k += 2) {
      const px = q[k] - ox;
      const py = q[k + 1] - oy;
      const a = px * dir[0] + py * dir[1];
      const u = px * up[0] + py * up[1];
      if (a < minA) minA = a;
      if (a > maxA) maxA = a;
      if (u < minU) minU = u;
      if (u > maxU) maxU = u;
    }
  }
  const at = (a, u) => [ox + dir[0] * a + up[0] * u, oy + dir[1] * a + up[1] * u];
  const corners = [at(minA, minU), at(maxA, minU), at(maxA, maxU), at(minA, maxU)];
  run.origin = [ox, oy];
  run.quad = corners.flat();
  run.box = boundsOf(corners);
  run.extent = { minA, maxA, minU, maxU };
  const lastRef = run.glyphs.at(-1);
  run.end = shows[lastRef[0]].glyphs[lastRef[1]].end;
}

// ---- classification ---------------------------------------------------------------------------

const FONT_REASONS = { type3: 'type3', vertical: 'vertical', cmap: 'encoding', metrics: 'metrics', 'symbol-font': 'symbol-font', 'unreadable-font': 'unreadable' };

function classify(analysis) {
  const { runs, shows } = analysis;
  for (const run of runs) {
    const why = run.reasons;
    why.add('unverified');
    if (analysis.tainted) why.add('unreadable');
    // New text is drawn after the page's content from a clean state; a stray Q would break that.
    if (analysis.unbalanced) why.add('structure');
    // Font set through ExtGState (no Tf name): there's no resource name to write with.
    if (!run.fontName && !run.first.form) why.add('font-resource');
    const font = run.font;
    for (const issue of font?.issues ?? []) if (FONT_REASONS[issue]) why.add(FONT_REASONS[issue]);
    for (const si of run.shows) {
      const s = shows[si];
      if (s.form) why.add('form');
      if (s.actualText) why.add('actual-text');
      for (const issue of s.issues) {
        if (issue === 'position' || issue === 'outside-text-object') why.add('position');
        else if (issue === 'metrics') why.add('metrics');
        else if (issue === 'vertical') why.add('vertical');
      }
    }
    if (run.text.includes('�')) why.add('decode');
    if (isBlank(run.text)) why.add('blank'); // nothing visible to click or edit
    const tr = run.first.tr;
    if (tr === 3) why.add('invisible');
    else if (tr >= 4 && tr <= 7) why.add(tr === 7 ? 'invisible' : 'clip-mode');
    if (run.frame.skewed) why.add('skewed');
    if (!(run.frame.size > 0.1)) why.add('degenerate');
    const clip = run.first.clip;
    if (clip && (!clip.exact || !inside(run.box, clip.box, 0.5))) why.add('clipped');
  }
  markOverlaps(runs);
}

const inside = (b, c, tol) => b[0] >= c[0] - tol && b[1] >= c[1] - tol && b[2] <= c[2] + tol && b[3] <= c[3] + tol;

/** Runs drawn twice on top of each other (fake bold, shadows): editing one copy would look wrong. */
function markOverlaps(runs) {
  const byText = new Map();
  for (const r of runs) {
    if (isBlank(r.text)) continue;
    const list = byText.get(r.text) ?? [];
    list.push(r);
    byText.set(r.text, list);
  }
  for (const list of byText.values()) {
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i];
        const b = list[j];
        const limit = 0.25 * Math.max(a.frame.size, b.frame.size);
        if (Math.hypot(a.origin[0] - b.origin[0], a.origin[1] - b.origin[1]) < limit) {
          a.reasons.add('overlap');
          b.reasons.add('overlap');
        }
      }
    }
  }
}

function summarize(analysis) {
  let visible = 0;
  let invisible = 0;
  let inForms = 0;
  for (const s of analysis.shows) {
    const n = s.glyphs.filter((g) => !isBlank(g.unicode)).length;
    if (s.tr === 3 || s.tr === 7) invisible += n;
    else visible += n;
    if (s.form) inForms += n;
  }
  const [x1, y1, x2, y2] = analysis.box;
  const area = Math.max(1e-6, (x2 - x1) * (y2 - y1));
  let covered = 0;
  for (const img of analysis.images) {
    const [a1, b1, a2, b2] = img.box;
    const w = Math.min(x2, a2) - Math.max(x1, a1);
    const h = Math.min(y2, b2) - Math.max(y1, b1);
    if (w > 0 && h > 0) covered += w * h;
  }
  const imageCoverage = Math.min(1, covered / area);
  let kind = 'text';
  if (analysis.tainted && !visible) kind = 'unreadable';
  else if (!visible) kind = imageCoverage >= 0.5 ? (invisible ? 'scanned-ocr' : 'scanned') : 'no-text';
  return {
    kind, runs: analysis.runs.length, editable: analysis.runs.filter((r) => r.editable).length,
    visibleGlyphs: visible, invisibleGlyphs: invisible, formGlyphs: inForms, imageCoverage,
  };
}

// ---- cross-check with pdf.js -----------------------------------------------------------------------

/**
 * Confirms the analysis against pdf.js's reading of the same page:
 *   operatorList  page.getOperatorList({ annotationMode: AnnotationMode.DISABLE })
 *   textContent   page.getTextContent()
 *   OPS           pdfjsLib.OPS
 * Runs that agree completely become editable; the font models learn which codes are proven.
 */
export function verifyPage(analysis, { operatorList, textContent, OPS }) {
  if (analysis.summary.kind === 'unreadable') return analysis;
  const theirs = topLevelShows(operatorList, OPS);
  // pdf.js skips text drawn with no font selected; so do we here.
  const ours = analysis.shows.filter((s) => !s.form && s.font);
  const verdicts = new Map();
  if (ours.length !== theirs.length) {
    for (const s of ours) verdicts.set(s.index, 'mismatch');
  } else {
    ours.forEach((s, k) => verdicts.set(s.index, compareShow(s, theirs[k])));
  }
  const misplaced = positionMismatches(analysis, textContent);

  for (const run of analysis.runs) {
    const why = run.reasons;
    why.delete('unverified');
    if (!why.has('form')) {
      for (const si of run.shows) {
        const verdict = verdicts.get(si);
        if (verdict !== true) why.add(verdict ?? 'mismatch');
      }
    }
    if (misplaced.some((p) => containsPoint(run, p))) why.add('position');
    run.editable = why.size === 0;
  }
  analysis.verified = true;
  analysis.summary = summarize(analysis);
  return analysis;
}

/** pdf.js's showText operations for the page itself (not inside forms or annotations). */
function topLevelShows({ fnArray, argsArray }, OPS) {
  const out = [];
  let forms = 0;
  let annots = 0;
  for (let i = 0; i < fnArray.length; i++) {
    const fn = fnArray[i];
    if (fn === OPS.paintFormXObjectBegin) forms++;
    else if (fn === OPS.paintFormXObjectEnd) forms--;
    else if (fn === OPS.beginAnnotation) annots++;
    else if (fn === OPS.endAnnotation) annots--;
    else if (fn === OPS.showText && forms === 0 && annots === 0) out.push(argsArray[i][0]);
  }
  return out;
}

/** true when pdf.js drew exactly these glyphs and spacing; otherwise the reason it didn't. */
function compareShow(show, theirs) {
  const ourGlyphs = show.glyphs;
  const ourNumbers = show.elements.filter((e) => typeof e === 'number');
  const theirGlyphs = [];
  const theirNumbers = [];
  for (const item of theirs ?? []) {
    if (typeof item === 'number') theirNumbers.push(item);
    else if (item) theirGlyphs.push(item);
  }
  if (ourGlyphs.length !== theirGlyphs.length || ourNumbers.length !== theirNumbers.length) return 'mismatch';
  if (ourNumbers.some((n, i) => Math.abs(n - theirNumbers[i]) > 1e-6)) return 'mismatch';
  let verdict = true;
  const font = show.font;
  ourGlyphs.forEach((g, i) => {
    const t = theirGlyphs[i];
    if (g.code !== t.originalCharCode) {
      verdict = 'mismatch';
      return;
    }
    if (g.unicode === null || g.unicode !== t.unicode) {
      font.noteConflict(g.code);
      if (verdict === true) verdict = g.unicode === null ? 'decode' : 'mismatch';
      return;
    }
    if (g.width === null || Math.abs(g.width - t.width) > 0.5) {
      font.noteConflict(g.code);
      if (verdict === true) verdict = 'metrics';
      return;
    }
    font.noteVerified(g.code, { unicode: g.unicode, width: g.width, inFont: t.isInFont, byteLength: g.byteLength });
  });
  return verdict;
}

/** pdf.js text items whose starting point doesn't coincide with any glyph we placed. */
function positionMismatches(analysis, textContent) {
  const cell = 4;
  const grid = new Map();
  for (const s of analysis.shows) {
    for (const g of s.glyphs) {
      const key = `${Math.floor(g.origin[0] / cell)},${Math.floor(g.origin[1] / cell)}`;
      const list = grid.get(key) ?? [];
      list.push(g.origin);
      grid.set(key, list);
    }
  }
  const bad = [];
  for (const item of textContent?.items ?? []) {
    if (!item.str || !item.str.trim()) continue;
    const [a, b, c, d, x, y] = item.transform;
    const size = Math.hypot(c, d) || Math.hypot(a, b) || 1;
    const tol = Math.max(0.05, 0.02 * size);
    const cx = Math.floor(x / cell);
    const cy = Math.floor(y / cell);
    let found = false;
    for (let i = cx - 1; i <= cx + 1 && !found; i++) {
      for (let j = cy - 1; j <= cy + 1 && !found; j++) {
        for (const [gx, gy] of grid.get(`${i},${j}`) ?? []) {
          if (Math.abs(gx - x) <= tol && Math.abs(gy - y) <= tol) {
            found = true;
            break;
          }
        }
      }
    }
    if (!found) bad.push({ x, y, tol: Math.max(tol, size * 0.3), str: item.str });
  }
  return bad;
}

function containsPoint(run, { x, y, tol }) {
  const [x1, y1, x2, y2] = run.box;
  return x >= x1 - tol && x <= x2 + tol && y >= y1 - tol && y <= y2 + tol;
}

// ---- helpers for callers -----------------------------------------------------------------------------

/** The glyphs of a run: [{ show, glyph }]. */
export function runGlyphs(analysis, run) {
  return run.glyphs.map(([si, gi]) => ({ show: analysis.shows[si], glyph: analysis.shows[si].glyphs[gi] }));
}

/** Human-readable reasons a run isn't editable (empty when it is). */
export function explainRun(run) {
  return [...run.reasons].map((r) => REASONS[r] ?? r);
}
