// Workflows as data (web/js/flow/model.js): what workflows.json holds, read forgivingly — nothing a person made
// is dropped for naming a step this Vellum doesn't have or for settings that don't check, and a file from a newer
// Vellum is never read (so never written over); written back as plain JSON, the same every time; checked step by
// step (unknown operation, settings, order, this PC); and which operations may come next. No app, no host.
// Run: node --test "tests/flow/*.test.mjs"

import test from 'node:test';
import assert from 'node:assert/strict';
import { webModule } from '../editing/harness.mjs';

const { FORMAT, MAX_STEPS, MAX_WORKFLOWS, readWorkflows, writeWorkflows, checkWorkflow, nextOperations, describeSteps, newWorkflow, newStep, plainParams } = await webModule('flow/model.js');
const { OPERATIONS, operation } = await webModule('operations/registry.js');

const OFFICE = { 'engine.office': true, 'engine.office.word': true };
const clientCopy = () => ({
  id: 'w1', name: 'Client copy',
  steps: [{ op: 'office.toPdf', params: {} }, { op: 'pdf.pageNumbers', params: { format: 'Page {n}', style: 'arabic', position: 'bottom-center' } }, { op: 'pdf.compress', params: { level: 'safe' } }],
});

test('reading: nothing saved is an empty list; a file that isn’t a list is damaged; a newer one isn’t read', () => {
  assert.deepEqual(readWorkflows(null), { workflows: [], dropped: 0, newer: false, damaged: false });
  for (const bad of [42, 'text', [], { workflows: {} }, { v: 1 }]) assert.equal(readWorkflows(bad).damaged, true, JSON.stringify(bad));
  const newer = readWorkflows({ v: FORMAT + 1, workflows: [clientCopy()] });
  assert.deepEqual([newer.newer, newer.workflows.length], [true, 0]);
});

test('reading: entries that aren’t workflows are dropped and counted; the rest are made whole', () => {
  const read = readWorkflows({ v: 1, workflows: [
    clientCopy(), null, 7, 'x',
    { id: 'w1', name: '  Same   id  ', steps: 'no' },
    { id: '../../etc', steps: [{ op: 5, params: [1] }, null, { op: 'pdf.compress', params: { level: 'safe', nested: { a: 1 }, f: 'ok', n: NaN, b: true } }] },
  ] });
  assert.equal(read.dropped, 3);
  assert.equal(read.workflows.length, 3);
  const [first, second, third] = read.workflows;
  assert.deepEqual(first, clientCopy());
  assert.notEqual(second.id, 'w1', 'a repeated id gets a new one');
  assert.deepEqual([second.name, second.steps], ['Same id', []]);
  assert.match(third.id, /^[A-Za-z0-9_-]+$/, 'an id that isn’t one gets a new one');
  assert.equal(third.name, 'Untitled workflow');
  assert.deepEqual(third.steps, [{ op: '', params: {} }, { op: '', params: {} }, { op: 'pdf.compress', params: { level: 'safe', f: 'ok', b: true } }]);
  const many = readWorkflows({ v: 1, workflows: Array.from({ length: MAX_WORKFLOWS + 3 }, (_, i) => ({ id: `w${i}`, name: `W${i}`, steps: [] })) });
  assert.deepEqual([many.workflows.length, many.dropped], [MAX_WORKFLOWS, 3]);
});

test('writing: plain JSON that reads back the same, unknown steps and all', () => {
  const list = [clientCopy(), { id: 'w2', name: 'From the future', steps: [{ op: 'pdf.ocr', params: { language: 'eng' } }] }];
  const data = writeWorkflows(list);
  assert.equal(data.v, FORMAT);
  const text = JSON.stringify(data);
  assert.equal(JSON.stringify(writeWorkflows(readWorkflows(JSON.parse(text)).workflows)), text, 'deterministic round trip');
  assert.deepEqual(readWorkflows(JSON.parse(text)).workflows, list);
  assert.ok(!/[A-Z]:\\\\|token|bytes/.test(text), 'no paths, tokens or file contents in a workflow');
});

test('checking: a workflow that can run, and the parameters each step will run with', () => {
  const checked = checkWorkflow(clientCopy(), { presence: OFFICE });
  assert.deepEqual([checked.runnable, checked.problem], [true, null]);
  assert.deepEqual(checked.steps.map((s) => s.operation.id), ['office.toPdf', 'pdf.pageNumbers', 'pdf.compress']);
  assert.deepEqual({ ...checked.steps[2].params }, { level: 'safe' });
});

test('checking: an unknown operation, bad settings, a wrong order and a missing name each say so, per step', () => {
  const unknown = checkWorkflow({ id: 'a', name: 'A', steps: [{ op: 'pdf.ocr', params: {} }, { op: 'pdf.compress', params: {} }] });
  assert.deepEqual([unknown.runnable, unknown.problem], [false, 'Step 1: This step isn’t available in this version of Vellum.']);
  assert.equal(unknown.steps[1].problem, null, 'the step after an unknown one is checked on its own');

  const settings = checkWorkflow({ id: 'b', name: 'B', steps: [{ op: 'pdf.compress', params: { level: 'tiny' } }] });
  assert.match(settings.problem, /^Step 1: Its settings aren’t valid: “tiny” isn’t an optimization level/);

  const order = checkWorkflow({ id: 'c', name: 'C', steps: [{ op: 'pdf.compress', params: {} }, { op: 'office.toPdf', params: {} }] }, { presence: OFFICE });
  assert.equal(order.problem, 'Step 2: This step takes an Office document, but the step before it makes a PDF.');

  assert.equal(checkWorkflow({ id: 'd', name: '  ', steps: [{ op: 'pdf.compress', params: {} }] }).problem, 'Give the workflow a name.');
  assert.equal(checkWorkflow({ id: 'e', name: 'E', steps: [] }).problem, 'Add at least one step.');
  const long = { id: 'f', name: 'F', steps: Array.from({ length: MAX_STEPS + 1 }, () => newStep(operation('pdf.compress'))) };
  assert.equal(checkWorkflow(long).problem, `A workflow can have at most ${MAX_STEPS} steps.`);
});

test('checking: an Office step on a PC with no Office application can’t run, and says why', () => {
  const none = checkWorkflow(clientCopy(), { presence: {} });
  assert.deepEqual([none.runnable, none.problem], [false, 'Step 1: No Office application on this PC converts documents to PDF.']);
  assert.equal(checkWorkflow(clientCopy()).runnable, true, 'presence not known yet (Node): not held against it');
});

test('next steps: anything first; after that only what takes the file the last step makes; nothing this PC lacks', () => {
  const ids = (list) => list.map((op) => op.id);
  assert.deepEqual(ids(nextOperations({ steps: [] }, { presence: OFFICE })), [...OPERATIONS.keys()]);
  assert.deepEqual(ids(nextOperations({ steps: [] }, { presence: {} })), ['pdf.compress', 'pdf.pageNumbers', 'pdf.watermark']);
  assert.deepEqual(ids(nextOperations(clientCopy(), { presence: OFFICE })), ['pdf.compress', 'pdf.pageNumbers', 'pdf.watermark']);
});

test('describing, new workflows and steps, and parameters as plain data', () => {
  assert.equal(describeSteps(clientCopy()), 'Convert to PDF → Add page numbers → Compress');
  assert.equal(describeSteps({ steps: [{ op: 'nope' }] }), 'A step this Vellum doesn’t have');
  assert.equal(describeSteps({ steps: [] }), 'No steps yet');
  const a = newWorkflow({ name: '  Tidy   up ' });
  const b = newWorkflow();
  assert.ok(a.id && a.id !== b.id);
  assert.deepEqual([a.name, a.steps], ['Tidy up', []]);
  assert.deepEqual(newStep(operation('pdf.watermark')), { op: 'pdf.watermark', params: { text: 'DRAFT', position: 'center', angle: 'diagonal' } });
  assert.deepEqual(plainParams({ a: 'x', b: 2, c: false, d: null, e: {}, f: Infinity }), { a: 'x', b: 2, c: false });
});
