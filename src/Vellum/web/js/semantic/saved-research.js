// Saved research: one Research (semantic/research.js) or Collection research (semantic/collection-research.js)
// result, written down so it can be read again without asking the question a second time. Kept by the host
// beside the recent list and the collections (Services/SavedResearch.cs, %LOCALAPPDATA%\Vellum\research.json).
//
//   { v, savedAt, question, source, document, collection, summary, sufficient, evidence: [...] }
//
//   v           the record's version, so an older file can still be read
//   savedAt     when it was kept, ISO 8601
//   question    what was asked, as it was typed
//   source      which research answered it: a value of provenance.js SOURCES
//   document    the document it was asked of (documentRef), for document research; null otherwise
//   collection  { id, name } the collection it was asked of, for collection research; null otherwise
//   summary     the one line Vellum wrote from the matches at the time — kept as it was, never rewritten
//   evidence    the ranked passages as they were found: { id, kind, page, text, matched, box, name, path,
//               provenance } — each one's provenance record exactly as semantic/provenance.js made it
//
// What this is not: a cache that refreshes, a second search engine, a second document index or a document
// identity. Opening a saved result never reads a PDF, never searches and never recomputes anything — what was
// found then is what is shown, evidence and summary alike. The documents are referenced the way the evidence
// already referenced them (a path, and the content key of the bytes that were read); a file that has moved,
// changed or gone is a file this result can no longer open, and it says so rather than looking for another.
//
// Pure: no reading, no writing, no network, no state.

import { PROVENANCE_VERSION, SOURCES } from './provenance.js';

export { SOURCES };

export const SAVED_RESEARCH_VERSION = 1;
export const MAX_NAME_LENGTH = 80;

const text = (value) => (typeof value === 'string' && value ? value : null);
const box4 = (value) => (Array.isArray(value) && value.length === 4 && value.every(Number.isFinite) ? Object.freeze([...value]) : null);
const page = (value) => (Number.isInteger(value) && value > 0 ? value : null);
const terms = (value) => Object.freeze((Array.isArray(value) ? value : []).filter((t) => typeof t === 'string'));

/** A document reference as saved: what provenance.js already froze, read back with nothing guessed. */
function docRef(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const contentKey = text(raw.contentKey);
  return Object.freeze({
    name: text(raw.name),
    path: text(raw.path),
    contentKey,
    reference: raw.reference === 'content' || raw.reference === 'path' ? raw.reference : (contentKey ? 'content' : 'path'),
  });
}

/** A provenance record as saved. Every field is kept as it stands; a damaged one is dropped, not repaired. */
function savedProvenance(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const object = raw.object && typeof raw.object === 'object' ? raw.object : {};
  const runIds = Array.isArray(object.runIds) ? Object.freeze(object.runIds.filter((id) => typeof id === 'string')) : null;
  return Object.freeze({
    v: Number.isInteger(raw.v) ? raw.v : PROVENANCE_VERSION,
    source: text(raw.source) ?? SOURCES.document,
    document: docRef(raw.document) ?? docRef({}),
    page: page(raw.page),
    box: box4(raw.box),
    object: Object.freeze({ id: text(object.id), kind: text(object.kind), blockId: text(object.blockId), runIds }),
  });
}

/** One piece of evidence as saved: the passage, where it is, and where it came from. */
function savedEvidence(item) {
  if (!item || typeof item !== 'object') return null;
  const provenance = savedProvenance(item.provenance);
  const number = page(item.number) ?? page(item.page) ?? provenance?.page ?? null;
  const quote = typeof item.text === 'string' ? item.text : null;
  if (quote === null || number === null) return null;
  return Object.freeze({
    id: text(item.id),
    kind: text(item.kind),
    page: number,
    text: quote,
    matched: terms(item.matched),
    box: box4(item.box) ?? provenance?.box ?? null,
    // The file the passage came from, as the research named it: a collection item carries its own, one
    // document takes the document the research was asked of.
    name: text(item.name) ?? provenance?.document?.name ?? null,
    path: text(item.path) ?? provenance?.document?.path ?? null,
    provenance,
  });
}

/**
 * A result made ready to keep. Takes what Research and Collection research already return:
 *
 *   question    the question as it was asked
 *   source      a value of SOURCES; document research by default
 *   document    the documentRef the research was asked of (document research)
 *   collection  { id, name } the research was asked of (collection research)
 *   summary     Vellum's line about the matches, as it was shown
 *   sufficient  whether there was enough evidence
 *   evidence    the ranked passages, each with its provenance
 *   savedAt     when it is being kept (now by default)
 *
 * Frozen and JSON-safe: what this holds is exactly what the host writes and what opening it gives back.
 */
export function savedResearchRecord({
  question = '', source = SOURCES.document, document = null, collection = null,
  summary = '', sufficient = false, evidence = [], savedAt = new Date().toISOString(),
} = {}) {
  const items = (Array.isArray(evidence) ? evidence : []).map(savedEvidence).filter(Boolean);
  return Object.freeze({
    v: SAVED_RESEARCH_VERSION,
    savedAt: text(savedAt) ?? new Date().toISOString(),
    question: String(question ?? ''),
    source: text(source) ?? SOURCES.document,
    document: docRef(document),
    collection: collection && typeof collection === 'object'
      ? Object.freeze({ id: text(collection.id), name: text(collection.name) })
      : null,
    summary: String(summary ?? ''),
    sufficient: Boolean(sufficient) && items.length > 0,
    evidence: Object.freeze(items),
  });
}

/**
 * A stored result read back, or null when it is damaged beyond reading (not an object, or from a version this
 * Vellum doesn't know). Passages that can't be read are dropped; the rest of the result still opens.
 */
export function readSavedResearch(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (Number.isInteger(raw.v) && raw.v > SAVED_RESEARCH_VERSION) return null;
  return savedResearchRecord(raw);
}

/** Every document the evidence quotes, once, in the order it is first quoted: what the host is told to watch. */
export function savedResearchPaths(record) {
  const paths = [];
  for (const item of record?.evidence ?? []) {
    const path = item.path;
    if (path && !paths.some((p) => p.toLowerCase() === path.toLowerCase())) paths.push(path);
  }
  return paths;
}

/** What the result was asked of, in one line: the collection's name, or the document's. */
export function savedResearchSubject(record) {
  if (record?.collection?.name) return record.collection.name;
  return record?.document?.name ?? record?.evidence?.[0]?.name ?? 'this document';
}

/**
 * The saved evidence with each passage told whether its document is still there. `documents` is what the host
 * listed for the item ([{ path, exists }]); a document it doesn't name is treated as missing, because the host
 * lists exactly the files the result quotes. Nothing is searched for and no path is guessed at: a missing
 * document stays the one the evidence names, marked `missing`, and can't be opened.
 */
export function withAvailability(record, documents = []) {
  const known = new Map((Array.isArray(documents) ? documents : [])
    .filter((d) => d && typeof d.path === 'string')
    .map((d) => [d.path.toLowerCase(), Boolean(d.exists)]));
  const evidence = (record?.evidence ?? []).map((item) => Object.freeze({
    ...item,
    missing: !(item.path && known.get(item.path.toLowerCase()) === true),
  }));
  return Object.freeze({ ...record, evidence: Object.freeze(evidence), missing: evidence.filter((e) => e.missing).length });
}

/** A name for a saved result, cleaned the way the host cleans it; empty when there is nothing usable. */
export function cleanSavedName(name) {
  return String(name ?? '').split(/\s+/).filter(Boolean).join(' ').slice(0, MAX_NAME_LENGTH);
}

/** The name Vellum offers when a result is saved: the question, shortened, else what it was asked of. */
export function suggestedName(record) {
  return cleanSavedName(record?.question) || cleanSavedName(savedResearchSubject(record)) || 'Saved research';
}
