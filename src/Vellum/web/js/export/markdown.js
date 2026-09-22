// Export Center V1 — PDF to Markdown. Pure: it writes out what Vellum already knows and adds nothing.
//
// Everything it writes comes from a system that exists: the semantic document model (semantic/model.js) for
// the text — paragraphs as paragraph grouping joined them, every other line as its own block, in the
// model's reading order — table extraction (semantic/tables.js) for the tables it is confident about, and
// the provenance record (semantic/provenance.js) for which file this came from. Nothing is inferred: no
// heading is guessed from a font size, no column order is invented, no list or emphasis is reconstructed,
// and a page whose text was not read (a protected PDF) says so instead of being filled in.
//
// Headings are the document's own. A block becomes a Markdown heading only when the PDF's outline
// (its bookmarks) names that exact text on that page, at the depth the outline gives it; a document with no
// outline gets no headings. The only other headings are the document's name and one per page, which are
// provenance — the page each part came from — not structure read out of the text.
//
// A confident table is written as a GitHub table where its text sits in reading order, and the blocks whose
// runs it already holds are not written again. A GitHub table needs a header row, so the table's first row
// is used as one; the extraction does not say a table has a header and none is inferred.
//
//   documentMarkdown({ document, pages, tables, headings }) -> string
//     document  { name, path, contentKey } as provenance's documentRef takes it
//     pages     the semantic pages to write, in order (semantic/model.js semanticPage)
//     tables    Map of page number -> the tables on it (semantic/tables.js pageTables().tables)
//     headings  Map of page number -> Map of exact block text -> heading level (1 = top), from the outline

import { documentRef } from '../semantic/provenance.js';
import { blockTables } from '../semantic/tables.js';

const MAX_HEADING = 4; // an outline deeper than this keeps the deepest Markdown heading available

/** Text as one Markdown paragraph line: its lines joined, and anything Markdown would read as markup escaped. */
function escapeText(text) {
  return String(text ?? '')
    .replace(/\s*\n\s*/g, ' ')
    .replace(/([\\`*_[\]<>|])/g, '\\$1')
    .trim();
}

/** A paragraph, with a leading character Markdown would read as a list or a heading escaped too. */
function paragraph(text) {
  return escapeText(text).replace(/^(#{1,6}\s|[-+]\s|\d+[.)]\s|>\s)/, '\\$1');
}

const cellText = (cell) => escapeText(cell?.text).replace(/\|/g, '\\|') || ' ';

/** One confident table as a GitHub table. Its first row is the header row; nothing else is assumed. */
function tableMarkdown(table) {
  const row = (cells) => `| ${cells.map(cellText).join(' | ')} |`;
  const [header, ...body] = table.rows;
  return [
    row(header),
    `| ${header.map(() => '---').join(' | ')} |`,
    ...body.map(row),
  ].join('\n');
}

/**
 * One page as Markdown blocks (an array of already-formed strings), in the model's reading order.
 * A block whose runs belong to a confident table is left to the table, which is written where the first
 * of those blocks would have been.
 */
export function pageBlocks(page, { tables = [], headings = null } = {}) {
  if (page.contentRead === false) {
    return ['*Vellum doesn’t read the text of a protected PDF, so this page has none here.*'];
  }
  const tableOfBlock = blockTables(page, tables);
  const out = [];
  const done = new Set();
  for (const block of page.blocks) {
    const table = tableOfBlock.get(block.id);
    if (table) {
      if (done.has(table.id)) continue;
      done.add(table.id);
      out.push(tableMarkdown(table));
      continue;
    }
    const text = block.text.trim();
    if (!text) continue;
    const level = headings?.get(text) ?? null;
    out.push(level ? `${'#'.repeat(Math.min(MAX_HEADING, 2 + level))} ${escapeText(text)}` : paragraph(text));
  }
  return out;
}

/** The whole export as one Markdown document. */
export function documentMarkdown({ document = {}, pages = [], tables = null, headings = null } = {}) {
  const ref = documentRef(document);
  const parts = [`# ${escapeText(ref.name || 'Document')}`];
  for (const page of pages) {
    parts.push(`## Page ${page.number}`);
    const blocks = pageBlocks(page, { tables: tables?.get(page.number) ?? [], headings: headings?.get(page.number) ?? null });
    parts.push(...(blocks.length ? blocks : ['*This page has no text.*']));
  }
  parts.push('---', sourceNote(ref, pages));
  return `${parts.join('\n\n')}\n`;
}

/** Where this came from, in provenance's own terms: the file, its place, and the bytes that were read. */
function sourceNote(ref, pages) {
  const numbers = pages.map((p) => p.number);
  const span = numbers.length ? `page${numbers.length === 1 ? '' : 's'} ${numbers[0]}${numbers.length > 1 ? `\u2013${numbers.at(-1)}` : ''}` : 'no pages';
  const lines = [`Exported from ${escapeText(ref.name || 'this document')} by Vellum \u2014 ${span}.`];
  if (ref.path) lines.push(escapeText(ref.path));
  if (ref.contentKey) lines.push(`content ${ref.contentKey.slice(0, 12).toLowerCase()}\u2026 (the file as it was read)`);
  return lines.map((line) => `*${line}*`).join('  \n');
}

/**
 * The document's own headings by page: Map of page number -> Map of the heading's exact text -> its level.
 * Read from the PDF's outline (pdf.getOutline()), with each entry's destination resolved to a page the way
 * the model resolves a link's. An entry whose page can't be resolved is left out, and a document without an
 * outline gives an empty map — no heading is ever guessed.
 */
export async function outlineHeadings(pdf) {
  const byPage = new Map();
  if (!pdf?.getOutline) return byPage;
  let outline = null;
  try { outline = await pdf.getOutline(); } catch { return byPage; }
  const walk = async (items, level) => {
    for (const item of items ?? []) {
      const title = String(item?.title ?? '').trim();
      if (title) {
        const number = await destinationPage(pdf, item.dest);
        if (number) {
          if (!byPage.has(number)) byPage.set(number, new Map());
          const page = byPage.get(number);
          if (!page.has(title)) page.set(title, level);
        }
      }
      await walk(item?.items, level + 1);
    }
  };
  await walk(outline, 1);
  return byPage;
}

async function destinationPage(pdf, dest) {
  try {
    const resolved = typeof dest === 'string' ? await pdf.getDestination(dest) : dest;
    const target = Array.isArray(resolved) ? resolved[0] : null;
    const index = Number.isInteger(target) ? target : target && typeof target === 'object' ? await pdf.getPageIndex(target) : null;
    return Number.isInteger(index) && index >= 0 && index < pdf.numPages ? index + 1 : null;
  } catch {
    return null;
  }
}
