// Running workflows (web/js/flow/runner.js): the steps in order on one file, each file handed to the next in
// memory and only the last written; a step that fails, is skipped, stopped or past its time ends the file with
// that outcome in that step's words and writes nothing; Stop starts no further step; a workflow runs on many
// files as a batch (batch/engine.js), partial results and Try again included; and real operations chained
// (Office → PDF held, page numbers, watermark, compress). Fake operations and hosts: no app, no Office.
// Run: node --test "tests/flow/*.test.mjs"

import test from 'node:test';
import assert from 'node:assert/strict';
import { loadPdfLib, openWithPdfjs, webModule } from '../editing/harness.mjs';

const { workflowOperation, fileSafe } = await webModule('flow/runner.js');
const { planBatch, runBatch, resetForRetry } = await webModule('batch/engine.js');
const { outcome, OPERATIONS } = await webModule('operations/registry.js');

const enc = (s) => new TextEncoder().encode(s);
const dec = (b) => new TextDecoder().decode(b);
const file = (path) => ({ token: `t-${path}`, path, name: path.slice(path.lastIndexOf('\\') + 1), size: 1, url: `https://app.vellum/doc/${path}` });

/** A fake PDF operation: appends `tag` to the bytes it reads and writes them; `behave` may replace that. */
function fakeOp(id, tag, { log = [], behave = null, ...extra } = {}) {
  return {
    id, name: id, step: `Step ${tag}`, verb: `Doing ${tag}`, noun: 'PDF', about: '', accept: 'pdf', makes: 'pdf',
    accepts: (name) => /\.pdf$/i.test(name), unsupported: 'Not a PDF.', outputName: (name) => name.replace(/\.pdf$/i, ` (${tag}).pdf`),
    params: {}, choices: [], checkParams: (p) => ({ ...p }), timeoutMs: 60_000, refusal: () => null,
    async run(job, env) {
      log.push([id, job.input.name, job.output.held ? 'held' : job.output.folder]);
      if (behave) return behave(job, env);
      const bytes = await env.readFile(job.input);
      const written = await env.writeFile({ folder: job.output.folder, name: job.output.name, overwrite: job.overwrite }, enc(`${dec(bytes)}+${tag}`));
      return outcome('succeeded', { output: written, note: `${tag} done`, details: [`${tag} detail`] });
    },
    ...extra,
  };
}

/** A fake host env: files read as their names, writes kept in `written`. */
function hostEnv(written = []) {
  return ({ signal, progress }) => ({
    signal, progress,
    readFile: async (input) => enc(input.name),
    writeFile: async (target, bytes) => { written.push({ ...target, text: dec(bytes) }); return { name: target.name, path: `${target.folder}\\${target.name}` }; },
  });
}

const registry = (...ops) => new Map(ops.map((op) => [op.id, op]));
const flow = (ids, name = 'Tidy up') => ({ id: 'w1', name, steps: ids.map((op) => ({ op, params: {} })) });

async function runOne(operation, { written = [], signal = null, onItem = null } = {}) {
  const items = planBatch({ operation, files: [file('C:\\in\\report.pdf')] });
  const summary = await runBatch(items, { operation, params: {}, env: hostEnv(written), signal, onItem });
  return { items, summary, written, result: items[0].result };
}

test('the workflow as an operation: named for the workflow, its first step’s files, one output per file', () => {
  const ops = registry(fakeOp('a', 'A'), fakeOp('b', 'B'));
  const op = workflowOperation(flow(['a', 'b'], 'Client: copy?'), { operations: ops });
  assert.deepEqual([op.id, op.name, op.accept, op.makes, op.noun], ['workflow:w1', 'Client: copy?', 'pdf', 'pdf', 'PDF']);
  assert.equal(op.outputName('report.pdf'), 'report (Client copy).pdf', 'no character Windows refuses in a name');
  assert.equal(op.timeoutMs >= 120_000, true, 'at least every step’s own limit');
  assert.deepEqual([fileSafe('...'), fileSafe(' a  b. ')], ['workflow', 'a b']);
  assert.throws(() => workflowOperation(flow(['a', 'nope']), { operations: ops }), /Step 2: This step isn’t available/);
  assert.throws(() => workflowOperation(flow([]), { operations: ops }), /Add at least one step/);
});

test('steps run in order, each on the file the one before made, in memory; only the last writes', async () => {
  const log = [];
  const ops = registry(fakeOp('a', 'A', { log }), fakeOp('b', 'B', { log }), fakeOp('c', 'C', { log }));
  const progress = [];
  const { result, summary, written, items } = await runOne(workflowOperation(flow(['a', 'b', 'c']), { operations: ops }),
    { onItem: (it) => { if (it.progress) progress.push(it.progress); } });
  assert.equal(result.status, 'succeeded', result.message);
  assert.deepEqual(log, [['a', 'report.pdf', 'held'], ['b', 'report (A).pdf', 'held'], ['c', 'report (A) (B).pdf', 'C:\\in']]);
  assert.deepEqual(written, [{ folder: 'C:\\in', name: 'report (Tidy up).pdf', overwrite: 'keepBoth', text: 'report.pdf+A+B+C' }]);
  assert.deepEqual([result.output.path, result.note], ['C:\\in\\report (Tidy up).pdf', 'A done · B done · C done']);
  assert.deepEqual(result.details, ['A detail', 'B detail', 'C detail']);
  assert.equal(summary.outcome, 'done');
  assert.ok(progress.includes('Step 1 of 3 · Doing A…') && progress.includes('Step 3 of 3 · Doing C…'), JSON.stringify(progress));
  assert.equal(items[0].status, 'succeeded');
});

test('a step that fails ends the file in its own words: nothing after it runs, nothing is written', async () => {
  const log = [];
  const ops = registry(fakeOp('a', 'A', { log }),
    fakeOp('b', 'B', { log, behave: () => outcome('failed', { code: 'refused', message: 'This PDF is protected.', details: ['why'] }) }),
    fakeOp('c', 'C', { log }));
  const { result, written, summary } = await runOne(workflowOperation(flow(['a', 'b', 'c']), { operations: ops }));
  assert.deepEqual([result.status, result.code, result.message], ['failed', 'refused', 'Step 2, Step B: This PDF is protected.']);
  assert.deepEqual([log.map((l) => l[0]), written, result.output], [['a', 'b'], [], null]);
  assert.deepEqual(result.details, ['A detail', 'why']);
  assert.equal(summary.outcome, 'failed');
});

test('skipped, a stop for the whole batch, an error and a success without a file are each said as they are', async () => {
  const skip = registry(fakeOp('a', 'A'), fakeOp('b', 'B', { behave: () => outcome('skipped', { message: 'Not this one.' }) }));
  assert.equal((await runOne(workflowOperation(flow(['a', 'b']), { operations: skip }))).result.status, 'skipped');

  const gone = registry(fakeOp('a', 'A', { behave: () => outcome('failed', { message: 'No Office.', stopBatch: true }) }), fakeOp('b', 'B'));
  const op = workflowOperation(flow(['a', 'b']), { operations: gone });
  const items = planBatch({ operation: op, files: [file('C:\\in\\1.pdf'), file('C:\\in\\2.pdf')] });
  await runBatch(items, { operation: op, params: {}, env: hostEnv() });
  assert.deepEqual(items.map((it) => it.status), ['failed', 'skipped']);
  assert.match(items[1].result.message, /^Not started\. Step 1, Step A: No Office\./);

  const thrown = registry(fakeOp('a', 'A'), fakeOp('b', 'B', { behave: () => { throw new Error('secret internals'); } }));
  const error = (await runOne(workflowOperation(flow(['a', 'b']), { operations: thrown }))).result;
  assert.deepEqual([error.status, error.message], ['failed', 'Step 2, Step B: Vellum couldn’t finish this file.']);
  assert.match(error.diagnostics, /secret internals/);

  const empty = registry(fakeOp('a', 'A'), fakeOp('b', 'B', { behave: () => outcome('succeeded', { output: null }) }));
  const none = (await runOne(workflowOperation(flow(['a', 'b']), { operations: empty }))).result;
  assert.deepEqual([none.status, none.code], ['failed', 'noOutput']);
});

test('a step past its own time limit is stopped and reported as timed out; nothing after it runs', async () => {
  const log = [];
  const ops = registry(fakeOp('a', 'A', { log, timeoutMs: 30, behave: (job, env) => new Promise(() => {}) }), fakeOp('b', 'B', { log }));
  const op = workflowOperation(flow(['a', 'b']), { operations: ops, graceMs: 20 });
  const { result, written } = await runOne(op);
  assert.deepEqual([result.status, result.code, log.length, written.length], ['timedOut', 'timeLimit', 1, 0]);
  assert.match(result.message, /^Step 1, Step A: It took longer than 0 s/);
});

test('Stop during a step stops it, starts no other, and writes nothing; files not started say so', async () => {
  const log = [];
  const controller = new AbortController();
  const ops = registry(
    fakeOp('a', 'A', { log, behave: (job, env) => new Promise((resolve) => {
      setTimeout(() => controller.abort(), 10);
      env.signal.addEventListener('abort', () => resolve(outcome('cancelled', { message: 'Stopped before it finished. Nothing was saved.' })));
    }) }),
    fakeOp('b', 'B', { log }));
  const op = workflowOperation(flow(['a', 'b']), { operations: ops });
  const written = [];
  const items = planBatch({ operation: op, files: [file('C:\\in\\1.pdf'), file('C:\\in\\2.pdf')] });
  const summary = await runBatch(items, { operation: op, params: {}, env: hostEnv(written), signal: controller.signal });
  assert.deepEqual(items.map((it) => it.status), ['cancelled', 'cancelled']);
  assert.equal(items[0].result.message, 'Step 1, Step A: Stopped before it finished. Nothing was saved.');
  assert.match(items[1].result.message, /Not started/);
  assert.deepEqual([log.length, written.length, summary.outcome], [1, 0, 'stopped']);
});

test('many files: each on its own, a partial result, and Try again runs only what didn’t finish', async () => {
  let fail = true;
  const ops = registry(fakeOp('a', 'A'), fakeOp('b', 'B', { behave: async (job, env) => {
    if (fail && job.input.name.startsWith('2')) return outcome('failed', { message: 'Bad page.' });
    const bytes = await env.readFile(job.input);
    return outcome('succeeded', { output: await env.writeFile({ ...job.output, overwrite: job.overwrite }, bytes) });
  } }));
  const op = workflowOperation(flow(['a', 'b']), { operations: ops });
  const written = [];
  const items = planBatch({ operation: op, files: ['1', '2', '3'].map((n) => file(`C:\\in\\${n}.pdf`)) });
  const first = await runBatch(items, { operation: op, params: {}, env: hostEnv(written) });
  assert.deepEqual([items.map((it) => it.status), first.outcome, written.length], [['succeeded', 'failed', 'succeeded'], 'partial', 2]);
  fail = false;
  const again = resetForRetry(items);
  assert.deepEqual([...again], [2]);
  const second = await runBatch(items, { operation: op, params: {}, env: hostEnv(written), only: again });
  assert.deepEqual([items.map((it) => it.status), second.outcome, written.map((w) => w.name)],
    [['succeeded', 'succeeded', 'succeeded'], 'done', ['1 (Tidy up).pdf', '3 (Tidy up).pdf', '2 (Tidy up).pdf']]);
});

test('real operations: Office → PDF held, then page numbers, a watermark and Compress; one file written', async () => {
  const lib = await loadPdfLib();
  const doc = await lib.PDFDocument.create({ updateMetadata: false });
  for (let i = 0; i < 2; i++) doc.addPage([612, 792]).drawText(`Body ${i + 1}`, { x: 40, y: 400, size: 12 });
  const converted = await doc.save({ useObjectStreams: false });

  const sent = [];
  const host = { request: async (type, payload) => {
    sent.push(type);
    if (type === 'batch.office') {
      assert.deepEqual(payload, { source: 't-C:\\in\\Report.docx', name: 'Report.pdf', hold: true });
      return { status: 'converted', message: 'Converted.', provider: 'msoffice', providerName: 'Microsoft Office', output: { name: 'Report.pdf', path: 'C:\\data\\flow-work\\x\\Report.pdf', token: 'held', url: 'https://app.vellum/doc/held' } };
    }
    return {};
  } };
  const written = [];
  const env = ({ signal, progress }) => ({
    signal, progress, host, pdfLib: loadPdfLib,
    readFile: async (input) => { assert.equal(input.url, 'https://app.vellum/doc/held', 'only the held PDF is read from the host'); return converted; },
    writeFile: async (target, bytes) => { written.push({ target, bytes }); return { name: target.name, path: `${target.folder}\\${target.name}` }; },
  });
  const workflow = { id: 'w9', name: 'Client copy', steps: [
    { op: 'office.toPdf', params: {} },
    { op: 'pdf.pageNumbers', params: { format: 'Page {n} of {total}', style: 'arabic', position: 'bottom-center' } },
    { op: 'pdf.watermark', params: { text: 'CLIENT COPY', position: 'center', angle: 'level' } },
    { op: 'pdf.compress', params: { level: 'smaller' } },
  ] };
  const op = workflowOperation(workflow, { presence: { 'engine.office': true, 'engine.office.word': true } });
  const items = planBatch({ operation: op, files: [file('C:\\in\\Report.docx'), file('C:\\in\\notes.pdf')], presence: { 'engine.office.word': true } });
  assert.deepEqual(items.map((it) => it.status), ['waiting', 'skipped'], 'a PDF isn’t what this workflow starts from');
  const summary = await runBatch(items, { operation: op, params: {}, env });
  assert.equal(items[0].status, 'succeeded', items[0].result.message);
  assert.deepEqual([summary.outcome, written.length, written[0].target.name, sent], ['done', 1, 'Report (Client copy).pdf', ['batch.office', 'batch.release']]);
  assert.match(items[0].result.note, /^Converted with Microsoft Office · Numbered on 2 pages · Watermarked on 2 pages · /);
  const js = await openWithPdfjs(written[0].bytes);
  try {
    const text = (await (await js.doc.getPage(2)).getTextContent()).items.map((i) => i.str).join(' ');
    assert.ok(text.includes('Body 2') && text.includes('Page 2 of 2') && text.includes('CLIENT COPY'), text);
  } finally {
    await js.close();
  }
  assert.ok(OPERATIONS.has('pdf.compress'));
});
