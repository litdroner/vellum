// Vellum 0.6: new text boxes with several lines, wrapping and formatting (editing/objects/text-format.js,
// editing/objects/inserted-text.js planFormat, editing/session.js formatText).
//
// Pinned here: lines break where they were typed and wrap at spaces to the box's width, aligned within it;
// formatting (the font's family, size, the family's own bold and italic, underline, alignment, colour, opacity) is
// validated and refused in plain words, never substituted; the writer draws every line as real text with
// its colour, opacity and underline; formatting is one undo step, keeps the box's top-left corner, and
// survives moving, turning, copying, pasting onto another page and into another document, cutting and
// undo; saved and reopened, the lines are ordinary editable page text in the chosen face, size and colour.
// Run: node --test "tests/editing/*.test.mjs"

import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { analyzeFile, engine, loadPdfLib, webModule, withSession } from './harness.mjs';
import { makeFixtures, FIXTURE_DIR } from './fixtures.mjs';

const { planNewText, planFormat, write } = await engine('objects/inserted-text.js');
const { layoutText, standardFace, styledFont, styleOf, formatOf, FAMILY_NAMES, LINE_SPACING } = await engine('objects/text-format.js');
const { EditError } = await engine('edits.js');
const { quarterTurn } = await engine('objects/transform.js');
const { quadCentre, transformQuad } = await engine('objects/geometry.js');
const { apply } = await engine('matrix.js');
const { composeDocument } = await webModule('annotations/persist.js');

let files;
before(async () => { files = await makeFixtures(FIXTURE_DIR); });
const read = (name) => new Uint8Array(fs.readFileSync(files[name]));

const UPRIGHT = [1, 0, 0, -1, 0, 0];
const LETTER = [0, 0, 612, 792];
const near = (a, b, tol = 1e-3) => Math.abs(a - b) <= tol;
const depth = (store) => {
  let n = 0;
  while (store.canUndo) { store.undo(); n++; }
  for (let i = 0; i < n; i++) store.redo();
  return n;
};

test('layout: typed line breaks, wrapping at spaces to the width, alignment within the box', async () => {
  const lib = await loadPdfLib();
  const face = standardFace(lib, 'Helvetica');
  const w = (s) => face.advance(s) * 10;

  const typed = layoutText(face, { text: 'One\nTwo three\n\nFour', size: 10 });
  assert.deepEqual(typed.lines.map((l) => l.text), ['One', 'Two three', '', 'Four']);
  assert.deepEqual(typed.lines.map((l) => l.y), [0, -12, -24, -36]);
  assert.ok(near(typed.box[2], w('Two three')), 'as wide as the widest line');
  assert.ok(near(typed.box[1], -36 + face.descent * 10) && near(typed.box[3], face.ascent * 10));

  const width = Math.max(w('alpha beta'), w('gamma delta')) + 0.5;
  assert.ok(w('alpha beta gamma') > width, 'the third word doesn’t fit on the first line');
  const wrapped = layoutText(face, { text: 'alpha beta gamma delta', size: 10, width, align: 'right' });
  assert.deepEqual(wrapped.lines.map((l) => l.text), ['alpha beta', 'gamma delta']);
  assert.equal(wrapped.box[2], Math.round(width * 1e4) / 1e4);
  for (const line of wrapped.lines) assert.ok(near(line.x + line.advance, width), 'right-aligned to the box');
  const centred = layoutText(face, { text: 'alpha beta gamma delta', size: 10, width, align: 'center' });
  assert.ok(near(centred.lines[1].x, (width - w('gamma delta')) / 2));

  const long = layoutText(face, { text: 'Supercalifragilistic', size: 10, width: w('Super') });
  assert.ok(long.lines.length > 1 && long.lines.join('') !== '' && long.lines.map((l) => l.text).join('') === 'Supercalifragilistic', 'a word wider than the box breaks between characters');
  for (const line of long.lines) assert.ok(line.advance <= w('Super') + 1e-6);
  assert.equal(LINE_SPACING, 1.2);
});

test('format: the family’s own bold and italic, and refusals in plain words, never a substitute', async () => {
  const lib = await loadPdfLib();
  assert.equal(styledFont('Helvetica', { bold: true, italic: true }), 'Helvetica-BoldOblique');
  assert.equal(styledFont('Times-Bold', { bold: false, italic: true }), 'Times-Italic');
  assert.equal(styledFont('Courier-Oblique', { bold: true }), 'Courier-BoldOblique');
  assert.deepEqual(styleOf('Times-Roman'), { family: 'Times', bold: false, italic: false });
  assert.equal(styledFont('Arial', { bold: true }), null);
  assert.equal(formatOf({ color: '#FF0000' }).format.color, '#ff0000');

  const base = { lib, text: 'Hi', transform: [1, 0, 0, 1, 72, 700], entry: 'e' };
  const refused = (fields, kind) => assert.throws(() => planNewText({ ...base, ...fields }),
    (e) => e instanceof EditError && e.kind === kind && typeof e.message === 'string', JSON.stringify(fields));
  refused({ size: 1001 }, 'content');
  refused({ color: 'red' }, 'content');
  refused({ opacity: 0 }, 'content');
  refused({ align: 'justify' }, 'content');
  refused({ width: 0 }, 'content');
  refused({ underline: 'yes' }, 'content');
  refused({ font: 'Arial-Bold' }, 'not-editable');
  refused({ text: 'Line one\nनमस्ते', font: 'Times-Bold' }, 'characters');

  const record = planNewText({ ...base, text: 'First line\r\nsecond\tline' });
  assert.deepEqual(Object.keys(record), ['id', 'kind', 'entry', 'text', 'font', 'size', 'underline', 'align', 'color', 'opacity', 'width', 'box', 'transform']);
  assert.equal(record.text, 'First line\nsecond line');
  // Formatting keeps the box's top-left corner where it was.
  const bigger = planFormat({ lib, record, changes: { size: 24, bold: true, italic: true, align: 'center', color: '#2F6FD6', opacity: 0.5, underline: true, width: 120 } });
  assert.deepEqual([bigger.font, bigger.size, bigger.align, bigger.color, bigger.opacity, bigger.underline, bigger.width], ['Helvetica-BoldOblique', 24, 'center', '#2f6fd6', 0.5, true, 120]);
  const topLeft = (r) => apply(r.transform, r.box[0], r.box[3]);
  assert.ok(topLeft(bigger).every((v, i) => near(v, topLeft(record)[i])), `${topLeft(bigger)} vs ${topLeft(record)}`);
  assert.equal(bigger.id, record.id);
});

test('the writer draws every line as real text, in its colour and opacity, with its underline', async () => {
  const lib = await loadPdfLib();
  const doc = await lib.PDFDocument.create();
  const page = doc.addPage([612, 792]);
  const plain = planNewText({ lib, text: 'One', transform: [1, 0, 0, 1, 72, 700], entry: 'e' });
  const styled = planNewText({ lib, text: 'Two\nThree', font: 'Times-Bold', size: 20, color: '#ff0000', opacity: 0.4, underline: true, align: 'right', transform: [1, 0, 0, 1, 72, 500], entry: 'e' });
  const { patches, append } = write({ lib, doc, page, index: 0, records: [plain, styled] });
  assert.deepEqual(patches, []);
  assert.match(append[0], /^q\n1 0 0 1 72 700 cm\nBT\n\/VlF1 12 Tf\n0 g\n0 Tc 0 Tw 100 Tz 0 Ts 0 Tr\n1 0 0 1 0 0 Tm\n<4f6e65> Tj\nET\nQ$/);
  assert.match(append[1], /^q\n1 0 0 1 72 500 cm\n\/VlGS1 gs\nBT\n\/VlF2 20 Tf\n1 0 0 rg\n/);
  assert.equal((append[1].match(/ Tj$/gm) ?? []).length, 2, 'two lines of text');
  assert.match(append[1], /\n1 0 0 1 [\d.]+ -24 Tm\n/, 'the second line one line spacing down');
  assert.equal((append[1].match(/ re f$/gm) ?? []).length, 2, 'an underline under each line');
  const state = page.node.Resources().lookup(lib.PDFName.of('ExtGState')).lookup(lib.PDFName.of('VlGS1'));
  assert.equal(state.lookup(lib.PDFName.of('ca')).asNumber(), 0.4);
  assert.throws(() => write({ lib, doc, page, index: 0, records: [{ ...styled, color: 'blue' }] }), EditError, 'an unusable format never reaches the file');
});

test('formatted new text in a session: one undo step each, kept through move, turn, copy, paste and cut; saved as editable text', async () => {
  const bytes = read('crosspage');
  await withSession(bytes, async ({ store, session, sources, plan }) => {
    const key = await session.insertText(1, { basis: UPRIGHT, box: LETTER });
    assert.equal(await session.edit(1, key, 'Quarterly notes\nsecond line of the box'), true, 'retyped over several lines');
    assert.equal(store.edits[0].text, 'Quarterly notes\nsecond line of the box');
    assert.deepEqual((await session.preview(1, key, 'a\nb')), { ok: true, mode: 'new', font: 'Helvetica', missing: [] });

    const changes = { size: 18, bold: true, italic: true, underline: true, align: 'center', color: '#1f9e6b', opacity: 0.6 };
    assert.equal(await session.formatText(1, [key], changes), true);
    assert.equal(await session.formatText(1, [key], changes), false, 'the same format again changes nothing');
    assert.equal(await session.formatText(1, [key], { width: 90 }), true, 'wrapped to a width');
    await assert.rejects(session.formatText(1, [key], { size: 5000 }), (e) => e.kind === 'content');
    assert.equal(store.edits.length, 1, 'still its one record');
    const formatted = { ...store.edits[0] };
    assert.deepEqual([formatted.font, formatted.size, formatted.underline, formatted.align, formatted.color, formatted.opacity, formatted.width],
      ['Helvetica-BoldOblique', 18, true, 'center', '#1f9e6b', 0.6, 90]);

    // Page text isn't new text: formatting it is refused, with nothing changed.
    const pageRun = (await session.objects(1)).objects.find((o) => o.kind === 'text-run' && !o.ref.newText);
    await assert.rejects(session.formatText(1, [pageRun.ref.key], { bold: true }), (e) => e.kind === 'format');

    let object = (await session.objects(1)).objects.find((o) => o.ref.key === key);
    assert.equal(object.record.format.bold, true);
    assert.equal(object.record.format.color, '#1f9e6b');
    const centre = quadCentre(transformQuad(object.geometry.quad, store.edits[0].transform));
    assert.equal(await session.transformObjects(1, [{ key, delta: [1, 0, 0, 1, 10, -300] }]), true);
    assert.equal(await session.transformObjects(1, [{ key, delta: quarterTurn([centre[0] + 10, centre[1] - 300], 1) }], { verb: 'rotate' }), true);
    const kept = (r) => [r.text, r.font, r.size, r.underline, r.align, r.color, r.opacity, r.width];
    assert.deepEqual(kept(store.edits[0]), kept(formatted), 'moving and turning keep the format');

    const clip = await session.copyObjects(1, [key]);
    const [onPage2] = await session.pasteObjects(2, clip);
    assert.match(onPage2, /^text:/);
    assert.deepEqual(kept(store.edits.find((e) => e.id !== formatted.id)), kept(formatted), 'pasted onto another page with its format');
    assert.equal(depth(store), 7, 'add, retype, format, width, move, turn, paste');

    // Into another document, formatted.
    await withSession(read('simple'), async ({ store: other, session: into }) => {
      const [pasted] = await into.pasteObjects(1, clip);
      assert.match(pasted, /^text:/);
      assert.deepEqual(kept(other.edits[0]), kept(formatted));
    });

    // Saved: every line is ordinary editable page text in the chosen face, size and colour, with its
    // opacity and underline; nothing rasterized.
    const saved = await composeDocument({ base: bytes, plan, edits: store.edits, sources });
    const before = await analyzeFile(bytes);
    const after = await analyzeFile(saved);
    const lines = after.pages[0].runs.filter((r) => r.font?.name === 'Helvetica-BoldOblique');
    assert.ok(lines.length >= 3, `wrapped into lines: ${lines.map((r) => r.text).join(' | ')}`);
    assert.equal(lines.map((r) => r.text).join(' ').replace(/\s+/g, ' '), 'Quarterly notes second line of the box');
    for (const run of lines) {
      assert.ok(run.editable, [...run.reasons].join(', '));
      assert.ok(near(run.frame.size, 18));
      assert.deepEqual(run.first.fill.color.args.map((v) => Math.round(v * 255)), [0x1f, 0x9e, 0x6b]);
      assert.equal(run.first.gsNames.length, 1, 'drawn with its opacity state');
    }
    assert.ok(after.pages[1].runs.some((r) => r.font?.name === 'Helvetica-BoldOblique' && r.text === 'Quarterly'), 'the copy on page 2');
    assert.equal(after.pages[0].images.length, before.pages[0].images.length, 'nothing rasterized');
    const doc = await (await loadPdfLib()).PDFDocument.load(saved);
    const states = doc.getPage(0).node.Resources().lookup((await loadPdfLib()).PDFName.of('ExtGState'));
    assert.ok(states && states.keys().some((k) => /VlGS/.test(k.asString())), 'the opacity is an ExtGState of the page');

    // Reopened, a saved line is text Vellum edits like any other.
    await withSession(saved, async ({ store: reopened, session: again }) => {
      const { runs } = await again.page(1);
      const item = runs.find((r) => r.run.text === lines[0].text);
      assert.ok(item, 'the line is a run of the reopened page');
      assert.equal(await again.edit(1, item.run.key, 'Annual notes'), true);
      assert.equal(reopened.edits.length, 1);
    });

    // Cut (removed) and undone, the format comes back with it.
    await session.removeObjects(1, [key]);
    assert.equal(store.edits.length, 1);
    store.undo();
    assert.deepEqual(kept(store.edits.find((e) => e.id === formatted.id)), kept(formatted));
  });
});

test('font selection: another standard family, its bold and italic kept, laid out again in its own widths', async () => {
  const lib = await loadPdfLib();
  assert.deepEqual(FAMILY_NAMES, ['Helvetica', 'Times', 'Courier'], 'the fonts new text may be written in');
  assert.equal(styledFont('Helvetica-BoldOblique', { family: 'Times' }), 'Times-BoldItalic', 'the family’s own face, not a slant');
  assert.equal(styledFont('Times-Italic', { family: 'Courier' }), 'Courier-Oblique');
  assert.equal(styledFont('Helvetica', { family: 'Times', bold: true }), 'Times-Bold', 'a family and a style at once');
  assert.equal(styledFont('Helvetica', { family: 'Liu' }), null, 'a font Vellum doesn’t have is never substituted');
  assert.equal(styledFont('Arial', { family: 'Times' }), null);

  const base = { lib, text: 'alpha beta gamma delta', transform: [1, 0, 0, 1, 72, 700], entry: 'e', width: 70, font: 'Helvetica-Bold' };
  const record = planNewText(base);
  const courier = planFormat({ lib, record, changes: { family: 'Courier' } });
  assert.equal(courier.font, 'Courier-Bold', 'bold kept through the change of family');
  assert.equal(courier.id, record.id, 'the same record, formatted');
  const laid = layoutText(standardFace(lib, 'Courier-Bold'), { text: base.text, size: courier.size, width: 70 });
  assert.deepEqual(courier.box, laid.box);
  assert.deepEqual(laid.lines.map((l) => l.text), ['alpha', 'beta', 'gamma', 'delta']);
  assert.ok(laid.lines.length > layoutText(standardFace(lib, 'Helvetica-Bold'), { text: base.text, size: record.size, width: 70 }).lines.length,
    'Courier is wider, so the same box wraps into more lines');
  const topLeft = (r) => apply(r.transform, r.box[0], r.box[3]);
  assert.ok(topLeft(courier).every((v, i) => near(v, topLeft(record)[i])), 'the box’s top-left corner stays where it was');

  // A font Vellum doesn't have is refused in plain words, with nothing changed.
  assert.throws(() => planFormat({ lib, record, changes: { family: 'Liu' } }),
    (e) => e instanceof EditError && e.kind === 'content' && /standard PDF fonts/.test(e.message));
  assert.throws(() => planFormat({ lib, record, changes: { family: 'Times New Roman' } }), EditError);
  // A character the chosen face can't write is refused, not drawn in another font.
  assert.throws(() => planFormat({ lib, record: planNewText({ ...base, text: 'Hi' }), changes: { family: 'Times', size: 5000 } }), EditError);
});

test('font selection in a session: one undo step, written and reopened in the chosen font', async () => {
  const bytes = read('crosspage');
  await withSession(bytes, async ({ store, session, sources, plan }) => {
    const key = await session.insertText(1, { basis: UPRIGHT, box: LETTER });
    assert.equal(await session.edit(1, key, 'Quarterly notes'), true);
    assert.equal(await session.formatText(1, [key], { bold: true, italic: true }), true);
    assert.equal(await session.formatText(1, [key], { family: 'Times' }), true);
    assert.equal(store.edits[0].font, 'Times-BoldItalic', 'the family chosen, the style kept');
    assert.equal(await session.formatText(1, [key], { family: 'Times' }), false, 'the same font again changes nothing');
    await assert.rejects(session.formatText(1, [key], { family: 'Liu' }), (e) => e.kind === 'content');
    assert.equal(store.edits[0].font, 'Times-BoldItalic', 'a refused font changes nothing');
    assert.equal(store.edits.length, 1, 'still its one record');
    assert.equal(depth(store), 4, 'add, retype, bold and italic, font');

    // Page text isn't new text: its font is not changed here.
    const pageRun = (await session.objects(1)).objects.find((o) => o.kind === 'text-run' && !o.ref.newText);
    await assert.rejects(session.formatText(1, [pageRun.ref.key], { family: 'Times' }), (e) => e.kind === 'format');

    const object = (await session.objects(1)).objects.find((o) => o.ref.key === key);
    assert.equal(object.record.format.family, 'Times', 'the format bar reads the family off the record');

    const saved = await composeDocument({ base: bytes, plan, edits: store.edits, sources });
    const after = await analyzeFile(saved);
    const line = after.pages[0].runs.find((r) => r.text === 'Quarterly notes');
    assert.ok(line, 'the line is on the page');
    assert.equal(line.font.name, 'Times-BoldItalic');
    assert.ok(line.editable, [...line.reasons].join(', '));
  });
});
