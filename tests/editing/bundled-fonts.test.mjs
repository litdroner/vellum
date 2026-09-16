// Vellum 0.6: the bundled font library (editing/objects/bundled-fonts.js, web/fonts/document) — the fonts
// Vellum ships for new text, read through the font set (editing/objects/font-set.js) as the app reads them.
//
// Pinned here: every family in the catalog has its licence (SIL OFL 1.1) beside its files and a line in
// NOTICE.txt; every face listed is a file that is one font, under its own PostScript name, of the family and
// style it is listed as, whose licence flags allow embedding, and which has the basic Latin characters; a
// font set lists the families before reading any file and reads a face only when it is wanted; representative
// families write, subset-embed and reopen as editable text; characters a face lacks, or that need shaping,
// are refused with nothing changed. Run: node --test "tests/editing/*.test.mjs"

import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WEB, analyzeFile, engine, loadPdfLib, webModule, withSession } from './harness.mjs';
import { makeFixtures, FIXTURE_DIR } from './fixtures.mjs';

// The app reads bundled fonts over its own resource server; here a file: URL is read from disk.
const nodeFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  const href = String(url);
  if (!href.startsWith('file:')) return nodeFetch(url, init);
  try {
    return new Response(fs.readFileSync(fileURLToPath(href)));
  } catch {
    return new Response(null, { status: 404 });
  }
};

const { BUNDLED_FONTS } = await engine('objects/bundled-fonts.js');
const { bundledFamilies, fontSet, readBundledFont } = await engine('objects/font-set.js');
const { STYLES } = await engine('objects/text-format.js');
const { EditError } = await engine('edits.js');
const { composeDocument } = await webModule('annotations/persist.js');

const FONTS = path.join(WEB, 'fonts', 'document');
const UPRIGHT = [1, 0, 0, -1, 0, 0];
const LETTER = [0, 0, 612, 792];
const LATIN = 'The quick brown fox jumps over the lazy dog. THE QUICK BROWN FOX 0123456789 ,.;:!?()"\'-';

let files;
before(async () => { files = await makeFixtures(FIXTURE_DIR); });

test('the catalog: licensed, noticed, every face one unrenamed font of its family and style, embeddable, with basic Latin', async () => {
  const ids = BUNDLED_FONTS.map((f) => f.id);
  assert.equal(new Set(ids).size, ids.length, 'ids are unique');
  assert.ok(BUNDLED_FONTS.length >= 25, `${BUNDLED_FONTS.length} families`);
  const notice = fs.readFileSync(path.join(FONTS, 'NOTICE.txt'), 'utf8');
  const groups = ['sans', 'serif', 'mono', 'legible', 'international'];
  let lastGroup = 0;
  for (const family of BUNDLED_FONTS) {
    assert.ok(groups.indexOf(family.group) >= lastGroup, `${family.name}: listed in its group's place`);
    lastGroup = groups.indexOf(family.group);
    assert.match(fs.readFileSync(path.join(FONTS, family.id, 'OFL.txt'), 'utf8'), /SIL OPEN FONT LICENSE Version 1\.1/i, `${family.name}: licence`);
    assert.ok(notice.includes(`${family.name} — `) && notice.includes(`${family.id}/OFL.txt`), `${family.name}: in NOTICE.txt`);
    assert.ok(family.faces.regular, `${family.name}: a regular face`);
    const listed = new Set(Object.values(family.faces).map((file) => path.basename(file)));
    const onDisk = fs.readdirSync(path.join(FONTS, family.id)).filter((f) => f.endsWith('.ttf'));
    assert.deepEqual([...onDisk].sort(), [...listed].sort(), `${family.name}: only the files listed`);
    for (const [style, file] of Object.entries(family.faces)) {
      assert.ok(STYLES.includes(style));
      const { font, refusal } = await readBundledFont(`bundled:${family.id}/${style}`);
      const label = `${family.name} ${style}`;
      assert.equal(refusal, null, `${label}: its licence flags allow embedding`);
      assert.equal(`${font.postscriptName}.ttf`, path.basename(file), `${label}: file named as the font names itself`);
      assert.equal(font.familyName, family.name, `${label}: the font's own family name`);
      const bold = style.startsWith('bold');
      const italic = style.endsWith('italic');
      assert.equal(font['OS/2'].usWeightClass, bold ? 700 : 400, `${label}: weight`);
      assert.equal(Boolean(font['OS/2'].fsSelection.italic), italic, `${label}: italic flag`);
      assert.deepEqual([...LATIN].filter((ch) => !font.hasGlyphForCodePoint(ch.codePointAt(0))), [], `${label}: basic Latin`);
    }
  }
});

test('a font set lists the library without reading it, and reads a face when it is wanted', async () => {
  const lib = await loadPdfLib();
  const fonts = await fontSet(lib);
  const listed = fonts.families.filter((f) => f.id.startsWith('bundled:') && BUNDLED_FONTS.some((b) => `bundled:${b.id}` === f.id));
  assert.equal(listed.length, BUNDLED_FONTS.length, 'every family listed');
  const serif = listed.find((f) => f.id === 'bundled:dmserifdisplay');
  assert.deepEqual(serif.faces, ['bundled:dmserifdisplay/regular', null, 'bundled:dmserifdisplay/italic', null], 'only the faces it has');
  assert.equal(serif.group, 'serif');
  assert.equal(fonts.face('bundled:lora/bold'), null, 'not read yet');
  await fonts.load(['bundled:lora']);
  assert.equal(fonts.face('bundled:lora/bold').name, 'Lora Bold');
  assert.equal(fonts.face('bundled:lora/bold-italic').name, 'Lora Bold Italic');
  assert.equal(fonts.face('bundled:inter/regular'), null, 'other families still unread');
});

// Representative families, one of each group and the widest coverage: [family, style, text].
const SAMPLES = [
  ['inter', 'bold-italic', 'Quarterly notes — “draft”'],
  ['merriweather', 'regular', 'Chapter one: café naïve'],
  ['jetbrainsmono', 'bold', 'const x = a[i] != 0;'],
  ['atkinsonhyperlegiblenext', 'italic', 'Il1 O0 rn m'],
  ['notosans', 'regular', 'Ελληνικά Кириллица Tiếng Việt'],
];

test('representative families: written, embedded as subsets, reopened as editable text in those fonts', async () => {
  const bytes = new Uint8Array(fs.readFileSync(files.simple));
  await withSession(bytes, async ({ store, session, sources, plan }) => {
    for (const [id, style, text] of SAMPLES) {
      const key = await session.insertText(1, { basis: UPRIGHT, box: LETTER });
      // Typed and formatted in one step, as in the open editor: the text needn't fit the standard font first.
      const changes = { family: `bundled:${id}`, bold: style.startsWith('bold'), italic: style.endsWith('italic') };
      assert.equal(await session.formatText(1, [key], changes, { text }), true, `${id} chosen`);
      const record = store.edits.find((e) => e.text === text);
      assert.equal(record.font, `bundled:${id}/${style}`);
      await session.transformObjects(1, [{ key, delta: [1, 0, 0, 1, 0, -40 * SAMPLES.findIndex((s) => s[0] === id)] }]);
    }

    const saved = await composeDocument({ base: bytes, plan, edits: store.edits, sources });
    assert.ok(saved.length < bytes.length + 250000, `subsets, not whole fonts (${saved.length - bytes.length} bytes added)`);
    const after = await analyzeFile(saved);
    const runs = after.pages[0].runs;
    for (const [id, style, text] of SAMPLES) {
      const ps = path.basename(BUNDLED_FONTS.find((f) => f.id === id).faces[style], '.ttf');
      const run = runs.find((r) => r.text === text);
      assert.ok(run, `${text}: ${JSON.stringify(runs.map((r) => r.text))}`);
      assert.match(run.font.name, new RegExp(`^${ps}-\\d+$`), `${text}: in a subset of ${ps} (pdf-lib tags a subset's name)`);
      assert.ok(run.font.embedded);
      assert.ok(run.editable, `${text}: ${[...run.reasons].join(', ')}`);
    }
  });
});

test('refused with nothing changed: a character the bundled face lacks, a script that needs shaping', async () => {
  const bytes = new Uint8Array(fs.readFileSync(files.simple));
  await withSession(bytes, async ({ store, session }) => {
    const key = await session.insertText(1, { basis: UPRIGHT, box: LETTER });
    await session.edit(1, key, 'Notes');
    await session.formatText(1, [key], { family: 'bundled:rubik' });
    const before = JSON.stringify(store.edits);
    await assert.rejects(session.formatText(1, [key], {}, { text: 'Notes 中文' }),
      (e) => e instanceof EditError && e.kind === 'characters' && /Rubik, which has no “中”, “文”/.test(e.message));
    // Rubik has Hebrew glyphs, but Hebrew is only written correctly shaped, right to left.
    await assert.rejects(session.formatText(1, [key], {}, { text: 'Notes שלום' }),
      (e) => e instanceof EditError && e.kind === 'characters' && /shaped together/.test(e.message));
    await assert.rejects(session.formatText(1, [key], { family: 'bundled:dmserifdisplay', bold: true }),
      (e) => e instanceof EditError && /style asked for/.test(e.message), 'a face the family hasn’t got');
    assert.equal(JSON.stringify(store.edits), before, 'nothing changed');
  });
});

test('Liu San in use: sentences, wrapped lines and every face, saved as embedded subsets, reopened and retyped', async () => {
  const bytes = new Uint8Array(fs.readFileSync(files.simple));
  const liu = BUNDLED_FONTS.find((f) => f.id === 'liusan');
  assert.deepEqual(Object.keys(liu.faces), STYLES, 'the four faces supplied');
  assert.equal(liu.name, 'Liu San', 'the name the selector and the palette show');
  const listed = bundledFamilies().find((f) => f.id === 'bundled:liusan');
  assert.equal(listed.preview, 'bundled:liusan/bold', 'the selector previews it in its own bold face');
  assert.ok(bundledFamilies().filter((f) => f.id !== listed.id).every((f) => f.preview === `${f.id}/regular`), 'every other family in its regular');
  for (const style of STYLES) {
    const { font } = await readBundledFont(`bundled:liusan/${style}`);
    const ps = `LiuSan-${style === 'regular' ? 'Regular' : style === 'bold' ? 'Bold' : style === 'italic' ? 'Italic' : 'BoldItalic'}`;
    assert.deepEqual([font.familyName, font.postscriptName], ['Liu San', ps], `${style}: named Liu San in the font itself`);
  }
  const lines = [
    ['regular', 'Hello there, reader.'],
    ['bold', 'A longer sentence: with spaces, commas; quotes “like this” and (brackets)!'],
    ['italic', 'Wrapped words that run on past the width of their box, onto more lines'],
    ['bold-italic', 'First line\nsecond line?'],
  ];
  const saved = await withSession(bytes, async ({ store, session, sources, plan }) => {
    const keys = [];
    for (const [i, [style, text]] of lines.entries()) {
      const key = await session.insertText(1, { basis: UPRIGHT, box: LETTER });
      keys.push(key);
      const changes = { family: 'bundled:liusan', bold: style.startsWith('bold'), italic: style.endsWith('italic'), size: 14, underline: i === 0, color: '#2f6fd6', opacity: 0.8 };
      assert.equal(await session.formatText(1, [key], changes, { text }), true, `${style} chosen`);
      if (i === 2) assert.equal(await session.formatText(1, [key], { width: 160 }), true, 'a width to wrap to');
      const record = store.edits.find((e) => e.kind === 'inserted-text' && e.text === text);
      assert.equal(record.font, `bundled:liusan/${style}`);
      await session.transformObjects(1, [{ key, delta: [1, 0, 0, 1, 0, -90 * i] }]);
    }
    const before = JSON.stringify(store.edits);
    await assert.rejects(session.formatText(1, [keys[0]], {}, { text: 'Notes 中文' }),
      (e) => e instanceof EditError && e.kind === 'characters' && /Liu San, which has no “中”, “文”/.test(e.message));
    assert.equal(JSON.stringify(store.edits), before, 'a character Liu San hasn’t got: nothing changed');
    const fonts = await fontSet(await loadPdfLib());
    await fonts.load(['bundled:liusan']);
    assert.ok(fonts.face('bundled:liusan/regular').underline.thickness > 0, 'an underline to draw though the font gives none');
    return composeDocument({ base: bytes, plan, edits: store.edits, sources });
  });

  const after = await analyzeFile(saved);
  const runs = after.pages[0].runs;
  const inLiu = runs.filter((r) => /^LiuSan-/.test(r.font?.name ?? ''));
  for (const [style, text] of lines) {
    const ps = `LiuSan-${style === 'regular' ? 'Regular' : style === 'bold' ? 'Bold' : style === 'italic' ? 'Italic' : 'BoldItalic'}`;
    const words = text.split(/\s+/);
    const mine = inLiu.filter((r) => new RegExp(`^${ps}-\\d+$`).test(r.font.name));
    assert.ok(mine.length, `${ps}: ${JSON.stringify(inLiu.map((r) => [r.text, r.font.name]))}`);
    assert.equal(mine.map((r) => r.text).join(' ').split(/\s+/).join(' '), words.join(' '), `${ps}: its text, as real text`);
    for (const run of mine) {
      assert.ok(run.font.embedded, `${ps}: embedded`);
      assert.ok(run.editable, `${run.text}: ${[...run.reasons].join(', ')}`);
    }
  }
  assert.ok(inLiu.filter((r) => r.font.name.startsWith('LiuSan-Italic-')).length >= 2, 'the long italic sentence wrapped onto lines');

  await withSession(saved, async ({ store, session }) => {
    const { runs: reopened } = await session.page(1);
    const item = reopened.find((r) => r.run.text === 'Hello there, reader.');
    assert.ok(item, 'reopened');
    assert.equal(await session.edit(1, item.run.key, 'Hello there, reader'), true, 'retyped after reopening');
    const record = store.edits.find((e) => e.kind === 'text');
    assert.equal(record?.encoding.mode, 'font', 'written in the embedded Liu San subset itself');
  });
});
