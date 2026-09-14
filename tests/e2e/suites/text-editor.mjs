// The Edit text tool in the real app, driven with keys, mouse and typing: open, type, keep, cancel,
// Tab order, refusals, undo/redo, zoom, Ctrl+S, a substitute font, locked text, a scanned page, a
// protected PDF, themes and a narrow window. (The 0.4 Phase 3 checks, moved into the repository.)

export const files = { 'ui-simple': 'simple', 'ui-fonts': 'fonts', 'ui-constructs': 'constructs', 'ui-scanned': 'scanned', 'ui-encrypted': 'encrypted-open' };

export async function run(t) {
  const { c, q, check, sleep, shot } = t;
  const DOCS = ['ui-simple', 'ui-fonts', 'ui-constructs', 'ui-scanned', 'ui-encrypted'].map(t.file);
  const [SIMPLE, FONTS, CONSTRUCTS, SCANNED, ENCRYPTED] = DOCS;

  const waitFor = async (expr, ms = 20000) => t.waitFor(expr, ms);
  const V = t.V;
  const settled = t.settled;
  const activate = async (path) => {
    await q(`__vellum.app.activate(${V(path)})`);
    await waitFor(settled(path));
    await sleep(400);
  };
  const editorOpen = `Boolean(document.querySelector('.vl-text-editor'))`;
  const editorGone = `!document.querySelector('.vl-text-editor')`;
  const status = () => q(`(() => { const s = document.querySelector('.vl-edit-status'); return s ? { text: s.textContent, tone: s.className } : null; })()`);
  const lineAt = (path, page, y) => q(`(async () => {
    const t = await (await ${V(path)}.pdf.getPage(${page})).getTextContent();
    return t.items.filter((i) => i.str.trim() && Math.round(i.transform[5]) === ${y}).map((i) => i.str).join('');
  })()`);
  /** Screen centre of a run (by its current text) and whether it's editable. */
  const runAt = (path, page, text) => q(`(async () => {
    const v = ${V(path)};
    const p = await v.textEditing.page(${page});
    const item = p.runs.find((r) => r.text === ${JSON.stringify(text)});
    if (!item) return null;
    const pv = v.viewer.getPageView(${page} - 1);
    const vp = pv.viewport;
    const box = pv.div.getBoundingClientRect();
    const quad = item.run.quad;
    let x = 0;
    let y = 0;
    for (let i = 0; i < 8; i += 2) {
      const [vx, vy] = vp.convertToViewportPoint(quad[i], quad[i + 1]);
      x += box.left + (vx * box.width) / vp.width;
      y += box.top + (vy * box.height) / vp.height;
    }
    return { x: x / 4, y: y / 4, key: item.run.key, editable: item.run.editable };
  })()`);
  /** State for diagnosing a click that didn't open the editor. */
  const clickState = (path, x, y) => q(`(() => {
    const v = ${V(path)};
    const el = document.elementFromPoint(${x}, ${y});
    return { editor: Boolean(document.querySelector('.vl-text-editor')), tool: v?.annotLayer.tool, rebuilding: v?.rebuilding, status: v?.status,
      active: __vellum.app.active === v, under: el ? el.tagName + '.' + String(el.className?.baseVal ?? el.className).slice(0, 50) : null,
      outlines: document.querySelectorAll('.vl-decor polygon.vl-edit-run').length, errors: __vellum.errors.slice(-3) };
  })()`);
  /**
   * Scrolls a run to the middle of the view when it isn't plainly clickable where it is, as a person
   * would before clicking it. How far a document is scrolled once several have opened isn't
   * deterministic, and a line near the top of a page can land under the tool bar, where a click at
   * its centre lands on the tool bar instead.
   */
  const revealRun = async (path, page, text) => {
    const moved = await q(`(async () => {
      const v = ${V(path)};
      const p = await v.textEditing.page(${page});
      const item = p.runs.find((r) => r.text === ${JSON.stringify(text)});
      if (!item) return false;
      const pv = v.viewer.getPageView(${page} - 1);
      const vp = pv.viewport;
      const box = pv.div.getBoundingClientRect();
      const view = v.container.getBoundingClientRect();
      let x = 0; let y = 0;
      for (let i = 0; i < 8; i += 2) {
        const [vx, vy] = vp.convertToViewportPoint(item.run.quad[i], item.run.quad[i + 1]);
        x += box.left + (vx * box.width) / vp.width;
        y += box.top + (vy * box.height) / vp.height;
      }
      x /= 4; y /= 4;
      const under = document.elementFromPoint(x, y);
      if (y > view.top + 60 && y < view.bottom - 110 && pv.div.contains(under)) return false;
      v.container.scrollTop += (y - view.top) - view.height / 2;
      return true;
    })()`);
    if (moved) await sleep(500);
  };
  let retries = 0;
  /** Clicks a run; for editable text, waits for the editor (one retry, reported, with the state if it didn't open). */
  const clickRun = async (path, page, text, { expectEditor = true } = {}) => {
    await revealRun(path, page, text);
    const at = await runAt(path, page, text);
    if (!at) {
      console.log(`  (no run reads ${JSON.stringify(text)})`);
      return null;
    }
    await c.mouse(at.x, at.y);
    if (!expectEditor || (await waitFor(editorOpen, 4000))) return at;
    retries++;
    const state = await clickState(path, at.x, at.y);
    await shot(`retry-${retries}`);
    console.log(`  RETRY  editor didn't open for ${JSON.stringify(text)}: ${JSON.stringify(state)}`);
    await c.mouse(at.x, at.y);
    await waitFor(editorOpen, 4000);
    return at;
  };
  const replaceText = async (text) => {
    const ok = await q(`(() => { const i = document.querySelector('.vl-text-input'); if (i) i.select(); return Boolean(i); })()`);
    if (!ok) {
      console.log(`  (no editor to type ${JSON.stringify(text)} into)`);
      return false;
    }
    await c.type(text);
    await sleep(250); // the live check runs 120 ms after typing stops
    return true;
  };

  // Remember the appearance, to put it back exactly afterwards.
  const original = await q(`({ appearance: localStorage.getItem('vellum.appearance'), seeds: localStorage.getItem('vellum.appearance.seeds'), motion: localStorage.getItem('vellum.motion'), glass: localStorage.getItem('vellum.glass'), tone: localStorage.getItem('vellum.pageTone') })`);
  await waitFor(DOCS.map((p) => `Boolean(${V(p)})`).join(' && '), 30000);
  for (const p of DOCS.slice(0, 4)) await waitFor(settled(p), 30000);

  // ---- A. simple document: the whole flow -----------------------------------------------------
  await activate(SIMPLE);
  await c.key('E');
  check('E turns on Edit text', await waitFor(`${V(SIMPLE)}.annotLayer.tool === 'edit'`, 3000));
  // The toolbar follows the document's state on the next frame, so give it one.
  check('the toolbar shows the Edit tool pressed',
    await waitFor(`document.querySelector('#toolbar .tool-seg .seg-btn[aria-label="Edit text"]')?.getAttribute('aria-pressed') === 'true'`, 3000));
  check('editable text is outlined', await waitFor(`document.querySelectorAll('.vl-decor polygon.vl-edit-run').length >= 3`));
  await shot('01-edit-mode');

  await revealRun(SIMPLE, 1, 'Hello, world');
  let at = await runAt(SIMPLE, 1, 'Hello, world');
  await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: at.x, y: at.y });
  check('hovering highlights the text and shows a text cursor', await waitFor(`Boolean(document.querySelector('.vl-edit-run.hover')) && ${V(SIMPLE)}.container.classList.contains('vl-edit-hover')`, 3000));
  await c.mouse(at.x, at.y);
  check('clicking opens an editor over the text', await waitFor(editorOpen, 3000));
  check('the editor holds the text', (await q(`document.querySelector('.vl-text-input').value`)) === 'Hello, world');
  check('the editor has focus', await q(`document.activeElement?.classList.contains('vl-text-input')`));
  await waitFor(`document.querySelector('.vl-edit-status')?.textContent.length > 0`, 3000);
  check('the bar says the original font is used', (await status())?.text === 'Same font as the original.', JSON.stringify(await status()));
  const aligned = await q(`(() => {
    const r = document.querySelector('.vl-text-editor').getBoundingClientRect();
    return { w: Math.round(r.width), h: Math.round(r.height), x: Math.round(r.left), y: Math.round(r.top) };
  })()`);
  check('the editor sits over the text', Math.abs(aligned.x + aligned.w / 2 - at.x) < aligned.w && Math.abs(aligned.y + aligned.h / 2 - at.y) < aligned.h, JSON.stringify({ aligned, at }));
  await shot('02-editor-open');
  await replaceText('Hello, Vellum');
  await c.key('Enter');
  check('Enter keeps the change', await waitFor(`${editorGone} && ${settled(SIMPLE)}`, 10000));
  check('the page shows the new text', (await lineAt(SIMPLE, 1, 700)) === 'Hello, Vellum');
  check('edited text is marked', await waitFor(`Boolean(document.querySelector('.vl-edit-run.edited'))`, 5000));
  check('the tab shows unsaved changes', await q(`Boolean(document.querySelector('.tab.active.dirty'))`));

  // Escape cancels.
  await clickRun(SIMPLE, 1, 'Third line.');
  await waitFor(editorOpen, 3000);
  await replaceText('Should not stay');
  await c.key('Escape');
  check('Escape cancels', await waitFor(editorGone, 3000));
  check('…and nothing changed', (await q(`${V(SIMPLE)}.annotations.edits.length`)) === 1 && (await lineAt(SIMPLE, 1, 640)) === 'Third line.');
  check('…and edit mode is still on', await q(`${V(SIMPLE)}.annotLayer.tool === 'edit'`));

  // Keyboard only. Tab continues from the text last clicked ("Third line.", the last on the page):
  // Shift+Tab goes back to the line before it, Enter opens it, Tab in the editor moves on, and at
  // the last text Tab has nowhere to go, so the editor stays open.
  const inputValue = () => q(`document.querySelector('.vl-text-input')?.value ?? null`);
  await q(`${V(SIMPLE)}.focus()`);
  await c.key('Shift+Tab');
  check('Shift+Tab moves to editable text (focus outline)', await waitFor(`Boolean(document.querySelector('.vl-edit-run.focus'))`, 3000));
  await sleep(200);
  await c.key('Enter');
  check('Enter opens the text under the keyboard focus', await waitFor(editorOpen, 3000));
  const second = await inputValue();
  check('…which is the line before the one last clicked', second === 'A second line with punctuation: café, naïve — 50% off!', second);
  await c.key('Tab');
  await sleep(600);
  await waitFor(editorOpen, 3000);
  check('Tab inside the editor moves to the next text', (await inputValue()) === 'Third line.', await inputValue());
  await c.key('Shift+Tab');
  await sleep(600);
  await waitFor(editorOpen, 3000);
  check('Shift+Tab goes back', (await inputValue()) === second);
  await c.key('Tab');
  await sleep(600);
  await c.key('Tab');
  await sleep(600);
  check('at the last text, Tab keeps the editor open', (await inputValue()) === 'Third line.');
  check('…and says there is nothing further', await q(`/No more editable text/.test(document.querySelector('.doc:not([hidden]) .vl-sr-only')?.textContent ?? '')`));
  await c.key('Escape');
  await waitFor(editorGone, 3000);
  check('Escape closes the editor but keeps Edit mode', await q(`${V(SIMPLE)}.annotLayer.tool === 'edit'`));

  // Characters no font can write: refused with a reason, nothing changes.
  await clickRun(SIMPLE, 1, 'Third line.');
  await waitFor(editorOpen, 3000);
  await replaceText('नमस्ते');
  await waitFor(`document.querySelector('.vl-edit-status')?.classList.contains('error')`, 3000);
  check('unsupported characters are explained', (await status())?.tone.includes('error'), (await status())?.text);
  check('…and Done is disabled', await q(`document.querySelector('.vl-edit-bar .btn.primary').disabled`));
  await c.key('Enter');
  await sleep(500);
  check('…and Enter doesn’t apply them', await q(editorOpen) && (await q(`${V(SIMPLE)}.annotations.edits.length`)) === 1);
  await shot('03-editor-unsupported');
  await c.key('Escape');
  await waitFor(editorGone, 3000);

  // Undo / redo from the keyboard.
  await q(`${V(SIMPLE)}.focus()`);
  await c.key('Ctrl+Z');
  await waitFor(settled(SIMPLE), 10000);
  await sleep(300);
  const undone = await lineAt(SIMPLE, 1, 700);
  await c.key('Ctrl+Y');
  await waitFor(settled(SIMPLE), 10000);
  await sleep(300);
  const redone = await lineAt(SIMPLE, 1, 700);
  check('Ctrl+Z / Ctrl+Y undo and redo the edit', undone === 'Hello, world' && redone === 'Hello, Vellum', `${undone} / ${redone}`);

  // Zoom while the editor is open: it follows the text.
  await clickRun(SIMPLE, 1, 'Hello, Vellum');
  await waitFor(editorOpen, 3000);
  await c.key('Ctrl+=');
  await waitFor(settled(SIMPLE), 5000);
  await sleep(700);
  at = await runAt(SIMPLE, 1, 'Hello, Vellum');
  const after = await q(`(() => { const r = document.querySelector('.vl-text-editor').getBoundingClientRect(); return { cx: r.left + r.width / 2, cy: r.top + r.height / 2, w: r.width, h: r.height }; })()`);
  check('zooming keeps the editor on its text', at && Math.abs(after.cy - at.y) < after.h && after.cx > at.x - after.w, JSON.stringify({ after, at }));
  await c.key('Escape');
  await waitFor(editorGone, 3000);
  await q(`${V(SIMPLE)}.zoomTo('auto')`);
  await sleep(600);

  // Ctrl+S with text still being typed: it's kept and saved. Then close and reopen.
  await clickRun(SIMPLE, 1, 'Third line.');
  await waitFor(editorOpen, 3000);
  await replaceText('Line three, saved.');
  await c.key('Ctrl+S');
  check('Ctrl+S keeps the text being typed and saves', await waitFor(`${editorGone} && ${settled(SIMPLE)} && !${V(SIMPLE)}.annotations.dirty`, 15000));
  await q(`__vellum.app.close(${V(SIMPLE)})`);
  await waitFor(`!${V(SIMPLE)}`, 5000);
  await q(`__vellum.actions.openRecent(${JSON.stringify(SIMPLE)})`);
  await waitFor(settled(SIMPLE), 20000);
  await sleep(500);
  check('reopened: both edits are in the file', (await lineAt(SIMPLE, 1, 700)) === 'Hello, Vellum' && (await lineAt(SIMPLE, 1, 640)) === 'Line three, saved.',
    `${await lineAt(SIMPLE, 1, 700)} | ${await lineAt(SIMPLE, 1, 640)}`);

  // ---- B. a font that can't write the new text: a matching standard font, said in the bar ------
  await activate(FONTS);
  await c.key('E');
  await waitFor(`document.querySelectorAll('.vl-decor polygon.vl-edit-run').length >= 5`, 8000);
  await clickRun(FONTS, 1, 'Liberation Sans embedded');
  await waitFor(editorOpen, 3000);
  await replaceText('Quartz jumps');
  await waitFor(`document.querySelector('.vl-edit-status')?.classList.contains('warn')`, 3000);
  const warn = await status();
  check('a substitute font is announced before applying', warn?.tone.includes('warn') && /Helvetica/.test(warn.text), warn?.text);
  await shot('04-editor-substitute-font');
  await c.key('Enter');
  await waitFor(`${editorGone} && ${settled(FONTS)}`, 10000);
  check('…and the page shows it', (await lineAt(FONTS, 1, 550)) === 'Quartz jumps');

  // ---- C. text that can't be edited explains why ----------------------------------------------
  await activate(CONSTRUCTS);
  await c.key('E');
  await waitFor(`document.querySelectorAll('.vl-decor polygon.vl-edit-run').length >= 5`, 8000);
  await revealRun(CONSTRUCTS, 1, 'abab');
  const locked = await runAt(CONSTRUCTS, 1, 'abab'); // locked: clicked below without expecting an editor
  await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: locked.x, y: locked.y });
  check('hovering locked text shows it can’t be edited', await waitFor(`${V(CONSTRUCTS)}.container.classList.contains('vl-edit-locked') && Boolean(document.querySelector('.vl-edit-run.locked'))`, 3000));
  await c.mouse(locked.x, locked.y);
  check('clicking locked text explains why', await waitFor(`/picture font/i.test(document.querySelector('.vl-edit-tip')?.textContent ?? '')`, 3000));
  check('…and no editor opens', await q(editorGone));
  await shot('05-locked-text');

  // ---- D. scanned page -------------------------------------------------------------------------------
  await activate(SCANNED);
  await c.key('E');
  await sleep(800);
  const page = await q(`(() => { const r = ${V(SCANNED)}.viewer.getPageView(0).div.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + Math.min(r.height / 2, 300) }; })()`);
  await c.mouse(page.x, page.y);
  check('a scanned page says there is no text to edit', await waitFor(`/scanned image/i.test(document.querySelector('.vl-edit-tip')?.textContent ?? '')`, 4000));
  await shot('06-scanned-page');

  // ---- E. protected PDF: the tool is unavailable, with the reason -------------------------------------
  await activate(ENCRYPTED);
  await waitFor(settled(ENCRYPTED), 10000);
  const button = await q(`(() => { const b = [...document.querySelectorAll('#toolbar .tool-seg .seg-btn')].at(-1); return { disabled: b.disabled, title: b.title }; })()`);
  check('on a protected PDF the Edit tool is disabled, with the reason', button.disabled && /protected/i.test(button.title), button.title);
  await c.key('E');
  await sleep(500);
  check('…and E doesn’t switch it on', await q(`${V(ENCRYPTED)}.annotLayer.tool !== 'edit'`));

  // ---- F. themes, comfort settings, page colours, a narrow window -------------------------------------
  await activate(SIMPLE);
  await c.key('E');
  await waitFor(`document.querySelectorAll('.vl-decor polygon.vl-edit-run').length >= 3`, 8000);
  await clickRun(SIMPLE, 1, 'A second line with punctuation: café, naïve — 50% off!');
  await waitFor(editorOpen, 3000);
  await q(`__vellum.setAppearance({ theme: 'mist', mode: 'dark', accent: null })`);
  await sleep(700);
  await shot('07-editor-obsidian');
  await q(`import('/js/themes.js').then((t) => { t.setReducedTransparency(true); t.setReducedMotion(true); })`);
  await sleep(400);
  await shot('08-editor-obsidian-solid');
  await q(`__vellum.ui.toolbar.onPageTone('dark')`);
  await sleep(400);
  await shot('09-editor-dark-pages');
  await q(`__vellum.ui.toolbar.onPageTone('sepia')`);
  await q(`__vellum.setAppearance({ theme: 'blush', mode: 'light', accent: null })`);
  await sleep(700);
  await shot('10-editor-blush-sepia');
  check('the editor survives theme and page-colour changes', await q(editorOpen));
  await c.key('Escape');
  await waitFor(editorGone, 3000);
  await q(`__vellum.ui.toolbar.onPageTone('normal')`);
  await q(`__vellum.setAppearance({ theme: 'mist', mode: 'light', accent: null })`);
  await q(`import('/js/themes.js').then((t) => { t.setReducedTransparency(false); t.setReducedMotion(false); })`);

  await c.send('Emulation.setDeviceMetricsOverride', { width: 560, height: 420, deviceScaleFactor: 1, mobile: false });
  await sleep(900);
  await q(`${V(SIMPLE)}.zoomTo('page-width')`);
  await sleep(700);
  await clickRun(SIMPLE, 1, 'Hello, Vellum');
  await waitFor(editorOpen, 3000);
  const narrow = await q(`(() => {
    const bar = document.querySelector('.vl-edit-bar').getBoundingClientRect();
    const c = ${V(SIMPLE)}.container.getBoundingClientRect();
    return { barLeft: Math.round(bar.left), barRight: Math.round(bar.right), left: Math.round(c.left), right: Math.round(c.right), overflow: document.documentElement.scrollWidth - innerWidth };
  })()`);
  check('in a narrow window the bar fits and nothing overflows sideways', narrow.barLeft >= narrow.left && narrow.barRight <= narrow.right && narrow.overflow === 0, JSON.stringify(narrow));
  await shot('11-editor-narrow');
  await c.key('Escape');
  await c.send('Emulation.clearDeviceMetricsOverride');
  await sleep(500);

  // ---- G. clean up -------------------------------------------------------------------------------------
  await c.key('V');
  const errors = await q('__vellum.errors');
  check('no runtime errors', errors.length === 0, JSON.stringify(errors).slice(0, 400));
  for (const p of DOCS) await q(`(() => { const v = ${V(p)}; if (v) __vellum.app.close(v); })()`);
  await q(`(async () => {
    for (const path of ${JSON.stringify(DOCS)}) await __vellum.ui.start.bridge.request('recent.remove', { path });
    __vellum.ui.start.refresh();
  })()`);
  // Put the appearance settings back exactly as they were (a key that didn't exist is removed again).
  await q(`(async () => {
    const o = ${JSON.stringify(original)};
    const t = await import('/js/themes.js');
    if (o.appearance) __vellum.setAppearance(JSON.parse(o.appearance));
    t.setReducedMotion(o.motion === 'reduced');
    t.setReducedTransparency(o.glass === 'off');
    __vellum.ui.toolbar.onPageTone(o.tone ?? 'normal');
    const restore = (key, value) => (value === null ? localStorage.removeItem(key) : localStorage.setItem(key, value));
    restore('vellum.appearance', o.appearance);
    restore('vellum.appearance.seeds', o.seeds);
    restore('vellum.motion', o.motion);
    restore('vellum.glass', o.glass);
    restore('vellum.pageTone', o.tone);
  })()`);
  const restored = await q(`({ appearance: localStorage.getItem('vellum.appearance'), seeds: localStorage.getItem('vellum.appearance.seeds'), motion: localStorage.getItem('vellum.motion'), glass: localStorage.getItem('vellum.glass'), tone: localStorage.getItem('vellum.pageTone') })`);
  check('appearance settings restored exactly', JSON.stringify(restored) === JSON.stringify(original), JSON.stringify(original));
  console.log(`  ${retries} click retr${retries === 1 ? 'y' : 'ies'}`);
}
