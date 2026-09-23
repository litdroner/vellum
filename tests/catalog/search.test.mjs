// The one search Tools and the command palette share (catalog/search.js): normalising, match bands,
// direction words and numbers, the golden queries every catalog change must keep, and the palette's
// promise that typing a command's label finds that command first.
// Run: node --test "tests/catalog/*.test.mjs"

import test from 'node:test';
import assert from 'node:assert/strict';
import { webModule } from '../editing/harness.mjs';

const { BAND, normalise, tokenise, indexItems, rank } = await webModule('catalog/search.js');
const { TOOLS, toolFields, COMMAND_FIELDS, aliasesByCommand } = await webModule('catalog/catalog.js');
const { createCommands } = await webModule('commands.js');

const commands = createCommands({}, {}, {});
const tools = indexItems(TOOLS, toolFields(commands));
const find = (query, options) => rank(tools, query, options);
const ids = (query, n) => find(query).slice(0, n).map((r) => r.item.id);

// The palette's items as ui/palette.js builds them with a document open (no recent files).
const aliases = aliasesByCommand();
const paletteItems = Object.entries(commands)
  .filter(([, c]) => c.label && c.palette !== false)
  .map(([id, c]) => ({ id, label: c.label, group: c.group ?? 'App', aliases: aliases.get(id) ?? null }));
const palette = indexItems(paletteItems, COMMAND_FIELDS);
const paletteTop = (query) => rank(palette, query)[0]?.item.id;

test('normalising: case, accents, punctuation, arrows, &, PDF/A, "2" between words', () => {
  assert.equal(normalise('Résumé'), 'resume');
  assert.equal(normalise('Convert to PDF/A-2b…'), 'convert to pdfa 2b');
  assert.equal(normalise('Images → PDF'), 'images to pdf');
  assert.equal(normalise('pdf->word'), 'pdf to word');
  assert.equal(normalise('pdf 2 word'), 'pdf to word');
  assert.equal(normalise('Fill & Sign'), 'fill and sign');
  assert.equal(normalise('What’s wrong?'), 'whats wrong');
  assert.equal(normalise('  Recognize text (OCR) '), 'recognize text ocr');
});

test('words: stop words go (unless nothing else is left), and a final s comes off longer words', () => {
  assert.deepEqual(tokenise('Merge the PDFs'), ['merge', 'pdf']);
  assert.deepEqual(tokenise('pages'), ['page']);
  assert.deepEqual(tokenise('class'), ['class']);
  assert.deepEqual(tokenise('this'), ['this']);
  assert.deepEqual(tokenise('please add a note'), ['add', 'note']);
  assert.deepEqual(tokenise(''), []);
});

// Query → the tool that must come first (docs/TOOLS_UX_SPEC.md §9.6).
const GOLDEN = [
  ['compress', 'compress-pdf'], ['shrink', 'compress-pdf'], ['smaller', 'compress-pdf'],
  ['combine', 'merge-pdfs'],
  ['remove page', 'delete-pages'],
  ['excel', 'pdf-to-excel'], ['xlsx', 'pdf-to-excel'],
  ['pictures to pdf', 'images-to-pdf'], ['jpg to pdf', 'images-to-pdf'],
  ['pdf to jpg', 'pdf-to-images'], ['pdf to pictures', 'pdf-to-images'],
  ['word', 'pdf-to-word'], ['docx', 'pdf-to-word'], ['convert to word', 'pdf-to-word'], ['pdf 2 word', 'pdf-to-word'],
  ['ocr', 'recognize-text'], ['scanned', 'recognize-text'],
  ['sign', 'add-signature'],
  ['black out', 'redact-selection'],
  ['reorder', 'organize-pages'],
  ['rotate', 'rotate-pages'], ['rotate 2 pages', 'rotate-pages'], ['rotate page 3', 'rotate-pages'],
  ['wtaermark', 'add-watermark'],
  ['archive', 'convert-to-pdfa'],
  ['page number', 'add-page-numbers'],
  ['extract', 'extract-pages'],
  ['text', 'edit-text'],
  ['merge into one', 'merge-pdfs'],
  ['split every 2 pages', 'split-pdf'],
];

test('golden queries: the right tool first', () => {
  for (const [query, id] of GOLDEN) assert.equal(ids(query, 1)[0], id, `“${query}” → ${ids(query, 3).join(', ')}`);
});

test('extract: Extract pages, then a PDF to … tool and Copy tables', () => {
  const top = ids('extract', 3);
  assert.equal(top[0], 'extract-pages');
  assert.ok(top.includes('copy-tables'), top.join(', '));
  assert.ok(top.some((id) => id.startsWith('pdf-to-')), top.join(', '));
});

test('font: no tool (fonts are formatting, found in the palette)', () => {
  assert.deepEqual(ids('font', 5), []);
});

test('direction: the order of the words decides between opposite conversions', () => {
  assert.deepEqual(ids('pictures to pdf', 2), ['images-to-pdf', 'pdf-to-images']);
  assert.deepEqual(ids('pdf to pictures', 2), ['pdf-to-images', 'images-to-pdf']);
  assert.equal(find('pictures to pdf')[0].band, BAND.PHRASE);
});

test('"to", "into" and numbers never leave a result out', () => {
  const plain = ids('rotate pages', 10);
  assert.deepEqual(ids('rotate to pages', 10), plain);
  assert.deepEqual(ids('rotate 90 pages', 10), plain);
  // Only optional words: they are the query, so something still matches.
  assert.ok(find('pdf to').length > 0 && find('to').length > 0);
});

test('match bands: phrase, in order, exact, prefix, inner, typo', () => {
  const band = (query, id) => find(query).find((r) => r.item.id === id)?.band;
  assert.equal(band('combine', 'merge-pdfs'), BAND.PHRASE);
  assert.equal(band('add page', 'add-page-numbers'), BAND.ORDERED);
  assert.equal(band('rotate', 'rotate-pages'), BAND.EXACT);
  assert.equal(band('rot', 'rotate-pages'), BAND.PREFIX);
  assert.equal(band('otate', 'rotate-pages'), BAND.INNER);
  assert.equal(band('wtaermark', 'add-watermark'), BAND.TYPO);
  // Typos only on longer words, inner matches only on three letters or more.
  assert.equal(band('ot', 'rotate-pages'), undefined);
  assert.equal(band('rotat', 'rotate-pages'), BAND.PREFIX);
});

test('results are ordered by band, then text score; context only breaks what is left tied', () => {
  for (const [query] of GOLDEN) {
    // A context that would put the last result first if it could.
    const plain = find(query);
    const last = plain.at(-1)?.item.id;
    const boosted = find(query, { context: (t) => (t.id === last ? 1e9 : 0) });
    for (let i = 1; i < boosted.length; i++) {
      const [a, b] = [boosted[i - 1], boosted[i]];
      assert.ok(a.band > b.band || (a.band === b.band && a.score >= b.score), `${query}: ${a.item.id} before ${b.item.id}`);
    }
    assert.deepEqual(boosted.map((r) => [r.band, r.score]), plain.map((r) => [r.band, r.score]), query);
  }
  // Tied on band and score, context decides: Copy tables can pass PDF to Excel, never Extract pages.
  const tied = find('extract', { context: (t) => (t.id === 'copy-tables' ? 25 : 0) }).map((r) => r.item.id);
  assert.deepEqual(tied.slice(0, 2), ['extract-pages', 'copy-tables']);
});

test('the same query always gives the same order', () => {
  for (const [query] of GOLDEN) assert.deepEqual(find(query), find(query), query);
});

test('palette: typing any command’s whole label puts that command first', () => {
  const labels = new Map();
  for (const item of paletteItems) {
    const key = tokenise(item.label).join(' ');
    assert.ok(!labels.has(key), `“${item.label}” reads the same as ${labels.get(key)}’s label`);
    labels.set(key, item.id);
    assert.equal(paletteTop(item.label), item.id, `“${item.label}”`);
  }
});

test('palette: the phrases the e2e suites type still find their command', () => {
  const typed = {
    'Add text': 'edit.addText', 'Replace picture': 'edit.replacePicture', 'Insert picture': 'edit.insertPicture',
    'Text colour': 'edit.textColour', 'Bold text': 'edit.textBold', 'Compare documents': 'tools.compare',
    'Document history': 'file.history', 'HTML to PDF': 'pages.htmlToPdf', 'Images to PDF': 'pages.imagesToPdf',
    'Merge PDFs': 'pages.merge', 'Rotate page left': 'pages.rotateLeft', 'Rotate page right': 'pages.rotateRight',
    'Duplicate page': 'pages.duplicate', 'Watermark': 'pages.watermark', 'Page numbers': 'pages.numbers',
    'Crop pages': 'pages.crop', 'Space evenly down': 'arrange.spaceDown', 'About Vellum': 'app.about',
  };
  for (const [query, id] of Object.entries(typed)) assert.equal(paletteTop(query), id, query);
  // And a partial label still works as it did: a word at the start of a label counts more.
  assert.equal(rank(palette, 'rot pag').slice(0, 2).map((r) => r.item.id).sort().join(), 'pages.rotateLeft,pages.rotateRight');
  assert.match(commands[paletteTop('page')].label, /^Page /);
  assert.match(commands[paletteTop('zoo')].label, /^Zoom /);
});

test('palette: tool aliases find intents that labels don’t', () => {
  assert.equal(paletteTop('combine'), 'pages.merge');
  assert.equal(paletteTop('remove page'), 'pages.delete');
  assert.equal(paletteTop('pictures to pdf'), 'pages.imagesToPdf');
  assert.equal(paletteTop('excel'), 'export.excel');
  assert.equal(paletteTop('black out'), 'edit.redactSelection');
  // Fonts stay in the palette, under their own labels.
  assert.match(commands[paletteTop('new text in')].label, /^New text in /);
});
