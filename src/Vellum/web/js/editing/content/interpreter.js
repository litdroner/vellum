// Walks a lexed content stream the way a PDF viewer would, tracking the graphics state (CTM, clip,
// colours, ExtGState) and the text state (font, size, spacing, scaling, rise, render mode, text
// matrices), and records every text-showing operator: which glyphs it draws, in which font, and
// exactly where in PDF user space. Form XObjects are followed (their text is recorded and marked
// as such); images are recorded for scanned-page detection. Nothing is modified.
//
// A show record:
//   { index, opIndex, op, form, font, fontName, fontSize, tc, tw, th, ts, tr, lineWidth,
//     fill, stroke, gsNames, clip, ca, CA, blend, softMask, actualText, ctm, frame, elements, glyphs, issues }
// A glyph:
//   { code, unicode, width, byteStart, byteLength, el, origin, end, quad, advance }
// where `el` is the index of the string inside a TJ array (0 for Tj), `origin`/`end` are the pen
// position before and after the glyph (user space), and `quad` its box (ll, lr, ur, ul).
//
// Also recorded, read-only, for later object editing:
//   images  { index, opIndex, stream, range, name, key, inline, info, ctm, quad, box, clip,
//             ca, CA, blend, softMask, form, mcid, artifact, actualText, oc }
//   paths   { index, opIndex, op, stream, paint, box, lineWidth, ctm, clip, …same context }
//   forms   { index, key, name, depth, opIndex, stream, range, ctm, box, clip, error, …same context,
//             matrix, bbox, group, resources, ownResources, bytes, ops, tagged, parent, ancestors,
//             root, uses, shows, glyphs, content, safety }
// One record per *occurrence*: a form drawn twice gives two records that share `key`. `parent` is
// the occurrence that draws it (null for the page), `ancestors` those occurrences outermost first,
// `root` the depth-1 occurrence it belongs to, `uses` how often `key` is drawn anywhere on the page.
// `content` is the health of the form's own stream, `safety` what stands in the way of ever
// rewriting text inside it — see safetyOf(). Nothing here makes anything editable.
// `stream` is 'page' or the key of the form whose content holds the operator; `range` its bytes in
// that stream; `quad` the image's unit square in user space; `oc` { keys, hidden } for content in
// optional-content groups (layers); `mcid` / `artifact` from marked content (tagged PDFs).

import { PdfName, PdfString } from './lexer.js';
import { IDENTITY, multiply, apply, boundsOf, intersect } from '../matrix.js';

const MAX_FORM_DEPTH = 12;
const MAX_OPS = 3_000_000;
const EPS = 1e-6;

export function interpretContent(ops, { resources, ctm = IDENTITY }) {
  // unbalanced: a Q with nothing to restore; openStates / openText: what the page leaves unclosed.
  const out = { shows: [], images: [], paths: [], forms: [], issues: [], tainted: false, unbalanced: false, openStates: 0, openText: false };
  const budget = { ops: 0 };
  run(ops, resources, initialState(ctm, null), 0, null, [], out, budget);
  finishForms(out);
  return out;
}

function initialState(ctm, clip) {
  return {
    ctm, clip,
    font: null, fontName: null, fontSize: 0,
    tc: 0, tw: 0, th: 1, tl: 0, tr: 0, ts: 0,
    fill: { space: null, color: null }, stroke: { space: null, color: null },
    lineWidth: 1, gsNames: [],
    // Transparency set through ExtGState: opacity, blend mode, and the soft mask in effect (the name
    // of the ExtGState that set it, or null).
    ca: 1, CA: 1, blend: 'Normal', softMask: null,
  };
}

const copyState = (gs) => ({ ...gs, fill: { ...gs.fill }, stroke: { ...gs.stroke }, gsNames: gs.gsNames.slice() });

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const nums = (args, count) => (args.length >= count && args.slice(-count).every(isNum) ? args.slice(-count) : null);

function run(ops, resources, startState, depth, form, formKeys, out, budget, outerMarked = [], record = null) {
  let gs = startState;
  const stack = [];
  // Marked content open around this stream (a form inherits what's open where it's drawn).
  const marked = outerMarked.slice();
  const outer = marked.length;
  let inText = false;
  let tm = IDENTITY;
  let tlm = IDENTITY;
  let tmKnown = true; // false after a show whose width we couldn't compute, until the next positioning
  let path = newPath();
  let pendingClip = false;

  const taint = (opIndex, message) => {
    out.tainted = true;
    if (record) record.content.tainted = true;
    out.issues.push({ kind: 'syntax', opIndex, form: form?.key ?? null, message });
  };
  const moveLine = (tx, ty) => {
    tlm = multiply([1, 0, 0, 1, tx, ty], tlm);
    tm = tlm;
    tmKnown = true;
  };
  /** Where and how an image is drawn: operator and bytes, CTM (its unit square), clip, transparency, tags, layers. */
  const imageRecord = (opIndex, info, fields, ownOc = null) => ({
    index: out.images.length, opIndex, stream: form?.key ?? 'page', range: [ops[opIndex].start, ops[opIndex].end],
    ...fields, info, ctm: gs.ctm, quad: unitQuad(gs.ctm), box: unitBox(gs.ctm), clip: gs.clip,
    ca: gs.ca, CA: gs.CA, blend: gs.blend, softMask: gs.softMask, fill: gs.fill, gsNames: gs.gsNames.slice(),
    form: form?.key ?? null, ...markedContext(marked, ownOc),
  });
  /** A painted path or shading: its bounds in user space and the state it was painted with. */
  const pathRecord = (opIndex, op, paint, box) => ({
    index: out.paths.length, opIndex, op, stream: form?.key ?? 'page', paint, box,
    lineWidth: paint === 'shading' ? null : gs.lineWidth, ctm: gs.ctm, clip: gs.clip,
    ca: gs.ca, CA: gs.CA, blend: gs.blend, softMask: gs.softMask,
    form: form?.key ?? null, ...markedContext(marked),
  });

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
        else if (record) record.content.unbalanced = true; // a Q that would escape the form
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
        if (ext) {
          if (isNum(ext.ca)) gs.ca = ext.ca;
          if (isNum(ext.CA)) gs.CA = ext.CA;
          if (ext.blend) gs.blend = ext.blend;
          // A soft mask is positioned by the CTM at the moment it's set, so it matters where it came from.
          if (ext.softMask === 'none') gs.softMask = null;
          else if (ext.softMask) gs.softMask = name;
        }
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
        // 'n' only ends a path (usually a clipping path): nothing is painted.
        if (op !== 'n' && path.points.length) out.paths.push(pathRecord(opIndex, op, PAINT[op], boundsOf(path.points)));
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
          ca: gs.ca, CA: gs.CA, blend: gs.blend, softMask: gs.softMask,
          ...markedContext(marked),
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
        marked.push(markOf(args[args.length - 1], null, resources));
        break;
      case 'BDC': {
        const mark = markOf(args[args.length - 2], args[args.length - 1], resources);
        marked.push(mark);
        // Content in the document's structure tree: a form that holds any can't be copied.
        if (mark.mcid !== null && record) record.tagged = true;
        break;
      }
      case 'EMC':
        if (marked.length > outer) marked.pop(); // never close what was opened outside this stream
        break;

      // ---- shadings, images and form XObjects ----
      case 'sh':
        // A shading paints the whole clip region (null: the whole page).
        out.paths.push(pathRecord(opIndex, op, 'shading', gs.clip ? gs.clip.box : null));
        break;
      case 'BI':
        out.images.push(imageRecord(opIndex, inlineInfo(args[0]), { name: null, key: null, inline: true }));
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
          out.images.push(imageRecord(opIndex, xobject.info ?? null, { name, key: xobject.key, inline: false }, xobject.oc ?? null));
          break;
        }
        if (xobject.kind !== 'form') break;
        const formCtm = multiply(xobject.matrix ?? IDENTITY, gs.ctm);
        const inner = {
          index: out.forms.length, key: xobject.key, name, depth: depth + 1, opIndex, stream: form?.key ?? 'page',
          range: [ops[opIndex].start, ops[opIndex].end], ctm: formCtm,
          box: xobject.bbox ? boxOf(xobject.bbox, formCtm) : null, clip: gs.clip, error: xobject.error ?? null,
          form: form?.key ?? null, ...markedContext(marked, xobject.oc ?? null),
          // What the form is, for a later phase that would have to copy it before changing it.
          matrix: xobject.matrix ?? IDENTITY, bbox: xobject.bbox ?? null, group: xobject.group ?? null,
          resources: xobject.resources ?? null, ownResources: xobject.ownResources === true,
          // The form's own stream as this analysis read it, so that a private copy of it can be
          // written from exactly these bytes and these operator offsets (objects/form-copy.js).
          bytes: xobject.bytes ?? null, ops: xobject.ops ?? null,
          // Marked content with an MCID drawn anywhere inside it: copying the form would copy that
          // too, and two pieces of content would then claim one place in the structure tree.
          tagged: false,
          // The transparency it is drawn through, which a rewrite would have to reproduce exactly.
          ca: gs.ca, CA: gs.CA, blend: gs.blend, softMask: gs.softMask,
          // Where this occurrence sits: filled in by finishForms() once the page is walked.
          parent: form?.occurrence ?? null, ancestors: [], root: null, uses: 0, shows: [], glyphs: 0,
          // The health of the form's own content stream, and what stops it being rewritten.
          content: { entered: false, tainted: false, unbalanced: false, openStates: 0, openText: false, recursive: false, tooDeep: false },
          safety: null, verification: null,
        };
        out.forms.push(inner);
        if (xobject.error) {
          out.issues.push({ kind: 'form-unreadable', key: xobject.key, message: xobject.error });
          break;
        }
        if (depth + 1 > MAX_FORM_DEPTH || formKeys.includes(xobject.key)) {
          inner.content[formKeys.includes(xobject.key) ? 'recursive' : 'tooDeep'] = true;
          out.issues.push({ kind: 'form-depth', key: xobject.key });
          break;
        }
        const innerState = copyState(gs);
        innerState.ctm = formCtm;
        if (xobject.bbox) {
          const [x1, y1, x2, y2] = xobject.bbox;
          const clipPath = newPath();
          addRect(clipPath, formCtm, x1, y1, x2 - x1, y2 - y1);
          innerState.clip = addClip(gs.clip, clipPath);
        }
        const within = xobject.oc ? [...marked, { tag: null, mcid: null, actualText: false, oc: xobject.oc }] : marked;
        inner.content.entered = true;
        // Shows drawn inside carry the occurrence, not just the key: one form drawn twice is two.
        const context = { key: xobject.key, name, occurrence: inner.index, depth: depth + 1 };
        run(xobject.ops, xobject.resources ?? resources, innerState, depth + 1, context, [...formKeys, xobject.key], out, budget, within, inner);
        break;
      }

      default:
        break; // operators that don't affect text placement (shading, dashes, Type 3 d0/d1, BX/EX…)
    }
  }
  if (depth === 0) {
    out.openStates = stack.length;
    out.openText = inText;
  } else if (record) {
    record.content.openStates = stack.length;
    record.content.openText = inText;
  }
}

// ---- form XObject occurrences -----------------------------------------------------------------

/** What stops text inside a form occurrence from ever being rewritten, in words a person can act on. */
export const FORM_BLOCKERS = {
  depth: 'This graphic is drawn inside another one, not by the page itself.',
  unreadable: 'This graphic’s drawing instructions couldn’t be read.',
  recursive: 'This graphic draws itself, so Vellum stops following it.',
  structure: 'This graphic’s drawing instructions are unbalanced.',
  'inherited-resources': 'This graphic has no resources of its own; it borrows whatever draws it.',
  layer: 'This graphic is on a layer that can be shown or hidden.',
  'soft-mask': 'This graphic is drawn through a transparency mask.',
  tagged: 'This graphic is part of the document’s accessibility structure, which a copy of it would claim too.',
};

/**
 * Facts about how an occurrence is drawn that don't stop its text being read and cross-checked, but
 * that a later phase has to carry over unchanged when it copies the form.
 */
export const FORM_NOTES = {
  shared: 'This graphic is drawn more than once on the page, so a change would have to copy it first.',
  group: 'This graphic is a transparency group, composited as one piece.',
  clipped: 'This graphic is drawn through a clipping shape.',
  transparent: 'This graphic is drawn with an opacity or blend mode set.',
  nested: 'This graphic draws further graphics of its own.',
};

/**
 * Links each form occurrence to the one that draws it, counts how often each XObject is used on the
 * page, gathers the shows drawn directly by each occurrence, and works out what stands in the way of
 * ever rewriting text inside it. Recording only: `safety.safe` says an occurrence is worth checking
 * further, never that anything is editable.
 */
function finishForms(out) {
  const byIndex = out.forms;
  const uses = new Map();
  for (const f of byIndex) uses.set(f.key, (uses.get(f.key) ?? 0) + 1);
  for (const f of byIndex) {
    f.uses = uses.get(f.key) ?? 1;
    const chain = [];
    for (let at = f.parent, guard = 0; at !== null && guard <= MAX_FORM_DEPTH; at = byIndex[at]?.parent ?? null, guard++) {
      if (byIndex[at] === undefined) break;
      chain.unshift(at);
    }
    f.ancestors = chain;
    f.root = chain.length ? chain[0] : f.index;
  }
  // A form holds whatever the forms it draws hold: tagged content below it is tagged content in it.
  for (const f of byIndex) if (f.tagged) for (const at of f.ancestors) byIndex[at].tagged = true;
  for (const show of out.shows) {
    const f = show.form ? byIndex[show.form.occurrence] : null;
    if (!f) continue;
    f.shows.push(show.index);
    f.glyphs += show.glyphs.length;
  }
  const hasChildren = new Set(byIndex.map((f) => f.parent).filter((i) => i !== null));
  for (const f of byIndex) f.safety = safetyOf(f, hasChildren.has(f.index));
}

/**
 * The blockers and notes of one occurrence, as `{ blockers, notes, safe }`. `safe` only means the
 * occurrence is one whose text is worth cross-checking; editability is decided elsewhere, and
 * nothing here removes a refusal.
 */
function safetyOf(f, children) {
  const blockers = [];
  if (f.depth !== 1 || f.stream !== 'page') blockers.push('depth');
  if (f.error || f.content.tooDeep || (!f.content.entered && !f.content.recursive)) blockers.push('unreadable');
  if (f.content.recursive) blockers.push('recursive');
  if (f.content.tainted || f.content.unbalanced || f.content.openStates !== 0 || f.content.openText) blockers.push('structure');
  if (!f.ownResources) blockers.push('inherited-resources');
  if (f.oc) blockers.push('layer');
  if (f.softMask) blockers.push('soft-mask');
  // Tagged content: the structure tree names the content that draws it, and a copy would be a
  // second claim on the same place in it — where the Do stands, or anywhere inside the form.
  if (f.mcid !== null || f.tagged) blockers.push('tagged');
  const notes = [];
  if (f.uses > 1) notes.push('shared');
  if (f.group) notes.push('group');
  if (f.clip) notes.push('clipped');
  if (f.ca !== 1 || f.CA !== 1 || f.blend !== 'Normal') notes.push('transparent');
  if (children) notes.push('nested');
  return { blockers, notes, safe: blockers.length === 0 };
}

/** Colour spaces that are an operator's own name rather than a resource. */
export const DEVICE_SPACES = new Set(['DeviceGray', 'DeviceRGB', 'DeviceCMYK', 'Pattern']);

/**
 * Every resource one show's own state names, as [category, name]: the font it selects, the
 * ExtGStates in effect over it, and the colour spaces and patterns its fill and stroke are set with.
 * Exactly what redrawing that show has to find again — under these names, in whichever resources the
 * redraw is read with. `fontName` overrides the show's own, for a redraw in a font of its own.
 */
export function shownResources(show, fontName = show.fontName) {
  const need = fontName ? [['Font', fontName]] : [];
  for (const name of show.gsNames) need.push(['ExtGState', name]);
  for (const state of [show.fill, show.stroke]) {
    for (const part of [state?.space, state?.color]) {
      const category = part?.op === 'cs' || part?.op === 'CS' ? 'ColorSpace' : part?.op === 'scn' || part?.op === 'SCN' ? 'Pattern' : null;
      if (!category) continue;
      for (const arg of part.args) {
        if (arg instanceof PdfName && !(category === 'ColorSpace' && DEVICE_SPACES.has(arg.name))) need.push([category, arg.name]);
      }
    }
  }
  return need;
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

/** An image's unit square in user space, as a quad (ll, lr, ur, ul) like a text run's. */
const unitQuad = (ctm) => [...apply(ctm, 0, 0), ...apply(ctm, 1, 0), ...apply(ctm, 1, 1), ...apply(ctm, 0, 1)];

const PAINT = { S: 'stroke', s: 'stroke', f: 'fill', F: 'fill', 'f*': 'fill', B: 'fill-stroke', 'B*': 'fill-stroke', b: 'fill-stroke', 'b*': 'fill-stroke' };

// ---- marked content ------------------------------------------------------------------

/** A marked-content sequence: its tag, MCID, ActualText and — for /OC — its optional-content group. */
function markOf(tag, props, resources) {
  const name = tag instanceof PdfName ? tag.name : null;
  let info = null;
  if (props instanceof Map) {
    const mcid = props.get('MCID');
    info = { mcid: isNum(mcid) ? mcid : null, actualText: props.has('ActualText'), oc: null };
  } else if (props instanceof PdfName) {
    info = resources?.properties(props.name) ?? null;
  }
  return {
    tag: name,
    mcid: info?.mcid ?? null,
    actualText: Boolean(info?.actualText),
    oc: name === 'OC' ? (info?.oc ?? { key: null, hidden: null }) : null,
  };
}

/**
 * What the open marked-content sequences say about content drawn now: the innermost MCID, whether
 * it's an artifact or has ActualText, and its layers — hidden when any is off in the default view,
 * null when that can't be told (a membership dictionary, or a layer the file doesn't describe).
 */
function markedContext(marked, extraOc = null) {
  let mcid = null;
  let artifact = false;
  let actualText = false;
  const layers = [];
  for (const m of marked) {
    if (m.mcid !== null) mcid = m.mcid;
    if (m.tag === 'Artifact') artifact = true;
    if (m.actualText) actualText = true;
    if (m.oc) layers.push(m.oc);
  }
  if (extraOc) layers.push(extraOc);
  const oc = layers.length
    ? { keys: layers.map((l) => l.key), hidden: layers.some((l) => l.hidden === true) ? true : layers.some((l) => l.hidden === null) ? null : false }
    : null;
  return { mcid, artifact, actualText, oc };
}

// ---- inline images -----------------------------------------------------------------

const INLINE_COLOR_SPACES = { G: 'DeviceGray', RGB: 'DeviceRGB', CMYK: 'DeviceCMYK', I: 'Indexed' };

/** An inline image's dictionary (abbreviated keys allowed) as the same info image XObjects get. */
function inlineInfo(dict) {
  const get = (...keys) => keys.map((k) => dict?.get(k)).find((v) => v !== undefined);
  const cs = get('CS', 'ColorSpace');
  const csName = cs instanceof PdfName ? cs.name : Array.isArray(cs) && cs[0] instanceof PdfName ? cs[0].name : null;
  const num = (v) => (isNum(v) ? v : null);
  return {
    width: num(get('W', 'Width')),
    height: num(get('H', 'Height')),
    bitsPerComponent: num(get('BPC', 'BitsPerComponent')),
    colorSpace: csName ? INLINE_COLOR_SPACES[csName] ?? csName : null,
    imageMask: get('IM', 'ImageMask') === true,
    smask: false,
    mask: dict?.has('Mask') ?? false,
  };
}

function boxOf([x1, y1, x2, y2], m) {
  return boundsOf([apply(m, x1, y1), apply(m, x2, y1), apply(m, x2, y2), apply(m, x1, y2)]);
}
