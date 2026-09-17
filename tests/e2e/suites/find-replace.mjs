// Find and replace in the real app: Ctrl+H, the query and the replacement typed, Enter to replace the
// highlighted match, Ctrl+Alt+Enter to replace the rest, Ctrl+Z / Ctrl+Y, then save, close and open
// again. Matching and planning are proved in tests/editing/find-replace.test.mjs.

export const files = { multi: 'multipage' };

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
}
