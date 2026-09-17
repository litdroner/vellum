// True redaction: the text and pictures in an area of a page are taken OUT of the page's content, and
// only then is the area painted black. A box drawn over content that is still in the file hides nothing
// from anyone who copies, searches or edits the page, so that is never what this does.
//
//   { id, kind: 'redact', entry, rects: [[x1, y1, x2, y2], ...] }
//     entry   the page plan entry (pages/plan.js) the redaction belongs to: it moves with its page
//     rects   the areas, in the page's user space
//
// The page writer runs this LAST on a page (editing/page-writer.js), over the page as every other edit
// has already left it — so text retyped, moved, pasted or added into the area, and pictures put there,
// are redacted exactly like the page's own. For that content, re-read:
//
//  - every glyph whose box touches an area is taken out of its text operator, replaced by the exact
//    advance it had (text-run.js neutralize), so the rest of the line stays where it was — visible or
//    invisible text alike (the searchable layer of a scanned page is text);
//  - every picture whose box touches an area has its draw removed — the whole picture, since a picture
//    can't be cut — and its resource dropped when nothing left on the page draws it, so the saved file's
//    garbage collection (annotations/persist.js, `clean`) sweeps its bytes, and the page's old content
//    stream with them;
//  - the page's thumbnail (/Thumb), a picture of the page as it was, is dropped;
//  - the areas are painted black after everything.
//
// Anything it can't prove it has removed refuses the whole save (EditError), rather than leave content
// behind a box: text or pictures inside a Form XObject that reaches an area, text whose position isn't
// known exactly, replacement text (/ActualText) or a tagged structure that could still carry the words,
// text used as a clipping shape, and a link or other annotation over an area. Vector drawings and
// shadings in an area are left as they are and painted over: they are shapes, not text or pictures.

import { EditError } from '../edits.js';
import { num } from '../content/writer.js';
import { newId } from '../../annotations/model.js';
import { neutralize } from './text-run.js';

export const kind = 'redact';

/** Show issues that mean a glyph's position isn't known, so whether it is in an area can't be said. */
const UNCERTAIN = new Set(['position', 'metrics', 'no-font', 'vertical', 'outside-text-object']);

/** Strictly: a line whose box only touches an area's edge (tight leading) isn't in it. */
const overlaps = (a, b) => a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3];

function quadBox(q) {
  const xs = [q[0], q[2], q[4], q[6]];
  const ys = [q[1], q[3], q[5], q[7]];
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

/** A record's areas, normalised; EditError when one isn't a usable area. */
export function areasOf(record) {
  const rects = Array.isArray(record?.rects) ? record.rects : [];
  if (!rects.length) throw new EditError('content', 'A redaction has no area, so nothing was saved.');
  return rects.map((r) => {
    if (!Array.isArray(r) || r.length !== 4 || !r.every(Number.isFinite)) throw new EditError('content', 'A redaction’s area couldn’t be read, so nothing was saved.');
    const box = [Math.min(r[0], r[2]), Math.min(r[1], r[3]), Math.max(r[0], r[2]), Math.max(r[1], r[3])];
    if (box[2] - box[0] <= 0 || box[3] - box[1] <= 0) throw new EditError('content', 'A redaction’s area is empty, so nothing was saved.');
    return box;
  });
}

/** A redaction record for these areas of a page plan entry. */
export function planRedaction({ entry, rects, id = newId() }) {
  const record = { id, kind, entry, rects };
  return { ...record, rects: areasOf(record) };
}

const refuse = (index, what) => {
  throw new EditError('redact', `Page ${index + 1}: ${what} Vellum can’t prove it would be removed, so nothing was saved.`);
};

/**
 * The changes one page's redactions make to the page's CURRENT content (`analysis`, read after every other
 * edit was written): byte patches that take content out, and the black areas drawn after. Also drops the
 * resources and thumbnail that would keep removed content in the file. Throws, and nothing is saved, when
 * something in an area can't be removed for certain.
 */
export function write({ lib, doc, page, index, analysis, records }) {
  const areas = records.flatMap(areasOf);
  const hits = (box) => areas.some((a) => overlaps(box, a));
  const tagged = Boolean(doc.catalog.get(lib.PDFName.of('StructTreeRoot')));

  for (const form of analysis.forms) {
    if (form.error || !form.box || hits(form.box)) refuse(index, 'part of an area is drawn by a reusable graphic (a form), whose content');
  }

  const edited = new Map(); // show index → Set of glyph indexes taken out
  for (const show of analysis.shows) {
    if (show.form) continue; // inside a form, which the check above keeps clear of every area
    if (show.issues.some((i) => UNCERTAIN.has(i))) refuse(index, 'this page has text whose position isn’t known exactly, so');
    const set = new Set();
    show.glyphs.forEach((g, gi) => { if (hits(quadBox(g.quad))) set.add(gi); });
    if (!set.size) continue;
    if (show.actualText) refuse(index, 'text in an area has replacement text (ActualText) that');
    if (show.tr >= 4) refuse(index, 'text in an area is used as a clipping shape, which');
    if (tagged && show.mcid !== null) refuse(index, 'text in an area is tagged, and its structure could carry words that');
    edited.set(show.index, set);
  }
  const patches = [...edited].map(([si, set]) => neutralize(analysis, analysis.shows[si], set));

  const removed = analysis.images.filter((i) => (i.stream ?? 'page') === 'page' && i.box && hits(i.box));
  for (const image of removed) {
    if (image.actualText) refuse(index, 'a picture in an area has replacement text (ActualText) that');
    if (tagged && image.mcid !== null) refuse(index, 'a picture in an area is tagged, and its structure could carry a description that');
    patches.push({ start: image.range[0], end: image.range[1], text: '' });
  }
  releaseImages(lib, doc, page, index, analysis, removed);

  const annots = page.node.Annots();
  for (let i = 0; i < (annots?.size() ?? 0); i++) {
    const rect = annots.lookup(i, lib.PDFDict)?.lookup(lib.PDFName.of('Rect'), lib.PDFArray);
    const box = rect?.size() === 4 ? areasOf({ rects: [rect.asArray().map((n) => n.asNumber?.() ?? NaN)] })[0] : null;
    if (!box || hits(box)) refuse(index, 'a link or annotation lies over an area, and what it holds');
  }
  page.node.delete(lib.PDFName.of('Thumb'));

  const append = areas.map((a) => `q 0 g ${num(a[0])} ${num(a[1])} ${num(a[2] - a[0])} ${num(a[3] - a[1])} re f Q`);
  return { patches, append };
}

/**
 * Drops the page's /XObject entry for each removed picture nothing left on the page draws (inside forms
 * too), so its bytes aren't kept in the saved file. A picture another draw still uses stays: it is shown
 * there. An entry that doesn't name the picture that was drawn refuses, rather than guess.
 */
function releaseImages(lib, doc, page, index, analysis, removed) {
  const { PDFName, PDFDict, PDFRef } = lib;
  const gone = new Set(removed);
  const keys = new Set(removed.filter((i) => !i.inline && i.key && !analysis.images.some((o) => !gone.has(o) && o.key === i.key)).map((i) => i.key));
  if (!keys.size) return;
  const ctx = doc.context;
  const inherited = page.node.Resources();
  const resources = inherited ? inherited.clone(ctx) : ctx.obj({});
  const current = resources.lookup(PDFName.of('XObject'));
  const xobjects = current instanceof PDFDict ? current.clone(ctx) : null;
  const names = new Map(removed.filter((i) => keys.has(i.key)).map((i) => [i.name, i]));
  for (const image of names.values()) {
    const value = xobjects?.get(PDFName.of(image.name));
    if (!(value instanceof PDFRef) || value.toString() !== image.key) refuse(index, 'a picture in an area is referred to in an unusual way, so');
    xobjects.delete(PDFName.of(image.name));
  }
  resources.set(PDFName.of('XObject'), xobjects);
  page.node.set(PDFName.of('Resources'), resources);
}
