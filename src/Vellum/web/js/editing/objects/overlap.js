// Overlap warnings: which other objects a gesture would put the moving objects on top of, so Edit mode
// can outline them while the hand is still moving. A warning only — nothing is refused because of it.
//
// Pure, in PDF user space. Objects are oriented quads (parallelograms), so two of them overlap unless
// some edge direction of one of them separates them (the separating axis test), which is exact for
// turned pictures and text at an angle alike. Only NEW overlaps count: a caption already printed over
// its picture is how the page was made, not something the gesture did.

/** How far two quads reach into each other along the axis where they overlap least, or 0 when apart. */
export function overlapDepth(a, b) {
  if (!a || !b || a.length < 8 || b.length < 8) return 0;
  let depth = Infinity;
  for (const quad of [a, b]) {
    for (let i = 0; i < 4; i++) {
      const j = (i + 1) % 4;
      const ex = quad[j * 2] - quad[i * 2];
      const ey = quad[j * 2 + 1] - quad[i * 2 + 1];
      const length = Math.hypot(ex, ey);
      if (!(length > 0)) continue;
      const nx = -ey / length;
      const ny = ex / length;
      const [a0, a1] = project(a, nx, ny);
      const [b0, b1] = project(b, nx, ny);
      const overlap = Math.min(a1, b1) - Math.max(a0, b0);
      if (overlap <= 0) return 0;
      depth = Math.min(depth, overlap);
    }
  }
  return Number.isFinite(depth) ? depth : 0;
}

function project(quad, nx, ny) {
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < 8; i += 2) {
    const d = quad[i] * nx + quad[i + 1] * ny;
    min = Math.min(min, d);
    max = Math.max(max, d);
  }
  return [min, max];
}

/**
 * The keys of the objects in `others` ([{ key, quad }]) that the moving objects cover where they are
 * going and did not cover where they were. `moving` is [{ key, from, to }], quads in user space; an
 * overlap shallower than `tolerance` (points) — lines whose boxes just touch — is not an overlap.
 */
export function newOverlaps(moving, others, tolerance = 0) {
  const keys = new Set(moving.map((m) => m.key));
  const found = [];
  for (const other of others) {
    if (keys.has(other.key) || !other.quad) continue;
    const covered = moving.some((m) => overlapDepth(m.to, other.quad) > tolerance && !(overlapDepth(m.from, other.quad) > tolerance));
    if (covered) found.push(other.key);
  }
  return found;
}
