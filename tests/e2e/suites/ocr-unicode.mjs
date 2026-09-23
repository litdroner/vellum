// Russian and Hindi OCR in the real app (OCR Unicode V1): each pack is downloaded and verified, a scanned
// page in the language is read by the same Tesseract engine, and its Cyrillic or Devanagari words become an
// invisible text layer in an embedded Noto Sans subset (editing/objects/ocr-text.js, UNICODE_FONTS). The
// words can be found, and they are still there, in their own script, once the file is saved and opened again.
//
// The packs come from a loopback source (VELLUM_OCR_LANGUAGE_SOURCE): the real packs, fetched once from the
// pinned source in languages.json and checked against their size. Only when named:
//   node tests/e2e/run.mjs ocr-unicode

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const files = { rus: 'scanned', hin: 'scanned' };
// Each language installs (up to a minute) and recognises a page (up to two).
export const timeoutMs = 600000;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'src', 'Vellum', 'web', 'js', 'ocr', 'languages.json'), 'utf8'));

/** Each language: the lines drawn on its scan (in a font of its script), words that must be read, one to find. */
const LANGUAGES = [
  { code: 'rus', name: 'Russian', font: '72px Georgia, serif', lines: ['Съешь же ещё этих', 'мягких французских булок', 'Счёт номер 4821'], words: ['Съешь', 'французских', 'ещё', '4821'], find: 'французских' },
  { code: 'hin', name: 'Hindi', font: '72px "Nirmala UI", Mangal, sans-serif', lines: ['भारत सरकार की किताब', 'हिंदी भाषा और संख्या', 'पृष्ठ'], words: ['भारत', 'सरकार', 'किताब', 'हिंदी', 'भाषा', 'संख्या', 'पृष्ठ'], find: 'किताब' },
];
let server = null;

export async function prepare() {
  const packs = new Map();
  for (const { code, name } of LANGUAGES) {
    const pack = manifest.packs.find((p) => p.code === code);
    const response = await fetch(`${manifest.source}${code}.traineddata.gz`);
    if (!response.ok) throw new Error(`couldn’t fetch the ${name} pack for the test (${response.status})`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length !== pack.size) throw new Error(`the fetched ${name} pack has the wrong size`);
    packs.set(`/${code}.traineddata.gz`, bytes);
  }
  server = http.createServer((req, res) => {
    const bytes = packs.get(req.url);
    if (!bytes) return res.writeHead(404).end();
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': bytes.length });
    res.end(bytes);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { env: { VELLUM_OCR_LANGUAGE_SOURCE: `http://127.0.0.1:${server.address().port}/` } };
}

export function cleanup() {
  server?.close();
}

export async function run(t) {
  for (const language of LANGUAGES) await ocrIn(t, language);
  t.check('no page errors were collected', (await t.q('__vellum.errors.length')) === 0, await t.q('JSON.stringify(__vellum.errors.slice(0, 3))'));
}

async function ocrIn(t, { code, name, font, lines, words, find }) {
  const { q, check, sleep, shot, V, settled, waitFor, area } = t;
  const DOC = t.file(code);
  const row = (c) => `document.querySelector('.settings-dialog .ocr-lang[data-code="${c}"]')`;
  const textOf = (n) => q(`(async () => (await (await ${V(DOC)}.pdf.getPage(${n})).getTextContent()).items.map((i) => i.str).join(' ').replace(/\\s+/g, ' ').normalize('NFC'))()`);
  const rest = async (ms = 30000) => { await waitFor(settled(DOC), ms); await sleep(500); };
  const readAll = (text) => words.every((w) => text.includes(w.normalize('NFC')));

  area(`download ${name}`);
  await rest();
  await q(`__vellum.actions.settings('ocr')`);
  check(`${name} is offered`, await waitFor(`${row(code)}?.dataset.state === 'available'`, 10000));
  await q(`(${row(code)}.querySelector('[data-act="download"]').click(), true)`);
  check(`${name} installs once verified`, await waitFor(`${row(code)}?.dataset.state === 'installed'`, 60000));
  await q(`(async () => { const { bridge } = await import('/js/bridge.js'); await bridge.request('ocr.select', { code: ${JSON.stringify(code)} }); })()`);
  await q(`document.querySelector('.settings-dialog .settings-close').click()`);
  await waitFor(`!document.querySelector('.settings-dialog')`, 5000);

  area(`${name} OCR`);
  const made = await q(`(async () => {
    const v = ${V(DOC)};
    const lib = await import('/vendor/pdf-lib/pdf-lib.esm.min.js');
    const canvas = Object.assign(document.createElement('canvas'), { width: 1700, height: 2200 });
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, 1700, 2200);
    ctx.fillStyle = '#111'; ctx.font = ${JSON.stringify(font)};
    ${JSON.stringify(lines)}.forEach((line, i) => ctx.fillText(line, 160, 320 + i * 150));
    const png = new Uint8Array(await (await new Promise((r) => canvas.toBlob(r, 'image/png'))).arrayBuffer());
    const doc = await lib.PDFDocument.create();
    doc.addPage([612, 792]).drawImage(await doc.embedPng(png), { x: 0, y: 0, width: 612, height: 792 });
    await v.writeFile(v.file, await doc.save());
    await __vellum.app.close(v);
    return true;
  })()`);
  check(`the scanned ${name} test document was written`, made === true);
  await waitFor(`!${V(DOC)}`);
  await q(`__vellum.actions.openRecent(${JSON.stringify(DOC)})`);
  await rest();
  await q(`(__vellum.actions.ocr.run(${V(DOC)}, 'page'), true)`);
  check(`the OCR dialog names ${name}`, await waitFor(`/in ${name}/.test(document.querySelector('.ocr-dialog')?.textContent ?? '')`, 10000));
  check('OCR finished', await waitFor(`${V(DOC)}.annotations.edits.filter((e) => e.kind === 'ocr').length === 1`, 120000));
  await rest();
  const read = await textOf(1);
  check(`the ${name} words are in the searchable text layer`, readAll(read), read);
  await q(`__vellum.ui.findbar.open(${JSON.stringify(find)})`);
  check(`Find locates a ${name} word`, await waitFor(`${V(DOC)}.find.total >= 1`, 10000), await q(`JSON.stringify(${V(DOC)}.find)`));
  await q('__vellum.ui.findbar.close()');
  await shot(`ocr-unicode-${code}`);

  area(`${name}: save and reopen`);
  await q('__vellum.actions.save()');
  check('saved', await waitFor(`!${V(DOC)}.annotations.dirty`, 30000));
  const raw = fs.readFileSync(DOC).toString('latin1');
  check('the saved file embeds a Noto Sans subset', /NotoSans/.test(raw) && /\/FontFile2/.test(raw));
  await q(`__vellum.app.close(${V(DOC)})`);
  await waitFor(`!${V(DOC)}`);
  await q(`__vellum.actions.openRecent(${JSON.stringify(DOC)})`);
  await rest();
  const reopened = await textOf(1);
  check(`the ${name} text layer is in the saved file`, readAll(reopened), reopened);
}
