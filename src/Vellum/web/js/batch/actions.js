// Batch processing, the app half: opens the batch dialog on an operation (ui/batch.js, loaded the first time),
// and gives the engine (batch/engine.js) and the operations (operations/registry.js) the host — the env one
// file runs with. Files are read from the host (/doc/{token}, the files the person chose, read-only) and new
// files are written through the Export Center's destination contract (export.targets, /export/{token}), so
// there is no second place to write, no second overwrite rule and no second progress system.
//
// One batch at a time. While one runs, closing Vellum asks first (stopForQuit(), from app.js prepareToQuit).

import { bridge } from '../bridge.js';
import { loadPdfLib } from '../annotations/persist.js';
import { operation as operationById } from '../operations/registry.js';
import { askAboutExisting } from '../ui/export.js';
import { showDialog } from '../ui/dialogs.js';
import { GRACE_MS, runBatch } from './engine.js';

/** What one file of a batch reaches the host through (the env of operations/registry.js). */
function hostEnv({ signal, progress }) {
  return {
    signal,
    progress,
    host: bridge,
    pdfLib: loadPdfLib,
    async readFile(input) {
      const response = await fetch(input.url, { signal });
      if (!response.ok) throw new Error(`The file couldn’t be read (${response.status}).`);
      return new Uint8Array(await response.arrayBuffer());
    },
    // Not stopped once started: a file being written is written whole (the host swaps it in atomically).
    async writeFile({ folder, name, overwrite }, bytes) {
      const { files } = await bridge.request('export.targets', { folder, names: [name], overwrite });
      const target = files[0];
      const response = await fetch(`${location.origin}/export/${target.token}`, {
        method: 'POST', body: bytes, headers: { 'Content-Type': 'application/octet-stream' },
      });
      const outcome = await response.json().catch(() => ({ ok: false, error: `The file couldn’t be written (${response.status}).` }));
      if (!outcome.ok) throw new Error(outcome.error);
      return { name: target.name, path: target.path };
    },
  };
}

export function createBatchActions({ office }) {
  let open = false;
  let run = null; // { controller, done } while files are being worked on

  const services = (op) => ({
    choose: ({ folder }) => bridge.request('batch.choose', { accept: op.accept, folder }),
    chooseFolder: async (current) => (await bridge.request('export.folder', { folder: current ?? undefined })).folder ?? null,
    /** The planned names already on disk, folder by folder. */
    async existing(byFolder) {
      const names = [];
      for (const [folder, wanted] of byFolder) {
        const { files } = await bridge.request('export.targets', { folder, names: wanted, probe: true });
        for (const f of files) if (f.exists) names.push(f.name);
      }
      return names;
    },
    askExisting: askAboutExisting,
    presence: () => office.presence(),
    noProvider: () => office.probe(true),
    showInFolder: (path) => bridge.request('showInFolder', { path }).catch(() => {}),
    run(items, { params, overwrite, only, onItem }) {
      const controller = new AbortController();
      const done = runBatch(items, { operation: op, params, overwrite, only, onItem, env: hostEnv, signal: controller.signal })
        .finally(() => { if (run?.done === done) run = null; });
      run = { controller, done };
      return { done, stop: () => controller.abort() };
    },
  });

  return {
    /** True while a batch is working on files. */
    get running() { return run !== null; },

    /** Opens the batch dialog on an operation id (operations/registry.js); false if it can't open now. */
    open(id) {
      const op = operationById(id);
      return op ? this.openOperation(op) : Promise.resolve(false);
    },

    /** Opens the batch dialog on an operation itself: one from the registry, or a workflow (flow/runner.js). */
    async openOperation(op) {
      if (open) return false;
      open = true;
      try {
        // Which Office formats this PC converts decides which files are skipped before anything runs.
        if (op.accept === 'office') await office.probe();
        const { showBatch } = await import('../ui/batch.js');
        return await showBatch({ operation: op, services: services(op) });
      } finally {
        open = false;
      }
    },

    /**
     * Before Vellum closes: with a batch running, asks whether to stop it. Resolves false to keep Vellum open;
     * true once the batch has stopped (or there was none).
     */
    async stopForQuit() {
      if (!run) return true;
      const choice = await showDialog({
        title: 'A batch is still running',
        message: 'Stop it and close Vellum? The new files already finished are kept; the file being worked on is stopped.',
        iconName: 'triangle-alert',
        buttons: [{ id: 'stop', label: 'Stop and close' }, { id: 'keep', label: 'Keep running', primary: true }],
      });
      if (choice !== 'stop') return false;
      const current = run;
      if (!current) return true;
      current.controller.abort();
      await Promise.race([current.done.catch(() => {}), new Promise((r) => setTimeout(r, GRACE_MS + 5000))]);
      return true;
    },
  };
}
