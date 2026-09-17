// PDF Compare: the comparison itself, apart from any UI, so it runs in Node tests too.
// Works on the words pdf.js reads from each page (getTextContent), never on the files: nothing here
// can change either document.
//
//   pageWords(textContent)          the words on a page, each with its box in PDF user space
//   pageProfile(words)              what page matching needs from a page
//   alignPages(profilesA, profilesB) pairs pages: same place, moved, added (only in B), removed (only in A)
//   diffWords(wordsA, wordsB)       text added, removed and changed between two pages

/** Pages at least this similar (Dice over their words) count as the same page. */
export const SAME_PAGE = 0.5;

const SOFT_HYPHEN = String.fromCharCode(0xad);
const clean = (s) => s.normalize('NFKC').replaceAll(SOFT_HYPHEN, ''); // invisible, so not a difference

/**
 * The words on a page in pdf.js's reading order: { text, rect: [x0, y0, x1, y1] } in PDF user space.
 * A word pdf.js split over two items (no space between them, on the same line) is joined again.
 * measure(text, style): the width of text in the item's font (pdf.js textContent.styles), so words are
 * placed along an item by their real width; without it, by their share of the characters.
 */
export function pageWords(textContent, { measure = null } = {}) {
  const words = [];
  let joinable = false; // the last word may continue into the next item
  let lastEnd = null;
  for (const item of textContent.items ?? []) {
    const str = item.str ?? '';
    if (!str) {
      if (item.hasEOL) joinable = false;
      continue;
    }
    const [a, b, c, d, e, f] = item.transform;
    const size = Math.hypot(c, d) || item.height || 10;
    const length = Math.hypot(a, b) || 1;
    const dx = a / length;
    const dy = b / length;
    const at = (t) => [e + dx * item.width * t, f + dy * item.width * t];
    const box = (t0, t1) => {
      const [x0, y0] = at(t0);
      const [x1, y1] = at(t1);
      const ux = -dy * size;
      const uy = dx * size;
      const xs = [x0 - ux * 0.22, x1 - ux * 0.22, x0 + ux * 0.9, x1 + ux * 0.9];
      const ys = [y0 - uy * 0.22, y1 - uy * 0.22, y0 + uy * 0.9, y1 + uy * 0.9];
      return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
    };
    const style = textContent.styles?.[item.fontName];
    const whole = measure ? measure(str, style) : 0;
    const along = (i) => (whole > 0 ? measure(str.slice(0, i), style) / whole : i / str.length);
    const start = at(0);
    const near = lastEnd && Math.hypot(start[0] - lastEnd[0], start[1] - lastEnd[1]) < size * 0.3;
    for (const m of str.matchAll(/\S+/g)) {
      const text = clean(m[0]);
      if (!text) continue;
      const rect = box(along(m.index), along(m.index + m[0].length));
      const previous = words.at(-1);
      if (m.index === 0 && joinable && near && previous) {
        previous.text += text;
        previous.rect = union(previous.rect, rect);
      } else {
        words.push({ text, rect });
      }
    }
    joinable = !item.hasEOL && !/\s$/.test(str);
    lastEnd = at(1);
  }
  return words;
}

const union = (r, s) => [Math.min(r[0], s[0]), Math.min(r[1], s[1]), Math.max(r[2], s[2]), Math.max(r[3], s[3])];

/** What page matching needs: the word count and how often each word appears. */
export function pageProfile(words) {
  const counts = new Map();
  for (const w of words) counts.set(w.text, (counts.get(w.text) ?? 0) + 1);
  return { size: words.length, counts };
}

/** 0–1: how many words two pages share (Dice). Two pages with no text are alike; text and none are not. */
export function similarity(p, q) {
  if (!p.size && !q.size) return 1;
  if (!p.size || !q.size) return 0;
  let common = 0;
  const [small, large] = p.counts.size <= q.counts.size ? [p.counts, q.counts] : [q.counts, p.counts];
  for (const [word, n] of small) common += Math.min(n, large.get(word) ?? 0);
  return (2 * common) / (p.size + q.size);
}

/**
 * Pairs the pages of A and B (0-based). The longest in-order run of similar pages stays in place; the
 * rest are paired as moved where a similar page is left over on the other side, or else added/removed.
 * Rows come in B's order, with removed pages where they were in A:
 *   { kind: 'same' | 'moved' | 'added' | 'removed', a: index | null, b: index | null, similarity }
 */
export function alignPages(profilesA, profilesB, { threshold = SAME_PAGE } = {}) {
  const n = profilesA.length;
  const m = profilesB.length;
  // Pages are only compared within a band around the diagonal, so long documents stay fast; pages that
  // moved further than that are still found below.
  const band = Math.max(25, Math.abs(n - m) + 25);
  const cache = new Map();
  const sim = (i, j) => {
    const key = i * (m + 1) + j;
    if (!cache.has(key)) cache.set(key, similarity(profilesA[i], profilesB[j]));
    return cache.get(key);
  };
  const width = m + 1;
  const score = new Float64Array((n + 1) * width);
  const step = new Uint8Array((n + 1) * width); // 1 up (skip A), 2 left (skip B), 3 diagonal (pair)
  for (let i = 1; i <= n; i++) step[i * width] = 1;
  for (let j = 1; j <= m; j++) step[j] = 2;
  for (let i = 1; i <= n; i++) {
    const centre = Math.round((i * m) / Math.max(n, 1));
    for (let j = 1; j <= m; j++) {
      let best = score[(i - 1) * width + j];
      let move = 1;
      if (score[i * width + j - 1] > best) { best = score[i * width + j - 1]; move = 2; }
      if (Math.abs(j - centre) <= band) {
        const s = sim(i - 1, j - 1);
        if (s >= threshold && score[(i - 1) * width + j - 1] + s > best) { best = score[(i - 1) * width + j - 1] + s; move = 3; }
      }
      score[i * width + j] = best;
      step[i * width + j] = move;
    }
  }
  const pairOfB = new Array(m).fill(null);
  const pairedA = new Array(n).fill(false);
  for (let i = n, j = m; i > 0 || j > 0;) {
    const move = step[i * width + j];
    if (move === 3) { pairOfB[j - 1] = { a: i - 1, kind: 'same', similarity: sim(i - 1, j - 1) }; pairedA[i - 1] = true; i--; j--; }
    else if (move === 1) i--;
    else j--;
  }

  // Left over on both sides: pages that moved (the most similar first).
  const restA = pairedA.flatMap((paired, i) => (paired ? [] : [i]));
  const restB = pairOfB.flatMap((pair, j) => (pair ? [] : [j]));
  if (restA.length && restB.length && restA.length * restB.length <= 250000) {
    const candidates = [];
    for (const i of restA) for (const j of restB) {
      const s = similarity(profilesA[i], profilesB[j]);
      if (s >= threshold) candidates.push({ i, j, s });
    }
    candidates.sort((x, y) => y.s - x.s || Math.abs(x.i - x.j) - Math.abs(y.i - y.j));
    for (const { i, j, s } of candidates) {
      if (pairedA[i] || pairOfB[j]) continue;
      pairOfB[j] = { a: i, kind: 'moved', similarity: s };
      pairedA[i] = true;
    }
  }

  const rows = [];
  let nextA = 0; // removed pages before this A index are placed already
  const flushRemoved = (upTo) => {
    for (; nextA < upTo; nextA++) if (!pairedA[nextA]) rows.push({ kind: 'removed', a: nextA, b: null, similarity: 0 });
  };
  // Pages removed from A come before pages added in B where both fall between the same kept pages.
  const keptAfter = new Array(m + 1).fill(n);
  for (let j = m - 1; j >= 0; j--) keptAfter[j] = pairOfB[j]?.kind === 'same' ? pairOfB[j].a : keptAfter[j + 1];
  for (let j = 0; j < m; j++) {
    const pair = pairOfB[j];
    if (!pair || pair.kind === 'same') flushRemoved(keptAfter[j]);
    rows.push(pair ? { kind: pair.kind, a: pair.a, b: j, similarity: pair.similarity } : { kind: 'added', a: null, b: j, similarity: 0 });
  }
  flushRemoved(n);
  return rows;
}

/**
 * Myers' diff over two sequences of strings: [['=', i, j] | ['-', i] | ['+', j]] in order.
 * The common start and end are taken off first, so small edits to long pages stay cheap.
 */
export function diffSequence(a, b) {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }
  const head = Array.from({ length: start }, (_, i) => ['=', i, i]);
  const tail = Array.from({ length: a.length - endA }, (_, k) => ['=', endA + k, endB + k]);
  const x0 = a.slice(start, endA);
  const y0 = b.slice(start, endB);
  const middle = myers(x0, y0).map((op) => (op[0] === '=' ? ['=', op[1] + start, op[2] + start] : op[0] === '-' ? ['-', op[1] + start] : ['+', op[1] + start]));
  return [...head, ...middle, ...tail];
}

function myers(a, b) {
  const n = a.length;
  const m = b.length;
  if (!n) return b.map((_, j) => ['+', j]);
  if (!m) return a.map((_, i) => ['-', i]);
  const max = n + m;
  const offset = max + 1;
  const v = new Int32Array(2 * max + 3);
  const trace = [];
  let found = -1;
  for (let d = 0; d <= max && found < 0; d++) {
    trace.push(v.slice(offset - d - 1, offset + d + 2)); // only the diagonals step d can reach
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1]) ? v[offset + k + 1] : v[offset + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) { x++; y++; }
      v[offset + k] = x;
      if (x >= n && y >= m) { found = d; break; }
    }
  }
  const ops = [];
  let x = n;
  let y = m;
  for (let d = found; d >= 0; d--) {
    const w = trace[d];
    const k = x - y;
    const at = (kk) => w[kk + d + 1];
    const prevK = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1;
    const prevX = d === 0 ? 0 : at(prevK);
    const prevY = d === 0 ? 0 : prevX - prevK;
    while (x > prevX && y > prevY) { ops.push(['=', x - 1, y - 1]); x--; y--; }
    if (d > 0) {
      ops.push(x === prevX ? ['+', y - 1] : ['-', x - 1]);
      x = prevX;
      y = prevY;
    }
  }
  return ops.reverse();
}

/**
 * The text changes between two pages' words:
 *   { kind: 'added' | 'removed' | 'changed', before, after, aRects, bRects, aAnchor, bAnchor }
 * Rects are per line (PDF user space). A side with no words of its own (text added: A; removed: B)
 * gets an anchor instead: the box of the nearest unchanged word, so both pages can show where it is.
 */
export function diffWords(wordsA, wordsB) {
  const ops = diffSequence(wordsA.map((w) => w.text), wordsB.map((w) => w.text));
  const changes = [];
  let lastA = -1;
  let lastB = -1;
  for (let k = 0; k < ops.length;) {
    if (ops[k][0] === '=') {
      [, lastA, lastB] = ops[k];
      k++;
      continue;
    }
    const removed = [];
    const added = [];
    for (; k < ops.length && ops[k][0] !== '='; k++) (ops[k][0] === '-' ? removed : added).push(ops[k][1]);
    const nextEqual = ops[k];
    const anchor = (words, before, after) => words[before]?.rect ?? words[after]?.rect ?? null;
    changes.push({
      kind: removed.length && added.length ? 'changed' : removed.length ? 'removed' : 'added',
      before: removed.map((i) => wordsA[i].text).join(' '),
      after: added.map((j) => wordsB[j].text).join(' '),
      aRects: lineRects(wordsA, removed),
      bRects: lineRects(wordsB, added),
      aAnchor: removed.length ? null : anchor(wordsA, lastA, nextEqual?.[1]),
      bAnchor: added.length ? null : anchor(wordsB, lastB, nextEqual?.[2]),
    });
  }
  return changes;
}

/** Boxes for the listed words, joined into one per line where the words follow each other. */
export function lineRects(words, indices) {
  const rects = [];
  let previous = -2;
  for (const i of indices) {
    const r = words[i].rect;
    const last = rects.at(-1);
    const height = r[3] - r[1];
    const sameLine = last && i === previous + 1 && Math.abs(last[1] - r[1]) < height * 0.5 && r[0] - last[2] < height * 2;
    if (sameLine) rects[rects.length - 1] = union(last, r);
    else rects.push([...r]);
    previous = i;
  }
  return rects;
}

/**
 * Every change between two documents, in row order. Page rows that were added, removed or moved are one
 * change each; pages present on both sides add their text changes (a moved page's text changes too).
 *   { kind: 'page-added' | 'page-removed' | 'page-moved' | 'text-added' | 'text-removed' | 'text-changed', row, ... }
 */
export function rowChanges(row, rowIndex, wordsA, wordsB) {
  if (row.kind === 'added') return [{ kind: 'page-added', row: rowIndex }];
  if (row.kind === 'removed') return [{ kind: 'page-removed', row: rowIndex }];
  const text = diffWords(wordsA, wordsB).map((c) => ({ ...c, kind: `text-${c.kind}`, row: rowIndex }));
  return row.kind === 'moved' ? [{ kind: 'page-moved', row: rowIndex }, ...text] : text;
}
