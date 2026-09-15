// Vellum 0.5.0: same-page multi-select, in the engine.
//
// Four things are pinned here, from the bottom up:
//
//   1. the selection is still identity and nothing else — now { page, keys }, of one page;
//   2. several records are ONE undo step, and an arrow-key burst over several objects folds into one
//      step by record, never by position (which also closes an undo that could throw, see below);
//   3. a verb is on offer for a selection only when every object in it allows it;
//   4. the session writes a gesture on several objects whole or not at all, and what it writes is in
//      the saved file exactly where the gesture put each object.
//
// The session is driven through a stand-in for the document view: the same store, plan, pdf.js
// document and bytes the app gives it, and nothing else.
// Run: node --test "tests/editing/*.test.mjs"

import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { analyzeFile, engine, webModule, withSession } from './harness.mjs';
import { makeFixtures, FIXTURE_DIR } from './fixtures.mjs';

const { ObjectSelection, selectableObjects } = await engine('objects/selection.js');
const { sharedCapability, refusalMessage } = await engine('objects/capabilities.js');
const { objectsOf } = await engine('objects/page-objects.js');
const { unionBox, boxQuad, quadWithin, quadBox } = await engine('objects/geometry.js');
const { isRemoved } = await engine('session.js');
const { EditError } = await engine('edits.js');
const { REASONS } = await engine('runs.js');
const { apply, translate } = await engine('matrix.js');
const { scaleAbout, quarterTurn } = await engine('objects/transform.js');
const { AnnotationStore } = await webModule('annotations/model.js');
const { composeDocument } = await webModule('annotations/persist.js');

let files;
before(async () => { files = await makeFixtures(FIXTURE_DIR); });
const read = (name) => new Uint8Array(fs.readFileSync(files[name]));

/** The session over one fixture, as the app would drive it (harness.mjs withSession). */
const withDocument = (name, run) => withSession(read(name), run);

/** Undo steps, counted by rewinding the whole history and replaying it. */
function depth(store) {
  let n = 0;
  while (store.canUndo) {
    store.undo();
    n++;
  }
  for (let i = 0; i < n; i++) store.redo();
  return n;
}

const round = (v, places = 2) => Math.round(v * 10 ** places) / 10 ** places;

/** Where an object's quad is now: its own, through the transform its record holds (if any). */
function liveQuad(object, edits) {
  const e = edits.find((r) => (r.kind === 'text' ? `run:${r.target.key}` : r.target.key) === object.ref.key);
  if (!e?.transform) return object.geometry.quad;
  const q = object.geometry.quad;
  return [0, 2, 4, 6].flatMap((i) => apply(e.transform, q[i], q[i + 1]));
}
const near = (a, b, tol = 0.02) => a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) <= tol);

/** A page's objects in a saved file: images by drawing order, runs by text. */
async function reread(bytes, page = 0) {
  const analysis = (await analyzeFile(bytes)).pages[page];
  const objects = objectsOf(analysis);
  return {
    images: objects.filter((o) => o.kind === 'image').map((o) => [[0, 0], [1, 0], [1, 1], [0, 1]].map(([x, y]) => apply(o.record.ctm, x, y))),
    run: (text) => analysis.runs.find((r) => r.text === text) ?? null,
  };
}

// ---- 1. the selection: identity of several objects on one page ----------------------------------

test('a selection is { page, keys } and nothing else, frozen all the way down', () => {
  const selection = new ObjectSelection();
  assert.equal(selection.current, null);
  assert.deepEqual([...selection.keys], [], 'no keys when nothing is selected');
  selection.set(2, ['image:page#2', 'run:4:0']);
  assert.deepEqual(Object.keys(selection.current).sort(), ['keys', 'page']);
  assert.deepEqual(JSON.parse(JSON.stringify(selection.current)), { page: 2, keys: ['image:page#2', 'run:4:0'] });
  assert.ok(Object.isFrozen(selection.current) && Object.isFrozen(selection.current.keys));
  assert.throws(() => { selection.current.keys.push('image:page#9'); }, TypeError);
  assert.throws(() => { selection.current.quads = []; }, TypeError);
  assert.equal(selection.size, 2);
  assert.equal(selection.primary, 'run:4:0', 'the most recently chosen');
  assert.equal(JSON.stringify(selection.current).includes('quad'), false);
});

test('toggle adds an object and takes it out again; taking out the last one clears', () => {
  const selection = new ObjectSelection();
  let changes = 0;
  selection.addEventListener('change', () => { changes++; });
  assert.equal(selection.toggle(1, 'run:0:0'), true);
  assert.equal(selection.toggle(1, 'image:page#2'), true);
  assert.deepEqual([...selection.keys], ['run:0:0', 'image:page#2']);
  assert.equal(selection.has(1, 'run:0:0') && selection.has(1, 'image:page#2'), true);
  assert.equal(selection.toggle(1, 'run:0:0'), true, 'toggling a selected object takes it out');
  assert.deepEqual([...selection.keys], ['image:page#2']);
  assert.equal(selection.toggle(1, 'image:page#2'), true);
  assert.equal(selection.current, null, 'and the last one out leaves nothing selected');
  assert.equal(changes, 4, 'one change per real change');
});

test('a selection is of one page: choosing on another page starts over there', () => {
  const selection = new ObjectSelection();
  selection.set(1, ['run:0:0', 'image:page#2']);
  selection.toggle(2, 'run:0:0');
  assert.deepEqual(selection.current, { page: 2, keys: ['run:0:0'] }, 'the same key on another page is another object');
  selection.add(3, ['image:page#5', 'image:page#7']);
  assert.deepEqual(selection.current, { page: 3, keys: ['image:page#5', 'image:page#7'] });
  assert.equal(selection.has(2, 'run:0:0'), false);
});

test('each key is kept once, in the order chosen, and nothing half-known is selected', () => {
  const selection = new ObjectSelection();
  selection.set(1, ['a:1', 'b:2', 'a:1', '', null, 'c:3']);
  assert.deepEqual([...selection.keys], ['a:1', 'b:2', 'c:3']);
  selection.add(1, ['b:2', 'd:4']);
  assert.deepEqual([...selection.keys], ['a:1', 'b:2', 'c:3', 'd:4'], 'adding what is there already adds nothing');
  assert.equal(selection.primary, 'd:4');
  assert.equal(selection.select(1, null), true, 'no key: the selection goes');
  assert.equal(selection.current, null);
  selection.select(1, 'a:1');
  assert.equal(selection.set(null, ['a:1']), true, 'no page is just as incomplete');
  assert.equal(selection.current, null);
  selection.select(1, 'a:1');
  assert.equal(selection.set(1, []), true, 'and neither is nothing');
  assert.equal(selection.current, null);
});

test('a no-op fires nothing', () => {
  const selection = new ObjectSelection();
  let changes = 0;
  selection.addEventListener('change', () => { changes++; });
  selection.set(1, ['a:1', 'b:2']);
  assert.equal(changes, 1);
  assert.equal(selection.set(1, ['a:1', 'b:2']), false, 'the same selection in the same order');
  assert.equal(selection.add(1, ['a:1']), false, 'adding what is selected');
  assert.equal(selection.retain(() => true), false, 'keeping everything');
  assert.equal(selection.toggle(null, 'a:1'), false, 'a toggle with no page');
  assert.equal(changes, 1);
  assert.equal(selection.set(1, ['b:2', 'a:1']), true, 'but a new order is a new primary, and a change');
  assert.equal(selection.primary, 'a:1');
  selection.clear();
  assert.equal(selection.clear(), false);
  assert.equal(changes, 3);
});

test('resolve() gives the selected objects still on the page, in selection order; reconcile() drops only what has gone', async () => {
  const analysis = (await analyzeFile(read('images'))).pages[0];
  const objects = selectableObjects(analysis);
  const image = objects.find((o) => o.kind === 'image');
  const run = objects.find((o) => o.kind === 'text-run');
  const selection = new ObjectSelection();
  selection.set(1, [run.ref.key, 'image:page#99999', image.ref.key]);
  assert.deepEqual(selection.resolve(analysis).map((o) => o.ref.key), [run.ref.key, image.ref.key]);
  assert.deepEqual(selection.resolve(null), [], 'without an analysis there is nothing to give');
  assert.equal(selection.size, 3, 'resolving changes nothing');
  assert.equal(selection.reconcile(analysis), true);
  assert.deepEqual([...selection.keys], [run.ref.key, image.ref.key], 'the missing key is dropped and the rest kept');
  assert.equal(selection.reconcile(analysis), false, 'and a second reconcile has nothing to do');
  selection.reconcile(null);
  assert.equal(selection.current, null, 'a page with no analysis at all has nothing selectable');
});

// ---- 2. the store: several records, one step ---------------------------------------------------------

const record = (id, x, extra = {}) => ({ id, kind: 'image', entry: 'p1', target: { key: `image:page#${id}` }, transform: [1, 0, 0, 1, x, 0], removed: false, ...extra });

test('several edits applied together are one undo step', () => {
  const store = new AnnotationStore();
  const a = record('a', 10);
  const b = record('b', 20);
  store.applyEdits([[null, a], [null, b]]);
  assert.deepEqual(store.edits, [a, b]);
  assert.equal(depth(store), 1, 'one gesture, one step');
  store.undo();
  assert.deepEqual(store.edits, [], 'undo takes back both');
  assert.equal(store.canUndo, false);
  store.redo();
  assert.deepEqual(store.edits, [a, b], 'redo puts back both');
  assert.equal(store.dirty, true);
});

test('a burst over several objects folds into one step that goes back to where the burst began', () => {
  const store = new AnnotationStore();
  const a0 = record('a', 5);
  store.applyEdit(null, a0); // an earlier, separate gesture
  const token = 'nudge:test';
  const a1 = record('a', 6);
  const b1 = record('b', 1);
  store.applyEdits([[a0, a1], [null, b1]], token);
  const a2 = record('a', 7);
  const b2 = record('b', 2);
  store.applyEdits([[a1, a2], [b1, b2]], token);
  assert.deepEqual(store.edits, [a2, b2]);
  assert.equal(depth(store), 2, 'the earlier gesture, and the whole burst as one step');
  store.undo();
  assert.deepEqual(store.edits, [a0], 'undo goes back to before the burst, for every object in it');
  store.redo();
  assert.deepEqual(store.edits, [a2, b2]);
});

test('a burst that ends one record and starts another folds by record: undo neither throws nor duplicates', () => {
  // A nudge that brings a moved object back to where the file has it removes its record; the next
  // nudge in the same burst makes a new record with a new id. Folding by position used to pair the
  // old record's "before" with the new record's "after" under the new id: undo then stored the old
  // record under the wrong id, and the next gesture on that object left two records for it.
  const store = new AnnotationStore();
  const x0 = record('x', 5);
  store.applyEdit(null, x0);
  const token = 'nudge:ids';
  store.applyEdit(x0, null, token); // back where the file has it: the record goes
  const y1 = record('y', 1, { target: { key: 'image:page#x' } }); // moved again: a new record
  store.applyEdit(null, y1, token);
  assert.deepEqual(store.edits, [y1]);
  assert.equal(depth(store), 2);
  store.undo();
  assert.deepEqual(store.edits, [x0], 'undo restores the record the burst started from, as itself');
  const x1 = record('x', 9);
  store.applyEdit(x0, x1);
  assert.deepEqual(store.edits, [x1], 'and a later gesture replaces it: one record for one object');
  store.undo();
  store.redo();
  assert.deepEqual(store.edits, [x1]);
});

test('a burst that starts a record and ends it again leaves no step, and nothing unsaved', () => {
  // Nudged away and straight back inside one burst: a record made and removed. Folded by position
  // this became { before: null, after: null }, and undoing it threw.
  const store = new AnnotationStore();
  const token = 'nudge:back';
  const a = record('a', 1);
  store.applyEdit(null, a, token);
  store.applyEdit(a, null, token);
  assert.deepEqual(store.edits, []);
  assert.equal(store.canUndo, false, 'nothing happened, so there is nothing to undo');
  assert.doesNotThrow(() => store.undo());
  assert.equal(store.dirty, false);

  // The same when the object had a record before the burst and ends it exactly as it was.
  const before = record('b', 3);
  store.applyEdit(null, before);
  store.markSaved();
  store.applyEdit(before, record('b', 4), 'nudge:same');
  store.applyEdit(record('b', 4), record('b', 3), 'nudge:same');
  assert.equal(depth(store), 1, 'only the step before the burst is left');
  assert.equal(store.dirty, false, 'and the document is as it was saved');
});

test('coalescing never reaches past a different token, a plan change or an annotation', () => {
  const store = new AnnotationStore();
  store.initPlan([{ id: 'p1', src: 'base', index: 0, rotate: 0 }]);
  const a1 = record('a', 1);
  store.applyEdit(null, a1, 't1');
  const a2 = record('a', 2);
  store.applyEdit(a1, a2, 't2');
  assert.equal(depth(store), 2, 'another token is another gesture');
  store.applyPlan([{ id: 'p1', src: 'base', index: 0, rotate: 90 }]);
  const a3 = record('a', 3);
  store.applyEdit(a2, a3, 't2');
  assert.equal(depth(store), 4, 'a page change in between ends the gesture');
  store.add(store.create({ type: 'note', page: 1, point: [0, 0], color: '#fff' }));
  const a4 = record('a', 4);
  store.applyEdit(a3, a4, 't2');
  assert.equal(depth(store), 6, 'and so does an annotation');
});

// ---- 3. what a selection may have done to it -----------------------------------------------------------

test('a verb is shared only when every object allows it, and says which refused first', async () => {
  const analysis = (await analyzeFile(read('objects'))).pages[0];
  const objects = selectableObjects(analysis);
  const movable = objects.filter((o) => o.capabilities.move === true);
  const clipped = objects.find((o) => o.capabilities.move === 'clipped');
  assert.ok(movable.length >= 2 && clipped, 'the fixture has both');
  assert.equal(sharedCapability(movable, 'move'), true);
  const answer = sharedCapability([movable[0], clipped, movable[1]], 'move');
  assert.deepEqual([answer.reason, answer.object.ref.key], ['clipped', clipped.ref.key]);
  const text = movable.find((o) => o.kind === 'text-run');
  const picture = movable.find((o) => o.kind === 'image');
  assert.equal(sharedCapability([picture, text], 'rotate').reason, 'unsupported', 'text is never turned, so neither is a selection with text in it');
  assert.equal(sharedCapability([], 'move').reason, 'unsupported', 'nothing selected allows nothing');
});

test('a refusal is the reason in its own words, and for several objects says the whole gesture was held back', () => {
  assert.equal(refusalMessage('move', 'clipped'), REASONS.clipped);
  assert.equal(refusalMessage('move', 'clipped', 3), `Not all of the selected objects can be moved. ${REASONS.clipped}`);
  assert.equal(refusalMessage('rotate', 'unsupported', 2), `Not all of the selected objects can be turned. ${REASONS.unsupported}`);
  assert.equal(refusalMessage('delete', 'no-such-reason', 2), `Not all of the selected objects can be deleted. ${REASONS.unsupported}`);
});

// ---- 4. group geometry --------------------------------------------------------------------------------

test('a group is bounded by the box around every quad, and a box is a quad', () => {
  const a = [10, 10, 30, 10, 30, 20, 10, 20];
  const turned = [100, 50, 100, 80, 90, 80, 90, 50]; // a quarter-turned quad: its corners out of box order
  assert.deepEqual(unionBox([a, turned]), [10, 10, 100, 80]);
  assert.deepEqual(unionBox([a, null, [1, 2]]), quadBox(a), 'what is not a quad is ignored');
  assert.equal(unionBox([]), null);
  assert.deepEqual(boxQuad([10, 10, 100, 80]), [10, 10, 100, 10, 100, 80, 10, 80], 'll, lr, ur, ul');
  assert.equal(boxQuad(null), null);
});

test('a selection rectangle takes what it encloses, not what it touches', () => {
  const box = [0, 0, 100, 100];
  assert.equal(quadWithin([10, 10, 30, 10, 30, 20, 10, 20], box), true);
  assert.equal(quadWithin([90, 10, 110, 10, 110, 20, 90, 20], box), false, 'half in is not in');
  assert.equal(quadWithin([0, 0, 100, 0, 100, 100, 0, 100], box), true, 'on the edge is in');
  assert.equal(quadWithin([50, 50, 60, 60, 70, 70, 60, 60], box), false, 'a quad with no area is never inside');
  assert.equal(quadWithin([10, 10, 30, 10, 30, 20, 10, 20], null), false);
});

// ---- 5. the session: a gesture on several objects ----------------------------------------------------

test('moving several objects writes one record each, as one undo step, and each lands where it was put', async () => {
  await withDocument('images', async ({ bytes, plan, store, session }) => {
    const { objects } = await session.objects(1);
    const movable = objects.filter((o) => o.capabilities.move === true);
    assert.equal(movable.length, 4, 'two pictures and two lines');
    const delta = translate(25, -40);
    const changed = await session.transformObjects(1, movable.map((o) => ({ key: o.ref.key, delta })));
    assert.equal(changed, true);
    assert.equal(store.edits.length, 4, 'one record per object');
    assert.equal(depth(store), 1, 'and one undo step for the gesture');
    for (const e of store.edits) assert.deepEqual(e.transform, [1, 0, 0, 1, 25, -40], `${e.kind} ${e.target.key}`);

    const saved = await composeDocument({ base: bytes, plan, edits: store.edits });
    const after = await reread(saved);
    const original = await reread(bytes);
    original.images.forEach((corners, i) => {
      const want = corners.map(([x, y]) => apply(delta, x, y));
      assert.ok(after.images.some((got) => got.every((p, k) => near(p, want[k]))), `picture ${i} moved by the gesture`);
    });
    for (const text of ['Caption under the picture', 'Text beside another picture']) {
      const want = apply(delta, ...original.run(text).origin);
      assert.ok(near(after.run(text)?.origin ?? [], want), `“${text}” moved by the gesture: ${after.run(text)?.origin} vs ${want}`);
    }

    store.undo();
    assert.deepEqual(store.edits, [], 'undo takes back every object at once');
  });
});

test('a second gesture on the group replaces each record: the placement is absolute', async () => {
  await withDocument('images', async ({ store, session }) => {
    const { objects } = await session.objects(1);
    const keys = objects.filter((o) => o.capabilities.move === true).map((o) => o.ref.key);
    await session.transformObjects(1, keys.map((key) => ({ key, delta: translate(10, 0) })));
    const ids = store.edits.map((e) => e.id);
    await session.transformObjects(1, keys.map((key) => ({ key, delta: translate(0, 5) })));
    assert.deepEqual(store.edits.map((e) => e.id), ids, 'the same records');
    for (const e of store.edits) assert.deepEqual(e.transform, [1, 0, 0, 1, 10, 5]);
    assert.equal(depth(store), 2);
    // Moved back to where the file has them: no records left at all.
    const back = await session.transformObjects(1, keys.map((key) => ({ key, delta: translate(-10, -5) })));
    assert.equal(back, true);
    assert.deepEqual(store.edits, [], 'back where it started is no change to keep');
    assert.equal(await session.transformObjects(1, keys.map((key) => ({ key, delta: translate(0, 0) }))), false, 'and nothing to do is not a change');
  });
});

test('a group scaled about one anchor keeps its layout, and text stays a move and a uniform scale', async () => {
  await withDocument('images', async ({ bytes, plan, store, session }) => {
    const { objects } = await session.objects(1);
    const movable = objects.filter((o) => o.capabilities.scale === true);
    const box = unionBox(movable.map((o) => o.geometry.quad));
    const anchor = [box[2], box[3]]; // the top-right corner of the group stays put
    const delta = scaleAbout(anchor, 0.5);
    await session.transformObjects(1, movable.map((o) => ({ key: o.ref.key, delta })), { verb: 'scale' });
    const texts = store.edits.filter((e) => e.kind === 'text');
    assert.equal(texts.length, 2);
    for (const e of texts) {
      const [a, b, c, d] = e.transform;
      assert.ok(b === 0 && c === 0 && a === d, `text keeps a uniform scale: ${e.transform}`);
    }
    const saved = await composeDocument({ base: bytes, plan, edits: store.edits });
    const after = await reread(saved);
    const original = await reread(bytes);
    for (const text of ['Caption under the picture', 'Text beside another picture']) {
      const run = original.run(text);
      const moved = after.run(text);
      assert.ok(near(moved.origin, apply(delta, ...run.origin), 0.05), `“${text}” scaled about the group’s corner`);
      assert.equal(round(moved.frame.size), round(run.frame.size * 0.5), 'at half the size');
    }
    const now = unionBox(movable.map((o) => liveQuad(o, store.edits)));
    assert.ok(Math.abs(now[2] - box[2]) < 0.01 && Math.abs(now[3] - box[3]) < 0.01, `the anchor corner of the group has not moved: ${now} vs ${box}`);
    assert.ok(Math.abs((now[2] - now[0]) - (box[2] - box[0]) * 0.5) < 0.01, 'and the group is half as wide');
  });
});

test('one refusal holds back the whole gesture: nothing at all is stored', async () => {
  await withDocument('objects', async ({ store, session }) => {
    const { objects } = await session.objects(1);
    const movable = objects.filter((o) => o.capabilities.move === true);
    const clipped = objects.find((o) => o.capabilities.move === 'clipped');
    const keys = [movable[0].ref.key, clipped.ref.key, movable[1].ref.key];
    await assert.rejects(
      session.transformObjects(1, keys.map((key) => ({ key, delta: translate(5, 5) }))),
      (err) => err instanceof EditError && err.kind === 'not-editable' && err.detail.reason === 'clipped'
        && err.message === refusalMessage('move', 'clipped', 3),
    );
    assert.deepEqual(store.edits, [], 'not even the objects that could have moved');
    assert.equal(store.canUndo, false);
    await assert.rejects(session.removeObjects(1, keys), (err) => err.detail?.reason === 'clipped');
    assert.deepEqual(store.edits, []);
  });
});

test('a selection with text in it is not turned, and a picture alone still is', async () => {
  await withDocument('images', async ({ store, session }) => {
    const { objects } = await session.objects(1);
    const picture = objects.find((o) => o.kind === 'image');
    const text = objects.find((o) => o.kind === 'text-run');
    const turn = (o) => ({ key: o.ref.key, delta: quarterTurn([100, 100], 1) });
    await assert.rejects(session.transformObjects(1, [turn(picture), turn(text)], { verb: 'rotate' }),
      (err) => err.detail?.reason === 'unsupported' && /turned/.test(err.message));
    assert.deepEqual(store.edits, []);
    assert.equal(await session.transformObjects(1, [turn(picture)], { verb: 'rotate' }), true);
    assert.equal(store.edits.length, 1);
  });
});

test('deleting several objects is one undo step, and the saved file no longer draws any of them', async () => {
  await withDocument('images', async ({ bytes, plan, store, session }) => {
    const { objects } = await session.objects(1);
    const picture = objects.find((o) => o.kind === 'image');
    const text = objects.find((o) => o.kind === 'text-run');
    await session.removeObjects(1, [picture.ref.key, text.ref.key]);
    assert.equal(store.edits.length, 2);
    assert.ok(store.edits.every(isRemoved), 'both records remove their object');
    assert.equal(depth(store), 1);
    const saved = await composeDocument({ base: bytes, plan, edits: store.edits });
    const after = await reread(saved);
    assert.equal(after.images.length, 1, 'one of the two picture draws is gone');
    assert.equal(after.run(text.text), null, 'and the line is gone');
    store.undo();
    assert.deepEqual(store.edits, [], 'undo brings both back');
  });
});

test('an object that has been deleted cannot be moved back into existence', async () => {
  await withDocument('images', async ({ store, session }) => {
    const { objects } = await session.objects(1);
    const picture = objects.find((o) => o.kind === 'image');
    const other = objects.filter((o) => o.kind === 'image')[1];
    await session.removeObject(1, picture.ref.key);
    const held = JSON.stringify(store.edits);
    await assert.rejects(session.transformObject(1, picture.ref.key, translate(5, 0)), (err) => err.kind === 'missing');
    await assert.rejects(
      session.transformObjects(1, [{ key: other.ref.key, delta: translate(5, 0) }, { key: picture.ref.key, delta: translate(5, 0) }]),
      (err) => err.kind === 'missing' && /selected objects/.test(err.message),
    );
    await assert.rejects(session.removeObject(1, picture.ref.key), (err) => err.kind === 'missing', 'nor deleted twice');
    assert.equal(JSON.stringify(store.edits), held, 'and nothing was written by any of it');
  });
});

test('a gesture that names an object twice, or has no transform, is refused before anything happens', async () => {
  await withDocument('images', async ({ store, session }) => {
    const { objects } = await session.objects(1);
    const key = objects.find((o) => o.kind === 'image').ref.key;
    await assert.rejects(session.transformObjects(1, [{ key, delta: translate(1, 0) }, { key, delta: translate(1, 0) }]), (err) => err.kind === 'changed');
    await assert.rejects(session.removeObjects(1, [key, key]), (err) => err.kind === 'changed');
    await assert.rejects(session.transformObjects(1, [{ key, delta: null }]), (err) => err.kind === 'content');
    await assert.rejects(session.transformObjects(1, [{ key, delta: [1, 0, 0, 1, Number.NaN, 0] }]), (err) => err.kind === 'content');
    await assert.rejects(session.removeObjects(1, []), (err) => err.kind === 'missing');
    assert.deepEqual(store.edits, []);
  });
});

test('an arrow-key burst on a group: several writes, one undo step, back to the start in one go', async () => {
  await withDocument('images', async ({ store, session }) => {
    const { objects } = await session.objects(1);
    const keys = objects.filter((o) => o.capabilities.move === true).map((o) => o.ref.key);
    const token = 'nudge:group';
    for (let i = 0; i < 3; i++) {
      await session.transformObjects(1, keys.map((key) => ({ key, delta: translate(1, 0) })), { coalesce: token });
    }
    for (const e of store.edits) assert.deepEqual(e.transform, [1, 0, 0, 1, 3, 0]);
    assert.equal(depth(store), 1);
    store.undo();
    assert.deepEqual(store.edits, []);
    // Out and straight back inside one burst leaves nothing to undo at all.
    await session.transformObjects(1, keys.map((key) => ({ key, delta: translate(2, 0) })), { coalesce: 'nudge:back' });
    await session.transformObjects(1, keys.map((key) => ({ key, delta: translate(-2, 0) })), { coalesce: 'nudge:back' });
    assert.deepEqual(store.edits, []);
    assert.equal(store.canUndo, false);
  });
});

test('a group move of text that was retyped keeps the new text, in one record per line', async () => {
  await withDocument('images', async ({ bytes, plan, store, session }) => {
    const page = await session.page(1);
    const line = page.runs.find((r) => r.run.editable);
    await session.edit(1, line.run.key, 'Retyped caption');
    const { objects } = await session.objects(1);
    const keys = objects.filter((o) => o.capabilities.move === true).map((o) => o.ref.key);
    await session.transformObjects(1, keys.map((key) => ({ key, delta: translate(0, -30) })));
    assert.equal(store.edits.length, 4, 'the retyped line did not gain a second record');
    const retyped = store.edits.find((e) => e.kind === 'text' && e.text === 'Retyped caption');
    assert.deepEqual(retyped.transform, [1, 0, 0, 1, 0, -30]);
    const after = await reread(await composeDocument({ base: bytes, plan, edits: store.edits }));
    assert.ok(near(after.run('Retyped caption').origin, apply(translate(0, -30), ...line.run.origin)));
    assert.equal(depth(store), 2, 'the retype and the move');
  });
});
