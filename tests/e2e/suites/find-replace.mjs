// Find and replace in the real app: Ctrl+H, the query and the replacement typed, Enter to replace the
// highlighted match, Ctrl+Alt+Enter to replace the rest, Ctrl+Z / Ctrl+Y, then save, close and open
// again. Matching and planning are proved in tests/editing/find-replace.test.mjs.

export const files = { multi: 'multipage', para: 'paragraphs' };

export async function run(t) {
  const { c, q, check, sleep, shot, V, settled, waitFor, area } = t;
  const DOC = t.file('multi');

  const rest = async (ms = 25000) => {
    await waitFor(settled(DOC), ms);
    await sleep(500);
  };
  const texts = () => q(`(async () => { const v = ${V(DOC)}; const out = []; for (let n = 1; n <= v.pdf.numPages; n++) out.push((await (await v.pdf.getPage(n)).getTextContent()).items.map((i) => i.str).join('')); return out; })()`);

  await q(`__vellum.app.activate(${V(DOC)})`);
  await rest();

  area('find');
  await q(`${V(DOC)}.focus()`);
  await c.key('Ctrl+H');
  check('Ctrl+H opens the bar with Replace', await waitFor(`!document.querySelector('.findbar').hidden && !document.querySelector('.find-replace').hidden`, 3000));
  await c.type('five');
  check('matches are counted and highlighted', await waitFor(`${V(DOC)}.find.total === 5 && document.querySelector('.textLayer .highlight.selected')`, 8000),
    await q(`JSON.stringify(${V(DOC)}.find)`));
  await c.key('Enter');
  check('Enter goes to the next match', await waitFor(`${V(DOC)}.find.current === 2`, 5000));

  area('replace one');
  await q(`document.querySelector('.find-replace .find-input').focus()`);
  await c.type('5');
  await c.key('Enter');
  await rest();
  let now = await texts();
  check('the highlighted match, and only it, is replaced', now.filter((s) => s.endsWith('of 5')).length === 1 && now.filter((s) => s.endsWith('of five')).length === 4, JSON.stringify(now));
  check('the search runs again on what is left', await waitFor(`${V(DOC)}.find.total === 4`, 8000), await q(`JSON.stringify(${V(DOC)}.find)`));

  area('replace all');
  await q(`document.querySelector('.find-replace .find-input').focus()`);
  await c.key('Ctrl+Alt+Enter');
  await rest();
  now = await texts();
  check('every page now reads "of 5"', now.every((s) => s.endsWith('of 5')), JSON.stringify(now));
  await shot('replaced');

  area('undo and redo');
  await q(`${V(DOC)}.focus()`);
  await c.key('Ctrl+Z');
  await rest();
  now = await texts();
  check('one undo takes Replace All back as a whole', now.filter((s) => s.endsWith('of 5')).length === 1, JSON.stringify(now));
  await c.key('Ctrl+Y');
  await rest();
  check('redo replaces them again', (await texts()).every((s) => s.endsWith('of 5')));

  area('save and reopen');
  await q('__vellum.actions.save()');
  check('saved', await waitFor(`!${V(DOC)}.annotations.dirty`, 25000));
  await q(`__vellum.app.close(${V(DOC)})`);
  await waitFor(`!${V(DOC)}`);
  await q(`__vellum.actions.openRecent(${JSON.stringify(DOC)})`);
  await rest();
  now = await texts();
  check('the file reads the replaced text', now.length === 5 && now.every((s, i) => s === `Page ${i + 1} of 5`), JSON.stringify(now));
  check('no page errors were collected', (await q('__vellum.errors.length')) === 0, await q('JSON.stringify(__vellum.errors.slice(0, 3))'));

  area('pasted text and new text');
  const edits = () => q(`JSON.stringify(${V(DOC)}.annotations.edits.map((e) => [e.kind, e.text]))`);
  await q(`(async () => { const s = ${V(DOC)}.textEditing; const own = (await s.objects(1)).objects.find((o) => o.text === 'Page 1 of 5'); await s.pasteObjects(1, await s.copyObjects(1, [own.ref.key]), [1, 0, 0, 1, 0, -100]); })()`);
  await rest();
  await q(`(async () => { const s = ${V(DOC)}.textEditing; window.__box = await s.insertText(1, { basis: [1, 0, 0, -1, 0, 0], box: [0, 0, 612, 792] }); })()`);
  await rest();
  await q(`${V(DOC)}.textEditing.edit(1, window.__box, 'Box of 5')`);
  await rest();
  await q(`window.__notices = []; ${V(DOC)}.addEventListener('notice', (e) => window.__notices.push(e.detail.message))`);
  await rest();
  await q(`${V(DOC)}.focus()`);
  await c.key('Ctrl+H');
  await q(`document.querySelector('.findbar .find-input').focus()`);
  await c.key('Ctrl+A');
  await c.type('of 5');
  await q(`document.querySelector('.find-replace .find-input').focus()`);
  await c.key('Ctrl+A');
  await c.type('of five');
  await c.key('Ctrl+Alt+Enter');
  check('Replace All reports what it did', await waitFor(`(window.__notices ?? []).length > 0`, 15000), await q('JSON.stringify(window.__notices)'));
  await rest();
  let all = JSON.parse(await edits());
  check('the pasted copy is replaced', all.some(([k, t]) => k === 'text-copy' && t === 'Page 1 of five'), JSON.stringify(all));
  check('the new text box is replaced', all.some(([k, t]) => k === 'inserted-text' && t === 'Box of five'), JSON.stringify(all));
  check('the notice counts every match', /^Replaced 7 of 7 matches./.test((await q('window.__notices[0]')) ?? ''), await q('JSON.stringify(window.__notices)'));
  await q(`${V(DOC)}.focus()`);
  await c.key('Ctrl+Z');
  await rest();
  all = JSON.parse(await edits());
  check('one undo takes all of it back', all.some(([k, t]) => k === 'text-copy' && t === 'Page 1 of 5') && all.some(([k, t]) => k === 'inserted-text' && t === 'Box of 5'), JSON.stringify(all));
  check('still no page errors', (await q('__vellum.errors.length')) === 0, await q('JSON.stringify(__vellum.errors.slice(0, 3))'));

  // ---- a match across two lines of a paragraph (1.2) ----------------------------------------------------
  area('cross-line match');
  const PARA = t.file('para');
  const settle = async (ms = 25000) => {
    await waitFor(settled(PARA), ms);
    await sleep(500);
  };
  const lines = () => q(`(async () => (await (await ${V(PARA)}.pdf.getPage(1)).getTextContent()).items.map((i) => i.str.trim()).filter(Boolean))()`);
  await q(`__vellum.app.activate(${V(PARA)})`);
  await settle();
  await q(`${V(PARA)}.focus()`);
  await c.key('Ctrl+H');
  await q(`document.querySelector('.findbar .find-input').focus()`);
  await c.key('Ctrl+A');
  await c.type('paragraph that runs on');
  check('a match across two lines is found and highlighted', await waitFor(`${V(PARA)}.find.total === 1 && document.querySelectorAll('.textLayer .highlight.selected').length >= 2`, 8000),
    await q(`JSON.stringify(${V(PARA)}.find)`));
  await q(`document.querySelector('.find-replace .find-input').focus()`);
  await c.key('Ctrl+A');
  await c.type('paragraph which goes on');
  await c.key('Enter');
  await settle();
  let para = await lines();
  check('Replace changes both lines of the match', para.includes('The first line of a plain paragraph which goes on') && para.includes('to a second line, then a third'), JSON.stringify(para));
  check('it is one undo step', (await q(`${V(PARA)}.annotations.edits.length`)) === 2);
  await shot('cross-line-replaced');
  await q(`${V(PARA)}.focus()`);
  await c.key('Ctrl+Z');
  await settle();
  para = await lines();
  check('one undo takes both lines back', para.includes('The first line of a plain paragraph that') && para.includes('runs on to a second line, then a third'), JSON.stringify(para));
  await q(`window.__notices = []; ${V(PARA)}.addEventListener('notice', (e) => window.__notices.push(e.detail.message))`);
  await q(`document.querySelector('.findbar .find-input').focus()`);
  await c.key('Ctrl+A');
  await c.type('which is shorter.');
  await q(`document.querySelector('.find-replace .find-input').focus()`);
  await c.key('Ctrl+A');
  await c.type('x');
  await c.key('Ctrl+Alt+Enter');
  check('a match that would empty a line is skipped, with the reason', await waitFor(`(window.__notices ?? []).some((m) => /Skipped 1 match.*empty line/.test(m))`, 15000), await q('JSON.stringify(window.__notices)'));
  check('…and nothing changed', (await q(`${V(PARA)}.annotations.edits.length`)) === 0);
  await c.key('Escape');

  // ---- Text Box and Form Fields are told apart in the page's context menu ---------------------------------
  area('context menu: Text Box vs Form Field');
  const menu = () => q(`[...document.querySelectorAll('.menu > *')].map((el) => (el.classList.contains('menu-heading') ? '# ' : '') + (el.querySelector('.menu-label')?.textContent ?? el.textContent)).filter(Boolean)`);
  const closeMenu = async () => { await c.key('Escape'); await sleep(200); };
  const pagePoint = (fx, fy) => q(`(() => { const r = ${V(PARA)}.viewer.getPageView(0).div.getBoundingClientRect(); return { x: r.left + r.width * ${fx}, y: r.top + r.height * ${fy} }; })()`);
  const onScreen = (key) => q(`(async () => {
    const v = ${V(PARA)}; const o = (await v.textEditing.objects(1)).objects.find((x) => x.ref.key === ${JSON.stringify(key)});
    const pv = v.viewer.getPageView(0); const r = pv.div.getBoundingClientRect(); const g = o.geometry.quad;
    const [x, y] = pv.viewport.convertToViewportPoint((g[0] + g[4]) / 2, (g[1] + g[5]) / 2);
    return { x: r.left + x, y: r.top + y };
  })()`);
  await q(`${V(PARA)}.viewer.currentPageNumber = 1`);
  await sleep(400);
  let at = await pagePoint(0.8, 0.12);
  await c.mouse(at.x, at.y, { button: 'right' });
  await waitFor(`document.querySelector('.menu')`, 3000);
  let items = await menu();
  check('the page menu has a “Form Fields” section with “Add Text Field here”', items.includes('# Form Fields') && items.includes('Add Text Field here'), JSON.stringify(items));
  check('…and outside Edit mode no Text Box command, so nothing reads as two kinds of “text”', !items.some((s) => /Text Box/.test(s)), JSON.stringify(items));
  await closeMenu();

  await q(`${V(PARA)}.setTool('edit')`);
  await settle();
  const box = await q(`${V(PARA)}.textEditing.insertText(1, { basis: [1, 0, 0, -1, 0, 0], box: [360, 700, 600, 780] })`);
  await settle();
  await q(`${V(PARA)}.objectSelection.set(1, [${JSON.stringify(box)}])`);
  await sleep(400);
  at = await onScreen(box);
  await q(`${V(PARA)}.container.scrollTop += ${at.y} - innerHeight / 2`);
  await sleep(500);
  at = await onScreen(box);
  await c.mouse(at.x, at.y, { button: 'right' });
  await waitFor(`document.querySelector('.menu')`, 3000);
  items = await menu();
  check('a selected text box is named “Text Box” with its own actions, first', items[0] === '# Text Box' && items.includes('Copy Text Box'), JSON.stringify({ items, at, under: await q(`document.elementFromPoint(${at.x}, ${at.y})?.className?.baseVal ?? document.elementFromPoint(${at.x}, ${at.y})?.className`), selection: await q(`JSON.stringify(${V(PARA)}.objectSelection.current)`) }));
  check('“Add Text Box” sits in its own section, apart from “Form Fields”', items.includes('# Page Content') && items.includes('Add Text Box')
    && items.indexOf('Add Text Box') > items.indexOf('# Page Content') && !items.slice(items.indexOf('# Form Fields'), items.indexOf('# Page Content')).includes('Add Text Box'), JSON.stringify(items));
  check('the two “add” commands have different icons', await q(`(() => { const icon = (label) => [...document.querySelectorAll('.menu-item')].find((b) => b.querySelector('.menu-label')?.textContent === label)?.querySelector('.menu-icon').innerHTML; return Boolean(icon('Add Text Box')) && icon('Add Text Box') !== icon('Add Text Field here'); })()`));
  await shot('menu-text-box');
  await closeMenu();
  await q(`${V(PARA)}.objectSelection.clear()`);
  await q(`${V(PARA)}.setTool('select')`);
  await q(`${V(PARA)}.container.scrollTop = 0`);
  await settle();

  at = await pagePoint(0.8, 0.3);
  await q(`${V(PARA)}.annotLayer.addFieldAt(${at.x}, ${at.y}, 'text')`);
  await sleep(600);
  const field = await q(`(() => { const f = document.querySelector('.vl-field-box'); if (!f) return null; const r = f.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  at = field ?? { x: at.x + 20, y: at.y + 8 };
  await c.mouse(at.x, at.y, { button: 'right' });
  await waitFor(`document.querySelector('.menu')`, 3000);
  items = await menu();
  check('a form field’s menu names it “Form Field · Text Field”', items.includes('# Form Field · Text Field') && items.includes('Delete Form Field'), JSON.stringify(items));
  check('…with no Text Box actions', !items.some((s) => /Text Box/.test(s)), JSON.stringify(items));
  await shot('menu-form-field');
  await closeMenu();
  check('no page errors in the cross-line and menu checks', (await q('__vellum.errors.length')) === 0, await q('JSON.stringify(__vellum.errors.slice(0, 3))'));
}
