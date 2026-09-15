// Vellum 0.5.0 Phase 1, Step 2: the read-only object model (editing/objects/page-objects.js).
// It is derived from an analysis and adds nothing to it, so these tests check that it reports the
// same facts the analysis already holds — identity that survives repeated draws and inline images,
// drawing order that survives nesting inside a form, and text editability passed through untouched.
// Run: node --test "tests/editing/*.test.mjs"

import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { analyzeFile, engine, ROOT } from './harness.mjs';
import { makeFixtures, FIXTURE_DIR } from './fixtures.mjs';

const { pageObjects, objectsOf, objectByKey, objectsOfKind, compareOrder } = await engine('objects/page-objects.js');

let files;
const cache = new Map();
before(async () => { files = await makeFixtures(FIXTURE_DIR); });
const read = (name) => new Uint8Array(fs.readFileSync(files[name]));

async function analyzed(name) {
  if (!cache.has(name)) cache.set(name, await analyzeFile(read(name)));
  return cache.get(name);
}

/** A short label per object, for order assertions. */
const label = (o) => {
  if (o.kind === 'text-run') return o.text;
  if (o.kind === 'image') return `image#${o.record.index}`;
  if (o.kind === 'path') return `path:${o.record.paint}`;
  return `form:/${o.record.name}`;
};

// ---- what it is ------------------------------------------------------------------------------

test('every drawn thing on a page becomes exactly one object', async () => {
  const page = (await analyzed('objects')).pages[0];
  const objects = pageObjects(page);
  assert.equal(objects.length, page.runs.length + page.images.length + page.paths.length + page.forms.length);
  const counts = {};
  for (const o of objects) counts[o.kind] = (counts[o.kind] ?? 0) + 1;
  assert.deepEqual(counts, { 'text-run': 5, image: 12, path: 3, form: 1 });
});

test('the model is read-only and adds nothing to the analysis', async () => {
  const page = (await analyzed('objects')).pages[0];
  const [first] = pageObjects(page);
  assert.ok(Object.isFrozen(first) && Object.isFrozen(first.ref) && Object.isFrozen(first.geometry));
  assert.throws(() => { first.kind = 'something-else'; }, TypeError);
  // Its geometry is the analysis's own, not a re-measurement.
  const image = pageObjects(page).find((o) => o.kind === 'image');
  assert.equal(image.geometry.box, image.record.box, 'the box is the analysis record’s own array');
  assert.equal(image.geometry.quad, image.record.quad);
});

test('objects are built on demand, and kept once built', async () => {
  const page = (await analyzed('simple')).pages[0];
  assert.notEqual(pageObjects(page), pageObjects(page), 'pageObjects() builds afresh each time');
  assert.equal(objectsOf(page), objectsOf(page), 'objectsOf() keeps the result for an analysis');
  assert.deepEqual(objectsOf(page).map(label), pageObjects(page).map(label));
});

test('object building stays out of the writer: the compose path never imports it', () => {
  // Phase 1 keeps this cost off every save. A test, not a convention, so it can't drift back in.
  for (const file of ['page-writer.js', 'objects/text-run.js', 'objects/registry.js', 'content/writer.js']) {
    const source = fs.readFileSync(path.join(ROOT, 'src', 'Vellum', 'web', 'js', 'editing', file), 'utf8');
    assert.ok(!/page-objects|capabilities/.test(source), `${file} must not pull the object model into the writer`);
  }
});

// ---- identity ---------------------------------------------------------------------------------

test('identity never rests on an image’s resource key', async () => {
  const page = (await analyzed('objects')).pages[0];
  const images = objectsOfKind(page, 'image');
  // /Im1 is drawn many times and every draw shares one resource key; an inline image has none.
  const repeated = images.filter((o) => o.record.name === 'Im1');
  assert.ok(repeated.length > 1);
  assert.equal(new Set(repeated.map((o) => o.record.key)).size, 1, 'the fixture repeats one resource');
  assert.equal(new Set(repeated.map((o) => o.ref.key)).size, repeated.length, 'but each draw is its own object');
  const inline = images.find((o) => o.record.inline);
  assert.equal(inline.record.key, null, 'an inline image has no resource key');
  assert.ok(inline.ref.key.startsWith('image:'), `it still gets an identity: ${inline.ref.key}`);
});

test('keys are unique on a page — including two runs that share one TJ operator', async () => {
  // `columns` draws both columns from single TJ operators, so those runs share a stream and an
  // operator index. Keying text on where it is drawn would collide; keying on the run does not.
  const page = (await analyzed('columns')).pages[0];
  const runs = objectsOfKind(page, 'text-run');
  const places = runs.map((o) => `${o.ref.stream}#${o.ref.opIndex}`);
  assert.ok(new Set(places).size < places.length, 'the fixture really does share operators between runs');
  const gaps = runs.filter((o) => o.text === 'Gap left' || o.text === 'Gap right');
  assert.equal(gaps.length, 2);
  assert.equal(gaps[0].ref.opIndex, gaps[1].ref.opIndex, 'drawn by the same operator');
  assert.notEqual(gaps[0].ref.key, gaps[1].ref.key, 'yet they are two objects');

  for (const name of ['simple', 'columns', 'objects', 'constructs', 'composite', 'images', 'transparency']) {
    const d = await analyzed(name);
    d.pages.forEach((p, i) => {
      const keys = objectsOf(p).map((o) => o.ref.key);
      assert.equal(new Set(keys).size, keys.length, `${name} page ${i + 1}: keys are not unique`);
    });
  }
});

test('a text object keeps the key its edit records already use, and is found by it', async () => {
  const page = (await analyzed('simple')).pages[0];
  const [run] = page.runs;
  const object = objectByKey(page, `run:${run.key}`);
  assert.equal(object.ref.runKey, run.key, 'the run key an edit record targets');
  assert.equal(object.text, 'Hello, world');
  assert.equal(objectByKey(page, 'run:nope'), null);
});

test('keys are stable across two analyses of the same file', async () => {
  for (const name of ['objects', 'constructs']) {
    const a = await analyzeFile(read(name));
    const b = await analyzeFile(read(name));
    a.pages.forEach((p, i) => {
      assert.deepEqual(objectsOf(p).map((o) => o.ref.key), objectsOf(b.pages[i]).map((o) => o.ref.key), name);
    });
  }
});

// ---- drawing order ------------------------------------------------------------------------------

test('objects come back in the order they are drawn, nesting included', async () => {
  const page = (await analyzed('objects')).pages[0];
  assert.deepEqual(objectsOf(page).map(label), [
    'image#0', 'image#1', 'image#2', 'image#3', 'image#4', 'image#5', 'image#6', 'image#7', 'image#8',
    'image#9', 'image#10', 'form:/Fm1', 'image#11',
    'path:fill', 'path:stroke', 'path:shading',
    'Tagged paragraph', 'Artifact text', 'Text on a visible layer', 'Text on a hidden layer', 'Ordinary text',
  ]);
});

test('an object inside a form is ordered by where the form is drawn', async () => {
  const page = (await analyzed('objects')).pages[0];
  const form = objectsOfKind(page, 'form')[0];
  const inside = objectsOfKind(page, 'image').find((o) => o.ref.stream !== 'page');
  assert.deepEqual(form.order, [57]);
  assert.deepEqual(inside.order, [57, 2], 'the form’s position on the page, then its own inside it');
  assert.ok(compareOrder(form, inside) < 0, 'the form is drawn before what it draws');
  // Its own operator index is 2, which on the page would mean "almost first".
  assert.equal(inside.ref.opIndex, 2);
  const pageLevelSecond = objectsOfKind(page, 'image').find((o) => o.record.index === 1);
  assert.ok(compareOrder(pageLevelSecond, inside) < 0, 'an image drawn at page operator 6 still comes first');
});

test('text inside a form nests the same way', async () => {
  const page = (await analyzed('constructs')).pages[0];
  const inForm = objectsOfKind(page, 'text-run').find((o) => o.text === 'Inside a form');
  assert.equal(inForm.order.length, 2, 'a page operator index, then one inside the form');
  const form = objectsOfKind(page, 'form').find((o) => o.record.key === inForm.ref.stream);
  assert.equal(inForm.order[0], form.ref.opIndex);
});

test('compareOrder sorts paths element by element, shorter first', () => {
  const order = [[57, 2], [2], [57], [61], [6], [57, 1]];
  assert.deepEqual(order.sort(compareOrder), [[2], [6], [57], [57, 1], [57, 2], [61]]);
});

// ---- text editability, passed through ------------------------------------------------------------

test('a text object reports exactly the editability the analysis worked out', async () => {
  const page = (await analyzed('constructs')).pages[0];
  const objects = objectsOfKind(page, 'text-run');
  assert.equal(objects.length, page.runs.length);
  for (const o of objects) {
    assert.equal(o.editable, o.record.editable, o.text);
    assert.deepEqual(o.reasons, [...o.record.reasons].sort(), o.text);
  }
  const by = (text) => objects.find((o) => o.text === text);
  assert.deepEqual([by('World kerned').editable, by('World kerned').reasons], [true, []]);
  assert.deepEqual([by('abab').editable, by('abab').reasons], [false, ['type3']]);
  assert.deepEqual([by('Zero size').editable, by('Zero size').reasons], [false, ['degenerate', 'skewed']]);
  // Layers, from a different fixture, use the same vocabulary.
  const layered = objectsOfKind((await analyzed('objects')).pages[0], 'text-run').find((o) => o.text === 'Text on a hidden layer');
  assert.deepEqual([layered.editable, layered.reasons], [false, ['layer']]);
});

test('only text says anything about editing; every kind answers the same verbs', async () => {
  // Step 3 gave every object `capabilities` (objects/capabilities.js, tested in full next door).
  // What must not change is the rest: `editable` and `reasons` stay a text-run affair.
  const page = (await analyzed('objects')).pages[0];
  for (const o of objectsOf(page)) {
    assert.deepEqual(Object.keys(o.capabilities), ['move', 'scale', 'stretch', 'rotate', 'replace', 'editText', 'delete', 'copy'], o.kind);
    if (o.kind === 'text-run') continue;
    assert.equal(o.editable, undefined, `${o.kind} must not claim editability`);
    assert.equal(o.reasons, undefined, `${o.kind} must not carry reasons`);
    assert.notEqual(o.capabilities.editText, true, `${o.kind} must never be text-editable`);
  }
});

test('geometry comes straight from the analysis, and is absent where the analysis has none', async () => {
  const page = (await analyzed('objects')).pages[0];
  const run = objectsOfKind(page, 'text-run')[0];
  assert.equal(run.geometry.quad.length, 8);
  assert.equal(run.geometry.frame, run.record.frame);
  const image = objectsOfKind(page, 'image')[0];
  assert.deepEqual(image.geometry.box, [72, 650, 172, 700]);
  assert.equal(image.geometry.frame, null, 'only text has a reading frame');
  for (const p of objectsOfKind(page, 'path')) {
    assert.equal(p.geometry.quad, null, 'a painted path has bounds, not a quad');
    assert.ok(Array.isArray(p.geometry.box));
  }
});
