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

// ---- every document's history (Settings) ----------------------------------------------------
// A stored history (from the host): { key, path, name, count, size, lastSnapshot, missing }.

/** Most recent snapshot first; histories with no date last. */
export function sortStored(documents) {
  const time = (d) => { const t = new Date(d.lastSnapshot ?? NaN).getTime(); return Number.isNaN(t) ? -Infinity : t; };
  return [...documents].sort((a, b) => time(b) - time(a));
}

/** The histories whose document is no longer on disk: they can only be removed. */
export function missingDocuments(documents) {
  return documents.filter((d) => d.missing);
}

/** "3 snapshots · 4.2 MB · last 12 Sep 2026, 14:03" */
export function storedLine(doc) {
  const count = Number(doc.count) || 0;
  const when = doc.lastSnapshot ? formatWhen(doc.lastSnapshot) : '';
  return `${count} snapshot${count === 1 ? '' : 's'} · ${formatSize(doc.size)}${when ? ` · last ${when}` : ''}`;
}

/** "2 documents · 9 snapshots · 12 MB on this PC" */
export function storedSummary(documents) {
  const n = documents.length;
  const snapshots = documents.reduce((sum, d) => sum + (Number(d.count) || 0), 0);
  return `${n} document${n === 1 ? '' : 's'} · ${snapshots} snapshot${snapshots === 1 ? '' : 's'} · ${formatSize(totalSize(documents))} on this PC`;
}
