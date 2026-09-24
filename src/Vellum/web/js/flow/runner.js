// Running a workflow (flow/model.js): its steps, one after another, on one file, each the operation itself
// (operations/registry.js) run as a batch runs one — batch/engine.js runOperation, with the step's own time limit,
// Stop and honest outcome. A workflow is presented to batch processing as one operation (workflowOperation), so
// running it on many files is a batch: the same planning, names, one file at a time, Stop, results and Try again.
// Workflow composes operations; batch repeats one; neither imports the other's UI, and batch never imports flow.
//
// The rules for one file:
//   in between     each step's file goes to the next in memory (a held output); only the last step writes, where
//                  the batch planned. An Office step in between is converted into the host's own work folder,
//                  read, and let go (operations/registry.js). The source is only ever read
//   all or nothing the file is done only when every step succeeded and the last wrote its file. A step that fails,
//                  is skipped, stopped or past its time ends the workflow for this file with that outcome, in that
//                  step's words ("Step 2, Add page numbers: …"), and nothing is written
//   stopping       Stop stops the step that is running and starts no other

import { outcome } from '../operations/registry.js';
import { GRACE_MS, runOperation } from '../batch/engine.js';
import { checkWorkflow } from './model.js';

const stemOf = (name) => String(name).replace(/\.[^.\\]*$/, '');

/** The workflow's name as part of a file name: no character Windows refuses, never empty. */
export const fileSafe = (name) => String(name).replace(/[\u0000-\u001f<>:"/\\|?*]+/g, ' ').replace(/\s+/g, ' ').trim().replace(/\.+$/, '') || 'workflow';

/**
 * The workflow as one operation batch processing runs (operations/registry.js shape). Throws with the reason when
 * it can't run (checkWorkflow). Its output is named "<file> (<workflow name>).pdf".
 */
export function workflowOperation(workflow, { operations, presence = null, graceMs = GRACE_MS } = {}) {
  const check = checkWorkflow(workflow, { operations, presence });
  if (!check.runnable) throw new Error(check.problem);
  const steps = Object.freeze(check.steps.map((s) => Object.freeze({ operation: s.operation, params: s.params })));
  const first = steps[0].operation;
  const last = steps.at(-1).operation;
  const nouns = `${first.noun}s`;
  return Object.freeze({
    id: `workflow:${workflow.id}`,
    name: workflow.name,
    step: workflow.name,
    verb: 'Running the workflow',
    icon: 'list-checks',
    noun: first.noun,
    about: `${steps.map((s, i) => `${i + 1}. ${s.operation.step}`).join('  ')}. Only the last step’s file is saved; the ${nouns} themselves aren’t changed.`,
    accept: first.accept,
    makes: last.makes,
    accepts: first.accepts,
    unsupported: first.unsupported,
    outputName: (name) => `${stemOf(name)} (${fileSafe(workflow.name)}).${last.makes}`,
    params: Object.freeze({}),
    choices: Object.freeze([]),
    checkParams: () => Object.freeze({}),
    // Each step has its own limit; this is the net under them all.
    timeoutMs: steps.reduce((sum, s) => sum + s.operation.timeoutMs + graceMs, 0),
    refusal: (input, context) => first.refusal(input, context),
    steps,
    run: (job, env) => runSteps(steps, job, env, graceMs),
  });
}

/** One file through every step; resolves the workflow's outcome for it. */
export async function runSteps(steps, job, env, graceMs = GRACE_MS) {
  const count = steps.length;
  const notes = [];
  const details = [];
  let provider = null;
  let current = job.input;
  for (let i = 0; i < count; i++) {
    const { operation, params } = steps[i];
    const last = i === count - 1;
    const where = count > 1 ? `Step ${i + 1} of ${count}` : '';
    const say = (label) => env.progress?.(where ? `${where} · ${label ?? `${operation.verb}…`}` : label);
    if (env.signal.aborted) {
      return outcome('cancelled', { code: 'stopped', message: `Stopped before step ${i + 1}, ${operation.step}. Nothing was saved.`, details });
    }
    say(`${operation.verb}…`);
    const output = last ? job.output : { held: true, name: operation.outputName(current.name) };
    // What this step reaches the host through: the file before it comes from memory, and only the last writes.
    const stepEnv = ({ signal, progress }) => ({
      ...env,
      signal,
      progress,
      readFile: (input) => (input.bytes ? Promise.resolve(input.bytes) : env.readFile(input)),
      writeFile: last ? env.writeFile : async ({ name }, bytes) => ({ name, held: true, bytes }),
    });
    const result = await runOperation(operation, { input: current, output, params, overwrite: job.overwrite },
      { env: stepEnv, signal: env.signal, graceMs, progress: say });
    details.push(...(result.details ?? []));
    if (result.status !== 'succeeded') {
      const { elapsedMs, ...said } = result;
      return outcome(result.status, {
        ...said, output: null, details, provider: result.provider ?? provider,
        message: count > 1 ? `Step ${i + 1}, ${operation.step}: ${result.message}` : result.message,
      });
    }
    if (result.note) notes.push(result.note);
    provider ??= result.provider;
    current = last ? result.output : { name: result.output.name, bytes: result.output.bytes };
  }
  return outcome('succeeded', {
    code: 'done', message: 'Done.', output: { name: current.name, path: current.path }, provider,
    note: notes.length ? notes.join(' · ') : null, details: [...new Set(details)],
  });
}
