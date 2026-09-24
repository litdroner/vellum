// Workflows (Vellum Flow V1): a named list of steps, each an operation id from operations/registry.js and its
// parameters, run one after another on each file (flow/runner.js). Data only — no UI, no bridge, no storage — so
// it is tested in Node. The host keeps the list in workflows.json (Services/Workflows.cs), and this module is
// what reads and writes it:
//
//   { "v": 1, "workflows": [ { "id": "…", "name": "Client copy",
//       "steps": [ { "op": "office.toPdf", "params": {} }, { "op": "pdf.pageNumbers", "params": { "format": "Page {n}", … } } ] } ] }
//
// A step names an operation, never a tool id or a command id. A workflow holds nothing from a document and no
// path: which files it runs on, and where the new files go, are chosen each time it runs.
//
// Reading is forgiving and loses nothing it can keep: a step whose operation this Vellum doesn't have, or whose
// parameters don't check, stays in the workflow as it was written, and the workflow says it can't run and why
// (checkWorkflow). Only entries that aren't workflows at all are dropped, and counted. A file written by a newer
// Vellum (v above FORMAT) is not read, so it is never written over.

import { OPERATIONS } from '../operations/registry.js';

export const FORMAT = 1;
export const MAX_WORKFLOWS = 100;
export const MAX_STEPS = 12;
export const NAME_MAX = 60;

const KINDS = Object.freeze({ pdf: 'a PDF', office: 'an Office document' });
const plainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Parameters as plain data: strings, finite numbers and booleans, which is all an operation takes. */
export function plainParams(value) {
  const out = {};
  if (!plainObject(value)) return out;
  for (const [key, v] of Object.entries(value)) {
    if (typeof v === 'string' || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v))) out[key] = v;
  }
  return out;
}

/** A workflow's name: spaces collapsed, at most NAME_MAX characters ('' when there is none). */
export const cleanName = (name) => String(name ?? '').replace(/\s+/g, ' ').trim().slice(0, NAME_MAX).trim();

const newId = () => globalThis.crypto?.randomUUID?.().replace(/-/g, '') ?? `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;

/** A new workflow: a fresh id, and a copy of the steps given. */
export const newWorkflow = ({ name = '', steps = [] } = {}) => ({
  id: newId(), name: cleanName(name), steps: steps.map((s) => ({ op: s.op, params: plainParams(s.params) })),
});

/** A step for `operation` with its default parameters. */
export const newStep = (operation) => ({ op: operation.id, params: plainParams(operation.params) });

/**
 * The workflows in the file's content (`data`, parsed; null when there is no file). Returns
 * { workflows, dropped, newer, damaged }: newer when a later Vellum wrote it (nothing is read), damaged when it
 * isn't a workflow list at all.
 */
export function readWorkflows(data) {
  const none = (flags = {}) => ({ workflows: [], dropped: 0, newer: false, damaged: false, ...flags });
  if (data === null || data === undefined) return none();
  if (!plainObject(data) || !Array.isArray(data.workflows)) return none({ damaged: true });
  if (typeof data.v === 'number' && data.v > FORMAT) return none({ newer: true });
  const workflows = [];
  const ids = new Set();
  let dropped = 0;
  for (const entry of data.workflows) {
    if (!plainObject(entry) || workflows.length >= MAX_WORKFLOWS) { dropped++; continue; }
    let id = typeof entry.id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(entry.id) ? entry.id : newId();
    if (ids.has(id)) id = newId();
    ids.add(id);
    const steps = (Array.isArray(entry.steps) ? entry.steps : []).map((step) => ({
      op: typeof step?.op === 'string' ? step.op : '',
      params: plainParams(step?.params),
    }));
    workflows.push({ id, name: cleanName(entry.name) || 'Untitled workflow', steps });
  }
  return { workflows, dropped, newer: false, damaged: false };
}

/** The file's content for `workflows`: plain JSON, in their order. */
export function writeWorkflows(workflows) {
  return {
    v: FORMAT,
    workflows: workflows.map((w) => ({ id: w.id, name: cleanName(w.name), steps: w.steps.map((s) => ({ op: s.op, params: plainParams(s.params) })) })),
  };
}

/**
 * Whether `workflow` can run here, and what each step is: { runnable, problem, steps: [{ op, operation, params,
 * problem }] }. A step's problem: an operation this Vellum doesn't have, one this PC can't do (`presence`, when
 * known; operation.presentIf), parameters that don't check, or an order that can't work (a step must take the kind
 * of file the one before makes). `problem` is the first sentence that stops the whole workflow, or null.
 */
export function checkWorkflow(workflow, { operations = OPERATIONS, presence = null } = {}) {
  let before = null; // the last step's operation
  const steps = workflow.steps.map((step, index) => {
    const operation = operations.get(step.op) ?? null;
    let params = null;
    let problem = null;
    if (!operation) {
      problem = 'This step isn’t available in this version of Vellum.';
    } else {
      try {
        params = operation.checkParams(step.params);
      } catch (err) {
        problem = `Its settings aren’t valid: ${err?.message ?? err}`;
      }
      if (!problem && operation.presentIf && presence && presence[operation.presentIf] !== true) problem = operation.absent ?? 'This PC can’t do this step.';
      if (!problem && index > 0 && before && operation.accept !== before.makes) {
        problem = `This step takes ${KINDS[operation.accept] ?? operation.accept}, but the step before it makes ${KINDS[before.makes] ?? before.makes}.`;
      }
    }
    before = operation;
    return { op: step.op, operation, params, problem };
  });
  const broken = steps.findIndex((s) => s.problem);
  const problem = !cleanName(workflow.name) ? 'Give the workflow a name.'
    : steps.length === 0 ? 'Add at least one step.'
      : steps.length > MAX_STEPS ? `A workflow can have at most ${MAX_STEPS} steps.`
        : broken >= 0 ? `Step ${broken + 1}: ${steps[broken].problem}`
          : null;
  return { runnable: problem === null, problem, steps };
}

/**
 * The operations a step added at the end could be, in the registry's order: any, for the first step; after that,
 * those that take what the last step makes. With `presence` known, operations this PC can't do are left out.
 */
export function nextOperations(workflow, { operations = OPERATIONS, presence = null } = {}) {
  const last = [...workflow.steps].reverse().map((s) => operations.get(s.op)).find(Boolean) ?? null;
  return [...operations.values()].filter((op) => (workflow.steps.length === 0 || !last || op.accept === last.makes)
    && !(op.presentIf && presence && presence[op.presentIf] !== true));
}

/** "Convert to PDF → Add page numbers → Compress": what the workflow does, step by step. */
export function describeSteps(workflow, { operations = OPERATIONS } = {}) {
  if (!workflow.steps.length) return 'No steps yet';
  return workflow.steps.map((s) => operations.get(s.op)?.step ?? 'A step this Vellum doesn’t have').join(' → ');
}
