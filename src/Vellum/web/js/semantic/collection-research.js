// Collection research: the same question asked of every document in one collection (Services/DocumentCollections.cs),
// answered only with passages those documents hold. Nothing new is searched with — the question's key terms, the
// passage rule and the ranking are Research's (semantic/research.js), which is semantic search (semantic/query.js)
// and nothing else. Deterministic and local: no AI, no index, no embeddings, no network beyond reading the files,
// and no document is written, opened for editing or changed.
//
// A document is read one at a time and dropped again: its bytes are analyzed page by page with the editor's own
// page analysis (editing/runs.js analyzePage over editing/source.js), each page turned into the semantic model
// (semantic/model.js) the evidence's page and box come from, and only the passages holding a term are kept. The
// pdf.js cross-check the open document's pages get (editing/session.js) is about editing, not text, so it is not
// run here; the text and boxes are the same ones Research quotes.
//
// A file that is gone, protected (pdf-lib can't read an encrypted PDF without rewriting it, and Vellum never
// asks for another document's password here) or unreadable is skipped, counted and named with its reason — it is
// never guessed at and never silently dropped.

import { analyzePage } from '../editing/runs.js';
import { openSource } from '../editing/source.js';
import { loadPdfLib } from '../annotations/persist.js';
import { MAX_EVIDENCE, needed, pageCandidates, rankEvidence, researchTerms } from './research.js';
import { readSemanticPage } from './model.js';

export { MAX_EVIDENCE, researchTerms };

/** Why a document in a collection was left out of the research. */
export const SKIP_REASONS = {
  missing: 'not found',
  protected: 'protected (its text isn’t read)',
  unreadable: 'couldn’t be read',
};

export class SkippedDocument extends Error {
  constructor(reason, message) {
    super(message ?? SKIP_REASONS[reason] ?? reason);
    this.name = 'SkippedDocument';
    this.reason = reason; // a key of SKIP_REASONS
  }
}

/**
 * The pages of one document, as the semantic model, one at a time: the caller keeps what it needs of a page and
 * the page is dropped. `bytes` are the file's, read only. Throws SkippedDocument when the file can't be read.
 */
export async function* documentPages(bytes) {
  let source;
  try {
    source = await openSource(await loadPdfLib(), bytes);
  } catch (err) {
    throw new SkippedDocument(err?.kind === 'encrypted' ? 'protected' : 'unreadable', err?.kind === 'encrypted' ? SKIP_REASONS.protected : `couldn’t be read (${err?.message ?? err})`);
  }
  for (let index = 0; index < source.pageCount; index++) {
    yield await readSemanticPage(analyzePage(source.page(index)));
  }
}

/** Reads a collection document from the host: its bytes over the read-only URL the host gave for it. */
export async function fetchDocumentBytes(doc) {
  if (!doc.exists || !doc.url) throw new SkippedDocument('missing');
  const response = await fetch(doc.url);
  if (!response.ok) throw new SkippedDocument(response.status === 404 ? 'missing' : 'unreadable');
  return new Uint8Array(await response.arrayBuffer());
}

const defaultRead = async function* read(doc) {
  yield* documentPages(await fetchDocumentBytes(doc));
};

/**
 * Evidence for a question from the documents of one collection.
 *
 *   documents   [{ path, name, exists, url }], in the collection's own order
 *   question    what is asked; its key terms are Research's (researchTerms)
 *   readDocument(doc) → async iterable of that document's semantic pages (the app's reader by default)
 *   onProgress({ index, total, name })  before each document is read
 *   signal      an AbortSignal: reading stops at the next page and `aborted` comes back true
 *
 * Returns { terms, evidence, missing, sufficient, summary, searched, skipped, aborted }. Each evidence item is
 * a passage as Research quotes it ({ id, kind, number, text, box, matched }) with the document it came from
 * (`path`, `name`, `docOrder`), so a result names its file, its page and the words it holds. At most `limit`
 * passages over the whole collection — the same 8 a single document gives.
 */
export async function researchCollection({
  documents = [], question = '', readDocument = defaultRead, limit = MAX_EVIDENCE, onProgress = null, signal = null,
} = {}) {
  const terms = researchTerms(question);
  const skipped = [];
  const candidates = [];
  let searched = 0;
  let aborted = false;

  if (terms.length) {
    for (const [index, doc] of documents.entries()) {
      if (signal?.aborted) { aborted = true; break; }
      onProgress?.({ index, total: documents.length, name: doc.name });
      try {
        for await (const page of readDocument(doc)) {
          if (signal?.aborted) { aborted = true; break; }
          for (const c of pageCandidates(page, terms)) {
            // The page model itself is dropped: a candidate keeps only what evidence shows.
            candidates.push({ id: c.id, kind: c.kind, number: c.number, text: c.text, box: c.box, matched: c.matched, docOrder: index, path: doc.path, name: doc.name });
          }
          // Reading and matching between pages, so the window stays responsive.
          await new Promise((resolve) => setTimeout(resolve));
        }
      } catch (err) {
        skipped.push({ path: doc.path, name: doc.name, reason: err?.reason ?? 'unreadable', message: err?.message ?? String(err) });
        continue;
      }
      if (aborted) break;
      searched++;
    }
  }

  const found = rankEvidence(terms, candidates, { limit });
  return { ...found, summary: summarize(terms, found, { searched, skipped, documents, aborted }), searched, skipped, aborted };
}

const quote = (t) => `“${t}”`;
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** One line about the matches, marked as Vellum's wherever it is shown: never an answer, never a guess. */
function summarize(terms, { evidence, missing }, { searched, skipped, documents, aborted }) {
  if (!terms.length) return 'Ask about something the documents may contain: the question has no key terms.';
  const left = skipped.length ? ` ${plural(skipped.length, 'document')} skipped: ${skipped.map((s) => `${s.name} — ${SKIP_REASONS[s.reason] ?? s.reason}`).join('; ')}.` : '';
  const none = missing.length ? ` Not found anywhere: ${missing.map(quote).join(', ')}.` : '';
  const stopped = aborted ? ' The research was stopped before every document was read.' : '';
  const read = `${plural(searched, 'document')} of ${documents.length} read.`;
  if (!evidence.length) {
    const rule = terms.length === 1
      ? quote(terms[0])
      : `${needed(terms.length) === terms.length ? 'all' : `${needed(terms.length)} or more`} of ${terms.map(quote).join(', ')}`;
    return `Not enough evidence in this collection: no passage holds ${rule}. ${read}${none}${left}${stopped}`;
  }
  const files = [...new Set(evidence.map((e) => e.name))];
  const best = evidence[0].matched.length;
  return `${plural(evidence.length, 'passage')} in ${plural(files.length, 'document')} (${files.join(', ')}); the closest holds ${best} of ${terms.length} key ${terms.length === 1 ? 'term' : 'terms'}. ${read}${none}${left}${stopped}`;
}
