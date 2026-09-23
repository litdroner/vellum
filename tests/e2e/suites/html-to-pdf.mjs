// HTML to PDF V1 in the real app, across the WPF/WebView2 boundary: the command palette opens the
// dialog, the host renders a local HTML file in a hidden WebView2 and prints it to a PDF, and the
// result is a real PDF whose text is still text, whose local picture is drawn, whose links are links,
// and whose page is the size that was asked for. The HTML file is left exactly as it was, what the
// page asks for from the internet is refused rather than fetched, and a request the host won't take
// comes back to the page as an error.
//
// This suite is named, never run by default: it fills in the real Open and Save dialogs through UI
// Automation (tests/e2e/native-dialog.mjs), which is bounded and stops the suite if a dialog cannot
// be filled in, so a run can never sit waiting on one.
//   node tests/e2e/run.mjs html-to-pdf

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { openWithPdfjs } from '../../editing/harness.mjs';
import { fillFileDialog, closeFileDialogs } from '../native-dialog.mjs';

export const files = { doc: 'simple' };

/** A solid RGB PNG of `width` × `height` pixels. */
function png(width, height) {
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const out = Buffer.alloc(body.length + 8);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(zlib.crc32(body), body.length + 4);
    return out;
  };
  const rows = Buffer.alloc((1 + width * 3) * height, 40);
  for (let y = 0; y < height; y++) rows[y * (1 + width * 3)] = 0;
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header), chunk('IDAT', zlib.deflateSync(rows)), chunk('IEND', Buffer.alloc(0)),
  ]);
}

const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>A local page</title>
<style>
  body { margin: 0; font-family: Georgia, serif; color: #202020; }
  h1 { font-size: 32px; margin: 0 0 12px; }
  .row { display: flex; gap: 16px; align-items: flex-start; }
  .box { width: 120px; height: 60px; background: #d8e4f0; }
</style></head>
<body>
  <h1>Vellum renders this locally</h1>
  <p id="body-text">The quick brown fox jumps over the lazy dog.</p>
  <div class="row"><div class="box"></div><img src="picture.png" width="120" height="60" alt=""></div>
  <p><a href="https://example.com/handbook">The handbook</a></p>
  <img src="https://example.invalid/tracker.png" width="1" height="1" alt="">
</body></html>
`;

export async function run(t) {
  const { c, q, check, sleep, shot, V, settled, waitFor, area } = t;
  const DOC = t.file('doc');
  const SOURCE = path.join(t.dir, 'page.html');
  const TARGET = path.join(t.dir, 'page.pdf');
  fs.writeFileSync(SOURCE, PAGE);
  fs.writeFileSync(path.join(t.dir, 'picture.png'), png(60, 30));
  const sourceHash = crypto.createHash('sha256').update(fs.readFileSync(SOURCE)).digest('hex');

  await waitFor(settled(DOC), 25000);
  await q(`__vellum.app.activate(${V(DOC)})`);
  await sleep(400);

  area('the dialog');
  await c.key('Ctrl+K');
  await waitFor(`document.activeElement?.closest?.('.palette')`, 3000);
  await c.type('HTML to PDF');
  await sleep(300);
  await c.key('Enter');
  check('the HTML to PDF dialog opens from the command palette', await waitFor(`document.querySelector('.html-pdf-dialog')`, 8000));
  await sleep(300);
  check('a page size can be chosen, A4 first',
    await q(`(() => { const s = document.querySelector('.html-pdf-dialog select'); return s && s.value === 'a4' && s.options.length === 2; })()`));
  check('the dialog says the page is rendered offline',
    await q(`document.querySelector('.html-pdf-dialog .dialog-message').textContent.includes('refused')`));
  await shot('html-pdf-dialog');

  area('the PDF written');
  // The real Open and Save dialogs, filled in from outside the app (native-dialog.mjs): UI Automation
  // patterns rather than keystrokes, a hard timeout on each, one retry at most, and no next step if
  // either of them can't be filled — a failure here closes them again and stops the suite rather than
  // leaving Vellum sitting on a modal dialog nothing can answer.
  const TITLES = ['Choose an HTML file', 'Save the PDF as'];
  await q(`[...document.querySelectorAll('.html-pdf-dialog .dialog-actions button')].find((b) => b.textContent === 'Choose file…').click()`);
  try {
    if (!(await fillFileDialog(t, { title: TITLES[0], text: SOURCE, titles: TITLES }))) throw new Error('the Open dialog could not be filled in');
    if (!(await fillFileDialog(t, { title: TITLES[1], text: TARGET, titles: TITLES }))) throw new Error('the Save dialog could not be filled in');
  } catch (err) {
    closeFileDialogs(TITLES);
    throw err;
  }

  // Either the toast that says it was made, or the dialog that says why it wasn't: waiting for only
  // the first would sit out the whole timeout on every failure.
  const made = `[...document.querySelectorAll('.toast')].some((el) => el.textContent.includes('page.pdf'))`;
  const refusedIt = `[...document.querySelectorAll('.dialog-title')].some((el) => el.textContent.includes('Couldn’t make the PDF'))`;
  await waitFor(`${made} || ${refusedIt}`, 40000);
  check('Vellum says it made the PDF', await q(made),
    await q(`[...document.querySelectorAll('.dialog-message')].map((el) => el.textContent).join(' ')`));
  check('the HTML file was left exactly as it was',
    crypto.createHash('sha256').update(fs.readFileSync(SOURCE)).digest('hex') === sourceHash);
  check('nothing was left behind beside the PDF', !fs.existsSync(`${TARGET}.part`));
  if (!fs.existsSync(TARGET)) throw new Error('no PDF was written, so there is nothing to read back');

  const js = await openWithPdfjs(new Uint8Array(fs.readFileSync(TARGET)));
  try {
    check('it reopens as a valid PDF', js.doc.numPages >= 1, String(js.doc.numPages));
    const page = await js.doc.getPage(1);
    const [, , width, height] = page.view;
    check('the page is the A4 that was asked for', Math.abs(width - 595) < 3 && Math.abs(height - 842) < 3, `${width} × ${height}`);

    const text = (await page.getTextContent()).items.map((i) => i.str).join(' ').replace(/\s+/g, ' ');
    check('the text is still text, not a picture of one', text.includes('Vellum renders this locally') && text.includes('lazy dog'), text.slice(0, 160));

    const ops = await page.getOperatorList();
    const paints = ops.fnArray.filter((fn) => fn === js.pdfjs.OPS.paintImageXObject).length;
    check('the local picture was drawn', paints > 0, String(paints));

    const links = (await page.getAnnotations()).filter((a) => a.subtype === 'Link' && a.url);
    check('the link is a real link in the PDF', links.some((a) => a.url.includes('example.com/handbook')),
      JSON.stringify(links.map((a) => a.url)));
  } finally {
    await js.close();
  }

  area('what is refused');
  const refused = await q(`(async () => {
    const { bridge } = await import(new URL('js/bridge.js', location.href).href);
    try { await bridge.request('html.toPdf', { size: 'a3' }); return 'no error'; } catch (err) { return err.message; }
  })()`);
  check('a request the host won’t take comes back to the page as an error', /page size/i.test(refused), refused);
  check('nothing went wrong along the way', (await q(`JSON.stringify(__vellum.errors)`)) === '[]', await q(`JSON.stringify(__vellum.errors)`));
}
