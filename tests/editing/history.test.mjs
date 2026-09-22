// Document history (history/model.js): how snapshots are named, ordered and sized in the history dialog.
// Settings → History (every document's history on this PC): its order, counts, sizes and missing documents.
// Taking, opening, comparing, restoring, deleting and clearing snapshots is proved in the app: tests/e2e/suites/history.mjs.
// Run: node --test "tests/editing/*.test.mjs"

import test from 'node:test';
import assert from 'node:assert/strict';
import { beforeRestoreName, formatSize, formatWhen, historySummary, missingDocuments, snapshotLabel, sortSnapshots, sortStored, storedLine, storedSummary, totalSize, withoutSnapshot } from '../../src/Vellum/web/js/history/model.js';

test('a snapshot is called by its name, or by when it was taken', () => {
  assert.equal(snapshotLabel({ name: 'Sent to legal', createdAt: '2026-09-17T10:00:00+02:00' }), 'Sent to legal');
  const unnamed = snapshotLabel({ name: '  ', createdAt: '2026-09-17T10:00:00+02:00' });
  assert.match(unnamed, /^Snapshot of /);
  assert.ok(unnamed.includes('2026'), unnamed);
  assert.equal(formatWhen('not a date'), '');
});

test('newest first, without changing the list it was given', () => {
  const list = [{ id: 'a', createdAt: '2026-09-01T10:00:00Z' }, { id: 'c', createdAt: '2026-09-17T10:00:00Z' }, { id: 'b', createdAt: '2026-09-10T10:00:00Z' }];
  assert.deepEqual(sortSnapshots(list).map((s) => s.id), ['c', 'b', 'a']);
  assert.deepEqual(list.map((s) => s.id), ['a', 'c', 'b']);
});

test('the version kept before a restore names the snapshot restored, within 80 characters', () => {
  assert.equal(beforeRestoreName({ name: 'Draft 2' }), 'Before restoring “Draft 2”');
  const long = beforeRestoreName({ name: 'x'.repeat(80) });
  assert.ok(long.length <= 80, String(long.length));
  assert.ok(long.startsWith('Before restoring “x'));
});

test('snapshot sizes read in B, KB, MB and GB', () => {
  assert.equal(formatSize(0), '0 B');
  assert.equal(formatSize(undefined), '0 B');
  assert.equal(formatSize(-5), '0 B');
  assert.equal(formatSize(812), '812 B');
  assert.equal(formatSize(1024), '1 KB');
  assert.equal(formatSize(1536), '1.5 KB');
  assert.equal(formatSize(20 * 1024), '20 KB');
  assert.equal(formatSize(4.2 * 1024 * 1024), '4.2 MB');
  assert.equal(formatSize(3 * 1024 ** 3), '3 GB');
});

test('the storage a history takes up is the sum of its snapshots, updated as they are deleted', () => {
  const list = [{ id: 'a', size: 1024 }, { id: 'b', size: 2048 }, { id: 'c', size: 'x' }];
  assert.equal(totalSize(list), 3072);
  assert.equal(historySummary(list), '3 snapshots · 3 KB on this PC');
  const after = withoutSnapshot(list, 'b');
  assert.deepEqual(after.map((s) => s.id), ['a', 'c']);
  assert.equal(list.length, 3);
  assert.equal(historySummary(after), '2 snapshots · 1 KB on this PC');
  assert.equal(historySummary(withoutSnapshot([{ id: 'a', size: 10 }], 'a')), '0 snapshots · 0 B on this PC');
  assert.equal(historySummary([{ id: 'a', size: 10 }]), '1 snapshot · 10 B on this PC');
});

test('every document’s history: most recent snapshot first, undated last, without changing the list', () => {
  const docs = [
    { key: 'A', lastSnapshot: '2026-09-01T10:00:00Z' },
    { key: 'B', lastSnapshot: null },
    { key: 'C', lastSnapshot: '2026-09-20T10:00:00Z' },
  ];
  assert.deepEqual(sortStored(docs).map((d) => d.key), ['C', 'A', 'B']);
  assert.deepEqual(docs.map((d) => d.key), ['A', 'B', 'C']);
});

test('the histories of documents no longer on disk are told apart', () => {
  const docs = [{ key: 'A', missing: false }, { key: 'B', missing: true }, { key: 'C' }];
  assert.deepEqual(missingDocuments(docs).map((d) => d.key), ['B']);
  assert.deepEqual(missingDocuments([]), []);
});

test('each history shows its snapshots, size and last snapshot; all of them add up', () => {
  const one = { key: 'A', count: 1, size: 2048, lastSnapshot: '2026-09-17T10:00:00Z' };
  const two = { key: 'B', count: 3, size: 3 * 1024 * 1024, lastSnapshot: '2026-09-18T10:00:00Z', missing: true };
  assert.ok(storedLine(one).startsWith('1 snapshot · 2 KB · last '), storedLine(one));
  assert.ok(storedLine(one).includes('2026'), storedLine(one));
  assert.equal(storedLine({ count: 4, size: 0 }), '4 snapshots · 0 B');
  assert.equal(storedSummary([one, two]), '2 documents · 4 snapshots · 3 MB on this PC');
  assert.equal(storedSummary([one]), '1 document · 1 snapshot · 2 KB on this PC');
  assert.equal(storedSummary([]), '0 documents · 0 snapshots · 0 B on this PC');
});
