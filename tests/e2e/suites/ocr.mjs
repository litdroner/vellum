// OCR v1 in the real app: a scanned page (a picture of text and nothing else) is read by the bundled
// Tesseract engine and gets an invisible text layer. The text can then be found and selected, the page
// looks exactly as it did, and the layer survives saving and opening the file again. A page that
// already has text is left alone.
//
// The scan is made here, in the app: text drawn on a canvas, put on a page as a picture with pdf-lib,
// and written over this suite's own copy of a fixture. Only when named: node tests/e2e/run.mjs ocr

export const files = { scan: 'scanned' };
// OCR of a page may take up to two minutes.
export const timeoutMs = 300000;

const LINES = ['Vellum reads scanned pages', 'Invoice number 4821', 'Searchable text stays invisible'];

export async function run(t) {
  const { q, check, sleep, shot, V, settled, waitFor, area } = t;
  const DOC = t.file('scan');
  const rest = async (ms = 30000) => {
    await waitFor(settled(DOC), ms);
    await sleep(500);
  };
  /** Page n's words as pdf.js reads them. */
  const textOf = (n) => q(`(async () => (await (await ${V(DOC)}.pdf.getPage(${n})).getTextContent()).items.map((i) => i.str).join(' '))()`);
  /** Page 1 rendered: a short fingerprint of its pixels, to prove the page still looks the same. */
  const pixels = () => q(`(async () => {
    const page = await ${V(DOC)}.pdf.getPage(1);
    const viewport = page.getViewport({ scale: 1 });
    const canvas = Object.assign(document.createElement('canvas'), { width: Math.ceil(viewport.width), height: Math.ceil(viewport.height) });
    await page.render({ canvas, canvasContext: canvas.getContext('2d'), viewport }).promise;
    const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
    const out = [];
    for (let i = 0; i < data.length; i += 4 * 97) out.push(data[i]);
    return out;
  })()`);
  const same = (a, b) => a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) <= 2);

  area('a scanned document');
  await rest();
  const made = await q(`(async () => {
    const v = ${V(DOC)};
    const lib = await import('/vendor/pdf-lib/pdf-lib.esm.min.js');
    const canvas = Object.assign(document.createElement('canvas'), { width: 1700, height: 2200 });
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, 1700, 2200);
    ctx.fillStyle = '#111'; ctx.font = '64px Georgia, serif';
    ${JSON.stringify(LINES)}.forEach((line, i) => ctx.fillText(line, 160, 320 + i * 140));
    const png = new Uint8Array(await (await new Promise((r) => canvas.toBlob(r, 'image/png'))).arrayBuffer());
    const doc = await lib.PDFDocument.create();
    const image = await doc.embedPng(png);
    doc.addPage([612, 792]).drawImage(image, { x: 0, y: 0, width: 612, height: 792 });
    const second = doc.addPage([612, 792]);
    second.drawImage(image, { x: 0, y: 0, width: 612, height: 792 });
    second.drawText('This page already has searchable text', { x: 72, y: 72, size: 12 });
    await v.writeFile(v.file, await doc.save());
    await __vellum.app.close(v);
    return true;
  })()`);
  check('the scanned test document was written', made === true);
  await waitFor(`!${V(DOC)}`);
  await q(`__vellum.actions.openRecent(${JSON.stringify(DOC)})`);
  await rest();
  check('page 1 has no text layer to begin with', (await textOf(1)).trim() === '', await textOf(1));
  const before = await pixels();

  area('OCR');
  await q(`(__vellum.actions.ocr.run(${V(DOC)}, 'document'), true)`);
  check('progress is shown while the pages are read', await waitFor(`Boolean(document.querySelector('.ocr-dialog .progress-fill'))`, 5000));
  check('OCR finished with one page of recognised text', await waitFor(`${V(DOC)}.annotations.edits.filter((e) => e.kind === 'ocr').length === 1`, 120000),
    await q(`JSON.stringify(${V(DOC)}.annotations.edits.map((e) => e.kind))`));
  await rest();
  check('the dialog closed', await waitFor(`!document.querySelector('.ocr-dialog')`, 5000));
  const read = await textOf(1);
  check('OCR produced the page’s text', /Vellum/i.test(read) && /4821/.test(read) && /invisible/i.test(read), read);
  check('the page that already had text was left alone', (await textOf(2)).trim() === 'This page already has searchable text', await textOf(2));
  check('the page looks exactly as it did', same(before, await pixels()));

  area('search and select');
  await q('__vellum.ui.findbar.open("4821")');
  check('Find locates a recognised word', await waitFor(`${V(DOC)}.find.total >= 1`, 10000), await q(`JSON.stringify(${V(DOC)}.find)`));
  await q('__vellum.ui.findbar.close()');
  await sleep(300);
  check('the words are in the selectable text layer', await waitFor(`[...(${V(DOC)}.viewer.getPageView(0).div.querySelectorAll('.textLayer span'))].some((s) => /Invoice/.test(s.textContent))`, 10000));
  await q(`${V(DOC)}.selectAllText()`);
  check('selecting copies the recognised text', /Invoice number 4821/i.test(await q(`${V(DOC)}.getSelectedText().replace(/\\s+/g, ' ')`)),
    await q(`${V(DOC)}.getSelectedText().slice(0, 200)`));
  await shot('ocr');

  area('save and reopen');
  await q('__vellum.actions.save()');
  check('saved', await waitFor(`!${V(DOC)}.annotations.dirty`, 30000));
  await q(`__vellum.app.close(${V(DOC)})`);
  await waitFor(`!${V(DOC)}`);
  await q(`__vellum.actions.openRecent(${JSON.stringify(DOC)})`);
  await rest();
  const reopened = await textOf(1);
  check('the text layer is in the saved file', /Vellum/i.test(reopened) && /4821/.test(reopened), reopened);
  check('the reopened page still looks exactly as it did', same(before, await pixels()));
  check('no page errors were collected', (await q('__vellum.errors.length')) === 0, await q('JSON.stringify(__vellum.errors.slice(0, 3))'));
}
