// The image handler for the page writer: everything about moving, scaling, turning, flipping and
// deleting an image that is already on a page. Registered in registry.js, which is what makes the
// `image` kind writable.
//
// An image record is plain data in the document's edit store, beside the text records:
//
//   { id, kind: 'image', entry,
//     target: { key, stream, opIndex, name, inline, ctm, width, height },
//     transform: [a b c d e f] | null,   absolute, in the ORIGINAL page's user space
//     removed: false }
//
// `target` is a fingerprint, checked against the page's ORIGINAL content every time the document is
// composed: the same draw must still be at that operator, of the same resource, at the same place,
// the same size — or nothing is written at all. `key` is the object model's identity
// (`image:<stream>#<opIndex>`); `name` is part of the fingerprint and never part of the identity,
// because one resource is drawn many times and an inline image has no name at all.
//
// Unlike text, an image is changed IN PLACE. Text has to be lifted out and redrawn after the page,
// because a run's position lives in a text matrix it shares with its neighbours; an image is one
// operator with one CTM, so wrapping it:
//
//   q <C · T · C⁻¹> cm  <the original operator, byte for byte>  Q
//
// leaves everything else about the draw exactly as the page had it — its place in the drawing order,
// its clip, its ExtGState, the fill colour a stencil mask paints with, its marked-content sequence
// and its /OC layer — and changes only where it lands. The original bytes are never copied or
// re-encoded: the two patches are insertions on either side of them, so an inline image's raw data
// cannot be touched even in principle.
//
// Deleting removes the operator's bytes and nothing else. What the page did around the draw — a `cm`
// that was already there, a clip, a marked-content sequence — still happens, exactly as before.
//
// One consequence of writing the transform in the image's OWN space is worth knowing: the numbers
// emitted are in unit-square units, where 1 is the whole width of the picture, and the writer keeps
// four decimals (num(), content/writer.js). So the placement is exact to about a ten-thousandth of
// the picture's own size — for a picture 200 points across, better than a fiftieth of a point. The
// alternative, a page-space `cm`, cannot be written at all without disturbing the operators around
// it, so this is the precision the approach costs, measured and not guessed
// (tests/editing/image-edits.test.mjs pins it).

import { EditError } from '../edits.js';
import { REASONS } from '../runs.js';
import { num } from '../content/writer.js';
import { conjugate, determinant, isIdentity, isValid, quantize } from './transform.js';
import { newId } from '../../annotations/model.js';

/** The kind of edit record this handler writes. */
export const kind = 'image';

/** Below this a placement has no usable area: C⁻¹ doesn't exist, so no transform can be expressed. */
const MIN_AREA = 1e-6;

/** Is box `b` inside box `c`, within `tol`? The same test classify() applies to clipped text. */
const inside = (b, c, tol) => b[0] >= c[0] - tol && b[1] >= c[1] - tol && b[2] <= c[2] + tol && b[3] <= c[3] + tol;

/**
 * Why this image can't be moved, scaled, turned, flipped or deleted, or null when it can.
 *
 * Every key here is one classify() already uses (editing/runs.js): there is no second vocabulary,
 * and nothing new was added for images. In the order they are reported:
 *
 *  - `form`      drawn by a Form XObject. Its bytes are in the form's stream, which the page writer
 *                doesn't splice, and rewriting a shared form would change every place it is drawn.
 *  - `layer`     on optional content that can be switched off.
 *  - `soft-mask` drawn through an ExtGState soft mask, which sits in page space: moving the image
 *                but not the mask would change how it looks. (An image's OWN /SMask travels with it
 *                and is fine.)
 *  - `clipped`   a clip that doesn't already contain the whole image, so moving it would crop it
 *                differently. The same rule, and the same tolerance, as clipped text.
 *  - `degenerate` a placement with no usable area: C⁻¹ doesn't exist and no transform could be
 *                written for it.
 *
 * Page-wide refusals (`unreadable`, `structure`) are not here: they are about the page, the page
 * writer already refuses such a page outright, and the capability model reports them.
 */
export function imageRefusal(record, ref) {
  if (!record || !ref) return 'unsupported';
  if (ref.stream !== 'page') return 'form';
  if (record.oc) return 'layer';
  if (record.softMask) return 'soft-mask';
  if (record.clip && (!record.clip.exact || !inside(record.box, record.clip.box, 0.5))) return 'clipped';
  if (!isValid(record.ctm) || Math.abs(determinant(record.ctm)) < MIN_AREA) return 'degenerate';
  return null;
}

const refuse = (reason) => {
  throw new EditError('not-editable', REASONS[reason], { reason });
};

/**
 * Plans moving, scaling, turning, flipping or deleting one image: a record, or EditError saying why
 * not. `object` is the object model's image (objects/page-objects.js) — its `ref` for identity and
 * its `record` for the facts to fingerprint.
 *
 * `transform` is absolute and in the original page's user space, and is kept to the four decimals
 * the content-stream writer can hold, so what was drawn on screen is what goes into the file.
 * Passing the identity, or nothing, plans a record that changes nothing — the caller is expected to
 * drop such a record rather than store it.
 */
export function planImageEdit({ object, transform = null, removed = false, entry, id = newId() }) {
  if (object?.kind !== 'image') throw new EditError('unsupported', REASONS.unsupported, { kind: object?.kind ?? null });
  const reason = imageRefusal(object.record, object.ref);
  if (reason) refuse(reason);
  const { ref, record } = object;
  const target = {
    key: ref.key,
    stream: ref.stream,
    opIndex: ref.opIndex,
    name: record.name,
    inline: record.inline,
    ctm: [...record.ctm],
    width: record.info?.width ?? null,
    height: record.info?.height ?? null,
  };
  if (removed) return { id, kind, entry, target, transform: null, removed: true };
  const kept = quantize(transform ?? [1, 0, 0, 1, 0, 0]);
  if (!kept) throw new EditError('content', 'That change to the picture couldn’t be worked out, so nothing was changed.');
  // The transform has to be expressible where the image is actually drawn, not only on the page.
  if (!conjugate(record.ctm, kept)) refuse('degenerate');
  return { id, kind, entry, target, transform: kept, removed: false };
}

/**
 * The changes one page's image edits make: byte patches into the page's own content. Nothing is
 * appended — an image is never redrawn, only wrapped or removed — so `append` is always empty.
 * Throws (and nothing at all is written) if a record no longer matches the file.
 */
export function write({ lib, doc, page, index, analysis, records }) {
  const patches = [];
  const deleted = [];
  const seen = new Set();
  for (const record of records) {
    const image = verify(analysis, record, index);
    if (seen.has(record.target.key)) throw new EditError('changed', 'Two changes refer to the same picture.');
    seen.add(record.target.key);
    const [start, end] = image.range;
    if (record.removed) {
      // The draw goes; everything the page did around it still happens, exactly as before.
      patches.push({ start, end, text: '' });
      deleted.push(image);
      continue;
    }
    if (!record.transform || isIdentity(record.transform)) continue; // a record that changes nothing
    const local = conjugate(image.ctm, record.transform);
    if (!local) {
      throw new EditError('content', `A picture on page ${index + 1} is drawn in a way Vellum can’t move it from, so nothing was changed.`);
    }
    // Two insertions, not a replacement: the operator's own bytes are never copied, so an inline
    // image's raw data comes through untouched by construction.
    patches.push({ start, end: start, text: `q ${local.map(num).join(' ')} cm ` });
    patches.push({ start: end, end, text: ' Q' });
  }
  if (deleted.length) releaseResources(lib, doc, page, analysis, deleted);
  return { patches, append: [] };
}

/**
 * The image a record refers to, as the page's ORIGINAL content has it now — or EditError. The draw
 * is found by where it is (its stream and operator), which is what identifies it; everything else
 * about it is then checked, so a record can never be written against a different picture.
 *
 * The refusals are checked again here, after the planner. A record that should never have existed
 * is refused at the writer too, the way a PDF/A-breaking font change is: the file is what matters,
 * and it must not depend on the UI having asked the right question.
 */
function verify(analysis, record, index) {
  const t = record.target;
  const image = analysis.images.find((i) => (i.stream ?? 'page') === t.stream && i.opIndex === t.opIndex);
  const same = image
    && image.name === t.name
    && image.inline === t.inline
    && (image.info?.width ?? null) === t.width
    && (image.info?.height ?? null) === t.height
    && Array.isArray(image.ctm) && image.ctm.length === t.ctm.length && image.ctm.every((v, i) => v === t.ctm[i]);
  if (!same) {
    throw new EditError('changed', `The picture being changed on page ${index + 1} isn’t in the file as expected any more, so nothing was changed.`);
  }
  const reason = imageRefusal(image, { stream: t.stream });
  if (reason) throw new EditError('not-editable', REASONS[reason], { reason });
  return image;
}

/**
 * Drops the /XObject entry for an image that has just been deleted — but only when that is provably
 * safe, so that a file is never left referring to something that isn't there. File correctness comes
 * before tidiness: when any of this can't be proven, the entry stays and the image data stays with
 * it, which costs some bytes and breaks nothing.
 *
 * Safe means all of:
 *  - the image has a resource name at all (an inline image has none, and nothing to release);
 *  - no other draw anywhere on this page uses that name, counting the ones inside forms and not
 *    counting the draws being deleted;
 *  - no Form XObject is drawn on the page. A form may inherit the page's resources, and proving
 *    which names its content resolves through them would mean interpreting it again.
 *
 * Removing the entry is all that is needed: composeDocument's garbage collection sweeps from the
 * trailer, so the image's bytes go only if nothing else in the file reaches them, and an appearance
 * stream or another page that still uses the image keeps it alive by itself.
 *
 * The resources are cloned before being changed, exactly as adding a font to a page clones them: a
 * page may inherit its /Resources from the page tree, and other pages must not be touched.
 */
function releaseResources(lib, doc, page, analysis, deleted) {
  const { PDFName, PDFDict } = lib;
  const ctx = doc.context;
  const gone = new Set(deleted.map((i) => `${i.stream ?? 'page'}#${i.opIndex}`));
  const names = new Set(deleted.filter((i) => !i.inline && i.name).map((i) => i.name));
  if (!names.size || analysis.forms.length) return;

  const releasable = [...names].filter((name) => !analysis.images.some((i) => (
    i.name === name && !gone.has(`${i.stream ?? 'page'}#${i.opIndex}`)
  )));
  if (!releasable.length) return;

  const inherited = page.node.Resources();
  const resources = inherited ? inherited.clone(ctx) : ctx.obj({});
  const current = resources.lookup(PDFName.of('XObject'));
  if (!(current instanceof PDFDict)) return;
  const xobjects = current.clone(ctx);
  let released = 0;
  for (const name of releasable) {
    if (!xobjects.has(PDFName.of(name))) continue;
    xobjects.delete(PDFName.of(name));
    released++;
  }
  if (!released) return;
  resources.set(PDFName.of('XObject'), xobjects);
  page.node.set(PDFName.of('Resources'), resources);
}
