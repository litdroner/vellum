// Tools (ui/tools.js) in the real app: opening and closing it (Ctrl+Shift+A, the title-bar button, More →
// All tools…, the palette), searching and running, the keyboard model, a tool that can't run and the reason
// it gives, the no-document landing, never over another modal, the page's text selection kept for the tool,
// Reduce motion and Reduce transparency, dark contrast, a 560 × 400 window, and a recorded measurement of the
// sheet's cost (open, keystroke, and frame times with its blur on and off, over a large document).
// It checks routing, not workflows (they have their own suites): every command a case runs is a spy first,
// and every request that would open a Windows dialog is refused for the whole suite.

import fs from 'node:fs';
import path from 'node:path';

export const files = { doc: 'multipage', locked: 'encrypted-open', large: 'large' };
export const timeoutMs = 120000;

// Every bridge request that shows a Windows dialog (MainWindow*.cs).
const NATIVE = ['openDialog', 'pictureDialog', 'attachDialog', 'collections.addDialog', 'saveAsDialog', 'splitTargets', 'export.folder', 'html.toPdf', 'history.move'];
const CATEGORIES = ['edit', 'review', 'organize', 'convert', 'sign', 'protect', 'optimize', 'research'];
const PROTECTED = 'This PDF is protected (encrypted), so Vellum can’t rewrite it.';

export async function run(t) {
  const { c, q, check, sleep, waitFor, settled, V, area, shot } = t;
  const DOC = t.file('doc');
  const LOCKED = t.file('locked');
  const LARGE = t.file('large');
  for (const file of [DOC, LOCKED, LARGE]) await waitFor(settled(file), 30000);
  const errorsBefore = await q(`__vellum.errors?.length ?? 0`);

  await q(`(async () => {
    const { bridge } = await import(new URL('js/bridge.js', location.href).href);
    const refused = new Set(${JSON.stringify(NATIVE)});
    const request = bridge.request;
    window.__toolsNative = [];
    bridge.request = function (type, payload) {
      if (!refused.has(type)) return request.call(this, type, payload);
      __toolsNative.push(type);
      return Promise.reject(new Error('the tools suite never opens a Windows dialog'));
    };
    return true;
  })()`);

  // A spy stands in for each command a case runs; it notes what the app looked like when it was called.
  const spy = (ids) => q(`(() => {
    window.__toolsSpy = { calls: [], saved: window.__toolsSpy?.saved ?? {} };
    for (const id of ${JSON.stringify(ids)}) {
      const command = __vellum.commands[id];
      __toolsSpy.saved[id] ??= command.run;
      command.run = () => { __toolsSpy.calls.push({
        id,
        sheet: document.querySelector('.tools-backdrop:not(.closing)') !== null,
        inert: document.getElementById('app').inert,
        focusInSheet: Boolean(document.activeElement?.closest('.tools-sheet')),
        selection: getSelection().toString().trim(),
      }); };
    }
    return true;
  })()`);
  const unspy = () => q(`(() => {
    const s = window.__toolsSpy;
    if (!s) return [];
    for (const [id, run] of Object.entries(s.saved)) __vellum.commands[id].run = run;
    s.saved = {};
    return s.calls;
  })()`);
  const calls = () => q(`window.__toolsSpy?.calls ?? []`);

  const OPEN = `(document.querySelector('.tools-backdrop:not(.closing)') !== null)`;
  const isOpen = () => q(OPEN);
  const opened = () => waitFor(`${OPEN} && document.activeElement?.matches('.tools-input')`, 5000);
  const closed = () => waitFor(`!${OPEN}`, 5000);
  const openWith = async (options = {}) => (await q(`__vellum.ui.tools.open(${JSON.stringify(options)})`)) === true && opened();
  const focused = (selector) => q(`document.activeElement?.matches(${JSON.stringify(selector)}) ?? false`);
  const query = () => q(`document.querySelector('.tools-input')?.value ?? null`);
  const typeQuery = async (text) => { await c.type(text); await sleep(150); };
  const closeSheet = async () => {
    if (await query()) { await c.key('Escape'); await sleep(100); }
    await c.key('Escape');
    return closed();
  };
  const options = () => q(`[...document.querySelectorAll('.tools-list [role="option"]')].map((o) => ({
    name: o.querySelector('.tools-row-name').textContent, tool: o.dataset.tool ?? null, off: o.getAttribute('aria-disabled') === 'true', id: o.id }))`);
  const activeOption = () => q(`document.querySelector('.tools-input').getAttribute('aria-activedescendant')`);
  const showCategory = async (id) => { await q(`(() => { const tab = document.getElementById('tools-tab-${id}'); tab.focus(); tab.click(); })()`); await sleep(200); };
  const activate = async (file) => { await q(`__vellum.app.activate(${file ? V(file) : 'null'})`); await sleep(300); };
  const markFocus = () => q(`(() => { document.querySelectorAll('[data-tools-mark]').forEach((el) => el.removeAttribute('data-tools-mark')); document.activeElement?.setAttribute('data-tools-mark', ''); return document.activeElement?.tagName; })()`);
  const focusIsMarked = () => q(`document.activeElement?.hasAttribute('data-tools-mark') ?? false`);
  // Resolves once the frame after the current one has painted.
  const AFTER_PAINT = `new Promise((r) => requestAnimationFrame(() => { const ch = new MessageChannel(); ch.port1.onmessage = () => r(); ch.port2.postMessage(0); }))`;
  const recorded = {};
  // Screenshots for review, not assertions: taken once the sheet's opening (220 ms) and a category's rise are over.
  const snap = async (name) => { await sleep(300); return shot(name); };

  area('opening');
  await activate(DOC);
  recorded.firstOpen = await q(`(async () => {
    const t0 = performance.now();
    const ok = await __vellum.ui.tools.open();
    await ${AFTER_PAINT};
    return { ok, ms: Math.round(performance.now() - t0) };
  })()`);
  check('Tools opens, its code loading the first time it is asked for', recorded.firstOpen.ok && await opened(), JSON.stringify(recorded.firstOpen));
  const semantics = await q(`(() => {
    const sheet = document.querySelector('.tools-sheet');
    const input = document.querySelector('.tools-input');
    const rail = document.querySelector('.tools-rail');
    return {
      role: sheet.getAttribute('role'), modal: sheet.getAttribute('aria-modal'), ownKeys: sheet.hasAttribute('data-own-keys'),
      title: document.getElementById(sheet.getAttribute('aria-labelledby'))?.textContent, inert: document.getElementById('app').inert,
      input: [input.type, input.getAttribute('aria-label'), input.getAttribute('role'), input.getAttribute('aria-expanded')].join(' '),
      rail: [rail.getAttribute('role'), rail.getAttribute('aria-orientation')].join(' '), panel: document.querySelector('.tools-panel').getAttribute('role'),
    };
  })()`);
  check('it is a modal dialog named Tools: the app behind it inert, its shortcuts stopped', semantics.role === 'dialog' && semantics.modal === 'true'
    && semantics.ownKeys && semantics.title === 'Tools' && semantics.inert === true, JSON.stringify(semantics));
  check('search is a field labelled "Search tools" (a combobox, collapsed with no search); the rail a vertical tab list; the content its panel',
    semantics.input === 'search Search tools combobox false' && semantics.rail === 'tablist vertical' && semantics.panel === 'tabpanel', JSON.stringify(semantics));
  const landing = await q(`(() => {
    const panel = document.querySelector('.tools-panel');
    return { title: panel.querySelector('.tools-title')?.textContent, tiles: [...panel.querySelectorAll('.tools-tile:not(.tools-card)')].map((el) => el.dataset.category),
      tabs: [...document.querySelectorAll('.tools-tab')].map((el) => el.dataset.view), selected: document.querySelector('.tools-tab[aria-selected="true"]')?.dataset.view };
  })()`);
  check('with a document open, the landing is for it and shows the eight categories', landing.title === 'For “doc.pdf”'
    && JSON.stringify(landing.tiles) === JSON.stringify(CATEGORIES), JSON.stringify(landing));
  check('the rail: Home (selected), then the eight categories; no Favorites or Recent before there are any', landing.selected === 'home'
    && JSON.stringify(landing.tabs) === JSON.stringify(['home', ...CATEGORIES]), JSON.stringify(landing.tabs));
  await snap('light-landing-document');
  await c.key('Escape');
  check('Esc closes it', await closed());
  check('it is gone once its fade is over', await waitFor(`document.querySelector('.tools-backdrop') === null`, 1500));

  area('open and close');
  await q(`__vellum.app.active.focus()`);
  await markFocus();
  await c.key('Ctrl+Shift+A');
  check('Ctrl+Shift+A opens it, with focus in the search field', await opened());
  await c.key('Escape');
  check('Esc closes it', await closed());
  check('focus goes back to what had it', await focusIsMarked());
  check('the app is no longer inert', await q(`!document.getElementById('app').inert`));

  const button = await q(`(() => {
    const b = __vellum.ui.titlebar.toolsBtn;
    const r = b.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, label: b.getAttribute('aria-label'), keys: b.getAttribute('aria-keyshortcuts'),
      title: b.title, popup: b.getAttribute('aria-haspopup'), text: b.textContent.trim(), next: b.nextElementSibling === __vellum.ui.titlebar.paletteBtn };
  })()`);
  check('the title bar has a Tools button, left of the palette’s, with its shortcut', button.label === 'Tools' && button.text === 'Tools' && button.keys === 'Control+Shift+A'
    && /Ctrl\+Shift\+A/.test(button.title) && button.popup === 'dialog' && button.next, JSON.stringify(button));
  await c.mouse(button.x, button.y);
  check('the title-bar button opens it', await opened());
  await c.key('Ctrl+Shift+A');
  check('Ctrl+Shift+A closes it again', await closed());
  check('focus goes back to the title-bar button', await focused('.tools-btn'));

  await c.key('Ctrl+Shift+A');
  await opened();
  await typeQuery('rotate');
  await c.key('Escape');
  await sleep(150);
  check('Esc with a search clears the search and stays open', (await isOpen()) && (await query()) === '' && await focused('.tools-input'));
  const empty = await q(`(() => { const r = document.querySelector('.tools-content').getBoundingClientRect(); return [r.left + 8, r.top + 8]; })()`);
  await c.mouse(empty[0], empty[1]);
  await sleep(150);
  check('a click on empty space in the sheet keeps focus in the sheet', await q(`Boolean(document.activeElement?.closest('.tools-sheet'))`), await q(`document.activeElement?.className ?? ''`));
  await c.key('Escape');
  check('…so Esc still closes it', await closed());
  await c.key('Ctrl+Shift+A');
  await opened();
  const scrim = await q(`(() => { const r = document.querySelector('.tools-sheet').getBoundingClientRect(); return [Math.max(4, Math.round(r.left / 2)), Math.round((r.top + r.bottom) / 2)]; })()`);
  await c.mouse(scrim[0], scrim[1]);
  check('a click on the scrim closes it', await closed());

  area('entry points');
  check('the toolbar’s mode control is named "Modes" (Tools is the sheet)', (await q(`document.querySelector('#toolbar .tool-seg').getAttribute('aria-label')`)) === 'Modes');
  await q(`__vellum.ui.toolbar.menuBtn.focus(); __vellum.ui.toolbar.menuBtn.click()`);
  await waitFor(`document.activeElement?.closest('.menu') != null`, 3000);
  const firstItem = await q(`document.querySelector('.menu .menu-item .menu-label')?.textContent`);
  check('More starts with "All tools…"', firstItem === 'All tools…', firstItem);
  await q(`document.querySelector('.menu .menu-item').click()`);
  check('…which opens Tools', await opened());
  await c.key('Escape');
  await closed();
  check('closing it gives focus back to More', await q(`document.activeElement === __vellum.ui.toolbar.menuBtn`));

  await q(`__vellum.app.active.focus()`);
  await markFocus();
  await c.key('Ctrl+K');
  await waitFor(`document.activeElement?.matches('.palette-input')`, 3000);
  await c.key('Ctrl+Shift+A');
  check('Ctrl+Shift+A in the palette puts Tools in the palette’s place', await opened() && !(await q(`__vellum.ui.palette.isOpen`)));
  await c.key('Escape');
  await closed();
  check('closing it gives focus back to what had it before the palette', await focusIsMarked());
  await c.key('Ctrl+K');
  await waitFor(`document.activeElement?.matches('.palette-input')`, 3000);
  await c.type('All tools');
  await sleep(400);
  await c.key('Enter');
  check('the palette’s "All tools…" opens Tools', await opened() && !(await q(`__vellum.ui.palette.isOpen`)));
  await closeSheet();

  area('search and run');
  await spy(['pages.merge']);
  await c.key('Ctrl+Shift+A'); // straight after closing it: the one fading out goes at once
  await opened();
  check('opened again at once, there is one sheet (no id twice)', await q(`document.querySelectorAll('.tools-sheet').length === 1 && document.querySelectorAll('#tools-results').length === 1`));
  await typeQuery('combine');
  const combine = await options();
  check('"combine" finds Merge PDFs first', combine[0]?.tool === 'merge-pdfs' && !combine[0].off, JSON.stringify(combine.slice(0, 3)));
  const combobox = await q(`(() => { const i = document.querySelector('.tools-input'); const a = document.getElementById(i.getAttribute('aria-activedescendant'));
    return { expanded: i.getAttribute('aria-expanded'), active: a?.id, selected: a?.getAttribute('aria-selected'), list: document.getElementById(i.getAttribute('aria-controls'))?.getAttribute('role') }; })()`);
  check('while there are results, the field drives the list: expanded, the top result active', combobox.expanded === 'true' && combobox.active === combine[0]?.id
    && combobox.selected === 'true' && combobox.list === 'listbox', JSON.stringify(combobox));
  await sleep(400);
  const said = await q(`document.querySelector('.tools-sheet [role="status"]').textContent`);
  check('the number of matches is announced', /^\d+ tools? match(es)? “combine”$/.test(said), said);
  await snap('light-results');
  await c.key('Enter');
  check('Enter closes Tools', await closed());
  await waitFor(`(window.__toolsSpy?.calls.length ?? 0) > 0`, 3000);
  await sleep(300);
  const mergeCalls = await unspy();
  check('…then runs Merge PDFs once, with the app back and focus out of the sheet', mergeCalls.length === 1 && mergeCalls[0].id === 'pages.merge'
    && !mergeCalls[0].sheet && !mergeCalls[0].inert && !mergeCalls[0].focusInSheet, JSON.stringify(mergeCalls));

  await c.key('Ctrl+Shift+A');
  await opened();
  await typeQuery('zzqx');
  const none = await q(`({ text: document.querySelector('.tools-list .tools-empty')?.textContent,
    options: [...document.querySelectorAll('.tools-list [role="option"]')].map((o) => o.getAttribute('aria-label')) })`);
  check('a search that finds no tool says so, and offers only where else to look', none.text === 'No tools match “zzqx”.'
    && JSON.stringify(none.options) === JSON.stringify(['Find “zzqx” in this document', 'Search commands for “zzqx”']), JSON.stringify(none));
  await snap('light-results-none');
  await c.key('Enter');
  await closed();
  check('"Find" opens the find bar on that text', await waitFor(`__vellum.ui.findbar.isOpen && __vellum.ui.findbar.input.value === 'zzqx'`, 3000));
  await q(`__vellum.ui.findbar.close?.()`);
  await c.key('Ctrl+Shift+A');
  await opened();
  await typeQuery('zzqx');
  await c.key('ArrowDown');
  await c.key('Enter');
  await closed();
  check('"Search commands" opens the palette on that text', await waitFor(`__vellum.ui.palette.isOpen && document.querySelector('.palette-input')?.value === 'zzqx'`, 3000));
  await c.key('Escape');
  await waitFor(`!__vellum.ui.palette.isOpen`, 3000);

  area('keyboard');
  await c.key('Ctrl+Shift+A');
  await opened();
  await typeQuery('page');
  const pageResults = await options();
  await c.key('ArrowDown');
  const second = await activeOption();
  await c.key('ArrowUp');
  const first = await activeOption();
  await c.key('ArrowUp');
  const wrapped = await activeOption();
  check('↓ and ↑ move the active result (and wrap), focus staying in the field', pageResults.length > 2 && second === pageResults[1].id && first === pageResults[0].id
    && wrapped === pageResults.at(-1).id && await focused('.tools-input'), JSON.stringify([second, first, wrapped, pageResults.length]));
  await c.key('Escape');
  await sleep(100);
  await c.key('Tab');
  check('Tab goes from the search field to the rail’s selected tab', await focused('.tools-tab[aria-selected="true"]'));
  await c.key('Tab');
  check('…then into the content', await focused('.tools-panel [data-cell]'));
  await c.key('Shift+Tab');
  check('Shift+Tab goes back to the rail', await focused('.tools-tab[aria-selected="true"]'));
  const tabs = await q(`[...document.querySelectorAll('.tools-tab')].map((el) => el.dataset.view)`);
  const railState = () => q(`({ focus: document.activeElement?.dataset.view ?? null, selected: document.querySelector('.tools-tab[aria-selected="true"]')?.dataset.view,
    panel: document.querySelector('.tools-panel').getAttribute('aria-labelledby') })`);
  await c.key('ArrowDown');
  const down = await railState();
  check('↓ in the rail moves to the next tab and shows it', down.focus === tabs[1] && down.selected === tabs[1] && down.panel === `tools-tab-${tabs[1]}`, JSON.stringify({ tabs, down }));
  await c.key('End');
  const end = await railState();
  await c.key('Home');
  const home = await railState();
  check('End and Home go to the last and first tabs', end.selected === tabs.at(-1) && end.focus === tabs.at(-1) && home.selected === 'home' && home.focus === 'home', JSON.stringify({ end, home }));
  await showCategory('organize');
  await snap('light-category');
  await c.key('Tab');
  const row = (tool) => `.tools-row[data-tool="${tool}"]`;
  check('Tab from the rail goes to the first tool', await focused(`${row('organize-pages')} .tools-run`));
  await c.key('ArrowDown');
  check('↓ goes to the next tool', await focused(`${row('rotate-pages')} .tools-run`));
  await c.key('ArrowRight');
  const right = await focused(`${row('rotate-pages')} .tools-variant[aria-label="Rotate pages: Right"]`);
  await c.key('ArrowRight');
  await c.key('ArrowRight');
  check('→ goes along the tool’s buttons, its variants, to its star', right && await focused(`${row('rotate-pages')} .tools-star`));
  await c.key('ArrowLeft');
  check('← goes back', await focused(`${row('rotate-pages')} .tools-variant[aria-label="Rotate pages: Left"]`));
  const stops = await q(`[...document.querySelectorAll('.tools-panel [data-cell]')].filter((el) => el.tabIndex === 0).length`);
  check('the content is one Tab stop (roving focus)', stops === 1, stops);
  const rotate = await q(`(() => {
    const r = document.querySelector('${row('rotate-pages')}');
    const main = r.querySelector('.tools-run');
    const star = r.querySelector('.tools-star');
    return { list: r.closest('ul').getAttribute('role'), name: document.getElementById(main.getAttribute('aria-labelledby'))?.textContent,
      line: document.getElementById(main.getAttribute('aria-describedby'))?.textContent, star: [star.getAttribute('aria-label'), star.getAttribute('aria-pressed')].join(' / ') };
  })()`);
  check('a tool row: in a list, the tool named and described, its star a toggle named for it', rotate.list === 'list' && rotate.name === 'Rotate pages'
    && rotate.line === 'Turn pages a quarter turn, saved in the file' && rotate.star === 'Add Rotate pages to favorites / false', JSON.stringify(rotate));
  await c.key('m');
  check('a letter typed outside the field goes to the search', (await query()) === 'm' && await focused('.tools-input'));
  await closeSheet();

  area('selected pages');
  const picked = await q(`(() => {
    const thumbs = __vellum.ui.sidebar.thumbs;
    thumbs.list.querySelector('.thumb[data-page="2"]').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    thumbs.list.querySelector('.thumb[data-page="3"]').dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true }));
    return thumbs.selectedIds.length;
  })()`);
  check('pages 2 and 3 are selected in the thumbnails', picked === 2, picked);
  await c.key('Ctrl+Shift+A');
  await opened();
  await showCategory('organize');
  const scoped = await q(`['rotate-pages', 'delete-pages', 'organize-pages'].map((id) => document.querySelector('.tools-row[data-tool="' + id + '"] .tools-row-line').textContent)`);
  check('tools that act on selected pages say which; the others keep their description', scoped[0] === 'Pages 2–3 (selected)' && scoped[1] === 'Pages 2–3 (selected)'
    && scoped[2] === 'Reorder, rotate and delete in the page thumbnails', JSON.stringify(scoped));
  await closeSheet();
  check('the pages are still selected after Tools', (await q(`__vellum.ui.sidebar.thumbs.selectedIds.length`)) === 2);
  await q(`__vellum.ui.sidebar.thumbs.clearSelection()`);

  area('unavailable');
  await activate(LOCKED);
  await spy(['tools.compress']);
  check('Tools opens on a category', await openWith({ category: 'optimize' }));
  const compress = await q(`(() => {
    const r = document.querySelector('.tools-row[data-tool="compress-pdf"]');
    const main = r?.querySelector('.tools-run');
    const line = r?.querySelector('.tools-row-line');
    return r ? { disabled: main.getAttribute('aria-disabled'), native: main.disabled, off: r.hasAttribute('data-off'), line: line.textContent,
      described: main.getAttribute('aria-describedby').split(' ').includes(line.id), selected: document.querySelector('.tools-tab[aria-selected="true"]')?.dataset.view } : null;
  })()`);
  check('in a protected PDF, Compress PDF stays in its place: aria-disabled but focusable, the reason as its description', compress?.disabled === 'true' && !compress.native
    && compress.off && compress.line === PROTECTED && compress.described && compress.selected === 'optimize', JSON.stringify(compress));
  await snap('light-unavailable');
  await q(`document.querySelector('.tools-row[data-tool="compress-pdf"] .tools-run').click()`);
  await sleep(300);
  check('activating it runs nothing, and Tools stays open', (await calls()).length === 0 && await isOpen());
  await q(`document.querySelector('.tools-input').focus()`);
  await typeQuery('compress');
  const lockedResults = await options();
  check('found by search it can’t run either', lockedResults[0]?.tool === 'compress-pdf' && lockedResults[0].off, JSON.stringify(lockedResults.slice(0, 2)));
  await c.key('Enter');
  await sleep(300);
  check('Enter on it runs nothing, and Tools stays open', (await calls()).length === 0 && await isOpen());
  await unspy();
  await closeSheet();

  area('no document');
  await activate(null);
  await waitFor(`!__vellum.app.active`, 3000);
  await spy(['file.open']);
  await openWith();
  const start = await q(`(() => {
    const panel = document.querySelector('.tools-panel');
    return { title: panel.querySelector('.tools-title')?.textContent, cards: [...panel.querySelectorAll('.tools-card')].map((el) => el.dataset.tool),
      note: panel.querySelector('.tools-note')?.textContent, open: panel.querySelectorAll('.tools-open').length, tiles: panel.querySelectorAll('.tools-tile:not(.tools-card)').length };
  })()`);
  check('with no document, the landing starts with the tools that need none', start.title === 'Start without a document'
    && ['merge-pdfs', 'images-to-pdf', 'html-to-pdf', 'compare-documents'].every((id) => start.cards.includes(id)), JSON.stringify(start));
  check('…then the eight categories, noting most tools need a PDF, with one Open a PDF button', start.tiles === 8 && start.note === 'Most tools work on an open PDF' && start.open === 1, JSON.stringify(start));
  await snap('light-landing-no-document');
  await showCategory('organize');
  const waiting = await q(`(() => {
    const groups = [...document.querySelectorAll('.tools-panel .tools-waiting')];
    const g = groups[0];
    const heading = g?.querySelector('.tools-label');
    const runs = g ? [...g.querySelectorAll('.tools-run')] : [];
    return { groups: groups.length, heading: heading?.textContent, open: g?.querySelectorAll('.tools-open').length ?? 0, rows: runs.length,
      off: runs.every((b) => b.getAttribute('aria-disabled') === 'true'), described: runs.every((b) => b.getAttribute('aria-describedby').split(' ').includes(heading?.id)),
      reasons: runs.filter((b) => b.closest('.tools-row').querySelector('.tools-row-line').textContent === 'Open a PDF first.').length,
      ready: [...document.querySelectorAll('.tools-panel .tools-section:not(.tools-waiting) .tools-row')].map((r) => [r.dataset.tool, r.hasAttribute('data-off')]) };
  })()`);
  check('tools that need a document wait once, under "Open a PDF to use these", with one Open a PDF button', waiting.groups === 1 && waiting.heading === 'Open a PDF to use these'
    && waiting.open === 1 && waiting.rows > 0 && waiting.off && waiting.described && waiting.reasons === 0, JSON.stringify(waiting));
  check('…below the ones that work now (Merge PDFs)', waiting.ready.some(([id, off]) => id === 'merge-pdfs' && !off), JSON.stringify(waiting.ready));
  await snap('light-category-no-document');
  await q(`document.querySelector('.tools-panel .tools-waiting .tools-open').click()`);
  check('Open a PDF closes Tools…', await closed());
  check('…and runs Open…, focus out of the sheet even with no document to go back to', await waitFor(`window.__toolsSpy.calls.length === 1 && __toolsSpy.calls[0].id === 'file.open'
    && !__toolsSpy.calls[0].focusInSheet && !__toolsSpy.calls[0].inert`, 3000), JSON.stringify(await calls()));
  await unspy();

  area('never over another modal');
  await activate(DOC);
  await q(`import(new URL('js/ui/dialogs.js', location.href).href).then((m) => { m.showDialog({ title: 'A dialog', message: 'Tools doesn’t open over it.' }); return true; })`);
  await waitFor(`document.activeElement?.closest('.dialog') != null`, 3000);
  await c.key('Ctrl+Shift+A');
  await sleep(400);
  check('Ctrl+Shift+A does nothing while a dialog is open', await q(`document.querySelector('.tools-backdrop') === null`));
  check('…nor does asking for Tools from code', (await q(`__vellum.ui.tools.open()`)) === false && !(await isOpen()));
  await c.key('Escape');
  await waitFor(`document.querySelector('#overlay-root [aria-modal="true"]') === null`, 3000);
  await q(`__vellum.app.active.focus()`);
  const mode = await q(`__vellum.app.active.annotLayer.tool`);
  await c.key('Ctrl+Shift+A');
  check('once it has closed, Tools opens again', await opened());
  await q(`document.querySelector('.tools-tab[aria-selected="true"]').focus()`);
  await c.key('H');
  await sleep(150);
  check('a one-letter shortcut doesn’t reach the document behind Tools (the letter goes to the search)', (await q(`__vellum.app.active.annotLayer.tool`)) === mode && (await query()) === 'h');
  await c.key('Ctrl+K');
  await sleep(300);
  check('nor does Ctrl+K: the palette doesn’t open over Tools', !(await q(`__vellum.ui.palette.isOpen`)) && await isOpen());
  await closeSheet();

  area('text selection');
  await activate(DOC);
  await waitFor(`${V(DOC)}.container.querySelector('.textLayer span')`, 5000);
  const selected = await q(`(() => {
    const span = [...${V(DOC)}.container.querySelectorAll('.textLayer span')].find((s) => s.textContent.trim().length > 3);
    const range = document.createRange();
    range.selectNodeContents(span);
    getSelection().removeAllRanges();
    getSelection().addRange(range);
    return __vellum.app.active.getSelectedText();
  })()`);
  check('text is selected on the page', selected.length > 0, selected);
  await c.key('Ctrl+Shift+A');
  await opened();
  await c.key('Escape');
  await closed();
  check('closing Tools gives the page its selection back', (await q(`__vellum.app.active.getSelectedText()`)) === selected);
  await spy(['annot.highlight']);
  await c.key('Ctrl+Shift+A');
  await opened();
  await typeQuery('highlight');
  const highlight = await options();
  check('Highlight is found, ready to run', highlight[0]?.tool === 'highlight' && !highlight[0].off, JSON.stringify(highlight.slice(0, 2)));
  await c.key('Enter');
  await closed();
  await waitFor(`(window.__toolsSpy?.calls.length ?? 0) > 0`, 3000);
  const highlightCalls = await unspy();
  check('Highlight run from Tools is run with the text still selected', highlightCalls.length === 1 && highlightCalls[0].selection === selected, JSON.stringify(highlightCalls));
  await q(`getSelection().removeAllRanges()`);

  area('reduced motion');
  await q(`document.documentElement.dataset.motion = 'reduced'`);
  const motionOpened = await openWith();
  const motion = await q(`({ sheet: getComputedStyle(document.querySelector('.tools-sheet')).animationDuration,
    scrim: getComputedStyle(document.querySelector('.tools-backdrop'), '::before').animationDuration })`);
  check('with Reduce motion nothing animates, and it opens with focus in the search', motionOpened && motion.sheet === '0s' && motion.scrim === '0s', JSON.stringify(motion));
  await c.key('Escape');
  check('…and it closes and goes away on its fixed time (no waiting for a transition)', await closed() && await waitFor(`document.querySelector('.tools-backdrop') === null`, 1500));
  await q(`delete document.documentElement.dataset.motion`);

  area('reduced transparency');
  await openWith();
  const glassOn = await q(`getComputedStyle(document.querySelector('.tools-sheet')).backdropFilter`);
  await closeSheet();
  await q(`document.documentElement.dataset.glass = 'off'`);
  await openWith();
  const glass = await q(`(() => {
    const probe = document.createElement('div');
    probe.style.background = 'var(--surface)';
    document.body.append(probe);
    const surface = getComputedStyle(probe).backgroundColor;
    probe.remove();
    const cs = getComputedStyle(document.querySelector('.tools-sheet'));
    return { filter: cs.backdropFilter, background: cs.backgroundColor, surface };
  })()`);
  check('the sheet is blurred glass normally', /blur/.test(glassOn), glassOn);
  check('with Reduce transparency it has no blur and is the solid surface colour', glass.filter === 'none' && glass.background === glass.surface, JSON.stringify(glass));
  await snap('light-landing-document-reduced-transparency');
  await closeSheet();
  await q(`delete document.documentElement.dataset.glass`);

  area('dark');
  const appearance = await q(`localStorage.getItem('vellum.appearance')`);
  // The contrast of `selector`'s text over what is under it: the sheet (and `layers` in it) over the scrim,
  // over the app's background and over a white page (PDF pages stay white in dark mode); the worst decides.
  const contrast = (selector, layers = []) => q(`(() => {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 1;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const rgba = (css) => { ctx.clearRect(0, 0, 1, 1); ctx.fillStyle = '#000'; ctx.fillStyle = css; ctx.fillRect(0, 0, 1, 1); const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data; return [r, g, b, a / 255]; };
    const over = (top, under) => [0, 1, 2].map((i) => top[i] * top[3] + under[i] * (1 - top[3])).concat(1);
    const lum = (c) => { const [r, g, b] = c.slice(0, 3).map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
    const ratio = (a, b) => { const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05); };
    const token = (name) => { const p = document.createElement('div'); p.style.background = 'var(' + name + ')'; document.body.append(p); const v = getComputedStyle(p).backgroundColor; p.remove(); return rgba(v); };
    const text = document.querySelector(${JSON.stringify(selector)});
    if (!text) return null;
    const stack = [document.querySelector('.tools-sheet'), ...${JSON.stringify(layers)}.map((s) => text.closest(s))].map((el) => rgba(getComputedStyle(el).backgroundColor));
    const scrim = rgba(getComputedStyle(document.querySelector('.tools-backdrop'), '::before').backgroundColor);
    const [app, page] = [token('--bg'), [255, 255, 255, 1]].map((under) => Math.round(ratio(rgba(getComputedStyle(text).color), stack.reduce((bg, layer) => over(layer, bg), over(scrim, under))) * 100) / 100);
    return { app, page, worst: Math.min(app, page) };
  })()`);
  const contrasts = {};
  for (const theme of ['mist', 'graphite']) {
    await q(`__vellum.setAppearance({ theme: '${theme}', mode: 'dark', accent: null })`);
    await sleep(300);
    await openWith();
    const landingBlurb = await contrast('.tools-panel .tools-tile-blurb', ['.tools-tile']);
    if (theme === 'mist') await snap('dark-landing-document');
    await showCategory('organize');
    const rowLine = await contrast('.tools-panel .tools-row-line');
    const subtitle = await contrast('.tools-panel .tools-subtitle');
    if (theme === 'mist') {
      await snap('dark-category');
      await q(`document.querySelector('.tools-input').focus()`);
      await typeQuery('page');
      await snap('dark-results');
      await c.key('Escape');
      await typeQuery('zzqx');
      await snap('dark-results-none');
    }
    await closeSheet();
    if (theme === 'mist') {
      await q(`document.documentElement.dataset.glass = 'off'`);
      await openWith();
      const solid = await q(`(() => { const p = document.createElement('div'); p.style.background = 'var(--surface)'; document.body.append(p); const surface = getComputedStyle(p).backgroundColor; p.remove();
        const cs = getComputedStyle(document.querySelector('.tools-sheet')); return { filter: cs.backdropFilter, background: cs.backgroundColor, surface }; })()`);
      check('mist dark with Reduce transparency: no blur, the solid surface colour', solid.filter === 'none' && solid.background === solid.surface, JSON.stringify(solid));
      await closeSheet();
      await q(`delete document.documentElement.dataset.glass`);
    }
    contrasts[theme] = { rowLine, landingBlurb, subtitle };
    check(`${theme} dark: descriptions keep at least 4.5:1 contrast over the glass, over the app or a white page`, [rowLine, landingBlurb, subtitle].every((r) => r?.worst >= 4.5), JSON.stringify(contrasts[theme]));
  }
  await activate(null);
  await openWith();
  await snap('dark-landing-no-document');
  await closeSheet();
  await activate(DOC);
  await q(`__vellum.setAppearance(${appearance ?? `{ theme: 'mist', mode: 'light', accent: null }`})`); // themes.js DEFAULT when none was saved
  await sleep(300);

  area('forced colours');
  await c.send('Emulation.setEmulatedMedia', { features: [{ name: 'forced-colors', value: 'active' }] });
  await waitFor(`matchMedia('(forced-colors: active)').matches`, 3000);
  await openWith({ category: 'organize' });
  const forced = await q(`({ pill: getComputedStyle(document.querySelector('.tools-pill')).display,
    outline: getComputedStyle(document.querySelector('.tools-tab[aria-selected="true"]')).outlineStyle })`);
  check('in forced colours the selected tab is outlined, not only tinted', forced.pill === 'none' && forced.outline === 'solid', JSON.stringify(forced));
  await snap('forced-colours-category');
  await closeSheet();
  await c.send('Emulation.setEmulatedMedia', { features: [] });
  await waitFor(`!matchMedia('(forced-colors: active)').matches`, 3000);

  area('small window');
  await c.send('Emulation.setDeviceMetricsOverride', { width: 560, height: 400, deviceScaleFactor: 0, mobile: false });
  await waitFor(`innerWidth === 560 && innerHeight === 400`, 3000);
  check('the title-bar button is an icon only in a narrow window', await q(`getComputedStyle(document.querySelector('.tools-btn-label')).display === 'none'`));
  await openWith();
  const small = await q(`(() => {
    const r = document.querySelector('.tools-sheet').getBoundingClientRect();
    const tiles = document.querySelector('.tools-panel .tools-tiles');
    return { rect: [r.left, r.top, r.right, r.bottom].map(Math.round), rail: document.querySelector('.tools-rail').getAttribute('aria-orientation'),
      columns: tiles ? getComputedStyle(tiles).gridTemplateColumns.split(' ').length : 0 };
  })()`);
  check('at 560 × 400 the sheet fits the window, its rail becomes a row and the tiles one column', small.rect[0] >= 0 && small.rect[2] <= 560 && small.rect[3] <= 400
    && small.rail === 'horizontal' && small.columns === 1, JSON.stringify(small));
  await snap('small-560x400-landing');
  await showCategory('organize');
  await snap('small-560x400-category');
  await closeSheet();
  await c.send('Emulation.clearDeviceMetricsOverride');
  await waitFor(`innerWidth !== 560`, 3000);

  area('performance (recorded)');
  // Recorded, not judged here (docs/TOOLS_UX_ARCHITECTURE_REVIEW.md §12): a warm open to first paint,
  // keystroke to results painted, and frame intervals over opening, a category, typing and closing, with
  // the blur on and then off (Reduce transparency), on a large document still painting after a zoom.
  await activate(LARGE);
  recorded.warm = await q(`(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const opens = [];
    const keys = [];
    for (let i = 0; i < 3; i++) {
      const t0 = performance.now();
      await __vellum.ui.tools.open();
      await ${AFTER_PAINT};
      opens.push(Math.round(performance.now() - t0));
      const input = document.querySelector('.tools-input');
      for (const text of ['r', 'ro', 'rot', 'rotate', 'page', 'merge pdf', 'to word']) {
        input.value = text;
        const k0 = performance.now();
        input.dispatchEvent(new Event('input'));
        const k1 = performance.now();
        await ${AFTER_PAINT};
        keys.push([k1 - k0, performance.now() - k0]);
      }
      for (let n = 0; n < 2; n++) input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await wait(300);
    }
    const spread = (list) => { const s = list.sort((a, b) => a - b).map((v) => Math.round(v * 10) / 10); return { median: s[s.length >> 1], max: s.at(-1) }; };
    return { openMs: opens, keystrokeMs: { rendered: spread(keys.map(([r]) => r)), painted: spread(keys.map(([, p]) => p)) } };
  })()`);
  const frames = (glassOff) => q(`(async () => {
    const root = document.documentElement;
    if (${glassOff}) root.dataset.glass = 'off'; else delete root.dataset.glass;
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const view = __vellum.app.active;
    const samples = [];
    let last = 0;
    let running = true;
    const tick = (now) => { if (last) samples.push([now, now - last]); last = now; if (running) requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
    const long = [];
    const observer = PerformanceObserver.supportedEntryTypes?.includes('long-animation-frame')
      ? new PerformanceObserver((list) => { for (const e of list.getEntries()) if (e.duration > 50) long.push([e.startTime, Math.round(e.duration)]); }) : null;
    observer?.observe({ type: 'long-animation-frame' });
    view.zoomIn(); // the pages repaint under the sheet as it opens
    await wait(30);
    const marks = [['open', performance.now()]];
    await __vellum.ui.tools.open();
    await wait(450);
    marks.push(['category', performance.now()]);
    document.getElementById('tools-tab-organize').click();
    await wait(350);
    marks.push(['typing', performance.now()]);
    const input = document.querySelector('.tools-input');
    for (const ch of 'rotate') { input.value += ch; input.dispatchEvent(new Event('input')); await wait(70); }
    await wait(250);
    marks.push(['close', performance.now()]);
    for (let n = 0; n < 2; n++) input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await wait(400);
    marks.push(['end', performance.now()]);
    running = false;
    observer?.disconnect();
    view.zoomOut();
    delete root.dataset.glass;
    const stats = (list) => { const s = list.map(([, d]) => d).sort((a, b) => a - b); const at = (p) => Math.round(s[Math.min(s.length - 1, Math.floor(p * s.length))] * 10) / 10;
      return { n: s.length, p50: at(0.5), p95: at(0.95), max: Math.round((s.at(-1) ?? 0) * 10) / 10 }; };
    const phases = {};
    for (let i = 0; i < marks.length - 1; i++) phases[marks[i][0]] = stats(samples.filter(([at]) => at >= marks[i][1] && at < marks[i + 1][1]));
    const all = samples.map(([, d]) => d).sort((a, b) => a - b);
    return { refreshMs: Math.round(all[all.length >> 1] * 10) / 10, phases, longFramesOver50ms: observer ? long.map(([, d]) => d) : 'not supported' };
  })()`);
  recorded.blurOn = await frames(false);
  await sleep(500);
  recorded.blurOff = await frames(true);
  recorded.contrast = contrasts;
  recorded.viewport = await q(`({ width: innerWidth, height: innerHeight, dpr: devicePixelRatio })`);
  fs.writeFileSync(path.join(t.dir, 'tools-measurements.json'), JSON.stringify(recorded, null, 2));
  const summary = (r) => `open p95 ${r.phases.open?.p95} ms (max ${r.phases.open?.max}), category p95 ${r.phases.category?.p95}, typing p95 ${r.phases.typing?.p95}, close p95 ${r.phases.close?.p95}; long frames ${JSON.stringify(r.longFramesOver50ms)}`;
  check('first and warm opens, and keystrokes, measured', Number.isFinite(recorded.firstOpen.ms) && recorded.warm.openMs.length === 3,
    `first open ${recorded.firstOpen.ms} ms; warm ${recorded.warm.openMs.join(' / ')} ms; keystroke → results rendered median ${recorded.warm.keystrokeMs.rendered.median} ms (max ${recorded.warm.keystrokeMs.rendered.max}), painted median ${recorded.warm.keystrokeMs.painted.median} ms (max ${recorded.warm.keystrokeMs.painted.max})`);
  check('frame times with the blur on, measured', Boolean(recorded.blurOn.phases.open), `refresh ${recorded.blurOn.refreshMs} ms; ${summary(recorded.blurOn)}`);
  check('frame times with the blur off (Reduce transparency), measured', Boolean(recorded.blurOff.phases.open), `refresh ${recorded.blurOff.refreshMs} ms; ${summary(recorded.blurOff)}`);

  area('clean run');
  check('no Windows dialog was asked for', (await q(`__toolsNative.length`)) === 0, await q(`__toolsNative.join(', ')`));
  const errors = await q(`(__vellum.errors ?? []).slice(${errorsBefore})`);
  check('no page errors', errors.length === 0, errors.join(' | '));
}
