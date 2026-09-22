// Research: a question asked of one document, answered only with passages the document holds. Built on
// semantic search (semantic/query.js matchPage) and nothing else: the question's key terms are each searched
// for as text, and a passage (a paragraph, or a line of its own) is evidence when it holds enough of them.
// Deterministic and local — no AI, no index, no embeddings; nothing is written. Pure.
//
// Evidence is the document's own text with its page and box. The one line of summary is Vellum's, made from
// the matches (how many passages, on which pages, which terms were found nowhere); it never states an answer.
// When no passage holds enough of the terms, the result says the evidence is insufficient instead of guessing.

import { matchPage } from './query.js';

export const MAX_EVIDENCE = 8;
const MAX_TEXT = 280;

// Words that carry no subject of their own in a question.
const STOP = new Set(`a an and are as at be been but by can could did do does for from had has have how i if in into is it
its me my of on or our should so than that the their them then there these they this those to was we were what when where
which who whom whose why will with would you your about any all also between both each more most other some such only own
same very just tell show find give list document pdf page pages say says said mention mentioned mentions`.split(/\s+/));

/** A question's key terms, lower-cased and each once: quoted phrases whole, other words without stop words. */
export function researchTerms(question) {
  const terms = [];
  const add = (t) => { t = t.toLowerCase(); if (t && !terms.includes(t)) terms.push(t); };
  const rest = String(question ?? '').replace(/"([^"]+)"/g, (_, phrase) => { add(phrase.replace(/\s+/g, ' ').trim()); return ' '; });
  for (const word of rest.split(/[^\p{L}\p{N}.\-']+/u)) {
    const w = word.replace(/^[.\-']+|[.\-']+$/g, '');
    if (w && (w.length > 1 || /\d/.test(w)) && !STOP.has(w.toLowerCase())) add(w);
  }
  return terms;
}

/** How many of the terms a passage must hold to count as evidence: all of one or two, else half or more. */
export const needed = (count) => (count <= 2 ? count : Math.ceil(count / 2));

// A term is matched as semantic search matches text; a short one only as a whole word ("two" not in "network").
const termQuery = (text) => ({ type: 'text', editable: null, match: 'contains', text, caseSensitive: false, entireWord: text.length <= 3 });

/** A page's passages holding any of the terms: [{ id, kind, number, item, text, box, matched }], in reading order. */
export function pageCandidates(page, terms) {
  const found = new Map();
  for (const term of terms) {
    for (const r of matchPage(page, termQuery(term))) {
      const entry = found.get(r.id) ?? { id: r.id, kind: r.kind, number: r.number, item: r.item, order: found.size, matched: [] };
      entry.matched.push(term);
      found.set(r.id, entry);
    }
  }
  return [...found.values()].sort((a, b) => a.order - b.order).map(({ order, ...c }) => ({
    ...c, text: String(c.item.text ?? '').replace(/\s+/g, ' ').trim(), box: c.item.box ?? null,
  }));
}

/**
 * Evidence for a question from the candidates of every page read: { terms, evidence, missing, sufficient, summary }.
 * Evidence holds at least needed(terms) of the terms, most terms first, then in page and reading order; at most
 * `limit`. Each item: { id, kind, number, item, text (clipped), box, matched }. `missing`: terms found nowhere.
 */
export function rankEvidence(terms, candidates, { limit = MAX_EVIDENCE } = {}) {
  if (!terms.length) return { terms, evidence: [], missing: [], sufficient: false, summary: 'Ask about something the document may contain: the question has no key terms.' };
  const min = needed(terms.length);
  const seen = new Set(candidates.flatMap((c) => c.matched));
  const missing = terms.filter((t) => !seen.has(t));
  const evidence = candidates
    .map((c, i) => ({ c, i }))
    .filter(({ c }) => c.matched.length >= min)
    .sort((a, b) => b.c.matched.length - a.c.matched.length || a.c.number - b.c.number || a.i - b.i)
    .slice(0, limit)
    .map(({ c }) => ({ ...c, text: clip(c.text) }));
  return { terms, evidence, missing, sufficient: evidence.length > 0, summary: summarize(terms, evidence, missing) };
}

function summarize(terms, evidence, missing) {
  const none = missing.length ? ` Not found anywhere: ${missing.map(quote).join(', ')}.` : '';
  if (!evidence.length) {
    return `Not enough evidence in this document: no passage holds ${terms.length === 1 ? quote(terms[0]) : `${needed(terms.length) === terms.length ? 'all' : `${needed(terms.length)} or more`} of ${terms.map(quote).join(', ')}`}.${none}`;
  }
  const pages = [...new Set(evidence.map((e) => e.number))].sort((a, b) => a - b);
  const best = evidence[0].matched.length;
  return `${evidence.length} ${evidence.length === 1 ? 'passage' : 'passages'} on ${pages.length === 1 ? 'page' : 'pages'} ${pages.join(', ')}; the closest holds ${best} of ${terms.length} key ${terms.length === 1 ? 'term' : 'terms'}.${none}`;
}

const quote = (t) => `“${t}”`;
const clip = (text) => (text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT - 1)}…` : text);
