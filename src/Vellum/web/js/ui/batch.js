import { h } from '../dom.js';
import { icon } from '../icons.js';
import { openModal } from './focus.js';
import { addFiles, planBatch, plannedOutputs, resetForRetry, retryable, summarize } from '../batch/engine.js';

// The batch dialog: one operation over the files the person adds. One modal, three stages in place —
//   setup     the files (added from the Open dialog or a folder, each removable), the operation's own choices,
//             and where the new files go: next to each file, or in one folder. The note says what will happen,
//             including what will be skipped and why
//   running   every file with its state (waiting, working, done with its new file, or why not), the whole
//             batch's progress, and Stop. It can't be closed while a file is being worked on
//   finished  what came of each file, a summary that says what didn't work, Try again for the files that
//             can run again, Show in folder for each new file, Close
// It decides nothing about files: the engine plans and runs (batch/engine.js), the host picks files and folders
// and says what is already there (services, from batch/actions.js). Built from the design system's dialog,
// choices, progress and buttons; its own section in app.css only lays out the list.

const GLYPH = { succeeded: 'check', failed: 'triangle-alert', timedOut: 'triangle-alert', skipped: 'minus', cancelled: 'x' };
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
let serial = 0;

/**
 * Shows the batch dialog for `operation` (operations/registry.js); resolves when it closes.
 * services: choose({ folder }) → { files, left, more }, chooseFolder(current) → folder | null,
 * existing(Map folder → names) → names already there, askExisting(names) → 'replace' | 'keepBoth' | null,
 * run(items, { params, overwrite, only, onItem }) → { done, stop }, presence() → presence names,
 * showInFolder(path), noProvider() (the host said Office is gone).
 */
export function showBatch({ operation, services }) {
  return new Promise((resolve) => {
    const titleId = `batch-title-${++serial}`;
    let files = [];
    let destination = { mode: 'beside', folder: null };
    const params = { ...operation.params };
    let items = [];
    let stage = 'setup';
    let overwrite = 'keepBoth';
    let handle = null; // the run, while one is going
    let queue = new Set(); // ids of the items the current run started with
    let notice = ''; // what the last add said (duplicates, files left out)

    const title = h('h2', { id: titleId, class: 'dialog-title', text: operation.name });
    const message = h('p', { class: 'dialog-message', text: operation.about });
    const list = h('ul', { class: 'batch-list', 'aria-label': 'Files' });
    const empty = h('p', { class: 'batch-empty', text: `No files yet. Add the ${operation.noun}s to work on.` });
    const addFilesBtn = h('button', { class: 'btn small', type: 'button', text: 'Add files…', onClick: () => add(false) });
    const addFolderBtn = h('button', { class: 'btn small', type: 'button', text: 'Add folder…', onClick: () => add(true) });
    const count = h('span', { class: 'batch-count' });
    const adder = h('div', { class: 'batch-add' }, addFilesBtn, addFolderBtn, count);

    const radio = (name, value, checked, label, extra = null) => h('label', { class: 'choice' },
      h('input', { type: 'radio', name, value, checked }), h('span', { class: 'choice-label' }, label, extra));
    const choiceGroups = operation.choices.map((choice) => {
      const group = h('div', { class: 'choices', role: 'radiogroup' },
        ...choice.options.map((o) => radio(`batch-${serial}-${choice.param}`, o.value, params[choice.param] === o.value,
          o.label, o.note ? h('span', { class: 'choice-note', text: o.note }) : null)));
      group.addEventListener('change', (e) => { params[choice.param] = e.target.value; });
      return group;
    });
    const folderPath = h('span', { class: 'export-folder-path' });
    const chooseBtn = h('button', { class: 'btn small', type: 'button', text: 'Choose…', onClick: () => pickFolder() });
    const where = h('div', { class: 'choices', role: 'radiogroup', 'aria-label': 'Where the new files go' },
      radio(`batch-${serial}-where`, 'beside', true, 'Next to each file'),
      radio(`batch-${serial}-where`, 'folder', false, 'In one folder', h('span', { class: 'batch-folder' }, folderPath, chooseBtn)));
    where.addEventListener('change', async (e) => {
      if (e.target.value === 'folder' && !destination.folder && !(await pickFolder())) {
        where.querySelector('input[value="beside"]').checked = true;
        return;
      }
      destination = { ...destination, mode: e.target.value };
      renderSetup();
    });
    const options = h('div', { class: 'batch-options' }, ...choiceGroups, where);

    const fill = h('div', { class: 'progress-fill' });
    const bar = h('div', { class: 'progress', hidden: true }, fill);
    const note = h('p', { class: 'dialog-note', 'aria-live': 'polite' });
    const actions = h('div', { class: 'dialog-actions' });
    const dialog = h('div', { class: 'dialog batch-dialog', role: 'dialog', 'aria-labelledby': titleId },
      h('div', { class: 'dialog-icon', html: icon(operation.accept === 'pdf' ? 'minimize-2' : 'file-output', 22) }),
      title, message, adder, empty, list, options, bar, note, actions);
    const backdrop = h('div', { class: 'dialog-backdrop ui' }, dialog);

    // Esc closes it, except while files are being worked on: then it only puts focus on Stop.
    const close = openModal(backdrop, {
      dialog,
      onEscape: () => (stage === 'running' ? actions.querySelector('button')?.focus() : finish()),
    });
    if (!close) {
      resolve(false);
      return;
    }
    requestAnimationFrame(() => backdrop.classList.add('open'));
    let ticker = null;

    function finish() {
      if (stage === 'running') return;
      clearInterval(ticker);
      close();
      backdrop.classList.remove('open');
      setTimeout(() => backdrop.remove(), 250);
      resolve(true);
    }

    /** While a host dialog or a question is up, nothing here takes a click. */
    async function aside(work) {
      backdrop.inert = true;
      try { return await work(); } finally { backdrop.inert = false; }
    }

    async function add(folder) {
      let answer;
      try {
        answer = await aside(() => services.choose({ folder }));
      } catch (err) {
        notice = err?.message ?? String(err);
        renderSetup();
        return;
      }
      const next = addFiles(files, answer?.files ?? []);
      files = next.list;
      const parts = [];
      if (next.duplicates) parts.push(`${plural(next.duplicates, 'file was', 'files were')} already in the list.`);
      if (answer?.left) parts.push(`${plural(answer.left, 'other file')} in that folder ${answer.left === 1 ? 'was' : 'were'} left out: only ${operation.noun}s are added.`);
      else if (answer?.folder && !answer.files?.length) parts.push(`That folder has no ${operation.noun}s in it.`);
      if (next.over || answer?.more) parts.push('A batch holds up to 1000 files; the rest were left out.');
      notice = parts.join(' ');
      renderSetup();
      addFilesBtn.focus();
    }

    async function pickFolder() {
      const chosen = await aside(() => services.chooseFolder(destination.folder)).catch(() => null);
      if (!chosen) return false;
      destination = { mode: 'folder', folder: chosen };
      where.querySelector('input[value="folder"]').checked = true;
      renderSetup();
      return true;
    }

    const plan = () => planBatch({ operation, files, destination, presence: services.presence() });

    function renderSetup() {
      stage = 'setup';
      items = plan();
      folderPath.textContent = destination.folder ?? 'Choose a folder';
      folderPath.title = destination.folder ?? '';
      list.replaceChildren(...items.map((it) => row(it)));
      empty.hidden = items.length > 0;
      count.textContent = items.length ? plural(items.length, 'file') : '';
      const runnable = items.filter((it) => it.status === 'waiting').length;
      const skipped = items.length - runnable;
      const into = destination.mode === 'folder' ? 'in the folder chosen' : 'next to each one';
      const example = operation.outputName(`name.${operation.accept === 'pdf' ? 'pdf' : 'docx'}`);
      note.textContent = [
        notice,
        runnable ? `${plural(runnable, operation.noun)} will each become a new file ${into}, named like “${example}”.` : '',
        skipped ? `${plural(skipped, 'file')} will be skipped, as ${skipped === 1 ? 'its row says' : 'their rows say'}.` : '',
      ].filter(Boolean).join(' ');
      buttons([
        { label: 'Cancel', run: finish },
        { label: 'Start', primary: true, disabled: runnable === 0, run: start },
      ]);
    }

    function row(it) {
      const name = h('span', { class: 'batch-name', text: it.input.name, title: it.input.path });
      const detail = h('span', { class: 'batch-detail' });
      const el = h('li', { class: 'batch-item', dataset: { id: String(it.id) } },
        h('span', { class: 'batch-glyph', 'aria-hidden': 'true' }), h('span', { class: 'batch-text' }, name, detail), h('span', { class: 'batch-act' }));
      paint(el, it);
      return el;
    }

    /** One row as its item is now. */
    function paint(el, it) {
      el.dataset.status = it.status;
      const glyph = el.querySelector('.batch-glyph');
      if (it.status === 'running') glyph.replaceChildren(h('span', { class: 'toast-spinner' }));
      else glyph.innerHTML = icon(GLYPH[it.status] ?? (stage === 'setup' ? 'file' : 'clock'), 16);
      el.querySelector('.batch-detail').textContent = detailOf(it);
      const act = el.querySelector('.batch-act');
      if (stage === 'setup') {
        act.replaceChildren(h('button', {
          class: 'batch-btn', type: 'button', title: 'Remove', 'aria-label': `Remove ${it.input.name}`, html: icon('x', 15),
          onClick: () => { files = files.filter((f) => f !== it.input); notice = ''; renderSetup(); list.querySelector('.batch-btn')?.focus() ?? addFilesBtn.focus(); },
        }));
      } else if (it.status === 'succeeded' && it.result?.output?.path) {
        act.replaceChildren(h('button', {
          class: 'batch-btn', type: 'button', title: 'Show in folder', 'aria-label': `Show ${it.result.output.name} in its folder`, html: icon('folder-open', 15),
          onClick: () => services.showInFolder(it.result.output.path),
        }));
      } else act.replaceChildren();
    }

    function detailOf(it) {
      const seconds = it.startedAt ? ` ${Math.floor((Date.now() - it.startedAt) / 1000)} s` : '';
      switch (it.status) {
        case 'waiting': return stage === 'setup' ? `→ ${it.output.name}` : 'Waiting';
        case 'running': return `${it.progress ?? `${operation.verb}…`}${seconds}`;
        case 'succeeded': return `→ ${it.result.output.name}${it.result.note ? ` · ${it.result.note}` : ''}`;
        default: return it.result?.message ?? '';
      }
    }

    function buttons(defs) {
      actions.replaceChildren(...defs.map((d) => h('button', {
        class: `btn${d.primary ? ' primary' : ''}`, type: 'button', disabled: d.disabled, onClick: d.run,
      }, d.label)));
    }

    async function start() {
      const planned = plan();
      if (!planned.some((it) => it.status === 'waiting')) return;
      // What is already there is asked about once, for the whole batch, before anything runs.
      let existing;
      try {
        existing = await services.existing(plannedOutputs(planned));
      } catch (err) {
        note.textContent = err?.message ?? String(err);
        return;
      }
      if (existing.length) {
        const answer = await aside(() => services.askExisting(existing));
        if (!answer) return;
        overwrite = answer;
      }
      items = planned;
      launch(null);
    }

    function launch(only) {
      stage = 'running';
      queue = new Set(items.filter((it) => it.status === 'waiting' && (!only || only.has(it.id))).map((it) => it.id));
      title.textContent = `${operation.verb}…`;
      message.textContent = operation.about;
      adder.hidden = true;
      options.hidden = true;
      empty.hidden = true;
      bar.hidden = false;
      list.replaceChildren(...items.map((it) => row(it)));
      progress();
      buttons([{ label: 'Stop', run: stop }]);
      actions.querySelector('button').focus();
      ticker = setInterval(() => {
        for (const it of items) if (it.status === 'running') paintItem(it);
      }, 1000);
      handle = services.run(items, {
        params, overwrite, only,
        onItem: (it) => {
          if (it.status === 'running') it.startedAt ??= Date.now();
          else delete it.startedAt;
          paintItem(it);
          progress();
          if (it.status === 'running') list.querySelector(`[data-id="${it.id}"]`)?.scrollIntoView({ block: 'nearest' });
        },
      });
      handle.done.then(done, (err) => done(null, err));
    }

    function paintItem(it) {
      const el = list.querySelector(`[data-id="${it.id}"]`);
      if (el) paint(el, it);
    }

    function progress() {
      const ended = items.filter((it) => queue.has(it.id) && it.status !== 'waiting' && it.status !== 'running').length;
      fill.style.width = `${queue.size ? (ended / queue.size) * 100 : 100}%`;
      if (stage === 'running') note.textContent = `${ended} of ${plural(queue.size, 'file')} finished.`;
    }

    function stop() {
      handle?.stop();
      buttons([{ label: 'Stopping…', disabled: true, run: () => {} }]);
    }

    function done(summary, err) {
      clearInterval(ticker);
      handle = null;
      stage = 'finished';
      const s = summary ?? summarize(items);
      if (items.some((it) => it.result?.stopBatch)) services.noProvider?.();
      for (const it of items) paintItem(it);
      progress();
      const didnt = s.failed + s.timedOut;
      const heading = {
        done: 'Done', partial: 'Done, with problems', failed: 'Nothing was finished', stopped: 'Stopped', nothing: 'Nothing was done',
      }[s.outcome];
      title.textContent = err ? 'Something went wrong' : heading;
      message.textContent = err ? 'The batch stopped unexpectedly. What each file came to is below.' : [
        s.succeeded ? `${plural(s.succeeded, 'new file')} made.` : '',
        didnt ? `${plural(didnt, 'file')} couldn’t be finished.` : '',
        s.cancelled ? `${plural(s.cancelled, 'file')} ${s.cancelled === 1 ? 'was' : 'were'} stopped or not started.` : '',
        s.skipped ? `${plural(s.skipped, 'file')} skipped.` : '',
      ].filter(Boolean).join(' ');
      note.textContent = didnt || s.cancelled ? 'Each file’s row says what happened to it.' : '';
      const again = retryable(items).length;
      buttons([
        ...(again ? [{ label: `Try again (${again})`, run: () => launch(resetForRetry(items)) }] : []),
        { label: 'Close', primary: true, run: finish },
      ]);
      actions.querySelector('.primary')?.focus();
    }

    renderSetup();
    addFilesBtn.focus();
  });
}
