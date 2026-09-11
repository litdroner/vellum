// Walks a lexed content stream the way a PDF viewer would, tracking the graphics state (CTM, clip,
// colours, ExtGState) and the text state (font, size, spacing, scaling, rise, render mode, text
// matrices), and records every text-showing operator: which glyphs it draws, in which font, and
// exactly where in PDF user space. Form XObjects are followed (their text is recorded and marked
// as such); images are recorded for scanned-page detection. Nothing is modified.
//
// A show record:
//   { index, opIndex, op, form, font, fontName, fontSize, tc, tw, th, ts, tr, lineWidth,
//     fill, stroke, gsNames, clip, actualText, ctm, frame, elements, glyphs, issues }
// A glyph:
//   { code, unicode, width, byteStart, byteLength, el, origin, end, quad, advance }
// where `el` is the index of the string inside a TJ array (0 for Tj), `origin`/`end` are the pen
// position before and after the glyph (user space), and `quad` its box (ll, lr, ur, ul).

import { PdfName, PdfString } from './lexer.js';
import { IDENTITY, multiply, apply, boundsOf, intersect } from '../matrix.js';

const MAX_FORM_DEPTH = 12;
const MAX_OPS = 3_000_000;
const EPS = 1e-6;

export function interpretContent(ops, { resources, ctm = IDENTITY }) {
  // unbalanced: a Q with nothing to restore; openStates / openText: what the page leaves unclosed.
  const out = { shows: [], images: [], forms: [], issues: [], tainted: false, unbalanced: false, openStates: 0, openText: false };
  const budget = { ops: 0 };
  run(ops, resources, initialState(ctm, null), 0, null, [], out, budget);
  return out;
}

function initialState(ctm, clip) {
  return {
    ctm, clip,
    font: null, fontName: null, fontSize: 0,
    tc: 0, tw: 0, th: 1, tl: 0, tr: 0, ts: 0,
    fill: { space: null, color: null }, stroke: { space: null, color: null },
    lineWidth: 1, gsNames: [],
  };
}

const copyState = (gs) => ({ ...gs, fill: { ...gs.fill }, stroke: { ...gs.stroke }, gsNames: gs.gsNames.slice() });

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const nums = (args, count) => (args.length >= count && args.slice(-count).every(isNum) ? args.slice(-count) : null);

function run(ops, resources, startState, depth, form, formKeys, out, budget) {
  let gs = startState;
  const stack = [];
  const marked = [];
  let inText = false;
  let tm = IDENTITY;
  let tlm = IDENTITY;
  let tmKnown = true; // false after a show whose width we couldn't compute, until the next positioning
  let path = newPath();
  let pendingClip = false;

  const taint = (opIndex, message) => {
    out.tainted = true;
    out.issues.push({ kind: 'syntax', opIndex, form: form?.key ?? null, message });
  };
  const moveLine = (tx, ty) => {
    tlm = multiply([1, 0, 0, 1, tx, ty], tlm);
    tm = tlm;
    tmKnown = true;
  };

  for (let opIndex = 0; opIndex < ops.length; opIndex++) {
    if (++budget.ops > MAX_OPS) {
      taint(opIndex, 'Too many operators');
      return;
    }
    const { op, args } = ops[opIndex];
    switch (op) {
      // ---- graphics state ----
      case 'q':
        stack.push(copyState(gs));
        break;
      case 'Q':
        if (stack.length) gs = stack.pop();
        else if (depth === 0) out.unbalanced = true;
        break;
      case 'cm': {
        const m = nums(args, 6);
        if (!m) { taint(opIndex, 'cm needs 6 numbers'); break; }
        gs.ctm = multiply(m, gs.ctm);
        break;
      }
      case 'w': {
        const v = nums(args, 1);
        if (v) gs.lineWidth = v[0];
        break;
      }
      case 'gs': {
        const name = args[0] instanceof PdfName ? args[0].name : null;
        if (!name) { taint(opIndex, 'gs needs a name'); break; }
        gs.gsNames.push(name);
        const ext = resources?.extGState(name);
        if (ext?.font) {
          gs.font = ext.font.model;
          gs.fontName = null; // set through ExtGState: can't be re-selected with Tf
          gs.fontSize = ext.font.size;
        }
        if (ext && isNum(ext.lineWidth)) gs.lineWidth = ext.lineWidth;
        break;
      }

      // ---- colour (kept as the operators that set it, so it can be re-applied verbatim) ----
      case 'g': case 'rg': case 'k':
        gs.fill = { space: null, color: { op, args } };
        break;
      case 'G': case 'RG': case 'K':
        gs.stroke = { space: null, color: { op, args } };
        break;
      case 'cs':
        gs.fill = { space: { op, args }, color: null };
        break;
      case 'CS':
        gs.stroke = { space: { op, args }, color: null };
        break;
      case 'sc': case 'scn':
        gs.fill = { ...gs.fill, color: { op, args } };
        break;
      case 'SC': case 'SCN':
        gs.stroke = { ...gs.stroke, color: { op, args } };
        break;

      // ---- paths and clipping (only what's needed to know whether text is clipped) ----
      case 're': {
        const v = nums(args, 4);
        if (!v) { taint(opIndex, 're needs 4 numbers'); break; }
        const [x, y, w, h] = v;
        addRect(path, gs.ctm, x, y, w, h);
        break;
      }
      case 'm': case 'l': {
        const v = nums(args, 2);
        if (!v) { taint(opIndex, `${op} needs 2 numbers`); break; }
        addPoint(path, gs.ctm, v[0], v[1], op === 'm');
        break;
      }
      case 'c': case 'v': case 'y': {
        const v = nums(args, op === 'c' ? 6 : 4);
        if (!v) { taint(opIndex, `${op} needs numbers`); break; }
        for (let i = 0; i < v.length; i += 2) addPoint(path, gs.ctm, v[i], v[i + 1], false);
        path.curved = true;
        break;
      }
      case 'h':
        break;
      case 'W': case 'W*':
        pendingClip = true;
        break;
      case 'S': case 's': case 'f': case 'F': case 'f*': case 'B': case 'B*': case 'b': case 'b*': case 'n':
        if (pendingClip) gs.clip = addClip(gs.clip, path);
        pendingClip = false;
        path = newPath();
        break;

      // ---- text objects and state ----
      case 'BT':
        inText = true;
        tm = IDENTITY;
        tlm = IDENTITY;
        tmKnown = true;
        break;
      case 'ET':
        inText = false;
        break;
      case 'Tc': { const v = nums(args, 1); if (v) gs.tc = v[0]; else taint(opIndex, 'Tc needs a number'); break; }
      case 'Tw': { const v = nums(args, 1); if (v) gs.tw = v[0]; else taint(opIndex, 'Tw needs a number'); break; }
      case 'Tz': { const v = nums(args, 1); if (v) gs.th = v[0] / 100; else taint(opIndex, 'Tz needs a number'); break; }
      case 'TL': { const v = nums(args, 1); if (v) gs.tl = v[0]; else taint(opIndex, 'TL needs a number'); break; }
      case 'Tr': { const v = nums(args, 1); if (v) gs.tr = v[0]; else taint(opIndex, 'Tr needs a number'); break; }
      case 'Ts': { const v = nums(args, 1); if (v) gs.ts = v[0]; else taint(opIndex, 'Ts needs a number'); break; }
      case 'Tf': {
        const name = args.length >= 2 && args[args.length - 2] instanceof PdfName ? args[args.length - 2].name : null;
        const size = args[args.length - 1];
        if (!name || !isNum(size)) { taint(opIndex, 'Tf needs a font name and size'); break; }
        gs.fontName = name;
        gs.font = resources?.font(name) ?? null;
        gs.fontSize = size;
        break;
      }
      case 'Td': case 'TD': {
        const v = nums(args, 2);
        if (!v) { taint(opIndex, `${op} needs 2 numbers`); break; }
        if (op === 'TD') gs.tl = -v[1];
        moveLine(v[0], v[1]);
        break;
      }
      case 'Tm': {
        const m = nums(args, 6);
        if (!m) { taint(opIndex, 'Tm needs 6 numbers'); break; }
        tlm = m;
        tm = m;
        tmKnown = true;
        break;
      }
      case 'T*':
        moveLine(0, -gs.tl);
        break;

      // ---- text showing ----
      case 'Tj': case 'TJ': case "'": case '"': {
        let elements;
        if (op === 'TJ') {
          const array = args[args.length - 1];
          if (!Array.isArray(array) || !array.every((e) => e instanceof PdfString || isNum(e))) {
            taint(opIndex, 'TJ needs an array of strings and numbers');
            break;
          }
          elements = array;
        } else {
          const s = args[args.length - 1];
          if (!(s instanceof PdfString)) { taint(opIndex, `${op} needs a string`); break; }
          elements = [s];
          if (op === '"') {
            const v = args.length >= 3 && isNum(args[args.length - 3]) && isNum(args[args.length - 2]);
            if (!v) { taint(opIndex, '" needs two numbers and a string'); break; }
            gs.tw = args[args.length - 3];
            gs.tc = args[args.length - 2];
          }
          if (op !== 'Tj') moveLine(0, -gs.tl);
        }
        const show = {
          index: out.shows.length, opIndex, op, form,
          font: gs.font, fontName: gs.fontName, fontSize: gs.fontSize,
          tc: gs.tc, tw: gs.tw, th: gs.th, ts: gs.ts, tr: gs.tr, lineWidth: gs.lineWidth,
          fill: gs.fill, stroke: gs.stroke, gsNames: gs.gsNames.slice(), clip: gs.clip,
          actualText: marked.some((m) => m.actualText),
          ctm: gs.ctm, tmStart: tm, elements, glyphs: [], issues: [],
        };
        if (!inText) show.issues.push('outside-text-object');
        if (!tmKnown) show.issues.push('position');
        if (!gs.font) {
          show.issues.push('no-font');
          out.shows.push(show);
          tmKnown = false; // its width is unknown
          break;
        }
        tm = layOutGlyphs(show, tm);
        if (show.issues.includes('metrics')) tmKnown = false;
        out.shows.push(show);
        break;
      }

      // ---- marked content ----
      case 'BMC':
        marked.push({ actualText: false });
        break;
      case 'BDC': {
        const props = args[args.length - 1];
        let dict = props instanceof Map ? props : null;
        if (!dict && props instanceof PdfName) dict = resources?.properties(props.name) ?? null;
        marked.push({ actualText: Boolean(dict?.has('ActualText')) });
        break;
      }
      case 'EMC':
        marked.pop();
        break;

      // ---- images and form XObjects ----
      case 'BI':
        out.images.push({ box: unitBox(gs.ctm), form: form?.key ?? null, inline: true });
        break;
      case 'Do': {
        const name = args[args.length - 1] instanceof PdfName ? args[args.length - 1].name : null;
        if (!name) { taint(opIndex, 'Do needs a name'); break; }
        const xobject = resources?.xobject(name);
        if (!xobject) {
          out.issues.push({ kind: 'missing-xobject', name, form: form?.key ?? null });
          break;
        }
        if (xobject.kind === 'image') {
          out.images.push({ box: unitBox(gs.ctm), form: form?.key ?? null, key: xobject.key });
          break;
        }
        if (xobject.kind !== 'form') break;
        const formCtm = multiply(xobject.matrix ?? IDENTITY, gs.ctm);
        const record = { key: xobject.key, name, depth: depth + 1, box: xobject.bbox ? boxOf(xobject.bbox, formCtm) : null, error: xobject.error ?? null };
        out.forms.push(record);
        if (xobject.error) {
          out.issues.push({ kind: 'form-unreadable', key: xobject.key, message: xobject.error });
          break;
        }
        if (depth + 1 > MAX_FORM_DEPTH || formKeys.includes(xobject.key)) {
          out.issues.push({ kind: 'form-depth', key: xobject.key });
          break;
        }
        const inner = copyState(gs);
        inner.ctm = formCtm;
        if (xobject.bbox) {
          const [x1, y1, x2, y2] = xobject.bbox;
          const clipPath = newPath();
          addRect(clipPath, formCtm, x1, y1, x2 - x1, y2 - y1);
          inner.clip = addClip(gs.clip, clipPath);
        }
        run(xobject.ops, xobject.resources ?? resources, inner, depth + 1, { key: xobject.key, name }, [...formKeys, xobject.key], out, budget);
        break;
      }

      default:
        break; // operators that don't affect text placement (shading, dashes, Type 3 d0/d1, BX/EX…)
    }
  }
  if (depth === 0) {
    out.openStates = stack.length;
    out.openText = inText;
  }
}

/**
 * Positions each glyph of a show and advances the text matrix, per the PDF text rendering model:
 *   Trm = [Tfs·Th 0 0 Tfs 0 Ts] × Tm × CTM,   tx = (w0·Tfs + Tc + Tw·[single-byte code 32]) · Th
 * and a TJ number n moves the pen by −n/1000·Tfs·Th.
 */
function layOutGlyphs(show, tmStart) {
  const { font, fontSize: fs, tc, tw, th, ts, ctm } = show;
  const fontMatrix = [fs * th, 0, 0, fs, 0, ts];
  let tm = tmStart;
  const frame = multiply(multiply(fontMatrix, tm), ctm);
  show.frame = describeFrame(frame);
  if (font.vertical) show.issues.push('vertical');

  show.elements.forEach((element, el) => {
    if (typeof element === 'number') {
      tm = multiply([1, 0, 0, 1, (-element / 1000) * fs * th, 0], tm);
      return;
    }
    for (const g of font.decode(element.bytes)) {
      const glyphTm = tm; // the text matrix this glyph is drawn with (before its own advance)
      const trm = multiply(multiply(fontMatrix, tm), ctm);
      const w = g.width;
      if (w === null) show.issues.push('metrics');
      const w0 = (w ?? 0) * font.widthScale;
      const origin = apply(trm, 0, 0);
      const { ascent, descent } = font;
      const quad = [...apply(trm, 0, descent), ...apply(trm, w0, descent), ...apply(trm, w0, ascent), ...apply(trm, 0, ascent)];
      const isSpace = g.byteLength === 1 && g.code === 32;
      const tx = (w0 * fs + tc + (isSpace ? tw : 0)) * th;
      tm = multiply([1, 0, 0, 1, tx, 0], tm);
      const end = apply(multiply(multiply(fontMatrix, tm), ctm), 0, 0);
      show.glyphs.push({ ...g, el, origin, end, quad, advance: tx, tm: glyphTm });
    }
  });
  if (show.issues.includes('metrics')) show.issues = [...new Set(show.issues)];
  return tm;
}

/** The text direction, "up" direction and effective size (in user space) of a rendering matrix. */
function describeFrame(m) {
  const [a, b, c, d] = m;
  const xLen = Math.hypot(a, b);
  const yLen = Math.hypot(c, d);
  const det = a * d - b * c;
  return {
    matrix: m,
    dir: xLen > EPS ? [a / xLen, b / xLen] : [1, 0],
    up: yLen > EPS ? [c / yLen, d / yLen] : [0, 1],
    size: yLen,
    width: xLen,
    // Shear or mirroring: the glyph axes aren't perpendicular, or the text is flipped.
    skewed: xLen < EPS || yLen < EPS || Math.abs(a * c + b * d) / (xLen * yLen) > 0.01 || det < 0,
  };
}

// ---- paths → clip boxes --------------------------------------------------------

function newPath() {
  return { points: [], rects: 0, subpaths: 0, curved: false, axisAligned: true };
}

function addRect(path, ctm, x, y, w, h) {
  for (const [px, py] of [[x, y], [x + w, y], [x + w, y + h], [x, y + h]]) path.points.push(apply(ctm, px, py));
  path.rects++;
  path.subpaths++;
  if (!(Math.abs(ctm[1]) < EPS && Math.abs(ctm[2]) < EPS) && !(Math.abs(ctm[0]) < EPS && Math.abs(ctm[3]) < EPS)) path.axisAligned = false;
}

function addPoint(path, ctm, x, y, isMove) {
  path.points.push(apply(ctm, x, y));
  if (isMove) path.subpaths++;
}

/**
 * The clip after intersecting with a path. `exact` means the clip is known to be exactly its box
 * (every path so far was one axis-aligned rectangle); otherwise the box is only an outer bound.
 */
function addClip(clip, path) {
  if (!path.points.length) return { box: [0, 0, 0, 0], exact: true };
  const box = boundsOf(path.points);
  const exact = path.subpaths === 1 && !path.curved && path.axisAligned && (path.rects === 1 || isRectangle(path.points, box));
  const combined = clip ? intersect(clip.box, box) ?? [0, 0, 0, 0] : box;
  return { box: combined, exact: (clip ? clip.exact : true) && exact };
}

/** Four or five points (a closed polygon) that are exactly the corners of their bounding box. */
function isRectangle(points, [x1, y1, x2, y2]) {
  if (points.length < 4 || points.length > 5) return false;
  const tol = 1e-3;
  return points.every(([x, y]) => (Math.abs(x - x1) < tol || Math.abs(x - x2) < tol) && (Math.abs(y - y1) < tol || Math.abs(y - y2) < tol));
}

const unitBox = (ctm) => boundsOf([apply(ctm, 0, 0), apply(ctm, 1, 0), apply(ctm, 1, 1), apply(ctm, 0, 1)]);

function boxOf([x1, y1, x2, y2], m) {
  return boundsOf([apply(m, x1, y1), apply(m, x2, y1), apply(m, x2, y2), apply(m, x1, y2)]);
}
