// The Font button of the edit bar on a line of the page's own text (0.6): the families of the PDF's own
// fonts, the line's own checked; choosing another sets the whole line in it (editing/objects/run-face.js),
// one undo step, saved and reopened as editable text in that font object. A family the line can't be set
// in is listed but can't be chosen.

export const files = { families: 'families' };

export async function run(t) {
  const { c, q, check, sleep, V, settled, waitFor, area } = t;
  const PATH = t.file('families');
  const rest = async (ms = 25000) => {
    await waitFor(settled(PATH), ms);
    await sleep(400);
  };
  const line = (text, y) => q(`(async () => {
    const v = ${V(PATH)};
    const { objects } = await v.textEditing.objects(1);
    const o = objects.find((o) => o.text === ${JSON.stringify(text)} && Math.abs(o.record.origin[1] - ${y}) < 0.5);
    const pv = v.viewer.getPageView(0);
    const box = pv.div.getBoundingClientRect();
    const q = o.geometry.quad;
    const [vx, vy] = pv.viewport.convertToViewportPoint((q[0] + q[4]) / 2, (q[1] + q[5]) / 2);
    return { key: o.ref.key, cx: box.left + vx * (box.width / pv.viewport.width), cy: box.top + vy * (box.height / pv.viewport.height) };
  })()`);
  const record = () => q(`(() => { const e = ${V(PATH)}.annotations.edits.find((r) => r.kind === 'text'); return e ? { face: e.face?.font ?? null, n: ${V(PATH)}.annotations.edits.length } : null; })()`);
  const fontButton = `document.querySelector('.vl-edit-bar .vl-run-font')`;
  const menuItems = `[...document.querySelectorAll('.font-menu .menu-item')].map((b) => ({ label: b.textContent, disabled: b.disabled, checked: b.getAttribute('aria-checked') === 'true' }))`;

  area('page text font');
  await q(`__vellum.app.activate(${V(PATH)})`);
  await rest();
  await q(`${V(PATH)}.setTool('edit')`);
  await sleep(500);

  // The bold line: the serif has no bold face, so it is listed but can't be chosen.
  const bold = await line('Plain sentence here in bold', 660);
  await c.mouse(bold.cx, bold.cy);
  check('the edit bar of page text has a Font button naming its font', await waitFor(`${fontButton}?.textContent.startsWith('Font: ') && ${fontButton}.textContent.includes('Liberation')`, 5000),
    await q(`${fontButton}?.textContent`));
  let at = await q(`(() => { const r = ${fontButton}.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; })()`);
  await c.mouse(at[0], at[1]);
  await waitFor(`document.querySelector('.font-menu')`, 5000);
  const boldMenu = await q(menuItems);
  check('its menu lists the PDF’s own families only; the serif can’t be chosen for a bold line',
    boldMenu?.length === 2 && boldMenu.some((i) => i.checked && i.label.includes('Liberation')) && boldMenu.some((i) => !i.checked && i.disabled), JSON.stringify(boldMenu));
  await c.key('Escape');
  await sleep(300);
  await c.key('Escape');
  await sleep(400);

  const plain = await line('Plain sentence here', 720);
  await c.mouse(plain.cx, plain.cy);
  await waitFor(`${fontButton}?.textContent.includes('Liberation')`, 5000);
  const depth = await q(`(() => { let n = 0; const v = ${V(PATH)}; while (v.annotations.canUndo) { v.annotations.undo(); n++; } for (let i = 0; i < n; i++) v.annotations.redo(); return n; })()`);
  at = await q(`(() => { const r = ${fontButton}.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; })()`);
  await c.mouse(at[0], at[1]);
  await waitFor(`document.querySelector('.font-menu')`, 5000);
  const serifAt = await q(`(() => { const b = [...document.querySelectorAll('.font-menu .menu-item')].find((b) => !b.disabled && b.getAttribute('aria-checked') !== 'true'); if (!b) return null; const r = b.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2, b.textContent]; })()`);
  check('the serif can be chosen for the regular line', Boolean(serifAt), JSON.stringify(await q(menuItems)));
  if (!serifAt) return;
  await c.mouse(serifAt[0], serifAt[1]);
  await rest();
  const held = await record();
  const newDepth = await q(`(() => { let n = 0; const v = ${V(PATH)}; while (v.annotations.canUndo) { v.annotations.undo(); n++; } for (let i = 0; i < n; i++) v.annotations.redo(); return n; })()`);
  check('choosing it sets the line in that font object of the PDF: one record, one undo step',
    held?.n === 1 && /^doc:\d+-\d+$/.test(held.face ?? '') && newDepth === depth + 1, JSON.stringify([held, depth, newDepth]));

  await q(`${V(PATH)}.annotations.undo()`);
  await rest();
  check('undo takes it back', (await record()) === null);
  await q(`${V(PATH)}.annotations.redo()`);
  await rest();
  check('redo sets it again', (await record())?.face === held?.face);

  await q('__vellum.actions.save()');
  await waitFor(`!${V(PATH)}.annotations.dirty`, 25000);
  await q(`__vellum.app.close(${V(PATH)})`);
  await waitFor(`!${V(PATH)}`);
  await q(`__vellum.actions.openRecent(${JSON.stringify(PATH)})`);
  await rest();
  const reopened = await q(`(async () => {
    const { runs } = await ${V(PATH)}.textEditing.page(1);
    const at720 = runs.find((r) => r.run.text === 'Plain sentence here' && Math.abs(r.run.origin[1] - 720) < 0.05);
    const serif = runs.find((r) => r.run.text === 'Plain sentence here in serif');
    return at720 ? { same: at720.run.font?.key === serif?.run.font?.key, editable: at720.run.editable, x: Math.round(at720.run.origin[0] * 1000) / 1000, drawn: runs.filter((r) => r.run.text === 'Plain sentence here').length } : null;
  })()`);
  check('saved and reopened: editable text from the same start, in the serif font object, drawn once',
    reopened?.same === true && reopened.editable === true && reopened.x === 72 && reopened.drawn === 2, JSON.stringify(reopened));

  check('no page errors were collected', (await q('__vellum.errors.length')) === 0, await q('JSON.stringify(__vellum.errors.slice(0, 3))'));
}
