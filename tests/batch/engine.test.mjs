// Batch processing's engine (web/js/batch/engine.js): files added once each, outputs planned so that nothing a
// batch writes is a source or another output of it, one file at a time in order, each file's result its own,
// Stop and time limits reported honestly, a missing provider stopping what can't succeed, retries, and the
// summary. Fake operations stand in for real ones: no app, no host, no Office.
// Run: node --test "tests/batch/*.test.mjs"

import test from 'node:test';
import assert from 'node:assert/strict';
import { webModule } from '../editing/harness.mjs';

const { MAX_FILES, addFiles, planBatch, plannedOutputs, runBatch, summarize, retryable, resetForRetry } = await webModule('batch/engine.js');
const { outcome, operation } = await webModule('operations/registry.js');

const file = (path) => ({ token: `t-${path}`, path, name: path.slice(path.lastIndexOf('\\') + 1), size: 1, url: `https://app.vellum/doc/${path}` });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A fake operation over .pdf files: `behave(job, env)` decides each file; it writes nothing anywhere. */
function fake(behave, extra = {}) {
  return {
    id: 'test.op', name: 'Test', verb: 'Testing', noun: 'PDF', accept: 'pdf', about: '',
    accepts: (name) => /\.pdf$/i.test(name), unsupported: 'Not a PDF.',
    outputName: (name) => name.replace(/\.pdf$/i, ' (done).pdf'),
    params: {}, choices: [], checkParams: (p) => p ?? {}, timeoutMs: 60_000, refusal: () => null,
    run: behave, ...extra,
  };
}
const done = (job) => outcome('succeeded', { message: 'Done.', output: { name: job.output.name, path: `${job.output.folder}\\${job.output.name}` } });
const env = ({ signal, progress }) => ({ signal, progress });
const statuses = (items) => items.map((it) => it.status);

test('adding files: each path once (any case), in order, and never more than the limit', () => {
  const a = file('C:\\in\\a.pdf');
  let { list, added, duplicates } = addFiles([], [a, file('C:\\in\\b.pdf'), file('C:\\IN\\A.PDF')]);
  assert.deepEqual([list.map((f) => f.name), added, duplicates], [['a.pdf', 'b.pdf'], 2, 1]);
  ({ list, added, duplicates } = addFiles(list, [a, { path: '', name: '' }, null, file('C:\\in\\c.pdf')]));
  assert.deepEqual([list.map((f) => f.name), added, duplicates], [['a.pdf', 'b.pdf', 'c.pdf'], 1, 1]);
  const many = Array.from({ length: MAX_FILES + 5 }, (_, i) => file(`C:\\in\\${i}.pdf`));
  const full = addFiles([], many);
  assert.deepEqual([full.list.length, full.over], [MAX_FILES, 5]);
});

test('planning: unsupported files are skipped with the reason; outputs go beside each file by default', () => {
  const op = fake(done);
  const items = planBatch({ operation: op, files: [file('C:\\in\\a.pdf'), file('C:\\in\\notes.txt'), file('D:\\other\\b.pdf')] });
  assert.deepEqual(statuses(items), ['waiting', 'skipped', 'waiting']);
  assert.deepEqual(items[1].result.code, 'unsupported');
  assert.equal(items[1].result.message, 'Not a PDF.');
  assert.deepEqual(items.map((it) => it.output), [{ folder: 'C:\\in', name: 'a (done).pdf' }, null, { folder: 'D:\\other', name: 'b (done).pdf' }]);
  assert.deepEqual([...plannedOutputs(items)], [['C:\\in', ['a (done).pdf']], ['D:\\other', ['b (done).pdf']]]);
  assert.deepEqual(planBatch({ operation: op, files: [] }), []);
});

test('planning: no output is another output or any source of the batch, whatever the case; names keep Unicode and spaces', () => {
  const office = operation('office.toPdf');
  const presence = { 'engine.office.word': true, 'engine.office.excel': true, 'engine.office.powerpoint': true };
  const same = planBatch({ operation: office, presence, files: [file('C:\\in\\Report.docx'), file('C:\\in\\report.doc'), file('C:\\in\\REPORT.xlsx')] });
  assert.deepEqual(same.map((it) => it.output.name), ['Report.pdf', 'report (2).pdf', 'REPORT (3).pdf']);

  const compress = operation('pdf.compress');
  const sources = planBatch({ operation: compress, files: [file('C:\\in\\a.pdf'), file('C:\\in\\a (compressed).pdf')] });
  assert.deepEqual(sources.map((it) => it.output.name), ['a (compressed) (2).pdf', 'a (compressed) (compressed).pdf']);

  const folder = planBatch({ operation: compress, destination: { mode: 'folder', folder: 'E:\\out' }, files: [file('C:\\x\\r.pdf'), file('D:\\y\\R.pdf'), file('C:\\x\\Ünïcode résumé 1.pdf')] });
  assert.deepEqual(folder.map((it) => it.output), [
    { folder: 'E:\\out', name: 'r (compressed).pdf' }, { folder: 'E:\\out', name: 'R (compressed) (2).pdf' }, { folder: 'E:\\out', name: 'Ünïcode résumé 1 (compressed).pdf' },
  ]);
});

test('planning: a format nothing on this PC converts is skipped before anything runs', () => {
  const items = planBatch({ operation: operation('office.toPdf'), presence: { 'engine.office.word': true }, files: [file('C:\\in\\a.docx'), file('C:\\in\\b.pptx')] });
  assert.deepEqual(statuses(items), ['waiting', 'skipped']);
  assert.equal(items[1].result.code, 'unavailable');
  assert.match(items[1].result.message, /PowerPoint presentation/);
});

test('running: one file at a time, in order, and each result is its own', async () => {
  const seen = [];
  let active = 0;
  const op = fake(async (job) => {
    active++;
    assert.equal(active, 1, 'never two at once');
    seen.push(job.input.name);
    await sleep(5);
    active--;
    if (job.input.name === 'b.pdf') throw new TypeError('secret internals');
    if (job.input.name === 'c.pdf') return outcome('failed', { code: 'refused', message: 'This PDF is protected.' });
    if (job.input.name === 'd.pdf') return outcome('succeeded', { message: 'Done.' }); // claims success with no file
    return done(job);
  });
  const items = planBatch({ operation: op, files: ['a', 'b', 'c', 'd', 'e'].map((n) => file(`C:\\in\\${n}.pdf`)) });
  const changes = [];
  const summary = await runBatch(items, { operation: op, env, onItem: (it) => changes.push(`${it.input.name}:${it.status}`) });
  assert.deepEqual(seen, ['a.pdf', 'b.pdf', 'c.pdf', 'd.pdf', 'e.pdf']);
  assert.deepEqual(statuses(items), ['succeeded', 'failed', 'failed', 'failed', 'succeeded']);
  assert.equal(changes.slice(0, 4).join(), 'a.pdf:running,a.pdf:succeeded,b.pdf:running,b.pdf:failed');
  // An exception is reported without its text, which is kept for diagnostics.
  assert.equal(items[1].result.code, 'error');
  assert.doesNotMatch(items[1].result.message, /secret/);
  assert.match(items[1].result.diagnostics, /secret internals/);
  assert.equal(items[2].result.message, 'This PDF is protected.');
  assert.equal(items[3].result.code, 'noOutput', 'never a success without a file');
  assert.equal(items[4].result.output.path, 'C:\\in\\e (done).pdf');
  assert.ok(items.every((it) => Object.isFrozen(it.result) && typeof it.result.elapsedMs === 'number'));
  assert.deepEqual({ ...summary }, { total: 5, waiting: 0, running: 0, succeeded: 2, failed: 3, skipped: 0, cancelled: 0, timedOut: 0, outcome: 'partial' });
});

test('stopping: nothing new starts, the running file ends as it reports, the rest say they never started', async () => {
  const controller = new AbortController();
  const op = fake(async (job, e) => {
    if (job.input.name === 'b.pdf') {
      controller.abort(); // Stop pressed while b runs
      await sleep(5);
      return e.signal.aborted ? outcome('cancelled', { message: 'Stopped. Nothing was saved.' }) : done(job);
    }
    return done(job);
  });
  const items = planBatch({ operation: op, files: ['a', 'b', 'c', 'd'].map((n) => file(`C:\\in\\${n}.pdf`)) });
  const summary = await runBatch(items, { operation: op, env, signal: controller.signal });
  assert.deepEqual(statuses(items), ['succeeded', 'cancelled', 'cancelled', 'cancelled']);
  assert.equal(items[1].result.message, 'Stopped. Nothing was saved.');
  assert.deepEqual(items.slice(2).map((it) => it.result.code), ['notStarted', 'notStarted']);
  assert.equal(summary.outcome, 'stopped');

  // A file that finished just as Stop came is written, and says so: it isn't reported as stopped.
  const late = new AbortController();
  const finishing = fake(async (job) => { late.abort(); return done(job); });
  const two = planBatch({ operation: finishing, files: [file('C:\\in\\x.pdf'), file('C:\\in\\y.pdf')] });
  await runBatch(two, { operation: finishing, env, signal: late.signal });
  assert.deepEqual(statuses(two), ['succeeded', 'cancelled']);

  // A file that doesn't end once stopped is left behind after the grace period, as stopped.
  const stuck = new AbortController();
  const ignoring = fake(() => { stuck.abort(); return new Promise(() => {}); });
  const one = planBatch({ operation: ignoring, files: [file('C:\\in\\z.pdf')] });
  await runBatch(one, { operation: ignoring, env, signal: stuck.signal, graceMs: 20 });
  assert.deepEqual([one[0].status, one[0].result.code], ['cancelled', 'stopped']);
});

test('time limit: past it the file is stopped and reported as timed out, whether or not it ends', async () => {
  const honouring = fake((job, e) => new Promise((resolve) => {
    e.signal.addEventListener('abort', () => resolve(outcome('cancelled', { message: 'Cancelled.' })));
  }), { timeoutMs: 20 });
  const ignoring = fake(() => new Promise(() => {}), { timeoutMs: 20 });
  for (const op of [honouring, ignoring]) {
    const items = planBatch({ operation: op, files: [file('C:\\in\\slow.pdf')] });
    const summary = await runBatch(items, { operation: op, env, graceMs: 20 });
    assert.equal(items[0].status, 'timedOut');
    assert.equal(items[0].result.code, 'timeLimit');
    assert.match(items[0].result.message, /took longer than/);
    assert.equal(summary.outcome, 'failed');
  }
});

test('no provider left: the rest of the batch is skipped, with the reason, and can run again later', async () => {
  const op = fake((job) => (job.input.name === 'b.pdf'
    ? outcome('failed', { code: 'noProvider', message: 'Neither Office nor LibreOffice was found.', stopBatch: true })
    : done(job)));
  const items = planBatch({ operation: op, files: ['a', 'b', 'c', 'd'].map((n) => file(`C:\\in\\${n}.pdf`)) });
  const summary = await runBatch(items, { operation: op, env });
  assert.deepEqual(statuses(items), ['succeeded', 'failed', 'skipped', 'skipped']);
  assert.equal(items[2].result.message, 'Not started. Neither Office nor LibreOffice was found.');
  assert.equal(summary.outcome, 'partial');
  assert.deepEqual(retryable(items).map((it) => it.input.name), ['b.pdf', 'c.pdf', 'd.pdf']);
});

test('trying again runs only the files that can run again, with the outputs planned before', async () => {
  let fail = true;
  const runs = [];
  const op = fake((job) => {
    runs.push(job.input.name);
    return job.input.name === 'b.pdf' && fail ? outcome('failed', { message: 'Busy.' }) : done(job);
  });
  const items = planBatch({ operation: op, files: [file('C:\\in\\a.pdf'), file('C:\\in\\b.pdf'), file('C:\\in\\n.txt')] });
  await runBatch(items, { operation: op, env });
  fail = false;
  const only = resetForRetry(items);
  assert.deepEqual([...only], [2]);
  const summary = await runBatch(items, { operation: op, env, only });
  assert.deepEqual(runs, ['a.pdf', 'b.pdf', 'b.pdf']);
  assert.deepEqual(statuses(items), ['succeeded', 'succeeded', 'skipped']);
  assert.equal(items[1].result.output.name, 'b (done).pdf');
  assert.equal(summary.outcome, 'done');
});

test('the summary: nothing, done, failed; a batch can’t run twice at once; bad parameters stop it before any file', async () => {
  const op = fake(done);
  assert.equal(summarize([]).outcome, 'nothing');
  const skippedOnly = planBatch({ operation: op, files: [file('C:\\in\\a.txt')] });
  assert.equal((await runBatch(skippedOnly, { operation: op, env })).outcome, 'nothing');
  const failing = fake(() => outcome('failed', { message: 'No.' }));
  const bad = planBatch({ operation: failing, files: [file('C:\\in\\a.pdf')] });
  assert.equal((await runBatch(bad, { operation: failing, env })).outcome, 'failed');

  const slow = fake(async (job) => { await sleep(10); return done(job); });
  const items = planBatch({ operation: slow, files: [file('C:\\in\\a.pdf')] });
  const first = runBatch(items, { operation: slow, env });
  await assert.rejects(runBatch(items, { operation: slow, env }), /already running/);
  assert.equal((await first).outcome, 'done');

  // A display that throws never changes the batch.
  const shown = planBatch({ operation: op, files: [file('C:\\in\\a.pdf')] });
  assert.equal((await runBatch(shown, { operation: op, env, onItem: () => { throw new Error('paint'); } })).outcome, 'done');

  const compress = operation('pdf.compress');
  const never = fake(() => assert.fail('no file may run'), { checkParams: compress.checkParams });
  await assert.rejects(runBatch(planBatch({ operation: never, files: [file('C:\\in\\a.pdf')] }), { operation: never, params: { level: 'tiny' }, env }), /optimization level/);
});
