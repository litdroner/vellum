import { bridge, writePdfFile } from '../bridge.js';
import { h } from '../dom.js';
import { icon } from '../icons.js';
import { openMenu } from '../ui/menu.js';
import { showDialog, toast } from '../ui/dialogs.js';
import { loadPdfLib } from '../annotations/persist.js';
import { newId } from '../annotations/model.js';
import { readPicture } from '../editing/objects/image.js';
import { decodeBase64 } from '../ui/text-editor.js';
import { PAGE_NUMBER_POSITIONS, PAGE_NUMBER_STYLES, WATERMARK_POSITIONS, pageNumberText, unsupportedCharacters } from './stamps.js';
import { MINIMUM_INPUTS, countInputs, mergeDocuments, mergedFileName, mergedPageCount, moveInput, removeInput, withoutDuplicates } from './merge.js';
import { bookmarkSections, sectionFileNames, topLevelBookmarks } from './outline.js';
import { CROP_SIDES as SIDES, cropProblem, isCrop, ownSides, quarterTurns, rectFromMargins, scopeIds, shownSides } from './crop.js';
import { cropPreview } from '../ui/crop.js';

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

    /**
     * Crop: a rectangle drawn on the page as it is shown, or the same four margins typed in — one and
     * the same crop, kept per page in the page's own (unrotated) sides, which the page writer turns
     * into the page's /CropBox when the document is saved. Nothing is deleted or rasterized, and the
     * file on disk is untouched until it is saved.
     */
    async crop(view, ids) {
      if (!ids.length || !(await allowed(view))) return;
      const plan = view.annotations.plan;
      const entries = plan.filter((e) => ids.includes(e.id));
      // How each page is shown — its quarter turns and its size — from the pages on screen.
      const shownPages = await Promise.all(view.shownPlan.map(async (e, i) => {
        const page = await view.pdf.getPage(i + 1);
        const { width, height } = page.getViewport({ scale: 1, rotation: page.rotate });
        return [e.id, { index: i, turns: quarterTurns(page.rotate), size: { width, height }, page }];
      }));
      const shownById = new Map(shownPages);
      const turnsOf = (e) => shownById.get(e.id)?.turns ?? 0;

      // The page the rectangle is drawn on: the one being read, when it is one of the chosen, else the
      // first chosen page. Its crop, as it is shown, is where the rectangle starts.
      const current = view.shownPlan[view.state.pageNumber - 1];
      const on = entries.find((e) => e.id === current?.id) ?? entries[0];
      const info = shownById.get(on.id) ?? { turns: 0, size: { width: 612, height: 792 }, page: null };
      const start = shownSides(on.crop, info.turns);

      let bound = null;
      const ui = cropPreview({ page: info.page, size: info.size, margins: start });
      const mmOf = (margins) => Object.fromEntries(SIDES.map((side) => [side, toMm(margins[side])]));
      ui.node.addEventListener('input', () => bound?.setValues(mmOf(ui.margins())));

      const typed = (v) => Object.fromEntries(SIDES.map((side) => [side, fromMm(v[side])]));
      const scopeCount = (v) => scopeIds(v.scope, { plan, selected: ids }).length;

      try {
        const answer = await askForPageSetting({
          title: 'Crop pages', iconName: 'minimize-2', count: ids.length, total: plan.length, removable: entries.some((e) => e.crop),
          message: 'Drag the rectangle to choose what to keep. Nothing is deleted: the hidden parts stay in the file.',
          fields: [
            { key: 'rect', type: 'custom', label: `Page ${(info.index ?? 0) + 1}`, wide: true, node: ui.node },
            ...SIDES.map((side) => ({ key: side, label: side[0].toUpperCase() + side.slice(1), type: 'number', unit: 'mm', value: toMm(start[side]), min: 0 })),
          ],
          scopes: [
            ['selected', ids.length === 1 ? 'This page' : `Selected pages (${ids.length})`],
            ['odd', `Odd pages (${scopeIds('odd', { plan }).length})`],
            ['even', `Even pages (${scopeIds('even', { plan }).length})`],
            ['all', `All pages (${plan.length})`],
          ],
          bind: (api) => { bound = api; },
          // The four fields and the rectangle are one crop: whichever was edited, the other follows.
          preview: (v) => {
            const wanted = mmOf(typed(v));
            const drawn = mmOf(ui.margins());
            if (SIDES.some((side) => Math.abs(wanted[side] - drawn[side]) > 0.05)) ui.set(typed(v));
            const rect = rectFromMargins(typed(v), info.size);
            const pages = plural(scopeCount(v), 'page');
            return `Keeps ${toMm(rect.width)} × ${toMm(rect.height)} mm of ${pages}.`;
          },
          // An empty crop, or one that leaves nothing of a page it would be applied to, is refused here
          // rather than failing when the document is saved.
          check: (v) => {
            const margins = typed(v);
            const targets = scopeIds(v.scope, { plan, selected: ids });
            if (!targets.length) return 'No pages are chosen.';
            if (!isCrop(margins)) return 'Drag a rectangle, or enter a margin, to crop.';
            for (const id of targets) {
              const page = shownById.get(id);
              const problem = page && cropProblem(margins, page.size);
              if (problem) return `${problem.replace(/the page/, `page ${page.index + 1}`)}`;
            }
            return null;
          },
        });
        if (!answer) return;
        const targets = scopeIds(answer.scope, { plan, selected: ids });
        const margins = typed(answer.values);
        const value = answer.remove ? null : (e) => {
          const crop = ownSides(margins, turnsOf(e));
          return isCrop(crop) ? crop : null;
        };
        if (view.setPageSetting(targets, 'crop', value)) {
          toast(answer.remove ? 'Crop removed' : `Cropped ${plural(targets.length, 'page')}`, { action: undo(view) });
        }
      } finally {
        ui.close();
      }
    },

    async pageNumbers(view, ids) {
      if (!(await allowed(view))) return;
      const plan = view.annotations.plan;
      const current = { format: 'Page {n} of {total}', position: 'bottom-center', size: 10, start: 1, style: 'arabic', restart: false,
        ...plan.find((e) => ids.includes(e.id) && e.pageNumber)?.pageNumber };
      // What the numbers would read, from the settings as they stand, without applying anything.
      const reading = (v, n, count) => pageNumberText(
        { format: v.format, start: Math.round(Number(v.start)), style: v.style }, n, count);
      const answer = await askForPageSetting({
        title: 'Page numbers', iconName: 'file-text', count: ids.length, total: plan.length, preferAll: true, removable: plan.some((e) => e.pageNumber),
        message: 'Adds each page’s number as text. {n} is the page’s number and {total} the page count, and anything around them is written as it stands; numbers follow the pages when they’re moved.',
        fields: [
          { key: 'format', label: 'Text', type: 'text', value: current.format, wide: true },
          { key: 'style', label: 'Numerals', type: 'select', value: current.style, options: PAGE_NUMBER_STYLES.map((k) => [k, STYLE_LABELS[k]]) },
          { key: 'position', label: 'Position', type: 'select', value: current.position, options: PAGE_NUMBER_POSITIONS.map((p) => [p, label(p)]) },
          { key: 'size', label: 'Size', type: 'number', unit: 'pt', value: current.size, min: 4, max: 72 },
          { key: 'from', label: 'Count from', type: 'select', value: current.restart ? 'here' : 'document', wide: true,
            options: [['document', 'The first page of the document'], ['here', 'The first of the pages chosen']] },
          { key: 'start', label: 'Start at', type: 'number', value: current.start, min: 0, max: 99999 },
        ],
        preview: (v) => {
          const count = v.from === 'here' ? Math.max(1, answerCount(v, ids.length, plan.length)) : plan.length;
          const first = reading(v, 1, count);
          const second = count > 1 ? reading(v, 2, count) : null;
          return `The first page reads “${first}”${second ? `, the next “${second}”` : ''}.`;
        },
        check: (v) => (v.format.includes('{n}') ? checkText(v.format) : 'Include {n} where the number goes.'),
      });
      if (!answer) return;
      const targets = answer.all ? plan.map((e) => e.id) : ids;
      const { format, position, size, start, style, from } = answer.values;
      const value = answer.remove ? null
        : { format, position, size: Number(size), start: Math.round(Number(start)), style, restart: from === 'here' };
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
      const answer = await askHowToSplit(total, numbersOf(view, selectedIds), await sectionsOf(view, total));
      if (!answer) return;
      const { groups, sections } = answer;
      const names = sections
        ? sectionFileNames(sections, baseName(view.file.name))
        : groups.map((_, i) => `${baseName(view.file.name)} (part ${i + 1}).pdf`);
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

const toMm = (pt) => Math.round((pt * 25.4 / 72) * 10) / 10;
const fromMm = (mm) => Math.max(0, Number(mm) || 0) * 72 / 25.4;
const label = (position) => position.split('-').map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');
const STYLE_LABELS = { arabic: 'Numbers (1, 2, 3)', roman: 'Roman (i, ii, iii)', ROMAN: 'Roman capitals (I, II, III)' };
/** How many pages the preview counts over: the pages chosen, or the whole document when All is picked. */
const answerCount = (v, chosen, total) => (v.all ? total : chosen);

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
 * `scopes` ([value, label]) replaces the two the other settings offer; `bind` is handed
 * { values, setValues } once the dialog is open, for a field that is edited two ways at once.
 * Resolves { all, scope, remove, values } or null if cancelled.
 */
async function askForPageSetting({ title, message, iconName, count, total, preferAll = false, removable, modes, fields, scopes, preview, check, bind }) {
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
  const choices = scopes ?? [
    ['selected', count === 1 ? 'This page' : `Selected pages (${count})`],
    ['all', `All pages (${total})`],
  ];
  const preferred = preferAll ? 'all' : choices[0][0];
  const scope = h('div', { class: 'choices' }, ...choices.map(([value, text]) => option(value, text, value === preferred)));
  const chosenScope = () => scope.querySelector('input:checked')?.value ?? preferred;
  const note = h('p', { class: 'dialog-note' });
  const settings = h('div', { class: 'page-settings' }, rows);
  const values = () => ({ ...Object.fromEntries([...inputs].map(([k, el]) => [k, el.value])), mode, scope: chosenScope(), all: chosenScope() === 'all' });
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
  /** Writes values back into the fields, for a field two things edit at once (the crop rectangle). */
  const setValues = (patch) => {
    let touched = false;
    for (const [key, value] of Object.entries(patch)) {
      const el = inputs.get(key);
      if (el && el.value !== String(value)) { el.value = String(value); touched = true; }
    }
    if (touched) update();
  };
  settings.addEventListener('input', update);
  // The preview can depend on how many pages are being numbered, so it follows the scope too.
  scope.addEventListener('change', update);

  const buttons = [{ id: 'cancel', label: 'Cancel' }, { id: 'ok', label: 'Apply', primary: true }];
  if (removable) buttons.unshift({ id: 'remove', label: 'Remove' });
  const result = await showDialog({
    title, message, iconName, className: 'page-setting-dialog',
    content: [switcher, settings, scope, note],
    buttons,
    onOpen: (dialog) => {
      primary = dialog.querySelector('.btn.primary');
      bind?.({ values, setValues });
      update();
      return dialog.querySelector('.page-settings input, .page-settings select');
    },
  });
  const all = chosenScope() === 'all';
  if (result === 'remove') return { all, scope: chosenScope(), remove: true, values: values() };
  return result === 'ok' && valid ? { all, scope: chosenScope(), remove: false, values: values() } : null;
}

/** The Split dialog. Resolves with groups of page numbers, or null if cancelled. */
/**
 * The sections the document's own bookmarks would cut it into, or [] when it can't be done: fewer than
 * two sections, or the pages on screen (which the outline is read from) not yet matching the page plan.
 */
async function sectionsOf(view, total) {
  const shown = view.shownPlan;
  if (!view.pdf || shown?.length !== total || !shown.every((e, i) => e.id === view.annotations.plan[i].id)) return [];
  const sections = bookmarkSections(await topLevelBookmarks(view.pdf), total);
  return sections.length > 1 ? sections : [];
}

async function askHowToSplit(total, selected, sections = []) {
  const cuts = selected.filter((n) => n > 1);
  const every = h('input', { class: 'field inline', type: 'number', min: '1', max: String(total), value: String(Math.max(1, Math.ceil(total / 2))) });
  const ranges = h('input', { class: 'field', type: 'text', spellcheck: 'false', placeholder: `e.g. 1-3, 4-${total}` });
  const summary = h('p', { class: 'dialog-note' });
  const option = (value, label, extra = null, disabled = false) => h('label', { class: `choice${disabled ? ' disabled' : ''}` },
    h('input', { type: 'radio', name: 'split-mode', value, disabled }), h('span', { class: 'choice-label' }, label, extra));
  const choices = h('div', { class: 'choices' },
    option('every', 'Every ', [every, ' pages']),
    option('selected', cuts.length ? `Before each selected page (${describePages(cuts)})` : 'Before each selected page', null, !cuts.length),
    option('bookmarks', sections.length ? `Before each bookmark (${plural(sections.length, 'section')})` : 'Before each bookmark', null, !sections.length),
    option('ranges', 'Page ranges', ranges));
  let primary = null;
  let groups = null;

  const mode = () => choices.querySelector('input[name="split-mode"]:checked')?.value;
  const compute = () => {
    const chosen = mode();
    if (chosen === 'every') {
      const size = Number(every.value);
      if (!Number.isInteger(size) || size < 1 || size >= total) return null;
      const out = [];
      for (let start = 1; start <= total; start += size) out.push(range(start, Math.min(total, start + size - 1)));
      return out;
    }
    if (chosen === 'selected') {
      const points = [1, ...cuts, total + 1];
      return points.slice(0, -1).map((start, i) => range(start, points[i + 1] - 1));
    }
    if (chosen === 'bookmarks') return sections.length > 1 ? sections.map((s) => range(s.from, s.to)) : null;
    const parsed = parseRanges(ranges.value, total);
    return parsed?.map(([a, b]) => range(a, b)) ?? null;
  };
  const update = () => {
    groups = compute();
    if (primary) primary.disabled = !groups;
    const named = mode() === 'bookmarks' && groups;
    summary.textContent = groups
      ? `Creates ${plural(groups.length, 'file')}: ${(named ? sections.map((s) => s.title ?? `pages ${describePages(range(s.from, s.to))}`) : groups.map((g) => `pages ${describePages(g)}`)).slice(0, 4).join(' · ')}${groups.length > 4 ? ' …' : ''}`
      : mode() === 'bookmarks' ? 'This document has no bookmarks Vellum can split on.'
        : 'Enter page ranges between 1 and ' + total + '.';
  };
  choices.addEventListener('change', update);
  every.addEventListener('input', () => { choices.querySelector('input[value="every"]').checked = true; update(); });
  ranges.addEventListener('input', () => { choices.querySelector('input[value="ranges"]').checked = true; update(); });
  choices.querySelector(`input[value="${cuts.length ? 'selected' : sections.length ? 'bookmarks' : 'every'}"]`).checked = true;

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
  return result === 'ok' && groups ? { groups, sections: mode() === 'bookmarks' ? sections : null } : null;
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
