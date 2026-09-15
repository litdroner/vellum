// What may be done to one object on a page, verb by verb. Derived from the analysis the engine has
// already made (editing/runs.js) and from the refusals each handler already publishes — it decides
// nothing new and parses nothing.
//
//   capabilities = { move, scale, stretch, rotate, editText, delete }
//
// Each value is `true` (Vellum can do this today) or a key from the ONE reason vocabulary in
// runs.js, which is what turns it into a sentence a person reads. There is no second table.
//
// `scale` is uniform — the same factor both ways — and `stretch` is not: a different factor along
// one of the object's own axes. They are separate verbs because they have separate answers for text.
//
// A verb is true only where a writer can honour it:
//
//   text    move, scale and delete follow `editText` exactly — the 0.4 engine's own verdict. Moved
//           and scaled text is redrawn from the file's own glyphs (objects/text-run.js), and
//           deleting is what writing empty text has always done. `stretch` and `rotate` are not
//           offered: the glyphs would have to be laid out again, which Vellum can't do.
//   images  move, scale, stretch, rotate and delete are true together, because one `cm` patch
//           writes any of them (objects/image.js). They are true when imageRefusal() — the handler's
//           own gate, the same one the writer checks again before any byte is written — says nothing
//           is wrong. `editText` is never true: an image has no text.
//   paths
//   forms   nothing: neither has a writer, and neither has an oriented outline to grab.
//
// A wrong "no" costs a feature; a wrong "yes" corrupts a file. So nothing here is true that the
// writer would not accept, and the writer never trusts this module to have asked.
//
// Several selected objects answer together (sharedCapability): a verb is on offer for a selection
// only when every object in it allows it, because a gesture on several objects is written whole or
// not at all.

import { imageRefusal } from './image.js';
import { REASONS } from '../runs.js';

/** The verbs an object answers for, in this order. */
export const VERBS = Object.freeze(['move', 'scale', 'stretch', 'rotate', 'editText', 'delete']);

/**
 * Refusals that are about the object or the page as a whole rather than about text, in the order
 * they are reported when more than one applies. The page-wide two come first: if the page can't be
 * rewritten at all, nothing on it can be touched, whatever else is true of the object.
 */
const STRUCTURAL = Object.freeze(['unreadable', 'structure', 'form', 'layer', 'soft-mask']);

/**
 * The structural refusal for one object, or null when none applies.
 *
 * A text run is asked in its own words: classify() has already put exactly these keys into
 * run.reasons (a tainted page adds `unreadable`, an unbalanced one `structure`, and each show
 * contributes `form`, `layer` and `soft-mask`), so reading them back is the engine's own decision
 * rather than a second opinion on the same facts. The other kinds record those facts directly —
 * every image, path and form carries the stream it is drawn in, its layer and its soft mask — so
 * they are read from the record, in the same order.
 */
function structural(analysis, kind, record, ref) {
  if (kind === 'text-run') return STRUCTURAL.find((key) => record.reasons.has(key)) ?? null;
  if (analysis.tainted) return 'unreadable';
  if (analysis.unbalanced) return 'structure';
  if (ref.stream !== 'page') return 'form'; // drawn by a Form XObject, which Vellum can't rewrite
  if (record.oc) return 'layer'; // on a layer that can be switched off
  if (record.softMask) return 'soft-mask';
  return null;
}

/**
 * A text run's `editText`: exactly what run.editable says today, and when it says no, the same
 * reason the tooltip and the edit error already show — explainRun() reads the set in insertion
 * order, so this takes the first key the same way. The full set stays on the object as `reasons`,
 * so nothing is lost when several apply. An unverified analysis has no verdict yet; `unverified` is
 * the key classify() uses for precisely that, and is what run.reasons holds until verifyPage() runs.
 */
const editTextOf = (run) => (run.editable ? true : [...run.reasons][0] ?? 'unverified');

/**
 * The capabilities of one object. Pure: it reads the analysis and the record and changes neither.
 * Never called while a document is being composed — the writer works from edit records and has no
 * use for this (tests/editing/capabilities.test.mjs keeps it out of that path).
 */
export function capabilitiesFor(analysis, kind, record, ref) {
  const blocked = structural(analysis, kind, record, ref);
  const capabilities = {};
  for (const verb of VERBS) capabilities[verb] = blocked ?? 'unsupported';
  if (kind === 'text-run') {
    // One verdict answers four verbs. Moving, scaling and deleting text all go through the same
    // writer as retyping it, so text that can't be edited can't be moved either, and says so in
    // the same words. A stretch or a rotation has no writer at all, so each keeps the plain
    // `unsupported` (or the structural reason, when there is one).
    const verdict = editTextOf(record);
    capabilities.editText = verdict;
    capabilities.move = verdict;
    capabilities.scale = verdict;
    capabilities.delete = verdict;
  } else if (kind === 'image') {
    // The handler's own gate, asked once. It repeats the structural checks and adds the two only
    // it can make — a clip that would crop the picture differently, and a placement with no
    // invertible basis — so a `true` here is a promise the writer has already agreed to keep.
    const reason = blocked ?? imageRefusal(record, ref);
    if (!reason) {
      capabilities.move = true;
      capabilities.scale = true;
      capabilities.stretch = true;
      capabilities.rotate = true;
      capabilities.delete = true;
    } else {
      for (const verb of VERBS) capabilities[verb] = reason;
      capabilities.editText = reason; // an image has no text; the structural reason is still why
    }
  }
  return Object.freeze(capabilities);
}

/**
 * Whether every one of several objects allows `verb`: `true`, or the first refusal met, as
 * { reason, object }, in the order the objects are given. Nothing at all allows nothing — there is
 * no gesture to make — and says so in the vocabulary's own `unsupported`.
 */
export function sharedCapability(objects, verb) {
  if (!objects?.length) return { reason: 'unsupported', object: null };
  for (const object of objects) {
    const answer = object.capabilities?.[verb] ?? 'unsupported';
    if (answer !== true) return { reason: answer, object };
  }
  return true;
}

/** How a refused verb is named in a sentence about several objects. */
const REFUSED = Object.freeze({ move: 'moved', scale: 'resized', stretch: 'stretched', rotate: 'turned', editText: 'edited', delete: 'deleted' });

/**
 * The sentence a refusal is reported in: the reason in its own words, and for a selection of
 * several objects, first that not all of them can be — so it is plain that the whole gesture was
 * held back, not only the part that one object refused.
 */
export function refusalMessage(verb, reason, count = 1) {
  const why = REASONS[reason] ?? REASONS.unsupported;
  return count > 1 ? `Not all of the selected objects can be ${REFUSED[verb] ?? 'changed'}. ${why}` : why;
}
