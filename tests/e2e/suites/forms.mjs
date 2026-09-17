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

  check('no page errors were collected', (await q('__vellum.errors.length')) === 0, await q('JSON.stringify(__vellum.errors.slice(0, 3))'));
}
