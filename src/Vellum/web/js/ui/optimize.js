// The dialogs of the two PDF operations that write a new file beside the document: Compress
// (optimize/compress.js) and PDF/A (optimize/pdfa.js). They follow the Export dialog — the same radio choices, the same folder row,
// the same note under them, the same two buttons — and decide nothing themselves: each hands back what
// was chosen and optimize/actions.js runs it.
//
// Progress and cancellation are the export run's own modal (ui/export.js exportProgress), with the
// steps of the operation under the title instead of a file name.

import { h } from '../dom.js';
import { icon } from '../icons.js';
import { showDialog } from './dialogs.js';
import { COMPRESSION_LEVELS, DEFAULT_LEVEL, formatBytes } from '../optimize/compress.js';
import { describePageNumbers, selectedPages } from '../export/model.js';

/**
 * Asks how to compress and where the copy goes. Resolves { level, folder } or null.
 *   fileName, size   the document and how big it is now
 *   outputName       the name the copy will have in the folder
 *   folder           where it goes to start with (the document's own folder)
 *   dirty            there are unsaved changes, which the copy won't have
 *   chooseFolder()   the host's folder picker; resolves a folder or null
 */
export async function askAboutCompression({ fileName, size, outputName, folder, dirty = false, chooseFolder }) {
  const choices = h('div', { class: 'choices' }, ...COMPRESSION_LEVELS.map((level) => h('label', { class: 'choice' },
    h('input', { type: 'radio', name: 'compress-level', value: level.id, checked: level.id === DEFAULT_LEVEL }),
    h('span', { class: 'choice-label' }, level.label, h('span', { class: 'choice-note', text: level.note })))));
  const destination = folderRow(folder, outputName, chooseFolder);
  const note = h('p', { class: 'dialog-note' },
    `${fileName} is ${formatBytes(size)} now. Nothing on the pages is changed: no page is turned into a picture, no image is re-encoded and no text is rewritten.`,
    dirty ? h('span', { class: 'optimize-warning', text: ' Unsaved changes aren’t in the copy — it is made from the file on disk.' }) : null);

  const result = await showDialog({
    title: 'Compress PDF',
    message: 'Vellum writes a smaller copy of this document. The PDF itself isn’t changed.',
    iconName: 'minimize-2',
    className: 'optimize-dialog',
    content: [choices, destination.row, note],
    buttons: [{ id: 'cancel', label: 'Cancel' }, { id: 'ok', label: 'Compress', primary: true }],
  });
  if (result !== 'ok') return null;
  return { level: choices.querySelector('input:checked')?.value ?? DEFAULT_LEVEL, folder: destination.folder() };
}

/**
 * Asks whether to convert to the PDF/A profile Vellum supports, which pages, and where the copy goes.
 * Resolves { pages, folder } or null. `profile` is the supported profile (optimize/pdfa.js
 * PDFA_PROFILE); the page choices are the Export dialog’s own (export/model.js selectedPages).
 */
export async function askAboutPdfa({ fileName, outputName, folder, profile, pageCount, currentPage, dirty = false, chooseFolder }) {
  const rangeInput = h('input', { class: 'field', type: 'text', spellcheck: 'false', placeholder: `e.g. 1-3, ${pageCount}` });
  const pageChoice = (value, label, extra = null, checked = false) => h('label', { class: 'choice' },
    h('input', { type: 'radio', name: 'pdfa-pages', value, checked }), h('span', { class: 'choice-label' }, label, extra));
  const pageChoices = h('div', { class: 'choices' },
    pageChoice('all', `All pages (${pageCount})`, null, true),
    pageChoice('current', `This page (${currentPage})`),
    pageChoice('range', 'Pages ', rangeInput));

  const destination = folderRow(folder, outputName, chooseFolder);
  const note = h('p', { class: 'dialog-note' });
  let primary = null;
  let pages = null;

  const update = () => {
    const mode = pageChoices.querySelector('input:checked')?.value;
    const selection = mode === 'all' ? { mode: 'all' } : mode === 'current' ? { mode: 'pages', pages: [currentPage] } : { mode: 'range', text: rangeInput.value };
    pages = selectedPages(selection, pageCount);
    if (primary) primary.disabled = !pages;
    note.replaceChildren(...(pages
      ? [`${pages.length === pageCount ? 'The whole document' : `Pages ${describePageNumbers(pages)}`} copied as ${profile.label}. Vellum converts to ${profile.label} only, and checks the copy against that profile before writing it — if this document can’t be converted without changing what it shows, nothing is written and Vellum says why.`,
        ...(dirty ? [h('span', { class: 'optimize-warning', text: ' Unsaved changes aren’t in the copy — it is made from the file on disk.' })] : [])]
      : [`Enter page numbers between 1 and ${pageCount}.`]));
  };
  pageChoices.addEventListener('change', update);
  rangeInput.addEventListener('input', () => {
    pageChoices.querySelector('input[value="range"]').checked = true;
    update();
  });

  const result = await showDialog({
    title: 'Convert to PDF/A',
    message: `${fileName} is copied as ${profile.label}, the archiving profile Vellum can produce and check. The PDF itself isn’t changed.`,
    iconName: 'list-checks',
    className: 'optimize-dialog',
    content: [pageChoices, destination.row, note],
    buttons: [{ id: 'cancel', label: 'Cancel' }, { id: 'ok', label: 'Convert', primary: true }],
    onOpen: (dialog) => {
      primary = dialog.querySelector('.btn.primary');
      update();
      return primary;
    },
  });
  return result === 'ok' && pages ? { pages, folder: destination.folder() } : null;
}

/** The folder row of the Export dialog, with the name the file will be written under. */
function folderRow(initial, outputName, chooseFolder) {
  let folder = initial;
  const text = h('span', { class: 'export-folder-path', text: folder });
  const row = h('div', { class: 'optimize-destination' },
    h('div', { class: 'export-destination' },
      h('span', { class: 'export-folder-label', text: 'Folder' }), text,
      h('button', {
        class: 'btn small', type: 'button', text: 'Choose…',
        onClick: async () => {
          const chosen = await chooseFolder();
          if (!chosen) return;
          folder = chosen;
          text.textContent = chosen;
        },
      })),
    h('p', { class: 'optimize-filename' }, 'Written as ', h('strong', { text: outputName })));
  return { row, folder: () => folder };
}

/**
 * What compressing did: every step, what it found, and the sizes before and after.
 * `show` opens the written file's folder, when the host gave a path.
 */
export function showCompressionResult(report, { path = null, show = null } = {}) {
  const saved = report.identical
    ? 'This PDF is already as small as Vellum can make it without changing what it draws, so the copy is identical to it.'
    : `${formatBytes(report.before)} → ${formatBytes(report.after)} — ${formatBytes(report.saved)} smaller (${Math.round(report.ratio * 100)}%).`;
  return showDialog({
    title: 'Compressed',
    message: saved,
    iconName: 'minimize-2',
    className: 'optimize-dialog',
    content: [
      stepList(report.steps),
      ...report.warnings.map((w) => h('p', { class: 'dialog-note optimize-warning', text: w })),
    ],
    buttons: [...(path && show ? [{ id: 'show', label: 'Show' }] : []), { id: 'close', label: 'Close', primary: true }],
  }).then((choice) => {
    if (choice === 'show') show();
    return choice;
  });
}

/** What the PDF/A conversion did, and what it checked afterwards. */
export function showPdfaResult(report, { path = null, show = null } = {}) {
  return showDialog({
    title: `Converted to ${report.profile.label}`,
    message: `${report.pageCount} ${report.pageCount === 1 ? 'page' : 'pages'} written and checked against ${report.profile.label}. Every check Vellum makes passed.`,
    iconName: 'list-checks',
    className: 'optimize-dialog',
    content: [
      stepList(report.steps),
      h('p', { class: 'dialog-note' }, `Checked: ${report.checks.join('; ')}. These are the ${report.profile.label} requirements Vellum can decide from the file itself — not the whole of the standard.`),
    ],
    buttons: [...(path && show ? [{ id: 'show', label: 'Show' }] : []), { id: 'close', label: 'Close', primary: true }],
  }).then((choice) => {
    if (choice === 'show') show();
    return choice;
  });
}

/** The steps an operation ran, with what each one actually did. Steps that did nothing say so. */
function stepList(steps) {
  return h('ul', { class: 'optimize-steps' }, steps.map((s) => h('li', { class: s.count === 0 ? 'none' : '' },
    h('span', { class: 'optimize-step-glyph', html: icon(s.count === 0 ? 'minus' : 'check', 14) }),
    h('span', {}, s.label, s.count != null ? h('span', { class: 'optimize-step-count', text: ` ×${s.count}` }) : null,
      s.note ? h('span', { class: 'optimize-step-note', text: ` — ${s.note}` }) : null))));
}

/**
 * Why an operation refused, in its own words, with what it found. Used for both operations: neither
 * writes anything when it refuses.
 */
export function showRefusal({ title, message, details = [] }) {
  return showDialog({
    title,
    message,
    iconName: 'triangle-alert',
    className: 'optimize-dialog',
    content: details.length ? [h('ul', { class: 'optimize-reasons' }, details.map((d) => h('li', { text: d })))] : [],
    buttons: [{ id: 'close', label: 'Close', primary: true }],
  });
}
