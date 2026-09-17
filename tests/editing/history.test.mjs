// Document history (history/model.js): how snapshots are named and ordered in the history dialog.
// Taking, opening, comparing, restoring and deleting snapshots is proved in the app: tests/e2e/suites/history.mjs.
// Run: node --test "tests/editing/*.test.mjs"

import test from 'node:test';
import assert from 'node:assert/strict';
import { beforeRestoreName, formatWhen, snapshotLabel, sortSnapshots } from '../../src/Vellum/web/js/history/model.js';

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
