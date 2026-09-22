import { bridge } from '../bridge.js';
import { toast, showDialog } from '../ui/dialogs.js';
import { askAboutExisting, askWhatToExport, exportProgress } from '../ui/export.js';
import { describeResult, exportPlan } from './model.js';
import { runExport } from './run.js';
import { renderPageImage } from './images.js';
import { documentMarkdown, outlineHeadings } from './markdown.js';
import { tablesWorkbook } from './xlsx.js';
import { readPdfPage, readSessionPage } from '../semantic/model.js';
import { pageTables } from '../semantic/tables.js';

// Export Center V1 as the UI offers it: the Export command opens the dialog (ui/export.js), the host says
// where the files may be written (MainWindow.Export.cs), and the shared run (export/run.js) produces and
// writes them one by one with progress and a Cancel that stops before the next file.
//
// Every format goes through the same steps; only `producerFor` differs. Images are rendered by pdf.js as
// printing renders them (export/images.js); Markdown and the Excel workbook are written from the semantic
// document model and the confident tables already extracted (export/markdown.js, export/xlsx.js). Nothing
// new reads or parses the PDF, and the document on disk is never opened for writing — an export only ever
// creates new files.

export function createExportActions({ pdfjsLib }) {
  const folderOf = (path) => path.slice(0, Math.max(0, path.lastIndexOf('\\')));
  const chooseFolder = async (folder) => {
    const { folder: chosen } = await bridge.request('export.folder', { folder });
    return chosen ?? null;
  };

  /** Bytes for one file of the plan. Reading and rendering happen here, one file at a time. */
  function producerFor(view, plan) {
    if (plan.format.kind === 'image') {
      return (file, { signal }) => renderPageImage({
        pdf: view.pdf,
        number: file.pages[0],
        format: plan.format,
        paint: (ctx, number, viewport) => view.paintAnnotations?.(ctx, number, viewport),
        pdfjsLib,
        signal,
      });
    }
    if (plan.format.id === 'excel') {
      return async (file, { signal }) => {
        const read = await readPages(view, file.pages, signal);
        return tablesWorkbook({ document: sourceOf(view), pages: read.map((r) => r.extraction) });
      };
    }
    return async (file, { signal }) => {
      const headings = await outlineHeadings(view.pdf);
      const read = await readPages(view, file.pages, signal);
      const markdown = documentMarkdown({
        document: sourceOf(view),
        pages: read.map((r) => r.page),
        tables: new Map(read.map((r) => [r.page.number, r.extraction.tables])),
        headings,
      });
      return new TextEncoder().encode(markdown);
    };
  }

  /** Which document this is, for the provenance every text format records. */
  const sourceOf = (view) => ({ name: view.file.name, path: view.file.path, contentKey: view.docKey ?? null });

  /**
   * The chosen pages of the semantic document model, each with its table extraction, in page order. One
   * read for every format that works from the model, so no format reads the document a second way.
   */
  async function readPages(view, numbers, signal) {
    const out = [];
    for (const number of numbers) {
      if (signal?.aborted) break;
      const page = view.encrypted
        ? await readPdfPage(view.pdf, number)
        : await readSessionPage(view.textEditing, view.pdf, number);
      out.push({ page, extraction: pageTables(page) });
    }
    return out;
  }

  /** Sends one exported file's bytes to the host, which writes it atomically. Returns its size. */
  async function write(view, target, data) {
    const response = await fetch(`${new URL(view.file.url).origin}/export/${target.token}`, {
      method: 'POST', body: data, headers: { 'Content-Type': 'application/octet-stream' },
    });
    const outcome = await response.json().catch(() => ({ ok: false, error: `The file couldn’t be written (${response.status}).` }));
    if (!outcome.ok) throw new Error(outcome.error);
    return data.byteLength ?? data.length ?? null;
  }

  const actions = {
    /** The Export command: ask, then export. */
    async run(view) {
      if (view?.status !== 'ready') return;
      const chosen = await askWhatToExport({
        fileName: view.file.name,
        pageCount: view.pdf.numPages,
        currentPage: view.state.pageNumber,
        folder: folderOf(view.file.path),
        chooseFolder: () => chooseFolder(folderOf(view.file.path)),
      });
      if (!chosen) return;
      const result = await actions.exportTo({ view, ...chosen });
      if (!result) return;
      const first = result.written[0];
      toast(describeResult(result), {
        kind: result.ok ? 'success' : result.cancelled ? 'info' : 'error',
        action: first?.path ? { label: 'Show', run: () => bridge.request('showInFolder', { path: first.path }) } : null,
      });
    },

    /**
     * Exports without asking: the dialog's answer, or a caller that already has one. Resolves the run's
     * result (export/run.js), or null if the person cancelled at the overwrite question.
     */
    async exportTo({ view, formatId, pages, folder, overwrite = null }) {
      const plan = exportPlan({ fileName: view.file.name, formatId, pages, pageCount: view.pdf.numPages });
      const names = plan.files.map((f) => f.name);
      let mode = overwrite;
      try {
        if (!mode) {
          const { files: existing } = await bridge.request('export.targets', { folder, names, probe: true });
          const taken = existing.filter((f) => f.exists).map((f) => f.name);
          if (taken.length) {
            mode = await askAboutExisting(taken);
            if (!mode) return null;
          } else {
            mode = 'replace';
          }
        }
        const { files: targets } = await bridge.request('export.targets', { folder, names, overwrite: mode });
        const ui = exportProgress({ total: plan.files.length });
        try {
          return await runExport({
            plan,
            targets,
            produce: producerFor(view, plan),
            write: (target, data) => write(view, target, data),
            onProgress: (step) => ui.progress(step),
            signal: ui.signal,
          });
        } finally {
          ui.close();
        }
      } catch (err) {
        showDialog({ title: 'Couldn’t export', message: err.message, iconName: 'triangle-alert' });
        return null;
      }
    },
  };
  return actions;
}
