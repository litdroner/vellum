// Vellum 0.5.0 Phase 2: the selection model (editing/objects/selection.js).
//
// Two things are being pinned here. First, what may be selected at all: only things a person can
// see and point at, decided from the reasons the engine has already recorded rather than from a
// second opinion. Second — and this is the one that matters — that a selection is IDENTITY and
// nothing else. No quad, no coordinate, no analysis, no object. If geometry ever leaks into this
// state, a selection can outlive the page it was measured on and draw an outline somewhere wrong.
//
// Written for one selected object ({ page, key }); multi-select made the identity { page, keys }
// and these tests follow it, one object at a time. Several objects: multi-select.test.mjs.
// Run: node --test "tests/editing/*.test.mjs"

import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { analyzeFile, engine } from './harness.mjs';
import { makeFixtures, FIXTURE_DIR } from './fixtures.mjs';

const { ObjectSelection, isSelectable, selectableObjects } = await engine('objects/selection.js');
const { objectsOf, objectsOfKind } = await engine('objects/page-objects.js');

let files;
const cache = new Map();
before(async () => { files = await makeFixtures(FIXTURE_DIR); });
const read = (name) => new Uint8Array(fs.readFileSync(files[name]));

async function analyzed(name) {
  if (!cache.has(name)) cache.set(name, await analyzeFile(read(name)));
  return cache.get(name);
}

// ---- 1. the state is identity, and only identity ---------------------------------------------

test('a selection is exactly { page, keys } and nothing else', () => {
  const selection = new ObjectSelection();
  assert.equal(selection.current, null);
  selection.select(3, 'image:page#7');
  assert.deepEqual(Object.keys(selection.current).sort(), ['keys', 'page']);
  assert.deepEqual(selection.current, { page: 3, keys: ['image:page#7'] });
  assert.ok(Object.isFrozen(selection.current) && Object.isFrozen(selection.current.keys), 'and it cannot be added to afterwards');
  assert.throws(() => { selection.current.quad = [1, 2, 3, 4]; }, TypeError);
  // Nothing in it is a coordinate, a list of them, or anything but a number and strings.
  assert.equal(typeof selection.current.page, 'number');
  assert.ok(selection.current.keys.every((key) => typeof key === 'string'));
});

test('selecting an object keeps no part of the object', async () => {
  const page = (await analyzed('objects')).pages[0];
  const object = selectableObjects(page)[0];
  const selection = new ObjectSelection();
  selection.select(1, object.ref.key);
  const kept = JSON.parse(JSON.stringify(selection.current));
  assert.deepEqual(kept, { page: 1, keys: [object.ref.key] });
  // The object, its geometry and its record are all reachable from the analysis and from nowhere
  // in the selection: serialising the whole state is two fields, never a quad.
  assert.equal(JSON.stringify(selection.current).includes('quad'), false);
  assert.equal(JSON.stringify(selection.current).length < 120, true);
});

test('change fires once per real change, and never for a no-op', () => {
  const selection = new ObjectSelection();
  let changes = 0;
  selection.addEventListener('change', () => { changes++; });

  assert.equal(selection.select(1, 'run:0:0'), true);
  assert.equal(changes, 1);
  assert.equal(selection.select(1, 'run:0:0'), false, 'selecting what is selected does nothing');
  assert.equal(changes, 1);
  assert.equal(selection.select(2, 'run:0:0'), true, 'the same key on another page is another object');
  assert.equal(changes, 2);
  assert.equal(selection.clear(), true);
  assert.equal(changes, 3);
  assert.equal(selection.clear(), false, 'clearing nothing does nothing');
  assert.equal(changes, 3);
});

// The Edit-mode overlay redraws on this event (ui/text-editor.js #selectionChanged), so a selection set
// from outside a click must announce the new page before anyone reads it, and a page it left behind.
test('a change made from outside a gesture reports the new page as it fires', () => {
  const selection = new ObjectSelection();
  const seen = [];
  selection.addEventListener('change', () => seen.push(selection.page));
  selection.set(1, ['text:a']);
  selection.set(2, ['text:b']);
  selection.select(3, 'run:0:0');
  selection.clear();
  assert.deepEqual(seen, [1, 2, 3, null], 'each change is seen with the page it moved to, in order');
});

test('an incomplete identity clears rather than selecting something half-known', () => {
  const selection = new ObjectSelection();
  selection.select(1, 'run:0:0');
  // It reports what every call reports: whether this changed anything. It did — the selection went.
  assert.equal(selection.select(1, null), true, 'no key: the selection goes');
  assert.equal(selection.current, null);
  assert.equal(selection.select(1, null), false, 'and with nothing selected, nothing changes');

  selection.select(1, 'run:0:0');
  selection.select(null, 'run:0:0');
  assert.equal(selection.current, null, 'no page is just as incomplete');
});

test('has() answers about both fields', () => {
  const selection = new ObjectSelection();
  assert.equal(selection.has(1, 'run:0:0'), false, 'nothing is selected');
  selection.select(1, 'run:0:0');
  assert.equal(selection.has(1, 'run:0:0'), true);
  assert.equal(selection.has(2, 'run:0:0'), false);
  assert.equal(selection.has(1, 'run:9:9'), false);
  assert.equal(selection.page, 1);
  assert.deepEqual([...selection.keys], ['run:0:0']);
  assert.equal(selection.primary, 'run:0:0');
});

// ---- 2. geometry comes from the analysis, every time -----------------------------------------

test('resolve() finds the object in the analysis it is given', async () => {
  const page = (await analyzed('objects')).pages[0];
  const object = selectableObjects(page).find((o) => o.kind === 'image');
  const selection = new ObjectSelection();
  selection.select(1, object.ref.key);
  const [found, ...more] = selection.resolve(page);
  assert.equal(found.ref.key, object.ref.key);
  assert.equal(more.length, 0);
  assert.ok(found.geometry.quad, 'and the geometry comes with it, from the page, not the selection');
  assert.deepEqual(selection.resolve(null), [], 'without an analysis there is no geometry to give');
});

test('a key that is no longer on the page resolves to nothing instead of throwing', async () => {
  const page = (await analyzed('objects')).pages[0];
  const selection = new ObjectSelection();
  selection.select(1, 'image:page#99999');
  assert.deepEqual(selection.resolve(page), []);
  assert.equal(selection.current !== null, true, 'resolving does not itself clear the selection');
});

test('reconcile() drops a selection whose object has gone, and keeps one that has not', async () => {
  const objects = (await analyzed('objects')).pages[0];
  const simple = (await analyzed('simple')).pages[0];
  const object = selectableObjects(objects).find((o) => o.kind === 'image');

  const kept = new ObjectSelection();
  kept.select(1, object.ref.key);
  kept.reconcile(objects);
  assert.equal(kept.primary, object.ref.key, 'still there, so still selected');

  // The same key against a different page: the object is not there, so the selection goes.
  const dropped = new ObjectSelection();
  dropped.select(1, object.ref.key);
  dropped.reconcile(simple);
  assert.equal(dropped.current, null);
});

test('re-resolving after a fresh analysis of the same file finds the same object', async () => {
  const first = (await analyzeFile(read('objects'))).pages[0];
  const second = (await analyzeFile(read('objects'))).pages[0];
  const object = selectableObjects(first).find((o) => o.kind === 'image');
  const selection = new ObjectSelection();
  selection.select(1, object.ref.key);
  // A rebuild produces a new analysis and new object instances; the two fields find it again.
  const [found] = selection.resolve(second);
  assert.ok(found, 'the key survives the rebuild');
  assert.notEqual(found, object, 'as a new object, not the one that was selected');
  assert.deepEqual([...found.geometry.quad], [...object.geometry.quad]);
});

// ---- 3. what may be selected ------------------------------------------------------------------

test('only text runs and images are selectable', async () => {
  const page = (await analyzed('objects')).pages[0];
  const kinds = new Set(selectableObjects(page).map((o) => o.kind));
  assert.deepEqual([...kinds].sort(), ['image', 'text-run']);
  // Paths and forms are on the page and deliberately not offered: they have no oriented outline,
  // only a bounding box, and neither can be acted on anyway.
  assert.ok(objectsOfKind(page, 'path').length > 0, 'the fixture paints paths');
  assert.ok(objectsOfKind(page, 'form').length > 0, 'and draws a form');
  for (const o of [...objectsOfKind(page, 'path'), ...objectsOfKind(page, 'form')]) {
    assert.equal(isSelectable(o, page), false, o.ref.key);
  }
});

test('content on a switched-off layer is not selectable: it is not drawn', async () => {
  const page = (await analyzed('objects')).pages[0];
  const hidden = objectsOfKind(page, 'image').filter((o) => o.record.oc?.hidden);
  assert.equal(hidden.length, 1, 'the fixture draws one image on a hidden layer');
  for (const o of hidden) assert.equal(isSelectable(o, page), false, o.ref.key);

  // A visible layer is a different matter: you can see it, so you can point at it.
  const visible = objectsOfKind(page, 'image').filter((o) => o.record.oc && !o.record.oc.hidden);
  assert.ok(visible.length > 0);
  for (const o of visible) assert.equal(isSelectable(o, page), true, o.ref.key);

  // The same for text, which carries its layer on its shows rather than on its own record.
  const hiddenText = objectsOfKind(page, 'text-run').find((o) => o.text.includes('hidden layer'));
  assert.ok(hiddenText, 'the fixture writes text on a hidden layer');
  assert.equal(isSelectable(hiddenText, page), false);
  const visibleText = objectsOfKind(page, 'text-run').find((o) => o.text.includes('visible layer'));
  assert.equal(isSelectable(visibleText, page), true);
});

test('text that is on the page but not on show is not selectable', async () => {
  const page = (await analyzed('constructs')).pages.find((p) => p.runs.some((r) => r.reasons.has('invisible')));
  const runs = objectsOfKind(page, 'text-run');
  const invisible = runs.filter((o) => o.record.reasons.has('invisible'));
  assert.ok(invisible.length > 0, 'the fixture draws invisible text');
  for (const o of invisible) assert.equal(isSelectable(o, page), false, o.text);
  // White space has nothing to click either.
  for (const o of runs.filter((r) => r.record.reasons.has('blank'))) assert.equal(isSelectable(o, page), false);
});

test('selectable does not mean editable: text Vellum refuses to change can still be selected', async () => {
  const page = (await analyzed('constructs')).pages.find((p) => p.runs.some((r) => r.reasons.has('skewed')));
  const skewed = objectsOfKind(page, 'text-run').find((o) => o.record.reasons.has('skewed'));
  assert.ok(skewed);
  assert.equal(skewed.editable, false, 'it cannot be edited');
  assert.equal(skewed.capabilities.editText, 'skewed', 'and says why');
  assert.equal(isSelectable(skewed, page), true, 'but it is on the page and can be pointed at');
});

test('selectable objects come back in drawing order, and are a subset of the page', async () => {
  const page = (await analyzed('objects')).pages[0];
  const all = objectsOf(page);
  const selectable = selectableObjects(page);
  assert.ok(selectable.length > 0 && selectable.length < all.length);
  const positions = selectable.map((o) => all.indexOf(o));
  assert.deepEqual(positions, [...positions].sort((a, b) => a - b), 'drawing order is preserved');
  assert.deepEqual(positions.filter((p) => p < 0), [], 'every one is the page object itself');
});

test('nothing selectable lacks the geometry needed to outline it', async () => {
  for (const name of ['objects', 'simple', 'cropbox', 'images']) {
    for (const page of (await analyzed(name)).pages) {
      for (const object of selectableObjects(page)) {
        assert.equal(object.geometry.quad?.length, 8, `${name}: ${object.ref.key}`);
      }
    }
  }
});

test('isSelectable refuses what it is not given', () => {
  assert.equal(isSelectable(null, null), false);
  assert.equal(isSelectable({ kind: 'image', geometry: {} }, null), false, 'an image with no quad');
  assert.equal(isSelectable({ kind: 'path', geometry: { quad: [0, 0, 1, 0, 1, 1, 0, 1] } }, null), false);
});
