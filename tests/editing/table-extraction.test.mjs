// Table extraction V1 (semantic/tables.js): text tables read off the semantic document model. Pinned here:
// a real table's rows, columns and cells in order with their page and boxes; and the layouts that must not
// be taken for tables — running text, two columns of prose, a 2 × 2 block, cells that don't line up —
// reported as not confident, or not at all, instead of guessed.
// Run: node --test tests/editing/table-extraction.test.mjs

import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeFile, loadPdfLib, openWithPdfjs, webModule } from './harness.mjs';

const { readSemanticPage } = await webModule('semantic/model.js');
const { pageTables, tableToTsv } = await webModule('semantic/tables.js');

/** A page of the model from lines of [x, y, text] (Helvetica 11 unless a size is given), one text object each. */
async function pdfOf(pages) {
  const { PDFDocument, StandardFonts } = await loadPdfLib();
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const lines of pages) {
    const page = doc.addPage([612, 792]);
    for (const [x, y, text, size = 11] of lines) page.drawText(text, { x, y, size, font });
  }
  return doc.save({ useObjectStreams: false });
}

async function modelPages(bytes) {
  const { pages } = await analyzeFile(bytes);
  const js = await openWithPdfjs(bytes);
  try {
    const out = [];
    for (const analysis of pages) out.push(await readSemanticPage(analysis, await js.doc.getPage(analysis.page + 1)));
    return out;
  } finally {
    await js.close();
  }
}

// Page 1: a heading, a paragraph, a 4 × 3 price table (numbers right-aligned), and a closing line.
// Page 2: a second table, 3 × 3, with one empty cell.
const TABLE = [
  [72, 740, 'Quarterly order summary', 16],
  [72, 712, 'This short paragraph introduces the table below and runs on'],
  [72, 698, 'to a second line so that grouping joins it into a paragraph.'],
  [72, 660, 'Item'], [220, 660, 'Quantity'], [340, 660, 'Price'],
  [72, 644, 'Pencils'], [220, 644, '120'], [340, 644, '$4.80'],
  [72, 628, 'Notebooks'], [220, 628, '35'], [340, 628, '$52.50'],
  [72, 612, 'Erasers'], [220, 612, '8'], [340, 612, '$1.20'],
  [72, 560, 'Totals are before tax.'],
];
const SECOND = [
  [100, 700, 'Region'], [260, 700, 'Owner'], [400, 700, 'Units'],
  [100, 684, 'North'], [260, 684, 'Avery'], [400, 684, '12'],
  [100, 668, 'South'], [400, 668, '9'],
];

let tablePages;
before(async () => { tablePages = await modelPages(await pdfOf([TABLE, SECOND])); });

test('a simple table: rows top down, columns left to right, every cell with its text and box', () => {
  const { page, tables, ambiguous } = pageTables(tablePages[0]);
  assert.equal(page, 1);
  assert.equal(tables.length, 1, 'one table, and the heading, paragraph and closing line are not in it');
  assert.equal(ambiguous.length, 0);
  const [table] = tables;
  assert.equal(table.rowCount, 4);
  assert.equal(table.columnCount, 3);
  assert.deepEqual(table.rows.map((row) => row.map((c) => c.text)), [
    ['Item', 'Quantity', 'Price'],
    ['Pencils', '120', '$4.80'],
    ['Notebooks', '35', '$52.50'],
    ['Erasers', '8', '$1.20'],
  ]);
  for (const [r, row] of table.rows.entries()) {
    for (const [c, cell] of row.entries()) {
      assert.equal(cell.row, r);
      assert.equal(cell.column, c);
      assert.equal(cell.runIds.length, 1);
      assert.ok(cell.runIds[0].startsWith('p1:'), 'cells point at the page’s own runs');
      assert.ok(tablePages[0].runs.some((run) => run.id === cell.runIds[0] && run.text.trim() === cell.text));
      assert.ok(cell.box[0] >= table.box[0] - 0.01 && cell.box[2] <= table.box[2] + 0.01 && cell.box[1] >= table.box[1] - 0.01 && cell.box[3] <= table.box[3] + 0.01);
    }
    if (r) assert.ok(row[0].box[3] < table.rows[r - 1][0].box[3], 'each row sits below the one before');
    assert.ok(row[0].box[2] < row[1].box[0] && row[1].box[2] < row[2].box[0], 'columns left to right');
  }
  assert.equal(tableToTsv(table), 'Item\tQuantity\tPrice\nPencils\t120\t$4.80\nNotebooks\t35\t$52.50\nErasers\t8\t$1.20');
  assert.equal(pageTables(tablePages[0]).tables[0].id, table.id, 'the same page gives the same table id');
});

test('page association: each page reports its own table; an empty cell is null', () => {
  const second = pageTables(tablePages[1]);
  assert.equal(second.page, 2);
  assert.equal(second.tables.length, 1);
  const [table] = second.tables;
  assert.equal(table.page, 2);
  assert.ok(table.id.startsWith('p2:table:'));
  assert.notEqual(table.id, pageTables(tablePages[0]).tables[0].id);
  assert.deepEqual(table.rows.map((row) => row.map((c) => c?.text ?? null)), [['Region', 'Owner', 'Units'], ['North', 'Avery', '12'], ['South', null, '9']]);
  assert.equal(tableToTsv(table), 'Region\tOwner\tUnits\nNorth\tAvery\t12\nSouth\t\t9');
  assert.ok(table.rows.flat().filter(Boolean).every((c) => c.runIds.every((id) => id.startsWith('p2:'))));
});

test('not tables: prose, two columns of prose, a 2 × 2 block and cells out of line are not taken for tables', async () => {
  const prose = [
    [72, 700, 'An ordinary paragraph of running text that goes on'],
    [72, 686, 'for a few lines, the way a letter or a report would,'],
    [72, 672, 'with nothing in it laid out in rows or in columns.'],
  ];
  // Two columns of prose, each line on its own at a different width so paragraph grouping may leave them.
  const columns = [];
  const left = ['Rivers carry the snow melt down to the plains every spring', 'and farmers along the banks wait for it with their seed', 'while the towns downstream build their walls a little higher', 'in case the water comes up faster than it did the last time'];
  const right = ['The market opens early on those mornings and closes late', 'because everyone who comes in from the hills has news to trade', 'and nobody wants to be the last to hear what the river did', 'or whose fields were lost and whose were saved this year'];
  for (let i = 0; i < 4; i++) columns.push([40, 500 - 14 * i, left[i], 9], [320, 500 - 14 * i, right[i], 9]);
  const small = [[72, 300, 'Cell A1'], [200, 300, 'Cell B1'], [72, 286, 'Cell A2'], [200, 286, 'Cell B2']];
  // Three rows of two pieces each, but the pieces wander: no column has its cells lined up.
  const scattered = [[72, 200, 'North'], [180, 200, 'Avery'], [140, 186, 'South'], [300, 186, 'Blake'], [90, 172, 'East'], [410, 172, 'Casey']];
  const pages = await modelPages(await pdfOf([prose, columns, [...small, ...scattered]]));

  assert.deepEqual(pageTables(pages[0]), { page: 1, tables: [], ambiguous: [] }, 'running text: nothing table-like at all');
  const two = pageTables(pages[1]);
  assert.equal(two.tables.length, 0, 'two columns of prose are not a table');
  const mixed = pageTables(pages[2]);
  assert.equal(mixed.tables.length, 0);
  assert.equal(mixed.ambiguous.length, 2, 'both are reported as not confidently detected');
  assert.equal(mixed.ambiguous[0].reason, 'too few rows');
  assert.notEqual(mixed.ambiguous[1].reason, 'too few rows', 'three rows, but the columns don’t hold');
  for (const a of [...two.ambiguous, ...mixed.ambiguous]) assert.ok(a.box && a.rowCount >= 2 && a.reason);
});

test('a page whose content was not read (a protected PDF) has no tables', () => {
  assert.deepEqual(pageTables({ ...tablePages[0], contentRead: false }), { page: 1, tables: [], ambiguous: [] });
});
