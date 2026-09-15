// The image handler for the page writer: everything about moving, scaling, turning, flipping and
// deleting an image that is already on a page. Registered in registry.js, which is what makes the
// `image` kind writable.
//
// An image record is plain data in the document's edit store, beside the text records:
//
//   { id, kind: 'image', entry,
//     target: { key, stream, opIndex, name, inline, ctm, width, height },
//     transform: [a b c d e f] | null,   absolute, in the ORIGINAL page's user space
//     removed: false,
//     replacement?: { source, format, width, height } }
//
// `replacement` is there only once the picture has been replaced with an image from a file: `source`
// names its bytes in the document's `sources` map (the one pages inserted from other PDFs already
// keep their bytes in), `format` is 'png' or 'jpeg', and width and height are its pixels.
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
// Replacing is the one change that does swap the operator: `/Im1 Do` becomes `/VlImg1 Do`, a new name
// in the page's resources for the embedded image (inside the same q … cm … Q when it has also been
// moved). Every image is drawn into its unit square, so the new picture fills exactly the frame the
// old one had — its place, size, turn, mirror and shear, its clip and its place in the drawing
// order — and nothing else about the page changes. Only the name is new: the old resource is still
// there for any other draw of it, and is released on the same terms as a deleted picture's.
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
import { pdfaClaim } from '../source.js';
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

/**
 * Why this image can't be replaced with another, or null when it can: everything imageRefusal()
 * says, and an inline image, which has no resource to swap (replacing one is deferred, audit §1).
 */
export function replaceRefusal(record, ref) {
  return imageRefusal(record, ref) ?? (record.inline ? 'unsupported' : null);
}

const refuse = (reason) => {
  throw new EditError('not-editable', REASONS[reason], { reason });
};

/** The image formats a picture can be replaced with, by their first bytes. */
const SIGNATURES = Object.freeze({ png: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], jpeg: [0xff, 0xd8, 0xff] });

/** The most pixels a PNG may have: decoding one takes several bytes per pixel, several times over. */
const MAX_PNG_PIXELS = 40_000_000;

const formatOf = (bytes) => Object.keys(SIGNATURES).find((f) => SIGNATURES[f].every((b, i) => bytes?.[i] === b)) ?? null;

/**
 * Reads an image file a picture is to be replaced with: { format, width, height }, or EditError
 * saying why it can't be used. It is embedded into a scratch document to find out — the same
 * pdf-lib embedding the writer will do — so a file that is accepted here is one the writer can
 * write, and a damaged one is refused now rather than failing every save afterwards.
 */
export async function readPicture(lib, bytes) {
  const format = bytes instanceof Uint8Array ? formatOf(bytes) : null;
  if (!format) throw new EditError('picture', 'Vellum can put a PNG or JPEG image into a page. This file isn’t one.');
  // A PNG is decoded pixel by pixel to be embedded, and a small file can claim an enormous image;
  // its header says how many pixels before any of them is decoded. (A JPEG is embedded undecoded.)
  if (format === 'png' && bytes.length >= 24) {
    const header = new DataView(bytes.buffer, bytes.byteOffset + 16, 8);
    if (header.getUint32(0) * header.getUint32(4) > MAX_PNG_PIXELS) {
      throw new EditError('picture', 'This PNG image is too large to put into a page (more than 40 megapixels).');
    }
  }
  try {
    const { width, height } = await embedded(lib, format, bytes);
    return { format, width, height };
  } catch {
    throw new EditError('picture', `This ${format === 'png' ? 'PNG' : 'JPEG'} image couldn’t be read. It may be damaged, or in a variant Vellum can’t embed.`);
  }
}

/** Image bytes → the scratch document they were embedded into once: Promise<{ scratch, ref, width, height }>. */
const scratches = new WeakMap();

/**
 * The image embedded, once for these bytes, into a scratch document of its own. Every document that
 * is composed afterwards copies the finished streams from there (prepare()), because embedding is
 * the slow part — a PNG is decoded and compressed again, most of a second for a large photograph —
 * and the pages are composed again after every change.
 */
function embedded(lib, format, bytes) {
  let pending = scratches.get(bytes);
  if (!pending) {
    pending = (async () => {
      const scratch = await lib.PDFDocument.create();
      const image = await (format === 'png' ? scratch.embedPng(bytes) : scratch.embedJpg(bytes));
      await image.embed();
      if (!(image.width > 0 && image.height > 0)) throw new Error('no pixels');
      return { scratch, ref: image.ref, width: image.width, height: image.height };
    })();
    pending.catch(() => scratches.delete(bytes));
    scratches.set(bytes, pending);
  }
  return pending;
}

/** A picture from a file as a record keeps it ({ source, format, width, height }), or EditError when it isn't one. */
export function replacementOf(value) {
  const { source, format, width, height } = value ?? {};
  const pixels = (n) => Number.isInteger(n) && n > 0;
  if (typeof source !== 'string' || !source || !SIGNATURES[format] || !pixels(width) || !pixels(height)) {
    throw new EditError('content', 'That picture couldn’t be used, so nothing was changed.');
  }
  return { source, format, width, height };
}

/**
 * Plans moving, scaling, turning, flipping, replacing or deleting one image: a record, or EditError
 * saying why not. `object` is the object model's image (objects/page-objects.js) — its `ref` for
 * identity and its `record` for the facts to fingerprint.
 *
 * `transform` is absolute and in the original page's user space, and is kept to the four decimals
 * the content-stream writer can hold, so what was drawn on screen is what goes into the file.
 * Passing the identity, or nothing, with no `replacement`, plans a record that changes nothing — the
 * caller is expected to drop such a record rather than store it.
 *
 * `replacement` ({ source, format, width, height }, from readPicture() and the document's sources)
 * rides along with any placement: a replaced picture can still be moved, and a moved one replaced.
 */
export function planImageEdit({ object, transform = null, removed = false, replacement = null, entry, id = newId() }) {
  if (object?.kind !== 'image') throw new EditError('unsupported', REASONS.unsupported, { kind: object?.kind ?? null });
  const reason = replacement && !removed ? replaceRefusal(object.record, object.ref) : imageRefusal(object.record, object.ref);
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
  const planned = { id, kind, entry, target, transform: kept, removed: false };
  return replacement ? { ...planned, replacement: replacementOf(replacement) } : planned;
}

/**
 * Checked once for the whole document, before anything is written. A PDF/A file is refused a
 * replacement: the standard constrains an image's colour space and transparency against the file's
 * output intent, which Vellum doesn't check, and a change it can't vouch for isn't written.
 */
export function precheck({ lib, doc, records }) {
  if (records.some((r) => r.replacement && !r.removed) && pdfaClaim(lib, doc)) {
    throw new EditError('pdfa', 'This PDF follows the PDF/A archiving standard, and Vellum can’t check that a new picture meets it, so nothing was changed.');
  }
}

/**
 * Adds every image the records replace pictures with to the document, once each however many draws
 * use it: { embedded: Map source → ref }. The streams are copied from the image's scratch document
 * (embedded()), its soft mask with it — the same objects pdf-lib's embedding writes, without doing
 * that work again. Runs before any page is written, so a missing or unreadable image refuses the
 * whole document.
 */
export function prepare({ lib, doc, records, sources }) {
  return embedPictures(lib, doc, records.filter((r) => !r.removed).map((r) => r.replacement), sources);
}

/**
 * Adds the images of these pictures from files ({ source, format, width, height }, falsy entries
 * skipped) to the document, once per source: { embedded: Map source → ref }. Shared with inserted
 * pictures (objects/inserted-image.js), which are embedded the same way.
 */
export async function embedPictures(lib, doc, pictures, sources) {
  const refs = new Map();
  for (const r of pictures) {
    if (!r || refs.has(r.source)) continue;
    const bytes = sources?.get(r.source);
    if (!(bytes instanceof Uint8Array) || formatOf(bytes) !== r.format) {
      throw new EditError('missing', 'A picture chosen for this document isn’t available any more, so nothing was changed.');
    }
    const image = await embedded(lib, r.format, bytes).catch(() => null);
    if (!image || image.width !== r.width || image.height !== r.height) {
      throw new EditError('changed', 'A picture chosen for this document isn’t the one that was chosen, so nothing was changed.');
    }
    const copy = lib.PDFObjectCopier.for(image.scratch.context, doc.context).copy(image.scratch.context.lookup(image.ref));
    refs.set(r.source, doc.context.register(copy));
  }
  return { embedded: refs };
}

/**
 * The changes one page's image edits make: byte patches into the page's own content. Nothing is
 * appended — an image is never redrawn, only wrapped or removed — so `append` is always empty.
 * Throws (and nothing at all is written) if a record no longer matches the file.
 */
export function write({ lib, doc, page, index, analysis, records, prepared }) {
  const patches = [];
  const dropped = []; // draws that no longer use their resource: deleted or replaced
  const added = []; // { patch, ref, local } for each replaced draw, named once all of them are known
  const seen = new Set();
  for (const record of records) {
    const image = verify(analysis, record, index);
    if (seen.has(record.target.key)) throw new EditError('changed', 'Two changes refer to the same picture.');
    seen.add(record.target.key);
    const [start, end] = image.range;
    if (record.removed) {
      // The draw goes; everything the page did around it still happens, exactly as before.
      patches.push({ start, end, text: '' });
      dropped.push(image);
      continue;
    }
    const moved = record.transform && !isIdentity(record.transform);
    const local = moved ? conjugate(image.ctm, record.transform) : null;
    if (moved && !local) {
      throw new EditError('content', `A picture on page ${index + 1} is drawn in a way Vellum can’t move it from, so nothing was changed.`);
    }
    if (record.replacement) {
      const reason = replaceRefusal(image, { stream: record.target.stream });
      if (reason) throw new EditError('not-editable', REASONS[reason], { reason });
      const ref = prepared?.embedded?.get(record.replacement.source);
      if (!ref) throw new EditError('missing', `The picture replacing one on page ${index + 1} isn’t available, so nothing was changed.`);
      // The operator itself is swapped for a draw of the new image, in the same placement. Its
      // resource name is only known once every replacement on the page has one (below).
      const patch = { start, end, text: null };
      added.push({ patch, ref, local });
      patches.push(patch);
      dropped.push(image);
      continue;
    }
    if (!moved) continue; // a record that changes nothing
    // Two insertions, not a replacement: the operator's own bytes are never copied, so an inline
    // image's raw data comes through untouched by construction.
    patches.push({ start, end: start, text: `q ${local.map(num).join(' ')} cm ` });
    patches.push({ start: end, end, text: ' Q' });
  }
  if (added.length || dropped.length) {
    const names = updateResources(lib, doc, page, analysis, dropped, added.map((a) => a.ref));
    added.forEach(({ patch, local }, i) => {
      patch.text = local ? ` q ${local.map(num).join(' ')} cm /${names[i]} Do Q ` : ` /${names[i]} Do `;
    });
  }
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
 * Changes a page's /XObject resources for the draws its image edits removed or replaced: a new name
 * for each image that replaces a picture (returned, in the order given), and the entry of an image
 * nothing on the page draws any more dropped — but only when that is provably safe, so that a file is
 * never left referring to something that isn't there. File correctness comes before tidiness: when
 * it can't be proven, the entry stays and the image data stays with it, which costs some bytes and
 * breaks nothing.
 *
 * Safe to drop means all of:
 *  - the image has a resource name at all (an inline image has none, and nothing to release);
 *  - no other draw anywhere on this page uses that name, counting the ones inside forms and not
 *    counting the draws being deleted or replaced;
 *  - no Form XObject is drawn on the page. A form may inherit the page's resources, and proving
 *    which names its content resolves through them would mean interpreting it again.
 *
 * A new name is one the page's /XObject dictionary doesn't already have, so no draw that stays can
 * find a different image under its name. Removing an entry is all that is needed: composeDocument's
 * garbage collection sweeps from the trailer, so the image's bytes go only if nothing else in the
 * file reaches them, and an appearance stream or another page that still uses the image keeps it
 * alive by itself.
 *
 * The resources are cloned before being changed, exactly as adding a font to a page clones them: a
 * page may inherit its /Resources from the page tree, and other pages must not be touched.
 */
export function updateResources(lib, doc, page, analysis, dropped, refs) {
  const { PDFName, PDFDict } = lib;
  const ctx = doc.context;
  const gone = new Set(dropped.map((i) => `${i.stream ?? 'page'}#${i.opIndex}`));
  const names = new Set(analysis.forms.length ? [] : dropped.filter((i) => !i.inline && i.name).map((i) => i.name));
  const releasable = [...names].filter((name) => !analysis.images.some((i) => (
    i.name === name && !gone.has(`${i.stream ?? 'page'}#${i.opIndex}`)
  )));
  if (!releasable.length && !refs.length) return [];

  const inherited = page.node.Resources();
  const resources = inherited ? inherited.clone(ctx) : ctx.obj({});
  const current = resources.lookup(PDFName.of('XObject'));
  if (!(current instanceof PDFDict) && !refs.length) return [];
  const xobjects = current instanceof PDFDict ? current.clone(ctx) : ctx.obj({});
  let changed = 0;
  for (const name of releasable) {
    if (!xobjects.has(PDFName.of(name))) continue;
    xobjects.delete(PDFName.of(name));
    changed++;
  }
  // Named after everything the page's dictionary held before any entry was dropped, so a released
  // name is never handed straight to a different image.
  const taken = new Set(current instanceof PDFDict ? current.keys().map((k) => k.asString()) : []);
  let n = 1;
  const added = refs.map((ref) => {
    while (taken.has(`/VlImg${n}`)) n++;
    const name = `VlImg${n++}`;
    xobjects.set(PDFName.of(name), ref);
    changed++;
    return name;
  });
  if (!changed) return added;
  resources.set(PDFName.of('XObject'), xobjects);
  page.node.set(PDFName.of('Resources'), resources);
  return added;
}
