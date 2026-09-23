// OCR language packs in the real app: Settings → OCR lists English as built in and the packs as available;
// a pack whose download doesn't match its checksum is thrown away; German is downloaded, used, and reads
// a scanned German page (ß, ü, ö survive in the text layer); a chosen pack that is missing is explained
// before OCR starts; English still works; and a pack can be removed again.
//
// The packs come from a loopback source (VELLUM_OCR_LANGUAGE_SOURCE): German is the real pack, fetched
// once from the pinned source in languages.json; French is served damaged. Only when named:
//   node tests/e2e/run.mjs ocr-languages

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const files = { scan: 'scanned' };
// A language installs (up to a minute) and two pages are recognised (up to two minutes each).
export const timeoutMs = 600000;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'src', 'Vellum', 'web', 'js', 'ocr', 'languages.json'), 'utf8'));
const LINES = ['Größe der Straße', 'Übung macht schön', 'Rechnung Nummer 4821'];
let server = null;

export async function prepare() {
  const german = manifest.packs.find((p) => p.code === 'deu');
  const response = await fetch(`${manifest.source}deu.traineddata.gz`);
  if (!response.ok) throw new Error(`couldn’t fetch the German pack for the test (${response.status})`);
  const deu = Buffer.from(await response.arrayBuffer());
  if (deu.length !== german.size) throw new Error('the fetched German pack has the wrong size');
  const french = manifest.packs.find((p) => p.code === 'fra');
  const damaged = Buffer.alloc(french.size, 7);
  server = http.createServer((req, res) => {
    const body = req.url === '/deu.traineddata.gz' ? deu : req.url === '/fra.traineddata.gz' ? damaged : null;
    if (!body) return res.writeHead(404).end();
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': body.length });
    res.end(body);
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
  const packs = path.join(t.dir, 'data', 'ocr-languages');
  const row = (code) => `document.querySelector('.settings-dialog .ocr-lang[data-code="${code}"]')`;
  const state = (code) => q(`${row(code)}?.dataset.state ?? null`);
  const click = (code, act) => q(`(${row(code)}.querySelector('[data-act="${act}"]').click(), true)`);
  const ocrEdits = () => q(`JSON.stringify(${V(DOC)}.annotations.edits.filter((e) => e.kind === 'ocr').map((e) => ({ lang: e.lang, text: e.words.map((w) => w[0]).join('') })))`).then(JSON.parse);
  const rest = async (ms = 30000) => { await waitFor(settled(DOC), ms); await sleep(500); };

  area('settings');
  await rest();
  await q(`__vellum.actions.settings('ocr')`);
  check('Settings → OCR lists the languages', await waitFor(`Boolean(${row('deu')})`, 10000));
  check('English is built in and used for OCR', await state('eng') === 'installed' && await q(`${row('eng')}.dataset.chosen`) === 'true'
    && /Built in/.test(await q(`${row('eng')}.textContent`)), await q(`${row('eng')}?.textContent`));
  check('the packs are available, not installed', await state('deu') === 'available' && await state('fra') === 'available'
    && await q(`${row('deu')}.closest('[data-list]').dataset.list`) === 'available');
  check('nothing was downloaded on its own', !fs.existsSync(packs) || fs.readdirSync(packs).length === 0);
  await shot('ocr-languages-available');

  area('a damaged download');
  await click('fra', 'download');
  check('a checksum failure is reported', await waitFor(`[...document.querySelectorAll('.dialog')].some((d) => /checksum/.test(d.textContent))`, 30000));
  await q(`[...document.querySelectorAll('.dialog')].find((d) => /checksum/.test(d.textContent)).querySelector('.dialog-actions button').click()`);
  await sleep(400);
  check('French stays available and nothing is kept', await waitFor(`${row('fra')}?.dataset.state === 'available'`, 5000)
    && (!fs.existsSync(packs) || fs.readdirSync(packs).length === 0), fs.existsSync(packs) ? fs.readdirSync(packs).join(',') : '');

  area('missing pack');
  await q(`(async () => { const { bridge } = await import('/js/bridge.js'); await bridge.request('ocr.select', { code: 'deu' }); })()`);
  await q(`document.querySelector('.settings-dialog .settings-close').click()`);
  await waitFor(`!document.querySelector('.settings-dialog')`, 5000);
  await q(`(__vellum.actions.ocr.run(${V(DOC)}, 'page'), true)`);
  check('OCR explains the chosen pack must be downloaded', await waitFor(`[...document.querySelectorAll('.dialog')].some((d) => /German isn’t downloaded/.test(d.textContent) && /Download it in Settings/.test(d.textContent))`, 10000));
  await shot('ocr-languages-missing');
  await q(`[...document.querySelectorAll('.dialog-actions button')].find((b) => b.textContent === 'Open OCR settings').click()`);
  check('“Open OCR settings” opens Settings → OCR', await waitFor(`Boolean(${row('deu')})`, 10000));
  check('German shows as chosen but not downloaded', /chosen for OCR/.test(await q(`${row('deu')}.textContent`)));
  check('nothing was recognised', (await ocrEdits()).length === 0);

  area('download');
  await click('deu', 'download');
  check('progress is shown while it downloads', await waitFor(`${row('deu')}?.dataset.state === 'downloading' || ${row('deu')}?.dataset.state === 'installed'`, 10000));
  check('German installs once verified', await waitFor(`${row('deu')}?.dataset.state === 'installed'`, 60000), await state('deu'));
  check('it is listed under Installed', await q(`${row('deu')}.closest('[data-list]').dataset.list`) === 'installed');
  check('the pack is stored in the data folder, not the app', fs.existsSync(path.join(packs, 'deu.traineddata.gz')) && fs.readdirSync(packs).length === 1, fs.existsSync(packs) ? fs.readdirSync(packs).join(',') : '');
  check('German is the language used for OCR', await q(`${row('deu')}.dataset.chosen`) === 'true');
  await shot('ocr-languages-installed');
  await q(`document.querySelector('.settings-dialog .settings-close').click()`);
  await waitFor(`!document.querySelector('.settings-dialog')`, 5000);

  area('German OCR');
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
    const image = await doc.embedPng(png);
    doc.addPage([612, 792]).drawImage(image, { x: 0, y: 0, width: 612, height: 792 });
    doc.addPage([612, 792]).drawImage(image, { x: 0, y: 0, width: 612, height: 792 });
    await v.writeFile(v.file, await doc.save());
    await __vellum.app.close(v);
    return true;
  })()`);
  check('the scanned German test document was written', made === true);
  await waitFor(`!${V(DOC)}`);
  await q(`__vellum.actions.openRecent(${JSON.stringify(DOC)})`);
  await rest();
  await q(`(__vellum.actions.ocr.run(${V(DOC)}, 'page'), true)`);
  check('the OCR dialog names German', await waitFor(`/in German/.test(document.querySelector('.ocr-dialog')?.textContent ?? '')`, 10000));
  check('OCR finished', await waitFor(`${V(DOC)}.annotations.edits.filter((e) => e.kind === 'ocr').length === 1`, 120000));
  let edits = await ocrEdits();
  check('the page was read with the German pack', edits[0]?.lang === 'deu', JSON.stringify(edits));
  check('German letters were recognised', /Straße/.test(edits[0]?.text) && /Größe/.test(edits[0]?.text) && /schön/.test(edits[0]?.text), edits[0]?.text);
  await rest();
  const text = await q(`(async () => (await (await ${V(DOC)}.pdf.getPage(1)).getTextContent()).items.map((i) => i.str).join(' '))()`);
  check('ß, ö and Ü are in the searchable text layer', /Straße/.test(text) && /Größe/.test(text) && /Übung/.test(text), text);

  area('English still works');
  await q(`(async () => { const { bridge } = await import('/js/bridge.js'); await bridge.request('ocr.select', { code: 'eng' }); })()`);
  await q(`${V(DOC)}.goToPage(2)`);
  await sleep(600);
  await q(`(__vellum.actions.ocr.run(${V(DOC)}, 'page'), true)`);
  check('the OCR dialog names English', await waitFor(`/in English/.test(document.querySelector('.ocr-dialog')?.textContent ?? '')`, 10000));
  check('English OCR finished', await waitFor(`${V(DOC)}.annotations.edits.filter((e) => e.kind === 'ocr').length === 2`, 120000));
  edits = await ocrEdits();
  check('the second page was read in English', edits[1]?.lang === 'eng' && /4821/.test(edits[1]?.text), JSON.stringify(edits[1]));

  area('remove');
  await q(`(async () => { const { bridge } = await import('/js/bridge.js'); await bridge.request('ocr.select', { code: 'deu' }); })()`);
  await q(`__vellum.actions.settings('ocr')`);
  await waitFor(`Boolean(${row('deu')})`, 10000);
  await click('deu', 'remove');
  check('German is available again after removing it', await waitFor(`${row('deu')}?.dataset.state === 'available'`, 10000));
  check('its file is gone', !fs.existsSync(path.join(packs, 'deu.traineddata.gz')));
  check('OCR is back to English', await q(`${row('eng')}.dataset.chosen`) === 'true');
  await q(`document.querySelector('.settings-dialog .settings-close').click()`);
  check('no page errors were collected', (await q('__vellum.errors.length')) === 0, await q('JSON.stringify(__vellum.errors.slice(0, 3))'));
}
