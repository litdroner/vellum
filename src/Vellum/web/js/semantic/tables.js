// Table extraction V1: text tables read off one page of the semantic document model (semantic/model.js).
// Read-only, deterministic and local. It reads only what the model already holds — each text run's text and
// box, and whether paragraph grouping joined it into a paragraph — and never the content stream, pixels or
// anything else. Nothing here writes, edits, selects or renders.
//
// A table is reported only on strong evidence, and anything short of it is reported as not confidently
// detected instead of being guessed at:
//   - rows: horizontal runs that share a line (their boxes overlap by at least half the smaller height);
//     runs on a line close enough to be one cell (a gap of about a word space) are one cell, runs a
//     clear gutter apart (an em or more) are separate cells, and a gap in between makes the line ambiguous
//   - a table: at least 3 consecutive such lines, each with at least 2 cells, evenly enough spaced, and no
//     line of a paragraph among them (grouping joins running text; it leaves table cells alone)
//   - columns: the cells' horizontal extents, merged where they overlap, give at least 2 columns; no line
//     may put two cells in one column, every column is filled on at least half of the rows, the table is
//     at least three quarters full, the cells of each column line up (left, right or centre) and the cells
//     are short, not running text
// Not handled, by design: merged or spanning cells, nested tables, rotated or vertical text, tables drawn as
// pictures, and a table's ruling lines (only its text counts). Empty cells are null.
//
//   result    { page, tables, ambiguous }
//   table     { id, page, box, rowCount, columnCount, rows }       rows[r][c]: cell | null, top row first
//   cell      { row, column, text, box, runIds }                   runIds in reading order, left to right
//   ambiguous { page, box, rowCount, reason }                      a table-like region that wasn't confident

const MIN_ROWS = 3;
const MIN_COLUMNS = 2;
const JOIN_GAP = 0.35;    // em: runs this close on a line are one cell
const GUTTER = 1.0;       // em: runs at least this far apart are separate cells
const MAX_PITCH = 3.0;    // em: rows further apart than this aren't one table
const PITCH_DRIFT = 1.6;  // a row gap more than this times the table's smallest doesn't continue it
const MIN_FILL = 0.75;
const ALIGNED = 0.8;      // share of a column's cells that must share an edge or centre
const PROSE_WORDS = 7;    // a column whose typical cell has this many words is running text

/** The bounds of several boxes [x1, y1, x2, y2]. */
const unionBox = (boxes) => [Math.min(...boxes.map((b) => b[0])), Math.min(...boxes.map((b) => b[1])), Math.max(...boxes.map((b) => b[2])), Math.max(...boxes.map((b) => b[3]))];
const median = (list) => {
  const s = [...list].sort((a, b) => a - b);
  return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : 0;
};
const height = (box) => box[3] - box[1];
const centreY = (box) => (box[1] + box[3]) / 2;
const em = (run) => (Number.isFinite(run.size) && run.size > 0 ? Math.abs(run.size) : height(run.box));
const horizontal = (run) => !run.dir || (run.dir[0] > 0.9998 && Math.abs(run.dir[1]) < 0.02);

/** The runs a table can be made of: visible, horizontal, with text and a box. */
function candidates(page) {
  return page.runs.filter((r) => !r.invisible && r.text?.trim() && Array.isArray(r.box) && height(r.box) > 0 && horizontal(r));
}

/** Runs grouped into lines, top line first; each line's runs left to right. */
function lines(runs) {
  const sorted = [...runs].sort((a, b) => centreY(b.box) - centreY(a.box) || a.box[0] - b.box[0]);
  const out = [];
  for (const run of sorted) {
    const line = out[out.length - 1];
    const overlap = line ? Math.min(line.box[3], run.box[3]) - Math.max(line.box[1], run.box[1]) : 0;
    if (line && overlap >= 0.5 * Math.min(height(line.box), height(run.box))) {
      line.runs.push(run);
      line.box = unionBox([line.box, run.box]);
    } else {
      out.push({ runs: [run], box: run.box });
    }
  }
  for (const line of out) line.runs.sort((a, b) => a.box[0] - b.box[0]);
  return out;
}

/** A line's cells, or null when a gap on it is neither a word space nor a gutter. */
function cellsOf(line) {
  const cells = [];
  for (const run of line.runs) {
    const cell = cells[cells.length - 1];
    const gap = cell ? run.box[0] - cell.box[2] : Infinity;
    const size = cell ? Math.max(cell.em, em(run)) : em(run);
    if (gap < JOIN_GAP * size) {
      cell.runs.push(run);
      cell.box = unionBox([cell.box, run.box]);
      cell.em = size;
    } else if (gap >= GUTTER * size) {
      cells.push({ runs: [run], box: run.box, em: em(run) });
    } else {
      return null;
    }
  }
  return cells;
}

const cellText = (cell) => cell.runs.reduce((text, run, i) => {
  if (!i) return run.text.trim();
  const gap = run.box[0] - cell.runs[i - 1].box[2];
  const spaced = /\s$/.test(cell.runs[i - 1].text) || /^\s/.test(run.text) || gap > 0.1 * cell.em;
  return text + (spaced ? ' ' : '') + run.text.trim();
}, '');

/** A stack of candidate rows as { columns, grid } when it is a confident table, or why it is not one. */
function verdict(rows) {
  if (rows.length < MIN_ROWS) return 'too few rows';
  const spans = rows.flatMap((row) => row.cells.map((c) => [c.box[0], c.box[2]])).sort((a, b) => a[0] - b[0]);
  const columns = [];
  for (const [x1, x2] of spans) {
    const last = columns[columns.length - 1];
    if (last && x1 <= last[1]) last[1] = Math.max(last[1], x2);
    else columns.push([x1, x2]);
  }
  if (columns.length < MIN_COLUMNS) return 'fewer than two columns';
  const grid = [];
  for (const row of rows) {
    const slots = new Array(columns.length).fill(null);
    for (const cell of row.cells) {
      const c = columns.findIndex(([x1, x2]) => cell.box[0] >= x1 && cell.box[2] <= x2);
      if (slots[c]) return 'cells don’t line up in columns';
      slots[c] = cell;
    }
    grid.push(slots);
  }
  const filled = grid.flat().filter(Boolean).length;
  if (filled < MIN_FILL * rows.length * columns.length) return 'too many empty cells';
  for (let c = 0; c < columns.length; c++) {
    const cells = grid.map((slots) => slots[c]).filter(Boolean);
    if (cells.length < rows.length / 2) return 'a column is mostly empty';
    const tol = Math.max(2, 0.5 * median(cells.map((cell) => cell.em)));
    const lined = [(b) => b[0], (b) => b[2], (b) => (b[0] + b[2]) / 2].some((edge) => {
      const at = median(cells.map((cell) => edge(cell.box)));
      return cells.filter((cell) => Math.abs(edge(cell.box) - at) <= tol).length >= ALIGNED * cells.length;
    });
    if (!lined) return 'a column’s cells aren’t aligned';
    if (median(cells.map((cell) => cellText(cell).split(/\s+/).length)) >= PROSE_WORDS) return 'the cells read as running text';
  }
  return { columns, grid };
}

/** Consecutive table-like lines, split where the row spacing jumps. */
function stacks(rows) {
  const out = [];
  let stack = [];
  const close = () => { if (stack.length) out.push(stack); stack = []; };
  for (const row of rows) {
    if (!row.cells) { close(); continue; }
    const prev = stack[stack.length - 1];
    if (prev) {
      const size = Math.max(...prev.cells.map((c) => c.em), ...row.cells.map((c) => c.em));
      const pitch = centreY(prev.box) - centreY(row.box);
      const pitches = stack.slice(1).map((r, i) => centreY(stack[i].box) - centreY(r.box));
      const least = pitches.length ? Math.min(...pitches) : pitch;
      if (pitch > MAX_PITCH * size || pitch > PITCH_DRIFT * least || least > PITCH_DRIFT * pitch) close();
    }
    stack.push(row);
  }
  close();
  return out;
}

/**
 * The text tables on one page of the semantic model (semanticPage), and the table-like regions that were
 * not confident enough to report as tables. Pure. A page whose content wasn't read has neither.
 */
export function pageTables(page) {
  const result = { page: page.number, tables: [], ambiguous: [] };
  if (page.contentRead === false) return Object.freeze(result);
  const paragraphs = new Set(page.blocks.filter((b) => b.kind === 'paragraph').map((b) => b.id));
  const rows = lines(candidates(page)).map((line) => {
    const cells = line.runs.some((r) => paragraphs.has(r.blockId)) ? null : cellsOf(line);
    return { box: line.box, cells: cells && cells.length >= MIN_COLUMNS ? cells : null };
  });
  for (const stack of stacks(rows)) {
    const box = Object.freeze(unionBox(stack.map((r) => r.box)));
    const found = verdict(stack);
    if (typeof found === 'string') {
      if (stack.length >= 2) result.ambiguous.push(Object.freeze({ page: page.number, box, rowCount: stack.length, reason: found }));
      continue;
    }
    const table = found.grid.map((slots, r) => Object.freeze(slots.map((cell, c) => cell && Object.freeze({
      row: r,
      column: c,
      text: cellText(cell),
      box: Object.freeze(unionBox(cell.runs.map((run) => run.box))),
      runIds: Object.freeze(cell.runs.map((run) => run.id)),
    }))));
    result.tables.push(Object.freeze({
      id: `${page.id}:table:${table[0].find(Boolean).runIds[0].slice(page.id.length + 1)}`,
      page: page.number,
      box,
      rowCount: table.length,
      columnCount: found.columns.length,
      rows: Object.freeze(table),
    }));
  }
  result.tables = Object.freeze(result.tables);
  result.ambiguous = Object.freeze(result.ambiguous);
  return Object.freeze(result);
}

/** A table as tab-separated text, one line per row: what a spreadsheet pastes as cells. */
export function tableToTsv(table) {
  const clean = (text) => String(text ?? '').replace(/[\t\r\n]+/g, ' ');
  return table.rows.map((row) => row.map((cell) => clean(cell?.text)).join('\t')).join('\n');
}
