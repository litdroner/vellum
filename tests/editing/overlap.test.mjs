// Vellum 0.5.0 should-have: overlap warnings (editing/objects/overlap.js).
//
// Pinned here: the depth of an overlap is exact for upright and turned quads, apart is 0, touching is
// 0; only NEW overlaps are reported, never the moving objects themselves, and a shallow touch under
// the tolerance doesn't count.
// Run: node --test "tests/editing/*.test.mjs"

import test from 'node:test';
import assert from 'node:assert/strict';
import { engine } from './harness.mjs';

const { overlapDepth, newOverlaps } = await engine('objects/overlap.js');
const { boxQuad, transformQuad } = await engine('objects/geometry.js');
const { translate } = await engine('matrix.js');

const box = (x1, y1, x2, y2) => boxQuad([x1, y1, x2, y2]);

test('overlap depth: exact for boxes, 0 apart or touching, and a turned quad is not its bounding box', () => {
  assert.equal(overlapDepth(box(0, 0, 10, 10), box(7, 2, 20, 8)), 3);
  assert.equal(overlapDepth(box(0, 0, 10, 10), box(10, 0, 20, 10)), 0, 'touching edges');
  assert.equal(overlapDepth(box(0, 0, 10, 10), box(30, 30, 40, 40)), 0);
  // A diamond around (20, 5): its bounding box [15, 0, 25, 10] reaches the square, the diamond doesn't.
  const diamond = [20, 0, 25, 5, 20, 10, 15, 5];
  assert.equal(overlapDepth(box(0, 0, 14.9, 10), diamond), 0);
  assert.equal(overlapDepth(box(0, 0, 16, 1), diamond), 0, 'inside the bounding box, beside the diamond');
  assert.ok(overlapDepth(box(0, 0, 21, 10), diamond) > 0);
});

test('only new overlaps, never the moving objects, and not below the tolerance', () => {
  const caption = box(0, 0, 100, 12);
  const picture = box(0, 10, 100, 110); // the caption already reaches 2 points into the picture
  const other = box(0, 200, 100, 212);
  const line = box(0, 150, 100, 162);
  const others = [{ key: 'caption', quad: caption }, { key: 'picture', quad: picture }, { key: 'other', quad: other }, { key: 'line', quad: line }];
  // The caption moves 1 point: it still overlaps the picture, as it always did — nothing new.
  assert.deepEqual(newOverlaps([{ key: 'caption', from: caption, to: transformQuad(caption, translate(1, 0)) }], others, 0), []);
  // The line moves onto the other text: that is new; the line itself is never reported.
  const onto = transformQuad(line, translate(0, 55));
  assert.deepEqual(newOverlaps([{ key: 'line', from: line, to: onto }], others, 1), ['other']);
  // Just touching it, 0.5 points deep, under a 1-point tolerance: not an overlap.
  const touching = transformQuad(line, translate(0, 38.5));
  assert.equal(overlapDepth(touching, other), 0.5);
  assert.deepEqual(newOverlaps([{ key: 'line', from: line, to: touching }], others, 1), []);
  assert.deepEqual(newOverlaps([{ key: 'line', from: line, to: touching }], others, 0.25), ['other']);
});
