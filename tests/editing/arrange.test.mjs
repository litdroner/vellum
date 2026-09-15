// Vellum 0.5.0 should-haves: lining several objects up, and spacing them evenly.
//
// The arithmetic (editing/objects/arrange.js) works in display axes and gives each object a move;
// the session writes those moves like any other gesture, as one undo step. Pinned here: every edge and
// centre lines up exactly, even spacing keeps the outermost objects still and makes every gap equal,
// nothing but moves ever comes out, and a page turned by the file or the viewer is lined up as it is
// shown. The saved file then holds the objects exactly there.
// Run: node --test "tests/editing/*.test.mjs"

import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { engine, webModule, analyzeFile, withSession } from './harness.mjs';
import { makeFixtures, FIXTURE_DIR } from './fixtures.mjs';

const { ALIGNMENTS, DISTRIBUTIONS, MINIMUM, alignMoves, distributeMoves } = await engine('objects/arrange.js');
const { quadBox, transformQuad } = await engine('objects/geometry.js');
const { objectsOf } = await engine('objects/page-objects.js');
const { applyLinear, invert, translate } = await engine('matrix.js');
const { composeDocument } = await webModule('annotations/persist.js');

let files;
before(async () => { files = await makeFixtures(FIXTURE_DIR); });
const read = (name) => new Uint8Array(fs.readFileSync(files[name]));

const boxes = () => [
  { key: 'a', box: [10, 10, 40, 30] },
  { key: 'b', box: [60, 50, 80, 90] },
  { key: 'c', box: [25, 100, 95, 120] },
];
const moved = (list, moves) => list.map(({ key, box }) => {
  const m = moves.find((x) => x.key === key);
  return { key, box: [box[0] + m.dx, box[1] + m.dy, box[2] + m.dx, box[3] + m.dy] };
});
const near = (a, b, tol = 1e-9) => Math.abs(a - b) <= tol;

// ---- 1. the arithmetic ---------------------------------------------------------------------------

test('each alignment lines every box up on one edge or centre of the box around them, moving one way only', () => {
  const at = {
    left: (b) => b[0], right: (b) => b[2], center: (b) => (b[0] + b[2]) / 2,
    top: (b) => b[1], bottom: (b) => b[3], middle: (b) => (b[1] + b[3]) / 2,
  };
  const want = { left: 10, right: 95, center: 52.5, top: 10, bottom: 120, middle: 65 };
  for (const alignment of ALIGNMENTS) {
    const moves = alignMoves(boxes(), alignment);
    assert.deepEqual(moves.map((m) => m.key), ['a', 'b', 'c'], 'one move per box, in the order given');
    const across = ['left', 'center', 'right'].includes(alignment);
    assert.ok(moves.every((m) => (across ? m.dy === 0 : m.dx === 0)), `${alignment} moves ${across ? 'across' : 'down'} only`);
    for (const { box } of moved(boxes(), moves)) assert.ok(near(at[alignment](box), want[alignment]), `${alignment}: ${box}`);
  }
});

test('boxes already lined up get moves of exactly zero', () => {
  const lined = [{ key: 'a', box: [10, 0, 20, 5] }, { key: 'b', box: [10, 20, 40, 25] }];
  assert.deepEqual(alignMoves(lined, 'left').map((m) => [m.dx, m.dy]), [[0, 0], [0, 0]]);
});

test('spacing evenly keeps the first and last in place and makes every gap the same', () => {
  const list = [
    { key: 'far', box: [200, 0, 230, 10] },
    { key: 'near', box: [0, 0, 20, 10] },
    { key: 'mid1', box: [30, 0, 70, 10] },
    { key: 'mid2', box: [150, 0, 160, 10] },
  ];
  const moves = distributeMoves(list, 'horizontal');
  assert.deepEqual(moves.map((m) => m.key), ['far', 'near', 'mid1', 'mid2'], 'in the order given');
  assert.ok(moves.every((m) => m.dy === 0), 'across only');
  const after = moved(list, moves).sort((p, q) => p.box[0] - q.box[0]);
  assert.deepEqual([after[0].key, after.at(-1).key], ['near', 'far']);
  assert.deepEqual([after[0].box[0], after.at(-1).box[2]], [0, 230], 'the outermost stay exactly where they were');
  const gaps = after.slice(1).map((b, i) => b.box[0] - after[i].box[2]);
  assert.ok(gaps.every((g) => near(g, gaps[0], 1e-9)), `equal gaps: ${gaps}`);
  assert.ok(near(gaps[0], (230 - 0 - (20 + 40 + 10 + 30)) / 3));
  // Down the page, the same rule on the other axis.
  const down = distributeMoves(boxes(), 'vertical');
  assert.ok(down.every((m) => m.dx === 0));
  const col = moved(boxes(), down).sort((p, q) => p.box[1] - q.box[1]);
  const vgaps = col.slice(1).map((b, i) => b.box[1] - col[i].box[3]);
  assert.ok(near(vgaps[0], vgaps[1]), `equal vertical gaps: ${vgaps}`);
});

test('overlapping boxes get equal overlaps, and ties keep the order they came in', () => {
  const list = [{ key: 'a', box: [0, 0, 50, 10] }, { key: 'b', box: [10, 0, 60, 10] }, { key: 'c', box: [20, 0, 70, 10] }, { key: 'd', box: [20, 0, 70, 10] }];
  const after = moved(list, distributeMoves(list, 'horizontal'));
  const byKey = Object.fromEntries(after.map((b) => [b.key, b.box]));
  assert.deepEqual([byKey.a[0], byKey.d[2]], [0, 70], 'the first and the last by centre (the later of a tie) stay');
  const order = ['a', 'b', 'c', 'd'];
  const gaps = order.slice(1).map((k, i) => byKey[k][0] - byKey[order[i]][2]);
  assert.ok(gaps.every((g) => near(g, gaps[0])) && gaps[0] < 0, `equal overlaps: ${gaps}`);
});

test('too few boxes, a box that isn’t one, or an arrangement that isn’t one gives nothing', () => {
  assert.deepEqual([MINIMUM.align, MINIMUM.distribute], [2, 3]);
  assert.equal(alignMoves(boxes().slice(0, 1), 'left'), null);
  assert.equal(distributeMoves(boxes().slice(0, 2), 'horizontal'), null);
  assert.equal(alignMoves(boxes(), 'diagonal'), null);
  assert.equal(distributeMoves(boxes(), 'sideways'), null);
  assert.equal(alignMoves([...boxes(), { key: 'bad', box: [0, 0, Number.NaN, 1] }], 'left'), null);
  assert.equal(alignMoves([...boxes(), { key: 'upside-down', box: [10, 10, 0, 0] }], 'left'), null);
  assert.equal(alignMoves('not a list', 'left'), null);
  assert.deepEqual([...DISTRIBUTIONS], ['horizontal', 'vertical']);
});

// ---- 2. as the page is shown ---------------------------------------------------------------------------

test('on a turned page, “left” is the left a person sees', () => {
  // A page shown turned a quarter clockwise: display x is page y, display y is page x (as pdf.js's
  // viewport has it for rotation 90, without zoom or offset).
  const shown = [0, 1, 1, 0, 0, 0];
  const back = invert(shown);
  const quads = { a: [100, 500, 200, 500, 200, 550, 100, 550], b: [300, 620, 360, 620, 360, 700, 300, 700] };
  const list = Object.entries(quads).map(([key, quad]) => ({ key, box: quadBox(transformQuad(quad, shown)) }));
  const moves = alignMoves(list, 'left');
  const after = Object.fromEntries(moves.map(({ key, dx, dy }) => {
    const [ux, uy] = applyLinear(back, dx, dy);
    return [key, transformQuad(quads[key], translate(ux, uy))];
  }));
  const leftOnScreen = (quad) => quadBox(transformQuad(quad, shown))[0];
  assert.ok(near(leftOnScreen(after.a), leftOnScreen(after.b)), 'lined up on the screen’s left');
  assert.equal(quadBox(after.a)[0], 100, 'which on this page moved nothing across the page’s own x');
  assert.equal(quadBox(after.b)[0], 300);
});

// ---- 3. through the session, into the file ---------------------------------------------------------------

test('lined up through the session: one record per object, one undo step, and the saved file has them there', async () => {
  await withSession(read('images'), async ({ bytes, plan, store, session }) => {
    const { objects } = await session.objects(1);
    const movable = objects.filter((o) => o.capabilities.move === true);
    const shown = [1, 0, 0, -1, 0, 0]; // an upright page: y downwards on screen
    const back = invert(shown);
    const list = movable.map((o) => ({ key: o.ref.key, box: quadBox(transformQuad(o.geometry.quad, shown)) }));
    const moves = alignMoves(list, 'right');
    const deltas = moves.map(({ key, dx, dy }) => ({ key, delta: translate(...applyLinear(back, dx, dy)) }));
    assert.equal(await session.transformObjects(1, deltas), true);
    assert.equal(store.edits.length, movable.filter((o) => moves.find((m) => m.key === o.ref.key).dx !== 0).length, 'a record for each object that had to move');
    assert.equal(store.undo(), true);
    assert.deepEqual([store.edits.length, store.canUndo], [0, false], 'one undo step for all of them');
    store.redo();
    const saved = await composeDocument({ base: bytes, plan, edits: store.edits });
    const again = objectsOf((await analyzeFile(saved)).pages[0]).filter((o) => o.kind === 'image' || o.kind === 'text-run');
    const right = Math.max(...movable.map((o) => quadBox(o.geometry.quad)[2]));
    const rights = again.filter((o) => o.kind === 'image' || o.text?.trim()).map((o) => quadBox(o.geometry.quad)[2]);
    assert.ok(rights.every((r) => Math.abs(r - right) < 0.05), `every right edge at ${right}: ${rights.map((r) => r.toFixed(2))}`);
  });
});
