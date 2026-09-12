// Vellum 0.5.0 Phase 1, Step 3: per-verb capabilities (editing/objects/capabilities.js).
// The point of this suite is that capabilities say nothing new. `editText` has to keep answering
// exactly what run.editable answers today, in the same words the tooltip already shows; every other
// verb has to refuse, because no writer for it exists; and none of it may cost the compose path
// anything. Run: node --test "tests/editing/*.test.mjs"

import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { analyzeFile, engine, WEB } from './harness.mjs';
import { makeFixtures, FIXTURE_DIR } from './fixtures.mjs';

const { objectsOf, objectsOfKind, pageObjects } = await engine('objects/page-objects.js');
const { capabilitiesFor, VERBS } = await engine('objects/capabilities.js');
const { REASONS, explainRun } = await engine('runs.js');

let files;
const cache = new Map();
before(async () => { files = await makeFixtures(FIXTURE_DIR); });
const read = (name) => new Uint8Array(fs.readFileSync(files[name]));

async function analyzed(name) {
  if (!cache.has(name)) cache.set(name, await analyzeFile(read(name)));
  return cache.get(name);
}

/** Every fixture whose text the baseline suite already pins, so both suites move together. */
const ALL = ['simple', 'multipage', 'fonts', 'columns', 'images', 'cropbox', 'tagged', 'pdfa',
  'signed', 'composite', 'scanned', 'transparency', 'objects', 'cmaps', 'constructs'];

/** Every object of every page of every listed fixture. */
async function* everyObject(names = ALL) {
  for (const name of names) {
    const d = await analyzed(name);
    for (const [i, page] of d.pages.entries()) {
      for (const o of objectsOf(page)) yield { name, page: i + 1, o };
    }
  }
}

// ---- 1. editText is the old answer, exactly -----------------------------------------------------

test('editText answers exactly what run.editable answers today', async () => {
  let trues = 0;
  let falses = 0;
  for await (const { name, page, o } of everyObject()) {
    if (o.kind !== 'text-run') continue;
    const editable = o.record.editable;
    assert.equal(o.capabilities.editText === true, editable,
      `${name} page ${page}: ${JSON.stringify(o.text)} — editText disagrees with run.editable`);
    if (editable) trues++; else falses++;
  }
  // Not an exact count (fixtures change); enough to prove the sweep saw plenty of both answers.
  assert.ok(trues > 50 && falses > 10, `the sweep must see both answers (${trues} editable, ${falses} refused)`);
});

test('a refused run names the very sentence the editor already shows', async () => {
  // edits.js and ui/text-editor.js both show explainRun(run)[0]. editText must name that same key,
  // so a person never gets one reason from the tooltip and another from the object model.
  let checked = 0;
  for (const name of ['constructs', 'objects', 'transparency', 'cmaps', 'scanned', 'composite']) {
    const d = await analyzed(name);
    for (const page of d.pages) {
      for (const o of objectsOfKind(page, 'text-run')) {
        if (o.record.editable) continue;
        assert.equal(REASONS[o.capabilities.editText], explainRun(o.record)[0],
          `${name}: ${JSON.stringify(o.text)}`);
        checked++;
      }
    }
  }
  assert.ok(checked > 10, `refusals actually compared: ${checked}`);
});

// ---- 2. one vocabulary, five verbs ---------------------------------------------------------------

test('every capability is true or a key of the one REASONS table', async () => {
  for await (const { name, page, o } of everyObject()) {
    for (const verb of VERBS) {
      const value = o.capabilities[verb];
      assert.ok(value === true || typeof REASONS[value] === 'string',
        `${name} page ${page} ${o.kind} ${o.ref.key}: ${verb} = ${JSON.stringify(value)} is not true and not a REASONS key`);
    }
  }
});

test('every object answers the same five verbs, in the same order', async () => {
  assert.deepEqual([...VERBS], ['move', 'scale', 'rotate', 'editText', 'delete']);
  for await (const { name, page, o } of everyObject()) {
    assert.deepEqual(Object.keys(o.capabilities), [...VERBS], `${name} page ${page} ${o.kind}`);
  }
});

test('no image, path or form is ever text-editable, and nothing else is writable yet', async () => {
  // Today exactly one cell in the whole model can be true: a text run's editText.
  for await (const { name, page, o } of everyObject()) {
    for (const verb of VERBS) {
      if (o.kind === 'text-run' && verb === 'editText') continue;
      assert.notEqual(o.capabilities[verb], true,
        `${name} page ${page} ${o.kind} ${o.ref.key}: ${verb} claims a permission no writer can honour`);
    }
  }
});

// ---- 3. structural reasons reach the other kinds -------------------------------------------------

test('an object drawn inside a form, or on a layer, refuses for that reason and not a vaguer one', async () => {
  const page = (await analyzed('objects')).pages[0];
  const images = objectsOfKind(page, 'image');

  const inForm = images.find((o) => o.ref.stream !== 'page');
  assert.ok(inForm, 'the fixture draws an image inside /Fm1');
  for (const verb of VERBS) assert.equal(inForm.capabilities[verb], 'form', verb);

  const layered = images.filter((o) => o.record.oc);
  assert.equal(layered.length, 3, 'the fixture draws three images on layers');
  for (const o of layered) {
    for (const verb of VERBS) assert.equal(o.capabilities[verb], 'layer', `${o.ref.key} ${verb}`);
  }
  // A visible layer refuses just as a hidden one does: edited content leaves the layer either way.
  assert.deepEqual([...new Set(layered.map((o) => o.record.oc.hidden))].sort(), [false, true]);

  // Everything else on this page has no structural reason, so it says plainly that the verb has no
  // writer yet rather than borrowing someone else's excuse.
  const plain = images.filter((o) => o.ref.stream === 'page' && !o.record.oc);
  assert.ok(plain.length > 5);
  for (const o of plain) assert.equal(o.capabilities.move, 'unsupported', o.ref.key);
});

test('the refusal rule itself: precedence, including branches no fixture draws', async () => {
  // No fixture draws an image or a path through a graphics-state soft mask, so that branch is
  // tested here directly rather than by pretending a fixture covers it.
  const clean = { tainted: false, unbalanced: false };
  const onPage = { stream: 'page' };
  const caps = (analysis, record, ref) => capabilitiesFor(analysis, 'image', record, ref).move;

  assert.equal(caps(clean, { oc: null, softMask: { name: 'Mask' } }, onPage), 'soft-mask');
  assert.equal(caps(clean, { oc: null, softMask: null }, onPage), 'unsupported');
  // Object-level precedence: where it is drawn, then its layer, then its soft mask.
  assert.equal(caps(clean, { oc: { hidden: false }, softMask: { name: 'Mask' } }, onPage), 'layer');
  assert.equal(caps(clean, { oc: { hidden: false }, softMask: null }, { stream: '7 0 R' }), 'form');
  // A page that can't be rewritten at all beats every object-level reason.
  assert.equal(caps({ tainted: false, unbalanced: true }, { oc: { hidden: false } }, { stream: '7 0 R' }), 'structure');
  assert.equal(caps({ tainted: true, unbalanced: false }, { oc: { hidden: false } }, { stream: '7 0 R' }), 'unreadable');
});

test('a page whose content is unbalanced refuses every verb on every object', async () => {
  const page = (await analyzed('constructs')).pages[3];
  assert.equal(page.unbalanced, true, 'the fixture leaves a stray Q on this page');
  const objects = objectsOf(page);
  assert.ok(objects.length > 0);
  for (const o of objects) {
    for (const verb of VERBS) assert.equal(o.capabilities[verb], 'structure', `${o.ref.key} ${verb}`);
  }
});

// ---- 4. it changes nothing ------------------------------------------------------------------------

test('building capabilities does not touch run.editable or run.reasons', async () => {
  // A fresh analysis, so nothing has been built for it yet: snapshot, build every object, compare.
  const d = await analyzeFile(read('constructs'));
  const snapshot = (a) => a.pages.map((p) => p.runs.map((r) => [r.text, r.editable, [...r.reasons]]));
  const before = snapshot(d);
  for (const page of d.pages) objectsOf(page);
  assert.deepEqual(snapshot(d), before, 'the analysis was modified while capabilities were worked out');
});

test('capabilities are frozen, and the same every time they are worked out', async () => {
  const page = (await analyzed('objects')).pages[0];
  const [first] = objectsOf(page);
  assert.ok(Object.isFrozen(first.capabilities));
  assert.throws(() => { first.capabilities.move = true; }, TypeError);
  const a = pageObjects(page).map((o) => [o.ref.key, o.capabilities]);
  const b = pageObjects(page).map((o) => [o.ref.key, o.capabilities]);
  assert.deepEqual(a, b, 'capability computation is not pure');
});

// ---- 5. and it costs the compose path nothing ------------------------------------------------------

/** The relative imports of one module. */
const importsOf = (file) => [...fs.readFileSync(file, 'utf8').matchAll(/from\s*['"]([^'"]+)['"]/g)]
  .map((m) => m[1]).filter((s) => s.startsWith('.'));

/** Every module reachable from an entry point by following relative imports. */
function reachable(entry) {
  const seen = new Set();
  const queue = [entry];
  while (queue.length) {
    const file = queue.pop();
    if (seen.has(file) || !fs.existsSync(file)) continue;
    seen.add(file);
    for (const spec of importsOf(file)) queue.push(path.resolve(path.dirname(file), spec));
  }
  return seen;
}

test('the compose path never reaches the object model or its capabilities', async () => {
  // Phase 1 keeps this cost off every save, and off every document that is merely saved rather than
  // selected in. Checked through the whole import graph, not just the writer's own first line.
  const js = path.join(WEB, 'js');
  for (const entry of [path.join(js, 'annotations', 'persist.js'), path.join(js, 'editing', 'page-writer.js')]) {
    const modules = [...reachable(entry)];
    // The walk must really be finding things, or this test would pass by doing nothing.
    assert.ok(modules.some((f) => f.endsWith(`editing${path.sep}page-writer.js`)), `${entry}: walk found no writer`);
    assert.ok(modules.some((f) => f.endsWith(`objects${path.sep}text-run.js`)), `${entry}: walk found no text handler`);
    for (const file of modules) {
      assert.ok(!file.endsWith('page-objects.js'), `${entry} reaches the object model via ${file}`);
      assert.ok(!file.endsWith('capabilities.js'), `${entry} reaches capability computation via ${file}`);
    }
  }
});
