// Provenance: where a piece of evidence came from, said in the terms Vellum already has. One small frozen
// record attached to every Research (semantic/research.js) and Collection research (semantic/collection-research.js)
// passage, so a later feature can name, quote and reach the source again without reading the PDF a second time.
//
//   { v, source, document: { name, path, contentKey, reference }, page, box, object: { id, kind, blockId, runIds } }
//
//   source      'document-research' (the open document) or 'collection-research' (a document of a collection)
//   document    the file as Vellum knows it: its name, its full path, and `contentKey` — the SHA-256 of the
//               bytes that were read, which the host already returns for every document it serves
//               (X-Vellum-Doc-Key, AppResourceServer). `reference` says which of the two identifies the file:
//               'content' when the hash is known, 'path' when it isn't.
//   page        the 1-based page the passage is on
//   box         its box on that page, [x1, y1, x2, y2] in PDF user space — the model's own, not measured here
//   object      the semantic model's IDs for the passage: the block's or run's `id` and `kind` as
//               semantic/query.js matched it, the block a run belongs to, and the runs a block is made of
//
// What this is not: a document identity that survives editing. `contentKey` is the bytes as they were read —
// saving, Save As or any change to the file gives a different one, and a copy of the same bytes elsewhere
// gives the same one. It identifies the file that was read at the moment it was read, nothing more; Vellum
// has no stored document identity to promise more than that, and this V1 does not invent one. Nothing is
// guessed: a value the model or the host doesn't hold is null and stays null.
//
// Pure: no reading, no writing, no network, no state.

export const PROVENANCE_VERSION = 1;

export const SOURCES = Object.freeze({
  document: 'document-research',
  collection: 'collection-research',
});

const text = (value) => (typeof value === 'string' && value ? value : null);
const box4 = (value) => (Array.isArray(value) && value.length === 4 && value.every(Number.isFinite) ? Object.freeze([...value]) : null);

/**
 * A reference to the document a passage came from, from what the caller already holds:
 * { name, path, contentKey, reference }. Anything missing is null; `reference` is 'content' when the
 * content hash is known and 'path' when only the file's place is.
 */
export function documentRef({ name = null, path = null, contentKey = null } = {}) {
  const key = text(contentKey);
  return Object.freeze({ name: text(name), path: text(path), contentKey: key, reference: key ? 'content' : 'path' });
}

/** The semantic model IDs of a passage: { id, kind, blockId, runIds }. Only IDs the candidate carries. */
function objectRef(candidate) {
  const item = candidate?.item ?? null;
  const runIds = candidate?.runIds ?? item?.runIds ?? null;
  return Object.freeze({
    id: text(candidate?.id),
    kind: text(candidate?.kind),
    blockId: text(candidate?.blockId ?? item?.blockId ?? null),
    runIds: Array.isArray(runIds) ? Object.freeze(runIds.filter((id) => typeof id === 'string')) : null,
  });
}

/**
 * The provenance of one evidence candidate. `document` is a documentRef (or what one is made from);
 * `source` is a value of SOURCES. Frozen, and JSON-safe: what it holds is what an export writes.
 */
export function evidenceProvenance(candidate, { document = null, source = SOURCES.document } = {}) {
  const ref = document && document.reference ? document : documentRef(document ?? {});
  return Object.freeze({
    v: PROVENANCE_VERSION,
    source,
    document: ref,
    page: Number.isFinite(candidate?.number) ? candidate.number : null,
    box: box4(candidate?.box),
    object: objectRef(candidate),
  });
}

/** Provenance in one line, as the evidence rows and an export show it: "report.pdf · page 3 · p3:run:12". */
export function provenanceLine(provenance) {
  if (!provenance) return '';
  const parts = [];
  if (provenance.document?.name) parts.push(provenance.document.name);
  if (provenance.page != null) parts.push(`page ${provenance.page}`);
  if (provenance.object?.id) parts.push(provenance.object.id);
  return parts.join(' · ');
}

/** The same with the file's place and how it is referenced, for a tooltip or an export's footnote. */
export function provenanceDetail(provenance) {
  if (!provenance) return '';
  const doc = provenance.document ?? {};
  const parts = [provenanceLine(provenance)];
  if (doc.path) parts.push(doc.path);
  if (doc.contentKey) parts.push(`content ${doc.contentKey.slice(0, 12).toLowerCase()}… (the file as it was read)`);
  return parts.filter(Boolean).join('\n');
}
