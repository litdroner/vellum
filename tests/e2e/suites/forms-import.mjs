// Imported form fields: pages inserted from another PDF (here a second copy of the same form, so every
// name clashes) bring their fields into the file's own form under names of their own; after saving and
// reopening they are filled like any other field, and the file's own fields keep their values.

export const files = { form: 'form', other: 'form' };

export async function run(t) {
  const { c, q, check, sleep, V, settled, waitFor, area } = t;
  const PATH = t.file('form');
  const OTHER = t.file('other');
  const fields = () => q(`(async () => {
    const objects = await ${V(PATH)}.pdf.getFieldObjects();
    const out = {};
    for (const [name, list] of objects) for (const o of list) if (o.type) (out[name] ??= []).push({ id: o.id, page: o.page, value: o.value });
    return JSON.stringify(out);
  })()`).then((s) => JSON.parse(s ?? '{}'));
  const reopen = async () => {
    await q(`__vellum.app.close(${V(PATH)})`);
    await waitFor(`!${V(PATH)}`);
    await q(`__vellum.actions.openRecent(${JSON.stringify(PATH)})`);
    await waitFor(settled(PATH), 25000);
  };

  area('forms import');
  await waitFor(settled(OTHER), 25000);
  await q(`__vellum.app.activate(${V(PATH)})`);
  await waitFor(settled(PATH), 25000);
  await q(`__vellum.actions.pages.insertFiles(${V(PATH)}, [${V(OTHER)}.file], 1)`);
  await waitFor(`${V(PATH)}.pdf?.numPages === 2 && ${settled(PATH)}`, 25000);
  let f = await fields();
  const ownNames = ['agree', 'country', 'name', 'size'];
  check('inserted pages bring their fields, renamed where the names are taken',
    JSON.stringify(Object.keys(f).sort()) === JSON.stringify([...ownNames, ...ownNames.map((n) => `${n}_2`)].sort())
    && f.name_2?.every((w) => w.page === 1) && f.name?.every((w) => w.page === 0), JSON.stringify(f));

  await q('__vellum.actions.save()');
  check('saved', await waitFor(`!${V(PATH)}.annotations.dirty`, 25000));
  await reopen();
  f = await fields();
  check('reopened: the imported fields are the file’s own fields now', Boolean(f.name_2 && f.size_2?.length === 2 && f.name?.length === 1), JSON.stringify(f));

  // Fill the imported text field on page 2, typed as a person would.
  await q(`${V(PATH)}.viewer.currentPageNumber = 2`);
  const input = `${V(PATH)}.viewer.getPageView(1)?.div.querySelector('.annotationLayer input[data-element-id="${f.name_2[0].id}"]')`;
  await waitFor(`(() => { const i = ${input}; if (!i) return false; const r = i.getBoundingClientRect(); return document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2) === i; })()`, 15000);
  const at = await q(`(() => { const r = ${input}.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; })()`);
  await c.mouse(at[0], at[1]);
  await sleep(200);
  await c.type('Imported Ada');
  await sleep(300);
  const kept = await q(`JSON.stringify(${V(PATH)}.annotations.formValues)`);
  check('what is typed is kept under the imported field’s name', kept?.includes('"name":"name_2"') && kept.includes('Imported Ada'), kept);
  await q('__vellum.actions.save()');
  check('saved again', await waitFor(`!${V(PATH)}.annotations.dirty`, 25000));
  await reopen();
  f = await fields();
  check('reopened: the imported field holds its value, the file’s own field is unchanged',
    f.name_2?.[0]?.value === 'Imported Ada' && (f.name?.[0]?.value ?? '') === '', JSON.stringify({ name: f.name, name_2: f.name_2 }));
  await t.shot('imported-filled');
  check('no errors in the page', (await q('__vellum.errors.length')) === 0, JSON.stringify(await q('__vellum.errors')));
}
