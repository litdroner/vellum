import { newId } from '../annotations/model.js';

// The document's own outline: its bookmarks, read as page numbers for splitting a PDF where its
// sections begin, and — since 0.25 — as the one editable model of the outline itself.
//
// The editable model is a FLAT list in outline order, each entry saying how deep it sits:
//
//   [{ id, title, page, url, depth, bold, italic }, ...]
//
// depth 0 is a top-level bookmark and depth n + 1 a child of the nearest entry above it at depth n,
// which is exactly how the outline reads on screen; `page` is the 1-based page of the document the
// bookmark goes to (null when it has none), and `url` is an address a bookmark of the file already
// had, kept as it was. The list is held in the edit store beside the page plan (annotations/model.js),
// so changing it is one undo step, and writeOutline puts it back into the file when it is saved. There
// is no second representation: reading (readOutline) and writing both speak this list.
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

// ---- the editable outline ---------------------------------------------------------

/**
 * The document's outline as the flat list above. Every entry pdf.js gives is kept, nested or not;
 * a destination is resolved to a page exactly as destinationPage does, and one that doesn't resolve
 * leaves `page` null rather than being guessed at. A document with no outline gives an empty list.
 */
export async function readOutline(pdf) {
  if (!pdf?.getOutline) return [];
  let outline = null;
  try { outline = await pdf.getOutline(); } catch { return []; }
  const list = [];
  const walk = async (items, depth) => {
    for (const item of items ?? []) {
      const url = typeof item?.url === 'string' ? item.url : null;
      list.push({
        id: newId(),
        title: String(item?.title ?? '').trim(),
        page: url ? null : await destinationPage(pdf, item?.dest),
        url,
        depth,
        bold: Boolean(item?.bold),
        italic: Boolean(item?.italic),
      });
      if (item?.items?.length) await walk(item.items, depth + 1);
    }
  };
  await walk(outline, 0);
  return list;
}

/** A bookmark with the fields the list needs, given a title and the page it goes to. */
export const newBookmark = ({ title = 'Bookmark', page = null, depth = 0 } = {}) => ({
  id: newId(), title: String(title).trim() || 'Bookmark', page, url: null, depth, bold: false, italic: false,
});

/**
 * The list as it may be written: titles trimmed, depths brought back to what nesting allows (an entry
 * may be at most one level deeper than the one above it, and the first is always top level), and
 * entries with no title and nowhere to go dropped. Every operation below ends here, so a list that
 * reaches the store or the writer is always one a PDF can hold.
 */
export function normalizeOutline(list) {
  const out = [];
  let previous = -1;
  for (const item of list ?? []) {
    const title = String(item?.title ?? '').trim();
    const page = Number.isInteger(item?.page) ? item.page : null;
    const url = typeof item?.url === 'string' && item.url ? item.url : null;
    if (!title && page === null && !url) continue;
    const depth = Math.max(0, Math.min(Number.isInteger(item?.depth) ? item.depth : 0, previous + 1));
    out.push({ ...item, id: item.id ?? newId(), title, page, url, depth });
    previous = depth;
  }
  return out;
}

/** The pages of the document each bookmark may go to: one outside 1…`pageCount` loses its page. */
export function clampOutlinePages(list, pageCount) {
  return normalizeOutline((list ?? []).map((item) => (
    Number.isInteger(item.page) && (item.page < 1 || item.page > pageCount) ? { ...item, page: null } : item)));
}

/** Where an entry's own section ends: itself plus everything nested under it. */
export function subtreeEnd(list, index) {
  const { depth } = list[index];
  let end = index + 1;
  while (end < list.length && list[end].depth > depth) end++;
  return end;
}

const indexOf = (list, id) => list.findIndex((item) => item.id === id);

/** Adds a bookmark after `afterId`'s section (or at the end), at that entry's depth. */
export function addBookmark(list, bookmark, afterId = null) {
  const at = afterId === null ? -1 : indexOf(list, afterId);
  if (at < 0) return normalizeOutline([...list, { ...bookmark, depth: 0 }]);
  const end = subtreeEnd(list, at);
  return normalizeOutline([...list.slice(0, end), { ...bookmark, depth: list[at].depth }, ...list.slice(end)]);
}

/** Changes one entry: its title, the page it goes to, or both. */
export function updateBookmark(list, id, patch) {
  return normalizeOutline(list.map((item) => (item.id === id ? { ...item, ...patch } : item)));
}

/** Removes an entry and everything nested under it. */
export function removeBookmark(list, id) {
  const at = indexOf(list, id);
  if (at < 0) return list;
  return normalizeOutline([...list.slice(0, at), ...list.slice(subtreeEnd(list, at))]);
}

/**
 * Moves an entry — with its children — one place up or down among its own siblings. An entry that is
 * already first or last among them stays where it is; nesting never changes here.
 */
export function moveBookmark(list, id, direction) {
  const at = indexOf(list, id);
  if (at < 0) return list;
  const end = subtreeEnd(list, at);
  const section = list.slice(at, end);
  const { depth } = list[at];
  if (direction < 0) {
    let before = at - 1;
    while (before >= 0 && list[before].depth > depth) before--;
    if (before < 0 || list[before].depth < depth) return list;
    return normalizeOutline([...list.slice(0, before), ...section, ...list.slice(before, at), ...list.slice(end)]);
  }
  if (end >= list.length || list[end].depth < depth) return list;
  const nextEnd = subtreeEnd(list, end);
  return normalizeOutline([...list.slice(0, at), ...list.slice(end, nextEnd), ...section, ...list.slice(nextEnd)]);
}

/**
 * Nests an entry one level deeper under the sibling above it (delta 1), or lifts it out to its
 * parent's level (delta -1). Its children come with it. An entry with no sibling above it can't be
 * nested, and a top-level entry can't be lifted any further.
 */
export function nestBookmark(list, id, delta) {
  const at = indexOf(list, id);
  if (at < 0 || !delta) return list;
  const { depth } = list[at];
  if (delta > 0 && (at === 0 || list[at - 1].depth < depth)) return list;
  if (delta < 0 && depth === 0) return list;
  const end = subtreeEnd(list, at);
  return normalizeOutline(list.map((item, i) => (i >= at && i < end ? { ...item, depth: item.depth + delta } : item)));
}

/**
 * The outline after a page plan change: each bookmark keeps the page it went to, wherever that page
 * is now, and a bookmark whose page was deleted loses its destination rather than being thrown away
 * or left pointing at whatever took its place. Same shape as pages/plan.js followPages.
 */
export function followOutlinePages(list, oldPlan, newPlan) {
  const position = new Map(newPlan.map((e, i) => [e.id, i + 1]));
  return normalizeOutline((list ?? []).map((item) => {
    if (!Number.isInteger(item.page)) return item;
    const entry = oldPlan[item.page - 1];
    return { ...item, page: (entry && position.get(entry.id)) ?? null };
  }));
}

/** The list as a tree, for drawing it: [{ ...entry, children: [...] }]. */
export function outlineTree(list) {
  const roots = [];
  const open = [];
  for (const item of list) {
    const node = { ...item, children: [] };
    open.length = item.depth;
    const parent = open[item.depth - 1];
    (parent ? parent.children : roots).push(node);
    open[item.depth] = node;
  }
  return roots;
}

/**
 * Writes `list` into the document as its /Outlines tree, replacing whatever outline it had. An entry
 * with a page gets an /XYZ destination on that page of `pages`; one that came from the file with an
 * address keeps its URI action; one with neither is still written, as a heading that goes nowhere.
 * An empty list takes the outline out of the file altogether.
 */
export function writeOutline(lib, doc, pages, list) {
  const { PDFHexString, PDFName, PDFNull, PDFString } = lib;
  const ctx = doc.context;
  const { catalog } = doc;
  const items = clampOutlinePages(list, pages.length);
  if (!items.length) {
    catalog.delete(PDFName.of('Outlines'));
    catalog.delete(PDFName.of('PageMode'));
    return;
  }
  const root = ctx.nextRef();
  const refs = items.map(() => ctx.nextRef());
  // Each entry's parent: the nearest entry above it that is one level shallower, or the root.
  const parents = [];
  const open = [];
  for (let i = 0; i < items.length; i++) {
    open.length = items[i].depth;
    parents.push(items[i].depth === 0 ? root : open[items[i].depth - 1]);
    open[items[i].depth] = refs[i];
  }
  const childrenOf = (ref) => items.map((_, j) => j).filter((j) => parents[j] === ref);
  items.forEach((item, i) => {
    const dict = { Title: PDFHexString.fromText(item.title || 'Untitled'), Parent: parents[i] };
    const page = Number.isInteger(item.page) ? pages[item.page - 1] : null;
    if (page) dict.Dest = [page.ref, PDFName.of('XYZ'), PDFNull, PDFNull, PDFNull];
    else if (item.url) dict.A = { Type: 'Action', S: 'URI', URI: PDFString.of(item.url) };
    const siblings = childrenOf(parents[i]);
    const at = siblings.indexOf(i);
    if (at > 0) dict.Prev = refs[siblings[at - 1]];
    if (at < siblings.length - 1) dict.Next = refs[siblings[at + 1]];
    const children = childrenOf(refs[i]);
    if (children.length) {
      dict.First = refs[children[0]];
      dict.Last = refs[children.at(-1)];
      // A positive /Count is "shown open, with this many entries visible under it": the whole section.
      dict.Count = subtreeEnd(items, i) - i - 1;
    }
    if (item.bold || item.italic) dict.F = (item.italic ? 1 : 0) | (item.bold ? 2 : 0);
    ctx.assign(refs[i], ctx.obj(dict));
  });
  const top = childrenOf(root);
  ctx.assign(root, ctx.obj({ Type: 'Outlines', First: refs[top[0]], Last: refs[top.at(-1)], Count: items.length }));
  catalog.set(PDFName.of('Outlines'), root);
}
