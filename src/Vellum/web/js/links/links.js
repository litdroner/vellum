// Links, the one model Vellum has of them.
//
// A link is a store item like a created form field (annotations/model.js): plain data in PDF user
// space, held in the edit store with everything else so one Ctrl+Z undoes it, and written into the
// file only when it is saved.
//
//   { id, type: 'link', page, rect: [x1, y1, x2, y2],
//     url,      an address — exactly one of these two is set …
//     target,   … or the 1-based page of the saved document the link goes to
//     existing?: { id, rect },   one of the file's own links, being changed
//     deleted?, contents? }
//
// The file's own links are read by pdf.js like any other annotation (semantic/model.js reads them for
// the Structure panel, and resolves an internal one's page with linkTargets). One of them becomes
// editable by being adopted as a store item with `existing` naming the annotation it stands for —
// exactly as forms/fields.js adopts one of the file's form fields. Nothing here keeps a second copy of
// a link: the store holds only the ones being created or changed, and the file holds the rest.
//
// Saving writes standard /Link annotations — a URI action for an address, an /XYZ destination for a
// page — so every reader follows them. It never writes a link whose destination is missing or one
// Vellum won't open (see linkUrl).

/** Smallest a link's rectangle can be dragged to, in points. */
export const MIN_LINK_SIZE = 8;

/** How far (points) an adopted link's rectangle may have moved and still be recognised in the file. */
const MATCH_TOLERANCE = 2;

// Only addresses a reader may follow. A PDF can carry javascript:, file: and data: URIs; Vellum
// neither writes nor keeps them, whatever the file it came from held.
const ALLOWED = /^(https?|mailto|tel):/i;
const BARE_HOST = /^[\w-]+(\.[\w-]+)+(\/\S*)?$/;
const BARE_MAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * `text` as an address a link may hold, or null. "example.com/x" and "a@b.com" are taken as the
 * https: and mailto: addresses they plainly are; anything else must say its own scheme, and only
 * http, https, mailto and tel are allowed.
 */
export function linkUrl(text) {
  const value = String(text ?? '').trim();
  if (!value || value.length > 2000 || /[\u0000-\u001f\u007f]/.test(value)) return null;
  // A scheme of its own is honoured if it is one of the allowed ones; otherwise the plain forms
  // "example.com/x" and "ada@example.com" are taken as the https: and mailto: addresses they are.
  if (/^[a-z][a-z0-9+.-]*:/i.test(value)) {
    if (!ALLOWED.test(value)) return null;
    try {
      return new URL(value).href;
    } catch {
      return null;
    }
  }
  if (BARE_MAIL.test(value)) return `mailto:${value}`;
  if (BARE_HOST.test(value)) return `https://${value}`;
  return null;
}

/** True when the item has somewhere to go: an allowed address, or a page of the document. */
export const hasDestination = (item, pageCount = Infinity) => Boolean(linkUrl(item?.url))
  || (Number.isInteger(item?.target) && item.target >= 1 && item.target <= pageCount);

/** What a link points at, for a label. */
export const linkLabel = (item) => (item?.url ? item.url : Number.isInteger(item?.target) ? `Page ${item.target}` : 'No destination');

/**
 * The store item that lets one of the file's own links be edited, from pdf.js's annotation data
 * (page.getAnnotations()) on page `page`; null for what isn't a link Vellum edits. `targetPage` is
 * the page an internal link goes to when pdf.js could resolve it (semantic/model.js linkTargets) —
 * without it an internal link is still adopted, and is given a destination before it is saved.
 */
export function existingLinkItem(data, page, targetPage = null) {
  if (data?.subtype !== 'Link' || !Array.isArray(data.rect) || data.rect.length !== 4) return null;
  const [a, b, c, d] = data.rect;
  if (![a, b, c, d].every(Number.isFinite)) return null;
  const rect = [Math.min(a, c), Math.min(b, d), Math.max(a, c), Math.max(b, d)];
  const url = linkUrl(data.url ?? data.unsafeUrl ?? '');
  return {
    type: 'link', page, rect, url, target: url ? null : Number.isInteger(targetPage) ? targetPage : null,
    existing: { id: data.id, rect },
  };
}

/** The /Link annotations of a page, each with the reference it is stored under. */
function linkAnnots(doc, page, lib) {
  const { PDFDict, PDFName, PDFRef } = lib;
  const annots = page.node.Annots();
  const found = [];
  for (let i = 0; annots && i < annots.size(); i++) {
    const ref = annots.get(i);
    const dict = doc.context.lookup(ref);
    if (!(dict instanceof PDFDict) || dict.get(PDFName.of('Subtype')) !== PDFName.of('Link')) continue;
    const raw = doc.context.lookup(dict.get(PDFName.of('Rect')));
    const numbers = raw?.asArray?.().map((v) => doc.context.lookup(v)?.asNumber?.());
    if (!numbers || numbers.length !== 4 || !numbers.every(Number.isFinite)) continue;
    const [a, b, c, d] = numbers;
    found.push({
      ref: ref instanceof PDFRef ? ref : null,
      dict,
      rect: [Math.min(a, c), Math.min(b, d), Math.max(a, c), Math.max(b, d)],
    });
  }
  return found;
}

/** The link of a page whose rectangle is (within a couple of points) the one given, or null. */
function closestLink(links, [x1, y1, x2, y2]) {
  let best = null;
  let bestDistance = MATCH_TOLERANCE;
  for (const entry of links) {
    const r = entry.rect;
    const distance = Math.max(Math.abs(r[0] - x1), Math.abs(r[1] - y1), Math.abs(r[2] - x2), Math.abs(r[3] - y2));
    if (distance <= bestDistance) {
      best = entry;
      bestDistance = distance;
    }
  }
  return best;
}

/** Sets a link dictionary's destination: a URI action, or an /XYZ destination on a page of this file. */
function setDestination(ctx, dict, item, pages, lib) {
  const { PDFName, PDFNull, PDFString } = lib;
  const url = linkUrl(item.url);
  dict.delete(PDFName.of('A'));
  dict.delete(PDFName.of('Dest'));
  if (url) {
    dict.set(PDFName.of('A'), ctx.obj({ Type: 'Action', S: 'URI', URI: PDFString.of(url) }));
    return true;
  }
  const page = pages[item.target - 1];
  if (!page) return false;
  // "/XYZ null null null": the top of the page, at whatever zoom the reader is already using.
  dict.set(PDFName.of('Dest'), ctx.obj([page.ref, PDFName.of('XYZ'), PDFNull, PDFNull, PDFNull]));
  return true;
}

/**
 * Writes created links (store items of type 'link' without `existing`) onto `pages` (1-based
 * item.page) as standard /Link annotations. A link with no destination — one just placed and not yet
 * given an address — is not written; neither is one whose address Vellum wouldn't open.
 */
export async function writeNewLinks(lib, doc, pages, items) {
  if (!items.length) return;
  const ctx = doc.context;
  for (const item of items) {
    const page = pages[item.page - 1];
    if (!page || !hasDestination(item, pages.length)) continue;
    const [x1, y1, x2, y2] = item.rect;
    // /Border [0 0 0] and no /C: no box drawn around the link, as generated PDFs write them.
    const dict = ctx.obj({ Type: 'Annot', Subtype: 'Link', Rect: [x1, y1, x2, y2], Border: [0, 0, 0], F: 4 });
    if (!setDestination(ctx, dict, item, pages, lib)) continue;
    if (item.contents) dict.set(lib.PDFName.of('Contents'), lib.PDFHexString.fromText(item.contents));
    page.node.addAnnot(ctx.register(dict));
  }
}

/**
 * Writes the changes made to the file's own links (items with `existing`, see existingLinkItem) into
 * those links: where the rectangle is, where it goes, or its removal. A link no longer where it was —
 * its page was deleted, or another edit moved it — is passed over. Throws with a readable reason.
 */
export async function writeLinkChanges(lib, doc, pages, items) {
  if (!items.length) return;
  const ctx = doc.context;
  const byPage = new Map();
  for (const item of items) {
    const list = byPage.get(item.page) ?? [];
    list.push(item);
    byPage.set(item.page, list);
  }
  for (const [number, list] of byPage) {
    const page = pages[number - 1];
    if (!page) continue;
    const links = linkAnnots(doc, page, lib);
    for (const item of list) {
      const entry = closestLink(links, item.existing.rect);
      if (!entry) continue;
      try {
        if (item.deleted) {
          if (entry.ref) page.node.removeAnnot(entry.ref);
          continue;
        }
        if (!hasDestination(item, pages.length)) throw new Error('it has no destination');
        const [x1, y1, x2, y2] = item.rect;
        entry.dict.set(lib.PDFName.of('Rect'), ctx.obj([x1, y1, x2, y2]));
        setDestination(ctx, entry.dict, item, pages, lib);
      } catch (err) {
        throw new Error(`A link on page ${number} couldn’t be changed (${err.message}).`);
      }
    }
  }
}
