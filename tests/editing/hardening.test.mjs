// Vellum 0.5.0 Phase 0: hardening of the 0.4 text-editing engine (transparency, document profile,
// PDF/A, signatures, thumbnails). Run: node --test "tests/editing/*.test.mjs"

import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { analyzeFile, describeRuns, engine, webModule } from './harness.mjs';
import { makeFixtures, FIXTURE_DIR } from './fixtures.mjs';

const { planTextEdit, EditError } = await engine('edits.js');
const { composeDocument } = await webModule('annotations/persist.js');
const { identityPlan } = await webModule('pages/plan.js');

let files;
before(async () => { files = await makeFixtures(FIXTURE_DIR); });
const read = (name) => new Uint8Array(fs.readFileSync(files[name]));

async function open(bytes) {
  const result = await analyzeFile(bytes);
  return { bytes, result, plan: identityPlan(result.source.pageCount) };
}

const runOf = (d, page, text) => {
  const run = d.result.pages[page].runs.find((r) => r.text === text);
  assert.ok(run, `no run ${JSON.stringify(text)} on page ${page + 1}`);
  return run;
};

function plan(d, page, fromText, toText, extra = {}) {
  return planTextEdit({ run: runOf(d, page, fromText), text: toText, entry: d.plan[page].id, glyphs: d.result.source.glyphs, ...extra });
}

const compose = (d, edits) => composeDocument({ base: d.bytes, plan: d.plan, edits });

// ---- transparency -------------------------------------------------------------------------------

test('soft-mask transparency: text drawn through a soft mask is refused; opacity and blend modes stay editable', async () => {
  const d = await open(read('transparency'));
  const runs = describeRuns(d.result.pages[0]);
  const at = (text) => runs.find((r) => r.text === text);
  assert.deepEqual([at('Masked text').editable, at('Masked text').reasons], [false, ['soft-mask']]);
  for (const text of ['Mask cleared again', 'Half-transparent text', 'Multiplied text', 'Plain text']) {
    assert.deepEqual([at(text).editable, at(text).reasons], [true, []], text);
  }
  assert.throws(() => plan(d, 0, 'Masked text', 'Changed'), (e) => e instanceof EditError && e.kind === 'not-editable');
  // What the interpreter recorded for each line.
  const first = (text) => runOf(d, 0, text).first;
  assert.equal(first('Masked text').softMask, 'Mask');
  assert.equal(first('Mask cleared again').softMask, null);
  assert.deepEqual([first('Half-transparent text').ca, first('Half-transparent text').CA], [0.5, 0.5]);
  assert.equal(first('Multiplied text').blend, 'Multiply');
  assert.deepEqual([first('Plain text').ca, first('Plain text').blend, first('Plain text').softMask], [1, 'Normal', null]);
});

test('edited transparent text keeps its opacity and blend mode', async () => {
  const d = await open(read('transparency'));
  const saved = await compose(d, [plan(d, 0, 'Half-transparent text', 'Still half-transparent'), plan(d, 0, 'Multiplied text', 'Still multiplied')]);
  const reopened = await open(saved);
  const half = runOf(reopened, 0, 'Still half-transparent');
  assert.deepEqual([half.editable, half.first.ca, half.first.CA], [true, 0.5, 0.5]);
  const multiplied = runOf(reopened, 0, 'Still multiplied');
  assert.deepEqual([multiplied.editable, multiplied.first.blend], [true, 'Multiply']);
  // The masked line is untouched and still refused.
  assert.deepEqual(describeRuns(reopened.result.pages[0]).find((r) => r.text === 'Masked text').reasons, ['soft-mask']);
});
