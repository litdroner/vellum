// What may be done to one object on a page, verb by verb. Derived from the analysis the engine has
// already made (editing/runs.js) — it decides nothing new and parses nothing.
//
//   capabilities = { move, scale, rotate, editText, delete }
//
// Each value is `true` (Vellum can do this today) or a key from the ONE reason vocabulary in
// runs.js, which is what turns it into a sentence a person reads. There is no second table.
//
// Today exactly one cell can be true: a text run's `editText`, and only when the 0.4 engine already
// found that run editable. Nothing else is true because nothing else is written: objects/registry.js
// has one handler, for text. Move, scale, rotate and delete have no writer, so they say so rather
// than claiming a permission that no code could honour — a wrong "no" costs a feature, a wrong
// "yes" corrupts a file.

/** The verbs an object answers for, in this order. */
export const VERBS = Object.freeze(['move', 'scale', 'rotate', 'editText', 'delete']);

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
  const refused = structural(analysis, kind, record, ref) ?? 'unsupported';
  const capabilities = {};
  for (const verb of VERBS) capabilities[verb] = refused;
  // Only text can be text-edited. Every other kind keeps the refusal above: there is no path here
  // by which an image, a path or a form could ever report true.
  if (kind === 'text-run') capabilities.editText = editTextOf(record);
  return Object.freeze(capabilities);
}
