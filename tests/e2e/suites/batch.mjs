// Batch processing in the real app (batch/, operations/registry.js, ui/batch.js): Automate lists the two batch
// tools, the Office one only where office.providers says a format converts; the dialog takes files, says what
// will be skipped and why, and lets one be removed; Compress many PDFs writes a real smaller copy of each PDF
// beside it through the host (export.targets, /export/{token}) and leaves the PDFs byte for byte unchanged;
// names already on disk are asked about once, and Keep both numbers them; Office files in bulk go one at a time
// through batch.office, Stop cancels the running one and starts nothing new, closing Vellum while a batch runs
// asks first, and a partial result says so and offers Try again for the files that can run again.
// The Windows dialogs are the test's: batch.choose answers with the suite's files (the two PDFs it opened, with
// their real addresses, and made-up Office paths), and office.providers, batch.office and office.cancel are
// stubbed, so no Windows dialog opens and no Office application starts. Real conversions are tests/host.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const files = { first: 'structure', second: 'multipage' };
export const timeoutMs = 150000;

// Every bridge request that shows a Windows dialog (MainWindow*.cs), batch.choose and batch.office among them.
const NATIVE = ['openDialog', 'pictureDialog', 'attachDialog', 'collections.addDialog', 'saveAsDialog', 'splitTargets', 'export.folder', 'html.toPdf', 'office.toPdf', 'history.move'];
const CANCELLED = 'The conversion was cancelled; nothing was saved.';

export async function run(t) {
  const { q, check, shot, settled, waitFor, area } = t;
  const FIRST = t.file('first');
  const SECOND = t.file('second');
  const folder = path.dirname(FIRST);
  const J = (v) => JSON.stringify(v);
  const hash = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  const originals = [hash(FIRST), hash(SECOND)];

  await waitFor(settled(FIRST), 25000);
  await waitFor(settled(SECOND), 25000);
  await waitFor(`Boolean(window.__vellum?.actions?.batch && __vellum.ui?.tools)`, 10000);
  const errorsBefore = await q(`__vellum.errors?.length ?? 0`);

  await q(`(async () => {
    const { bridge } = await import(new URL('js/bridge.js', location.href).href);
    const native = new Set(${J(NATIVE)});
    const request = bridge.request;
    const s = window.__batch = { choose: [], chose: [], office: [], replies: [], cancels: 0, refused: [], report: null, pending: null };
    s.finish = (reply) => { const p = s.pending; s.pending = null; p?.(reply); };
    bridge.request = function (type, payload) {
      if (type === 'batch.choose') { s.chose.push(payload); return Promise.resolve(s.choose.shift() ?? { files: [], left: 0, more: 0, folder: null }); }
      if (type === 'office.providers') return Promise.resolve(s.report);
      if (type === 'office.cancel') { s.cancels++; setTimeout(() => s.finish({ status: 'cancelled', message: ${J(CANCELLED)} }), 50); return Promise.resolve({}); }
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

  /** office.providers answers: one status per format, as the host spells them. */
  const provide = (word, excel, powerpoint) => q(`(async () => {
    __batch.report = { providers: [], formats: [['word', '${word}'], ['excel', '${excel}'], ['powerpoint', '${powerpoint}']].map(([format, status]) => ({ format, status })) };
    await __vellum.actions.office.probe(true);
    return true;
  })()`);
  /** What batch.choose gives back for one open document: the file as the host describes a chosen one. */
  const opened = (file) => `(() => { const f = __vellum.app.views.find((v) => v.file.path.toLowerCase() === ${J(file.toLowerCase())}).file;
    return { token: f.token ?? 'doc', path: f.path, name: f.path.split('\\\\').pop(), size: 1, url: f.url }; })()`;
  const fake = (name) => ({ token: `fake-${name}`, path: path.join(folder, name), name, size: 1, url: 'about:blank' });

  const DIALOG = `document.querySelector('.batch-dialog')`;
  const OPEN = `Boolean(${DIALOG}) && !${DIALOG}.closest('.dialog-backdrop').inert`;
  const button = (label, scope = '.batch-dialog') => `[...document.querySelectorAll('${scope} .dialog-actions .btn')].find((b) => b.textContent.startsWith(${J(label)}))`;
  const click = (expr) => q(`(() => { const el = ${expr}; if (!el || el.disabled) return false; el.click(); return true; })()`);
  const title = () => q(`${DIALOG}?.querySelector('.dialog-title')?.textContent ?? null`);
  const rows = () => q(`[...document.querySelectorAll('.batch-dialog .batch-item')].map((el) => ({
    name: el.querySelector('.batch-name').textContent, status: el.dataset.status, detail: el.querySelector('.batch-detail').textContent,
    shows: Boolean(el.querySelector('.batch-act button')) }))`);
  const note = () => q(`${DIALOG}?.querySelector('.dialog-note')?.textContent ?? ''`);
  const closed = () => waitFor(`!document.querySelector('.batch-dialog')`, 3000);
  const TOOLS_OPEN = `(document.querySelector('.tools-backdrop:not(.closing)') !== null)`;
  const automateRows = async () => {
    await q(`__vellum.ui.tools.open({ category: 'automate' })`);
    await waitFor(TOOLS_OPEN, 5000);
    const ids = await q(`[...document.querySelectorAll('.tools-row')].map((el) => el.dataset.tool)`);
    return ids;
  };

  area('Automate');
  await provide('noProvider', 'noProvider', 'noProvider');
  let ids = await automateRows();
  check('Automate lists Compress many PDFs, and no Office batch without Office', J(ids) === J(['batch-compress', 'workflows']), J(ids));
  await q(`document.querySelector('.tools-input').value = ''`);
  await t.c.key('Escape');
  await waitFor(`!${TOOLS_OPEN}`, 5000);
  await provide('ready', 'ready', 'noProvider');
  ids = await automateRows();
  check('with Word or Excel on this PC, both batch tools', J(ids) === J(['batch-compress', 'batch-office-to-pdf', 'workflows']), J(ids));
  await shot('batch-automate');

  area('setup');
  await click(`document.querySelector('.tools-row[data-tool="batch-compress"] .tools-run')`);
  check('the tool opens the batch dialog', await waitFor(OPEN, 5000));
  check('named for its operation', (await title()) === 'Compress PDFs', await title());
  check('empty, with Start off', await q(`!${DIALOG}.querySelector('.batch-empty').hidden && ${button('Start')}.disabled`));
  const levels = await q(`[...${DIALOG}.querySelectorAll('.batch-options input[type="radio"]')].map((i) => i.value).join(',')`);
  check('with Compress’s own levels and where the files go', levels === 'safe,smaller,beside,folder', levels);
  await q(`__batch.choose.push({ files: [${await q(opened(FIRST)).then(J)}, ${await q(opened(SECOND)).then(J)}, ${J(fake('notes.txt'))}, ${await q(opened(FIRST)).then(J)}], left: 0, more: 0, folder: null })`);
  await click(`[...${DIALOG}.querySelectorAll('.batch-add .btn')].find((b) => b.textContent === 'Add files…')`);
  await waitFor(`${DIALOG}.querySelectorAll('.batch-item').length === 3`, 5000);
  check('Add files asks the host for PDFs', await q(`__batch.chose.at(-1)?.accept === 'pdf' && __batch.chose.at(-1)?.folder === false`), await q(`JSON.stringify(__batch.chose)`));
  let list = await rows();
  check('each file once, in order', J(list.map((r) => r.name)) === J(['first.pdf', 'second.pdf', 'notes.txt']), J(list));
  check('each PDF with the name its copy will have', list[0].detail === '→ first (compressed).pdf' && list[1].detail === '→ second (compressed).pdf', J(list));
  check('the other file skipped, saying why', list[2].status === 'skipped' && list[2].detail === 'Not a PDF.', J(list[2]));
  const said = await note();
  check('the note says what happens, and what was left out', said.includes('already in the list') && said.includes('2 PDFs will each become a new file next to each one') && said.includes('1 file will be skipped'), said);
  await shot('batch-setup');
  await click(`${DIALOG}.querySelectorAll('.batch-item .batch-btn')[2]`);
  list = await rows();
  check('a file can be removed', J(list.map((r) => r.name)) === J(['first.pdf', 'second.pdf']), J(list));

  area('compressing');
  await click(button('Start'));
  check('it runs to the end', await waitFor(`${DIALOG}?.querySelector('.dialog-title')?.textContent === 'Done'`, 60000), await title());
  list = await rows();
  check('each PDF done, with its new file and the sizes', list.every((r) => r.status === 'succeeded' && r.shows && /\(compressed\)\.pdf/.test(r.detail)), J(list));
  check('the summary counts them', /2 new files made\./.test(await q(`${DIALOG}.querySelector('.dialog-message').textContent`)));
  check('nothing to try again', !(await q(`Boolean(${button('Try again')})`)));
  await shot('batch-compressed');
  const outputs = ['first (compressed).pdf', 'second (compressed).pdf'].map((n) => path.join(folder, n));
  check('the copies are on disk, as PDFs', outputs.every((f) => fs.existsSync(f) && fs.readFileSync(f).subarray(0, 5).toString('latin1') === '%PDF-'));
  check('the PDFs themselves are byte for byte unchanged', hash(FIRST) === originals[0] && hash(SECOND) === originals[1]);
  await click(button('Close'));
  check('Close closes it', await closed());

  area('names already there');
  await q(`(__vellum.commands['batch.compress'].run(), true)`);
  await waitFor(OPEN, 5000);
  await q(`__batch.choose.push({ files: [${await q(opened(FIRST)).then(J)}, ${await q(opened(SECOND)).then(J)}], left: 0, more: 0, folder: null })`);
  await click(`[...${DIALOG}.querySelectorAll('.batch-add .btn')].find((b) => b.textContent === 'Add files…')`);
  await waitFor(`${DIALOG}.querySelectorAll('.batch-item').length === 2`, 5000);
  await click(button('Start'));
  const QUESTION = `[...document.querySelectorAll('.dialog')].find((d) => d.querySelector('.dialog-title')?.textContent === '2 of those files already exist')`;
  check('names already on disk are asked about once, for the batch', await waitFor(`Boolean(${QUESTION})`, 5000));
  await click(`[...(${QUESTION}).querySelectorAll('.btn')].find((b) => b.textContent === 'Keep both')`);
  check('Keep both runs it', await waitFor(`${DIALOG}?.querySelector('.dialog-title')?.textContent === 'Done'`, 60000), await title());
  const numbered = ['first (compressed) (2).pdf', 'second (compressed) (2).pdf'].map((n) => path.join(folder, n));
  check('and numbers the new files, keeping the old ones', numbered.every((f) => fs.existsSync(f)) && outputs.every((f) => fs.existsSync(f)));
  await click(button('Close'));
  await closed();

  area('Office files, stopped');
  await q(`(__vellum.commands['batch.officeToPdf'].run(), true)`);
  check('Convert many Office files opens', await waitFor(`${OPEN} && ${DIALOG}.querySelector('.dialog-title').textContent === 'Convert Office files to PDF'`, 5000));
  await q(`__batch.choose.push({ files: ${J(['a.docx', 'b.xlsx', 'c.pptx', 'd.docx'].map(fake))}, left: 2, more: 0, folder: ${J(folder)} })`);
  await click(`[...${DIALOG}.querySelectorAll('.batch-add .btn')].find((b) => b.textContent === 'Add folder…')`);
  await waitFor(`${DIALOG}.querySelectorAll('.batch-item').length === 4`, 5000);
  check('Add folder asks the host for Office files', await q(`__batch.chose.at(-1)?.accept === 'office' && __batch.chose.at(-1)?.folder === true`));
  list = await rows();
  check('the presentation is skipped: nothing here converts it', list[2].status === 'skipped' && /PowerPoint presentation/.test(list[2].detail), J(list[2]));
  check('the note says the folder’s other files were left out', (await note()).includes('2 other files in that folder were left out'), await note());
  await q(`__batch.replies.push({ status: 'converted', message: 'Converted with Microsoft Office.', provider: 'msoffice', providerName: 'Microsoft Office', output: { name: 'a.pdf', path: ${J(path.join(folder, 'a.pdf'))} } }, 'hold')`);
  await click(button('Start'));
  check('one at a time: the second waits on the host', await waitFor(`__batch.office.length === 2 && __batch.pending !== null`, 10000), await q(`__batch.office.length`));
  const sent = await q(`__batch.office.map((p) => [p.source, p.folder, p.name, p.overwrite])`);
  check('each by its token, into its own folder, under its planned name', J(sent) === J([['fake-a.docx', folder, 'a.pdf', 'keepBoth'], ['fake-b.xlsx', folder, 'b.pdf', 'keepBoth']]), J(sent));
  list = await rows();
  check('the first done, the second working, the last waiting', J(list.map((r) => r.status)) === J(['succeeded', 'running', 'skipped', 'waiting']), J(list.map((r) => r.status)));
  check('the done one says what converted it', /Converted with Microsoft Office/.test(list[0].detail), list[0].detail);
  check('Esc doesn’t close it while it works', await (async () => { await t.c.key('Escape'); return q(`Boolean(${DIALOG}) && document.activeElement?.textContent === 'Stop'`); })());
  await shot('batch-running');

  // Closing Vellum while a batch runs asks first; Keep running leaves it be.
  await q(`(__vellum.actions.batch.stopForQuit().then((ok) => { window.__quitAnswer = ok; }), true)`);
  const ASK = `[...document.querySelectorAll('.dialog')].find((d) => d.querySelector('.dialog-title')?.textContent === 'A batch is still running')`;
  check('closing Vellum asks first', await waitFor(`Boolean(${ASK})`, 3000));
  await click(`[...(${ASK}).querySelectorAll('.btn')].find((b) => b.textContent === 'Keep running')`);
  check('Keep running keeps Vellum open and the batch going', await waitFor(`window.__quitAnswer === false`, 3000) && await q(`__vellum.actions.batch.running && __batch.pending !== null`));
  check('and the question goes away', await waitFor(`!${ASK}`, 3000), await q(`[...document.querySelectorAll('#overlay-root > *')].map((el) => el.className + (el.inert ? ' [inert]' : '')).join(' | ')`));

  await click(button('Stop'));
  check('Stop reaches the host', await waitFor(`__batch.cancels === 1`, 3000));
  check('and the batch ends as stopped', await waitFor(`${DIALOG}?.querySelector('.dialog-title')?.textContent === 'Stopped'`, 10000), await title());
  list = await rows();
  check('the running one stopped, the waiting one never started', J(list.map((r) => r.status)) === J(['succeeded', 'cancelled', 'skipped', 'cancelled'])
    && list[1].detail === CANCELLED && /Not started/.test(list[3].detail), J(list));
  check('nothing more was sent to the host', await q(`__batch.office.length === 2`));
  check('Try again offers the two', await q(`Boolean(${button('Try again (2)')})`));
  check('and no batch is running', await q(`!__vellum.actions.batch.running`));

  area('Try again, partly');
  await q(`__batch.replies.push({ status: 'converted', message: 'Converted with Microsoft Office.', provider: 'msoffice', providerName: 'Microsoft Office', output: { name: 'b.pdf', path: ${J(path.join(folder, 'b.pdf'))} } },
    { status: 'failed', message: 'Word couldn’t open this document.', provider: 'msoffice', providerName: 'Microsoft Office', output: null })`);
  await click(button('Try again'));
  check('only the two run again', await waitFor(`${DIALOG}?.querySelector('.dialog-title')?.textContent === 'Done, with problems'`, 10000), await title());
  check('each once more', J(await q(`__batch.office.slice(2).map((p) => p.source)`)) === J(['fake-b.xlsx', 'fake-d.docx']));
  list = await rows();
  check('the result is partial, each row saying why', J(list.map((r) => r.status)) === J(['succeeded', 'succeeded', 'skipped', 'failed']) && list[3].detail === 'Word couldn’t open this document.', J(list));
  const message = await q(`${DIALOG}.querySelector('.dialog-message').textContent`);
  check('the summary says what didn’t work', /2 new files made\./.test(message) && /1 file couldn’t be finished\./.test(message) && /1 file skipped\./.test(message), message);
  check('Try again offers the failed one', await q(`Boolean(${button('Try again (1)')})`));
  await shot('batch-partial');
  await click(button('Close'));
  check('Close closes it', await closed());

  area('safety');
  const refused = await q(`JSON.stringify(__batch.refused)`);
  check('no Windows dialog was asked for', refused === '[]', refused);
  const errors = await q(`JSON.stringify(__vellum.errors?.slice(${errorsBefore}) ?? [])`);
  check('no errors', errors === '[]', errors);
}
