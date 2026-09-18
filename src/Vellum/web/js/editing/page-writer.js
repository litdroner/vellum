// The one writer that puts content edits into pages. annotations/persist.js is still the only
// place PDF bytes are produced; it calls this while composing a document.
//
// This module knows nothing about any particular kind of edit. It finds the pages that have edits,
// re-reads each one's ORIGINAL content, asks the handler for each kind (objects/registry.js) what
// to change, and assembles one new content stream per edited page:
//
//   the page's own content, wrapped in q … Q (closing anything the page leaves open), with each
//   handler's byte patches spliced in, followed by whatever the handlers draw afterwards.
//
// Nothing else on the page is touched, and a page is only rewritten when every record for it still
// matches the file exactly — a handler that can't verify its record throws, and then nothing is
// written rather than something uncertain. An edit of a kind no handler claims is refused for the
// same reason: a change a person made must never vanish silently.

import { PdfSource } from './source.js';
import { analyzePage } from './runs.js';
import { EditError } from './edits.js';
import { handlerFor } from './objects/registry.js';
import * as redaction from './objects/redaction.js';
import { spliceContent } from './content/writer.js';

/**
 * Applies content edits to arranged pages. pages[i] shows plan[i]. Resolves { changed } (pages
 * rewritten). `sources` is the document's Map of id → bytes, where a replacement picture's image is
 * and the PDFs pages were inserted from are; `originals` the opened file's own pages, in file order,
 * whether the plan still uses them or not.
 */
export async function applyObjectEdits({ lib, doc, pages, plan, edits, sources = new Map(), originals = [] }) {
  const byEntry = new Map();
  const byKind = new Map();
  for (const e of edits) {
    // A kind no handler claims is refused, before anything is written (see objects/registry.js):
    // dropping it silently would lose a change the person made without telling them.
    if (!handlerFor(e.kind)) {
      throw new EditError('unsupported', 'Vellum can’t write this kind of change yet, so nothing was saved.', { kind: e.kind });
    }
    const list = byEntry.get(e.entry) ?? [];
    list.push(e);
    byEntry.set(e.entry, list);
    const ofKind = byKind.get(e.kind) ?? [];
    ofKind.push(e);
    byKind.set(e.kind, ofKind);
  }
  if (!byEntry.size) return { changed: 0 };
  // Whole-document checks first, so a refusal happens before any page is touched.
  for (const [kind, records] of byKind) handlerFor(kind).precheck?.({ lib, doc, records });
  // Then what a handler must add to the document once for all its pages (an embedded image), and
  // hands to each page it writes. Still before any page is touched.
  const prepared = new Map();
  for (const [kind, records] of byKind) prepared.set(kind, await handlerFor(kind).prepare?.({ lib, doc, records, sources }));

  const source = new PdfSource(lib, doc);
  const origins = await readOrigins({ lib, doc, source, pages, plan, edits, sources, originals });
  let changed = 0;
  plan.forEach((entry, i) => {
    const records = byEntry.get(entry.id);
    if (!records || !pages[i]) return;
    rewritePage(lib, doc, source, pages[i], i, records, prepared, origins);
    changed++;
  });
  return { changed };
}

/**
 * The pages whose ORIGINAL content records draw from on other pages (a record's `from`, see
 * objects/copies.js): Map `${src}:${index}` → { key, analysis, resources }, each read before any page
 * is rewritten, so it is the file's own page whatever the other edits do to it. The page is the one
 * the plan shows, or the opened file's own page when the plan no longer uses it, or — from a PDF in
 * `sources` that no page of the plan comes from any more — a copy of that page brought into the
 * document, unused but for what the records draw from it (collectGarbage sweeps the rest). A page
 * that can't be found or read reliably refuses the save.
 */
async function readOrigins({ lib, doc, source, pages, plan, edits, sources, originals }) {
  const wanted = new Map();
  for (const { from } of edits) if (from) wanted.set(`${from.src}:${from.index}`, from);
  const found = new Map();
  const fromOtherFiles = new Map(); // src → [index]
  for (const [key, from] of wanted) {
    const position = plan.findIndex((e) => e.src === from.src && e.index === from.index);
    const page = position >= 0 ? pages[position] : from.src === 'base' ? originals[from.index] : null;
    if (page) found.set(key, page);
    else if (from.src !== 'base' && from.src !== 'blank') fromOtherFiles.set(from.src, [...(fromOtherFiles.get(from.src) ?? []), from.index]);
  }
  for (const [src, indexes] of fromOtherFiles) {
    const bytes = sources.get(src);
    const other = bytes instanceof Uint8Array ? await lib.PDFDocument.load(bytes, { updateMetadata: false }).catch(() => null) : null;
    const usable = other ? indexes.filter((i) => Number.isInteger(i) && i >= 0 && i < other.getPageCount()) : [];
    if (!usable.length) continue;
    const copied = await doc.copyPages(other, usable);
    usable.forEach((i, k) => found.set(`${src}:${i}`, copied[k]));
  }
  const origins = new Map();
  for (const [key, from] of wanted) {
    const page = found.get(key);
    if (!page) throw new EditError('missing', 'A page that pasted text or pictures come from isn’t available any more, so nothing was saved.');
    const analysis = analyzePage(source.pageFor(page, from.index));
    if (analysis.summary.kind === 'unreadable' || analysis.tainted || analysis.unbalanced) {
      throw new EditError('content', 'A page that pasted text or pictures come from couldn’t be read reliably, so nothing was saved.');
    }
    origins.set(key, { key, analysis, resources: page.node.Resources() ?? null });
  }
  return origins;
}

function rewritePage(lib, doc, source, page, index, records, prepared, origins) {
  // Redactions go last, over the page as every other edit leaves it (objects/redaction.js), so nothing
  // another edit draws into a redacted area survives it.
  const redactions = records.filter((r) => r.kind === redaction.kind);
  const others = records.filter((r) => r.kind !== redaction.kind);
  if (others.length) {
    const analysis = readPage(source, page, index);
    const patches = [];
    const appended = [];
    for (const [kind, list] of groupByKind(others)) {
      const result = handlerFor(kind).write({ lib, doc, source, page, index, analysis, records: list, prepared: prepared.get(kind), pageRecords: records, origins });
      patches.push(...result.patches);
      appended.push(...result.append);
    }
    writeContent(lib, doc, page, analysis, patches, appended);
  }
  if (redactions.length) {
    const analysis = readPage(source, page, index);
    const { patches, append } = redaction.write({ lib, doc, page, index, analysis, records: redactions });
    writeContent(lib, doc, page, analysis, patches, append);
  }
}

function readPage(source, page, index) {
  const analysis = analyzePage(source.pageFor(page, index));
  if (analysis.summary.kind === 'unreadable' || analysis.tainted || analysis.unbalanced) {
    throw new EditError('content', `Page ${index + 1}’s content couldn’t be read reliably, so it wasn’t changed.`);
  }
  return analysis;
}

function writeContent(lib, doc, page, analysis, patches, appended) {
  // The page's own content, wrapped in q … Q (closing anything it leaves open), then what
  // follows — assembled by the writer's own spliceContent(), which a private copy of a form
  // XObject builds its content with too (objects/form-copy.js).
  const bytes = spliceContent(analysis.bytes, patches, appended, analysis);
  const ctx = doc.context;
  page.node.set(lib.PDFName.of('Contents'), ctx.register(ctx.flateStream(bytes)));
}

/** A page's records grouped by kind, each group keeping the order the edits were made in. */
function groupByKind(records) {
  const groups = new Map();
  for (const r of records) {
    const list = groups.get(r.kind) ?? [];
    list.push(r);
    groups.set(r.kind, list);
  }
  return groups;
}
