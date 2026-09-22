// Export Center — PDF to Excel. Pure: it writes out the tables Vellum is already confident about and
// nothing else.
//
// The tables are table extraction's (semantic/tables.js) over the semantic document model
// (semantic/model.js). There is no second table parser here, no OCR, no picture of a table read back, and
// nothing about a table is inferred: the rows and columns are the extraction's, in its order, and a region
// the extraction was not confident about is left out and named on the last sheet instead of being guessed
// at. Merged and spanning cells are not something the extraction reports, so none are written.
//
// Every confident table becomes one worksheet of real Excel cells — never an image. A cell holds its text
// as text unless the text is unambiguously a number (see `cellNumber`), because a part code, a phone number
// or a version is not a quantity. An empty cell is written as an empty cell, so a row keeps its shape.
//
//   tablesWorkbook({ document, pages }) -> Uint8Array   the .xlsx bytes
//     document  { name, path, contentKey } as provenance's documentRef takes it
//     pages     [{ page, tables, ambiguous }] in page order — semantic/tables.js pageTables() results
//
// Worksheet names are deterministic: "Page 4" for a page with one table, "Page 4 table 1", "Page 4 table 2"
// for a page with more. The same document and pages always give the same workbook, byte for byte.

import { documentRef } from '../semantic/provenance.js';
import { describePageNumbers } from './model.js';
import { XML_DECLARATION, xmlText, zipArchive } from './zip.js';

const NOTES_SHEET = 'About this export';
const MAX_DIGITS = 15; // more digits than a spreadsheet number keeps exactly

/**
 * A cell's text as a number, or null when reading it as one would change or lose what it says. Only a plain
 * decimal counts, and only when it survives the round trip — so "007", "1.50", "1,200", "+3", "1e4",
 * "12%" and "£5" all stay text.
 */
export function cellNumber(text) {
  const value = String(text ?? '').trim();
  if (!/^-?(0|[1-9]\d*)(\.\d+)?$/.test(value)) return null;
  if (value.replace(/[^\d]/g, '').length > MAX_DIGITS) return null;
  const number = Number(value);
  return Number.isFinite(number) && String(number) === value ? number : null;
}

/** "A", "B" … "AA": a zero-based column's letters, as a spreadsheet writes them. */
export function columnLetters(index) {
  let out = '';
  for (let n = index; n >= 0; n = Math.floor(n / 26) - 1) out = String.fromCharCode(65 + (n % 26)) + out;
  return out;
}

/**
 * The worksheets a set of pages' tables becomes, in order: one per confident table, named for its page.
 * `rows` are arrays of cell text (null for an empty cell), top row first.
 */
export function workbookSheets(pages) {
  const sheets = [];
  for (const result of pages ?? []) {
    const tables = result?.tables ?? [];
    for (const [index, table] of tables.entries()) {
      sheets.push({
        name: tables.length > 1 ? `Page ${result.page} table ${index + 1}` : `Page ${result.page}`,
        page: result.page,
        rows: table.rows.map((row) => row.map((cell) => (cell ? cell.text : null))),
      });
    }
  }
  return sheets;
}

/** One worksheet: real cells, in the table's own row and column order, empty cells kept. */
export function worksheetXml(rows) {
  const cells = (row, r) => row.map((text, c) => {
    const ref = `${columnLetters(c)}${r + 1}`;
    if (text == null || text === '') return `<c r="${ref}"/>`;
    const number = cellNumber(text);
    return number === null
      ? `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${xmlText(text)}</t></is></c>`
      : `<c r="${ref}"><v>${number}</v></c>`;
  }).join('');
  const body = rows.map((row, r) => `<row r="${r + 1}">${cells(row, r)}</row>`).join('');
  return `${XML_DECLARATION}<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${body}</sheetData></worksheet>`;
}

/** The last sheet: where this came from, and every table-like region that was not confident enough to write. */
function notesRows(ref, pages) {
  const numbers = (pages ?? []).map((p) => p.page);
  const tables = (pages ?? []).reduce((n, p) => n + (p.tables?.length ?? 0), 0);
  const rows = [
    ['Exported from', ref.name || 'this document'],
    ...(ref.path ? [['File', ref.path]] : []),
    ...(ref.contentKey ? [['Content', `${ref.contentKey.slice(0, 12).toLowerCase()}… (the file as it was read)`]] : []),
    ['Pages', numbers.length ? describePageNumbers(numbers) : 'none'],
    ['Tables', String(tables)],
  ];
  const skipped = (pages ?? []).flatMap((p) => (p.ambiguous ?? []).map((a) => [`Page ${a.page}`, `${a.rowCount} rows not written — ${a.reason}`]));
  if (skipped.length) rows.push([null, null], ['Not confidently a table', null], ...skipped);
  return rows;
}

const CONTENT_TYPES = (sheetCount) => `${XML_DECLARATION}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">`
  + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
  + '<Default Extension="xml" ContentType="application/xml"/>'
  + '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
  + Array.from({ length: sheetCount }, (_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet"/>`).join('')
  + '</Types>';

const ROOT_RELS = `${XML_DECLARATION}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`
  + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>';

/**
 * The workbook for a document's confident tables. Throws when there are none, so an export of a document
 * without tables says so and writes no file rather than a spreadsheet with nothing in it.
 */
export async function tablesWorkbook({ document = {}, pages = [] } = {}) {
  const ref = documentRef(document);
  const sheets = workbookSheets(pages);
  if (!sheets.length) {
    throw new Error('Vellum didn’t confidently find a table on the pages chosen, so there is no spreadsheet to write.');
  }
  const all = [...sheets, { name: NOTES_SHEET, page: null, rows: notesRows(ref, pages) }];
  const workbook = `${XML_DECLARATION}<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" `
    + 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>'
    + all.map((s, i) => `<sheet name="${xmlText(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')
    + '</sheets></workbook>';
  const rels = `${XML_DECLARATION}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`
    + all.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')
    + '</Relationships>';

  return zipArchive([
    { name: '[Content_Types].xml', data: CONTENT_TYPES(all.length) },
    { name: '_rels/.rels', data: ROOT_RELS },
    { name: 'xl/workbook.xml', data: workbook },
    { name: 'xl/_rels/workbook.xml.rels', data: rels },
    ...all.map((sheet, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, data: worksheetXml(sheet.rows) })),
  ]);
}
