import { bridge, writePdfFile } from '../bridge.js';
import { h } from '../dom.js';
import { icon } from '../icons.js';
import { openMenu } from '../ui/menu.js';
import { showDialog, toast } from '../ui/dialogs.js';
import { loadPdfLib } from '../annotations/persist.js';
import { newId } from '../annotations/model.js';
import { readPicture } from '../editing/objects/image.js';
import { decodeBase64 } from '../ui/text-editor.js';
import { PAGE_NUMBER_POSITIONS, WATERMARK_POSITIONS, pageNumberText, unsupportedCharacters } from './stamps.js';
import { MINIMUM_INPUTS, countInputs, mergeDocuments, mergedFileName, mergedPageCount, moveInput, removeInput, withoutDuplicates } from './merge.js';

// Page operations as the UI offers them: the DocumentView methods plus the dialogs, menus and
// messages around them. Used by the thumbnail panel, the menus and keyboard shortcuts.
// Everything that changes pages is one undo step (Ctrl+Z), and nothing touches the file on disk
// until the document is saved, except Extract and Split, which write new files.

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const baseName = (name) => name.replace(/\.pdf$/i, '');

/** "3", "3–5" or "2, 4, 7–9" for a set of page numbers. */
export function describePages(numbers) {
  const sorted = [...new Set(numbers)].sort((a, b) => a - b);
  const runs = [];
  for (const n of sorted) {
    const last = runs.at(-1);
    if (last && n === last[1] + 1) last[1] = n;
    else runs.push([n, n]);
  }
  return runs.map(([a, b]) => (a === b ? `${a}` : `${a}–${b}`)).join(', ');
}

/** Parses "1-3, 5, 9-" into [[start, end], ...] (1-based, inclusive). Null if anything is invalid. */
function parseRanges(text, total) {
  const parts = text.split(',').map((p) => p.trim()).filter(Boolean);
  if (!parts.length) return null;
  const ranges = [];
  for (const part of parts) {
    const m = /^(\d+)\s*(?:[-–]\s*(\d*))?$/.exec(part);
    if (!m) return null;
    const start = Number(m[1]);
    const end = m[2] === undefined ? start : m[2] === '' ? total : Number(m[2]);
    if (start < 1 || end > total || start > end) return null;
    ranges.push([start, end]);
  }
  return ranges;
}

export function createPageActions({ onOpenFile }) {
  /** Can pages be taken from this document (for new files)? */
  const usable = (view) => {
    if (view?.canEditPages) return true;
    toast(view?.encrypted ? 'This PDF is protected, so its pages can’t be changed.' : 'The document is still opening.', { kind: 'error' });
    return false;
  };
  /** Can this document's pages be changed? A signed PDF asks first (saving invalidates its signature). */
  const allowed = async (view) => usable(view) && view.confirmChanges();
  const undo = (view) => ({ label: 'Undo', run: () => view.annotations.undo() });
  const numbersOf = (view, ids) => ids.map((id) => view.annotations.plan.findIndex((e) => e.id === id) + 1).filter((n) => n > 0);
  // Pages copied with Ctrl+C in the organiser: plan entry ids of one document, pasted into that document.
  let copied = null;

  const actions = {
    copy(view, ids) {
      if (!usable(view) || !ids.length) return;
      copied = { view, ids };
      toast(`Copied ${plural(ids.length, 'page')}`);
    },

    /** Pastes the copied pages at insertion point `index`. */
    async paste(view, index) {
      if (!copied) return;
      if (copied.view !== view) {
        toast('Pages are pasted into the document they were copied from. To add pages from another PDF, use Insert pages from file.');
        return;
      }
      const ids = copied.ids.filter((id) => view.annotations.plan.some((e) => e.id === id));
      if (!ids.length) {
        toast('The copied pages are no longer in this document.', { kind: 'error' });
        return;
      }
      if (!(await allowed(view))) return;
      if (view.copyPages(ids, index)) toast(`Pasted ${plural(ids.length, 'page')}`, { action: undo(view) });
    },

    get canPaste() { return Boolean(copied); },

    /** Moves pages one place up (-1) or down (1), keeping them together. */
    async moveBy(view, ids, step) {
      const numbers = numbersOf(view, ids);
      if (!numbers.length) return;
      const index = step < 0 ? Math.min(...numbers) - 2 : Math.max(...numbers) + 1;
      if (index < 0 || index > view.annotations.plan.length) return;
      await actions.move(view, ids, index);
    },

    async rotate(view, ids, delta) {
      if (await allowed(view)) view.rotatePages(ids, delta);
    },

    async remove(view, ids) {
      if (!ids.length || !(await allowed(view))) return;
      if (view.deletePages(ids)) toast(`Deleted ${plural(ids.length, 'page')}`, { action: undo(view) });
    },

    /** Crop: margins as the pages are shown, kept per page in the page's own (unrotated) sides. */
    async crop(view, ids) {
      if (!ids.length || !(await allowed(view))) return;
      const plan = view.annotations.plan;
      const entries = plan.filter((e) => ids.includes(e.id));
      // Quarter turns each page is shown at (its own rotation plus the plan's), from the pages on screen.
      const turns = new Map(await Promise.all(view.shownPlan.map(async (e, i) => [e.id, Math.round((await view.pdf.getPage(i + 1)).rotate / 90) % 4])));
      const turnsOf = (e) => turns.get(e.id) ?? 0;
      const first = entries[0];
      const shown = first.crop ? SIDES.map((_, i) => first.crop[SIDES[(i - turnsOf(first) + 4) % 4]] ?? 0) : [0, 0, 0, 0];
      const answer = await askForPageSetting({
        title: 'Crop pages', iconName: 'minimize-2', count: ids.length, total: plan.length, removable: entries.some((e) => e.crop),
        message: 'Trims the edges of the pages as they’re shown. Nothing is deleted: the hidden parts stay in the file.',
        fields: SIDES.map((side, i) => ({ key: side, label: side[0].toUpperCase() + side.slice(1), type: 'number', unit: 'mm', value: toMm(shown[i]), min: 0 })),
      });
      if (!answer) return;
      const targets = answer.all ? plan.map((e) => e.id) : ids;
      const value = answer.remove ? null : (e) => {
        const k = turnsOf(e);
        const crop = Object.fromEntries(SIDES.map((side, j) => [side, fromMm(answer.values[SIDES[(j + k) % 4]])]));
        return Object.values(crop).some((v) => v > 0) ? crop : null;
      };
      if (view.setPageSetting(targets, 'crop', value)) toast(answer.remove ? 'Crop removed' : `Cropped ${plural(targets.length, 'page')}`, { action: undo(view) });
    },

    async pageNumbers(view, ids) {
      if (!(await allowed(view))) return;
      const plan = view.annotations.plan;
      const current = plan.find((e) => ids.includes(e.id) && e.pageNumber)?.pageNumber ?? { format: 'Page {n} of {total}', position: 'bottom-center', size: 10, start: 1 };
      const answer = await askForPageSetting({
        title: 'Page numbers', iconName: 'file-text', count: ids.length, total: plan.length, preferAll: true, removable: plan.some((e) => e.pageNumber),
        message: 'Adds each page’s number as text. {n} is the page’s number and {total} the page count; numbers follow the pages when they’re moved.',
        fields: [
          { key: 'format', label: 'Text', type: 'text', value: current.format, wide: true },
          { key: 'position', label: 'Position', type: 'select', value: current.position, options: PAGE_NUMBER_POSITIONS.map((p) => [p, label(p)]) },
          { key: 'size', label: 'Size', type: 'number', unit: 'pt', value: current.size, min: 4, max: 72 },
          { key: 'start', label: 'Start at', type: 'number', value: current.start, min: 0, max: 99999 },
        ],
        preview: (v) => `Page 1 reads “${pageNumberText({ format: v.format, start: Math.round(Number(v.start)) }, 1, plan.length)}”`,
        check: (v) => (v.format.includes('{n}') ? checkText(v.format) : 'Include {n} where the number goes.'),
      });
      if (!answer) return;
      const targets = answer.all ? plan.map((e) => e.id) : ids;
      const { format, position, size, start } = answer.values;
      const value = answer.remove ? null : { format, position, size: Number(size), start: Math.round(Number(start)) };
      if (view.setPageSetting(targets, 'pageNumber', value)) toast(answer.remove ? 'Page numbers removed' : `Numbered ${plural(targets.length, 'page')}`, { action: undo(view) });
    },

    /** Text or a picture (PNG or JPEG) over the pages; the picture's bytes go into the document's sources. */
    async watermark(view, ids) {
      if (!(await allowed(view))) return;
      const plan = view.annotations.plan;
      const current = { text: 'DRAFT', position: 'center', size: 60, scale: 50, opacity: 0.2, rotation: 45, ...plan.find((e) => ids.includes(e.id) && e.watermark)?.watermark };
      let picture = current.picture ?? null; // { source, format, width, height }
      let bytes = picture ? view.sources.get(picture.source) : null;
      let problem = null;
      const chooser = picturePicker(() => ({ picture, bytes }), async () => {
        let file;
        try {
          ({ file } = await bridge.request('pictureDialog', { purpose: 'watermark' }));
          if (!file) return false;
          const chosen = decodeBase64(file.data);
          picture = { source: newId(), ...(await readPicture(await loadPdfLib(), chosen)) };
          bytes = chosen;
          problem = null;
        } catch (err) {
          problem = err.message;
        }
        return true;
      });
      const answer = await askForPageSetting({
        title: 'Watermark', iconName: 'blend', count: ids.length, total: plan.length, preferAll: true, removable: plan.some((e) => e.watermark),
        message: 'Adds text or a picture across the pages, over their content.',
        modes: { value: picture ? 'picture' : 'text', options: [['text', 'Text'], ['picture', 'Picture']], label: 'Watermark kind' },
        fields: [
          { key: 'text', label: 'Text', type: 'text', value: current.text, wide: true, mode: 'text' },
          { key: 'picture', label: 'Picture', type: 'custom', node: chooser.node, wide: true, mode: 'picture' },
          { key: 'position', label: 'Position', type: 'select', value: current.position, options: WATERMARK_POSITIONS.map((p) => [p, label(p)]) },
          { key: 'size', label: 'Size', type: 'number', unit: 'pt', value: current.size, min: 6, max: 400, mode: 'text' },
          { key: 'scale', label: 'Width of page', type: 'number', unit: '%', value: current.scale, min: 1, max: 400, mode: 'picture' },
          { key: 'opacity', label: 'Opacity', type: 'number', unit: '%', value: Math.round(current.opacity * 100), min: 5, max: 100 },
          { key: 'rotation', label: 'Rotation', type: 'number', unit: '°', value: current.rotation, min: -180, max: 180 },
        ],
        check: (v) => (v.mode === 'picture'
          ? problem ?? (picture ? null : 'Choose a PNG or JPEG picture.')
          : v.text.trim() ? checkText(v.text) : 'Enter the watermark text.'),
        preview: (v) => (v.mode === 'picture' && picture ? `${picture.width} × ${picture.height} ${picture.format === 'png' ? 'PNG' : 'JPEG'}; a PNG’s transparency is kept.` : null),
      });
      chooser.close();
      if (!answer) return;
      const targets = answer.all ? plan.map((e) => e.id) : ids;
      const { mode, text, position, size, scale, opacity, rotation } = answer.values;
      const shared = { position, opacity: Number(opacity) / 100, rotation: Number(rotation) };
      if (!answer.remove && mode === 'picture') view.sources.set(picture.source, bytes);
      const value = answer.remove ? null
        : mode === 'picture' ? { picture, ...shared, scale: Number(scale) }
          : { text: text.trim(), ...shared, size: Number(size) };
      if (view.setPageSetting(targets, 'watermark', value)) toast(answer.remove ? 'Watermark removed' : `Watermarked ${plural(targets.length, 'page')}`, { action: undo(view) });
    },

    async duplicate(view, ids) {
      if (await allowed(view)) view.duplicatePages(ids);
    },

    async move(view, ids, index) {
      if (await allowed(view)) view.movePages(ids, index);
    },

    async insertBlank(view, index) {
      if (await allowed(view)) view.insertBlankPage(index);
    },

    async insertFromFile(view, index) {
      if (!(await allowed(view))) return;
      const { files } = await bridge.request('openDialog', { title: 'Insert pages from' });
      await actions.insertFiles(view, files, index);
    },

    /** files: described by the host (from the open dialog or a drop). */
    async insertFiles(view, files, index) {
      if (!files?.length || !(await allowed(view))) return;
      let at = index;
      for (const file of files) {
        try {
          at += await view.insertFile(file, at);
        } catch (err) {
          toast(`Couldn’t insert “${file.name}”: ${err.message}`, { kind: 'error', timeout: 6000 });
        }
      }
      if (at > index) toast(`Inserted ${plural(at - index, 'page')}`, { kind: 'success', action: undo(view) });
    },

    async extract(view, ids) {
      if (!usable(view) || !ids.length) return;
      const numbers = numbersOf(view, ids);
      const name = `${baseName(view.file.name)} (${numbers.length === 1 ? 'page' : 'pages'} ${describePages(numbers).replaceAll('–', '-')}).pdf`;
      const { file } = await bridge.request('saveAsDialog', { path: view.file.path, name, title: 'Extract pages to' });
      if (!file) return;
      try {
        await view.writeFile(file, await view.exportPages(ids));
        toast(`Saved ${plural(ids.length, 'page')} to “${file.name}”`, { kind: 'success', action: { label: 'Open', run: () => onOpenFile(file) } });
      } catch (err) {
        showDialog({ title: 'Couldn’t extract the pages', message: err.message, iconName: 'triangle-alert' });
      }
    },

    async split(view, selectedIds = []) {
      if (!usable(view)) return;
      const plan = view.annotations.plan;
      const total = plan.length;
      if (total < 2) {
        toast('This document has only one page.');
        return;
      }
      const groups = await askHowToSplit(total, numbersOf(view, selectedIds));
      if (!groups) return;
      const names = groups.map((_, i) => `${baseName(view.file.name)} (part ${i + 1}).pdf`);
      const { files } = await bridge.request('splitTargets', { names, path: view.file.path });
      if (!files?.length) return;
      try {
        for (let i = 0; i < groups.length; i++) {
          const ids = groups[i].map((n) => plan[n - 1].id);
          await view.writeFile(files[i], await view.exportPages(ids));
        }
        toast(`Split into ${plural(files.length, 'file')}`, {
          kind: 'success', action: { label: 'Show', run: () => bridge.request('showInFolder', { path: files[0].path }) },
        });
      } catch (err) {
        showDialog({ title: 'Couldn’t split the document', message: err.message, iconName: 'triangle-alert' });
      }
    },

    /**
     * Merge Documents: several PDFs chosen from disk into one new file. It needs no open document —
     * the chosen files are only read, and the merge itself is pages/merge.js over the writer every
     * other page operation uses.
     */
    async merge() {
      const { files } = await bridge.request('openDialog', { title: 'Choose PDFs to merge' });
      if (!files?.length) return;
      let inputs = await readForMerge(files);
      if (inputs.length < MINIMUM_INPUTS) {
        // A file that couldn't be read has already said so by name.
        if (inputs.length) toast(`Choose at least ${MINIMUM_INPUTS} PDFs to merge.`);
        return;
      }
      inputs = await askWhatToMerge(inputs);
      if (!inputs) return;

      const target = await bridge.request('saveAsDialog', {
        path: inputs[0].path, name: mergedFileName(inputs[0].name), title: 'Save the merged PDF as',
      });
      const file = target?.file;
      if (!file) return;
      try {
        await writePdfFile(file, await mergeDocuments(inputs));
        toast(`Merged ${plural(inputs.length, 'PDF')} into “${file.name}”`, {
          kind: 'success', action: { label: 'Open', run: () => onOpenFile(file) },
        });
      } catch (err) {
        showDialog({ title: 'Couldn’t merge the PDFs', message: err.message, iconName: 'triangle-alert' });
      }
    },

    /** Right-click menu on thumbnails. `index` is the page right-clicked (inserts go after it). */
    contextMenu(view, ids, { x, y, index }) {
      const off = !view.canEditPages;
      const n = ids.length;
      const which = n === 1 ? 'page' : `${n} pages`;
      openMenu([
        { label: `Rotate ${which} right`, icon: 'rotate-cw', disabled: off, action: () => actions.rotate(view, ids, 90) },
        { label: `Rotate ${which} left`, icon: 'rotate-ccw', disabled: off, action: () => actions.rotate(view, ids, -90) },
        { label: `Crop ${which}…`, icon: 'minimize-2', disabled: off, action: () => actions.crop(view, ids) },
        { label: `Duplicate ${which}`, icon: 'copy-plus', shortcut: 'Ctrl+D', disabled: off, action: () => actions.duplicate(view, ids) },
        { label: `Copy ${which}`, icon: 'copy', shortcut: 'Ctrl+C', disabled: off, action: () => actions.copy(view, ids) },
        { label: 'Paste pages after', icon: 'files', shortcut: 'Ctrl+V', disabled: off || !copied, action: () => actions.paste(view, index) },
        '-',
        { label: 'Insert blank page after', icon: 'file-plus', disabled: off, action: () => actions.insertBlank(view, index) },
        { label: 'Insert pages from file…', icon: 'files', disabled: off, action: () => actions.insertFromFile(view, index) },
        '-',
        { label: `Extract ${which}…`, icon: 'file-output', disabled: off, action: () => actions.extract(view, ids) },
        { label: 'Split into files…', icon: 'scissors', disabled: off, action: () => actions.split(view, n > 1 ? ids : []) },
        '-',
        { label: `Delete ${which}`, icon: 'trash-2', shortcut: 'Del', disabled: off, action: () => actions.remove(view, ids) },
      ], { x, y });
    },

    /** The "Page tools" button in the sidebar. */
    panelMenu(view, panel, anchor) {
      if (!view || view.status !== 'ready') return;
      const off = !view.canEditPages;
      const after = view.state.pageNumber;
      const ids = panel?.targetIds() ?? [];
      openMenu([
        { label: 'Insert blank page', icon: 'file-plus', disabled: off, action: () => actions.insertBlank(view, after) },
        { label: 'Insert pages from file…', icon: 'files', disabled: off, action: () => actions.insertFromFile(view, after) },
        '-',
        { label: 'Merge PDFs…', icon: 'combine', action: () => actions.merge() },
        '-',
        { label: ids.length > 1 ? `Extract ${ids.length} pages…` : 'Extract this page…', icon: 'file-output', disabled: off, action: () => actions.extract(view, ids) },
        { label: 'Split into files…', icon: 'scissors', disabled: off, action: () => actions.split(view, panel?.selectedIds ?? []) },
        '-',
        { label: ids.length > 1 ? `Crop ${ids.length} pages…` : 'Crop page…', icon: 'minimize-2', disabled: off || !ids.length, action: () => actions.crop(view, ids) },
        { label: 'Page numbers…', icon: 'file-text', disabled: off, action: () => actions.pageNumbers(view, ids) },
        { label: 'Watermark…', icon: 'blend', disabled: off, action: () => actions.watermark(view, ids) },
        '-',
        { label: 'Select all pages', icon: 'list-checks', shortcut: 'Ctrl+A', disabled: !panel, action: () => panel?.selectAll() },
      ], { anchor, align: 'end' });
    },
  };
  return actions;
}

const SIDES = ['top', 'right', 'bottom', 'left']; // clockwise, as shown
const toMm = (pt) => Math.round((pt * 25.4 / 72) * 10) / 10;
const fromMm = (mm) => Math.max(0, Number(mm) || 0) * 72 / 25.4;
const label = (position) => position.split('-').map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');

async function checkText(text) {
  const bad = await unsupportedCharacters(await loadPdfLib(), text);
  return bad ? `These characters can’t be written in the standard PDF font: ${bad}` : null;
}

/**
 * The picture row of the Watermark dialog: a thumbnail of the chosen picture and a Choose button.
 * choose() asks for a file and resolves true when something changed; the row then asks the dialog to
 * check it again. close() lets the thumbnail go.
 */
function picturePicker(current, choose) {
  let url = null;
  const thumb = h('img', { class: 'watermark-thumb', alt: '' });
  const name = h('span', { class: 'watermark-picture-name' });
  const button = h('button', { class: 'btn', type: 'button', text: 'Choose picture…' });
  const node = h('div', { class: 'watermark-picture' }, thumb, name, button);
  const show = () => {
    const { picture, bytes } = current();
    if (url) URL.revokeObjectURL(url);
    url = picture && bytes ? URL.createObjectURL(new Blob([bytes], { type: picture.format === 'png' ? 'image/png' : 'image/jpeg' })) : null;
    thumb.hidden = !url;
    if (url) thumb.src = url;
    name.textContent = picture ? '' : 'No picture chosen';
  };
  button.addEventListener('click', async () => {
    if (!(await choose())) return;
    show();
    node.dispatchEvent(new Event('input', { bubbles: true }));
  });
  show();
  return { node, close: () => url && URL.revokeObjectURL(url) };
}

/**
 * The dialog for crop, page numbers and watermarks: a few fields, which pages, Apply or Remove.
 * `modes` ({ value, options, label }) adds a segmented choice above the fields; a field with a `mode`
 * shows only in that mode, and values.mode says which was chosen. A 'custom' field is its own `node`.
 * Resolves { all, remove, values } or null if cancelled.
 */
async function askForPageSetting({ title, message, iconName, count, total, preferAll = false, removable, modes, fields, preview, check }) {
  const inputs = new Map();
  let mode = modes?.value;
  const rows = fields.map((f) => {
    if (f.type === 'custom') return h('div', { class: `page-setting${f.wide ? ' wide' : ''}`, 'data-mode': f.mode }, h('span', { text: f.label }), f.node);
    const input = f.type === 'select'
      ? h('select', { class: 'field' }, ...f.options.map(([value, text]) => h('option', { value, text, selected: value === f.value })))
      : h('input', { class: 'field', type: f.type, value: String(f.value), min: f.min, max: f.max, step: f.type === 'number' ? 'any' : null, spellcheck: 'false' });
    input.setAttribute('aria-label', f.label);
    inputs.set(f.key, input);
    return h('label', { class: `page-setting${f.wide ? ' wide' : ''}`, 'data-mode': f.mode }, h('span', { text: f.label }),
      h('span', { class: 'page-setting-input' }, input, f.unit ? h('span', { class: 'unit', text: f.unit }) : null));
  });
  const option = (value, text, checked) => h('label', { class: 'choice' },
    h('input', { type: 'radio', name: 'page-scope', value, checked }), h('span', { class: 'choice-label', text }));
  const scope = h('div', { class: 'choices' },
    option('selected', count === 1 ? 'This page' : `Selected pages (${count})`, !preferAll),
    option('all', `All pages (${total})`, preferAll));
  const note = h('p', { class: 'dialog-note' });
  const settings = h('div', { class: 'page-settings' }, rows);
  const values = () => ({ ...Object.fromEntries([...inputs].map(([k, el]) => [k, el.value])), mode });
  const shown = (f) => !f.mode || f.mode === mode;
  let switcher = null;
  if (modes) {
    const buttons = modes.options.map(([id, text]) => h('button', { class: 'seg-btn', type: 'button', role: 'radio', 'data-mode': id, text }));
    switcher = h('div', { class: 'seg page-setting-modes', role: 'radiogroup', 'aria-label': modes.label }, ...buttons);
    switcher.style.setProperty('--seg-count', String(buttons.length));
    const pick = (id) => {
      mode = id;
      buttons.forEach((b, i) => {
        b.setAttribute('aria-checked', String(b.dataset.mode === id));
        if (b.dataset.mode === id) switcher.style.setProperty('--seg-index', String(i));
      });
      for (const row of rows) if (row.dataset.mode) row.hidden = row.dataset.mode !== id;
    };
    for (const b of buttons) b.addEventListener('click', () => { pick(b.dataset.mode); update(); });
    pick(mode);
  }
  let primary = null;
  let valid = true;
  let turn = 0;
  const update = async () => {
    const v = values();
    const mine = ++turn;
    const bad = fields.find((f) => f.type === 'number' && shown(f) && (v[f.key] === '' || !Number.isFinite(Number(v[f.key])) || Number(v[f.key]) < f.min || (f.max != null && Number(v[f.key]) > f.max)));
    const problem = bad ? `${bad.label}: enter a number from ${bad.min}${bad.max != null ? ` to ${bad.max}` : ' up'}.` : await check?.(v);
    if (mine !== turn) return;
    valid = !problem;
    if (primary) primary.disabled = !valid;
    note.textContent = problem ?? preview?.(v) ?? '';
  };
  settings.addEventListener('input', update);

  const buttons = [{ id: 'cancel', label: 'Cancel' }, { id: 'ok', label: 'Apply', primary: true }];
  if (removable) buttons.unshift({ id: 'remove', label: 'Remove' });
  const result = await showDialog({
    title, message, iconName, className: 'page-setting-dialog',
    content: [switcher, settings, scope, note],
    buttons,
    onOpen: (dialog) => {
      primary = dialog.querySelector('.btn.primary');
      update();
      return dialog.querySelector('.page-settings input, .page-settings select');
    },
  });
  const all = scope.querySelector('input:checked')?.value === 'all';
  if (result === 'remove') return { all, remove: true, values: values() };
  return result === 'ok' && valid ? { all, remove: false, values: values() } : null;
}

/** The Split dialog. Resolves with groups of page numbers, or null if cancelled. */
async function askHowToSplit(total, selected) {
  const cuts = selected.filter((n) => n > 1);
  const every = h('input', { class: 'field inline', type: 'number', min: '1', max: String(total), value: String(Math.max(1, Math.ceil(total / 2))) });
  const ranges = h('input', { class: 'field', type: 'text', spellcheck: 'false', placeholder: `e.g. 1-3, 4-${total}` });
  const summary = h('p', { class: 'dialog-note' });
  const option = (value, label, extra = null, disabled = false) => h('label', { class: `choice${disabled ? ' disabled' : ''}` },
    h('input', { type: 'radio', name: 'split-mode', value, disabled }), h('span', { class: 'choice-label' }, label, extra));
  const choices = h('div', { class: 'choices' },
    option('every', 'Every ', [every, ' pages']),
    option('selected', cuts.length ? `Before each selected page (${describePages(cuts)})` : 'Before each selected page', null, !cuts.length),
    option('ranges', 'Page ranges', ranges));
  let primary = null;
  let groups = null;

  const compute = () => {
    const mode = choices.querySelector('input[name="split-mode"]:checked')?.value;
    if (mode === 'every') {
      const size = Number(every.value);
      if (!Number.isInteger(size) || size < 1 || size >= total) return null;
      const out = [];
      for (let start = 1; start <= total; start += size) out.push(range(start, Math.min(total, start + size - 1)));
      return out;
    }
    if (mode === 'selected') {
      const points = [1, ...cuts, total + 1];
      return points.slice(0, -1).map((start, i) => range(start, points[i + 1] - 1));
    }
    const parsed = parseRanges(ranges.value, total);
    return parsed?.map(([a, b]) => range(a, b)) ?? null;
  };
  const update = () => {
    groups = compute();
    if (primary) primary.disabled = !groups;
    summary.textContent = groups
      ? `Creates ${plural(groups.length, 'file')}: ${groups.slice(0, 4).map((g) => `pages ${describePages(g)}`).join(' · ')}${groups.length > 4 ? ' …' : ''}`
      : 'Enter page ranges between 1 and ' + total + '.';
  };
  choices.addEventListener('change', update);
  every.addEventListener('input', () => { choices.querySelector('input[value="every"]').checked = true; update(); });
  ranges.addEventListener('input', () => { choices.querySelector('input[value="ranges"]').checked = true; update(); });
  choices.querySelector(`input[value="${cuts.length ? 'selected' : 'every'}"]`).checked = true;

  const result = await showDialog({
    title: 'Split into separate PDFs',
    message: `This document has ${plural(total, 'page')}. Choose where to split it; each part is saved as a new file and this document isn’t changed.`,
    iconName: 'scissors',
    className: 'split-dialog',
    content: [choices, summary],
    buttons: [{ id: 'cancel', label: 'Cancel' }, { id: 'ok', label: 'Choose folder…', primary: true }],
    onOpen: (dialog) => {
      primary = dialog.querySelector('.btn.primary');
      update();
      return primary;
    },
  });
  return result === 'ok' ? groups : null;
}

/**
 * Reads the chosen files and counts their pages, so a protected or damaged one is named and left out
 * before the list is even shown. Files already listed are not read twice.
 */
async function readForMerge(files, existing = []) {
  const wanted = withoutDuplicates([...existing, ...(files ?? []).map((f) => ({ ...f, id: newId() }))]);
  const fresh = wanted.filter((f) => !existing.includes(f));
  const kept = [];
  for (const f of wanted) {
    if (!fresh.includes(f)) { kept.push(f); continue; }
    try {
      const response = await fetch(f.url);
      if (!response.ok) throw new Error(`“${f.name}” couldn’t be read.`);
      const [counted] = await countInputs([{ ...f, bytes: new Uint8Array(await response.arrayBuffer()) }]);
      kept.push(counted);
    } catch (err) {
      toast(err.message, { kind: 'error', timeout: 6000 });
    }
  }
  return kept;
}

/** The merge list: the documents in the order they will be merged, reordered or dropped before merging. */
async function askWhatToMerge(initial) {
  let inputs = initial;
  let selected = inputs[0].id;
  const list = h('div', { class: 'merge-list', role: 'listbox', 'aria-label': 'Documents to merge' });
  const summary = h('p', { class: 'dialog-note' });
  let primary = null;

  const button = (name, label, disabled, run) => h('button', {
    class: 'merge-btn', type: 'button', title: label, 'aria-label': label, disabled, html: icon(name, 16),
    onClick: (e) => { e.stopPropagation(); run(); },
  });

  const render = () => {
    list.replaceChildren(...inputs.map((f, i) => h('div', {
      class: `merge-item${f.id === selected ? ' selected' : ''}`, role: 'option', tabindex: '0',
      'aria-selected': f.id === selected ? 'true' : 'false',
      onClick: () => { selected = f.id; render(); },
      onKeydown: (e) => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); selected = f.id; render(); } },
    },
    h('span', { class: 'merge-order', text: String(i + 1) }),
    h('span', { class: 'merge-name', text: f.name, title: f.path ?? f.name }),
    h('span', { class: 'merge-pages', text: plural(f.pageCount, 'page') }),
    h('span', { class: 'merge-buttons' },
      button('chevron-up', 'Move up', i === 0, () => { inputs = moveInput(inputs, f.id, -1); selected = f.id; render(); }),
      button('chevron-down', 'Move down', i === inputs.length - 1, () => { inputs = moveInput(inputs, f.id, 1); selected = f.id; render(); }),
      button('x', 'Remove from the list', inputs.length <= MINIMUM_INPUTS, () => {
        inputs = removeInput(inputs, f.id);
        selected = inputs[Math.min(i, inputs.length - 1)]?.id ?? null;
        render();
      })),
    )));
    const enough = inputs.length >= MINIMUM_INPUTS;
    if (primary) primary.disabled = !enough;
    summary.textContent = enough
      ? `${plural(inputs.length, 'document')} · ${plural(mergedPageCount(inputs), 'page')} in the merged PDF`
      : `Merging needs at least ${MINIMUM_INPUTS} documents.`;
  };

  const add = h('button', {
    class: 'btn small', type: 'button',
    onClick: async () => {
      const { files } = await bridge.request('openDialog', { title: 'Add PDFs to merge' });
      if (!files?.length) return;
      inputs = await readForMerge(files, inputs);
      render();
    },
  }, 'Add files…');

  render();
  const result = await showDialog({
    title: 'Merge PDFs',
    message: 'The documents are merged in this order into one new PDF. The files you chose aren’t changed.',
    iconName: 'combine',
    className: 'merge-dialog',
    content: [list, h('div', { class: 'merge-add' }, add), summary],
    buttons: [{ id: 'cancel', label: 'Cancel' }, { id: 'ok', label: 'Save as…', primary: true }],
    onOpen: (dialog) => {
      primary = dialog.querySelector('.btn.primary');
      render();
      return primary;
    },
  });
  return result === 'ok' && inputs.length >= MINIMUM_INPUTS ? inputs : null;
}

function range(a, b) {
  return Array.from({ length: b - a + 1 }, (_, i) => a + i);
}
