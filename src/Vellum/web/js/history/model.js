// Document history: the words and order the history dialog shows. No I/O: snapshots themselves are kept
// by the host (Services/DocumentHistory.cs), on this PC only.

const WHEN = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });

/** "12 Sep 2026, 14:03" */
export function formatWhen(createdAt) {
  const date = new Date(createdAt);
  return Number.isNaN(date.getTime()) ? '' : WHEN.format(date);
}

/** What a snapshot is called: its name, or when it was taken. */
export function snapshotLabel(snapshot) {
  return snapshot.name?.trim() || `Snapshot of ${formatWhen(snapshot.createdAt)}`;
}

/** Newest first. */
export function sortSnapshots(snapshots) {
  return [...snapshots].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

/** "0 B", "812 KB", "4.2 MB": sizes in 1024s, one decimal below 10. */
export function formatSize(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = n;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++; }
  if (unit === 0) return `${Math.round(value)} B`;
  return `${value < 10 ? value.toFixed(1).replace(/\.0$/, '') : Math.round(value)} ${units[unit]}`;
}

/** The storage a document's history takes up: the sum of its snapshots' sizes. */
export function totalSize(snapshots) {
  return snapshots.reduce((sum, s) => sum + (Number(s.size) > 0 ? Number(s.size) : 0), 0);
}

/** "3 snapshots · 4.2 MB on this PC" */
export function historySummary(snapshots) {
  const count = snapshots.length;
  return `${count} snapshot${count === 1 ? '' : 's'} · ${formatSize(totalSize(snapshots))} on this PC`;
}

/** The list once a snapshot is deleted. */
export function withoutSnapshot(snapshots, id) {
  return snapshots.filter((s) => s.id !== id);
}

/** The snapshot kept of the current version just before another one is restored over it. */
export function beforeRestoreName(snapshot) {
  const name = `Before restoring “${snapshotLabel(snapshot)}”`;
  return name.length > 80 ? `${name.slice(0, 78)}…”` : name;
}
