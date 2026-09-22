// OCR language packs (ocr/languages.json, ocr/languages.js): the list Vellum offers is well formed and
// pinned, every offered language can be written by the OCR text layer, and the page's rules for installed
// vs available, the chosen language, and a missing or damaged pack. Downloading and checking a pack is the
// host's (tests/host).

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { loadPdfLib, webModule } from './harness.mjs';

const manifest = JSON.parse(await readFile(new URL('../../src/Vellum/web/js/ocr/languages.json', import.meta.url), 'utf8'));
const L = await webModule('ocr/languages.js');

/** Letters each language needs beyond A–Z (checked against the text layer's encoding). */
const LETTERS = {
  dan: 'æøåÆØÅ', nld: 'ëïéèĳ', fin: 'äöåÄÖÅ', fra: 'àâæçéèêëîïôœùûüÿÀÇÉÈŒ', deu: 'äöüßÄÖÜ',
  ita: 'àèéìíîòóùú', nor: 'æøåÆØÅ', por: 'áâãàçéêíóôõúÁÇÃ', spa: 'áéíñóúüÑ¿¡', swe: 'åäöÅÄÖ',
};

test('the language list is pinned, well formed and leaves English to the bundle', () => {
  assert.match(manifest.source, /^https:\/\/raw\.githubusercontent\.com\/naptha\/tessdata\/[0-9a-f]{40}\/4\.0\.0_best_int\/$/);
  assert.deepEqual(manifest.builtIn, { code: 'eng', name: 'English' });
  const codes = manifest.packs.map((p) => p.code);
  assert.equal(new Set(codes).size, codes.length, 'codes are unique');
  assert.ok(!codes.includes('eng'));
  for (const p of manifest.packs) {
    assert.match(p.code, /^[a-z]{3}$/, p.code);
    assert.match(p.sha256, /^[0-9a-f]{64}$/, p.code);
    assert.ok(Number.isInteger(p.size) && p.size > 100_000 && p.size < 20_000_000, `${p.code} size`);
    assert.ok(p.name && p.name !== p.code, `${p.code} has a name`);
  }
  assert.deepEqual(Object.keys(LETTERS).sort(), [...codes].sort(), 'every offered language is checked below');
});

test('every offered language can be written by the OCR text layer', async () => {
  const lib = await loadPdfLib();
  const { encodeWord } = await webModule('editing/objects/ocr-text.js');
  for (const [code, letters] of Object.entries(LETTERS)) {
    for (const ch of letters.replace('ĳ', '')) {
      const { shown } = encodeWord(lib, ch);
      assert.equal(shown, ch, `${code}: “${ch}” survives`);
    }
  }
});

test('English is always installed and first; packs split into installed and available', () => {
  const list = L.languageList({
    selected: 'fra', downloading: null,
    packs: [{ code: 'fra', name: 'French', size: 707406, installed: true }, { code: 'deu', name: 'German', size: 1333102, installed: false }, { code: 'dan', name: 'Danish', size: 1, installed: false }],
  });
  assert.deepEqual(list.languages.map((l) => l.code), ['eng', 'dan', 'fra', 'deu']);
  assert.deepEqual(L.installedLanguages(list).map((l) => l.code), ['eng', 'fra']);
  assert.deepEqual(L.availableLanguages(list).map((l) => l.code), ['dan', 'deu']);
  assert.equal(L.selectedLanguage(list).code, 'fra');
});

test('the chosen language falls back to English when unknown, and with no host at all', () => {
  assert.equal(L.selectedLanguage(L.languageList({ selected: 'xyz', packs: [] })).code, 'eng');
  assert.equal(L.selectedLanguage(L.languageList(null)).code, 'eng');
  const list = L.languageList({ selected: 'eng', packs: [{ code: 'eng', name: 'Fake', installed: false }, { code: 'bad code' }] });
  assert.deepEqual(list.languages.map((l) => l.code), ['eng'], 'English can’t be replaced by a pack; bad entries are dropped');
  assert.equal(list.languages[0].installed, true);
});

test('OCR runs in English or an installed pack, and explains a missing or damaged one', () => {
  const list = L.languageList({ selected: 'deu', packs: [{ code: 'deu', name: 'German', size: 1333102, installed: false }] });
  assert.equal(L.ocrReadiness(L.ENGLISH, { ready: false }).ready, true, 'English never depends on a pack');
  const german = L.selectedLanguage(list);
  assert.equal(L.ocrReadiness(german, { ready: true }).ready, true);
  const missing = L.ocrReadiness(german, { ready: false, reason: 'missing' });
  assert.equal(missing.ready, false);
  assert.equal(missing.title, 'German isn’t downloaded');
  assert.match(missing.message, /Download it in Settings → OCR \(1\.3 MB\)/);
  const damaged = L.ocrReadiness(german, { ready: false, reason: 'damaged' });
  assert.match(damaged.title, /damaged/);
  assert.match(damaged.message, /Download it again/);
});

test('sizes read as megabytes', () => {
  assert.equal(L.formatMB(707406), '0.7 MB');
  assert.equal(L.formatMB(3795323), '3.6 MB');
  assert.equal(L.formatMB(12 * 1024 * 1024), '12 MB');
});
