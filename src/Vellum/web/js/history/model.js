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

/** The snapshot kept of the current version just before another one is restored over it. */
export function beforeRestoreName(snapshot) {
  const name = `Before restoring “${snapshotLabel(snapshot)}”`;
  return name.length > 80 ? `${name.slice(0, 78)}…”` : name;
}
