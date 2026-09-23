// Crop, page numbers and watermarks in the real app, the way a person does it: the command palette,
// the dialog (typed into, Enter to apply), Ctrl+Z / Ctrl+Y, then save, close and open again. The
// writer itself is proved in tests/editing/page-stamps.test.mjs.

import zlib from 'node:zlib';

export const files = { 'mixed-sizes': 'mixed-sizes' };

/** A 16 × 8 half-transparent red PNG, as the host's picture dialog would hand it over (base64). */
function redPng() {
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const out = Buffer.alloc(body.length + 8);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(zlib.crc32(body), body.length + 4);
    return out;
  };
  const [w, h] = [16, 8];
  const rows = Buffer.alloc((1 + w * 4) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) rows.set([220, 30, 30, 128], y * (1 + w * 4) + 1 + x * 4);
  const header = Buffer.alloc(13);
  header.writeUInt32BE(w, 0);
  header.writeUInt32BE(h, 4);
  header.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header), chunk('IDAT', zlib.deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]).toString('base64');
}

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

  area('picture watermark');
  // The Windows file dialog can't be driven from here: for one call, the bridge hands back a picture as the host would.
  const stubPicker = (data) => q(`(async () => {
    const { bridge } = await import(new URL('js/bridge.js', location.href).href);
    const request = bridge.request;
    bridge.request = (type, payload) => {
      if (type !== 'pictureDialog') return request.call(bridge, type, payload);
      bridge.request = request;
      return Promise.resolve({ file: { name: 'mark.png', data: ${JSON.stringify(data)} } });
    };
    return true;
  })()`);
  await q(`${V(DOC)}.goToPage(2)`);
  await sleep(300);
  await palette('Watermark');
  await q(`document.querySelector('.page-setting-dialog .seg-btn[data-mode="picture"]').click()`);
  await sleep(200);
  check('Picture mode asks for a picture before Apply', await q(`document.querySelector('.page-setting-dialog .btn.primary').disabled`));
  await stubPicker(Buffer.from('not a picture').toString('base64'));
  await q(`document.querySelector('.watermark-picture .btn').click()`);
  await sleep(500);
  check('a file that isn’t a PNG or JPEG is refused in the dialog', await q(`document.querySelector('.page-setting-dialog .btn.primary').disabled
    && /PNG or JPEG/.test(document.querySelector('.page-setting-dialog .dialog-note').textContent)`));
  await stubPicker(redPng());
  await q(`document.querySelector('.watermark-picture .btn').click()`);
  await waitFor(`!document.querySelector('.watermark-thumb')?.hidden && !document.querySelector('.page-setting-dialog .btn.primary').disabled`, 5000);
  check('the chosen picture is previewed', await q(`document.querySelector('.watermark-thumb').naturalWidth === 16`));
  await q(`document.querySelector('.page-setting-dialog input[name="page-scope"][value="selected"]').click()`);
  await fill('Width of page', 40);
  await fill('Rotation', 15);
  await shot('picture-watermark-dialog');
  await c.key('Enter');
  await rest();
  const marks = () => q(`JSON.stringify(${V(DOC)}.annotations.plan.map((e) => e.watermark?.picture ? ['picture', e.watermark.scale, e.watermark.rotation] : e.watermark?.text ?? null))`);
  check('page 2 now has the picture; the others keep the text', await marks() === JSON.stringify(['CONFIDENTIAL', ['picture', 40, 15], 'CONFIDENTIAL', 'CONFIDENTIAL']), await marks());
  const imagesOn = (n) => q(`(async () => { const ops = (await (await ${V(DOC)}.pdf.getPage(${n})).getOperatorList()).fnArray; return ops.filter((o) => o === 85 || o === 86).length; })()`);
  check('it is drawn as an image on page 2 only', (await imagesOn(2)) === 1 && (await imagesOn(3)) === 0 && !(await texts(2)).includes('CONFIDENTIAL'));
  await shot('picture-watermark');
  await q(`${V(DOC)}.focus()`);
  await c.key('Ctrl+Z');
  await rest();
  check('undo brings the text watermark back to page 2', (await texts(2)).includes('CONFIDENTIAL') && (await imagesOn(2)) === 0);
  await c.key('Ctrl+Y');
  await rest();
  check('redo puts the picture back', (await imagesOn(2)) === 1);
  await q(`${V(DOC)}.duplicatePages([${V(DOC)}.annotations.plan[1].id])`);
  await rest();
  check('a duplicated page takes the picture along', (await imagesOn(3)) === 1 && JSON.parse(await marks()).length === 5);
  await c.key('Ctrl+Z');
  await rest();

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
  check('the picture watermark is in the file, on page 2 only', (await imagesOn(2)) === 1 && (await imagesOn(3)) === 0);
  check('no page errors were collected', (await q('__vellum.errors.length')) === 0, await q('JSON.stringify(__vellum.errors.slice(0, 3))'));

  // 0.24: roman numerals, and a count that begins again on the pages chosen. Last, so the checks above
  // stay on the numbering they were written for.
  area('numerals and where the count begins');
  const pick = async (label, value) => {
    await q(`(() => { const el = document.querySelector('.page-setting-dialog [aria-label="${label}"]');
      el.value = ${JSON.stringify(value)}; el.dispatchEvent(new Event('input', { bubbles: true })); return el.value; })()`);
    await sleep(250);
  };
  await palette('Page numbers');
  await pick('Numerals', 'roman');
  await pick('Count from', 'here');
  check('the dialog says how the pages will read', /The first page reads “Page i of iv”, the next “Page ii of iv”\./
    .test(await q(`document.querySelector('.page-setting-dialog .dialog-note').textContent`)),
  await q(`document.querySelector('.page-setting-dialog .dialog-note').textContent`));
  await shot('page-numbers-roman-dialog');
  await c.key('Enter');
  await rest();
  check('the setting is on every page', await q(`${V(DOC)}.annotations.plan.every((e) => e.pageNumber?.style === 'roman' && e.pageNumber.restart === true)`));
  // The arabic numbers were saved into the file in the area above, and a saved stamp is ordinary page
  // content from then on — so numbering again writes beside it rather than over it. That is Vellum's
  // documented behaviour for any stamp, not something numerals change; the pages here carry both.
  check('the pages read in roman numerals', (await texts(1)).includes('Page i of iv') && (await texts(4)).includes('Page iv of iv'),
    JSON.stringify(await texts(4)));
  check('the number saved earlier is still there too, as page content', (await texts(4)).includes('Page 4 of 4'),
    JSON.stringify(await texts(4)));
  await q(`${V(DOC)}.focus()`);
  await c.key('Ctrl+Z');
  await rest();
  check('undo brings the arabic numbers back', (await texts(1)).includes('Page 1 of 4'), JSON.stringify(await texts(1)));
  await c.key('Ctrl+Y');
  await rest();

  await q('__vellum.actions.save()');
  check('saved again', await waitFor(`!${V(DOC)}.annotations.dirty`, 25000));
  await q(`__vellum.app.close(${V(DOC)})`);
  await waitFor(`!${V(DOC)}`);
  await q(`__vellum.actions.openRecent(${JSON.stringify(DOC)})`);
  await rest();
  const romanPage = await texts(2);
  check('the roman numerals are in the file, once each', romanPage.filter((s) => s === 'Page ii of iv').length === 1, JSON.stringify(romanPage));
  check('and the stamp written before them was not doubled either', romanPage.filter((s) => s === 'Page 2 of 4').length === 1, JSON.stringify(romanPage));
  check('still no page errors', (await q('__vellum.errors.length')) === 0, await q('JSON.stringify(__vellum.errors.slice(0, 3))'));

  // 0.25: the crop drawn as a rectangle on the page itself, and applied to the even pages.
  area('the crop rectangle');
  const beforeCrop = await Promise.all([1, 2, 3, 4].map((n) => view(n)));
  await q(`${V(DOC)}.goToPage(1)`);
  await sleep(300);
  await palette('Crop pages');
  check('the dialog shows the page it will be drawn on', await q(`Boolean(document.querySelector('.page-setting-dialog .crop-frame canvas'))`));
  const frame = JSON.parse(await q(`JSON.stringify(document.querySelector('.crop-frame').getBoundingClientRect())`));
  // Drag out a rectangle over the middle of the page: a quarter in on every side.
  const at = (fx, fy) => [Math.round(frame.left + frame.width * fx), Math.round(frame.top + frame.height * fy)];
  await c.drag(at(0.25, 0.25), at(0.75, 0.75));
  await sleep(350);
  const typed = JSON.parse(await q(`JSON.stringify(['Top', 'Right', 'Bottom', 'Left']
    .map((l) => Number(document.querySelector('.page-setting-dialog [aria-label="' + l + '"]').value)))`));
  check('the margins beside it follow the rectangle', typed.every((mm) => mm > 5), JSON.stringify(typed));
  check('and the dialog says what would be kept', /^Keeps [\d.]+ × [\d.]+ mm of/
    .test(await q(`document.querySelector('.page-setting-dialog .dialog-note').textContent`)),
  await q(`document.querySelector('.page-setting-dialog .dialog-note').textContent`));
  await shot('crop-rectangle-dialog');
  await q(`(() => { const el = [...document.querySelectorAll('.page-setting-dialog input[name="page-scope"]')]
    .find((i) => i.value === 'even'); el.click(); return el.value; })()`);
  await sleep(250);
  await c.key('Enter');
  await rest();
  const afterCrop = await Promise.all([1, 2, 3, 4].map((n) => view(n)));
  const smaller = (a, b) => b[2] - b[0] < a[2] - a[0] && b[3] - b[1] < a[3] - a[1];
  check('the even pages are cropped', smaller(beforeCrop[1], afterCrop[1]) && smaller(beforeCrop[3], afterCrop[3]),
    JSON.stringify(afterCrop));
  check('and the odd pages are not', JSON.stringify([afterCrop[0], afterCrop[2]]) === JSON.stringify([beforeCrop[0], beforeCrop[2]]),
    JSON.stringify([afterCrop[0], afterCrop[2]]));
  const inside = (a, b) => b[0] >= a[0] && b[1] >= a[1] && b[2] <= a[2] && b[3] <= a[3];
  check('each crop box sits inside its own page', inside(beforeCrop[1], afterCrop[1]) && inside(beforeCrop[3], afterCrop[3]));
  // The four margins the dialog showed, in points, on a page shown upright and on one shown turned.
  const trimmed = (i) => [afterCrop[i][0] - beforeCrop[i][0], afterCrop[i][1] - beforeCrop[i][1],
    beforeCrop[i][2] - afterCrop[i][2], beforeCrop[i][3] - afterCrop[i][3]].map((v) => Math.round(v * 10) / 10);
  const mm = (n) => Math.round((n * 72 / 25.4) * 10) / 10;
  check('an upright page is trimmed by the margins the dialog showed',
    JSON.stringify(trimmed(1)) === JSON.stringify([mm(typed[3]), mm(typed[2]), mm(typed[1]), mm(typed[0])]), JSON.stringify(trimmed(1)));
  // Page 4 is shown turned, so what a person calls the top is trimmed off the page's own left.
  check('a turned page is trimmed on the sides it is shown with',
    JSON.stringify(trimmed(3)) === JSON.stringify([mm(typed[0]), mm(typed[3]), mm(typed[2]), mm(typed[1])]), JSON.stringify(trimmed(3)));
  await q(`${V(DOC)}.focus()`);
  await c.key('Ctrl+Z');
  await rest();
  check('undo takes the rectangle’s crop away', JSON.stringify(await Promise.all([1, 2, 3, 4].map((n) => view(n)))) === JSON.stringify(beforeCrop));
  check('no page errors from the crop rectangle', (await q('__vellum.errors.length')) === 0, await q('JSON.stringify(__vellum.errors.slice(0, 3))'));
}
