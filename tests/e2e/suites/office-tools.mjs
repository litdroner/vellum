// Word, Excel and PowerPoint to PDF as tools, in the real app (office/actions.js): each is listed in Tools and
// the palette only where office.providers says a provider can convert its format; run from Tools or the
// palette it asks the host for that format; while the host converts, a dialog says so and Cancel reaches the
// host; the outcome is said (a PDF with Open, a quiet cancel, the host's reason in a dialog); a second start
// while one runs does nothing; and Home, Recent and Favorites follow presence like any other tool.
// The host is stubbed on the page: office.providers, office.toPdf, office.cancel and the office-converting
// event are the test's, so no Windows dialog opens and no Office application starts (every other request that
// would open a dialog is refused). The real host's office.providers is office-providers.mjs; real conversions
// are tests/host (VELLUM_OFFICE_SMOKE=1).

export const files = {};
export const timeoutMs = 90000;

// Every bridge request that shows a Windows dialog (MainWindow*.cs), office.toPdf among them.
const NATIVE = ['openDialog', 'pictureDialog', 'attachDialog', 'collections.addDialog', 'saveAsDialog', 'splitTargets', 'export.folder', 'html.toPdf', 'office.toPdf', 'history.move'];
const OFFICE = ['word-to-pdf', 'excel-to-pdf', 'powerpoint-to-pdf'];
const CANCELLED = 'The conversion was cancelled; nothing was saved.';
const BUSY = 'PowerPoint is open. Close it and try again: Vellum converts presentations in a PowerPoint of its own, never in one you are using.';

export async function run(t) {
  const { c, q, check, sleep, waitFor, area } = t;
  await waitFor(`Boolean(window.__vellum?.actions?.office && __vellum.ui?.start && __vellum.commands)`, 20000);
  const errorsBefore = await q(`__vellum.errors?.length ?? 0`);

  await q(`(async () => {
    const { bridge } = await import(new URL('js/bridge.js', location.href).href);
    const native = new Set(${JSON.stringify(NATIVE)});
    const request = bridge.request;
    const on = bridge.on;
    const s = window.__office = { calls: [], cancels: 0, refused: [], report: null, pending: null, listeners: new Set() };
    s.finish = (reply) => { const p = s.pending; s.pending = null; p?.(reply); };
    s.emit = (e) => { for (const fn of [...s.listeners]) fn(e); };
    bridge.request = function (type, payload) {
      if (type === 'office.providers') return Promise.resolve(s.report);
      if (type === 'office.cancel') { s.cancels++; setTimeout(() => s.finish({ result: { status: 'cancelled', message: ${JSON.stringify(CANCELLED)} } }), 50); return Promise.resolve({}); }
      if (type === 'office.toPdf') { s.calls.push(payload); return new Promise((resolve) => { s.pending = resolve; }); }
      if (native.has(type)) { s.refused.push(type); return Promise.reject(new Error('this suite never opens a Windows dialog')); }
      return request.call(this, type, payload);
    };
    bridge.on = function (event, fn) {
      if (event !== 'office-converting') return on.call(this, event, fn);
      s.listeners.add(fn);
      return () => s.listeners.delete(fn);
    };
    localStorage.removeItem('vellum.catalog');
    return true;
  })()`);

  /** office.providers answers: one status per format, as the host spells them. */
  const provide = (word, excel, powerpoint) => q(`(async () => {
    __office.report = { providers: [], formats: [['word', '${word}'], ['excel', '${excel}'], ['powerpoint', '${powerpoint}']].map(([format, status]) => ({ format, status })) };
    await __vellum.actions.office.probe(true);
    return true;
  })()`);
  const OPEN = `(document.querySelector('.tools-backdrop:not(.closing)') !== null)`;
  const openTools = async (options) => (await q(`__vellum.ui.tools.open(${JSON.stringify(options)})`)) === true && waitFor(`${OPEN} && document.activeElement?.matches('.tools-input')`, 5000);
  const closeTools = async () => { await q(`document.querySelector('.tools-input').value = ''`); await c.key('Escape'); return waitFor(`!${OPEN}`, 5000); };
  const rows = () => q(`[...document.querySelectorAll('.tools-row')].map((el) => el.dataset.tool).filter((id) => ${JSON.stringify(OFFICE)}.includes(id))`);
  const offRows = () => q(`[...document.querySelectorAll('.tools-row[data-off]')].map((el) => el.dataset.tool)`);
  const paletteLabels = async (text) => {
    await q(`__vellum.ui.palette.open(${JSON.stringify(text)})`);
    await waitFor(`document.querySelectorAll('.palette-item').length > 0 || Boolean(document.querySelector('.palette-empty'))`, 5000);
    const labels = await q(`[...document.querySelectorAll('.palette-item .pi-text')].map((el) => el.textContent)`);
    await c.key('Escape');
    await waitFor(`!document.querySelector('.palette-backdrop.open')`, 5000);
    return labels;
  };
  const running = `document.querySelector('.office-dialog')`;
  const dialogText = () => q(`document.querySelector('.dialog-backdrop:last-child .dialog')?.textContent ?? ''`);
  const toasts = () => q(`[...document.querySelectorAll('#toasts .toast')].map((el) => el.textContent).join(' | ')`);
  const recent = () => q(`(JSON.parse(localStorage.getItem('vellum.catalog') ?? 'null')?.recent ?? []).map((e) => e.id)`);
  const homeRow = async () => {
    await q(`__vellum.ui.start.renderTools()`);
    await sleep(300);
    return q(`[...document.querySelectorAll('.home-tools .home-tool')].map((el) => el.dataset.tool)`);
  };

  area('presence');
  await provide('noProvider', 'noProvider', 'noProvider');
  await openTools({ category: 'convert' });
  check('no provider: none of the three is in Convert, HTML to PDF still is',
    (await rows()).length === 0 && await q(`Boolean(document.querySelector('.tools-row[data-tool="html-to-pdf"]'))`), JSON.stringify(await rows()));
  await closeTools();
  check('…nor in the palette', !(await paletteLabels('Word to PDF')).some((l) => /Word to PDF/.test(l)));
  check('…nor on Home, where nothing was run yet', !(await homeRow()).some((id) => OFFICE.includes(id)));

  await provide('ready', 'ready', 'notSupported');
  await openTools({ category: 'convert' });
  check('Office without PowerPoint: Word and Excel to PDF are in Convert, ready with no document open',
    JSON.stringify(await rows()) === JSON.stringify(OFFICE.slice(0, 2)) && !(await offRows()).some((id) => OFFICE.includes(id)), JSON.stringify(await rows()));
  await closeTools();
  await openTools({ query: 'office' });
  await waitFor(`document.querySelectorAll('.tools-option[data-tool]').length > 0`, 5000);
  const found = await q(`[...new Set([...document.querySelectorAll('.tools-option[data-tool]')].map((el) => el.dataset.tool))]`);
  check('searching Tools for “office” finds the two that are there, and nothing else', JSON.stringify(found.sort()) === JSON.stringify(OFFICE.slice(0, 2).sort()), JSON.stringify(found));
  await closeTools();
  const labels = await paletteLabels('Word to PDF');
  check('the palette finds Word to PDF… first', labels[0] === 'Word to PDF…', JSON.stringify(labels));

  area('a conversion, cancelled');
  await openTools({ category: 'convert' });
  await q(`document.querySelector('.tools-row[data-tool="word-to-pdf"] .tools-run').click()`);
  await waitFor(`!${OPEN}`, 5000);
  check('Word to PDF from Tools asks the host for a Word document', await waitFor(`__office.calls.length === 1 && __office.calls[0].format === 'word'`, 5000), JSON.stringify(await q(`__office.calls`)));
  check('nothing is shown while the host has its own dialogs open', !(await q(`Boolean(${running})`)));
  await q(`__office.emit({ name: 'report.docx', providerName: 'Microsoft Office' })`);
  const shown = await waitFor(`Boolean(${running}) && document.activeElement?.closest('.office-dialog') !== null`, 5000);
  const text = await dialogText();
  check('once converting: a dialog names the document and the application, with focus on Cancel',
    shown && text.includes('report.docx') && text.includes('Microsoft Office') && await q(`document.activeElement?.textContent === 'Cancel'`), text);
  await q(`__vellum.commands['office.wordToPdf'].run(); __vellum.commands['office.excelToPdf'].run(); true`);
  await sleep(300);
  check('a second start while it runs does nothing', await q(`__office.calls.length === 1`), JSON.stringify(await q(`__office.calls`)));
  check('…and Tools doesn’t open over it', (await q(`__vellum.ui.tools.open({})`)) === false);
  await q(`document.activeElement.click()`);
  check('Cancel reaches the host', await waitFor(`__office.cancels === 1`, 5000));
  check('…the dialog goes, and the cancel is said quietly', await waitFor(`!${running}`, 5000) && await waitFor(`document.getElementById('toasts')?.textContent.includes(${JSON.stringify(CANCELLED)})`, 5000), await toasts());
  check('Word to PDF is in Recent', (await recent())[0] === 'word-to-pdf', JSON.stringify(await recent()));

  area('a conversion that succeeds');
  await q(`__vellum.ui.palette.open('Excel to PDF')`);
  await waitFor(`document.querySelector('.palette-item .pi-text')?.textContent === 'Excel to PDF…'`, 5000);
  await c.key('Enter');
  check('Excel to PDF from the palette asks for an Excel workbook', await waitFor(`__office.calls.length === 2 && __office.calls[1].format === 'excel'`, 5000), JSON.stringify(await q(`__office.calls`)));
  await q(`__office.emit({ name: 'budget.xlsx', providerName: 'Microsoft Office' })`);
  await waitFor(`Boolean(${running})`, 5000);
  await q(`__office.finish({ result: { status: 'converted', message: 'Converted with Microsoft Office.' }, file: { name: 'budget.pdf', path: 'C:\\\\nowhere\\\\budget.pdf' } })`);
  check('the dialog goes and the PDF is announced, with Open',
    await waitFor(`!${running}`, 5000) && await waitFor(`[...document.querySelectorAll('#toasts .toast.success')].some((el) => el.textContent.includes('Made “budget.pdf” from “budget.xlsx”') && el.querySelector('.toast-action')?.textContent === 'Open')`, 5000), await toasts());
  check('Excel to PDF is in Recent, newest first', JSON.stringify((await recent()).slice(0, 2)) === '["excel-to-pdf","word-to-pdf"]', JSON.stringify(await recent()));

  area('refused before any dialog');
  await provide('ready', 'ready', 'unavailable');
  await openTools({ category: 'convert' });
  check('PowerPoint open: PowerPoint to PDF is still listed', (await rows()).includes('powerpoint-to-pdf'), JSON.stringify(await rows()));
  await q(`document.querySelector('.tools-row[data-tool="powerpoint-to-pdf"] .tools-run').click()`);
  await waitFor(`!${OPEN}`, 5000);
  await waitFor(`__office.calls.length === 3`, 5000);
  await q(`__office.finish({ result: { status: 'unavailable', message: ${JSON.stringify(BUSY)} } })`);
  await waitFor(`Boolean(document.querySelector('.dialog-backdrop .dialog'))`, 5000);
  const refusal = await dialogText();
  check('…run, it says why, under a title that fits, with no running dialog', refusal.includes('Can’t convert right now') && refusal.includes(BUSY) && !(await q(`Boolean(${running})`)), refusal);
  await c.key('Escape');
  await waitFor(`!document.querySelector('.dialog-backdrop .dialog')`, 5000);

  // What the PC has changed since presence was read: the host says no provider, and presence is read again.
  await q(`__office.report = { providers: [], formats: ['word', 'excel', 'powerpoint'].map((format) => ({ format, status: 'noProvider' })) }; true`);
  await q(`__vellum.commands['office.wordToPdf'].run(); true`);
  await waitFor(`__office.calls.length === 4`, 5000);
  await q(`__office.finish({ result: { status: 'noProvider', message: 'Converting a Word document to PDF needs Microsoft Office or LibreOffice on this PC, and neither was found.' } })`);
  await waitFor(`Boolean(document.querySelector('.dialog-backdrop .dialog'))`, 5000);
  check('no provider any more: said, and the tools go', (await dialogText()).includes('neither was found')
    && await waitFor(`Object.keys(__vellum.actions.office.presence()).length === 0`, 5000));
  await c.key('Escape');
  await waitFor(`!document.querySelector('.dialog-backdrop .dialog')`, 5000);

  area('Home, Recent and Favorites');
  check('with no provider, Home leaves recently run Office tools out', !(await homeRow()).some((id) => OFFICE.includes(id)), JSON.stringify(await homeRow()));
  await provide('ready', 'ready', 'ready');
  const home = await homeRow();
  check('with one, they come first on Home, as recently run tools do', JSON.stringify(home.slice(0, 3)) === '["powerpoint-to-pdf","excel-to-pdf","word-to-pdf"]', JSON.stringify(home));
  await openTools({ category: 'convert' });
  await q(`document.querySelector('.tools-row[data-tool="word-to-pdf"] .tools-star').click()`);
  await closeTools();
  await openTools({});
  const chips = (label) => q(`[...document.querySelectorAll('.tools-block')].filter((b) => b.querySelector('.tools-label')?.textContent === ${JSON.stringify(label)}).flatMap((b) => [...b.querySelectorAll('.tools-chip')].map((el) => el.dataset.tool))`);
  check('a star puts Word to PDF in Favorites', (await chips('Favorites')).includes('word-to-pdf'), JSON.stringify(await chips('Favorites')));
  await closeTools();
  await provide('noProvider', 'noProvider', 'noProvider');
  await openTools({});
  check('…and with no provider neither Favorites nor Recent shows an Office tool',
    ![...(await chips('Favorites')), ...(await chips('Recent'))].some((id) => OFFICE.includes(id)), JSON.stringify([await chips('Favorites'), await chips('Recent')]));
  await closeTools();

  check('no Windows dialog was asked for', (await q(`__office.refused.length`)) === 0, JSON.stringify(await q(`__office.refused`)));
  const errors = await q(`JSON.stringify(__vellum.errors?.slice(${errorsBefore}) ?? [])`);
  check('no errors', errors === '[]', errors);
}
