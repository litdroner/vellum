// Document history (history/model.js): how snapshots are named, ordered and sized in the history dialog.
// Taking, opening, comparing, restoring, deleting and clearing snapshots is proved in the app: tests/e2e/suites/history.mjs.
// Run: node --test "tests/editing/*.test.mjs"

import test from 'node:test';
import assert from 'node:assert/strict';
import { beforeRestoreName, formatSize, formatWhen, historySummary, snapshotLabel, sortSnapshots, totalSize, withoutSnapshot } from '../../src/Vellum/web/js/history/model.js';

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
