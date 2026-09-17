// The semantic document model: one read-only description of what a document is made of — pages, text
// blocks and the text runs in them, images, form fields, annotations and links — with a box for each and
// an in-memory ID that is the same every time the same pages are described.
//
// It is an adapter and adds no analysis of its own. Text runs and images are the object model's
// (editing/objects/page-objects.js, from editing/runs.js); paragraphs are paragraph grouping's
// (editing/objects/text-block.js), so lines it won't join — columns, table cells, lists, indents — stay
// separate one-line blocks here too; fields, annotations and links are pdf.js's reading of the page's
// annotations (page.getAnnotations()). Nothing here writes, edits or selects.
//
//   document  { pageCount, pages }
//   page      { id, number, box, rotate, blocks, runs, images, fields, annotations, links, readingOrder }
//   block     { id, kind: 'paragraph' | 'line', text, lines, runIds, box }
//   run       { id, key, blockId, text, box, quad, font, size, dir, editable, invisible }
//   image     { id, key, box, quad, inline, inserted, pixels }
//   field     { id, name, type, value, box, readOnly }
//   annotation{ id, subtype, contents, box }
//   link      { id, url, internal, box }
//
// Boxes are [x1, y1, x2, y2] in the page's PDF user space (y up), as the analysis and pdf.js give them.
// IDs are `p<page>:<key>`: the object model's key for text and images, pdf.js's object id for the rest.
//
// Reading order is only what the analysis can vouch for: the lines of a paragraph run top down, and blocks
// follow the order the page's content draws them in (`readingOrder`, block IDs). That is the reading order
// of most generated PDFs but not a promise of it; no columns are inferred from where text sits.

import { compareOrder, objectsOf } from '../editing/objects/page-objects.js';
import { textBlocks } from '../editing/objects/text-block.js';
import { unionBox } from '../editing/objects/geometry.js';

const freezeAll = (list) => Object.freeze(list.map((x) => Object.freeze(x)));

/** A rectangle as [x1, y1, x2, y2] with x1 ≤ x2 and y1 ≤ y2, or null. */
function normalRect(rect) {
  if (!Array.isArray(rect) || rect.length !== 4 || !rect.every(Number.isFinite)) return null;
  return Object.freeze([Math.min(rect[0], rect[2]), Math.min(rect[1], rect[3]), Math.max(rect[0], rect[2]), Math.max(rect[1], rect[3])]);
}

const FIELD_TYPES = { Tx: 'text', Ch: 'choice', Sig: 'signature' };

function fieldType(a) {
  if (a.fieldType === 'Btn') return a.checkBox ? 'checkbox' : a.radioButton ? 'radio' : 'button';
  if (a.fieldType === 'Ch') return a.combo ? 'dropdown' : 'list';
  return FIELD_TYPES[a.fieldType] ?? 'unknown';
}

/** pdf.js annotation data → fields, links and annotations. Popups belong to their parent; they are not their own. */
function classifyAnnotations(prefix, list) {
  const fields = [];
  const links = [];
  const annotations = [];
  for (const a of list ?? []) {
    if (!a || a.subtype === 'Popup') continue;
    const id = `${prefix}:annot:${a.id}`;
    const box = normalRect(a.rect);
    if (a.subtype === 'Widget' && a.fieldName !== undefined) {
      fields.push({ id, name: a.fieldName ?? '', type: fieldType(a), value: a.fieldValue ?? null, box, readOnly: Boolean(a.readOnly) });
    } else if (a.subtype === 'Link') {
      links.push({ id, url: a.url ?? a.unsafeUrl ?? null, internal: !a.url && !a.unsafeUrl && (a.dest != null || a.action != null), box });
    } else {
      const contents = a.contentsObj?.str ?? (typeof a.contents === 'string' ? a.contents : null);
      annotations.push({ id, subtype: a.subtype ?? 'Unknown', contents: contents || null, box });
    }
  }
  return { fields, links, annotations };
}

/**
 * One page's model. Pure.
 *   number       1-based position of the page in the document
 *   objects      the page's objects (objectsOf(analysis), or a session's objects(pageNumber).objects)
 *   annotations  pdf.js's page.getAnnotations() for the page (optional)
 *   box, rotate  the page's box in user space and its rotation (optional)
 */
export function semanticPage({ number, objects = [], annotations = [], box = null, rotate = 0 }) {
  const prefix = `p${number}`;
  const idOf = (o) => `${prefix}:${o.ref.key}`;
  const texts = objects.filter((o) => o.kind === 'text-run' && o.text?.trim() && o.geometry?.quad);
  const byKey = new Map(texts.map((o) => [o.ref.key, o]));

  // Paragraphs from grouping, then every line it left alone as a block of its own.
  const blockList = [];
  const blockOfKey = new Map();
  for (const group of textBlocks(objects)) {
    const lines = group.keys.map((k) => byKey.get(k)).filter(Boolean);
    if (lines.length < 2) continue;
    const entry = { id: `${prefix}:${group.key}`, kind: 'paragraph', lines };
    blockList.push(entry);
    for (const l of lines) blockOfKey.set(l.ref.key, entry);
  }
  for (const o of texts) {
    if (blockOfKey.has(o.ref.key)) continue;
    const entry = { id: `${prefix}:block:${o.ref.key}`, kind: 'line', lines: [o] };
    blockList.push(entry);
    blockOfKey.set(o.ref.key, entry);
  }
  // Content order of each block's earliest-drawn line: the only order the analysis vouches for.
  const first = (entry) => entry.lines.reduce((a, b) => (compareOrder(a, b) <= 0 ? a : b));
  blockList.sort((a, b) => compareOrder(first(a), first(b)));

  const blocks = blockList.map((b) => ({
    id: b.id,
    kind: b.kind,
    text: b.lines.map((l) => l.text).join('\n'),
    lines: b.lines.length,
    runIds: Object.freeze(b.lines.map(idOf)),
    box: Object.freeze(unionBox(b.lines.map((l) => l.geometry.quad))),
  }));

  const runs = texts.map((o) => ({
    id: idOf(o),
    key: o.ref.key,
    blockId: blockOfKey.get(o.ref.key).id,
    text: o.text,
    box: o.geometry.box ?? null,
    quad: o.geometry.quad,
    font: o.record.font?.name ?? o.record.fontName ?? null,
    size: o.record.frame?.size ?? null,
    dir: o.record.frame?.dir ?? null,
    editable: o.editable === true,
    invisible: Boolean(o.reasons?.includes('invisible')),
  }));

  const images = objects.filter((o) => o.kind === 'image').map((o) => ({
    id: idOf(o),
    key: o.ref.key,
    box: o.geometry.box ?? null,
    quad: o.geometry.quad ?? null,
    inline: Boolean(o.record.inline),
    inserted: Boolean(o.ref.inserted),
    pixels: o.record.info?.width && o.record.info?.height ? Object.freeze([o.record.info.width, o.record.info.height]) : null,
  }));

  const { fields, links, annotations: notes } = classifyAnnotations(prefix, annotations);
  return Object.freeze({
    id: prefix,
    number,
    box: normalRect(box),
    rotate: rotate ?? 0,
    blocks: freezeAll(blocks),
    runs: freezeAll(runs),
    images: freezeAll(images),
    fields: freezeAll(fields),
    annotations: freezeAll(notes),
    links: freezeAll(links),
    readingOrder: Object.freeze(blocks.map((b) => b.id)),
  });
}

/** A document's model from its pages' models. Pure. */
export function semanticDocument(pages) {
  const list = Object.freeze([...pages]);
  const index = new Map();
  for (const page of list) {
    for (const group of [page.blocks, page.runs, page.images, page.fields, page.annotations, page.links]) {
      for (const item of group) index.set(item.id, item);
    }
  }
  return Object.freeze({ pageCount: list.length, pages: list, byId: (id) => index.get(id) ?? null });
}

/**
 * The model of one analyzed page (editing/runs.js analyzePage) and its pdf.js page proxy, or of a page's
 * analysis alone.
 */
export async function readSemanticPage(analysis, pdfPage = null) {
  const annotations = pdfPage ? await pdfPage.getAnnotations().catch(() => []) : [];
  return semanticPage({
    number: analysis ? analysis.page + 1 : pdfPage.pageNumber,
    objects: analysis ? objectsOf(analysis) : [],
    annotations,
    box: analysis?.box ?? pdfPage?.view ?? null,
    rotate: pdfPage?.rotate ?? 0,
  });
}

/**
 * The model of the document open in an editing session (editing/session.js), page by page as it is
 * shown, over the same analysis the editor uses. `pdf` is the pdf.js document of the pages shown.
 */
export async function readSemanticDocument(session, pdf) {
  const pages = [];
  for (let number = 1; number <= pdf.numPages; number++) {
    const [{ objects }, pdfPage] = await Promise.all([session.objects(number), pdf.getPage(number)]);
    const annotations = await pdfPage.getAnnotations().catch(() => []);
    pages.push(semanticPage({ number, objects, annotations, box: pdfPage.view, rotate: pdfPage.rotate }));
  }
  return semanticDocument(pages);
}
