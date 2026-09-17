// Find and replace in a run's text: plain text (never a pattern), optionally matching case and
// whole words, with the same meaning pdf.js's find gives them. Pure functions; the session
// (editing/session.js replaceText) turns what they return into ordinary text edits.

const WORD = /[\p{L}\p{N}_]/u;

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** What a query is matched as: NFC, and any run of white space matching any run of white space. */
function patternOf(query, flags) {
  const parts = query.normalize('NFC').trim().split(/\s+/).filter(Boolean).map(escape);
  return parts.length ? new RegExp(parts.join('\\s+'), flags) : null;
}

/**
 * The places `query` occurs in `text`: [{ start, end }] in order, never overlapping. Whole words
 * means no letter, digit or underscore right before a match that starts with one, or right after a
 * match that ends with one.
 */
export function findMatches(text, query, { caseSensitive = false, entireWord = false } = {}) {
  const pattern = patternOf(query ?? '', caseSensitive ? 'gu' : 'giu');
  if (!pattern || !text) return [];
  const matches = [];
  for (const m of text.matchAll(pattern)) {
    const start = m.index;
    const end = start + m[0].length;
    if (entireWord) {
      if (WORD.test(m[0][0]) && start > 0 && WORD.test(text[start - 1])) continue;
      if (WORD.test(m[0].at(-1)) && end < text.length && WORD.test(text[end])) continue;
    }
    matches.push({ start, end });
  }
  return matches;
}

/** `text` with each of `matches` (from findMatches) replaced by `replacement`. */
export function replaceMatches(text, matches, replacement) {
  let out = '';
  let at = 0;
  for (const { start, end } of matches) {
    out += text.slice(at, start) + replacement;
    at = end;
  }
  return out + text.slice(at);
}

/**
 * The places `query` occurs in a paragraph's lines (`texts`, top line first) read as one text, each
 * line break read as a space: [{ start, end, first, last }], `start`/`end` in that joined text and
 * `first`/`last` the lines the match begins and ends on (the same line for a match inside one line).
 * Also returns `offsets`: where each line starts in the joined text.
 */
export function paragraphMatches(texts, query, options) {
  const offsets = [];
  let at = 0;
  for (const text of texts) {
    offsets.push(at);
    at += text.length + 1;
  }
  const lineAt = (pos) => {
    let i = 0;
    while (i + 1 < offsets.length && offsets[i + 1] <= pos) i++;
    return i;
  };
  const matches = findMatches(texts.join(' '), query, options)
    .map(({ start, end }) => ({ start, end, first: lineAt(start), last: lineAt(end - 1) }));
  return { matches, offsets };
}

/**
 * The lines `texts` with each of `matches` (from paragraphMatches, in order) replaced by `replacement`:
 * the replacement ends the line the match begins on, and what follows the match on its last line
 * stays on that line. A line a match runs right across is left empty.
 */
export function replaceInLines(texts, offsets, matches, replacement) {
  const out = texts.map(() => '');
  const copy = (from, to) => {
    texts.forEach((text, i) => {
      const a = Math.max(from, offsets[i]);
      const b = Math.min(to, offsets[i] + text.length);
      if (a < b) out[i] += text.slice(a - offsets[i], b - offsets[i]);
    });
  };
  let at = 0;
  for (const m of matches) {
    copy(at, m.start);
    out[m.first] += replacement;
    at = m.end;
  }
  copy(at, Infinity);
  return out;
}

/** Might `text` (a page's text as pdf.js reads it) contain `query`? Loose: never says no wrongly. */
export function mayContain(text, query) {
  const pattern = patternOf((query ?? '').replace(/\s+/g, ''), 'iu');
  return Boolean(pattern) && pattern.test((text ?? '').normalize('NFC').replace(/\s+/g, ''));
}

/**
 * The one match in `text` nearest `fraction` (0 at the run's start, 1 at its end), or null: which
 * occurrence a highlighted match on screen is, when a line holds the word more than once.
 */
export function nearestMatch(text, matches, fraction) {
  let best = null;
  let distance = Infinity;
  for (const m of matches) {
    const d = Math.abs((m.start + m.end) / 2 / Math.max(1, text.length) - fraction);
    if (d < distance) [best, distance] = [m, d];
  }
  return best;
}
