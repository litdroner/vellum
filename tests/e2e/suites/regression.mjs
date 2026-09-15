// Targeted regression in the real app (keys, mouse, typing), on copies — the 0.4.0 final pass:
//   1. annotations: create, move/edit, save → close → reopen; still intact after a text edit + save
//   2. search: found and located, next/previous, no results, after an edit, after save + reopen
//   3. rotation while the text editor is open: view (keys and view bar) and page (menu and palette)

export const files = { 'reg-annot': 'simple', 'reg-search': 'multipage', 'reg-rotate': 'simple' };

export async function run(t) {
  const { c, q, check, sleep, shot, V, settled } = t;
  const ANNOT = t.file('reg-annot');
  const SEARCH = t.file('reg-search');
  const ROTATE = t.file('reg-rotate');
  const waitFor = (expr, ms = 15000) => t.waitFor(expr, ms);
  const activate = async (path) => { await q(`__vellum.app.activate(${V(path)})`); await waitFor(settled(path)); await sleep(400); };
  const editorOpen = `Boolean(document.querySelector('.vl-text-editor'))`;
  const editorGone = `!document.querySelector('.vl-text-editor')`;
  const errors = () => q('__vellum.errors.length');

  /** Screen rectangle of a pdf.js text-layer span with exactly this text (visible pages). */
  const spanRect = (text) => q(`(() => {
    const span = [...document.querySelectorAll('.doc:not([hidden]) .textLayer span')].find((s) => s.textContent === ${JSON.stringify(text)});
    if (!span) return null;
    const r = span.getBoundingClientRect();
    return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, cx: r.left + r.width / 2, cy: r.top + r.height / 2 };
  })()`);
  /** Screen centre of an editable run by its current text (via the editing session). */
  const runAt = (path, page, text) => q(`(async () => {
    const v = ${V(path)};
    const p = await v.textEditing.page(${page});
    const item = p.runs.find((r) => r.text === ${JSON.stringify(text)});
    if (!item) return null;
    const pv = v.viewer.getPageView(${page} - 1);
    const vp = pv.viewport;
    const box = pv.div.getBoundingClientRect();
    let x = 0; let y = 0;
    for (let i = 0; i < 8; i += 2) {
      const [vx, vy] = vp.convertToViewportPoint(item.run.quad[i], item.run.quad[i + 1]);
      x += box.left + (vx * box.width) / vp.width;
      y += box.top + (vy * box.height) / vp.height;
    }
    return { x: x / 4, y: y / 4 };
  })()`);
  /**
   * Scrolls a run to the middle of the view when it isn't plainly clickable where it is, as a person
   * would before clicking it. How far a document is scrolled once several have opened isn't
   * deterministic, and a line near the top of a page can land under the tool bar, where a click
   * at its centre lands on the tool bar instead.
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
  const openEditor = async (path, page, text) => {
    await revealRun(path, page, text);
    const at = await runAt(path, page, text);
    if (!at) return false;
    await c.mouse(at.x, at.y);
    return waitFor(editorOpen, 4000);
  };
  const replaceText = async (text) => {
    await q(`document.querySelector('.vl-text-input')?.select()`);
    await c.type(text);
    await sleep(250);
  };
  const pageText = (path, page) => q(`(async () => {
    const t = await (await ${V(path)}.pdf.getPage(${page})).getTextContent();
    return t.items.filter((i) => i.str.trim()).map((i) => ({ str: i.str, x: Math.round(i.transform[4]), y: Math.round(i.transform[5]) }));
  })()`);
  const annotations = (path) => q(`(() => {
    const r = (v) => Math.round(v * 10) / 10;
    return ${V(path)}.annotations.all.map((a) => ({
      id: a.id, type: a.type, page: a.page, color: a.color, contents: a.contents ?? '',
      point: a.point?.map(r) ?? null, quads: a.quads?.map((q) => q.map(r)) ?? null, paths: a.paths?.length ?? null, width: a.width ?? null,
    })).sort((x, y) => x.type.localeCompare(y.type));
  })()`);
  const reopen = async (path) => {
    await q(`__vellum.app.close(${V(path)})`);
    await waitFor(`!${V(path)}`, 5000);
    await q(`__vellum.actions.openRecent(${JSON.stringify(path)})`);
    await waitFor(settled(path), 20000);
    await sleep(700);
  };
  const save = async (path) => {
    await c.key('Ctrl+S');
    return waitFor(`${settled(path)} && !${V(path)}.annotations.dirty`, 15000);
  };

  await waitFor([ANNOT, SEARCH, ROTATE].map((p) => settled(p)).join(' && '), 30000);

  // ===== 1. ANNOTATIONS ===========================================================================
  t.area('annotations');
  await activate(ANNOT);
  await q(`${V(ANNOT)}.focus()`);
  // Highlight: the H tool, then drag across a line — once the tool is really on and the line's text
  // layer is there to drag over (the suite may be the first thing a freshly started app does).
  await c.key('H');
  const highlightOn = await waitFor(`${V(ANNOT)}.annotLayer.tool === 'highlight'`, 3000);
  await revealRun(ANNOT, 1, 'Third line.');
  await waitFor(`[...document.querySelectorAll('.doc:not([hidden]) .textLayer span')].some((s) => s.textContent === 'Third line.')`, 5000);
  let line = await spanRect('Third line.');
  await c.drag([line.left + 1, line.cy], [line.right - 1, line.cy]);
  check('a new highlight is created by dragging over text with the H tool', await waitFor(`${V(ANNOT)}.annotations.all.some((a) => a.type === 'highlight')`, 3000),
    JSON.stringify({ highlightOn, tool: await q(`${V(ANNOT)}.annotLayer.tool`), line, selection: await q('String(getSelection())'), under: await q(`document.elementFromPoint(${line.cx}, ${line.cy})?.className ?? null`) }));
  // Note: the N tool, click beside the text, type, Done.
  await c.key('N');
  const hello = await spanRect('Hello, world');
  await c.mouse(hello.right + 120, hello.cy);
  await waitFor(`Boolean(document.querySelector('.vl-note-editor'))`, 3000);
  await c.type('Reviewer note');
  await q(`document.querySelector('.vl-note-editor .btn.primary').click()`);
  check('a new note is created with its text', await waitFor(`${V(ANNOT)}.annotations.all.some((a) => a.type === 'note' && a.contents === 'Reviewer note')`, 3000));
  // Ink: the D tool, draw a stroke below the text.
  await c.key('D');
  line = await spanRect('Third line.');
  await c.drag([line.left, line.bottom + 60], [line.left + 160, line.bottom + 90], 12);
  check('new ink is drawn', await waitFor(`${V(ANNOT)}.annotations.all.some((a) => a.type === 'ink')`, 3000));
  await c.key('V');
  await sleep(300);
  // Move the note (drag its icon), then edit its text.
  const before = await annotations(ANNOT);
  const noteBox = await q(`(() => { const r = document.querySelector('.vl-note[data-id]').getBoundingClientRect(); return { cx: r.left + r.width / 2, cy: r.top + r.height / 2 }; })()`);
  // Test-only probe: does the browser fire a click at the end of the drag?
  await q(`window.__clicks = 0; document.addEventListener('click', () => { window.__clicks++; }, true); true`);
  await c.drag([noteBox.cx, noteBox.cy], [noteBox.cx + 70, noteBox.cy + 30], 10);
  await sleep(300);
  const clicksAfterDrag = await q('window.__clicks');
  const moved = await annotations(ANNOT);
  const n0 = before.find((a) => a.type === 'note');
  const n1 = moved.find((a) => a.type === 'note');
  check('the note can be moved', n1.point[0] > n0.point[0] + 20 && n1.point[1] < n0.point[1] - 5, `${n0.point} → ${n1.point}`);
  const noteNow = await q(`(() => { const r = document.querySelector('.vl-note[data-id]').getBoundingClientRect(); return { cx: r.left + r.width / 2, cy: r.top + r.height / 2 }; })()`);
  await c.mouse(noteNow.cx, noteNow.cy);
  const openedFirstTime = await waitFor(`Boolean(document.querySelector('.vl-note-editor'))`, 3000);
  check('clicking the note right after moving it opens it', openedFirstTime, `browser clicks fired by the drag: ${clicksAfterDrag}; first click after the drag ${openedFirstTime ? 'opened the note' : 'was swallowed'}`);
  if (!openedFirstTime) {
    await c.mouse(noteNow.cx, noteNow.cy); // carry on to check the rest
    await waitFor(`Boolean(document.querySelector('.vl-note-editor'))`, 3000);
  }
  await q(`document.querySelector('.vl-note-text').select()`);
  await c.type('Reviewer note, revised');
  await q(`document.querySelector('.vl-note-editor .btn.primary').click()`);
  check('the note’s text can be edited', await waitFor(`${V(ANNOT)}.annotations.all.some((a) => a.type === 'note' && a.contents === 'Reviewer note, revised')`, 3000));
  // Recolour the highlight and the ink through their bars.
  line = await spanRect('Third line.');
  await c.mouse(line.cx, line.cy);
  await waitFor(`Boolean(document.querySelector('.vl-pop .swatch'))`, 3000);
  await q(`document.querySelectorAll('.vl-pop .swatch')[1].click()`);
  check('the highlight can be recoloured', await waitFor(`${V(ANNOT)}.annotations.all.find((a) => a.type === 'highlight')?.color === '#a3eab9'`, 3000));
  await c.key('Escape');
  const inkPoint = await q(`(() => {
    const v = ${V(ANNOT)};
    const ink = v.annotations.all.find((a) => a.type === 'ink');
    const pv = v.viewer.getPageView(0);
    const vp = pv.viewport;
    const box = pv.div.getBoundingClientRect();
    const [vx, vy] = vp.convertToViewportPoint(ink.paths[0][0], ink.paths[0][1]);
    return { x: box.left + (vx * box.width) / vp.width, y: box.top + (vy * box.height) / vp.height };
  })()`);
  await c.mouse(inkPoint.x, inkPoint.y);
  await waitFor(`Boolean(document.querySelector('.vl-pop .swatch'))`, 3000);
  await q(`document.querySelectorAll('.vl-pop .swatch')[2].click()`);
  check('the ink can be recoloured', await waitFor(`${V(ANNOT)}.annotations.all.find((a) => a.type === 'ink')?.color === '#1f9e6b'`, 3000));
  await c.key('Escape');
  const created = await annotations(ANNOT);
  await shot('r1-annotations-created');
  check('save', await save(ANNOT));
  await reopen(ANNOT);
  const reopened = await annotations(ANNOT);
  check('after save → close → reopen, every annotation is back exactly (type, place, colour, text)', JSON.stringify(reopened) === JSON.stringify(created),
    JSON.stringify({ created: created.map((a) => a.type), reopened: reopened.map((a) => a.type) }));
  check('…and they are drawn on the page', await waitFor(`document.querySelectorAll('.doc:not([hidden]) .vl-layer .vl-a').length >= 3`, 5000));
  // A text edit (and save) leaves the annotations alone.
  await c.key('E');
  await waitFor(`document.querySelectorAll('.vl-decor polygon.vl-edit-run').length >= 3`, 8000);
  await openEditor(ANNOT, 1, 'Hello, world');
  await replaceText('Hello, annotated world');
  await c.key('Enter');
  await waitFor(`${editorGone} && ${settled(ANNOT)}`, 10000);
  await sleep(500);
  check('after a text edit the annotations are unchanged', JSON.stringify(await annotations(ANNOT)) === JSON.stringify(created));
  check('…and still drawn after the page is rebuilt', await waitFor(`document.querySelectorAll('.doc:not([hidden]) .vl-layer .vl-a').length >= 3`, 5000));
  await c.key('V');
  check('save with a text edit and annotations', await save(ANNOT));
  await reopen(ANNOT);
  check('after reopening: the edited text is there', (await pageText(ANNOT, 1)).some((i) => i.str === 'Hello, annotated world'));
  check('…and every annotation is still exactly as it was', JSON.stringify(await annotations(ANNOT)) === JSON.stringify(created));
  await shot('r2-annotations-after-text-edit');
  check('no runtime errors (annotations)', (await errors()) === 0);

  // ===== 2. SEARCH ============================================================================================
  t.area('search');
  await activate(SEARCH);
  const find = () => q(`(() => { const v = ${V(SEARCH)}; const sel = document.querySelector('.doc:not([hidden]) .textLayer .highlight.selected'); return {
    current: v.find.current, total: v.find.total, state: v.find.state, page: v.state.pageNumber,
    selectedPage: sel ? Number(sel.closest('.page').dataset.pageNumber) : null, selectedText: sel?.textContent ?? null,
    count: document.querySelector('.findbar .find-count')?.textContent ?? null, noMatch: document.querySelector('.findbar')?.classList.contains('no-match') ?? null,
  }; })()`);
  // Start from page 1 (Vellum reopens a file where it was left; search starts from the current page).
  await q(`${V(SEARCH)}.focus()`);
  await c.key('Home');
  await waitFor(`${V(SEARCH)}.state.pageNumber === 1`, 3000);
  await sleep(300);
  await c.key('Ctrl+F');
  await waitFor(`document.activeElement?.classList.contains('find-input')`, 3000);
  await c.type('Page');
  await waitFor(`${V(SEARCH)}.find.total === 5 && Boolean(document.querySelector('.doc:not([hidden]) .textLayer .highlight.selected'))`, 6000);
  let f = await find();
  check('a word on every page is found (5 matches)', f.total === 5 && f.current === 1, JSON.stringify(f));
  check('…and the first match is highlighted on page 1', f.selectedPage === 1 && f.selectedText === 'Page', JSON.stringify(f));
  check('…and the bar counts it', f.count === '1 of 5', f.count);
  await shot('r3-search-found');
  await c.key('Enter');
  await waitFor(`${V(SEARCH)}.find.current === 2`, 4000);
  await sleep(300);
  f = await find();
  check('Enter goes to the next match (page 2)', f.current === 2 && f.selectedPage === 2 && f.page === 2, JSON.stringify(f));
  await c.key('F3');
  await waitFor(`${V(SEARCH)}.find.current === 3`, 4000);
  await sleep(300);
  f = await find();
  check('F3 goes to the next match (page 3)', f.current === 3 && f.selectedPage === 3 && f.page === 3, JSON.stringify(f));
  await c.key('Shift+F3');
  await waitFor(`${V(SEARCH)}.find.current === 2`, 4000);
  await sleep(300);
  check('Shift+F3 goes back', (await find()).selectedPage === 2);
  await c.key('Shift+Enter');
  await waitFor(`${V(SEARCH)}.find.current === 1`, 4000);
  await sleep(300);
  check('Shift+Enter goes back again (page 1)', (await find()).selectedPage === 1);
  await q(`document.querySelector('.findbar .find-input').select()`);
  await c.type('zzzqqq');
  await waitFor(`${V(SEARCH)}.find.state === 1`, 4000);
  await sleep(200);
  f = await find();
  check('a search with no results says so', f.state === 1 && f.total === 0 && f.noMatch && f.count === 'No matches', JSON.stringify(f));
  await c.key('Escape');
  await waitFor(`document.querySelector('.findbar').hidden`, 2000);
  // Edit a line, then search for the new text.
  await q(`${V(SEARCH)}.goToPage(2)`);
  await sleep(700);
  await c.key('E');
  await waitFor(`document.querySelectorAll('.vl-decor polygon.vl-edit-run').length >= 1`, 8000);
  check('edit a line on page 2', await openEditor(SEARCH, 2, 'Page 2 of five'));
  await replaceText('Page two of five');
  await c.key('Enter');
  await waitFor(`${editorGone} && ${settled(SEARCH)}`, 10000);
  await sleep(500);
  await c.key('V');
  await c.key('Ctrl+F');
  await waitFor(`document.activeElement?.classList.contains('find-input')`, 3000);
  await q(`document.querySelector('.findbar .find-input').select()`);
  await c.type('two');
  await waitFor(`${V(SEARCH)}.find.total === 1 && Boolean(document.querySelector('.doc:not([hidden]) .textLayer .highlight.selected'))`, 6000);
  f = await find();
  check('search finds the edited text right after the edit', f.total === 1 && f.selectedPage === 2 && f.selectedText === 'two', JSON.stringify(f));
  await q(`document.querySelector('.findbar .find-input').select()`);
  await c.type('Page 2');
  await waitFor(`${V(SEARCH)}.find.state === 1`, 4000);
  check('…and no longer finds the replaced text', (await find()).total === 0);
  await c.key('Escape');
  check('save', await save(SEARCH));
  await reopen(SEARCH);
  await c.key('Ctrl+F');
  await waitFor(`document.activeElement?.classList.contains('find-input')`, 3000);
  await q(`document.querySelector('.findbar .find-input').select()`);
  await c.type('Page two');
  await waitFor(`${V(SEARCH)}.find.total === 1 && Boolean(document.querySelector('.doc:not([hidden]) .textLayer .highlight.selected'))`, 8000);
  f = await find();
  check('after save and reopen, the edited text is found on page 2', f.total === 1 && f.selectedPage === 2 && f.page === 2, JSON.stringify(f));
  await shot('r4-search-after-reopen');
  await c.key('Escape');
  check('no runtime errors (search)', (await errors()) === 0);

  // ===== 3. ROTATION WHILE EDITING ==============================================================================
  t.area('rotation');
  await activate(ROTATE);
  const editorBox = () => q(`(() => {
    const el = document.querySelector('.vl-text-editor');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { cx: r.left + r.width / 2, cy: r.top + r.height / 2, w: r.width, h: r.height, transform: el.style.transform, value: el.querySelector('input').value, focused: document.activeElement === el.querySelector('input') };
  })()`);
  const near = (box, at) => Boolean(box && at) && Math.abs(box.cx - at.x) < Math.max(12, box.w * 0.25) && Math.abs(box.cy - at.y) < Math.max(12, box.h * 0.25);
  await c.key('E');
  await waitFor(`document.querySelectorAll('.vl-decor polygon.vl-edit-run').length >= 3`, 8000);
  const SECOND = 'A second line with punctuation: café, naïve — 50% off!';
  check('open an editable line', await openEditor(ROTATE, 1, SECOND));
  await replaceText('Second line, typed before rotating.');
  await c.key('Ctrl+Shift+=');
  await waitFor(`${V(ROTATE)}.state.rotation === 90`, 3000);
  await sleep(1200);
  let box = await editorBox();
  let at = await runAt(ROTATE, 1, SECOND);
  check('rotating the view with the editor open: no crash, the editor stays open with its text', box?.value === 'Second line, typed before rotating.', JSON.stringify(box));
  check('…and it turns with the page and stays on its line', near(box, at) && /rotate\(1\.57/.test(box.transform), JSON.stringify({ box, at }));
  check('…and the outlines follow the page', await waitFor(`document.querySelectorAll('.vl-decor polygon.vl-edit-run').length >= 2`, 3000));
  await shot('r5-editor-rotated');
  await q(`document.querySelector('.vl-text-input').focus()`);
  await c.key('Enter');
  await waitFor(`${editorGone} && ${settled(ROTATE)}`, 10000);
  await sleep(600);
  check('committing while rotated applies the text and keeps the rotation',
    (await pageText(ROTATE, 1)).some((i) => i.str === 'Second line, typed before rotating.') && (await q(`${V(ROTATE)}.state.rotation`)) === 90);
  check('rotate a line open, then rotate back with the editor open', await openEditor(ROTATE, 1, 'Third line.'));
  await c.key('Ctrl+Shift+-');
  await waitFor(`${V(ROTATE)}.state.rotation === 0`, 3000);
  await sleep(1200);
  box = await editorBox();
  at = await runAt(ROTATE, 1, 'Third line.');
  check('…the editor comes back upright on its line', near(box, at) && /rotate\(0rad\)/.test(box.transform), JSON.stringify({ box, at }));
  await c.key('Escape');
  await waitFor(editorGone, 3000);
  check('Escape cancels safely after rotating (nothing else changed)', (await q(`${V(ROTATE)}.annotations.edits.length`)) === 1);
  // The view bar's rotate button with typed text: the text is kept first, then the view turns.
  await openEditor(ROTATE, 1, 'Hello, world');
  await replaceText('Hello, rotated world');
  const rot = await q(`(() => { const r = document.querySelector('.viewbar button[aria-label="Rotate view clockwise"]').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  await c.mouse(rot.x, rot.y);
  await waitFor(`${editorGone} && ${settled(ROTATE)} && ${V(ROTATE)}.state.rotation === 90`, 10000);
  await sleep(600);
  check('the view bar’s rotate button keeps the typed text, then turns the view',
    (await pageText(ROTATE, 1)).some((i) => i.str === 'Hello, rotated world') && (await q(`${V(ROTATE)}.annotations.edits.length`)) === 2);
  for (let i = 0; i < 3; i++) { await c.mouse(rot.x, rot.y); await sleep(500); }
  await waitFor(`${V(ROTATE)}.state.rotation === 0`, 3000);
  // Rotating the page itself (context menu) while the editor is open.
  await openEditor(ROTATE, 1, 'Third line.');
  await replaceText('Third line, page turned.');
  // A point on the visible part of the page, away from the text (the page is taller than the window).
  const visiblePagePoint = `(() => {
    const v = ${V(ROTATE)};
    const r = v.viewer.getPageView(0).div.getBoundingClientRect();
    const c = v.container.getBoundingClientRect();
    return { x: r.left + r.width * 0.85, y: Math.min(r.bottom, c.bottom) - 120 };
  })()`;
  const pageBox = await q(visiblePagePoint);
  await c.mouse(pageBox.x, pageBox.y, { button: 'right' });
  await waitFor(`[...document.querySelectorAll('.menu-item .menu-label')].some((l) => l.textContent === 'Rotate page right')`, 3000);
  const menuItemAt = (label) => q(`(() => {
    const b = [...document.querySelectorAll('.menu-item')].find((x) => x.querySelector('.menu-label')?.textContent === ${JSON.stringify(label)});
    if (!b) return null;
    const r = b.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  })()`);
  const rightItem = await menuItemAt('Rotate page right');
  await c.mouse(rightItem.x, rightItem.y); // a real click, as a person would
  await waitFor(`${editorGone} && ${settled(ROTATE)} && ${V(ROTATE)}.shownPlan[0].rotate === 90`, 15000);
  await sleep(800);
  check('rotating the page with the editor open keeps the typed text and turns the page',
    (await pageText(ROTATE, 1)).some((i) => i.str === 'Third line, page turned.') && (await q(`${V(ROTATE)}.shownPlan[0].rotate`)) === 90);
  check('…and the rotated page is still editable', Boolean(await runAt(ROTATE, 1, 'Third line, page turned.')));
  await shot('r6-page-rotated');
  // Rotating the page back from the keyboard (command palette) while another line is being typed:
  // the typed text must be kept, not discarded by the page change.
  check('open another line on the rotated page', await openEditor(ROTATE, 1, 'Hello, rotated world'));
  await replaceText('Hello again');
  await c.key('Ctrl+K');
  await waitFor(`document.activeElement?.closest?.('.palette')`, 3000);
  await c.type('Rotate page left');
  await sleep(300);
  await c.key('Enter');
  await waitFor(`${editorGone} && ${settled(ROTATE)} && ${V(ROTATE)}.shownPlan[0].rotate === 0`, 15000);
  await sleep(600);
  check('rotating the page back from the command palette keeps the typed text',
    (await pageText(ROTATE, 1)).some((i) => i.str === 'Hello again') && (await q(`${V(ROTATE)}.shownPlan[0].rotate`)) === 0);
  const expected = [['Hello again', 72, 700], ['Second line, typed before rotating.', 72, 660], ['Third line, page turned.', 72, 640]];
  let text = await pageText(ROTATE, 1);
  check('rotated back: the page shows exactly the three edited lines, in place',
    expected.every(([s, x, y]) => text.some((i) => i.str === s && i.x === x && i.y === y)) && text.length === 3, JSON.stringify(text));
  await c.key('V');
  check('save', await save(ROTATE));
  await reopen(ROTATE);
  text = await pageText(ROTATE, 1);
  const rotation = await q(`(async () => (await ${V(ROTATE)}.pdf.getPage(1)).rotate)()`);
  check('after save and reopen: same text, page upright', expected.every(([s, x, y]) => text.some((i) => i.str === s && i.x === x && i.y === y)) && rotation === 0, JSON.stringify({ text, rotation }));
  check('no runtime errors (rotation)', (await errors()) === 0, JSON.stringify(await q('__vellum.errors')).slice(0, 300));

  // ---- chrome: even gaps between the tools; + goes home and keeps the open tabs -------------------
  t.area('chrome');
  const gaps = await q(`(() => {
    const knob = getComputedStyle(document.querySelector('#toolbar .tool-seg'), '::before');
    const pressed = document.querySelector('#toolbar .tool-seg .seg-btn[aria-pressed="true"]');
    const contents = [...document.querySelectorAll('#toolbar .tool-seg .seg-btn')].map((b) => {
      const r = [...b.children].map((c) => c.getBoundingClientRect()).filter((r) => r.width);
      return { left: Math.min(...r.map((x) => x.left)), right: Math.max(...r.map((x) => x.right)) };
    });
    return { spaces: contents.slice(1).map((c, i) => c.left - contents[i].right), knobWidth: parseFloat(knob.width), pressedWidth: pressed?.offsetWidth, count: contents.length };
  })()`);
  check('the six tools have equal space between them', gaps.count === 6 && Math.max(...gaps.spaces) - Math.min(...gaps.spaces) < 1.5, JSON.stringify(gaps));
  check('the tool knob is as wide as the pressed tool', Math.abs(gaps.knobWidth - gaps.pressedWidth) < 1, JSON.stringify(gaps));
  const tabsBefore = await q('__vellum.app.views.length');
  await q(`document.querySelector('.tab-new').click()`);
  await waitFor(`!__vellum.app.active && document.querySelector('#stage').classList.contains('empty')`, 3000);
  const home = await q(`({ views: __vellum.app.views.length, tabs: document.querySelectorAll('.tabs .tab:not(.closing)').length, start: getComputedStyle(document.querySelector('.start')).display !== 'none' })`);
  check('+ shows the home screen with every tab still open', home.start && home.views === tabsBefore && home.tabs === tabsBefore && tabsBefore > 0, JSON.stringify({ tabsBefore, home }));
  await activate(ROTATE);
  check('a tab brings its document back after home', (await q(`__vellum.app.active === ${V(ROTATE)}`)) === true);

  // ---- clean up: tabs closed, test files out of the recent list (Vellum's own remove) ---------------
  await q(`(async () => {
    for (const v of [...__vellum.app.views]) __vellum.app.close(v);
    for (const path of ${JSON.stringify([ANNOT, SEARCH, ROTATE])}) await __vellum.ui.start.bridge.request('recent.remove', { path });
  })()`);
  for (const area of ['annotations', 'search', 'rotation', 'chrome']) {
    const lines = t.results.filter((r) => r.area === area);
    const failed = lines.filter((r) => !r.ok).length;
    console.log(`  ${area.toUpperCase()}: ${failed ? 'FAIL' : 'PASS'} (${lines.length - failed}/${lines.length})`);
  }
}
