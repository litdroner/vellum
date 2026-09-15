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
import { ascii, concat } from './content/writer.js';

/**
 * Applies content edits to arranged pages. pages[i] shows plan[i]. Resolves { changed } (pages
 * rewritten). `sources` is the document's Map of id → bytes, where a replacement picture's image is.
 */
export async function applyObjectEdits({ lib, doc, pages, plan, edits, sources = new Map() }) {
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
  let changed = 0;
  plan.forEach((entry, i) => {
    const records = byEntry.get(entry.id);
    if (!records || !pages[i]) return;
    rewritePage(lib, doc, source, pages[i], i, records, prepared);
    changed++;
  });
  return { changed };
}

function rewritePage(lib, doc, source, page, index, records, prepared) {
  const analysis = analyzePage(source.pageFor(page, index));
  if (analysis.summary.kind === 'unreadable' || analysis.tainted || analysis.unbalanced) {
    throw new EditError('content', `Page ${index + 1}’s content couldn’t be read reliably, so it wasn’t changed.`);
  }

  const patches = [];
  const appended = [];
  for (const [kind, list] of groupByKind(records)) {
    const result = handlerFor(kind).write({ lib, doc, source, page, index, analysis, records: list, prepared: prepared.get(kind) });
    patches.push(...result.patches);
    appended.push(...result.append);
  }

  patches.sort((a, b) => a.start - b.start);
  for (let i = 1; i < patches.length; i++) {
    if (patches[i].start < patches[i - 1].end) throw new EditError('content', 'Overlapping text operators; the page wasn’t changed.');
  }

  // The page's own content, wrapped in q … Q (closing anything it leaves open), then what follows.
  const pieces = [ascii('q\n')];
  let at = 0;
  for (const p of patches) {
    pieces.push(analysis.bytes.subarray(at, p.start), ascii(p.text));
    at = p.end;
  }
  pieces.push(analysis.bytes.subarray(at));
  pieces.push(ascii(`\n${analysis.openText ? 'ET\n' : ''}${'Q\n'.repeat(analysis.openStates)}Q\n`));
  for (const text of appended) pieces.push(ascii(`${text}\n`));

  const ctx = doc.context;
  page.node.set(lib.PDFName.of('Contents'), ctx.register(ctx.flateStream(concat(pieces))));
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
