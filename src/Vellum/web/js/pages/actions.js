import { bridge } from '../bridge.js';
import { h } from '../dom.js';
import { openMenu } from '../ui/menu.js';
import { showDialog, toast } from '../ui/dialogs.js';

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
  const allowed = (view) => {
    if (view?.canEditPages) return true;
    toast(view?.encrypted ? 'This PDF is protected, so its pages can’t be changed.' : 'The document is still opening.', { kind: 'error' });
    return false;
  };
  const undo = (view) => ({ label: 'Undo', run: () => view.annotations.undo() });
  const numbersOf = (view, ids) => ids.map((id) => view.annotations.plan.findIndex((e) => e.id === id) + 1).filter((n) => n > 0);

  const actions = {
    rotate(view, ids, delta) {
      if (allowed(view)) view.rotatePages(ids, delta);
    },

    remove(view, ids) {
      if (!allowed(view) || !ids.length) return;
      if (view.deletePages(ids)) toast(`Deleted ${plural(ids.length, 'page')}`, { action: undo(view) });
    },

    duplicate(view, ids) {
      if (allowed(view)) view.duplicatePages(ids);
    },

    move(view, ids, index) {
      if (allowed(view)) view.movePages(ids, index);
    },

    insertBlank(view, index) {
      if (allowed(view)) view.insertBlankPage(index);
    },

    async insertFromFile(view, index) {
      if (!allowed(view)) return;
      const { files } = await bridge.request('openDialog', { title: 'Insert pages from' });
      await actions.insertFiles(view, files, index);
    },

    /** files: described by the host (from the open dialog or a drop). */
    async insertFiles(view, files, index) {
      if (!files?.length || !allowed(view)) return;
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
      if (!allowed(view) || !ids.length) return;
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
      if (!allowed(view)) return;
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

    /** Right-click menu on thumbnails. `index` is the page right-clicked (inserts go after it). */
    contextMenu(view, ids, { x, y, index }) {
      const off = !view.canEditPages;
      const n = ids.length;
      const which = n === 1 ? 'page' : `${n} pages`;
      openMenu([
        { label: `Rotate ${which} right`, icon: 'rotate-cw', disabled: off, action: () => actions.rotate(view, ids, 90) },
        { label: `Rotate ${which} left`, icon: 'rotate-ccw', disabled: off, action: () => actions.rotate(view, ids, -90) },
        { label: `Duplicate ${which}`, icon: 'copy-plus', disabled: off, action: () => actions.duplicate(view, ids) },
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
        { label: ids.length > 1 ? `Extract ${ids.length} pages…` : 'Extract this page…', icon: 'file-output', disabled: off, action: () => actions.extract(view, ids) },
        { label: 'Split into files…', icon: 'scissors', disabled: off, action: () => actions.split(view, panel?.selectedIds ?? []) },
        '-',
        { label: 'Select all pages', icon: 'list-checks', shortcut: 'Ctrl+A', disabled: !panel, action: () => panel?.selectAll() },
      ], { anchor, align: 'end' });
    },
  };
  return actions;
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

function range(a, b) {
  return Array.from({ length: b - a + 1 }, (_, i) => a + i);
}
