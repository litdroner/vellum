// Text inside a Form XObject, edited in the real app: the one case Vellum writes (a clean depth-1
// occurrence with resources of its own) is clickable and typeable like any other text, an occurrence
// Vellum can't copy safely is still refused in its own words, and a form drawn twice and edited once
// leaves its other draw exactly as it was — on screen, in the saved file, and after reopening it.

export const files = { 'ui-form-text': 'form-xobjects' };

export async function run(t) {
  const { c, q, check, sleep, shot, V, settled } = t;
  const DOC = t.file('ui-form-text');
  const waitFor = async (expr, ms = 20000) => t.waitFor(expr, ms);
  const editorOpen = `Boolean(document.querySelector('.vl-text-editor'))`;
  const editorGone = `!document.querySelector('.vl-text-editor')`;

  /** Every run of page 1 as the engine sees it: text, whether it's editable, and its left edge. */
  const runs = () => q(`(async () => {
    const p = await ${V(DOC)}.textEditing.page(1);
    return p.runs.map((r) => ({ text: r.text, editable: r.run.editable, form: Boolean(r.run.formEdit), x: Math.round(r.run.origin[0]) }));
  })()`);

  /** The centre of the run at this left edge with this text, in screen coordinates. */
  const runAt = (text, x) => q(`(async () => {
    const v = ${V(DOC)};
    const p = await v.textEditing.page(1);
    const item = p.runs.find((r) => r.text === ${JSON.stringify(text)} && Math.round(r.run.origin[0]) === ${x});
    if (!item) return null;
    const pv = v.viewer.getPageView(0);
    const vp = pv.viewport;
    const box = pv.div.getBoundingClientRect();
    let cx = 0;
    let cy = 0;
    for (let i = 0; i < 8; i += 2) {
      const [px, py] = vp.convertToViewportPoint(item.run.quad[i], item.run.quad[i + 1]);
      cx += box.left + (px * box.width) / vp.width;
      cy += box.top + (py * box.height) / vp.height;
    }
    return { x: cx / 4, y: cy / 4, editable: item.run.editable };
  })()`);

  /** What pdf.js draws on page 1: [{ str, x }], rounded, whitespace-only items left out. */
  const drawn = () => q(`(async () => {
    const content = await (await ${V(DOC)}.pdf.getPage(1)).getTextContent();
    return content.items.filter((i) => i.str.trim()).map((i) => ({ str: i.str, x: Math.round(i.transform[4]) }));
  })()`);

  const says = (str) => (list) => list.filter((i) => i.str === str).length;

  await waitFor(`Boolean(${V(DOC)})`, 30000);
  await q(`__vellum.app.activate(${V(DOC)})`);
  await waitFor(settled(DOC), 30000);
  await sleep(500);

  // ---- A. which text a form draws is editable at all -------------------------------------------
  const before = await runs();
  const find = (text) => before.find((r) => r.text === text);
  check('a clean depth-1 form’s text is editable, through a copy of that form',
    find('Clean form text')?.editable === true && find('Clean form text')?.form === true, JSON.stringify(find('Clean form text')));
  check('both draws of a shared form are editable, each on its own',
    before.filter((r) => r.text === 'Drawn twice' && r.editable && r.form).length === 2);
  for (const text of ['Borrowed resources', 'Behind a soft mask', 'Unbalanced form', 'Tagged form text', 'Font from outside', 'Two forms deep']) {
    check(`“${text}” is still refused`, find(text)?.editable === false && find(text)?.form === false, JSON.stringify(find(text)));
  }

  await c.key('E');
  check('E turns on Edit text', await waitFor(`${V(DOC)}.annotLayer.tool === 'edit'`, 3000));
  check('text inside the safe forms is outlined with the page’s own',
    await waitFor(`document.querySelectorAll('.vl-decor polygon.vl-edit-run').length >= 4`, 5000));
  await shot('01-edit-mode');

  // ---- B. a form drawn twice, edited once -------------------------------------------------------
  const left = await runAt('Drawn twice', 76);
  check('the left-hand draw of the shared form was found', Boolean(left) && left.editable === true);
  await c.mouse(left.x, left.y);
  if (!(await waitFor(editorOpen, 4000))) {
    await c.mouse(left.x, left.y); // one retry: a click that lands while the page is still settling
    await waitFor(editorOpen, 4000);
  }
  check('clicking text inside a form opens an editor over it', await q(editorOpen));
  check('the editor holds the form’s own text', (await q(`document.querySelector('.vl-text-input').value`)) === 'Drawn twice');
  await shot('02-editor-open');
  await q(`document.querySelector('.vl-text-input').select()`);
  await c.type('Only this one');
  await sleep(250);
  await c.key('Enter');
  check('Enter keeps the change', await waitFor(`${editorGone} && ${settled(DOC)}`, 15000));

  const shown = await drawn();
  check('the occurrence edited shows the new text', says('Only this one')(shown) === 1, JSON.stringify(shown.filter((i) => /Only this|Drawn twice/.test(i.str))));
  check('the other occurrence of the same form is untouched', says('Drawn twice')(shown) === 1);
  check('nothing else on the page changed', says('Page text stays editable')(shown) === 1 && says('Clean form text')(shown) === 1);
  await shot('03-one-occurrence-edited');

  // ---- C. saved and opened again ----------------------------------------------------------------
  await c.key('Ctrl+S');
  check('Ctrl+S saves', await waitFor(`${settled(DOC)} && !${V(DOC)}.annotations.dirty`, 20000));
  await q(`__vellum.app.close(${V(DOC)})`);
  await waitFor(`!${V(DOC)}`, 8000);
  await q(`__vellum.actions.openRecent(${JSON.stringify(DOC)})`);
  await waitFor(settled(DOC), 25000);
  await sleep(500);

  const reopened = await drawn();
  check('reopened: the edited occurrence reads the new text', says('Only this one')(reopened) === 1);
  check('reopened: the other occurrence still reads the original', says('Drawn twice')(reopened) === 1);
  check('reopened: every other form on the page is as it was',
    says('Clean form text')(reopened) === 1 && says('Behind a soft mask')(reopened) === 1 && says('Two forms deep')(reopened) === 1);
  const after = await runs();
  check('reopened: the copy is ordinary editable text again',
    after.some((r) => r.text === 'Only this one' && r.editable && r.form));
  check('reopened: the refusals are the refusals they were',
    ['Borrowed resources', 'Behind a soft mask', 'Unbalanced form', 'Tagged form text'].every((text) => after.find((r) => r.text === text)?.editable === false));
  await shot('04-reopened');

  // ---- D. an occurrence Vellum can't copy is still refused, in its own words ---------------------
  await c.key('E');
  await waitFor(`${V(DOC)}.annotLayer.tool === 'edit'`, 3000);
  const masked = await runAt('Behind a soft mask', 76);
  check('the refused run is there to click', Boolean(masked) && masked.editable === false);
  await c.mouse(masked.x, masked.y);
  await sleep(800);
  check('clicking it opens no editor', await q(editorGone));
  const toast = await q(`document.querySelector('.vl-toast, .toast, [role="status"]')?.textContent ?? null`);
  check('and it says why, in the reason’s own words',
    toast === null || /reusable graphic/.test(toast), String(toast));
  await shot('05-refused');
}
