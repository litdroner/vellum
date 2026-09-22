// The document's own outline (its bookmarks) read as page numbers, for splitting a PDF where its
// sections begin.
//
// Nothing here guesses. A bookmark becomes a boundary only when its destination resolves to a page of
// this document the way pdf.js resolves a link's — the same resolution PDF → Markdown already uses for
// headings (destinationPage, which lives here now so there is one copy of it). A bookmark that points
// at a URL, an action, or a destination that can't be resolved has no page and is passed over; no page
// is ever inferred from a title, the text of a page or where an entry sits in the list.
//
// Only top-level entries are boundaries in V1. A nested entry's pages stay inside its parent's section,
// which is what a chapter split means: the sections are the top level of the book.

/** The page a destination points at (1-based), or null when it can't be resolved. */
export async function destinationPage(pdf, dest) {
  try {
    const resolved = typeof dest === 'string' ? await pdf.getDestination(dest) : dest;
    const target = Array.isArray(resolved) ? resolved[0] : null;
    const index = Number.isInteger(target) ? target : target && typeof target === 'object' ? await pdf.getPageIndex(target) : null;
    return Number.isInteger(index) && index >= 0 && index < pdf.numPages ? index + 1 : null;
  } catch {
    return null;
  }
}

/**
 * The document's top-level bookmarks that have a page, in outline order: [{ title, page }].
 * A document with no outline, or none whose destination resolves, gives an empty list.
 */
export async function topLevelBookmarks(pdf) {
  if (!pdf?.getOutline) return [];
  let outline = null;
  try { outline = await pdf.getOutline(); } catch { return []; }
  const found = [];
  for (const item of outline ?? []) {
    const page = await destinationPage(pdf, item?.dest);
    if (page) found.push({ title: String(item?.title ?? '').trim(), page });
  }
  return found;
}

/**
 * The sections a bookmark split would make, over a document of `total` pages:
 * [{ title, from, to }], covering every page once, in page order. `title` is null for the pages
 * before the first bookmark, which are a section of their own rather than being thrown away.
 * Two bookmarks on one page are one boundary — the first of them in outline order names it.
 */
export function bookmarkSections(bookmarks, total) {
  const byPage = new Map();
  for (const b of bookmarks) {
    if (!Number.isInteger(b.page) || b.page < 1 || b.page > total) continue;
    if (!byPage.has(b.page)) byPage.set(b.page, b.title);
  }
  const starts = [...byPage.keys()].sort((a, b) => a - b);
  if (!starts.length) return [];
  const sections = starts.map((from, i) => ({ title: byPage.get(from), from, to: (starts[i + 1] ?? total + 1) - 1 }));
  if (starts[0] > 1) sections.unshift({ title: null, from: 1, to: starts[0] - 1 });
  return sections;
}

// Windows will not take these in a file name, nor a name that is one of its device names.
const ILLEGAL = /[<>:"/\\|?*\u0000-\u001f]+/g;
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
const MAX_NAME = 60;

/** A bookmark title as a file name Windows will take. Empty or impossible titles fall back. */
export function safeFileName(title, fallback = 'Section') {
  let name = String(title ?? '').replace(ILLEGAL, ' ').replace(/\s+/g, ' ').trim();
  if (name.length > MAX_NAME) name = name.slice(0, MAX_NAME).trim();
  name = name.replace(/[. ]+$/, '');
  if (!name) return fallback;
  return RESERVED.test(name) ? `${name} (section)` : name;
}

const pagesLabel = (from, to) => (from === to ? `page ${from}` : `pages ${from}-${to}`);

/**
 * A ".pdf" name for every section, in order and all different: a bookmark's title, and the document's
 * own name with the pages for the part before the first bookmark. The same sections always give the
 * same names; a title used twice is numbered. (The host still finds a free path in the folder chosen,
 * so nothing is ever overwritten.)
 */
export function sectionFileNames(sections, baseName) {
  const used = new Map();
  return sections.map((s, i) => {
    const wanted = s.title === null
      ? `${safeFileName(baseName, 'Document')} (${pagesLabel(s.from, s.to)})`
      : safeFileName(s.title, `Section ${i + 1}`);
    const seen = (used.get(wanted.toLowerCase()) ?? 0) + 1;
    used.set(wanted.toLowerCase(), seen);
    return `${seen === 1 ? wanted : `${wanted} (${seen})`}.pdf`;
  });
}
