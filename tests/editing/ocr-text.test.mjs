// The OCR text layer (editing/objects/ocr-text.js), saved: Latin-script languages in Helvetica (WinAnsi),
// as before; Russian in the bundled Noto Sans, embedded as a subset whose ToUnicode map gives readers the
// Cyrillic letters. Checked the way another reader sees the file: pdf.js's text of the saved page, and of
// that file saved again. Run: node --test "tests/editing/*.test.mjs"

import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { WEB, engine, openWithPdfjs, webModule, withSession } from './harness.mjs';
import { makeFixtures, FIXTURE_DIR } from './fixtures.mjs';

const { registerBundledFamily } = await engine('objects/font-set.js');
const { UNICODE_FONTS, unicodeFontOf } = await engine('objects/ocr-text.js');
const { composeDocument } = await webModule('annotations/persist.js');

// The app reads bundled fonts over fetch; Node reads the same file from disk.
registerBundledFamily({ id: 'notosans', name: 'Noto Sans', faces: { regular: new Uint8Array(fs.readFileSync(path.join(WEB, 'fonts', 'document', 'notosans', 'NotoSans-Regular.ttf'))) } });

let files;
before(async () => { files = await makeFixtures(FIXTURE_DIR); });

/** Words along one line, as ocr/engine.js makes them. */
const line = (words, y = 700) => {
  let x = 72;
  return words.map((w, i) => {
    const text = w + (i < words.length - 1 ? ' ' : '');
    const word = [text, x, y, x + w.length * 7, y, 14];
    x += w.length * 7 + 5;
    return word;
  });
};

async function pageText(bytes) {
  const js = await openWithPdfjs(bytes);
  try {
    const { items } = await (await js.doc.getPage(1)).getTextContent();
    return items.map((i) => i.str).join('');
  } finally { await js.close(); }
}

/** OCR of page 1 of the scanned fixture in `lang`, saved; then that file saved again. */
async function ocrSaved(lang, words) {
  const bytes = new Uint8Array(fs.readFileSync(files.scanned));
  return withSession(bytes, async ({ plan, sources }) => {
    const edits = [{ id: 'o1', kind: 'ocr', entry: plan[0].id, lang, words }];
    const saved = await composeDocument({ base: bytes, plan, edits, sources });
    const again = await composeDocument({ base: saved });
    return { saved, again };
  });
}

test('only Russian is written in a Unicode font so far; every other language stays in Helvetica', () => {
  assert.deepEqual(Object.keys(UNICODE_FONTS), ['rus']);
  assert.equal(unicodeFontOf('rus'), 'bundled:notosans/regular');
  for (const code of ['eng', 'fra', 'deu', 'toString', undefined]) assert.equal(unicodeFontOf(code), null, String(code));
});

test('Russian OCR is saved as real, selectable Cyrillic text in an embedded Noto Sans subset, and survives saving again', async () => {
  const words = line(['Съешь', 'же', 'ещё', 'этих', 'мягких', 'французских', 'булок,', 'ЁЖ', '2026']);
  const { saved, again } = await ocrSaved('rus', words);
  const raw = Buffer.from(saved).toString('latin1');
  assert.match(raw, /NotoSans/, 'the font is Noto Sans');
  assert.match(raw, /\/FontFile2/, 'embedded');
  assert.match(raw, /\/ToUnicode/, 'with the letters it stands for');
  assert.ok(saved.length < fs.statSync(files.scanned).size + 80000, 'a subset, not the whole font');
  const expected = 'Съешь же ещё этих мягких французских булок, ЁЖ 2026';
  const norm = (s) => s.replace(/\s+/g, ' ').trim();
  assert.equal(norm(await pageText(saved)), expected);
  assert.equal(norm(await pageText(again)), expected, 'reopened and saved again, the text is unchanged');
});

test('English OCR is still written in Helvetica, not embedded', async () => {
  const { saved, again } = await ocrSaved('eng', line(['Quarterly', 'report', 'naïve']));
  const raw = Buffer.from(saved).toString('latin1');
  assert.match(raw, /\/BaseFont\s*\/Helvetica/);
  assert.doesNotMatch(raw, /NotoSans/);
  const norm = (s) => s.replace(/\s+/g, ' ').trim();
  assert.equal(norm(await pageText(saved)), 'Quarterly report naïve');
  assert.equal(norm(await pageText(again)), 'Quarterly report naïve');
});
