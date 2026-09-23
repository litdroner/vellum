// One search for every surface that finds things by name: Tools and the command palette. Local and
// deterministic: the same words, items and weights always give the same order. No AI, no dictionary, no
// index beyond each item's words normalised once.
//
// A surface gives items and fields ({ get(item) → text or texts, weight, phrase? }). Each query word is
// matched against every word of every field; the best match counts, once. Results are ranked:
//   1. by band, the strength of the match as a whole:
//        PHRASE   the query is a phrase field (a name, a label or an alias) word for word
//        ORDERED  the query's words appear in that order, together, inside a phrase field
//        EXACT, PREFIX, INNER, TYPO   the weakest match among the query's words
//   2. by text score: for each query word, its best match's points × the field's weight, summed; a
//      word that starts a name or label counts a little more ("page" finds "Page numbers…" first)
//   3. by context, where the surface gives it (Tools: available, favourite, recent). It never lifts a
//      result out of its band, and it can't overturn a better text score
//   4. by the order the items were given in.
// Every query word must match (AND), except "to", "into" and numbers: those never leave a result out,
// and count only for PHRASE and ORDERED, which is what puts "pictures to pdf" (Images to PDF) above
// "pdf to pictures" (PDF to images), and lets "rotate 2 pages" find Rotate pages.

export const BAND = Object.freeze({ PHRASE: 6, ORDERED: 5, EXACT: 4, PREFIX: 3, INNER: 2, TYPO: 1 });

const POINTS = { [BAND.EXACT]: 100, [BAND.PREFIX]: 70, [BAND.INNER]: 30, [BAND.TYPO]: 20 };
const LEADING_BONUS = 10;
const PHRASE_BONUS = 300;
const ORDERED_BONUS = 120;
const STOP_WORDS = new Set(['a', 'an', 'the', 'my', 'this', 'of', 'for', 'please']);
const optional = (word) => word === 'to' || word === 'into' || /^\d+$/.test(word);

/** Text as search compares it: lower case, no accents, words separated by single spaces. */
export function normalise(text) {
  return String(text ?? '')
    .toLowerCase()
    .normalize('NFKD').replace(/\p{M}/gu, '') // "résumé" → "resume"
    .replace(/pdf\/a/g, 'pdfa')
    .replace(/→|->/g, ' to ')
    .replace(/&/g, ' and ')
    .replace(/['’]/g, '') // "what’s" → "whats"
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/(?<=\p{L}) 2 (?=\p{L})/gu, ' to ') // "pdf 2 word"
    .trim();
}

/** A final "s" off words of four letters or more, except "ss": "pages" → "page", "pdfs" → "pdf". */
const stem = (word) => (word.length >= 4 && word.endsWith('s') && !word.endsWith('ss') ? word.slice(0, -1) : word);

/** The words search matches: normalised, stop words dropped (unless that leaves none), stemmed. */
export function tokenise(text) {
  const words = normalise(text).split(' ').filter(Boolean);
  const kept = words.filter((w) => !STOP_WORDS.has(w));
  return kept.length ? kept.map(stem) : words;
}

/** Items with their fields' words worked out once, ready for rank(). */
export function indexItems(items, fields) {
  return items.map((item, order) => ({
    item,
    order,
    fields: fields.map(({ get, weight, phrase = false }) => ({
      weight,
      phrase,
      values: [get(item) ?? []].flat().map(tokenise).filter((words) => words.length),
    })),
  }));
}

/**
 * The items that match `query`, best first: [{ item, band, score, context }]. `context(item)` is an
 * optional number that orders results only where band and text score are equal.
 */
export function rank(index, query, { context = null } = {}) {
  const words = tokenise(query);
  if (!words.length) return [];
  const needed = words.some((w) => !optional(w)) ? words.filter((w) => !optional(w)) : words;
  const results = [];
  for (const entry of index) {
    const found = match(entry, words, needed);
    if (found) results.push({ item: entry.item, ...found, context: context?.(entry.item) ?? 0, order: entry.order });
  }
  results.sort((a, b) => b.band - a.band || b.score - a.score || b.context - a.context || a.order - b.order);
  return results.map(({ order, ...result }) => result);
}

function match(entry, words, needed) {
  let band = BAND.EXACT;
  let score = 0;
  for (const word of needed) {
    let tier = 0;
    let best = 0;
    for (const field of entry.fields) {
      for (const value of field.values) {
        value.forEach((candidate, at) => {
          const t = tierOf(word, candidate);
          if (!t) return;
          const leading = at === 0 && field.phrase && t >= BAND.PREFIX ? LEADING_BONUS : 0;
          tier = Math.max(tier, t);
          best = Math.max(best, (POINTS[t] + leading) * field.weight);
        });
      }
    }
    if (!tier) return null;
    band = Math.min(band, tier);
    score += best;
  }
  // A phrase field that is the query, or holds it in order: the strongest field's bonus counts.
  let bonus = 0;
  for (const field of entry.fields) {
    if (!field.phrase) continue;
    for (const value of field.values) {
      const kept = value.filter((w) => !optional(w));
      if (same(value, words) || same(kept, needed)) {
        bonus = Math.max(bonus, PHRASE_BONUS * field.weight);
        band = BAND.PHRASE;
      } else if ((words.length > 1 && within(value, words)) || (needed.length > 1 && within(kept, needed))) {
        if (band !== BAND.PHRASE) band = BAND.ORDERED;
        bonus = Math.max(bonus, ORDERED_BONUS * field.weight);
      }
    }
  }
  return { band, score: score + bonus };
}

const same = (a, b) => a.length === b.length && a.every((w, i) => w === b[i]);

/** `part` appears in `words` in order, with nothing between. */
function within(words, part) {
  for (let i = 0; i + part.length <= words.length; i++) {
    if (part.every((w, k) => words[i + k] === w)) return true;
  }
  return false;
}

/** How `word` (from the query) matches `candidate` (from a field): a BAND tier, or 0. */
function tierOf(word, candidate) {
  if (candidate === word) return BAND.EXACT;
  if (candidate.startsWith(word)) return BAND.PREFIX;
  if (word.length >= 3 && candidate.includes(word)) return BAND.INNER;
  if (word.length >= 5 && oneEditApart(word, candidate)) return BAND.TYPO;
  return 0;
}

/** One letter changed, added or left out, or two neighbouring letters swapped. */
function oneEditApart(a, b) {
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  if (a.length === b.length) {
    return a.slice(i + 1) === b.slice(i + 1)
      || (a[i] === b[i + 1] && a[i + 1] === b[i] && a.slice(i + 2) === b.slice(i + 2));
  }
  return a.length > b.length ? a.slice(i + 1) === b.slice(i) : a.slice(i) === b.slice(i + 1);
}
