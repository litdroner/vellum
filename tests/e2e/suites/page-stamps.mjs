// Crop, page numbers and watermarks in the real app, the way a person does it: the command palette,
// the dialog (typed into, Enter to apply), Ctrl+Z / Ctrl+Y, then save, close and open again. The
// writer itself is proved in tests/editing/page-stamps.test.mjs.

export const files = { 'mixed-sizes': 'mixed-sizes' };

export async function run(t) {
  const { c, q, check, sleep, shot, V, settled, waitFor, area } = t;
  const DOC = t.file('mixed-sizes');

  const rest = async (ms = 25000) => {
    await waitFor(settled(DOC), ms);
    await sleep(400);
  };
  const palette = async (label) => {
    await q(`${V(DOC)}.focus()`);
    await c.key('Ctrl+K');
    await waitFor(`document.activeElement?.closest?.('.palette')`, 3000);
    await c.type(label);
    await sleep(300);
    await c.key('Enter');
    await waitFor(`document.querySelector('.page-setting-dialog')`, 3000);
    await sleep(300);
  };
  /** Replaces the value of the dialog field named `label` by typing. */
  const fill = async (label, value) => {
    await q(`document.querySelector('.page-setting-dialog [aria-label="${label}"]').focus()`);
    await c.key('Ctrl+A');
    await c.type(String(value));
    await sleep(250);
  };
  const texts = (n) => q(`(async () => (await (await ${V(DOC)}.pdf.getPage(${n})).getTextContent()).items.map((i) => i.str).filter((s) => s.trim()))()`);
  const view = (n) => q(`(async () => (await ${V(DOC)}.pdf.getPage(${n})).view)()`);

  await q(`__vellum.app.activate(${V(DOC)})`);
  await rest();
  const pageOneView = await view(1);

  area('watermark');
  await palette('Watermark');
  await fill('Text', 'Draft ₹');
  check('a character the standard font can’t write disables Apply', await q(`document.querySelector('.page-setting-dialog .btn.primary').disabled`)
    && /can’t be written/.test(await q(`document.querySelector('.page-setting-dialog .dialog-note').textContent`)));
  await fill('Text', 'CONFIDENTIAL');
  await fill('Opacity', 30);
  await c.key('Enter');
  await rest();
  check('every page has the watermark in its plan entry', await q(`${V(DOC)}.annotations.plan.every((e) => e.watermark?.text === 'CONFIDENTIAL' && e.watermark.opacity === 0.3)`));
  check('and on the page as text', (await texts(2)).includes('CONFIDENTIAL'), JSON.stringify(await texts(2)));

  area('page numbers');
  await palette('Page numbers');
  await fill('Size', 12);
  await c.key('Enter');
  await rest();
  check('pages are numbered as text', (await texts(1)).includes('Page 1 of 4') && (await texts(4)).includes('Page 4 of 4'));

  area('crop');
  await q(`${V(DOC)}.goToPage(1)`);
  await sleep(300);
  await palette('Crop pages');
  await fill('Top', 20);
  await c.key('Enter');
  await rest();
  const cropped = await view(1);
  check('page 1 is 20 mm shorter; the others are not', Math.abs((pageOneView[3] - pageOneView[1]) - (cropped[3] - cropped[1]) - 56.69) < 0.1
    && JSON.stringify(await q(`${V(DOC)}.annotations.plan.slice(1).map((e) => e.crop ?? null)`)) === '[null,null,null]', JSON.stringify(cropped));
  check('its text is still there', (await texts(1)).includes('Letter page'));
  await shot('page-stamps');

  area('undo and redo');
  await q(`${V(DOC)}.focus()`);
  await c.key('Ctrl+Z');
  await rest();
  check('undo takes the crop away', JSON.stringify(await view(1)) === JSON.stringify(pageOneView));
  await c.key('Ctrl+Y');
  await rest();
  check('redo crops again', JSON.stringify(await view(1)) === JSON.stringify(cropped));

  area('save and reopen');
  await q('__vellum.actions.save()');
  check('saved', await waitFor(`!${V(DOC)}.annotations.dirty`, 25000));
  await q(`__vellum.app.close(${V(DOC)})`);
  await waitFor(`!${V(DOC)}`);
  await q(`__vellum.actions.openRecent(${JSON.stringify(DOC)})`);
  await rest();
  check('the crop is in the file', JSON.stringify(await view(1)) === JSON.stringify(cropped), JSON.stringify(await view(1)));
  const reopened = await texts(3);
  check('numbers and watermark are in the file, once each', reopened.filter((s) => s === 'Page 3 of 4').length === 1 && reopened.filter((s) => s === 'CONFIDENTIAL').length === 1, JSON.stringify(reopened));
  check('the rotated page kept its text', (await texts(4)).includes('Rotated page'));
  check('no page errors were collected', (await q('__vellum.errors.length')) === 0, await q('JSON.stringify(__vellum.errors.slice(0, 3))'));
}
