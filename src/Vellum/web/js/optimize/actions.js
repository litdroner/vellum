// Compress PDF (optimize/compress.js) as the command offers it: the PDF operations that write a new
// file beside the document all run through here.
//
// Both follow the Export Center exactly: the dialog asks (ui/optimize.js), the host says where a file
// may be written (export.folder / export.targets, MainWindow.Export.cs), the bytes go to the
// /export/{token} route, which writes them atomically, and the result says plainly what was written.
// The document being worked on is read from the file on disk and is never opened for writing; an
// operation only ever creates a new file.
//
// No operation writes anything it could not verify: compression reopens its own output and compares
// it with an inventory of the source. A refusal writes nothing at all and says what it found.

import { bridge } from '../bridge.js';
import { loadPdfLib } from '../annotations/persist.js';
import { askAboutExisting, exportProgress } from '../ui/export.js';
import { askAboutCompression, showCompressionResult, showRefusal } from '../ui/optimize.js';
import { CompressError, compressDocument } from './compress.js';

const folderOf = (path) => path.slice(0, Math.max(0, path.lastIndexOf('\\')));
const baseName = (name) => name.replace(/\.pdf$/i, '');

export function createOptimizeActions() {
  const chooseFolder = async (folder) => {
    const { folder: chosen } = await bridge.request('export.folder', { folder });
    return chosen ?? null;
  };

  /** Writes one file through the host, asking first when something of that name is already there. */
  async function writeBeside(view, folder, name, data) {
    const { files: existing } = await bridge.request('export.targets', { folder, names: [name], probe: true });
    let mode = 'replace';
    if (existing.some((f) => f.exists)) {
      mode = await askAboutExisting([name]);
      if (!mode) return null;
    }
    const { files: targets } = await bridge.request('export.targets', { folder, names: [name], overwrite: mode });
    const target = targets[0];
    const response = await fetch(`${new URL(view.file.url).origin}/export/${target.token}`, {
      method: 'POST', body: data, headers: { 'Content-Type': 'application/octet-stream' },
    });
    const outcome = await response.json().catch(() => ({ ok: false, error: `The file couldn’t be written (${response.status}).` }));
    if (!outcome.ok) throw new Error(outcome.error);
    return target;
  }

  /** The same shape for both operations: ask, run with progress, write, show what happened. */
  async function run(view, { title, suffix, ask, produce, present, refusalTitle, isRefusal }) {
    if (view?.status !== 'ready') return null;
    const folder = folderOf(view.file.path);
    const outputName = `${baseName(view.file.name)}${suffix}.pdf`;
    // The file on disk, read before anything is asked, so the dialog can say how big it is now.
    let bytes;
    try {
      bytes = await view.baseBytes();
    } catch (err) {
      await showRefusal({ title: refusalTitle, message: `This document couldn’t be read (${err?.message ?? err}).` });
      return null;
    }
    const answer = await ask({ outputName, folder, size: bytes.length });
    if (!answer) return null;

    const ui = exportProgress({ total: 1, title, describe: ({ name }) => name ?? title });
    let report;
    try {
      report = await produce({
        ...answer,
        bytes,
        onProgress: ({ label, index, total }) => ui.progress({ index, total, name: label }),
        signal: ui.signal,
      });
    } catch (err) {
      ui.close();
      if (ui.signal.aborted) return null;
      if (isRefusal(err)) {
        await showRefusal({ title: refusalTitle, message: err.message, details: err.details ?? [] });
        return null;
      }
      await showRefusal({ title: refusalTitle, message: err?.message ?? String(err) });
      return null;
    }
    ui.close();

    let target;
    try {
      target = await writeBeside(view, answer.folder, outputName, report.bytes);
    } catch (err) {
      await showRefusal({ title: refusalTitle, message: err?.message ?? String(err) });
      return null;
    }
    if (!target) return null;
    await present(report, {
      path: target.path ?? null,
      show: target.path ? () => bridge.request('showInFolder', { path: target.path }) : null,
    });
    return report;
  }

  return {
    /** Compress PDF: a smaller copy of the file on disk, verified against it before it is written. */
    compress(view) {
      return run(view, {
        title: 'Compressing',
        suffix: ' (compressed)',
        refusalTitle: 'Couldn’t compress',
        isRefusal: (err) => err instanceof CompressError,
        ask: ({ outputName, folder, size }) => askAboutCompression({
          fileName: view.file.name,
          size,
          outputName,
          folder,
          dirty: view.state.dirty,
          chooseFolder: () => chooseFolder(folder),
        }),
        produce: async ({ bytes, level, onProgress, signal }) =>
          compressDocument({ lib: await loadPdfLib(), bytes, level, onProgress, signal }),
        present: showCompressionResult,
      });
    },

  };
}
