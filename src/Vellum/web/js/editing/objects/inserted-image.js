// The handler for pictures put onto a page from a file: new objects, not changes to ones the page
// already draws. Registered in registry.js, which is what makes the `inserted-image` kind writable.
//
//   { id, kind: 'inserted-image', entry,
//     picture: { source, format, width, height },   the image, exactly as a replacement keeps it
//     transform: [a b c d e f] }                     the image's unit square → the ORIGINAL page's user space
//
// A picture that isn't in the page's content has no operator to fingerprint, so the record itself is
// the object: its identity is `inserted:<id>`, and `transform` is its whole placement rather than a
// change to one — moving it replaces the transform, deleting it removes the record, and undo and redo
// are the edit store's. The image's bytes live in the document's `sources`, embedded once per file
// and copied per compose, exactly as for a replaced picture (objects/image.js embedPictures).
//
// It is drawn AFTER the page's own content, the way moved text is, in a graphics state of its own:
//
//   q <transform> cm /VlImgN Do Q
//
// under a new name in the page's /XObject resources (image.js updateResources, which never reuses a
// name the page already has and clones inherited resources first). Nothing already on the page is
// touched: only its content is wrapped and this is appended.
//
// To the object model it is a picture like any other (kind 'image', page-objects.js insertedObject),
// with an identity CTM and the unit square as its outline, so selecting, moving, scaling, stretching, turning, mirroring, snapping,
// arranging and deleting it all go through what already exists.

import { EditError } from '../edits.js';
import { pdfaClaim } from '../source.js';
import { num } from '../content/writer.js';
import { apply, applyLinear, invert, multiply } from '../matrix.js';
import { determinant, quantize } from './transform.js';
import { embedPictures, replacementOf, updateResources } from './image.js';
import { newId } from '../../annotations/model.js';

/** The kind of edit record this handler writes. */
export const kind = 'inserted-image';

/** The object-model key of an inserted picture. */
export const keyOf = (record) => `inserted:${record.id}`;

/** Below this (square points) a placement has no usable area. */
const MIN_AREA = 1e-6;

/** How big a pixel is when a picture is first placed: an image shown at 96 pixels to the inch. */
const POINTS_PER_PIXEL = 0.75;

/** A new picture never starts larger than this share of the page's width or height, as shown. */
const MAX_SHARE = 0.5;

/**
 * Plans an inserted picture at `transform`: a record, or EditError. Used for a new picture and for
 * every later change to one (same `id`), so a record always holds exactly where the picture is.
 */
export function planInsertion({ picture, transform, entry, id = newId() }) {
  const kept = quantize(transform);
  if (!kept || !(Math.abs(determinant(kept)) >= MIN_AREA)) {
    throw new EditError('content', 'That change to the picture couldn’t be worked out, so nothing was changed.');
  }
  return { id, kind, entry, picture: replacementOf(picture), transform: kept };
}

/**
 * Where a new picture of `width` × `height` pixels goes: centred on the page, upright as the page is
 * shown (`basis`, page-space.js displayBasis, whatever the page's or the view's rotation), at its
 * natural size (96 pixels to the inch) but no more than half the page's shown width or height, never
 * enlarged. `box` is the page's crop box in user space. A transform, or null when there is none.
 */
export function defaultPlacement({ width, height, box, basis }) {
  const back = basis ? invert(basis) : null;
  if (!back || !(width > 0 && height > 0) || !box) return null;
  const shown = [[box[0], box[1]], [box[2], box[1]], [box[2], box[3]], [box[0], box[3]]].map(([x, y]) => applyLinear(basis, x, y));
  const span = (axis) => Math.max(...shown.map((p) => p[axis])) - Math.min(...shown.map((p) => p[axis]));
  const w = width * POINTS_PER_PIXEL;
  const h = height * POINTS_PER_PIXEL;
  const factor = Math.min(1, (MAX_SHARE * span(0)) / w, (MAX_SHARE * span(1)) / h);
  // Upright on screen: shown space runs downwards, and an image's unit square runs up.
  const linear = multiply([w * factor, 0, 0, -h * factor, 0, 0], back);
  const [px, py] = apply(linear, 0.5, 0.5);
  return quantize([linear[0], linear[1], linear[2], linear[3], (box[0] + box[2]) / 2 - px, (box[1] + box[3]) / 2 - py]);
}

/** A PDF/A file is refused a new picture, for the reason a replacement is (objects/image.js precheck). */
export function precheck({ lib, doc, records }) {
  if (records.length && pdfaClaim(lib, doc)) {
    throw new EditError('pdfa', 'This PDF follows the PDF/A archiving standard, and Vellum can’t check that a new picture meets it, so nothing was changed.');
  }
}

/** Embeds every inserted picture's image once, before any page is written. */
export function prepare({ lib, doc, records, sources }) {
  return embedPictures(lib, doc, records.map((r) => r.picture), sources);
}

/** One page's inserted pictures: nothing patched, one draw appended for each, under a new name. */
export function write({ lib, doc, page, index, analysis, records, prepared }) {
  const refs = records.map((record) => {
    const t = record.transform;
    if (!Array.isArray(t) || !quantize(t) || !(Math.abs(determinant(t)) >= MIN_AREA)) {
      throw new EditError('content', `A picture put on page ${index + 1} has no usable placement, so nothing was changed.`);
    }
    const ref = prepared?.embedded?.get(record.picture?.source);
    if (!ref) throw new EditError('missing', `A picture put on page ${index + 1} isn’t available, so nothing was changed.`);
    return ref;
  });
  const names = updateResources(lib, doc, page, analysis, [], refs);
  return { patches: [], append: records.map((r, i) => `q ${r.transform.map(num).join(' ')} cm /${names[i]} Do Q`) };
}
