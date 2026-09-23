// Export Center V1 — the export contract every format shares. Pure: no DOM, no pdf.js, no host, no state.
//
// One export is a plan: a format, the pages it covers, and the files it will create, named before anything
// is rendered or read. A format says how its files are made, not how they are written — the run
// (export/run.js) produces each file's bytes and hands them to the host, and every format goes through the
// same steps: choose pages, name the files, ask the host for write targets, produce, write, report.
//
//   format   { id, label, extension, mime, kind: 'image' | 'text' | 'binary', perPage, note }
//   plan     { format, base, pageCount, pages, files }
//   file     { name, pages }        pages: the page numbers this one file holds (one, for a per-page format)
//   result   { format, total, written, failed, cancelled, ok }   (export/run.js fills it in)
//
// File names are deterministic: the same document, format and pages always give the same names, in the same
// order, whatever was exported before. A per-page format names each file after the document and the page,
// zero-padded to the document's page count (at least three digits) so the files sort as the pages read.
//
// Adding a format means adding an entry here and a producer for it;
// pages, names, targets, overwriting, progress, cancellation and the result stay exactly as they are.

export const EXPORT_FORMATS = Object.freeze({
  jpg: Object.freeze({
    id: 'jpg', label: 'JPEG images', extension: 'jpg', mime: 'image/jpeg', kind: 'image', perPage: true,
    note: 'One image per page, as the page is drawn.',
  }),
  png: Object.freeze({
    id: 'png', label: 'PNG images', extension: 'png', mime: 'image/png', kind: 'image', perPage: true,
    note: 'One image per page, as the page is drawn.',
  }),
  markdown: Object.freeze({
    id: 'markdown', label: 'Markdown', extension: 'md', mime: 'text/markdown', kind: 'text', perPage: false,
    note: 'One file: the text Vellum already reads, its confident tables, and the page each part came from.',
  }),
  excel: Object.freeze({
    id: 'excel', label: 'Excel workbook', extension: 'xlsx',
    mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', kind: 'binary', perPage: false,
    note: 'One worksheet for every table Vellum is confident about, as real cells.',
  }),
  word: Object.freeze({
    id: 'word', label: 'Word document', extension: 'docx',
    mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', kind: 'binary', perPage: false,
    note: 'One editable document: the text Vellum already reads, its confident tables, page by page.',
  }),
  powerpoint: Object.freeze({
    id: 'powerpoint', label: 'PowerPoint deck', extension: 'pptx',
    mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', kind: 'binary', perPage: false,
    note: 'One editable slide per page: the text Vellum already reads, in boxes where it sits.',
  }),
});

/** The formats an export offers, in the order the dialog shows them. */
export const EXPORT_FORMAT_IDS = Object.freeze(Object.keys(EXPORT_FORMATS));

export const exportFormat = (id) => EXPORT_FORMATS[id] ?? null;

const MIN_PAGE_DIGITS = 3;

/**
 * "1-3, 5, 9-" as page numbers, sorted and without duplicates (the same syntax the page dialogs use).
 * Null when any part is not a page of this document.
 */
export function parsePageRange(text, total) {
  const parts = String(text ?? '').split(',').map((p) => p.trim()).filter(Boolean);
  if (!parts.length) return null;
  const pages = new Set();
  for (const part of parts) {
    const m = /^(\d+)\s*(?:[-\u2013]\s*(\d*))?$/.exec(part);
    if (!m) return null;
    const start = Number(m[1]);
    const end = m[2] === undefined ? start : m[2] === '' ? total : Number(m[2]);
    if (!Number.isInteger(start) || start < 1 || end > total || start > end) return null;
    for (let n = start; n <= end; n++) pages.add(n);
  }
  return [...pages].sort((a, b) => a - b);
}

/**
 * The pages a selection covers, sorted and without duplicates, or null if it covers none.
 *   { mode: 'all' } | { mode: 'range', text } | { mode: 'pages', pages }
 */
export function selectedPages(selection, total) {
  if (!Number.isInteger(total) || total < 1) return null;
  const mode = selection?.mode ?? 'all';
  if (mode === 'all') return Array.from({ length: total }, (_, i) => i + 1);
  if (mode === 'range') return parsePageRange(selection.text, total);
  const pages = [...new Set((selection?.pages ?? []).filter((n) => Number.isInteger(n) && n >= 1 && n <= total))].sort((a, b) => a - b);
  return pages.length ? pages : null;
}

/** "3", "3-5" or "2, 4, 7-9" (en dashes) for a set of page numbers. */
export function describePageNumbers(numbers) {
  const runs = [];
  for (const n of [...new Set(numbers)].sort((a, b) => a - b)) {
    const last = runs.at(-1);
    if (last && n === last[1] + 1) last[1] = n;
    else runs.push([n, n]);
  }
  return runs.map(([a, b]) => (a === b ? `${a}` : `${a}\u2013${b}`)).join(', ');
}

/** The document's name as the stem of an exported file: no extension, and nothing a file name can't hold. */
export function exportBaseName(fileName) {
  const stem = String(fileName ?? '').replace(/\.pdf$/i, '');
  const clean = stem.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().replace(/\.+$/, '').trim();
  return clean || 'Document';
}

/** One file's name: "report (page 003).jpg" for a per-page format, "report.md" otherwise. */
export function exportFileName({ base, format, page = null, pageCount = 1 }) {
  if (!format.perPage || page == null) return `${base}.${format.extension}`;
  const digits = Math.max(MIN_PAGE_DIGITS, String(Math.max(1, pageCount)).length);
  return `${base} (page ${String(page).padStart(digits, '0')}).${format.extension}`;
}

/**
 * The plan for one export. `pages` are the document's page numbers to export (selectedPages); `pageCount`
 * is the whole document's, which is what the file names are padded to. Frozen; throws on an unknown format
 * or no pages, which the dialog has already ruled out.
 */
export function exportPlan({ fileName, formatId, pages, pageCount }) {
  const format = exportFormat(formatId);
  if (!format) throw new Error('Vellum has no export format by that name.');
  const numbers = [...new Set(pages ?? [])].sort((a, b) => a - b);
  if (!numbers.length) throw new Error('No pages were chosen to export.');
  const base = exportBaseName(fileName);
  const total = Number.isInteger(pageCount) && pageCount > 0 ? pageCount : numbers.at(-1);
  const files = format.perPage
    ? numbers.map((page) => Object.freeze({ name: exportFileName({ base, format, page, pageCount: total }), pages: Object.freeze([page]) }))
    : [Object.freeze({ name: exportFileName({ base, format, pageCount: total }), pages: Object.freeze([...numbers]) })];
  return Object.freeze({
    format,
    base,
    pageCount: total,
    pages: Object.freeze(numbers),
    files: Object.freeze(files),
  });
}

/** What a plan is about to do, for the dialog's note: "Creates 3 files: report (page 001).jpg ...". */
export function describePlan(plan) {
  const shown = plan.files.slice(0, 3).map((f) => f.name).join(', ');
  const rest = plan.files.length > 3 ? ' \u2026' : '';
  const files = `${plan.files.length} file${plan.files.length === 1 ? '' : 's'}`;
  return `Creates ${files} from page${plan.pages.length === 1 ? '' : 's'} ${describePageNumbers(plan.pages)}: ${shown}${rest}`;
}

/** What an export did, for the toast and the dialog: one plain sentence. */
export function describeResult(result) {
  const files = (n) => `${n} file${n === 1 ? '' : 's'}`;
  if (result.cancelled) return result.written.length ? `Export stopped \u2014 ${files(result.written.length)} written` : 'Export cancelled \u2014 nothing was written';
  if (result.failed.length) return `${files(result.written.length)} written, ${result.failed.length} couldn\u2019t be: ${result.failed[0].error}`;
  return `Exported ${files(result.written.length)}`;
}
