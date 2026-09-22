// Accessibility V1 in the real app, with two documents open: the document tabs are one Tab stop, named
// by their file, and arrows / Home / End switch between them; a menu opened from the keyboard gives focus
// back to its button on Esc and lets Tab move on; the command palette and dialogs take focus when they
// open and give it back when they close (to the document when what had it is gone); a dialog keeps Tab
// inside itself and Esc still closes it; a hidden sidebar leaves the Tab order; and Vellum's own Reduce
// motion setting counts as reduced motion for the animations run from script.

export const files = { first: 'multipage', second: 'multipage' };

export async function run(t) {
  const { c, q, check, sleep, waitFor, settled, area } = t;
  const A = t.file('first');
  const B = t.file('second');
  await waitFor(settled(A), 25000);
  await waitFor(settled(B), 25000);
  const errorsBefore = await q(`__vellum.errors?.length ?? 0`);
  const active = () => q(`__vellum.app.active?.file.path`);
  const focused = (sel) => q(`document.activeElement?.matches(${JSON.stringify(sel)}) ?? false`);

  area('document tabs');
  const stops = await q(`[...document.querySelectorAll('.tabs .tab')].map((t) => [t.tabIndex, t.getAttribute('aria-selected')])`);
  check('only the active tab is a Tab stop', stops.filter(([i]) => i === 0).length === 1 && stops.every(([i, s]) => (i === 0) === (s === 'true')), JSON.stringify(stops));
  const named = await q(`(() => { const t = document.querySelector('.tabs .tab.active'); return document.getElementById(t.getAttribute('aria-labelledby'))?.textContent === __vellum.app.active.file.name; })()`);
  check('a tab is named by its file name (not its Close button)', named);
  await q(`document.querySelector('.tabs .tab.active').focus()`);
  const start = await active();
  await c.key('ArrowLeft');
  await sleep(150);
  check('ArrowLeft switches to the other document', (await active()) !== start);
  check('focus follows to the newly active tab', await focused('.tabs .tab.active'));
  await c.key('End');
  await sleep(150);
  check('End goes to the last tab', (await active()) === (await q(`__vellum.app.views.at(-1).file.path`)) && await focused('.tabs .tab.active'));
  await c.key('Home');
  await sleep(150);
  check('Home goes to the first tab', (await active()) === (await q(`__vellum.app.views[0].file.path`)) && await focused('.tabs .tab.active'));

  // A tab clicked with the mouse leaves focus, and the arrows, with the document, as before.
  await q(`__vellum.app.active.focus()`);
  const [tx, ty] = await q(`(() => { const r = document.querySelector('.tabs .tab.active').getBoundingClientRect(); return [r.left + 24, r.top + r.height / 2]; })()`);
  await c.mouse(tx, ty);
  await q(`__vellum.app.active.goToPage(1)`);
  await sleep(200);
  const before = await active();
  await c.key('ArrowRight');
  await sleep(250);
  check('after a mouse click on a tab, ArrowRight still turns the page', (await q(`__vellum.app.active.state.pageNumber`)) === 2 && (await active()) === before, await q(`__vellum.app.active.state.pageNumber`));

  area('menus');
  // A raw key-down over DevTools types no character, so Enter can't press a button here: click() is
  // the same activation Enter or Space would give the focused button.
  const openMore = async () => {
    await q(`__vellum.ui.toolbar.menuBtn.focus(); __vellum.ui.toolbar.menuBtn.click()`);
    return waitFor(`document.activeElement?.closest('.menu') != null`, 2000);
  };
  const page = () => q(`__vellum.app.active.state.pageNumber`);
  await q(`__vellum.app.active.goToPage(2)`);
  await sleep(200);
  check('More opens its menu with focus inside', await openMore());
  await c.key('ArrowDown');
  check('arrows move through the items', await focused('.menu-item'));
  await c.key('End');
  check('End goes to the last item, not to the last page', await q(`(() => { const items = [...document.querySelectorAll('.menu .menu-item:not(:disabled)')]; return document.activeElement === items.at(-1); })()`) && (await page()) === 2, await page());
  await c.key('Home');
  check('Home goes to the first item, not to the first page', await q(`document.activeElement === document.querySelector('.menu .menu-item:not(:disabled)')`) && (await page()) === 2, await page());
  await c.key('Escape');
  await sleep(100);
  check('Esc closes the menu and focus returns to More', !(await q(`document.querySelector('.menu') != null`)) && await q(`document.activeElement === __vellum.ui.toolbar.menuBtn`));
  await openMore();
  await c.key('Tab');
  await sleep(100);
  check('Tab closes the menu and moves on from More, not to the page body',
    !(await q(`document.querySelector('.menu') != null`)) && await q(`document.activeElement !== document.body && document.activeElement !== __vellum.ui.toolbar.menuBtn`),
    await q(`document.activeElement?.outerHTML.slice(0, 120)`));

  area('command palette');
  await q(`__vellum.app.active.focus()`);
  await c.key('Ctrl+K');
  check('the palette takes focus in its search field', await waitFor(`document.activeElement?.classList.contains('palette-input')`, 2000));
  await c.key('Escape');
  await sleep(250);
  check('Esc closes it and focus returns to the document', await q(`!document.querySelector('.palette-backdrop') && document.activeElement === __vellum.app.active.container`));

  area('dialogs');
  await c.key('Ctrl+K');
  await waitFor(`document.activeElement?.classList.contains('palette-input')`, 2000);
  await c.type('About Vellum');
  await sleep(150);
  await c.key('Enter');
  check('a dialog opened from the palette takes focus', await waitFor(`document.activeElement?.closest('[role="dialog"].dialog') != null`, 3000));
  const trapped = [];
  for (let i = 0; i < 6; i++) {
    await c.key('Tab');
    trapped.push(await q(`document.activeElement?.closest('[role="dialog"].dialog') != null`));
  }
  check('Tab stays inside the open dialog', trapped.every(Boolean), JSON.stringify(trapped));
  await c.key('Escape');
  await sleep(300);
  check('Esc still closes it and focus returns to the document', await q(`!document.querySelector('.dialog-backdrop') && document.activeElement === __vellum.app.active.container`));
  // Opened from something that then disappears (a menu item, a closed tab): focus goes to the document.
  const fallback = await q(`(async () => {
    const { showDialog } = await import('./js/ui/dialogs.js');
    const b = document.createElement('button'); document.body.append(b); b.focus();
    const done = showDialog({ title: 'Test', message: 'x' });
    b.remove();
    await new Promise((r) => setTimeout(r, 50));
    const inside = document.activeElement?.closest('.dialog') != null;
    document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await done;
    return { inside, back: document.activeElement === __vellum.app.active.container };
  })()`);
  check('the dialog takes focus, and a vanished opener hands focus to the document', fallback.inside && fallback.back, JSON.stringify(fallback));

  area('sidebar');
  await q(`__vellum.ui.sidebar.toggle(false)`);
  await sleep(100);
  check('a hidden sidebar is inert (out of the Tab order)', await q(`document.getElementById('sidebar').inert === true`));
  await q(`__vellum.ui.sidebar.toggle(true)`);
  await sleep(100);
  check('a shown sidebar is not inert', await q(`document.getElementById('sidebar').inert === false`));

  area('reduced motion');
  const motion = await q(`(async () => {
    const { reducedMotion } = await import('./js/dom.js');
    const root = document.documentElement, was = root.dataset.motion;
    root.dataset.motion = 'reduced';
    const on = reducedMotion();
    if (was === undefined) delete root.dataset.motion; else root.dataset.motion = was;
    return on;
  })()`);
  check('Settings → Reduce motion counts as reduced motion for scripted animation', motion === true);

  check('no script errors', (await q(`__vellum.errors?.length ?? 0`)) === errorsBefore, JSON.stringify(await q(`__vellum.errors`)));
}
