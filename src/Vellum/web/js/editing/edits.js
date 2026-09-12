// Content edits as plain data, kept in the document's edit store (annotations/model.js) so they
// share its single undo history. A text edit refers to a run of the page's ORIGINAL content by its
// first glyph and its exact original text, so it can be found — and checked — every time the
// document is composed; it never stores positions that could drift.
//
//   { id, kind: 'text', entry, target: { key, text, glyphs }, text, encoding, transform? }
//     entry     the page plan entry (pages/plan.js) the edit belongs to: it moves with its page
//     encoding  { mode: 'font', items }   written with the run's own font, codes proven present
//               { mode: 'standard', font } a standard font of the same style (the original can't)
//               { mode: 'original' }       the file's own glyph bytes, redrawn somewhere else
//               { mode: 'none' }            the text was removed
//     transform [a b c d e f], and only once the run has been moved or scaled: an ABSOLUTE affine
//               transform in the ORIGINAL page's user space, applied AFTER the text's own
//               placement. Absolute, so a second drag of one run replaces the first in the same
//               record instead of adding another; and left out altogether when it would be the
//               identity, so an untransformed edit is the record — and writes the bytes — it
//               always was.
//
// Images are the other kind of content edit. Their record shape, their planner (planImageEdit) and
// everything about writing them live with their handler, in objects/image.js.

import { newId } from '../annotations/model.js';
import { fallbackFontFor, charactersOutsideWinAnsi } from './fonts.js';
import { explainRun, REASONS } from './runs.js';
import { isIdentity, moveAndScaleOf, quantize } from './objects/transform.js';

export class EditError extends Error {
  constructor(kind, message, detail = null) {
    super(message);
    this.name = 'EditError';
    this.kind = kind;
    this.detail = detail;
  }
}

const listOf = (chars) => chars.map((c) => `“${c}”`).join(', ');

/** Below this a scale has collapsed, and the text it is asked of would have no usable size. */
const MIN_SCALE = 1e-6;

/** Why this run can’t be edited, in its own words: the one refusal both planners raise. */
const refuseRun = (run) => {
  throw new EditError('not-editable', explainRun(run ?? { reasons: new Set() })[0] ?? 'This text can’t be edited.');
};

/**
 * The fingerprint a record is checked against every time the document is composed: the run by its
 * first glyph, its exact original text, and the glyphs it was made from. Never a position.
 */
const targetOf = (run) => ({ key: run.key, text: run.text, glyphs: run.glyphs.map(([s, g]) => [s, g]) });

/**
 * Why `transform` can’t be written for text, or null when it can.
 *
 * Text is redrawn from the file’s own glyphs, in the file’s own font, so only a move, a uniform
 * scale, or both are supported: a rotation, a mirror, a non-uniform scale or a skew would need the
 * glyphs laid out again, which Vellum can’t do yet. Both keys here are classify()’s own (runs.js)
 * — there is no second vocabulary for transforms, and none was added for them.
 */
export function textTransformRefusal(transform) {
  const factor = moveAndScaleOf(transform);
  if (factor === null || factor < 0) return 'unsupported';
  return factor < MIN_SCALE ? 'degenerate' : null;
}

/**
 * The transform to store, or null for one that changes no placement at all — nothing, or the
 * identity. Kept to the four decimals the content-stream writer can hold (quantize()) and judged
 * after rounding, so what is stored is what was judged and what the file will get. Throws when it
 * can’t be written at all.
 */
function placementOf(transform) {
  if (transform === null || transform === undefined) return null;
  const kept = quantize(transform);
  if (!kept) throw new EditError('content', 'That change to the text couldn’t be worked out, so nothing was changed.');
  const reason = textTransformRefusal(kept);
  if (reason) throw new EditError('not-editable', REASONS[reason], { reason, transform: kept });
  return isIdentity(kept) ? null : kept;
}

/**
 * Plans replacing `run` (from a verified analysis) with `text`. The run's own font is used if it
 * can write every character; otherwise a standard font of the same style, if that can and it
 * wouldn't look obviously wrong; otherwise EditError explains why not.
 * embeddedFontsOnly (PDF/A files): a substitute standard font isn't embedded, so it isn't allowed.
 * `transform` is the run's placement, carried straight through: retyping text that has been moved
 * must not put it back (planTextTransform says what a transform is and what may be in one).
 */
export function planTextEdit({ run, text, entry, glyphs, id = newId(), embeddedFontsOnly = false, transform = null }) {
  if (!run?.editable) refuseRun(run);
  // A run is one line: line breaks and tabs become spaces (reflowing paragraphs comes later).
  const clean = text.replace(/[\r\n\t\f\v]+/g, ' ').normalize('NFC');
  const target = targetOf(run);
  const placement = placementOf(transform);
  const record = { id, kind: 'text', entry, target, text: clean, ...(placement ? { transform: placement } : {}) };
  if (!clean.trim()) return { ...record, text: '', encoding: { mode: 'none' } };

  const own = run.font.planText(clean);
  if (own.ok) {
    const items = own.items.map((i) => (i.space ? { space: true } : { code: i.code, byteLength: i.byteLength }));
    return { ...record, encoding: { mode: 'font', items } };
  }
  const fallback = fallbackFontFor(run.font);
  if (!fallback.name) {
    throw new EditError('font', `This text’s font doesn’t contain ${listOf(own.missing)}, and a substitute font wouldn’t look right here.`, { missing: own.missing });
  }
  const outside = charactersOutsideWinAnsi(clean, glyphs);
  if (outside.length) {
    throw new EditError('characters', `Vellum can’t write ${listOf(outside)} into this PDF yet: neither its font nor a standard font has them.`, { missing: outside });
  }
  if (embeddedFontsOnly) {
    throw new EditError('pdfa', `This PDF follows the PDF/A archiving standard, which needs every font embedded in the file. The text’s own font doesn’t have ${listOf(own.missing)}, and Vellum can’t embed a replacement font yet, so this change would break the standard.`, { missing: own.missing });
  }
  return { ...record, encoding: { mode: 'standard', font: fallback.name, missing: own.missing } };
}

/**
 * Plans moving or scaling one text run: the record that says where it ends up.
 *
 * `transform` is ABSOLUTE and in the ORIGINAL page’s user space — where the text lands, not how far
 * it was just dragged — so a second drag of the same run replaces the first rather than composing
 * with it, and one object always has exactly one record. Only a move, a uniform scale, or both can
 * be written today; anything else raises EditError (textTransformRefusal says which).
 *
 * A run that has not been retyped gets a record in `encoding.mode: 'original'`: its own glyph
 * bytes, redrawn somewhere else, with no font looked up, nothing re-encoded and no text reflowed.
 * A run that already has a record keeps THAT record — same id, same text, same encoding — with the
 * new transform on it, because retyped-then-moved text is one edit and not two.
 *
 * The identity is not stored: like an image edit, a transform that changes nothing plans a record
 * the caller is expected to drop rather than keep.
 */
export function planTextTransform({ run = null, record = null, transform, entry, id = record?.id ?? newId() }) {
  if (record && record.kind !== 'text') throw new EditError('unsupported', REASONS.unsupported, { kind: record.kind });
  // Eligibility is the engine’s own verdict and nothing new: a run 0.4 already found editable.
  // Given a record and no run, that verdict is already in the record — it couldn’t exist otherwise.
  if (run && !run.editable) refuseRun(run);
  if (!run && !record) refuseRun(null);
  const placement = placementOf(transform);
  if (record) {
    const next = { ...record };
    if (placement) next.transform = placement;
    else delete next.transform;
    return next;
  }
  return {
    id, kind: 'text', entry, target: targetOf(run), text: run.text,
    encoding: { mode: 'original' }, ...(placement ? { transform: placement } : {}),
  };
}

/** Hash of a whole edit record. Records are never changed in place (the store replaces them), so it's kept. */
const recordHashes = new WeakMap();

function recordHash(e) {
  let h = recordHashes.get(e);
  if (h === undefined) {
    h = 0;
    for (const ch of JSON.stringify(e)) h = (Math.imul(h, 31) + ch.charCodeAt(0)) | 0;
    recordHashes.set(e, h);
  }
  return h;
}

/**
 * A short string that changes whenever a page's edits change in any way - text, font, placement
 * or anything else in the records - for caches such as thumbnails.
 */
export function editSignature(edits, entryId) {
  let hash = 0;
  let count = 0;
  for (const e of edits) {
    if (e.entry !== entryId) continue;
    count++;
    hash = (Math.imul(hash, 31) + recordHash(e)) | 0;
  }
  return count ? `e${count}.${(hash >>> 0).toString(36)}` : '';
}

/**
 * Edit changes that keep edits with their pages when the page plan changes: deleted pages take
 * their edits away, duplicated pages get copies. (Moved pages keep their entry ids.)
 */
export function followEdits(edits, newPlan, copies = []) {
  const kept = new Set(newPlan.map((e) => e.id));
  const changes = [];
  for (const e of edits) if (!kept.has(e.entry)) changes.push({ edit: { before: e, after: null } });
  for (const [fromId, toId] of copies) {
    for (const e of edits) if (e.entry === fromId) changes.push({ edit: { before: null, after: { ...e, id: newId(), entry: toId } } });
  }
  return changes;
}
