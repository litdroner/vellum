// Workflows in the real app (flow/, ui/flow.js, operations/registry.js, Services/Workflows.cs): Automate lists
// Workflows; a workflow is made from the steps this PC can do (no Office step without Office), its settings checked
// (a watermark the standard font can't write is refused before saving), reordered, saved to the host's
// workflows.json (operation ids and settings only, no paths) and read back when Workflows opens again; Run opens it
// as a batch, which writes one real file per PDF beside it — numbered, watermarked and compressed — and leaves the
// PDFs byte for byte unchanged. An Office step goes first and hands its PDF on held (batch.office with hold,
// batch.release), Stop cancels the conversion and writes nothing for that file; a step this Vellum doesn't have
// is shown as such and can't run until it is removed; Delete asks first; a damaged workflows.json is kept as .bad.
// The Windows dialogs and Office are the test's: batch.choose answers with the suite's files, and
// office.providers, batch.office, batch.release and office.cancel are stubbed on the page. flow.load, flow.save,
// export.targets and /export are the host's own, in the run's throwaway data folder.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { openWithPdfjs } from '../../editing/harness.mjs';

export const files = { first: 'structure', second: 'multipage' };
export const timeoutMs = 180000;

// Every bridge request that shows a Windows dialog (MainWindow*.cs), batch.choose and batch.office among them.
const NATIVE = ['openDialog', 'pictureDialog', 'attachDialog', 'collections.addDialog', 'saveAsDialog', 'splitTargets', 'export.folder', 'html.toPdf', 'office.toPdf', 'history.move'];
const CANCELLED = 'The conversion was cancelled; nothing was saved.';

export async function run(t) {
  const { q, check, shot, settled, waitFor, area } = t;
  const FIRST = t.file('first');
  const SECOND = t.file('second');
  const folder = path.dirname(FIRST);
  const store = path.join(t.dir, 'data', 'workflows.json');
  const J = (v) => JSON.stringify(v);
  const hash = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  const originals = [hash(FIRST), hash(SECOND)];

  await waitFor(settled(FIRST), 25000);
  await waitFor(settled(SECOND), 25000);
  await waitFor(`Boolean(window.__vellum?.actions?.flow && __vellum.ui?.tools)`, 10000);
  const errorsBefore = await q(`__vellum.errors?.length ?? 0`);

  await q(`(async () => {
    const { bridge } = await import(new URL('js/bridge.js', location.href).href);
    const native = new Set(${J(NATIVE)});
    const request = bridge.request;
    const s = window.__flow = { choose: [], office: [], replies: [], released: [], cancels: 0, refused: [], report: null, pending: null };
    s.finish = (reply) => { const p = s.pending; s.pending = null; p?.(reply); };
    bridge.request = function (type, payload) {
      if (type === 'batch.choose') return Promise.resolve(s.choose.shift() ?? { files: [], left: 0, more: 0, folder: null });
      if (type === 'office.providers') return Promise.resolve(s.report);
      if (type === 'office.cancel') { s.cancels++; setTimeout(() => s.finish({ status: 'cancelled', message: ${J(CANCELLED)} }), 50); return Promise.resolve({}); }
      if (type === 'batch.release') { s.released.push(payload.token); return Promise.resolve({ released: true }); }
      if (type === 'batch.office') {
        s.office.push(payload);
        const reply = s.replies.shift();
        return reply === 'hold' ? new Promise((resolve) => { s.pending = resolve; }) : Promise.resolve(reply);
      }
      if (native.has(type)) { s.refused.push(type); return Promise.reject(new Error('this suite never opens a Windows dialog')); }
      return request.call(this, type, payload);
    };
    localStorage.removeItem('vellum.catalog');
    return true;
  })()`);

  const provide = (word, excel, powerpoint) => q(`(async () => {
    __flow.report = { providers: [], formats: [['word', '${word}'], ['excel', '${excel}'], ['powerpoint', '${powerpoint}']].map(([format, status]) => ({ format, status })) };
    await __vellum.actions.office.probe(true);
    return true;
  })()`);
  const opened = (file) => q(`(() => { const f = __vellum.app.views.find((v) => v.file.path.toLowerCase() === ${J(file.toLowerCase())}).file;
    return { token: f.token ?? 'doc', path: f.path, name: f.path.split('\\\\').pop(), size: 1, url: f.url }; })()`);
  const fake = (name) => ({ token: `fake-${name}`, path: path.join(folder, name), name, size: 1, url: 'about:blank' });

  const FLOW = `document.querySelector('.flow-dialog')`;
  const FLOW_OPEN = `Boolean(${FLOW}) && !${FLOW}.closest('.dialog-backdrop').inert && !${FLOW}.closest('.dialog-backdrop').classList.contains('closing')`;
  const BATCH = `document.querySelector('.batch-dialog:not(.flow-dialog)')`;
  const BATCH_OPEN = `Boolean(${BATCH}) && !${BATCH}.closest('.dialog-backdrop').inert`;
  const button = (label, scope) => `[...(${scope}?.querySelectorAll('.dialog-actions .btn') ?? [])].find((b) => b.textContent.startsWith(${J(label)}))`;
  const click = (expr) => q(`(() => { const el = ${expr}; if (!el || el.disabled) return false; el.click(); return true; })()`);
  const title = (scope) => q(`${scope}?.querySelector('.dialog-title')?.textContent ?? null`);
  const note = () => q(`${FLOW}?.querySelector('.dialog-note')?.textContent ?? ''`);
  const workflowRows = () => q(`[...document.querySelectorAll('.flow-dialog .flow-item')].map((el) => ({
    name: el.querySelector('.batch-name').textContent, detail: el.querySelector('.batch-detail').textContent,
    runnable: el.dataset.runnable === 'true', problem: el.querySelector('.flow-problem')?.textContent ?? null,
    run: !el.querySelector('.flow-run').disabled }))`);
  const stepRows = () => q(`[...document.querySelectorAll('.flow-dialog .flow-step')].map((el) => ({
    label: el.querySelector('.batch-name').textContent, problem: el.querySelector('.flow-problem')?.textContent ?? null }))`);
  const addable = () => q(`[...${FLOW}.querySelectorAll('.flow-add option')].map((o) => o.value)`);
  const addStep = async (id) => {
    await q(`(() => { const s = ${FLOW}.querySelector('.flow-add select'); s.value = ${J(id)}; return s.value === ${J(id)}; })()`);
    const before = await q(`${FLOW}.querySelectorAll('.flow-step').length`);
    await click(`${FLOW}.querySelector('.flow-add .btn')`);
    return waitFor(`${FLOW}.querySelectorAll('.flow-step').length === ${before + 1}`, 3000);
  };
  /** Sets one of step `index`'s settings (by its label) as a person would: the change or input event follows. */
  const setStep = (index, label, value) => q(`(() => {
    const row = ${FLOW}.querySelectorAll('.flow-step')[${index}];
    const field = [...row.querySelectorAll('.flow-settings .page-setting')].find((l) => l.firstChild.textContent === ${J(label)})?.querySelector('input, select');
    if (!field) return false;
    field.value = ${J(value)};
    field.dispatchEvent(new Event(field.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }));
    return true;
  })()`);
  const stepButton = (label) => `${FLOW}.querySelector('.flow-step .batch-btn[aria-label^=${J(label)}]')`;
  const openFlow = async () => {
    await q(`(__vellum.commands['flow.open'].run(), true)`);
    return waitFor(`${FLOW_OPEN} && ${FLOW}.querySelector('.dialog-note').textContent !== 'Loading…'`, 5000);
  };
  const closeFlow = async () => {
    await click(button('Close', FLOW));
    return waitFor(`!document.querySelector('.flow-dialog')`, 3000);
  };
  const saved = () => (fs.existsSync(store) ? JSON.parse(fs.readFileSync(store, 'utf8')) : null);
  const pageText = async (file, page) => {
    const js = await openWithPdfjs(new Uint8Array(fs.readFileSync(file)));
    try { return (await (await js.doc.getPage(page)).getTextContent()).items.map((i) => i.str).join(' '); } finally { await js.close(); }
  };

  area('Automate');
  await provide('noProvider', 'noProvider', 'noProvider');
  await q(`__vellum.ui.tools.open({ category: 'automate' })`);
  await waitFor(`document.querySelector('.tools-backdrop:not(.closing)') !== null`, 5000);
  const ids = await q(`[...document.querySelectorAll('.tools-row')].map((el) => el.dataset.tool)`);
  check('Automate lists Workflows beside the batch tools', J(ids) === J(['batch-compress', 'workflows']), J(ids));
  await click(`document.querySelector('.tools-row[data-tool="workflows"] .tools-run')`);
  check('the tool opens Workflows', await waitFor(FLOW_OPEN, 5000));
  check('empty to begin with, and says what a workflow is', await q(`!${FLOW}.querySelector('.batch-empty').hidden && /No workflows yet/.test(${FLOW}.querySelector('.batch-empty').textContent)`));
  check('nothing on disk yet', !fs.existsSync(store));

  area('making one');
  await click(button('New workflow', FLOW));
  check('New workflow opens the editor', (await title(FLOW)) === 'New workflow', await title(FLOW));
  check('Save is off with no steps', await q(`${button('Save', FLOW)}.disabled`));
  check('with no Office on this PC, no Convert to PDF step is offered', J(await addable()) === J(['pdf.compress', 'pdf.pageNumbers', 'pdf.watermark']), J(await addable()));
  await q(`${FLOW}.querySelector('.flow-name input').focus()`);
  await t.c.type('Client copy');
  check('three steps added', await addStep('pdf.pageNumbers') && await addStep('pdf.watermark') && await addStep('pdf.compress'));
  let steps = await stepRows();
  check('in the order they were added', J(steps.map((s) => s.label)) === J(['Add page numbers', 'Add a watermark', 'Compress']), J(steps));
  check('each with its own settings', await q(`[...${FLOW}.querySelectorAll('.flow-step')].map((r) => r.querySelectorAll('.flow-settings .page-setting').length).join()`) === '3,3,1');
  await click(stepButton('Move step 3 up'));
  steps = await stepRows();
  check('a step moves up', J(steps.map((s) => s.label)) === J(['Add page numbers', 'Compress', 'Add a watermark']), J(steps));
  await click(stepButton('Move step 2 down'));
  steps = await stepRows();
  check('and back down', J(steps.map((s) => s.label)) === J(['Add page numbers', 'Add a watermark', 'Compress']), J(steps));
  await setStep(0, 'Position', 'bottom-right');
  await setStep(1, 'Text', 'CLIENT ✓');
  await click(button('Save', FLOW));
  check('a watermark the standard font can’t write isn’t saved', await waitFor(`/can’t be written in the standard PDF font: ✓/.test(${FLOW}.querySelector('.dialog-note').textContent)`, 5000), await note());
  check('… and the editor stays open', (await title(FLOW)) === 'New workflow' && !fs.existsSync(store));
  await setStep(1, 'Text', '');
  check('an empty watermark is said on its step, and Save goes off', await q(`${FLOW}.querySelectorAll('.flow-step')[1].querySelector('.flow-problem')?.textContent === 'Its settings aren’t valid: Enter the watermark text.' && ${button('Save', FLOW)}.disabled`));
  await setStep(1, 'Text', 'CLIENT COPY');
  await shot('flow-editor');
  await click(button('Save', FLOW));
  check('Save goes back to the list', await waitFor(`${FLOW}?.querySelector('.dialog-title')?.textContent === 'Workflows' && ${FLOW}.querySelectorAll('.flow-item').length === 1`, 5000), await note());
  let list = await workflowRows();
  check('listed with its steps, ready to run', list[0]?.name === 'Client copy' && list[0].detail === 'Add page numbers → Add a watermark → Compress' && list[0].run, J(list));
  const onDisk = saved();
  check('saved on this PC as operation ids and settings, nothing else', onDisk?.v === 1 && J(onDisk.workflows[0].steps) === J([
    { op: 'pdf.pageNumbers', params: { format: 'Page {n} of {total}', style: 'arabic', position: 'bottom-right' } },
    { op: 'pdf.watermark', params: { text: 'CLIENT COPY', position: 'center', angle: 'diagonal' } },
    { op: 'pdf.compress', params: { level: 'smaller' } }]) && !/:\\\\/.test(fs.readFileSync(store, 'utf8')), fs.readFileSync(store, 'utf8'));
  await shot('flow-list');

  area('saved');
  check('Close closes it', await closeFlow());
  check('opened again, the workflow is read back from the host', await openFlow() && (await workflowRows())[0]?.name === 'Client copy');

  area('running');
  await click(`${FLOW}.querySelector('.flow-item .flow-run')`);
  check('Run opens it as a batch, named for the workflow', await waitFor(`${BATCH_OPEN} && !document.querySelector('.flow-dialog')`, 5000) && (await title(BATCH)) === 'Client copy', await title(BATCH));
  check('with no choices of its own to make', await q(`${BATCH}.querySelectorAll('.batch-options input[name$="-level"]').length === 0`));
  await q(`__flow.choose.push({ files: [${J(await opened(FIRST))}, ${J(await opened(SECOND))}], left: 0, more: 0, folder: null })`);
  await click(`[...${BATCH}.querySelectorAll('.batch-add .btn')].find((b) => b.textContent === 'Add files…')`);
  await waitFor(`${BATCH}.querySelectorAll('.batch-item').length === 2`, 5000);
  const planned = await q(`[...${BATCH}.querySelectorAll('.batch-detail')].map((d) => d.textContent)`);
  check('each PDF will become one new file, named for the workflow', J(planned) === J(['→ first (Client copy).pdf', '→ second (Client copy).pdf']), J(planned));
  await click(button('Start', BATCH));
  check('it runs to the end', await waitFor(`${BATCH}?.querySelector('.dialog-title')?.textContent === 'Done'`, 60000), await title(BATCH));
  const details = await q(`[...${BATCH}.querySelectorAll('.batch-detail')].map((d) => d.textContent)`);
  check('each row says what every step did', details.every((d) => /Numbered on \d+ pages? · Watermarked on \d+ pages? · /.test(d)), J(details));
  const outputs = ['first (Client copy).pdf', 'second (Client copy).pdf'].map((n) => path.join(folder, n));
  check('one new file per PDF, and nothing in between', outputs.every((f) => fs.existsSync(f))
    && !fs.readdirSync(folder).some((n) => /\((numbered|watermarked|compressed)\)/.test(n)), fs.readdirSync(folder).join(', '));
  const text = await pageText(outputs[1], 2);
  check('numbered and watermarked, as a PDF reader reads it', /Page 2 of \d+/.test(text) && text.includes('CLIENT COPY'), text.slice(0, 200));
  check('the PDFs themselves are byte for byte unchanged', hash(FIRST) === originals[0] && hash(SECOND) === originals[1]);
  await shot('flow-ran');
  await click(button('Close', BATCH));
  await waitFor(`!document.querySelector('.batch-dialog')`, 3000);

  area('an Office step, held, then stopped');
  await provide('ready', 'ready', 'noProvider');
  await openFlow();
  await click(button('New workflow', FLOW));
  check('with Office, Convert to PDF is offered', (await addable())[0] === 'office.toPdf', J(await addable()));
  await q(`${FLOW}.querySelector('.flow-name input').focus()`);
  await t.c.type('Handout');
  await addStep('office.toPdf');
  check('after it, only the steps that take a PDF', J(await addable()) === J(['pdf.compress', 'pdf.pageNumbers', 'pdf.watermark']), J(await addable()));
  await addStep('pdf.pageNumbers');
  await click(stepButton('Move step 2 up'));
  check('an Office step moved after a PDF step says why it can’t be there', (await stepRows())[1]?.problem === 'This step takes an Office document, but the step before it makes a PDF.'
    && await q(`${button('Save', FLOW)}.disabled`), J(await stepRows()));
  await click(stepButton('Move step 1 down'));
  await click(button('Save', FLOW));
  await waitFor(`${FLOW}?.querySelectorAll('.flow-item').length === 2`, 5000);
  await click(`[...${FLOW}.querySelectorAll('.flow-item')].find((el) => el.querySelector('.batch-name').textContent === 'Handout').querySelector('.flow-run')`);
  check('the Office workflow opens as a batch', await waitFor(`${BATCH_OPEN} && ${BATCH}.querySelector('.dialog-title').textContent === 'Handout'`, 5000));
  const firstUrl = (await opened(FIRST)).url;
  await q(`__flow.choose.push({ files: ${J(['a.docx', 'b.docx'].map(fake))}, left: 0, more: 0, folder: null })`);
  await click(`[...${BATCH}.querySelectorAll('.batch-add .btn')].find((b) => b.textContent === 'Add files…')`);
  await waitFor(`${BATCH}.querySelectorAll('.batch-item').length === 2`, 5000);
  // The held PDF: the host's reply names a readable PDF (the suite's own first file) by a token.
  await q(`__flow.replies.push({ status: 'converted', message: 'Converted with Microsoft Office.', provider: 'msoffice', providerName: 'Microsoft Office',
    output: { name: 'a.pdf', path: 'C:\\\\held\\\\a.pdf', token: 'held-a', url: ${J(firstUrl)} } }, 'hold')`);
  await click(button('Start', BATCH));
  check('the second document waits on the host', await waitFor(`__flow.office.length === 2 && __flow.pending !== null`, 20000), await q(`JSON.stringify(__flow.office)`));
  const sent = await q(`__flow.office.map((p) => p)`);
  check('each converted held, by token, not into any folder', J(sent) === J([{ source: 'fake-a.docx', name: 'a.pdf', hold: true }, { source: 'fake-b.docx', name: 'b.pdf', hold: true }]), J(sent));
  check('the held PDF was read and let go', J(await q(`__flow.released`)) === J(['held-a']));
  const handout = path.join(folder, 'a (Handout).pdf');
  check('the first document is done: its numbered PDF written once, beside it', fs.existsSync(handout) && /Page 1 of \d+/.test(await pageText(handout, 1)));
  await click(button('Stop', BATCH));
  check('Stop cancels the conversion', await waitFor(`__flow.cancels === 1`, 3000));
  check('and the batch ends as stopped', await waitFor(`${BATCH}?.querySelector('.dialog-title')?.textContent === 'Stopped'`, 10000), await title(BATCH));
  const stopped = await q(`[...${BATCH}.querySelectorAll('.batch-item')].map((el) => [el.dataset.status, el.querySelector('.batch-detail').textContent])`);
  check('the stopped one says which step, in the host’s words', J(stopped) === J([['succeeded', stopped[0][1]], ['cancelled', `Step 1, Convert to PDF: ${CANCELLED}`]]), J(stopped));
  check('nothing was written for it', !fs.existsSync(path.join(folder, 'b (Handout).pdf')));
  check('Try again offers it', await q(`Boolean(${button('Try again (1)', BATCH)})`));
  await click(button('Close', BATCH));
  await waitFor(`!document.querySelector('.batch-dialog')`, 3000);

  area('a step this Vellum doesn’t have');
  const current = saved();
  fs.writeFileSync(store, J({ ...current, workflows: [...current.workflows, { id: 'future', name: 'From a newer Vellum', steps: [{ op: 'pdf.ocr', params: { language: 'eng' } }, { op: 'pdf.compress', params: {} }] }] }));
  await openFlow();
  list = await workflowRows();
  const future = list.find((w) => w.name === 'From a newer Vellum');
  check('listed, but can’t run, and says why', future && !future.runnable && !future.run && future.problem === 'Can’t run: Step 1: This step isn’t available in this version of Vellum.', J(future));
  check('the others still can', list.filter((w) => w.runnable).length === 2, J(list));
  await click(`[...${FLOW}.querySelectorAll('.flow-item')].find((el) => el.querySelector('.batch-name').textContent === 'From a newer Vellum').querySelector('.batch-btn[aria-label^="Edit"]')`);
  steps = await stepRows();
  check('its unknown step is shown as one', steps[0]?.label === 'A step this Vellum doesn’t have' && /isn’t available/.test(steps[0].problem ?? ''), J(steps));
  await click(stepButton('Remove step 1'));
  await click(button('Save', FLOW));
  check('removed, it saves and can run', await waitFor(`[...${FLOW}.querySelectorAll('.flow-item')].some((el) => el.querySelector('.batch-name').textContent === 'From a newer Vellum' && el.dataset.runnable === 'true')`, 5000));

  area('delete');
  await click(`[...${FLOW}.querySelectorAll('.flow-item')].find((el) => el.querySelector('.batch-name').textContent === 'Handout').querySelector('.batch-btn[aria-label^="Delete"]')`);
  const ASK = `[...document.querySelectorAll('.dialog')].find((d) => d.querySelector('.dialog-title')?.textContent === 'Delete “Handout”?')`;
  check('Delete asks first', await waitFor(`Boolean(${ASK})`, 3000));
  await click(`[...(${ASK}).querySelectorAll('.btn')].find((b) => b.textContent === 'Delete')`);
  check('and deletes it from the list and the disk', await waitFor(`${FLOW}.querySelectorAll('.flow-item').length === 2`, 3000)
    && !saved().workflows.some((w) => w.name === 'Handout'));
  await closeFlow();

  area('damaged file');
  fs.writeFileSync(store, '{ not json');
  await openFlow();
  check('a damaged file is said, and the list starts empty', /couldn’t be read, so Vellum kept a copy/.test(await note()) && (await workflowRows()).length === 0, await note());
  check('the file is kept beside it as .bad', fs.readFileSync(`${store}.bad`, 'utf8') === '{ not json');
  await closeFlow();

  area('safety');
  const refused = await q(`JSON.stringify(__flow.refused)`);
  check('no Windows dialog was asked for', refused === '[]', refused);
  const errors = await q(`JSON.stringify(__vellum.errors?.slice(${errorsBefore}) ?? [])`);
  check('no errors', errors === '[]', errors);
}
