// Single-style paragraph reflow: a grouped paragraph (objects/text-block.js) rewrapped to a new width,
// in its own font and size, on its own lines.
//
// The narrow case, and nothing else. The words are refilled into the paragraph's EXISTING lines, each
// keeping exactly its baseline, left edge, font, size, colour and spacing; a line the new width no longer
// needs is emptied. Every line stays the one text record it already was (editing/edits.js), written by
// the text writer that has always written it — so reflow adds no record kind, no writer, no layout of
// its own and no font of any kind: a line is re-encoded with the codes its own font is proven to have.
//
// Refused, with the reason, whenever the result could look different from the paragraph as set:
//
//   - fewer than two lines, a line that can't be edited, or lines that differ in font, size, spacing
//     operators, colour, render mode, graphics state, direction or scale;
//   - lines not on one left edge and one even line spacing;
//   - text the file doesn't lay out with the font's own widths (kerning, tracking, justification, word
//     gaps drawn as moves rather than spaces): refilled, it would not match the lines around it;
//   - a line ending in a hyphen (the word it splits can't be joined without guessing);
//   - a line already set in a substitute font, or already removed, or lines placed differently;
//   - text the font can't write in its own glyphs (no substitute is ever used here);
//   - a width narrower than a word, or one that needs more lines than the paragraph has.
//
// Pure: given the page's verified analysis and each line's run and record, top line first.

import { EditError, planTextEdit, planTextTransform } from '../edits.js';
import { multiply } from '../matrix.js';
import { moveAndScaleOf } from './transform.js';
import { MIN_STEP, MAX_STEP } from './text-block.js';

const refuse = (message, reason) => {
  throw new EditError('reflow', message, { reason });
};

const HYPHEN_END = /[-‐‑­]$/u;

const dot = (p, q, v) => (p[0] - q[0]) * v[0] + (p[1] - q[1]) * v[1];

/** A run's first show, its first glyph and its last glyph. */
function endsOf(analysis, run) {
  const [si, gi] = run.glyphs[0];
  const [sl, gl] = run.glyphs.at(-1);
  return { show: analysis.shows[si], first: analysis.shows[si].glyphs[gi], last: analysis.shows[sl].glyphs[gl] };
}

/** What has to be the same on every line for the text to be one style, set one way. */
function styleOf(show, first) {
  const unit = multiply(first.tm, show.ctm);
  return JSON.stringify([
    show.font?.key ?? null, show.fontName, show.fontSize, show.tc, show.tw, show.th, show.ts, show.tr,
    show.fill ?? null, show.stroke ?? null, show.tr === 1 || show.tr === 2 ? show.lineWidth : null,
    show.gsNames ?? [], show.form?.key ?? null, show.clip ? show.clip.box : null, show.actualText ?? null,
    unit.slice(0, 4).map((x) => Math.round(x * 1e4) / 1e4), show.ctm.slice(0, 4).map((x) => Math.round(x * 1e4) / 1e4),
  ]);
}

/** The lines top first, along the text's own up, whatever order they were given in. */
function ordered(analysis, lines) {
  if (!analysis || !Array.isArray(lines) || lines.some((l) => !l?.run?.glyphs?.length)) return lines;
  const up = lines[0].run.frame.up;
  const height = (line) => {
    const o = endsOf(analysis, line.run).first.origin;
    return o[0] * up[0] + o[1] * up[1];
  };
  return [...lines].sort((a, b) => height(b) - height(a));
}

/** The text on a line now: the record's when it was retyped in its own font, else the file's. */
const textOf = (run, record) => (record?.encoding?.mode === 'font' ? record.text : run.text);

/**
 * How wide `text` is in the paragraph's style, in the original page's user space along the text, or
 * null when its font can't write it in its own glyphs — including white space it can't draw, which
 * the writer would turn into a gap of another width.
 */
function measurer(analysis, run) {
  const { show, first } = endsOf(analysis, run);
  const { font, fontSize: fs, tc, tw, th } = show;
  const m = multiply(first.tm, show.ctm);
  const unit = Math.hypot(m[0], m[1]);
  return (text) => {
    const plan = font.planText(text);
    if (!plan.ok || plan.items.some((item) => item.space)) return null;
    let width = 0;
    for (const item of plan.items) {
      const isSpace = item.byteLength === 1 && item.code === 32;
      width += ((item.width ?? 0) * font.widthScale * fs + tc + (isSpace ? tw : 0)) * th;
    }
    return width * unit;
  };
}

/**
 * Why these lines can't be reflowed, as a message, or null when they can. `lines` is
 * [{ run, record }], top line first.
 */
export function reflowRefusal(analysis, lines) {
  try {
    check(analysis, ordered(analysis, lines));
    return null;
  } catch (err) {
    if (err instanceof EditError) return err.message;
    throw err;
  }
}

function check(analysis, lines) {
  if (!analysis || !Array.isArray(lines) || lines.length < 2) refuse('Only a paragraph of two or more lines can be reflowed.', 'lines');
  const style = [];
  for (const { run, record } of lines) {
    if (!run?.editable) refuse('One of the paragraph’s lines can’t be edited, so it can’t be reflowed.', 'not-editable');
    if (record?.encoding?.mode === 'standard') refuse('A line of this paragraph is already set in a substitute font, so it can’t be reflowed in its own font.', 'substitute');
    if (record?.encoding?.mode === 'none' || record?.removed) refuse('A line of this paragraph has been removed, so it can’t be reflowed.', 'removed');
    // A formatted line's colour, opacity or underline would stay with the line, not with the words that move.
    if (record?.format) refuse('A line of this paragraph has been formatted, so it can’t be reflowed yet.', 'formatted');
    // A line set in another face of its font (objects/run-face.js) is drawn in that face alone.
    if (record?.face) refuse('A line of this paragraph is set in another face of its font, so it can’t be reflowed yet.', 'face');
    const { show, first } = endsOf(analysis, run);
    style.push(styleOf(show, first));
    // Set with the font's own widths and nothing else: each glyph starts where the one before it ends.
    const { size, dir, up } = run.frame;
    let previous = null;
    for (const [si, gi] of run.glyphs) {
      const glyph = analysis.shows[si].glyphs[gi];
      if (previous && (Math.abs(dot(glyph.origin, previous.end, dir)) > 0.02 * size || Math.abs(dot(glyph.origin, previous.origin, up)) > 0.01 * size)) {
        refuse('This paragraph is spaced by its own adjustments (kerning, tracking or justification), which reflowing would lose.', 'layout');
      }
      previous = glyph; // a run never continues across a change of style (runs.js), so one show speaks for it
    }
  }
  if (new Set(style).size !== 1) refuse('The lines of this paragraph aren’t all in one font, size and colour, so it can’t be reflowed.', 'style');
  const placements = new Set(lines.map(({ record }) => JSON.stringify(record?.transform ?? null)));
  if (placements.size !== 1) refuse('The lines of this paragraph have been moved separately, so it can’t be reflowed.', 'placement');

  // One left edge, one line spacing.
  const { dir, up, size } = lines[0].run.frame;
  const origins = lines.map(({ run }) => endsOf(analysis, run).first.origin);
  const steps = [];
  for (let i = 1; i < lines.length; i++) {
    const frame = lines[i].run.frame;
    if (frame.dir[0] * dir[0] + frame.dir[1] * dir[1] < 0.9998) refuse('The lines of this paragraph don’t run the same way, so it can’t be reflowed.', 'direction');
    if (Math.abs(dot(origins[i], origins[0], dir)) > 0.1 * size) refuse('The lines of this paragraph don’t start at one edge, so it can’t be reflowed.', 'edge');
    steps.push(dot(origins[i - 1], origins[i], up));
  }
  if (steps.some((s) => !(s >= MIN_STEP * size && s <= MAX_STEP * size) || Math.abs(s - steps[0]) > 0.05 * size)) {
    refuse('The lines of this paragraph aren’t evenly spaced, so it can’t be reflowed.', 'spacing');
  }

  // The width the file lays each line out at has to be the width Vellum measures, or refilled lines
  // would not match.
  const measure = measurer(analysis, lines[0].run);
  lines.forEach(({ run, record }, i) => {
    const text = textOf(run, record);
    if (i < lines.length - 1 && HYPHEN_END.test(text.trimEnd())) refuse('A line of this paragraph ends in a hyphen, and Vellum won’t guess how to join the word it splits.', 'hyphen');
    const { first, last } = endsOf(analysis, run);
    const laid = dot(last.end, first.origin, run.frame.dir);
    const measured = measure(run.text);
    if (measured === null) refuse('This paragraph’s font can’t write its own text again, so it can’t be reflowed.', 'font');
    if (Math.abs(measured - laid) > 0.02 * size + 0.002 * laid) refuse('This paragraph is spaced by its own adjustments (kerning, tracking or justification), which reflowing would lose.', 'layout');
  });
}

/**
 * The words of the paragraph refilled to `width` — measured in the ORIGINAL page's user space along
 * the text — as one text per line, top line first (empty for a line no longer needed). Throws
 * EditError when that can't be done in this paragraph's own lines and font.
 */
export function reflowTexts(analysis, lines, width) {
  return wrap(analysis, ordered(analysis, lines), width);
}

function wrap(analysis, lines, width) {
  check(analysis, lines);
  if (!(width > 0)) refuse('That width is too narrow for this paragraph.', 'narrow');
  const measure = measurer(analysis, lines[0].run);
  const words = lines.map(({ run, record }) => textOf(run, record)).join(' ').split(/\s+/u).filter(Boolean);
  const limit = width + 0.01;
  const filled = [];
  let current = '';
  const fits = (text) => {
    const w = measure(text);
    if (w === null) refuse('This paragraph’s font can’t write all of its words in its own glyphs, so it can’t be reflowed.', 'font');
    return w <= limit;
  };
  for (const word of words) {
    const next = current ? `${current} ${word}` : word;
    if (fits(next)) {
      current = next;
      continue;
    }
    if (!current) refuse(`That width is narrower than the word “${word}”.`, 'narrow');
    filled.push(current);
    if (!fits(word)) refuse(`That width is narrower than the word “${word}”.`, 'narrow');
    current = word;
  }
  if (current) filled.push(current);
  if (filled.length > lines.length) {
    refuse(`At that width the paragraph needs ${filled.length} lines, and it has ${lines.length}. Vellum reflows text only into the lines a paragraph already has.`, 'lines');
  }
  return lines.map((_, i) => filled[i] ?? '');
}

/**
 * The edit-store changes that reflow these lines to `width` — measured as the paragraph is shown NOW,
 * so a paragraph scaled by its (shared) placement is measured at that scale — as [before, after]
 * pairs for one undo step; empty when nothing would change.
 */
export function planReflow({ analysis, lines: given, width, entry, glyphs, embeddedFontsOnly = false }) {
  const lines = ordered(analysis, given);
  const transform = lines?.[0]?.record?.transform ?? null;
  const scale = transform ? moveAndScaleOf(transform) : 1;
  if (!(scale > 0)) refuse('This paragraph’s placement can’t be measured, so it can’t be reflowed.', 'placement');
  const texts = wrap(analysis, lines, width / scale);
  const pairs = [];
  lines.forEach(({ run, record }, i) => {
    const text = texts[i];
    if (text === textOf(run, record)) return;
    if (text === run.text) {
      // Back to exactly what the file says: the file's own glyphs, kept where the paragraph is placed.
      pairs.push([record, record?.transform ? planTextTransform({ run, transform: record.transform, entry, id: record.id }) : null]);
      return;
    }
    const next = planTextEdit({ run, text, entry, glyphs, id: record?.id, transform: record?.transform ?? null, embeddedFontsOnly });
    if (next.encoding.mode !== 'font' && next.encoding.mode !== 'none') {
      refuse('This paragraph’s font can’t write all of its words in its own glyphs, so it can’t be reflowed.', 'font');
    }
    pairs.push([record, next]);
  });
  return pairs;
}
