// Batch processing: one operation (operations/registry.js) over many files. No UI and no bridge here — the
// dialog (ui/batch.js) shows it and batch/actions.js gives it the host (env) — so it is tested in Node, and
// Vellum Flow can run its steps the same way.
//
// The rules:
//   one at a time      files run in the order they were added, one after another. Conversions already run one
//                      at a time on the host (one Office instance of Vellum's own), and the page's operations
//                      share one JavaScript thread, so running two at once would only race; it never helps
//   each on its own    every file gets its own abort signal and its own result; an error, a refusal or a
//                      timeout in one never changes another. An exception is reported without its text
//                      (kept as diagnostics), a refusal in the operation's own words
//   names planned      each output's name is fixed before anything runs: never a source of this batch, never
//                      another output of it ("report.pdf", "report (2).pdf"). What is already on disk is the
//                      person's choice, asked once: replace it, or keep both (the host numbers the name)
//   stopping           Stop starts nothing new and stops the file that is running; it ends as the operation
//                      reports it (a file written just before is written, and says so), or, if it doesn't end
//                      within a grace period, as stopped. Files never started say so. Nothing stopped is a success
//   time limit         each operation says how long one file may take; past it the file is stopped the same way
//                      and reported as timed out
//   no provider left   an outcome with stopBatch (Office gone from this PC) skips the rest, with the reason
//
// A batch is its items: { id, input, output, status, result }. status: waiting, running, succeeded, failed,
// skipped, cancelled or timedOut; result: the operation's outcome (operations/registry.js) with elapsedMs.

import { outcome } from '../operations/registry.js';

/** Files one batch holds at most (the host's batch.choose gives no more either). */
export const MAX_FILES = 1000;
/** How long a stopped file may take to end before it is left behind. */
export const GRACE_MS = 15_000;

export const FINAL = Object.freeze(['succeeded', 'failed', 'skipped', 'cancelled', 'timedOut']);

const folderOf = (path) => String(path).slice(0, Math.max(0, String(path).lastIndexOf('\\')));
const keyOf = (folder, name) => `${folder}\\${name}`.toLowerCase();
const splitName = (name) => { const m = /^(.*?)(\.[^.\\]*)?$/.exec(name); return [m[1], m[2] ?? '']; };

/**
 * `files` added to `list` ({ token, path, name, size, url }, as batch.choose describes them): new ones at the end,
 * in order; one whose path is already there (any case), or that comes twice, is left out. Never more than
 * MAX_FILES. Returns { list, added, duplicates, over }.
 */
export function addFiles(list, files) {
  const seen = new Set(list.map((f) => f.path.toLowerCase()));
  const next = [...list];
  let duplicates = 0;
  let over = 0;
  for (const file of files ?? []) {
    if (!file?.path || !file?.name) continue;
    const key = file.path.toLowerCase();
    if (seen.has(key)) { duplicates++; continue; }
    if (next.length >= MAX_FILES) { over++; continue; }
    seen.add(key);
    next.push(file);
  }
  return { list: next, added: next.length - list.length, duplicates, over };
}

/**
 * The batch: one item per file, in order. A file the operation doesn't take, or can't take on this PC now
 * (operation.refusal, from `presence`), is skipped with the reason and never run. The others are waiting, each
 * with the output it will write: in the chosen folder (destination { mode: 'folder', folder }) or beside its
 * source ({ mode: 'beside' }), under a name no source and no other output of the batch has.
 */
export function planBatch({ operation, files, destination = { mode: 'beside' }, presence = {} }) {
  const taken = new Set(files.map((f) => f.path.toLowerCase()));
  return files.map((input, index) => {
    const id = index + 1;
    if (!operation.accepts(input.name)) return item(id, input, null, 'skipped', outcome('skipped', { code: 'unsupported', message: operation.unsupported }));
    const refusal = operation.refusal(input, { presence });
    if (refusal) return item(id, input, null, 'skipped', outcome('skipped', { code: 'unavailable', message: refusal }));
    const folder = destination.mode === 'folder' && destination.folder ? destination.folder : folderOf(input.path);
    return item(id, input, { folder, name: freeName(folder, operation.outputName(input.name), taken) }, 'waiting', null);
  });
}

const item = (id, input, output, status, result) => ({ id, input, output, status, result });

/** `name` in `folder`, or "name (2).ext", …: the first not in `taken`, which it joins. */
function freeName(folder, name, taken) {
  const [stem, extension] = splitName(name);
  for (let i = 1; ; i++) {
    const candidate = i === 1 ? name : `${stem} (${i})${extension}`;
    const key = keyOf(folder, candidate);
    if (!taken.has(key)) {
      taken.add(key);
      return candidate;
    }
  }
}

/** The outputs of waiting items, by folder: what to ask the host about before starting ({ folder: [names] }). */
export function plannedOutputs(items) {
  const byFolder = new Map();
  for (const it of items) {
    if (it.status !== 'waiting' || !it.output) continue;
    if (!byFolder.has(it.output.folder)) byFolder.set(it.output.folder, []);
    byFolder.get(it.output.folder).push(it.output.name);
  }
  return byFolder;
}

const inProgress = new WeakSet();

/**
 * Runs the waiting items (only those in `only`, a Set of ids, when given), one after another, and resolves the
 * summary. `env({ signal, progress })` gives an operation what it reaches the host through for one file;
 * `signal` stops the batch; onItem(item) is called whenever an item changes. overwrite: 'replace' or 'keepBoth'.
 * The same items can't run twice at once.
 */
export async function runBatch(items, { operation, params, overwrite = 'keepBoth', env, signal = null, onItem = null, only = null, graceMs = GRACE_MS }) {
  if (inProgress.has(items)) throw new Error('This batch is already running.');
  inProgress.add(items);
  const changed = (it) => { try { onItem?.(it); } catch { /* the display's problem, never the batch's */ } };
  try {
    const checked = operation.checkParams(params);
    let stopReason = null;
    for (const it of items) {
      if (it.status !== 'waiting' || (only && !only.has(it.id))) continue;
      if (signal?.aborted) {
        finish(it, outcome('cancelled', { code: 'notStarted', message: 'Not started: the batch was stopped.' }), 0);
      } else if (stopReason) {
        finish(it, outcome('skipped', { code: 'notStarted', message: `Not started. ${stopReason}` }), 0);
      } else {
        it.status = 'running';
        it.progress = null;
        changed(it);
        const result = await runItem(operation, it, { params: checked, overwrite, env, signal, graceMs, changed });
        finish(it, result, result.elapsedMs);
        if (result.stopBatch && result.status !== 'succeeded') stopReason = result.message;
      }
      changed(it);
    }
    return summarize(items);
  } finally {
    inProgress.delete(items);
  }
}

function finish(it, result, elapsedMs) {
  it.status = result.status;
  it.progress = null;
  it.result = Object.freeze({ ...result, elapsedMs });
}

const ABANDONED = Symbol('abandoned');

function runItem(operation, it, { params, overwrite, env, signal, graceMs, changed }) {
  const progress = (label) => {
    if (it.status !== 'running') return;
    it.progress = typeof label === 'string' ? label : null;
    changed(it);
  };
  return runOperation(operation, { input: it.input, output: it.output, params, overwrite }, { env, signal, graceMs, progress });
}

/**
 * One operation on one file (`job`, as operations/registry.js describes it), with the operation's own time limit:
 * resolves what it came to, judged (judge()), with elapsedMs. `signal` stops it; past graceMs after a stop or the
 * time limit it is left behind. A batch runs each file with it, and a workflow (flow/runner.js) each step.
 */
export async function runOperation(operation, job, { env, signal = null, graceMs = GRACE_MS, progress = null }) {
  const controller = new AbortController();
  let why = null; // 'cancelled' (stopped from outside) or 'timedOut'
  const stop = (reason) => {
    if (why) return;
    why = reason;
    controller.abort();
  };
  const onStop = () => stop('cancelled');
  if (signal?.aborted) stop('cancelled');
  signal?.addEventListener('abort', onStop, { once: true });
  const limit = setTimeout(() => stop('timedOut'), operation.timeoutMs);
  let grace = null;
  // A file that doesn't end within graceMs of being stopped is left behind; what it reports later is not used.
  const abandoned = new Promise((resolve) => {
    const wait = () => { grace = setTimeout(() => resolve(ABANDONED), graceMs); };
    if (controller.signal.aborted) wait();
    else controller.signal.addEventListener('abort', wait, { once: true });
  });
  const started = Date.now();
  let settled;
  try {
    const work = Promise.resolve().then(() => operation.run(job, env({ signal: controller.signal, progress: progress ?? (() => {}) })));
    settled = await Promise.race([work, abandoned]);
  } catch (err) {
    settled = { thrown: err };
  } finally {
    clearTimeout(limit);
    clearTimeout(grace);
    signal?.removeEventListener('abort', onStop);
  }
  return { ...judge(settled, why, operation), elapsedMs: Date.now() - started };
}

const within = (ms) => (ms >= 60_000 ? `${Math.round(ms / 60_000)} min` : `${Math.round(ms / 1000)} s`);

/** What one file's run comes to, honestly: never a success without a file, never a stop reported as anything else. */
export function judge(settled, why, operation) {
  const tooLong = `It took longer than ${within(operation.timeoutMs)}, so Vellum stopped it.`;
  if (settled === ABANDONED || settled?.thrown !== undefined) {
    if (why === 'timedOut') return outcome('timedOut', { code: 'timeLimit', message: tooLong });
    if (why === 'cancelled') return outcome('cancelled', { code: 'stopped', message: 'Stopped before it finished.' });
    const err = settled.thrown;
    return outcome('failed', { code: 'error', message: 'Vellum couldn’t finish this file.', diagnostics: String(err?.stack ?? err) });
  }
  if (!settled || !FINAL.includes(settled.status)) {
    return outcome('failed', { code: 'error', message: 'Vellum couldn’t finish this file.', diagnostics: `An outcome Vellum doesn’t know: ${JSON.stringify(settled)}` });
  }
  // A success has its file: written (a path), or held in memory for a workflow's next step.
  if (settled.status === 'succeeded' && !settled.output?.path && !(settled.output?.held && settled.output.bytes)) {
    return outcome('failed', { ...settled, code: 'noOutput', message: 'It finished without a file to show, so it isn’t counted as done.' });
  }
  // The operation stopped because its time was up: say that, and keep what it said about the file.
  if (settled.status === 'cancelled' && why === 'timedOut') return outcome('timedOut', { ...settled, code: 'timeLimit', message: `${tooLong} Nothing was saved.` });
  return outcome(settled.status, settled);
}

/**
 * How a batch stands: a count per status, and the outcome — nothing (nothing ran), done (every file that ran
 * succeeded), partial, failed (none did) or stopped (the person stopped it).
 */
export function summarize(items) {
  const count = { total: items.length, waiting: 0, running: 0, succeeded: 0, failed: 0, skipped: 0, cancelled: 0, timedOut: 0 };
  for (const it of items) count[it.status]++;
  const ran = count.succeeded + count.failed + count.cancelled + count.timedOut;
  const outcome = ran === 0 ? 'nothing'
    : count.cancelled > 0 ? 'stopped'
      : count.failed + count.timedOut === 0 ? 'done'
        : count.succeeded > 0 ? 'partial' : 'failed';
  return Object.freeze({ ...count, outcome });
}

/** Items that can run again: failed, stopped, timed out, or never started because of another's failure. */
export const retryable = (items) => items.filter((it) => ['failed', 'cancelled', 'timedOut'].includes(it.status)
  || (it.status === 'skipped' && it.result?.code === 'notStarted'));

/** Puts `items` back to waiting, keeping their planned outputs (none was written). Returns their ids. */
export function resetForRetry(items) {
  const ids = new Set();
  for (const it of retryable(items)) {
    it.status = 'waiting';
    it.result = null;
    it.progress = null;
    ids.add(it.id);
  }
  return ids;
}
