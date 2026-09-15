// Paragraph grouping (`text-block`): which lines of text on a page plainly read as one paragraph, so
// that a gesture on one of its lines can take the whole paragraph with it.
//
// A block is identity and nothing else — { key, keys }, `keys` the text runs' object keys from the top
// line down — so everything a block is moved, scaled, nudged, lined up or deleted with is what several
// selected objects already use: one record per line, one undo step, the same writer. Nothing new is
// written into a file by grouping, and nothing about a line changes by being in a block.
//
// Pure: it reads the objects it is given, where they are now (a moved line is compared where it was
// moved to), and works in each line's own reading frame, so a page turned by the file, or text set at
// an angle, is grouped the same way as upright text.
//
// It refuses rather than guesses. Lines are grouped only when every one of these holds:
//
//   - each is text that can be moved, set in the same font, size, colour, render mode and direction;
//   - they start at the same left edge, one under the next, at a line spacing between 0.9 and 1.6
//     times the size of the text, and the same spacing all the way down;
//   - no line shares its row with any other text (columns, table cells, a word in another style) and
//     none starts like a list item;
//   - nothing else is drawn between one line and the next (a rule, a picture, other text), apart from
//     something behind the whole of both lines, like a page background.
//
//   - the paragraph has one left edge: a line at paragraph spacing starting elsewhere (an indent)
//     leaves the lines on both sides of it ungrouped.
//
// Anything else stays as separate lines, which is what the page was before grouping existed.

import { boxQuad } from './geometry.js';

const MIN_STEP = 0.9;
const MAX_STEP = 1.6;
/** A line spacing that differs from the block's by more than this (× size) ends the block. */
const STEP_DRIFT = 0.05;
/** Left edges this close (× size) are the same edge. */
const EDGE_TOLERANCE = 0.1;
/** Two lines whose bands overlap by more than this share a row. */
const ROW_OVERLAP = 0.5;
/** A bullet, a dash or a number or letter with a full stop or bracket, then a space. */
const LIST_MARKER = /^\s*(?:[•◦▪▫‣∙·●○■□►▸➢✓\-–—*+]|\(?(?:\d{1,3}|[a-zA-Z]|[ivxlcdmIVXLCDM]{1,6})[.)])\s/u;

const round = (x) => Math.round(x * 1e4) / 1e4;

/** A text object's reading frame, from where it is now: its direction, its up, its size. */
function frameOf(object) {
  const q = object.geometry?.quad;
  const record = object.record;
  if (object.kind !== 'text-run' || !q || !record?.frame || record.frame.skewed) return null;
  const ux = q[2] - q[0];
  const uy = q[3] - q[1];
  const vx = q[6] - q[0];
  const vy = q[7] - q[1];
  const width = Math.hypot(ux, uy);
  const height = Math.hypot(vx, vy);
  if (!(width > 0) || !(height > 0)) return null;
  const dir = [ux / width, uy / width];
  const up = [vx / height, vy / height];
  if (Math.abs(dir[0] * up[0] + dir[1] * up[1]) > 0.01 || dir[0] * up[1] - dir[1] * up[0] <= 0) return null; // sheared or mirrored
  // A scaled line is the size it is drawn at: its own size times what its quad grew by.
  const o = record.quad;
  const original = o ? Math.hypot(o[6] - o[0], o[7] - o[1]) : height;
  return { dir, up, height, size: original > 0 ? (record.frame.size * height) / original : record.frame.size };
}

/** The box of a quad in a reading frame: [along from, up from, along to, up to]. */
function boxIn(quad, { dir, up }) {
  let s0 = Infinity;
  let t0 = Infinity;
  let s1 = -Infinity;
  let t1 = -Infinity;
  for (let i = 0; i < 8; i += 2) {
    const s = quad[i] * dir[0] + quad[i + 1] * dir[1];
    const t = quad[i] * up[0] + quad[i + 1] * up[1];
    s0 = Math.min(s0, s);
    s1 = Math.max(s1, s);
    t0 = Math.min(t0, t);
    t1 = Math.max(t1, t);
  }
  return [s0, t0, s1, t1];
}

/** What has to match for two lines to be in one paragraph, apart from where they are. */
function styleOf(object, frame) {
  const record = object.record;
  const show = record.first ?? {};
  const substitute = object.edit?.encoding?.mode === 'standard' ? object.edit.encoding.font : null;
  return JSON.stringify([
    record.font?.key ?? null, record.fontName ?? null, substitute, show.fill ?? null, show.stroke ?? null,
    show.tr ?? 0, show.th ?? 1, show.tc ?? 0, show.tw ?? 0, show.gsNames ?? [], show.form?.key ?? null,
    round(frame.dir[0]), round(frame.dir[1]),
  ]);
}

const sameDirection = (a, b) => a.dir[0] * b.dir[0] + a.dir[1] * b.dir[1] > 0.9998 && a.up[0] * b.up[0] + a.up[1] * b.up[1] > 0.9998;

/**
 * The paragraphs on a page: [{ key, keys }], each at least two lines, in the order their top lines
 * are found. `objects` are the page's objects (any kinds), as they are now.
 */
export function textBlocks(objects) {
  const list = objects ?? [];
  const lines = [];
  for (const object of list) {
    if (object.kind !== 'text-run' || object.editable !== true || object.capabilities?.move !== true) continue;
    if (!object.text?.trim() || LIST_MARKER.test(object.text)) continue;
    const frame = frameOf(object);
    if (frame) lines.push({ object, frame, style: styleOf(object, frame), box: null });
  }
  if (lines.length < 2) return Object.freeze([]);

  // Everything else on the page, measured in each direction the lines are set in (usually one).
  // A painted path or a form has only a box, which is enough to be in the way.
  const quadOf = (o) => o.geometry?.quad ?? (o.geometry?.box ? boxQuad(o.geometry.box) : null);
  const others = list.filter((o) => quadOf(o) && !(o.kind === 'text-run' && !o.text?.trim()));
  const frames = new Map();
  const measured = (line) => {
    const id = `${round(line.frame.dir[0])},${round(line.frame.dir[1])}`;
    if (!frames.has(id)) frames.set(id, new Map(others.map((o) => [o, boxIn(quadOf(o), line.frame)])));
    return frames.get(id);
  };
  for (const line of lines) line.box = measured(line).get(line.object) ?? boxIn(line.object.geometry.quad, line.frame);

  /** Does any other text sit on this line's row? */
  const sharesRow = (line) => {
    const [, t0, , t1] = line.box;
    for (const [o, box] of measured(line)) {
      if (o === line.object || o.kind !== 'text-run') continue;
      const overlap = Math.min(t1, box[3]) - Math.max(t0, box[1]);
      if (overlap > ROW_OVERLAP * Math.min(t1 - t0, box[3] - box[1])) return true;
    }
    return false;
  };
  /**
   * Is anything but the two lines drawn between them — from the middle of the lower line to the middle
   * of the upper, across the width of both — other than something behind all of that? The middles, so
   * the descenders of the line above and the ascenders of the line below never count.
   */
  const between = (a, b) => {
    const region = [Math.min(a.box[0], b.box[0]), (b.box[1] + b.box[3]) / 2, Math.max(a.box[2], b.box[2]), (a.box[1] + a.box[3]) / 2];
    const inset = 0.05 * a.frame.size;
    for (const [o, box] of measured(a)) {
      if (o === a.object || o === b.object) continue;
      const touches = box[0] < region[2] - inset && box[2] > region[0] + inset && box[1] < region[3] - inset && box[3] > region[1] + inset;
      const behind = box[0] <= region[0] && box[1] <= region[1] && box[2] >= region[2] && box[3] >= region[3];
      if (touches && !behind) return true;
    }
    return false;
  };

  const blocks = [];
  const byStyle = new Map();
  for (const line of lines) {
    if (sharesRow(line)) continue;
    const group = byStyle.get(line.style) ?? [];
    group.push(line);
    byStyle.set(line.style, group);
  }
  for (const group of byStyle.values()) {
    group.sort((a, b) => b.box[1] - a.box[1]); // top line first, in the text's own up
    let chain = [];
    // A line at paragraph spacing that starts somewhere else — an indented first line, a hanging
    // indent — means the paragraph is not all one edge: neither side of it is grouped, rather than
    // a block that leaves one of the paragraph's lines behind.
    let ragged = false;
    const flush = () => {
      if (chain.length >= 2 && !ragged) {
        const keys = chain.map((l) => l.object.ref.key);
        blocks.push(Object.freeze({ key: `block:${keys[0]}`, keys: Object.freeze(keys) }));
      }
      chain = [];
      ragged = false;
    };
    for (const line of group) {
      const above = chain.at(-1);
      const verdict = above ? joins(above, line, chain, between) : true;
      if (verdict !== true) {
        if (verdict === 'edge') ragged = true;
        flush();
        if (verdict === 'edge') ragged = true;
      }
      chain.push(line);
    }
    flush();
  }
  return Object.freeze(blocks);
}

/**
 * Does `line` continue the paragraph whose last line so far is `above`? true, false, or 'edge' when
 * it would, except that it starts at another left edge.
 */
function joins(above, line, chain, between) {
  const size = above.frame.size;
  if (!sameDirection(above.frame, line.frame)) return false;
  if (Math.abs(line.frame.size - size) > 0.01 * size || Math.abs(line.frame.height - above.frame.height) > 0.02 * above.frame.height) return false;
  const step = above.box[1] - line.box[1];
  if (step < MIN_STEP * size || step > MAX_STEP * size) return false;
  if (chain.length >= 2 && Math.abs(step - (chain[0].box[1] - chain[1].box[1])) > STEP_DRIFT * size) return false;
  if (between(above, line)) return false;
  return Math.abs(line.box[0] - above.box[0]) <= EDGE_TOLERANCE * size ? true : 'edge';
}

/** The block one object key belongs to, from blocks textBlocks() gave, or null. */
export const blockOf = (blocks, key) => blocks.find((b) => b.keys.includes(key)) ?? null;
