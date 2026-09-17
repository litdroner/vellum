// True redaction in the app: in Edit mode a line and a picture are selected and "Redact selection" is run
// (one undo step); the file is saved, closed and reopened. The words and the picture must be gone from the
// saved file itself — its text as pdf.js reads it, and every stream in it decoded — not only covered.

import fs from 'node:fs';
import { loadPdfLib } from '../../editing/harness.mjs';

export const files = { images: 'images' };

export async function run(t) {
  const { q, check, sleep, V, settled, waitFor, area } = t;
  const PATH = t.file('images');
  const rest = async () => { await waitFor(settled(PATH), 25000); await sleep(400); };
  const objects = () => q(`(async () => (await ${V(PATH)}.textEditing.objects(1)).objects.map((o) => ({ key: o.ref.key, kind: o.kind, text: o.record?.text ?? null })))()`);
  const pageText = () => q(`(async () => (await (await ${V(PATH)}.pdf.getPage(1)).getTextContent()).items.map((i) => i.str).join('|'))()`);

  area('redact');
  await q(`__vellum.app.activate(${V(PATH)})`);
  await rest();
  await q(`${V(PATH)}.setTool('edit')`);
  await sleep(500);
  const before = await objects();
  const caption = before.find((o) => o.text === 'Caption under the picture');
  const picture = before.find((o) => o.kind === 'image');
  check('the caption and a picture are objects', Boolean(caption && picture), JSON.stringify(before));
  await q(`${V(PATH)}.objectSelection.set(1, ${JSON.stringify([caption.key, picture.key])})`);
  check('redacting the selection succeeds', await q(`${V(PATH)}.textEditor.redactSelected()`));
  await rest();
  check('one redaction record', (await q(`${V(PATH)}.annotations.edits.filter((e) => e.kind === 'redact').length`)) === 1);
  check('the pages show it: the caption is gone, the other text stays', await (async () => {
    const text = await pageText();
    return !text.includes('Caption') && text.includes('Text beside another picture');
  })(), await pageText());
  check('redacted objects can no longer be selected', !(await objects()).some((o) => o.key === caption.key || o.key === picture.key));
  await t.shot('redacted');

  area('save and reopen');
  await q('__vellum.actions.save()');
  check('saved', await waitFor(`!${V(PATH)}.annotations.dirty`, 25000));
  await q(`__vellum.app.close(${V(PATH)})`);
  await waitFor(`!${V(PATH)}`);
  await q(`__vellum.actions.openRecent(${JSON.stringify(PATH)})`);
  await rest();
  const reopened = await pageText();
  check('reopened: the caption is not in the text', !reopened.includes('Caption') && reopened.includes('Text beside another picture'), reopened);

  const lib = await loadPdfLib();
  const doc = await lib.PDFDocument.load(new Uint8Array(fs.readFileSync(PATH)), { updateMetadata: false });
  let streams = '';
  let draws = 0;
  for (const [, obj] of doc.context.enumerateIndirectObjects()) {
    if (!(obj instanceof lib.PDFRawStream)) continue;
    const text = Buffer.from(lib.decodePDFRawStream(obj).decode()).toString('latin1');
    streams += text;
    draws += (text.match(/\/Im1 Do/g) ?? []).length;
  }
  check('the saved file holds no trace of the caption', !streams.includes('Caption') && !streams.toLowerCase().includes(Buffer.from('Caption').toString('hex')));
  check('one picture draw is gone, the other stays', draws === 1, String(draws));
  check('no page errors were collected', (await q('__vellum.errors.length')) === 0, await q('JSON.stringify(__vellum.errors.slice(0, 3))'));
}
