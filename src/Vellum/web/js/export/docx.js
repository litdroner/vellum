// Export Center — PDF to Word. Pure: it writes out what Vellum already reads and adds nothing.
//
// The source is the semantic document model (semantic/model.js) — the same one the Markdown export writes
// from — and nothing else: paragraphs as paragraph grouping joined them, every other line as its own
// paragraph, in the model's reading order. There is no second PDF parser here, no page rasterized, no
// layout read off the page, and no structure guessed: a heading is written only where the PDF's own outline
// names that exact text on that page, and no heading is ever inferred from a font size.
//
// What is written, and only because it is already known:
//   paragraphs  the model's blocks, one Word paragraph each, its runs in the model's order
//   bold, italic  the PDF's own font name for that run says so ("Arial-BoldMT", "Helvetica-Oblique");
//                 nothing else about a run's look is claimed
//   tables      the tables Table extraction V1 is confident about (semantic/tables.js), as Word tables of
//               real cells, their columns as wide as the model's own boxes; an empty cell stays empty
//   links       a run a link annotation's own rectangle covers becomes a Word hyperlink to that URL
//   pages       a page break between one page and the next, so the document reads page by page
//
// What is not written, because the model cannot give it safely: images (the model holds an image's place
// and size but not its pixels, and a picture is never invented or rasterized in its stead), colours, fonts,
// sizes, alignment, columns, lists, headers and footers, form fields and annotations. A page whose text was
// not read (a protected PDF) says so instead of being filled in. This is a faithful editable document, not
// a picture of the PDF, and it does not claim to be pixel-perfect.
//
//   documentDocx({ document, pages, tables, headings }) -> Uint8Array   the .docx bytes
//     document  { name, path, contentKey } as provenance's documentRef takes it
//     pages     the semantic pages to write, in order
//     tables    Map of page number -> the tables on it (semantic/tables.js pageTables().tables)
//     headings  Map of page number -> Map of exact block text -> heading level (1 = top), from the outline

import { documentRef } from '../semantic/provenance.js';
import { blockTables } from '../semantic/tables.js';
import { XML_DECLARATION, xmlText, zipArchive } from './zip.js';

const TWIPS = 20;              // a PDF point is 1/72 inch; a twip is 1/1440
const MAX_HEADING = 4;         // the deepest outline level that still has a Word heading style
const LETTER = [612, 792];
const LINK_SLACK = 1;          // a link's rectangle is usually drawn a shade around its text

const BOLD = new Set(['bold', 'black', 'heavy']);
const ITALIC = new Set(['italic', 'oblique']);

/**
 * Bold and italic as the PDF's own font name says them, and nothing more. The subset prefix is dropped and
 * the rest is split into words — on anything that isn't a letter, and where a lower-case letter meets a
 * capital — so "ABCDEF+TimesNewRomanPS-BoldItalicMT" is bold and italic while "Boldoni" is neither.
 */
export function runStyle(fontName) {
  const words = String(fontName ?? '')
    .replace(/^[A-Z]{6}\+/, '')
    .split(/[^A-Za-z]+/)
    .flatMap((part) => part.split(/(?<=[a-z])(?=[A-Z])/))
    .map((word) => word.toLowerCase());
  return { bold: words.some((w) => BOLD.has(w)), italic: words.some((w) => ITALIC.has(w)) };
}

const contains = (outer, inner) => Boolean(outer) && Boolean(inner)
  && inner[0] >= outer[0] - LINK_SLACK && inner[1] >= outer[1] - LINK_SLACK
  && inner[2] <= outer[2] + LINK_SLACK && inner[3] <= outer[3] + LINK_SLACK;

/** The link a run sits in, or null: the first whose own rectangle covers the run's box. */
const linkOf = (run, links) => links.find((link) => link.url && !link.internal && contains(link.box, run.box)) ?? null;

/** One run of text, with the little the font name vouches for. */
function runXml(text, { bold, italic }, { hyperlink = false } = {}) {
  const props = [hyperlink ? '<w:rStyle w:val="Hyperlink"/>' : '', bold ? '<w:b/>' : '', italic ? '<w:i/>' : ''].join('');
  return `<w:r>${props ? `<w:rPr>${props}</w:rPr>` : ''}<w:t xml:space="preserve">${xmlText(text)}</w:t></w:r>`;
}

const paragraphXml = (body, style = null) =>
  `<w:p>${style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : ''}${body}</w:p>`;

const PAGE_BREAK = '<w:p><w:r><w:br w:type="page"/></w:r></w:p>';

/**
 * A block's runs as Word runs, in the model's order, each hyperlinked where a link covers it. The lines of
 * a paragraph are joined by a space, as the Markdown export joins them, so a paragraph reads as one.
 */
function blockRuns(block, { runs, links, rels }) {
  const out = [];
  let previous = null;
  for (const id of block.runIds) {
    const run = runs.get(id);
    if (!run?.text) continue;
    const space = previous && !/\s$/.test(previous) && !/^\s/.test(run.text) ? ' ' : '';
    const style = runStyle(run.font);
    const link = linkOf(run, links);
    const body = runXml(space + run.text, style, { hyperlink: Boolean(link) });
    out.push(link ? `<w:hyperlink r:id="${rels.for(link.url)}">${body}</w:hyperlink>` : body);
    previous = run.text;
  }
  return out.join('');
}

/** The columns of a confident table, in twips, from the model's own cell boxes. */
function columnWidths(table) {
  const widths = [];
  for (let c = 0; c < table.columnCount; c++) {
    const boxes = table.rows.map((row) => row[c]?.box).filter(Boolean);
    const span = boxes.length ? Math.max(...boxes.map((b) => b[2])) - Math.min(...boxes.map((b) => b[0])) : 0;
    widths.push(Math.max(1, Math.round(span * TWIPS)));
  }
  return widths;
}

/** One confident table as a Word table of real cells. Empty cells stay empty; no borders are claimed. */
function tableXml(table) {
  const widths = columnWidths(table);
  const grid = widths.map((w) => `<w:gridCol w:w="${w}"/>`).join('');
  const rows = table.rows.map((row) => {
    const cells = row.map((cell, c) => {
      const text = cell?.text ? runXml(cell.text, { bold: false, italic: false }) : '';
      return `<w:tc><w:tcPr><w:tcW w:w="${widths[c]}" w:type="dxa"/></w:tcPr>${paragraphXml(text)}</w:tc>`;
    }).join('');
    return `<w:tr>${cells}</w:tr>`;
  }).join('');
  return `<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/></w:tblPr><w:tblGrid>${grid}</w:tblGrid>${rows}</w:tbl>`;
}

/** One page as Word body XML: its blocks in reading order, with its confident tables in their place. */
export function pageXml(page, { tables = [], headings = null, rels } = {}) {
  if (page.contentRead === false) {
    return paragraphXml(runXml('Vellum doesn’t read the text of a protected PDF, so this page has none here.', { bold: false, italic: true }));
  }
  const runs = new Map((page.runs ?? []).map((run) => [run.id, run]));
  const links = page.links ?? [];
  const tableOfBlock = blockTables(page, tables);
  const done = new Set();
  const out = [];
  for (const block of page.blocks ?? []) {
    const table = tableOfBlock.get(block.id);
    if (table) {
      if (done.has(table.id)) continue;
      done.add(table.id);
      out.push(tableXml(table));
      // Word wants a paragraph after a table, or the next one is swallowed into it.
      out.push(paragraphXml(''));
      continue;
    }
    if (!block.text.trim()) continue;
    const level = headings?.get(block.text.trim()) ?? null;
    out.push(paragraphXml(blockRuns(block, { runs, links, rels }), level ? `Heading${Math.min(MAX_HEADING, level)}` : null));
  }
  return out.join('');
}

/** Where this came from, in provenance's own terms, as the last paragraphs of the document. */
function sourceXml(ref, pages) {
  const numbers = pages.map((p) => p.number);
  const span = numbers.length ? `page${numbers.length === 1 ? '' : 's'} ${numbers[0]}${numbers.length > 1 ? `–${numbers.at(-1)}` : ''}` : 'no pages';
  const lines = [`Exported from ${ref.name || 'this document'} by Vellum — ${span}.`];
  if (ref.path) lines.push(ref.path);
  if (ref.contentKey) lines.push(`content ${ref.contentKey.slice(0, 12).toLowerCase()}… (the file as it was read)`);
  return lines.map((line) => paragraphXml(runXml(line, { bold: false, italic: true }))).join('');
}

/** The document's page size, from the first page Vellum read; a rotated page is as it is shown. */
function sectionXml(pages) {
  const box = pages.find((p) => Array.isArray(p.box))?.box ?? null;
  const turned = Math.abs((pages[0]?.rotate ?? 0) % 180) === 90;
  const [width, height] = box ? [box[2] - box[0], box[3] - box[1]] : LETTER;
  const [w, h] = turned ? [height, width] : [width, height];
  return `<w:sectPr><w:pgSz w:w="${Math.round(w * TWIPS)}" w:h="${Math.round(h * TWIPS)}"/></w:sectPr>`;
}

/** The relationships the document collects as it is written: the styles part, then one per link URL. */
function relationships() {
  const links = new Map();
  return {
    links,
    for(url) {
      if (!links.has(url)) links.set(url, `rId${links.size + 2}`);
      return links.get(url);
    },
    xml() {
      const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
      return `${XML_DECLARATION}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`
        + `<Relationship Id="rId1" Type="${REL}/styles" Target="styles.xml"/>`
        + [...links].map(([url, id]) => `<Relationship Id="${id}" Type="${REL}/hyperlink" Target="${xmlText(url)}" TargetMode="External"/>`).join('')
        + '</Relationships>';
    },
  };
}

// The styles the document refers to and nothing else: the headings the PDF's outline names, and the look
// Word gives a hyperlink. No style claims anything about the PDF's own type.
const HEADING_SIZES = [32, 28, 24, 22]; // half-points
const STYLES = `${XML_DECLARATION}<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">`
  + '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>'
  + HEADING_SIZES.map((size, i) => `<w:style w:type="paragraph" w:styleId="Heading${i + 1}"><w:name w:val="heading ${i + 1}"/>`
    + `<w:basedOn w:val="Normal"/><w:pPr><w:outlineLvl w:val="${i}"/></w:pPr>`
    + `<w:rPr><w:b/><w:sz w:val="${size}"/></w:rPr></w:style>`).join('')
  + '<w:style w:type="character" w:styleId="Hyperlink"><w:name w:val="Hyperlink"/>'
  + '<w:rPr><w:color w:val="0563C1"/><w:u w:val="single"/></w:rPr></w:style>'
  + '</w:styles>';

const CONTENT_TYPES = `${XML_DECLARATION}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">`
  + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
  + '<Default Extension="xml" ContentType="application/xml"/>'
  + '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
  + '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>'
  + '</Types>';

const ROOT_RELS = `${XML_DECLARATION}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`
  + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>';

/** The whole export as one Word document. Deterministic: the same pages always give the same bytes. */
export async function documentDocx({ document = {}, pages = [], tables = null, headings = null } = {}) {
  const ref = documentRef(document);
  const rels = relationships();
  const body = pages
    .map((page) => pageXml(page, { tables: tables?.get(page.number) ?? [], headings: headings?.get(page.number) ?? null, rels }))
    .join(PAGE_BREAK);
  const xml = `${XML_DECLARATION}<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" `
    + 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:body>'
    + body + sourceXml(ref, pages) + sectionXml(pages) + '</w:body></w:document>';

  return zipArchive([
    { name: '[Content_Types].xml', data: CONTENT_TYPES },
    { name: '_rels/.rels', data: ROOT_RELS },
    { name: 'word/document.xml', data: xml },
    { name: 'word/_rels/document.xml.rels', data: rels.xml() },
    { name: 'word/styles.xml', data: STYLES },
  ]);
}
