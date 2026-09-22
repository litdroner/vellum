// Two-page spread reading: which pages share a spread, and where Previous / Next go.
//
// Spreads are laid out as pdf.js's SpreadMode.ODD lays them out: 1–2, 3–4, 5–6…, with the last page of
// an odd-length document alone. A turn is always a whole spread, from either page of it, and stops at
// the first and last spread. Only page numbers are involved: the layout never touches the file.
// Run: node --test "tests/editing/*.test.mjs"

import test from 'node:test';
import assert from 'node:assert/strict';
import { spreadStart, spreadPages, nextSpreadPage, previousSpreadPage } from '../../src/Vellum/web/js/spread.js';

test('each page belongs to the spread starting at its odd page', () => {
  assert.deepEqual([1, 2, 3, 4, 5, 6].map(spreadStart), [1, 1, 3, 3, 5, 5]);
});

test('pages pair up side by side; an odd count ends with one page alone', () => {
  assert.deepEqual(spreadPages(1, 5), [1, 2]);
  assert.deepEqual(spreadPages(4, 5), [3, 4]);
  assert.deepEqual(spreadPages(5, 5), [5]);
  assert.deepEqual(spreadPages(6, 6), [5, 6]);
  assert.deepEqual(spreadPages(1, 1), [1]);
});

test('Next goes to the next spread from either of its pages, and stops at the last', () => {
  assert.equal(nextSpreadPage(1, 5), 3);
  assert.equal(nextSpreadPage(2, 5), 3);
  assert.equal(nextSpreadPage(4, 5), 5);
  assert.equal(nextSpreadPage(5, 5), null); // odd count: the last page alone
  assert.equal(nextSpreadPage(5, 6), null); // even count: the last pair
  assert.equal(nextSpreadPage(6, 6), null);
  assert.equal(nextSpreadPage(1, 2), null);
  assert.equal(nextSpreadPage(1, 1), null);
});

test('Previous goes to the previous spread from either of its pages, and stops at the first', () => {
  assert.equal(previousSpreadPage(5), 3);
  assert.equal(previousSpreadPage(4), 1);
  assert.equal(previousSpreadPage(3), 1);
  assert.equal(previousSpreadPage(2), null);
  assert.equal(previousSpreadPage(1), null);
});

test('turning through a whole document visits every spread once, both ways', () => {
  for (const count of [1, 2, 5, 6, 9]) {
    const forward = [1];
    for (let p = nextSpreadPage(1, count); p; p = nextSpreadPage(p, count)) forward.push(p);
    assert.deepEqual(forward, Array.from({ length: Math.ceil(count / 2) }, (_, i) => i * 2 + 1), `${count} pages`);
    const back = [spreadStart(count)];
    for (let p = previousSpreadPage(count); p; p = previousSpreadPage(p)) back.push(p);
    assert.deepEqual(back, [...forward].reverse(), `${count} pages, backwards`);
  }
});
