// Tools' Recent and Favorites, and Home's quick tools (docs/TOOLS_UX_SPEC.md §8, §10), in the real app:
// a tool run from Tools, Home or the palette goes to Recent, newest first; a star keeps a tool in Favorites
// without running it; both survive closing Tools and reloading the page; Home's row holds only tools that
// need no document, recently run ones first, then the defaults, each once, four at most, then All tools;
// and stored data that names a tool no longer there, or that can't be read, changes nothing else.
// It checks routing, not workflows (they have their own suites): every command a case runs is a spy, and
// every request that would open a Windows dialog is refused for the whole suite.

export const files = { doc: 'multipage' };
export const timeoutMs = 90000;

// Every bridge request that shows a Windows dialog (MainWindow*.cs).
const NATIVE = ['openDialog', 'pictureDialog', 'attachDialog', 'collections.addDialog', 'saveAsDialog', 'splitTargets', 'export.folder', 'html.toPdf', 'office.toPdf', 'history.move'];
const DEFAULTS = ['merge-pdfs', 'images-to-pdf', 'compare-documents', 'html-to-pdf'];
// The commands the cases run, spied on: the four Home tools and two that need a document.
const SPIED = ['pages.merge', 'pages.imagesToPdf', 'tools.compare', 'pages.htmlToPdf', 'tools.compress', 'pages.rotateRight', 'file.open'];
const COLOURS = JSON.stringify({ highlight: '#1e88e5', underline: '#e53935', note: '#fbc02d', ink: '#43a047', inkWidth: 3 });

export async function run(t) {
  const { c, q, check, sleep, waitFor, settled, area } = t;
  const DOC = t.file('doc');
  await waitFor(settled(DOC), 30000);

  // Refuses native dialogs and puts spies in place of the commands the cases run. Again after a reload.
  const prepare = () => q(`(async () => {
    const { bridge } = await import(new URL('js/bridge.js', location.href).href);
    const refused = new Set(${JSON.stringify(NATIVE)});
    const request = bridge.request;
    window.__homeNative = [];
    bridge.request = function (type, payload) {
      if (!refused.has(type)) return request.call(this, type, payload);
      __homeNative.push(type);
      return Promise.reject(new Error('this suite never opens a Windows dialog'));
    };
    window.__homeCalls = [];
    for (const id of ${JSON.stringify(SPIED)}) __vellum.commands[id].run = () => { __homeCalls.push(id); };
    return true;
  })()`);
  await prepare();
  await q(`localStorage.removeItem('vellum.catalog'); localStorage.setItem('vellum.tools', ${JSON.stringify(COLOURS)}); true`);
  const errorsBefore = await q(`__vellum.errors.length`);

  const calls = () => q(`window.__homeCalls.slice()`);
  const clearCalls = () => q(`window.__homeCalls.length = 0`);
  const stored = () => q(`(() => { try { return JSON.parse(localStorage.getItem('vellum.catalog')); } catch { return 'unreadable'; } })()`);
  const recent = async () => ((await stored())?.recent ?? []).map((e) => e.id);
  const recentIs = (ids) => waitFor(`JSON.stringify((JSON.parse(localStorage.getItem('vellum.catalog') ?? 'null')?.recent ?? []).map((e) => e.id).slice(0, ${ids.length})) === ${JSON.stringify(JSON.stringify(ids))}`, 3000);

  const OPEN = `(document.querySelector('.tools-backdrop:not(.closing)') !== null)`;
  const opened = () => waitFor(`${OPEN} && document.activeElement?.matches('.tools-input')`, 5000);
  const closed = () => waitFor(`!${OPEN}`, 5000);
  const openTools = async (options = {}) => (await q(`__vellum.ui.tools.open(${JSON.stringify(options)})`)) === true && opened();
  const closeTools = async () => { await q(`document.querySelector('.tools-input').value = ''`); await c.key('Escape'); return closed(); };
  const row = (tool) => `.tools-row[data-tool="${tool}"]`;
  const landing = () => q(`(() => {
    const panel = document.querySelector('.tools-panel');
    const blocks = [...panel.querySelectorAll('.tools-block')].map((b) => ({
      label: b.querySelector('.tools-label')?.textContent ?? null, chips: [...b.querySelectorAll('.tools-chip')].map((el) => el.dataset.tool) }))
      .filter((b) => b.label === 'Favorites' || b.label === 'Recent');
    return { blocks, tabs: [...document.querySelectorAll('.tools-tab')].map((el) => el.dataset.view), text: panel.textContent };
  })()`);
  /** Runs a tool from its row in Tools (its category's view); the sheet closes, then the command runs. */
  const runFromTools = async (tool, category) => {
    await openTools({ category });
    await q(`document.querySelector('${row(tool)} .tools-run').click()`);
    return closed();
  };

  // Enter as a keyboard types it (with its "\r"), which is what activates a focused button; c.key sends
  // the key alone, which only keydown handlers see.
  const pressEnter = async () => {
    const base = { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 };
    await c.send('Input.dispatchKeyEvent', { type: 'keyDown', text: '\r', unmodifiedText: '\r', ...base });
    await c.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
  };

  const homeRow = () => q(`[...document.querySelectorAll('.home-tools .home-tool')].map((el) => el.dataset.tool)`);
  const homeRowIs = (ids) => waitFor(`JSON.stringify([...document.querySelectorAll('.home-tools .home-tool')].map((el) => el.dataset.tool)) === ${JSON.stringify(JSON.stringify(ids))}`, 5000);

  area('recent from Tools');
  await clearCalls();
  check('a tool run from Tools runs its command', await runFromTools('compress-pdf', 'optimize') && await waitFor(`__homeCalls.includes('tools.compress')`, 2000), JSON.stringify(await calls()));
  check('…and goes to Recent', await recentIs(['compress-pdf']), JSON.stringify(await stored()));
  await runFromTools('rotate-pages', 'organize');
  check('another run goes in front of it', await recentIs(['rotate-pages', 'compress-pdf']), JSON.stringify(await stored()));
  await runFromTools('compress-pdf', 'optimize');
  check('running one again moves it to the front, once', JSON.stringify(await recent()) === JSON.stringify(['compress-pdf', 'rotate-pages']), JSON.stringify(await recent()));
  await openTools();
  let view = await landing();
  check('the landing lists them under Recent, newest first; the rail gains Recent, but no Favorites',
    JSON.stringify(view.blocks) === JSON.stringify([{ label: 'Recent', chips: ['compress-pdf', 'rotate-pages'] }])
    && view.tabs.includes('recent') && !view.tabs.includes('favorites'), JSON.stringify(view));
  await closeTools();

  area('favorites');
  await clearCalls();
  await openTools({ category: 'organize' });
  await q(`document.querySelector('${row('merge-pdfs')} .tools-star').focus()`);
  await pressEnter();
  await sleep(150);
  const starred = await q(`(() => { const s = document.querySelector('${row('merge-pdfs')} .tools-star'); return {
    pressed: s.getAttribute('aria-pressed'), focused: document.activeElement === s, open: ${OPEN},
    tabs: [...document.querySelectorAll('.tools-tab')].map((el) => el.dataset.view) }; })()`);
  check('a star, from the keyboard, stars the tool: pressed, focus stays on it, Favorites joins the rail',
    starred.pressed === 'true' && starred.focused && starred.tabs.includes('favorites'), JSON.stringify(starred));
  check('…and neither runs the tool nor closes Tools', starred.open && (await calls()).length === 0, JSON.stringify(await calls()));
  check('the star is kept', JSON.stringify((await stored())?.favorites) === JSON.stringify(['merge-pdfs']), JSON.stringify(await stored()));
  await pressEnter();
  await sleep(150);
  const unstarred = await q(`(() => { const s = document.querySelector('${row('merge-pdfs')} .tools-star'); return {
    pressed: s.getAttribute('aria-pressed'), focused: document.activeElement === s, tabs: [...document.querySelectorAll('.tools-tab')].map((el) => el.dataset.view) }; })()`);
  check('pressed again, it is unstarred, and Favorites leaves the rail', unstarred.pressed === 'false' && unstarred.focused
    && !unstarred.tabs.includes('favorites') && JSON.stringify((await stored())?.favorites) === '[]', JSON.stringify(unstarred));
  await q(`document.querySelector('${row('merge-pdfs')} .tools-star').click()`);
  await q(`document.querySelector('${row('rotate-pages')} .tools-star').click()`);
  await closeTools();
  await openTools();
  view = await landing();
  check('after closing and opening again: Favorites first (in the order starred), then Recent without them',
    JSON.stringify(view.blocks) === JSON.stringify([{ label: 'Favorites', chips: ['merge-pdfs', 'rotate-pages'] }, { label: 'Recent', chips: ['compress-pdf'] }])
    && view.tabs.includes('favorites') && view.tabs.includes('recent'), JSON.stringify(view));
  check('the landing has 6 chips at most', view.blocks.reduce((n, b) => n + b.chips.length, 0) <= 6);
  check('no tool ran while starring', (await calls()).length === 0, JSON.stringify(await calls()));
  await closeTools();

  area('Home quick tools');
  await q(`__vellum.app.activate(null); true`);
  check('Home shows the row under the Open card, with the defaults: Recent holds only tools that need a document',
    await homeRowIs(DEFAULTS), JSON.stringify(await homeRow()));
  const home = await q(`(() => {
    const row = document.querySelector('.home-tools');
    const all = row.querySelector('.home-all-tools');
    return { under: row.parentElement === document.querySelector('.open-card').parentElement
        && Boolean(document.querySelector('.open-card').compareDocumentPosition(row) & Node.DOCUMENT_POSITION_FOLLOWING),
      shown: row.offsetParent !== null, all: all?.textContent, last: row.lastElementChild === all,
      names: [...row.querySelectorAll('.home-tool')].map((el) => el.textContent), group: row.getAttribute('role') + ' ' + row.getAttribute('aria-label') };
  })()`);
  check('the row: the tools by name, then All tools with its shortcut, a group named Quick tools',
    home.under && home.shown && home.last && home.all === 'All toolsCtrl+Shift+A' && home.group === 'group Quick tools'
    && JSON.stringify(home.names) === JSON.stringify(['Merge PDFs', 'Images to PDF', 'Compare documents', 'HTML to PDF']), JSON.stringify(home));
  await t.shot('home-row');
  await clearCalls();
  await q(`document.querySelector('.home-tool[data-tool="html-to-pdf"]').focus()`);
  await pressEnter();
  check('a Home tool runs its command', await waitFor(`__homeCalls.includes('pages.htmlToPdf')`, 2000), JSON.stringify(await calls()));
  check('…and goes to Recent', await recentIs(['html-to-pdf', 'compress-pdf']), JSON.stringify(await stored()));
  check('the row puts it first, keeps each tool once and holds four', await homeRowIs(['html-to-pdf', 'merge-pdfs', 'images-to-pdf', 'compare-documents']), JSON.stringify(await homeRow()));
  check('focus stays on the tool that ran', await q(`document.activeElement?.dataset?.tool === 'html-to-pdf'`));
  await q(`document.querySelector('.home-all-tools').click()`);
  check('All tools opens Tools', await opened());
  await closeTools();

  area('recent from the palette');
  await clearCalls();
  await q(`__vellum.ui.palette.open('Images to PDF'); true`);
  const listed = await waitFor(`document.querySelector('.palette-item .pi-text')?.textContent === 'Images to PDF…'`, 5000);
  if (listed) await c.key('Enter');
  check('the palette runs the tool’s command as before', listed && await waitFor(`__homeCalls.includes('pages.imagesToPdf')`, 2000), JSON.stringify(await calls()));
  check('…and the tool goes to Recent', await recentIs(['images-to-pdf', 'html-to-pdf']), JSON.stringify(await stored()));
  check('Home’s row follows', await homeRowIs(['images-to-pdf', 'html-to-pdf', 'merge-pdfs', 'compare-documents']), JSON.stringify(await homeRow()));
  await q(`__vellum.ui.palette.open('Open'); true`);
  const openListed = await waitFor(`document.querySelector('.palette-item .pi-text')?.textContent === 'Open…'`, 5000);
  const before = JSON.stringify(await stored());
  if (openListed) await c.key('Enter');
  const ranOpen = await waitFor(`__homeCalls.includes('file.open')`, 2000);
  await sleep(200);
  check('a palette command that is no tool’s (Open…) runs, and changes nothing in Recent', openListed && ranOpen
    && JSON.stringify(await stored()) === before, JSON.stringify(await stored()));
  check('no Windows dialog was asked for', JSON.stringify(await q(`__homeNative`)) === '[]', JSON.stringify(await q(`__homeNative`)));
  check('no page errors', (await q(`__vellum.errors.length`)) === errorsBefore, JSON.stringify(await q(`__vellum.errors.slice(${errorsBefore})`)));

  area('after a reload');
  await q(`window.__beforeReload = true; setTimeout(() => location.reload(), 50); true`);
  const reloaded = await waitFor(`!window.__beforeReload && Boolean(window.__vellum?.app && __vellum.ui?.start && __vellum.commands)`, 20000);
  check('the page reloads', reloaded);
  if (!reloaded) return;
  await prepare();
  check('Home’s row is as it was', await homeRowIs(['images-to-pdf', 'html-to-pdf', 'merge-pdfs', 'compare-documents']), JSON.stringify(await homeRow()));
  await openTools();
  view = await landing();
  // No document now: the chips are the tools that can run without one.
  check('Favorites and Recent are as they were', JSON.stringify(view.blocks) === JSON.stringify([{ label: 'Favorites', chips: ['merge-pdfs'] },
    { label: 'Recent', chips: ['images-to-pdf', 'html-to-pdf'] }]), JSON.stringify(view.blocks));
  check('…the stored lists too', JSON.stringify(await recent()) === JSON.stringify(['images-to-pdf', 'html-to-pdf', 'compress-pdf', 'rotate-pages'])
    && JSON.stringify((await stored())?.favorites) === JSON.stringify(['merge-pdfs', 'rotate-pages']), JSON.stringify(await stored()));
  await closeTools();
  check('the annotation colours (vellum.tools) are untouched', (await q(`localStorage.getItem('vellum.tools')`)) === COLOURS);
  const kept = await stored();
  check('vellum.catalog holds tool ids and times only, no file name', kept?.v === 1 && Object.keys(kept).sort().join() === 'favorites,recent,v'
    && kept.recent.every((e) => Object.keys(e).sort().join() === 'id,t') && !JSON.stringify(kept).includes('.pdf'), JSON.stringify(kept));

  area('stored data that can’t all be used');
  const errorsAfterReload = await q(`__vellum.errors.length`);
  await q(`localStorage.setItem('vellum.catalog', JSON.stringify({ v: 1, recent: [{ id: 'gone-tool', t: 9 }, { id: 'compare-documents', t: 8 }, { id: 'compare-documents', t: 7 }], favorites: ['gone-tool', 'html-to-pdf'] })); __vellum.ui.start.renderTools(); true`);
  check('a tool that no longer exists is left out of Home, and repeats count once', await homeRowIs(['compare-documents', 'merge-pdfs', 'images-to-pdf', 'html-to-pdf']), JSON.stringify(await homeRow()));
  await openTools();
  view = await landing();
  check('…and out of Tools', JSON.stringify(view.blocks) === JSON.stringify([{ label: 'Favorites', chips: ['html-to-pdf'] }, { label: 'Recent', chips: ['compare-documents'] }])
    && !view.text.includes('gone-tool'), JSON.stringify(view.blocks));
  await closeTools();
  await q(`localStorage.setItem('vellum.catalog', '{not json'); __vellum.ui.start.renderTools(); true`);
  check('unreadable data: Home shows the defaults', await homeRowIs(DEFAULTS), JSON.stringify(await homeRow()));
  check('…and Tools opens with no Favorites or Recent', await openTools() && (await landing()).blocks.length === 0);
  await closeTools();
  await clearCalls();
  await q(`document.querySelector('.home-tool[data-tool="merge-pdfs"]').click()`);
  check('a run then keeps working, and writes readable data again', await waitFor(`__homeCalls.includes('pages.merge')`, 2000) && await recentIs(['merge-pdfs']), JSON.stringify(await stored()));
  check('no page errors', (await q(`__vellum.errors.length`)) === errorsAfterReload, JSON.stringify(await q(`__vellum.errors.slice(${errorsAfterReload})`)));
  check('no Windows dialog was asked for', JSON.stringify(await q(`__homeNative`)) === '[]', JSON.stringify(await q(`__homeNative`)));
}
