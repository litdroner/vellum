// Workflows, the app half: opens the Workflows dialog (ui/flow.js, loaded the first time) over the list the host
// keeps (flow.load / flow.save: workflows.json in Vellum's data folder, Services/Workflows.cs), and runs the one
// chosen as a batch (batch/actions.js openOperation, with flow/runner.js workflowOperation): the files are added,
// the new files placed and the results shown exactly as batch processing does it.

import { bridge } from '../bridge.js';
import { showDialog } from '../ui/dialogs.js';
import { loadPdfLib } from '../annotations/persist.js';
import { OPERATIONS } from '../operations/registry.js';
import { readWorkflows, writeWorkflows } from './model.js';
import { workflowOperation } from './runner.js';

export function createFlowActions({ batch, office }) {
  let open = false;

  const services = {
    operations: OPERATIONS,
    presence: () => office.presence(),
    pdfLib: loadPdfLib,
    async load() {
      const { data, damaged } = await bridge.request('flow.load');
      const read = readWorkflows(data ?? null);
      return { ...read, damaged: Boolean(damaged) || read.damaged };
    },
    save: (workflows) => bridge.request('flow.save', { data: writeWorkflows(workflows) }),
  };

  return {
    /** Opens Workflows; a workflow chosen to run opens in the batch dialog. False if it can't open now. */
    async open() {
      if (open || batch.running) return false;
      open = true;
      let chosen;
      try {
        // Which Office formats this PC converts decides whether an Office step can be offered or run.
        await office.probe();
        const { showWorkflows } = await import('../ui/flow.js');
        chosen = await showWorkflows({ services });
      } finally {
        open = false;
      }
      if (!chosen) return true;
      let operation;
      try {
        operation = workflowOperation(chosen, { presence: office.presence() });
      } catch (err) {
        // What this PC can do changed since the list was shown (Office removed).
        await showDialog({ title: 'This workflow can’t run', message: err.message, iconName: 'triangle-alert' });
        return false;
      }
      return batch.openOperation(operation);
    },
  };
}
