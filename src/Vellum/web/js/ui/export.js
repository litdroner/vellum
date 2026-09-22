import { h } from '../dom.js';
import { showDialog } from './dialogs.js';
import { EXPORT_FORMAT_IDS, EXPORT_FORMATS, describePlan, exportPlan, selectedPages } from '../export/model.js';

// The Export dialog (Export Center V1): one format, which pages, and where. It follows the Split and page
// setting dialogs — the same radio choices, the same note under them, the same two buttons — and decides
// nothing itself: it hands back what was chosen and export/actions.js runs it.
//
// Progress and cancellation are the print dialog's (print.js): one modal with a bar and a Cancel button.

/**
 * Asks what to export. Resolves { formatId, pages, folder } or null.
 *   fileName, pageCount, currentPage   the document
 *   folder                             where the files go to start with (the document's own folder)
 *   chooseFolder()                     opens the host's folder picker; resolves a folder or null
 */
export async function askWhatToExport({ fileName, pageCount, currentPage, folder, chooseFolder }) {
  let destination = folder;
  const formats = EXPORT_FORMAT_IDS.map((id) => EXPORT_FORMATS[id]);
  const formatChoice = (format, checked) => h('label', { class: 'choice' },
    h('input', { type: 'radio', name: 'export-format', value: format.id, checked }),
    h('span', { class: 'choice-label' }, format.label, h('span', { class: 'choice-note', text: format.note })));
  const formatChoices = h('div', { class: 'choices' }, ...formats.map((f, i) => formatChoice(f, i === 0)));

  const rangeInput = h('input', { class: 'field', type: 'text', spellcheck: 'false', placeholder: `e.g. 1-3, ${pageCount}` });
  const pageChoice = (value, label, extra = null, checked = false) => h('label', { class: 'choice' },
    h('input', { type: 'radio', name: 'export-pages', value, checked }), h('span', { class: 'choice-label' }, label, extra));
  const pageChoices = h('div', { class: 'choices' },
    pageChoice('all', `All pages (${pageCount})`, null, true),
    pageChoice('current', `This page (${currentPage})`),
    pageChoice('range', 'Pages ', rangeInput));
  // The formats and the pages scroll together, so the folder, the note and the buttons stay in view
  // however many formats there are (ui/collection-research.js scrolls its results the same way).
  const choices = h('div', { class: 'export-choices' }, formatChoices, pageChoices);

  const folderText = h('span', { class: 'export-folder-path', text: destination });
  const folderRow = h('div', { class: 'export-destination' },
    h('span', { class: 'export-folder-label', text: 'Folder' }), folderText,
    h('button', {
      class: 'btn small', type: 'button', text: 'Choose\u2026',
      onClick: async () => {
        const chosen = await chooseFolder();
        if (!chosen) return;
        destination = chosen;
        folderText.textContent = chosen;
      },
    }));

  const note = h('p', { class: 'dialog-note' });
  let primary = null;
  let choice = null;

  const compute = () => {
    const formatId = formatChoices.querySelector('input:checked')?.value;
    const mode = pageChoices.querySelector('input:checked')?.value;
    const selection = mode === 'all' ? { mode: 'all' } : mode === 'current' ? { mode: 'pages', pages: [currentPage] } : { mode: 'range', text: rangeInput.value };
    const pages = selectedPages(selection, pageCount);
    if (!pages) return null;
    return { formatId, pages };
  };
  const update = () => {
    choice = compute();
    if (primary) primary.disabled = !choice;
    note.textContent = choice
      ? describePlan(exportPlan({ fileName, formatId: choice.formatId, pages: choice.pages, pageCount }))
      : `Enter page numbers between 1 and ${pageCount}.`;
  };
  formatChoices.addEventListener('change', update);
  pageChoices.addEventListener('change', update);
  rangeInput.addEventListener('input', () => {
    pageChoices.querySelector('input[value="range"]').checked = true;
    update();
  });

  const result = await showDialog({
    title: 'Export',
    message: `Vellum writes new files from this document. The PDF itself isn\u2019t changed.`,
    iconName: 'file-output',
    className: 'export-dialog',
    content: [choices, folderRow, note],
    buttons: [{ id: 'cancel', label: 'Cancel' }, { id: 'ok', label: 'Export', primary: true }],
    onOpen: (dialog) => {
      primary = dialog.querySelector('.btn.primary');
      update();
      return primary;
    },
  });
  return result === 'ok' && choice ? { ...choice, folder: destination } : null;
}

/** Files that are already there. Resolves 'replace', 'keepBoth' or null (cancelled). */
export async function askAboutExisting(names) {
  const shown = names.slice(0, 3).join(', ');
  const result = await showDialog({
    title: names.length === 1 ? 'That file already exists' : `${names.length} of those files already exist`,
    message: `${shown}${names.length > 3 ? ', \u2026' : ''}`,
    iconName: 'triangle-alert',
    buttons: [
      { id: 'cancel', label: 'Cancel' },
      { id: 'replace', label: 'Replace' },
      { id: 'keepBoth', label: 'Keep both', primary: true },
    ],
  });
  return result === 'replace' || result === 'keepBoth' ? result : null;
}

/**
 * The progress modal. Returns { signal, progress(step), close() }: `signal` aborts when Cancel is pressed,
 * so the run stops before the next file (export/run.js).
 */
export function exportProgress({ total, title = 'Exporting' }) {
  const controller = new AbortController();
  const fill = h('div', { class: 'progress-fill' });
  const label = h('p', { class: 'dialog-message', text: `File 1 of ${total}` });
  const panel = h('div', { class: 'dialog-backdrop ui open' },
    h('div', { class: 'dialog', role: 'dialog', 'aria-modal': 'true' },
      h('h2', { class: 'dialog-title', text: title }),
      label,
      h('div', { class: 'progress' }, fill),
      h('div', { class: 'dialog-actions' },
        h('button', { class: 'btn', onClick: () => controller.abort() }, 'Cancel'))));
  document.getElementById('overlay-root').append(panel);
  return {
    signal: controller.signal,
    progress({ index, total: count, name }) {
      fill.style.width = `${(index / count) * 100}%`;
      if (name) label.textContent = count === 1 ? name : `File ${index + 1} of ${count} \u2014 ${name}`;
    },
    close() {
      panel.remove();
    },
  };
}
