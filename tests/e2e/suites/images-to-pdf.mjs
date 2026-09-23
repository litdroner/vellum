// Images to PDF V1 in the real app: the command palette opens the picture list with no document of
// its own, the list shows every chosen picture with its pixels and format in the order it was picked,
// the order can be changed, a file that isn't a picture is refused by name before it reaches the list,
// and saving writes a real PDF with one page per picture. The geometry of those pages — their size,
// the placement, the image bytes — is proved over the bytes in tests/editing/images-to-pdf.test.mjs.
//
// The Windows file dialogs can't be driven from here, so for one call each the bridge hands back what
// the host would: pictures drawn in the page itself as PNGs, and a save target the host really
// described (openPath, for a file of this run's own that the app has closed first).

import fs from 'node:fs';
import { openWithPdfjs } from '../../editing/harness.mjs';

export const files = { doc: 'simple', target: 'multipage' };

export async function run(t) {
  const { c, q, check, sleep, shot, V, settled, waitFor, area } = t;
  const DOC = t.file('doc');
  const TARGET = t.file('target');

  /** Hands back pictures the page draws itself, plus one file that isn't a picture at all. */
  const stubPictureDialog = (pictures) => q(`(async () => {
    const { bridge } = await import(new URL('js/bridge.js', location.href).href);
    const request = bridge.request;
    const png = (w, h, colour) => {
      const canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = colour; ctx.fillRect(0, 0, w, h);
      return canvas.toDataURL('image/png').split(',')[1];
    };
    bridge.request = (type, payload) => {
      if (type !== 'pictureDialog') return request.call(bridge, type, payload);
      bridge.request = request;
      const files = ${JSON.stringify(pictures)}.map(([name, w, h, colour]) => (w
        ? { name, path: 'C:\\\\pictures\\\\' + name, data: png(w, h, colour) }
        : { name, path: 'C:\\\\pictures\\\\' + name, data: btoa('not a picture at all') }));
      return Promise.resolve({ file: files[0], files });
    };
    return true;
  })()`);

  const openImagesDialog = async (pictures) => {
    await stubPictureDialog(pictures);
    await q(`${V(DOC)}.focus()`);
    await c.key('Ctrl+K');
    await waitFor(`document.activeElement?.closest?.('.palette')`, 3000);
    await c.type('Images to PDF');
    await sleep(300);
    await c.key('Enter');
    await waitFor(`document.querySelector('.images-dialog')`, 8000);
    await sleep(300);
  };

  const rows = () => q(`JSON.stringify([...document.querySelectorAll('.images-dialog .merge-item')].map((el) => [
    el.querySelector('.merge-order').textContent, el.querySelector('.merge-name').textContent, el.querySelector('.merge-pages').textContent]))`);
  const clickRow = async (i, label) => {
    await q(`document.querySelectorAll('.images-dialog .merge-item')[${i}].querySelector('[aria-label="${label}"]').click()`);
    await sleep(250);
  };

  await waitFor(settled(DOC), 25000);
  await waitFor(settled(TARGET), 25000);
  await q(`__vellum.app.activate(${V(DOC)})`);
  await sleep(400);

  area('the picture list');
  await openImagesDialog([['wide.png', 400, 200, '#c33'], ['tall.png', 200, 400, '#36c'], ['notes.txt', 0, 0, '']]);
  check('the Images to PDF dialog opens from the command palette', await q(`Boolean(document.querySelector('.images-dialog'))`));
  check('every picture is listed in order with its pixels and format, and the file that isn’t a picture is left out',
    await rows() === JSON.stringify([['1', 'wide.png', '400 × 200 PNG'], ['2', 'tall.png', '200 × 400 PNG']]), await rows());
  check('the file that isn’t a picture was refused by name',
    await q(`[...document.querySelectorAll('.toast')].some((el) => el.textContent.includes('notes.txt'))`));
  check('the page size can be chosen, the image’s own size first',
    await q(`(() => { const s = document.querySelector('.images-dialog select'); return s && s.value === 'image' && s.options.length === 3; })()`));
  await shot('images-dialog');

  area('ordering');
  await clickRow(1, 'Move up');
  check('moving a picture up reorders the list',
    await rows() === JSON.stringify([['1', 'tall.png', '200 × 400 PNG'], ['2', 'wide.png', '400 × 200 PNG']]), await rows());
  await clickRow(0, 'Move down');
  check('moving it back restores the order it was picked in',
    await rows() === JSON.stringify([['1', 'wide.png', '400 × 200 PNG'], ['2', 'tall.png', '200 × 400 PNG']]), await rows());

  area('the PDF written');
  // The target is closed first, so the file the app writes over is not one it is showing.
  await q(`__vellum.app.close(${V(TARGET)})`);
  await sleep(600);
  await q(`(async () => {
    const { bridge } = await import(new URL('js/bridge.js', location.href).href);
    const request = bridge.request;
    const { file } = await request.call(bridge, 'openPath', { path: ${JSON.stringify(TARGET)} });
    bridge.request = (type, payload) => {
      if (type !== 'saveAsDialog') return request.call(bridge, type, payload);
      bridge.request = request;
      return Promise.resolve({ file });
    };
    return true;
  })()`);
  await q(`[...document.querySelectorAll('.images-dialog .dialog-actions button')].find((b) => b.textContent === 'Save as…').click()`);
  check('the pictures were written into the PDF', await waitFor(
    `[...document.querySelectorAll('.toast')].some((el) => el.textContent.includes('2 pictures'))`, 20000));

  const bytes = new Uint8Array(fs.readFileSync(TARGET));
  const js = await openWithPdfjs(bytes);
  try {
    check('the file has one page per picture', js.doc.numPages === 2, String(js.doc.numPages));
    const boxes = [];
    for (let n = 1; n <= js.doc.numPages; n++) {
      const page = await js.doc.getPage(n);
      boxes.push([page.view[2], page.view[3]]);
    }
    check('each page is its picture’s own size at 96 DPI',
      JSON.stringify(boxes) === JSON.stringify([[300, 150], [150, 300]]), JSON.stringify(boxes));
  } finally {
    await js.close();
  }

  area('reopening');
  await q(`(async () => {
    const { bridge } = await import(new URL('js/bridge.js', location.href).href);
    const { file } = await bridge.request('openPath', { path: ${JSON.stringify(TARGET)} });
    await __vellum.app.open(file);
    return true;
  })()`);
  check('Vellum reopens the PDF it wrote', await waitFor(settled(TARGET), 20000));
  check('and shows its two pages', await q(`${V(TARGET)}.annotations.plan.length`) === 2);
  check('nothing went wrong along the way', (await q(`JSON.stringify(__vellum.errors)`)) === '[]', await q(`JSON.stringify(__vellum.errors)`));
}
