// Forms v1: the PDF's own form fields, drawn by pdf.js over the page, are filled in the app — text typed,
// a checkbox ticked, a radio button and a dropdown option chosen — saved into the same fields, and shown
// again with those values after the file is closed and reopened.

export const files = { form: 'form' };

export async function run(t) {
  const { c, q, check, sleep, V, settled, waitFor, area } = t;
  const PATH = t.file('form');
  const layer = `${V(PATH)}.viewer.getPageView(0)?.div.querySelector('.annotationLayer')`;
  const centre = (selector) => q(`(() => { const r = ${layer}.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; })()`);
  const values = () => q(`(() => {
    const l = ${layer};
    if (!l) return null;
    const radios = [...l.querySelectorAll('input[type=radio]')];
    return {
      name: l.querySelector('input[type=text], input:not([type])')?.value ?? null,
      agree: l.querySelector('input[type=checkbox]')?.checked ?? null,
      size: radios.map((r) => r.checked),
      country: l.querySelector('select')?.value ?? null,
    };
  })()`);

  area('forms');
  await q(`__vellum.app.activate(${V(PATH)})`);
  await waitFor(settled(PATH), 25000);
  check('the form fields are shown as inputs over the page', await waitFor(`${layer}?.querySelectorAll('input, select').length === 5`, 15000),
    await q(`${layer}?.innerHTML.slice(0, 300)`));

  // The page may still be redrawn once after opening: click only when the input is what is under the pointer.
  await waitFor(`(() => { const i = ${layer}?.querySelector('input[type=text], input:not([type])'); if (!i) return false; const r = i.getBoundingClientRect(); return document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2) === i; })()`, 10000);
  let at = await centre('input[type=text], input:not([type])');
  await c.mouse(at[0], at[1]);
  await sleep(200);
  await c.type('Ada Lovelace');
  at = await centre('input[type=checkbox]');
  await c.mouse(at[0], at[1]);
  at = await q(`(() => { const r = ${layer}.querySelectorAll('input[type=radio]')[1].getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; })()`);
  await c.mouse(at[0], at[1]);
  // A native dropdown's popup isn't part of the page, so the option is chosen as the browser reports it.
  await q(`(() => { const s = ${layer}.querySelector('select'); s.value = 'se'; s.dispatchEvent(new Event('input', { bubbles: true })); s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  await sleep(300);
  check('filling the form marks the document changed', await waitFor(`${V(PATH)}.annotations.dirty`, 5000));
  const kept = await q(`JSON.stringify(${V(PATH)}.annotations.formValues)`);
  check('each field’s value is kept by name', kept?.includes('"Ada Lovelace"') && kept.includes('"agree","type":"checkbox","value":true') && kept.includes('"value":"Large"') && kept.includes('"value":"se"'), kept);

  await q('__vellum.actions.save()');
  check('saved', await waitFor(`!${V(PATH)}.annotations.dirty`, 25000));
  await q(`__vellum.app.close(${V(PATH)})`);
  await waitFor(`!${V(PATH)}`);
  await q(`__vellum.actions.openRecent(${JSON.stringify(PATH)})`);
  await waitFor(settled(PATH), 25000);
  await waitFor(`${layer}?.querySelectorAll('input, select').length === 5`, 15000);
  const back = await values();
  check('reopened: the fields show the saved values and are still editable fields',
    back?.name === 'Ada Lovelace' && back.agree === true && back.size[0] === false && back.size[1] === true && back.country === 'se'
    && !(await q(`${V(PATH)}.annotations.dirty`)), JSON.stringify(back));
  await t.shot('reopened');

  // Forms v2: new fields placed with the field tool, moved and resized, saved as real fields, and filled after reopening.
  const pdfPoint = async (x, y) => q(`(() => {
    const pv = ${V(PATH)}.viewer.getPageView(0);
    const box = pv.div.getBoundingClientRect();
    const [vx, vy] = pv.viewport.convertToViewportPoint(${x}, ${y});
    const s = box.width / pv.viewport.width;
    return [box.left + vx * s, box.top + vy * s];
  })()`);
  const created = () => q(`JSON.stringify(${V(PATH)}.annotations.all.filter((a) => a.type === 'field').map(({ kind, name, value, rect, options }) => ({ kind, name, value, rect: rect.map(Math.round), options })))`).then(JSON.parse);
  await q(`${V(PATH)}.viewer.currentScaleValue = 'page-fit'`);
  await sleep(800);
  for (const [kind, x, y] of [['text', 72, 300], ['checkbox', 72, 250], ['radio', 72, 220], ['radio', 120, 220], ['dropdown', 72, 180]]) {
    await q(`${V(PATH)}.annotLayer.startField('${kind}')`);
    const p = await pdfPoint(x, y);
    await c.mouse(p[0], p[1]);
    await sleep(150);
  }
  let made = await created();
  check('the field tool places each kind of field, radio buttons in one group',
    JSON.stringify(made.map((f) => `${f.kind}:${f.name}:${f.value ?? ''}`)) === JSON.stringify(['text:Text1:', 'checkbox:Check1:', 'radio:Choice1:Option1', 'radio:Choice1:Option2', 'dropdown:Dropdown1:'])
    && made[0].rect.every((v, i) => Math.abs(v - [72, 278, 232, 300][i]) <= 2) && (await q(`${V(PATH)}.annotLayer.tool`)) === 'select', JSON.stringify(made));

  let p = await pdfPoint(150, 289);
  let to = await pdfPoint(250, 289);
  await c.drag(p, to, 10);
  await sleep(200);
  made = await created();
  check('a created field moves with the pointer', Math.abs(made[0].rect[0] - 172) <= 3 && Math.abs(made[0].rect[1] - 278) <= 3, JSON.stringify(made[0]));
  p = await pdfPoint(made[0].rect[2], made[0].rect[1]);
  to = await pdfPoint(made[0].rect[2] + 40, made[0].rect[1] - 10);
  await c.drag(p, to, 10);
  await sleep(200);
  made = await created();
  check('a created field resizes from its handle', Math.abs(made[0].rect[2] - 372) <= 3 && Math.abs(made[0].rect[1] - 268) <= 3 && Math.abs(made[0].rect[3] - 300) <= 3, JSON.stringify(made[0]));

  p = await pdfPoint(100, 170);
  await c.mouse(p[0], p[1]);
  await sleep(200);
  check('selecting a created dropdown shows its options', await waitFor(`document.querySelector('.vl-pop input[aria-label^="Options"]')`, 3000));
  await q(`(() => { const i = document.querySelector('.vl-pop input[aria-label^="Options"]'); i.value = 'Red, Green'; i.dispatchEvent(new Event('change')); })()`);
  made = await created();
  check('the dropdown keeps the options typed', JSON.stringify(made[4].options) === '["Red","Green"]', JSON.stringify(made[4]));

  await q('__vellum.actions.save()');
  check('saved with the new fields', await waitFor(`!${V(PATH)}.annotations.dirty`, 25000));
  await q(`__vellum.app.close(${V(PATH)})`);
  await waitFor(`!${V(PATH)}`);
  await q(`__vellum.actions.openRecent(${JSON.stringify(PATH)})`);
  await waitFor(settled(PATH), 25000);
  check('reopened: the created fields are the file’s own fields now, drawn as inputs',
    await waitFor(`${layer}?.querySelectorAll('input, select').length === 10`, 15000), await q(`${layer}?.querySelectorAll('input, select').length`));
  const text1 = await q(`${V(PATH)}.pdf.getFieldObjects().then((o) => JSON.stringify({ rect: o.get('Text1').find((w) => w.type).rect.map(Math.round), options: o.get('Dropdown1').find((w) => w.type).items.map((i) => i.exportValue), radios: o.get('Choice1').length, stored: ${V(PATH)}.annotations.all.length }))`).then(JSON.parse);
  check('the fields are where they were moved and sized, with their options', text1.rect.every((v, i) => Math.abs(v - made[0].rect[i]) <= 1)
    && JSON.stringify(text1.options) === '["Red","Green"]' && text1.radios >= 2 && text1.stored === 0, JSON.stringify(text1));
  const box = await q(`${V(PATH)}.pdf.getFieldObjects().then((o) => { const r = ${layer}.querySelector('[data-element-id="' + o.get('Text1').find((w) => w.type).id + '"]').getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; })`);
  await c.mouse(box[0], box[1]);
  await sleep(200);
  await c.type('Grace');
  await sleep(300);
  const filled = await q(`JSON.stringify(${V(PATH)}.annotations.formValues)`);
  check('a created field is filled like any other after reopening', filled?.includes('"name":"Text1","type":"text","value":"Grace"'), filled);
  await t.shot('created-fields');

  // Forms v2.1: the file's own fields are edited — picked from the right-click menu, moved, resized,
  // renamed, made required, given a maximum length, deleted — with undo, and saved into the same fields.
  const own = () => q(`JSON.stringify(${V(PATH)}.annotations.all.filter((a) => a.existing).map(({ kind, name, value, rect, required, maxLength, deleted, options, existing }) => ({ kind, name, value, rect: rect.map(Math.round), required, maxLength, deleted: Boolean(deleted), options, was: existing.name })))`).then(JSON.parse);
  const widgetCentre = (name, index = 0) => q(`${V(PATH)}.pdf.getFieldObjects().then((o) => { const r = ${layer}.querySelector('[data-annotation-id="' + o.get(${JSON.stringify(name)}).filter((w) => w.type)[${index}].id + '"]').getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; })`);
  const editOwn = async (name, index = 0) => {
    const at = await widgetCentre(name, index);
    await c.mouse(at[0], at[1], { button: 'right' });
    await waitFor(`document.querySelector('.menu')`, 3000);
    const found = await q(`(() => { const b = [...document.querySelectorAll('.menu > *')].find((el) => el.textContent.includes('Edit Form Field')); b?.click(); return Boolean(b); })()`);
    await sleep(400);
    return found;
  };
  check('right-clicking one of the file’s own fields offers “Edit Form Field”', await editOwn('name'));
  let mine = await own();
  check('the field becomes an editable item, and pdf.js’s own drawing of it is hidden',
    mine.length === 1 && mine[0].kind === 'text' && mine[0].name === 'name' && (await q(`${layer}.querySelectorAll('.vl-field-edited').length`)) === 1
    && (await q(`Boolean(document.querySelector('.vl-pop input[aria-label="Field name"]'))`)), JSON.stringify(mine));
  const start = mine[0].rect;
  p = await pdfPoint(start[0] + 60, (start[1] + start[3]) / 2);
  to = await pdfPoint(start[0] + 160, (start[1] + start[3]) / 2 - 100);
  await c.drag(p, to, 10);
  await sleep(250);
  mine = await own();
  check('an existing field moves with the pointer', Math.abs(mine[0].rect[0] - (start[0] + 100)) <= 3 && Math.abs(mine[0].rect[1] - (start[1] - 100)) <= 3, JSON.stringify(mine[0]));
  const moved = mine[0].rect;
  await q(`${V(PATH)}.annotations.undo()`);
  mine = await own();
  const undone = mine[0].rect.every((v, i) => Math.abs(v - start[i]) <= 1);
  await q(`${V(PATH)}.annotations.redo()`);
  mine = await own();
  check('undo and redo take the move back and forward', undone && mine[0].rect.every((v, i) => Math.abs(v - moved[i]) <= 1), JSON.stringify(mine[0]));
  p = await pdfPoint(moved[2], moved[1]);
  to = await pdfPoint(moved[2] + 40, moved[1] - 10);
  await c.drag(p, to, 10);
  await sleep(250);
  mine = await own();
  check('an existing field resizes from its handle', Math.abs(mine[0].rect[2] - (moved[2] + 40)) <= 3 && Math.abs(mine[0].rect[1] - (moved[1] - 10)) <= 3, JSON.stringify(mine[0]));
  const sized = mine[0].rect;

  const setInput = (label, value) => q(`(() => { const i = document.querySelector('.vl-pop input[aria-label^=${JSON.stringify(label)}]'); if (!i) return null; i.value = ${JSON.stringify(value)}; i.dispatchEvent(new Event('change')); return i.hasAttribute('aria-invalid'); })()`);
  await q(`${V(PATH)}.annotLayer.select(${V(PATH)}.annotations.all.find((a) => a.existing?.name === 'name').id)`);
  await sleep(200);
  const refused = await setInput('Field name', 'agree');
  const refusedDot = await setInput('Field name', 'a.b');
  mine = await own();
  check('a name already in the file, or with a dot, is refused', refused === true && refusedDot === true && mine[0].name === 'name', JSON.stringify(mine[0]));
  const renamed = await setInput('Field name', 'fullName');
  const maxed = await setInput('Maximum length', '20');
  await q(`[...document.querySelectorAll('.vl-pop .vl-field-flag')].find((b) => b.textContent === 'Required').click()`);
  mine = await own();
  check('rename, maximum length and required are kept', renamed === false && maxed === false && mine[0].name === 'fullName' && mine[0].maxLength === 20 && mine[0].required === true, JSON.stringify(mine[0]));
  await q(`${V(PATH)}.annotations.undo()`);
  mine = await own();
  const flagUndone = mine[0].required === false;
  await q(`${V(PATH)}.annotations.redo()`);
  mine = await own();
  check('undo and redo take back and forward a property change', flagUndone && mine[0].required === true, JSON.stringify(mine[0]));

  check('a radio button of the file can be edited', await editOwn('size', 1));
  let radio = (await own()).find((f) => f.kind === 'radio');
  const radioStart = radio.rect;
  p = await pdfPoint((radioStart[0] + radioStart[2]) / 2, (radioStart[1] + radioStart[3]) / 2);
  to = await pdfPoint((radioStart[0] + radioStart[2]) / 2 + 80, (radioStart[1] + radioStart[3]) / 2);
  await c.drag(p, to, 10);
  await sleep(250);
  radio = (await own()).find((f) => f.kind === 'radio');
  check('…moved, keeping its group and export value', radio.name === 'size' && radio.value === 'Large' && Math.abs(radio.rect[0] - (radioStart[0] + 80)) <= 3, JSON.stringify(radio));
  check('a dropdown of the file can be edited, keeping its options', await editOwn('country')
    && JSON.stringify((await own()).find((f) => f.kind === 'dropdown')?.options) === '["India","Sweden"]');

  check('a field of the file can be deleted', await editOwn('Check1'));
  await c.key('Delete');
  await sleep(250);
  let check1 = (await own()).find((f) => f.was === 'Check1');
  const hit = await q(`${V(PATH)}.annotLayer.selectedId`);
  await q(`${V(PATH)}.annotations.undo()`);
  const back1 = (await own()).find((f) => f.was === 'Check1');
  await q(`${V(PATH)}.annotations.redo()`);
  check('…with Delete, and undo brings it back', check1?.deleted === true && hit === null && back1?.deleted === false
    && (await own()).find((f) => f.was === 'Check1')?.deleted === true, JSON.stringify({ check1, back1 }));
  await t.shot('edited-fields');

  await q('__vellum.actions.save()');
  check('saved with the edited fields', await waitFor(`!${V(PATH)}.annotations.dirty`, 25000), await q('JSON.stringify(__vellum.errors.slice(0, 3))'));
  await q(`__vellum.app.close(${V(PATH)})`);
  await waitFor(`!${V(PATH)}`);
  await q(`__vellum.actions.openRecent(${JSON.stringify(PATH)})`);
  await waitFor(settled(PATH), 25000);
  await waitFor(`${layer}?.querySelectorAll('input, select').length === 9`, 15000);
  const after = await q(`${V(PATH)}.pdf.getPage(1).then((p) => p.getAnnotations()).then((list) => JSON.stringify(list.filter((a) => a.fieldName).map((a) => ({ name: a.fieldName, rect: a.rect.map(Math.round), required: a.required, maxLen: a.maxLen, value: a.fieldValue, export: a.buttonValue ?? null, options: a.options?.map((o) => o.exportValue) }))))`).then(JSON.parse);
  const named = (n) => after.filter((f) => f.name === n);
  const full = named('fullName')[0];
  const sizes = named('size');
  check('reopened: the renamed field is where it was moved and sized, required, with its maximum length and value',
    full && full.rect.every((v, i) => Math.abs(v - sized[i]) <= 1) && full.required === true && full.maxLen === 20 && full.value === 'Ada Lovelace' && !named('name').length, JSON.stringify(full));
  check('reopened: the deleted field is gone; the radio group keeps both buttons, export values and the choice',
    !named('Check1').length && sizes.length === 2 && sizes.map((s) => s.export).sort().join() === 'Large,Small' && sizes.every((s) => s.value === 'Large')
    && sizes.some((s) => Math.abs(s.rect[0] - radio.rect[0]) <= 1), JSON.stringify({ sizes, all: after.map((f) => f.name) }));
  check('reopened: the dropdown keeps its options and value; a created field keeps what was typed',
    JSON.stringify(named('country')[0]?.options) === '["in","se"]' && JSON.stringify(named('country')[0]?.value) === '["se"]' && named('Text1')[0]?.value === 'Grace',
    JSON.stringify({ country: named('country'), text1: named('Text1') }));
  check('reopened: nothing is left waiting to be saved', (await q(`${V(PATH)}.annotations.all.length`)) === 0 && !(await q(`${V(PATH)}.annotations.dirty`)));

  check('no page errors were collected', (await q('__vellum.errors.length')) === 0, await q('JSON.stringify(__vellum.errors.slice(0, 3))'));
}
