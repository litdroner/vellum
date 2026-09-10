import { bounds, underlineSegments } from './geometry.js';
import { isIdentity } from '../pages/plan.js';

// Reading and writing Vellum's annotations inside the PDF itself, using pdf-lib.
//
// Annotations are saved as standard PDF annotations (Highlight, Underline, Ink, Text) with
// appearance streams, so Acrobat, Edge, Chrome and other readers show them too. Each one also
// carries /VellumId and /VellumData (Vellum's exact data as JSON) so Vellum can reopen them as
// editable. When such a file is opened, those annotations are lifted out of the copy handed to
// pdf.js (so they aren't painted twice) and live in Vellum's own layer instead.

let libPromise = null;
const pdfLib = () => (libPromise ??= import('../../vendor/pdf-lib/pdf-lib.esm.min.js'));

export class AnnotationSaveError extends Error {}

const SUBTYPES = { highlight: 'Highlight', underline: 'Underline', ink: 'Ink', note: 'Text' };
const TYPES = { Highlight: 'highlight', Underline: 'underline', Ink: 'ink', Text: 'note' };

/** Returns Vellum's annotations from a file plus a copy of the bytes without them. */
export async function extractAnnotations(bytes) {
  const lib = await pdfLib();
  const doc = await lib.PDFDocument.load(bytes, { updateMetadata: false });
  const found = [];
  doc.getPages().forEach((page, index) => {
    for (const dict of detachVellum(doc.context, page, lib)) {
      const annotation = parse(dict, index + 1, lib);
      if (annotation) found.push(annotation);
    }
  });
  if (!found.length) return { annotations: [], bytes };
  return { annotations: found, bytes: await doc.save({ useObjectStreams: false }) };
}

/** Returns new file bytes: the original with Vellum's annotations replaced by `annotations`. */
export function writeAnnotations(bytes, annotations) {
  return composeDocument({ base: bytes, annotations });
}

/**
 * Builds a PDF from a page plan (see pages/plan.js).
 *   base         bytes of the opened file; Vellum annotations already in it are replaced
 *   plan         page plan, or null for "the file's own pages, unchanged"
 *   sources      Map of sourceId → bytes, for pages inserted from other PDFs
 *   annotations  Vellum annotations to write; .page is the 1-based position in the plan
 *   clean        really remove deleted pages from the file (not just unlink them from the page list)
 */
export async function composeDocument({ base, plan = null, sources = new Map(), annotations = [], clean = true }) {
  const lib = await pdfLib();
  const doc = await loadForWriting(lib, base);
  const ctx = doc.context;
  const basePages = doc.getPages();
  for (const page of basePages) detachVellum(ctx, page, lib);

  let pages = basePages;
  let dropped = null;
  if (!isIdentity(plan, basePages.length)) ({ pages, dropped } = await arrangePages(doc, lib, basePages, plan, sources));

  for (const a of annotations) {
    const page = pages[a.page - 1];
    if (page) page.node.addAnnot(ctx.register(buildAnnotation(ctx, a, page.ref, lib)));
  }
  // After any rearrangement the old page tree (and any deleted pages) are left unreferenced.
  if (clean && dropped) collectGarbage(ctx, lib, dropped);
  // Uncompressed object layout keeps the /VellumId marker findable by a quick byte scan on open.
  return doc.save({ useObjectStreams: false, updateFieldAppearances: false });
}

/** Page count of a PDF that pages are about to be inserted from (fails clearly if it's protected). */
export async function countPages(bytes) {
  const doc = await loadForWriting(await pdfLib(), bytes);
  return doc.getPageCount();
}

async function loadForWriting(lib, bytes) {
  try {
    return await lib.PDFDocument.load(bytes, { updateMetadata: false });
  } catch (err) {
    throw new AnnotationSaveError(/encrypt/i.test(err.message)
      ? 'This PDF is protected (encrypted), so Vellum can’t write it.'
      : `This PDF couldn’t be prepared for saving (${err.message}).`);
  }
}

// ---- page arrangement ----------------------------------------------------------

const INHERITABLE = ['Resources', 'MediaBox', 'CropBox', 'Rotate'];
const turn = (angle) => ((angle % 360) + 360) % 360;

/**
 * Lays the pages out as the plan says. A page of the opened file is reused as-is the first time it
 * appears, so bookmarks and links pointing at it keep working; repeats and pages from other files
 * are copies. Copies from one file are made in batches so shared fonts and images are stored once.
 * Returns the pages in order and the original pages that are no longer used.
 */
async function arrangePages(doc, lib, basePages, plan, sources) {
  const { PDFPage, PDFPageTree, PDFName, PDFNumber, degrees } = lib;
  const ctx = doc.context;

  const sourceDocs = new Map();
  for (const e of plan) {
    if (e.src === 'base' || e.src === 'blank' || sourceDocs.has(e.src)) continue;
    const bytes = sources.get(e.src);
    if (!bytes) throw new AnnotationSaveError('A PDF that pages were inserted from is no longer available.');
    sourceDocs.set(e.src, await loadForWriting(lib, bytes));
  }

  const pages = new Array(plan.length);
  const batches = new Map(); // src → [[{ index, position }, ...] per repeat round]
  const seen = new Map();
  plan.forEach((e, position) => {
    if (e.src === 'blank') {
      pages[position] = PDFPage.create(doc);
      pages[position].setSize(e.width, e.height);
      return;
    }
    const key = `${e.src}:${e.index}`;
    const round = seen.get(key) ?? 0;
    seen.set(key, round + 1);
    if (e.src === 'base' && round === 0) {
      pages[position] = basePages[e.index];
      return;
    }
    const rounds = batches.get(e.src) ?? [];
    batches.set(e.src, rounds);
    (rounds[e.src === 'base' ? round - 1 : round] ??= []).push({ index: e.index, position });
  });
  for (const [src, rounds] of batches) {
    const from = src === 'base' ? doc : sourceDocs.get(src);
    for (const batch of rounds) {
      const copied = await doc.copyPages(from, batch.map((b) => b.index));
      batch.forEach((b, k) => { pages[b.position] = copied[k]; });
    }
  }

  // Settle each page's own attributes (the old page tree may have supplied them), then its rotation.
  plan.forEach((e, i) => {
    const node = pages[i].node;
    for (const key of INHERITABLE) {
      const name = PDFName.of(key);
      if (!node.get(name)) {
        const value = node.getInheritableAttribute(name);
        if (value) node.set(name, value);
      }
    }
    if (e.rotate) pages[i].setRotation(degrees(turn(pages[i].getRotation().angle + e.rotate)));
  });

  // A fresh, flat page tree in plan order. It has to be a real PDFPageTree, not a plain dict:
  // pdf-lib climbs through it whenever it reads a page's inherited attributes (adding an annotation does).
  const tree = PDFPageTree.withContext(ctx);
  tree.set(PDFName.of('Kids'), ctx.obj(pages.map((p) => p.ref)));
  tree.set(PDFName.of('Count'), PDFNumber.of(pages.length));
  const treeRef = ctx.register(tree);
  for (const p of pages) p.node.setParent(treeRef);
  doc.catalog.set(PDFName.of('Pages'), treeRef);

  const used = new Set(pages.map((p) => p.ref.toString()));
  return { pages, dropped: basePages.filter((p) => !used.has(p.ref.toString())).map((p) => p.ref) };
}

/**
 * Deletes every object no longer reachable from the document, never following references into
 * removed pages. Without this, a "deleted" page would stay inside the file, just unlisted.
 */
function collectGarbage(ctx, { PDFRef, PDFDict, PDFArray, PDFStream }, dropped) {
  const blocked = new Set(dropped.map((ref) => ref.toString()));
  const reachable = new Set();
  const stack = Object.values(ctx.trailerInfo).filter(Boolean);
  while (stack.length) {
    const obj = stack.pop();
    if (obj instanceof PDFRef) {
      const key = obj.toString();
      if (reachable.has(key) || blocked.has(key)) continue;
      reachable.add(key);
      const target = ctx.lookup(obj);
      if (target) stack.push(target);
    } else if (obj instanceof PDFDict) {
      for (const [, value] of obj.entries()) stack.push(value);
    } else if (obj instanceof PDFArray) {
      for (const value of obj.asArray()) stack.push(value);
    } else if (obj instanceof PDFStream) {
      stack.push(obj.dict);
    }
  }
  for (const [ref] of ctx.enumerateIndirectObjects()) {
    if (!reachable.has(ref.toString())) ctx.delete(ref);
  }
}

// ---- reading -------------------------------------------------------------------

/** Removes Vellum's annotations (and popups other apps attached to them) from a page. */
function detachVellum(ctx, page, { PDFName, PDFDict, PDFRef }) {
  const annots = page.node.Annots();
  if (!annots) return [];
  const MARK = PDFName.of('VellumId');
  const entries = annots.asArray();
  const removed = [];
  const drop = new Set();
  const removedRefs = new Set();

  entries.forEach((entry, i) => {
    const dict = ctx.lookup(entry);
    if (dict instanceof PDFDict && dict.has(MARK)) {
      removed.push(dict);
      drop.add(i);
      if (entry instanceof PDFRef) removedRefs.add(entry.toString());
    }
  });
  if (!drop.size) return [];

  entries.forEach((entry, i) => {
    const dict = ctx.lookup(entry);
    const parent = dict instanceof PDFDict ? dict.get(PDFName.of('Parent')) : null;
    if (parent instanceof PDFRef && removedRefs.has(parent.toString())) drop.add(i);
  });

  for (const i of [...drop].sort((a, b) => b - a)) {
    const entry = annots.get(i);
    const dict = ctx.lookup(entry);
    annots.remove(i);
    // Delete the objects too, or every save would leave orphans behind and grow the file.
    if (dict instanceof PDFDict) {
      const ap = dict.lookup(PDFName.of('AP'));
      if (ap instanceof PDFDict) for (const [, value] of ap.entries()) if (value instanceof PDFRef) ctx.delete(value);
    }
    if (entry instanceof PDFRef) ctx.delete(entry);
  }
  return removed;
}

function parse(dict, page, { PDFName, PDFString, PDFHexString, PDFArray, PDFNumber }) {
  const text = (key) => {
    const v = dict.lookup(PDFName.of(key));
    return v instanceof PDFString || v instanceof PDFHexString ? v.decodeText() : '';
  };
  try {
    const data = JSON.parse(text('VellumData') || 'null');
    if (data && data.id && SUBTYPES[data.type]) return { ...data, page };
  } catch { /* fall back to the standard keys below */ }

  // Fallback: rebuild from the standard annotation keys.
  const type = TYPES[dict.lookup(PDFName.of('Subtype'))?.decodeText?.()];
  if (!type) return null;
  const numbers = (value) => (value instanceof PDFArray
    ? value.asArray().map((_, i) => value.lookup(i)).map((n) => (n instanceof PDFNumber ? n.asNumber() : 0))
    : []);
  const color = numbers(dict.lookup(PDFName.of('C')));
  const hex = color.length === 3 ? `#${color.map((c) => Math.round(c * 255).toString(16).padStart(2, '0')).join('')}` : '#ffd84d';
  const id = text('VellumId') || `recovered-${Math.random().toString(36).slice(2)}`;
  const base = { id, type, page, color: hex, contents: text('Contents'), author: text('T'), created: '', modified: '' };
  if (type === 'highlight' || type === 'underline') {
    const flat = numbers(dict.lookup(PDFName.of('QuadPoints')));
    const quads = [];
    for (let i = 0; i + 8 <= flat.length; i += 8) quads.push(flat.slice(i, i + 8));
    return quads.length ? { ...base, quads } : null;
  }
  if (type === 'ink') {
    const list = dict.lookup(PDFName.of('InkList'));
    const paths = list instanceof PDFArray ? list.asArray().map((_, i) => numbers(list.lookup(i))) : [];
    const w = dict.lookup(PDFName.of('BS'))?.lookup?.(PDFName.of('W'));
    const width = w instanceof PDFNumber ? w.asNumber() : 1.5;
    return paths.length ? { ...base, paths, width } : null;
  }
  const rect = numbers(dict.lookup(PDFName.of('Rect')));
  return rect.length === 4 ? { ...base, point: [rect[0], rect[3]] } : null;
}

// ---- writing -------------------------------------------------------------------

const n = (v) => String(Math.round(v * 100) / 100);

function rgb(hex) {
  const v = parseInt(hex.slice(1), 16);
  return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255].map((c) => Math.round(c * 1000) / 1000);
}

function inkPathOps(p) {
  if (p.length === 2) return `${n(p[0])} ${n(p[1])} m ${n(p[0] + 0.01)} ${n(p[1])} l S`;
  if (p.length === 4) return `${n(p[0])} ${n(p[1])} m ${n(p[2])} ${n(p[3])} l S`;
  // Same curve as on screen: quadratic segments through midpoints, written as cubics.
  let ops = `${n(p[0])} ${n(p[1])} m`;
  let cx = p[0];
  let cy = p[1];
  for (let i = 2; i < p.length - 2; i += 2) {
    const qx = p[i];
    const qy = p[i + 1];
    const ex = (p[i] + p[i + 2]) / 2;
    const ey = (p[i + 1] + p[i + 3]) / 2;
    ops += ` ${n(cx + (2 / 3) * (qx - cx))} ${n(cy + (2 / 3) * (qy - cy))} ${n(ex + (2 / 3) * (qx - ex))} ${n(ey + (2 / 3) * (qy - ey))} ${n(ex)} ${n(ey)} c`;
    cx = ex;
    cy = ey;
  }
  return `${ops} ${n(p.at(-2))} ${n(p.at(-1))} l S`;
}

function appearanceOps(a, [r, g, b]) {
  const fill = `${r} ${g} ${b} rg`;
  const stroke = `${r} ${g} ${b} RG`;
  switch (a.type) {
    case 'highlight':
      return `/GS0 gs ${fill}\n${a.quads.map((q) => `${n(q[0])} ${n(q[1])} m ${n(q[2])} ${n(q[3])} l ${n(q[6])} ${n(q[7])} l ${n(q[4])} ${n(q[5])} l h f`).join('\n')}`;
    case 'underline':
      return `${stroke} 0 J\n${underlineSegments(a.quads).map((s) => `${n(s.width)} w ${n(s.x1)} ${n(s.y1)} m ${n(s.x2)} ${n(s.y2)} l S`).join('\n')}`;
    case 'ink':
      return `${stroke} ${n(a.width)} w 1 J 1 j\n${a.paths.map(inkPathOps).join('\n')}`;
    case 'note': {
      const [x, y] = a.point;
      const line = (x1, x2, yy) => `${n(x + x1)} ${n(y - yy)} m ${n(x + x2)} ${n(y - yy)} l S`;
      return [
        `${fill} 0.16 0.12 0.08 RG 0.8 w`,
        `${n(x + 1)} ${n(y - 19)} 18 18 re B`,
        '1.1 w 1 J',
        line(5, 15, 7), line(5, 15, 10.5), line(5, 11.5, 14),
      ].join('\n');
    }
    default:
      return '';
  }
}

function buildAnnotation(ctx, a, pageRef, { PDFHexString, PDFString }) {
  const rect = bounds(a, 1).map((v) => Math.round(v * 100) / 100);
  const color = rgb(a.color);
  const dict = {
    Type: 'Annot',
    Subtype: SUBTYPES[a.type],
    Rect: rect,
    P: pageRef,
    C: color,
    F: a.type === 'note' ? 28 : 4, // Print (+ NoZoom, NoRotate for note icons)
    T: PDFHexString.fromText(a.author || ''),
    Contents: PDFHexString.fromText(a.contents || ''),
    NM: PDFString.of(`vellum-${a.id}`),
    M: PDFString.fromDate(new Date(a.modified || Date.now())),
    CreationDate: PDFString.fromDate(new Date(a.created || Date.now())),
    VellumId: PDFString.of(a.id),
    VellumData: PDFHexString.fromText(JSON.stringify(a)),
  };
  let resources = {};
  if (a.type === 'highlight' || a.type === 'underline') dict.QuadPoints = a.quads.flat().map((v) => Math.round(v * 100) / 100);
  if (a.type === 'highlight') resources = { ExtGState: { GS0: { Type: 'ExtGState', BM: 'Multiply', CA: 1, ca: 1 } } };
  if (a.type === 'ink') {
    dict.InkList = a.paths;
    dict.BS = { W: a.width, S: 'S' };
  }
  if (a.type === 'note') {
    dict.Name = 'Comment';
    dict.Open = false;
  }
  const appearance = ctx.flateStream(appearanceOps(a, color), {
    Type: 'XObject', Subtype: 'Form', FormType: 1, BBox: rect, Matrix: [1, 0, 0, 1, 0, 0], Resources: resources,
  });
  dict.AP = { N: ctx.register(appearance) };
  return ctx.obj(dict);
}
