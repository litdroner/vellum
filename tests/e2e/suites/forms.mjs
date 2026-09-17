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

  check('no page errors were collected', (await q('__vellum.errors.length')) === 0, await q('JSON.stringify(__vellum.errors.slice(0, 3))'));
}
