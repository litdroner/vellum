import { h } from '../dom.js';
import { icon } from '../icons.js';
import { openModal } from './focus.js';
import { showDialog } from './dialogs.js';
import { MAX_STEPS, NAME_MAX, checkWorkflow, cleanName, describeSteps, newStep, newWorkflow, nextOperations, plainParams } from '../flow/model.js';

// Workflows (Vellum Flow V1): the saved workflows, and the editor for one. One modal, two views in place —
//   list    each workflow with its steps ("Convert to PDF → Add page numbers → Compress"), or why it can't run;
//           Run, Edit, Delete; New workflow
//   editor  its name and its steps, in order: each the operation's own choices, moved up or down, or removed;
//           Add step offers only the operations that can follow the last one. Each step says what is wrong with
//           it, and Save stays off until the workflow can run
// Running is not done here: Run resolves with the workflow, and batch processing runs it on the files the person
// adds (flow/actions.js). Built from the batch dialog's list and the page-setting fields; no style of its own
// beyond laying out a step's settings.

let serial = 0;

/**
 * Shows the Workflows dialog; resolves with the workflow to run, or null when closed.
 * services: load() → { workflows, newer, damaged, dropped }, save(workflows), presence() → presence names,
 * pdfLib() (for operation.verify), operations (the registry's Map).
 */
export function showWorkflows({ services }) {
  return new Promise((resolve) => {
    const titleId = `flow-title-${++serial}`;
    const { operations } = services;
    let workflows = [];
    let readOnly = false;
    let loadNote = '';
    let view = 'list';
    let editing = null; // { workflow (a working copy), isNew }

    const title = h('h2', { id: titleId, class: 'dialog-title', text: 'Workflows' });
    const message = h('p', { class: 'dialog-message' });
    const nameInput = h('input', { class: 'field', type: 'text', maxlength: String(NAME_MAX), spellcheck: 'false', 'aria-label': 'Workflow name' });
    const nameRow = h('label', { class: 'page-setting wide flow-name' }, h('span', { text: 'Name' }), nameInput);
    const list = h('ul', { class: 'batch-list flow-list', 'aria-label': 'Workflows' });
    const empty = h('p', { class: 'batch-empty' });
    const addSelect = h('select', { class: 'field', 'aria-label': 'Step to add' });
    const addBtn = h('button', { class: 'btn small', type: 'button', text: 'Add step', onClick: () => addStep() });
    const adder = h('div', { class: 'batch-add flow-add' }, addSelect, addBtn);
    const note = h('p', { class: 'dialog-note', 'aria-live': 'polite' });
    const actions = h('div', { class: 'dialog-actions' });
    const dialog = h('div', { class: 'dialog batch-dialog flow-dialog', role: 'dialog', 'aria-labelledby': titleId },
      h('div', { class: 'dialog-icon', html: icon('list-checks', 22) }),
      title, message, nameRow, empty, list, adder, note, actions);
    const backdrop = h('div', { class: 'dialog-backdrop ui' }, dialog);

    const close = openModal(backdrop, { dialog, onEscape: () => (view === 'editor' ? showList() : finish(null)) });
    if (!close) {
      resolve(null);
      return;
    }
    requestAnimationFrame(() => backdrop.classList.add('open'));

    function finish(result) {
      close();
      backdrop.classList.remove('open');
      setTimeout(() => backdrop.remove(), 250);
      resolve(result);
    }

    /** While a question is up, nothing here takes a click. */
    async function aside(work) {
      backdrop.inert = true;
      try { return await work(); } finally { backdrop.inert = false; }
    }

    const check = (workflow) => checkWorkflow(workflow, { operations, presence: services.presence() });

    function buttons(defs) {
      actions.replaceChildren(...defs.map((d) => h('button', {
        class: `btn${d.primary ? ' primary' : ''}`, type: 'button', disabled: d.disabled, onClick: d.run,
      }, d.label)));
    }

    const iconButton = (glyph, label, run, disabled = false) => h('button', {
      class: 'batch-btn', type: 'button', title: label, 'aria-label': label, html: icon(glyph, 15), disabled, onClick: run,
    });

    // ---- the list ------------------------------------------------------------------------------

    function showList(focusId = null) {
      view = 'list';
      editing = null;
      title.textContent = 'Workflows';
      message.textContent = 'A workflow runs the same steps on each file you give it, one after another. Only the last step’s file is saved; the files you start from aren’t changed.';
      nameRow.hidden = true;
      adder.hidden = true;
      list.setAttribute('aria-label', 'Workflows');
      list.replaceChildren(...workflows.map(workflowRow));
      empty.textContent = readOnly ? 'These workflows were saved by a newer version of Vellum, so this one can’t show or change them.'
        : 'No workflows yet. Choose steps once — such as Convert to PDF, then Add page numbers, then Compress — and run them on any files.';
      empty.hidden = workflows.length > 0;
      note.textContent = loadNote;
      buttons([
        { label: 'New workflow…', disabled: readOnly, run: () => edit(null) },
        { label: 'Close', primary: true, run: () => finish(null) },
      ]);
      const target = (focusId && list.querySelector(`[data-id="${focusId}"] .flow-run`)) || list.querySelector('.flow-run:not([disabled])');
      (target ?? actions.querySelector('.btn:not([disabled])'))?.focus();
    }

    function workflowRow(workflow) {
      const { runnable, problem } = check(workflow);
      const run = h('button', {
        class: 'btn small flow-run', type: 'button', text: 'Run…', disabled: !runnable, 'aria-label': `Run ${workflow.name}`, onClick: () => finish(workflow),
      });
      return h('li', { class: 'batch-item flow-item', dataset: { id: workflow.id, runnable: String(runnable) } },
        h('span', { class: 'batch-glyph', 'aria-hidden': 'true', html: icon(runnable ? 'list-checks' : 'triangle-alert', 16) }),
        h('span', { class: 'batch-text' },
          h('span', { class: 'batch-name', text: workflow.name }),
          h('span', { class: 'batch-detail', text: describeSteps(workflow, { operations }) }),
          runnable ? null : h('span', { class: 'batch-detail flow-problem', text: `Can’t run: ${problem}` })),
        h('span', { class: 'batch-act' },
          run,
          iconButton('pen-line', `Edit ${workflow.name}`, () => edit(workflow)),
          iconButton('trash-2', `Delete ${workflow.name}`, () => remove(workflow))));
    }

    async function remove(workflow) {
      const answer = await aside(() => showDialog({
        title: `Delete “${workflow.name}”?`,
        message: 'Only the workflow is deleted. Files it made, and the files it ran on, stay as they are.',
        iconName: 'trash-2',
        buttons: [{ id: 'delete', label: 'Delete' }, { id: 'keep', label: 'Keep it', primary: true }],
      }));
      if (answer !== 'delete') { showList(workflow.id); return; }
      const next = workflows.filter((w) => w !== workflow);
      if (await store(next)) showList();
    }

    /** Saves the whole list; false (and says why) when it couldn't be. */
    async function store(next) {
      try {
        await services.save(next);
      } catch (err) {
        note.textContent = `The workflows couldn’t be saved: ${err?.message ?? err}`;
        return false;
      }
      workflows = next;
      loadNote = '';
      return true;
    }

    // ---- the editor ----------------------------------------------------------------------------

    function edit(workflow) {
      view = 'editor';
      editing = {
        isNew: !workflow,
        id: workflow?.id ?? null,
        workflow: workflow ? { ...workflow, steps: workflow.steps.map((s) => ({ op: s.op, params: { ...s.params } })) } : newWorkflow(),
        touched: Boolean(workflow),
      };
      title.textContent = workflow ? 'Edit workflow' : 'New workflow';
      message.textContent = 'The steps run in order on each file: each works on the file the step before it made.';
      nameRow.hidden = false;
      nameInput.value = editing.workflow.name;
      empty.textContent = 'No steps yet. Add the first one below.';
      list.setAttribute('aria-label', 'Steps');
      renderEditor();
      nameInput.focus();
    }

    nameInput.addEventListener('input', () => {
      if (!editing) return;
      editing.workflow.name = nameInput.value;
      editing.touched = true;
      refreshEditor();
    });

    function renderEditor(focus = null) {
      const { workflow } = editing;
      const checked = check(workflow);
      list.replaceChildren(...workflow.steps.map((step, i) => stepRow(step, i, checked.steps[i])));
      empty.hidden = workflow.steps.length > 0;
      const next = workflow.steps.length >= MAX_STEPS ? [] : nextOperations(workflow, { operations, presence: services.presence() });
      addSelect.replaceChildren(...next.map((op) => h('option', { value: op.id, text: op.step })));
      adder.hidden = false;
      addSelect.disabled = addBtn.disabled = next.length === 0;
      if (!next.length) addSelect.append(h('option', { value: '', text: workflow.steps.length >= MAX_STEPS ? 'No more steps' : 'Nothing can follow the last step' }));
      refreshEditor();
      focus?.();
    }

    /** The note and Save, as the workflow stands (the rows say what is wrong with each step). */
    function refreshEditor() {
      const checked = check(editing.workflow);
      note.textContent = editing.touched || !checked.runnable ? checked.problem ?? '' : '';
      buttons([
        { label: 'Cancel', run: () => showList(editing.id) },
        { label: 'Save', primary: true, disabled: !checked.runnable, run: () => save() },
      ]);
    }

    function stepRow(step, index, checked) {
      const { workflow } = editing;
      const operation = checked.operation;
      const settings = operation ? operation.choices.map((choice) => setting(step, choice)) : [];
      const last = workflow.steps.length - 1;
      const label = operation?.step ?? 'A step this Vellum doesn’t have';
      return h('li', { class: 'batch-item flow-step', dataset: { index: String(index), op: step.op, problem: checked.problem ? 'true' : 'false' } },
        h('span', { class: 'batch-glyph flow-number', 'aria-hidden': 'true', text: String(index + 1) }),
        h('span', { class: 'batch-text' },
          h('span', { class: 'batch-name', text: label }),
          checked.problem ? h('span', { class: 'batch-detail flow-problem', text: checked.problem }) : null,
          settings.length ? h('span', { class: 'page-settings flow-settings' }, settings) : null),
        h('span', { class: 'batch-act' },
          iconButton('chevron-up', `Move step ${index + 1} up`, () => move(index, -1), index === 0),
          iconButton('chevron-down', `Move step ${index + 1} down`, () => move(index, 1), index === last),
          iconButton('x', `Remove step ${index + 1}, ${label}`, () => removeStep(index))));
    }

    /** One of a step's choices: a list to pick from, or words to type. */
    function setting(step, choice) {
      const current = step.params[choice.param];
      let input;
      if (choice.kind === 'text') {
        input = h('input', { class: 'field', type: 'text', value: typeof current === 'string' ? current : '', maxlength: choice.maxLength ? String(choice.maxLength) : null, spellcheck: 'false' });
        input.addEventListener('input', () => { step.params[choice.param] = input.value; editing.touched = true; refreshStep(input); });
      } else {
        const known = choice.options.some((o) => o.value === current);
        input = h('select', { class: 'field' },
          known ? null : h('option', { value: '', text: 'Choose…', selected: true }),
          ...choice.options.map((o) => h('option', { value: o.value, text: o.label, selected: o.value === current })));
        input.addEventListener('change', () => { step.params[choice.param] = input.value; editing.touched = true; refreshStep(input); });
      }
      return h('label', { class: `page-setting${choice.kind === 'text' ? ' wide' : ''}` }, h('span', { text: choice.label }), input);
    }

    /** A setting changed: the step's own sentence, the note and Save follow, and focus stays where it is. */
    function refreshStep(input) {
      const row = input.closest('.flow-step');
      const index = Number(row.dataset.index);
      const checked = check(editing.workflow).steps[index];
      row.dataset.problem = checked.problem ? 'true' : 'false';
      let said = row.querySelector('.flow-problem');
      if (checked.problem) {
        said ??= row.querySelector('.batch-name').insertAdjacentElement('afterend', h('span', { class: 'batch-detail flow-problem' }));
        said.textContent = checked.problem;
      } else said?.remove();
      refreshEditor();
    }

    function addStep() {
      const op = operations.get(addSelect.value);
      if (!op) return;
      editing.workflow.steps.push(newStep(op));
      editing.touched = true;
      renderEditor(() => addBtn.disabled ? list.querySelector('.flow-step:last-child .batch-btn:last-child')?.focus() : addSelect.focus());
    }

    function move(index, by) {
      const steps = editing.workflow.steps;
      const to = index + by;
      if (to < 0 || to >= steps.length) return;
      [steps[index], steps[to]] = [steps[to], steps[index]];
      editing.touched = true;
      const label = by < 0 ? 'up' : 'down';
      renderEditor(() => {
        const row = list.querySelector(`[data-index="${to}"]`);
        const button = row?.querySelector(`[aria-label^="Move step ${to + 1} ${label}"]`);
        (button && !button.disabled ? button : row?.querySelector('.batch-btn:not([disabled])'))?.focus();
      });
    }

    function removeStep(index) {
      editing.workflow.steps.splice(index, 1);
      editing.touched = true;
      renderEditor(() => (list.querySelector(`[data-index="${Math.min(index, editing.workflow.steps.length - 1)}"] .batch-btn:last-child`) ?? addSelect).focus());
    }

    async function save() {
      const { workflow } = editing;
      workflow.name = cleanName(workflow.name);
      const checked = check(workflow);
      if (!checked.runnable) { note.textContent = checked.problem; return; }
      // What only pdf-lib can check (a watermark's characters), before anything is saved.
      for (const [i, s] of checked.steps.entries()) {
        const problem = await s.operation.verify?.(s.params, { pdfLib: services.pdfLib });
        if (problem) { note.textContent = `Step ${i + 1}: ${problem}`; return; }
      }
      const saved = { id: workflow.id, name: workflow.name, steps: checked.steps.map((s) => ({ op: s.op, params: plainParams(s.params) })) };
      const next = editing.isNew ? [...workflows, saved] : workflows.map((w) => (w.id === editing.id ? saved : w));
      if (await store(next)) showList(saved.id);
    }

    // ---- start ---------------------------------------------------------------------------------

    buttons([{ label: 'Close', primary: true, run: () => finish(null) }]);
    nameRow.hidden = adder.hidden = true;
    note.textContent = 'Loading…';
    Promise.resolve().then(() => services.load()).then((loaded) => {
      workflows = loaded.workflows;
      readOnly = loaded.newer;
      loadNote = loaded.damaged ? 'The saved workflows couldn’t be read, so Vellum kept a copy of that file and started a new list.'
        : loaded.dropped ? `${loaded.dropped === 1 ? 'One saved entry wasn’t' : `${loaded.dropped} saved entries weren’t`} a workflow Vellum can read, and ${loaded.dropped === 1 ? 'was' : 'were'} left out.` : '';
    }, (err) => {
      readOnly = true;
      loadNote = `The saved workflows couldn’t be read: ${err?.message ?? err}`;
    }).then(() => { if (view === 'list') showList(); });
  });
}
