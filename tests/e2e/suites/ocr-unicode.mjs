// Russian OCR in the real app (OCR Unicode V1): the Russian pack is downloaded and verified, a scanned
// Russian page is read by the same Tesseract engine, and its Cyrillic words become an invisible text layer
// in an embedded Noto Sans subset (editing/objects/ocr-text.js, UNICODE_FONTS). The words can be found,
// and they are still there, as Cyrillic, once the file is saved and opened again.
//
// The pack comes from a loopback source (VELLUM_OCR_LANGUAGE_SOURCE): the real pack, fetched once from the
// pinned source in languages.json and checked against its size. Only when named:
//   node tests/e2e/run.mjs ocr-unicode

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const files = { scan: 'scanned' };

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'src', 'Vellum', 'web', 'js', 'ocr', 'languages.json'), 'utf8'));
const LINES = ['Съешь же ещё этих', 'мягких французских булок', 'Счёт номер 4821'];
let server = null;

export async function prepare() {
  const russian = manifest.packs.find((p) => p.code === 'rus');
  const response = await fetch(`${manifest.source}rus.traineddata.gz`);
  if (!response.ok) throw new Error(`couldn’t fetch the Russian pack for the test (${response.status})`);
  const rus = Buffer.from(await response.arrayBuffer());
  if (rus.length !== russian.size) throw new Error('the fetched Russian pack has the wrong size');
  server = http.createServer((req, res) => {
    if (req.url !== '/rus.traineddata.gz') return res.writeHead(404).end();
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': rus.length });
    res.end(rus);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { env: { VELLUM_OCR_LANGUAGE_SOURCE: `http://127.0.0.1:${server.address().port}/` } };
}

export function cleanup() {
  server?.close();
}

export async function run(t) {
  const { q, check, sleep, shot, V, settled, waitFor, area } = t;
  const DOC = t.file('scan');
  const row = (code) => `document.querySelector('.settings-dialog .ocr-lang[data-code="${code}"]')`;
  const textOf = (n) => q(`(async () => (await (await ${V(DOC)}.pdf.getPage(${n})).getTextContent()).items.map((i) => i.str).join(' ').replace(/\\s+/g, ' '))()`);
  const rest = async (ms = 30000) => { await waitFor(settled(DOC), ms); await sleep(500); };
  const cyrillic = (text) => /Съешь/.test(text) && /французских/.test(text) && /ещё/.test(text) && /4821/.test(text);

  area('download Russian');
  await rest();
  await q(`__vellum.actions.settings('ocr')`);
  check('Russian is offered', await waitFor(`${row('rus')}?.dataset.state === 'available'`, 10000));
  await q(`(${row('rus')}.querySelector('[data-act="download"]').click(), true)`);
  check('Russian installs once verified', await waitFor(`${row('rus')}?.dataset.state === 'installed'`, 60000));
  await q(`(async () => { const { bridge } = await import('/js/bridge.js'); await bridge.request('ocr.select', { code: 'rus' }); })()`);
  await q(`document.querySelector('.settings-dialog .settings-close').click()`);
  await waitFor(`!document.querySelector('.settings-dialog')`, 5000);

  area('Russian OCR');
  const made = await q(`(async () => {
    const v = ${V(DOC)};
    const lib = await import('/vendor/pdf-lib/pdf-lib.esm.min.js');
    const canvas = Object.assign(document.createElement('canvas'), { width: 1700, height: 2200 });
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, 1700, 2200);
    ctx.fillStyle = '#111'; ctx.font = '72px Georgia, serif';
    ${JSON.stringify(LINES)}.forEach((line, i) => ctx.fillText(line, 160, 320 + i * 150));
    const png = new Uint8Array(await (await new Promise((r) => canvas.toBlob(r, 'image/png'))).arrayBuffer());
    const doc = await lib.PDFDocument.create();
    doc.addPage([612, 792]).drawImage(await doc.embedPng(png), { x: 0, y: 0, width: 612, height: 792 });
    await v.writeFile(v.file, await doc.save());
    await __vellum.app.close(v);
    return true;
  })()`);
  check('the scanned Russian test document was written', made === true);
  await waitFor(`!${V(DOC)}`);
  await q(`__vellum.actions.openRecent(${JSON.stringify(DOC)})`);
  await rest();
  await q(`(__vellum.actions.ocr.run(${V(DOC)}, 'page'), true)`);
  check('the OCR dialog names Russian', await waitFor(`/in Russian/.test(document.querySelector('.ocr-dialog')?.textContent ?? '')`, 10000));
  check('OCR finished', await waitFor(`${V(DOC)}.annotations.edits.filter((e) => e.kind === 'ocr').length === 1`, 120000));
  await rest();
  const read = await textOf(1);
  check('the Cyrillic words are in the searchable text layer', cyrillic(read), read);
  await q('__vellum.ui.findbar.open("французских")');
  check('Find locates a Cyrillic word', await waitFor(`${V(DOC)}.find.total >= 1`, 10000), await q(`JSON.stringify(${V(DOC)}.find)`));
  await q('__vellum.ui.findbar.close()');
  await shot('ocr-unicode');

  area('save and reopen');
  await q('__vellum.actions.save()');
  check('saved', await waitFor(`!${V(DOC)}.annotations.dirty`, 30000));
  const raw = fs.readFileSync(DOC).toString('latin1');
  check('the saved file embeds a Noto Sans subset', /NotoSans/.test(raw) && /\/FontFile2/.test(raw));
  await q(`__vellum.app.close(${V(DOC)})`);
  await waitFor(`!${V(DOC)}`);
  await q(`__vellum.actions.openRecent(${JSON.stringify(DOC)})`);
  await rest();
  const reopened = await textOf(1);
  check('the Cyrillic text layer is in the saved file', cyrillic(reopened), reopened);
  check('no page errors were collected', (await q('__vellum.errors.length')) === 0, await q('JSON.stringify(__vellum.errors.slice(0, 3))'));
}
