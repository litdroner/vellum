// Vellum 0.6: fonts for new text beyond the standard families — the font set (editing/objects/font-set.js)
// and bundled fonts, read by the vendored fontkit and embedded, subset, by pdf-lib when saved.
//
// Pinned here: a bundled face is measured the way pdf-lib writes it (glyph advances, nothing shaped between
// glyphs), so layout and the file agree; a font set offers only the families it could read, each with the
// faces it really has; choosing a bundled family keeps bold and italic where the family has them and is
// refused, with nothing changed, where it hasn't; a character the face lacks, or a font whose licence flags
// don't allow embedding, is refused; one box may mix a standard and a bundled face; saved, the text is real
// page text in an embedded subset of the font, which reopens as editable text.
//
// The fonts here are test registrations of the Liberation Sans files pdf.js ships (web/vendor/pdfjs/
// standard_fonts), not fonts Vellum offers. Run: node --test "tests/editing/*.test.mjs"

import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { STANDARD_FONTS, analyzeFile, engine, loadPdfLib, webModule, withSession } from './harness.mjs';
import { makeFixtures, FIXTURE_DIR } from './fixtures.mjs';

const { planNewText, planFormat } = await engine('objects/inserted-text.js');
const { layoutText, bundledKey, styleOf, formatOf } = await engine('objects/text-format.js');
const { fontSet, fontkitFace, loadFontkit, registerBundledFamily, noShaping } = await engine('objects/font-set.js');
const { EditError } = await engine('edits.js');
const { composeDocument } = await webModule('annotations/persist.js');

const font = (file) => new Uint8Array(fs.readFileSync(path.join(STANDARD_FONTS, file)));
const REGULAR = font('LiberationSans-Regular.ttf');
const BOLD = font('LiberationSans-Bold.ttf');

/** A copy of a TrueType font whose OS/2 fsType says `flags` (0x0002: restricted licence embedding). */
function withFsType(bytes, flags) {
  const copy = bytes.slice();
  const view = new DataView(copy.buffer);
  const tables = view.getUint16(4);
  for (let i = 0; i < tables; i++) {
    const at = 12 + i * 16;
    if (String.fromCharCode(...copy.subarray(at, at + 4)) === 'OS/2') {
      view.setUint16(view.getUint32(at + 8) + 8, flags);
      return copy;
    }
  }
  throw new Error('no OS/2 table');
}

registerBundledFamily({ id: 'test-sans', name: 'Test Sans', faces: { regular: REGULAR, bold: BOLD } });
registerBundledFamily({ id: 'test-locked', name: 'Test Locked', faces: { regular: withFsType(REGULAR, 0x0002) } });
registerBundledFamily({ id: 'test-missing', name: 'Test Missing', faces: { regular: async () => { throw new Error('no file'); } } });

let files;
before(async () => { files = await makeFixtures(FIXTURE_DIR); });
const read = (name) => new Uint8Array(fs.readFileSync(files[name]));

const UPRIGHT = [1, 0, 0, -1, 0, 0];
const LETTER = [0, 0, 612, 792];
const near = (a, b, tol = 1e-6) => Math.abs(a - b) <= tol;
const base = (lib, fonts, fields) => ({ lib, fonts, text: 'Quarterly notes', transform: [1, 0, 0, 1, 72, 700], entry: 'e1', ...fields });

test('a bundled face measures what pdf-lib writes: glyph advances, nothing shaped, adding up however text is broken', async () => {
  const lib = await loadPdfLib();
  const fontkit = await loadFontkit();
  const parsed = fontkit.create(REGULAR);
  const face = fontkitFace(parsed, { name: 'Test Sans' });
  const doc = await lib.PDFDocument.create();
  doc.registerFontkit(fontkit);
  const embedded = await doc.embedFont(REGULAR, { subset: true, features: noShaping() });
  for (const text of ['Quarterly notes', 'office affine fiddle', 'AVAWAY To.', 'Ünïcødé — “quotes”']) {
    assert.ok(near(face.advance(text) * 1000, embedded.widthOfTextAtSize(text, 1000), 1e-6), `${text}: as pdf-lib measures it`);
    for (let cut = 1; cut < text.length; cut++) {
      assert.ok(near(face.advance(text), face.advance(text.slice(0, cut)) + face.advance(text.slice(cut))), `${text} broken at ${cut}`);
    }
  }
  assert.deepEqual(face.missing('Hello 中文 ok\n'), ['中', '文'], 'what the font hasn’t got, each once');
  assert.ok(face.ascent > 0.8 && face.descent < 0 && face.underline.thickness > 0);
});

test('a font set: the standard families, then the bundled families it could read, with the faces they have', async () => {
  const lib = await loadPdfLib();
  const fonts = await fontSet(lib);
  assert.ok(fonts.families.some((f) => f.id === 'bundled:test-missing'), 'listed before any file is read');
  assert.equal(fonts.face('bundled:test-sans/regular'), null, 'a face is measured only once it has been read');
  await fonts.load(['bundled:test-sans', 'bundled:test-locked/regular', 'bundled:test-missing/regular']);
  const ids = fonts.families.map((f) => f.id);
  assert.deepEqual(ids.slice(0, 3), ['Helvetica', 'Times', 'Courier']);
  assert.ok(ids.includes('bundled:test-sans') && ids.includes('bundled:test-locked'));
  assert.ok(!ids.includes('bundled:test-missing'), 'a family whose file can’t be read isn’t offered');
  const sans = fonts.families.find((f) => f.id === 'bundled:test-sans');
  assert.equal(sans.name, 'Test Sans');
  assert.deepEqual(sans.faces, ['bundled:test-sans/regular', 'bundled:test-sans/bold', null, null]);
  assert.equal(fonts.face('bundled:test-sans/regular').name, 'Test Sans');
  assert.equal(fonts.face('bundled:test-sans/bold').name, 'Test Sans Bold');
  assert.equal(fonts.face('bundled:test-sans/italic'), null, 'a face the family hasn’t got');
  assert.equal(fonts.face('Helvetica').name, 'Helvetica');
  assert.deepEqual(bundledKey('bundled:test-sans/bold-italic'), { family: 'bundled:test-sans', style: 'bold-italic' });
  assert.equal(bundledKey('bundled:Test Sans/bold'), null);
  assert.deepEqual(styleOf('bundled:test-sans/bold'), { family: 'bundled:test-sans', bold: true, italic: false });
  assert.ok(formatOf({ font: 'bundled:test-sans/regular' }).format, 'a record may name a bundled font');
  assert.equal(formatOf({ font: 'Garamond' }).bad, 'font');
});

test('new text in a bundled family: laid out in its widths, its own bold kept, refusals with nothing changed', async () => {
  const lib = await loadPdfLib();
  const fonts = await fontSet(lib);
  await fonts.load(['bundled:test-sans', 'bundled:test-locked', 'bundled:test-missing']);
  const record = planNewText(base(lib, fonts, { size: 14 }));
  const bold = planFormat({ fonts, record: planFormat({ fonts, record, changes: { bold: true } }), changes: { family: 'bundled:test-sans' } });
  assert.equal(bold.font, 'bundled:test-sans/bold', 'the family chosen, its own bold face kept');
  assert.deepEqual(bold.box, layoutText(fonts.face('bundled:test-sans/bold'), { text: bold.text, size: 14 }).box, 'measured in that face');
  assert.equal(planFormat({ fonts, record: bold, changes: { family: 'Times' } }).font, 'Times-Bold', 'and back to a standard family');

  assert.throws(() => planFormat({ fonts, record: bold, changes: { italic: true } }),
    (e) => e instanceof EditError && e.kind === 'content' && /style asked for/.test(e.message), 'a face the family hasn’t got');
  assert.throws(() => planFormat({ fonts, record, changes: { family: 'bundled:test-missing' } }),
    (e) => e instanceof EditError && /can write new text in/.test(e.message), 'a family that couldn’t be read');
  assert.throws(() => planFormat({ fonts, record, changes: { family: 'bundled:test-locked' } }),
    (e) => e instanceof EditError && e.kind === 'font' && /licence/.test(e.message), 'a font whose licence doesn’t allow embedding');
  const regular = planFormat({ fonts, record, changes: { family: 'bundled:test-sans' } });
  assert.throws(() => planFormat({ fonts, record: regular, changes: {}, text: 'Notes 中文' }),
    (e) => e instanceof EditError && e.kind === 'characters' && /Test Sans, which has no “中”, “文”/.test(e.message));
  assert.throws(() => planFormat({ fonts, record: regular, changes: {}, text: 'Notes שלום' }),
    (e) => e instanceof EditError && e.kind === 'characters' && /shaped together/.test(e.message), 'a script that needs shaping isn’t written glyph by glyph');
  // Without the font set, a bundled font is a font Vellum can't write in: never drawn in another one.
  assert.throws(() => planNewText({ lib, ...regular }), (e) => e instanceof EditError && /can write new text in/.test(e.message));
});

test('a box mixing a standard and a bundled face, saved: real text in an embedded subset, reopened as editable text', async () => {
  const bytes = read('simple');
  await withSession(bytes, async ({ store, session, sources, plan }) => {
    const families = await session.fontFamilies();
    assert.ok(families.some((f) => f.id === 'bundled:test-sans'), 'the session offers the bundled family');
    const key = await session.insertText(1, { basis: UPRIGHT, box: LETTER });
    assert.equal(await session.edit(1, key, 'Quarterly notes'), true);
    assert.equal(await session.formatText(1, [key], { family: 'bundled:test-sans' }, { range: [10, 15] }), true);
    const record = store.edits[0];
    assert.equal(record.font, 'Helvetica');
    assert.deepEqual(record.spans, [{ n: 10 }, { n: 5, font: 'bundled:test-sans/regular' }]);

    // Moving it is planned in the same fonts.
    const object = (await session.objects(1)).objects.find((o) => o.ref.key === key);
    assert.equal(object.record.spans[1].format.family, 'bundled:test-sans');
    assert.equal(await session.transformObjects(1, [{ key, delta: [1, 0, 0, 1, 5, 5] }]), true);

    const saved = await composeDocument({ base: bytes, plan, edits: store.edits, sources });
    const text = Buffer.from(saved).toString('latin1');
    assert.match(text, /\/FontFile2/, 'the font program is embedded');
    assert.match(text, /\/CIDFontType2/, 'as a composite font of its glyphs');
    assert.ok(saved.length < bytes.length + 60000, 'a subset, not the whole font');

    const after = await analyzeFile(saved);
    const runs = after.pages[0].runs;
    const standardPart = runs.find((r) => r.text.startsWith('Quarterly'));
    const bundledPart = runs.find((r) => r.text.includes('notes') && r !== standardPart) ?? standardPart;
    assert.ok(standardPart && /Helvetica/.test(standardPart.font.name), JSON.stringify(runs.map((r) => [r.text, r.font?.name])));
    assert.ok(/LiberationSans/.test(bundledPart.font.name), 'the bundled piece is in the embedded font');
    assert.ok(bundledPart.font.embedded);
    assert.ok(bundledPart.editable, [...bundledPart.reasons].join(', '));
  });
});
