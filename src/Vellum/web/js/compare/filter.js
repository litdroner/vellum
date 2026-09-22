// PDF Compare V1.1: showing one type of change at a time. A view over the change list (compare/diff.js
// rowChanges), apart from any UI so it runs in Node tests too; the comparison itself is unchanged.
//
//   changeTone(change)                 'added' | 'removed' | 'changed' | 'moved' (text and page changes alike)
//   shows(filter, change)              whether a filter ('all' or a tone) shows a change
//   countByFilter(changes)             how many changes each filter shows
//   stepChange(changes, i, delta, f)   the next (1) or previous (-1) shown change after i, wrapping; -1 if none
//   positionOf(changes, i, f)          { at: i's place among the shown changes (1-based, 0 if not shown), total }

export const FILTERS = [['all', 'All'], ['added', 'Added'], ['removed', 'Removed'], ['changed', 'Changed'], ['moved', 'Moved']];

export const changeTone = (change) => change.kind.slice(change.kind.indexOf('-') + 1);

export const shows = (filter, change) => filter === 'all' || changeTone(change) === filter;

export function countByFilter(changes) {
  const counts = Object.fromEntries(FILTERS.map(([id]) => [id, 0]));
  for (const change of changes) {
    counts.all++;
    counts[changeTone(change)]++;
  }
  return counts;
}

export function stepChange(changes, index, delta, filter = 'all') {
  const n = changes.length;
  if (!n) return -1;
  const from = index < 0 ? (delta > 0 ? -1 : 0) : index;
  for (let k = 1; k <= n; k++) {
    const j = (((from + delta * k) % n) + n) % n;
    if (shows(filter, changes[j])) return j;
  }
  return -1;
}

export function positionOf(changes, index, filter = 'all') {
  let total = 0;
  let at = 0;
  changes.forEach((change, i) => {
    if (!shows(filter, change)) return;
    total++;
    if (i === index) at = total;
  });
  return { at, total };
}
