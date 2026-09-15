// Vellum 0.5.0 should-have: snapping while dragging.
//
// The arithmetic (editing/objects/snap.js) works in display axes and only adds to a move. Pinned here:
// an edge or centre within the tolerance lands exactly on the other line, the nearest line wins, each
// axis snaps on its own, nothing beyond the tolerance moves, the guides say where the lines are, and
// on a page turned by the file or the viewer the snap is to the line as it is shown.
// Run: node --test "tests/editing/*.test.mjs"

import test from 'node:test';
import assert from 'node:assert/strict';
import { engine } from './harness.mjs';

const { snapMove } = await engine('objects/snap.js');
const { quadBox, transformQuad, boxQuad } = await engine('objects/geometry.js');
const { applyLinear, invert, translate } = await engine('matrix.js');

const shift = (box, dx, dy) => [box[0] + dx, box[1] + dy, box[2] + dx, box[3] + dy];

test('an edge within the tolerance lands exactly on the other object’s edge, with a guide along it', () => {
  const other = [100, 100, 200, 150];
  // The dragged box's left edge is 3 points right of the other's left edge; nothing is near down.
  const box = [103, 300, 163, 340];
  const { dx, dy, guides } = snapMove(box, [other], 4);
  assert.deepEqual([dx, dy], [-3, 0]);
  assert.deepEqual(guides, [{ axis: 'x', at: 100, from: 100, to: 340 }], 'one vertical line, spanning both boxes');
  // Just beyond the tolerance: the move is left exactly as the hand made it, and nothing is drawn.
  assert.deepEqual(snapMove(shift(box, 1.5, 0), [other], 4), { dx: 0, dy: 0, guides: [] });
});

test('centres and opposite edges snap too, the nearest line wins, and each axis snaps on its own', () => {
  const other = [100, 100, 200, 150]; // centre (150, 125)
  // Centre 2 points right of the other's centre, top 1 point below the other's bottom edge.
  const box = [132, 151, 172, 181];
  const near = snapMove(box, [other], 5);
  assert.deepEqual([near.dx, near.dy], [-2, -1]);
  const after = shift(box, near.dx, near.dy);
  assert.equal((after[0] + after[2]) / 2, 150, 'centre on centre');
  assert.equal(after[1], 150, 'top edge on the other’s bottom edge');
  assert.deepEqual(near.guides.map((g) => [g.axis, g.at]), [['x', 150], ['y', 150]]);
  // Two candidates on one axis: the closer one decides, whichever target it belongs to.
  const far = [0, 0, 97, 20]; // right edge 97: 5 from the box's left edge at 102
  const close = [101, 400, 190, 420]; // left edge 101: 1 from it
  assert.equal(snapMove([102, 200, 140, 230], [far, close], 6).dx, -1);
  // Never more than the tolerance, whatever is further away.
  for (let x = -20; x <= 20; x += 0.25) {
    const { dx, dy } = snapMove(shift(box, x, 0), [other], 3);
    assert.ok(Math.abs(dx) <= 3 && Math.abs(dy) <= 3, `at ${x}: ${dx}, ${dy}`);
  }
});

test('the page’s edges and centre are lines like any other, and its guide runs the length of the page', () => {
  const page = [0, 0, 612, 792]; // centre (306, 396)
  const box = [255, 20, 353, 60]; // centre x 304
  const { dx, dy, guides } = snapMove(box, [page], 4);
  assert.deepEqual([dx, dy], [2, 0]);
  assert.deepEqual(guides, [{ axis: 'x', at: 306, from: 0, to: 792 }]);
  // Right up against the page's right edge.
  const edge = snapMove([500, 300, 609.5, 340], [page], 4);
  assert.equal(edge.dx, 2.5);
});

test('nothing to snap to, or something that isn’t a box, gives no snap at all', () => {
  const none = { dx: 0, dy: 0, guides: [] };
  assert.deepEqual(snapMove([0, 0, 10, 10], [], 4), none);
  assert.deepEqual(snapMove([0, 0, 10, 10], [[0, 0, Number.NaN, 5]], 4), none);
  assert.deepEqual(snapMove([0, 0, Number.NaN, 10], [[0, 0, 10, 10]], 4), none);
  assert.deepEqual(snapMove([10, 10, 0, 0], [[0, 0, 10, 10]], 4), none, 'an upside-down box');
  assert.deepEqual(snapMove([0, 0, 10, 10], 'not a list', 4), none);
  assert.deepEqual(snapMove([0, 0, 10, 10], [[0, 0, 10, 10]], Number.NaN), none);
  // A target that isn't a box is passed over; the ones that are still count.
  assert.equal(snapMove([2, 50, 12, 60], [null, [0, 0, 10, 10]], 4).dx, -2);
});

test('on a turned page the snap is to the line as it is shown, and only the move changes', () => {
  // A page shown a quarter turn clockwise (pdf.js's viewport for rotation 90, without zoom or offset):
  // display x is page y, display y is page x. A picture dragged so its on-screen left edge is 2 points
  // from another picture's.
  const shown = [0, 1, 1, 0, 0, 0];
  const back = invert(shown);
  const other = [100, 500, 200, 500, 200, 550, 100, 550];
  const picture = [300, 620, 360, 620, 360, 700, 300, 700];
  const pointer = [0, -118]; // the hand's move in user space: page y down 118, so on-screen left 118
  const [dx, dy] = applyLinear(shown, ...pointer);
  const moved = quadBox(transformQuad(picture, shown)).map((v, i) => v + (i % 2 ? dy : dx));
  const snap = snapMove(moved, [quadBox(transformQuad(other, shown))], 4);
  assert.deepEqual([snap.dx, snap.dy], [-2, 0], 'across the screen only');
  const move = translate(...applyLinear(back, dx + snap.dx, dy + snap.dy));
  const placed = transformQuad(picture, move);
  const leftOnScreen = (quad) => quadBox(transformQuad(quad, shown))[0];
  assert.equal(leftOnScreen(placed), leftOnScreen(other), 'the left edges a person sees meet exactly');
  assert.deepEqual([move[0], move[1], move[2], move[3]], [1, 0, 0, 1], 'still nothing but a move');
  assert.equal(quadBox(placed)[0], 300, 'which on this page moved nothing across the page’s own x');
  // Its guide, taken back to user space, runs along the page's own x axis: vertical on screen.
  const [g] = snap.guides;
  const ends = [applyLinear(back, g.at, g.from), applyLinear(back, g.at, g.to)];
  assert.equal(ends[0][1], ends[1][1], 'constant page y');
  assert.equal(ends[0][1], 500);
  assert.ok(boxQuad(quadBox(placed)), 'the placed picture is still a box');
});
