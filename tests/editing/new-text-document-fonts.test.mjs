// Vellum 0.6: new text in the opened PDF's own fonts (editing/objects/font-set.js, the document's own fonts).
//
// Pinned here: a document font is offered only once pdf.js has confirmed glyphs of it, grouped into
// families with its own bold and italic; only characters the document has been seen to draw in it are
// written, each with exactly that code and width, and anything else is refused with nothing changed; the
// record keeps that glyph table, and the writer checks it against the font before drawing, refusing the
// save when it doesn't match; the font program is never changed (the file gains no font); saved and
// reopened, the text is ordinary editable page text in that font; it can't be pasted into another document.
// Run: node --test "tests/editing/*.test.mjs"

import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { analyzeFile, engine, withSession } from './harness.mjs';
import { makeFixtures, FIXTURE_DIR } from './fixtures.mjs';

const { documentKey, tableFace } = await engine('objects/font-set.js');
const { EditError } = await engine('edits.js');
const { webModule } = await import('./harness.mjs');
const { composeDocument } = await webModule('annotations/persist.js');

let files;
before(async () => { files = await makeFixtures(FIXTURE_DIR); });
const read = (name) => new Uint8Array(fs.readFileSync(files[name]));

const UPRIGHT = [1, 0, 0, -1, 0, 0];
const LETTER = [0, 0, 612, 792];
const count = (bytes, pattern) => (Buffer.from(bytes).toString('latin1').match(pattern) ?? []).length;

test('the document’s own fonts: offered once confirmed, written only in glyphs it draws, checked when saved', async () => {
  const bytes = read('fonts');
  await withSession(bytes, async ({ store, session, sources, plan }) => {
    assert.ok(!(await session.fontFamilies()).some((f) => f.id.startsWith('doc:')), 'nothing offered before a page has been read');
    await session.objects(1);
    const families = await session.fontFamilies();
    assert.deepEqual(families.slice(0, 3).map((f) => f.id), ['Helvetica', 'Times', 'Courier'], 'the standard families first');
    const liberation = families.find((f) => f.id === 'doc:LiberationSans');
    assert.ok(liberation, JSON.stringify(families.map((f) => f.id)));
    assert.equal(liberation.name, 'Liberation Sans');
    assert.ok(documentKey(liberation.faces[0]) && documentKey(liberation.faces[1]), 'its regular and its bold, each a font object of the file');
    assert.equal(liberation.faces[2], null, 'no italic of it in the file');
    assert.ok(!families.some((f) => f.id === 'doc:Helvetica'), 'a standard font the file doesn’t embed isn’t offered as its own');

    const key = await session.insertText(1, { basis: UPRIGHT, box: LETTER });
    assert.equal(await session.edit(1, key, 'Liberation notes'), true);
    assert.equal(await session.formatText(1, [key], { family: 'doc:LiberationSans' }), true);
    let record = store.edits.at(-1);
    assert.equal(record.font, liberation.faces[0]);
    assert.deepEqual(Object.keys(record.glyphs), [record.font], 'the glyphs it is written with are kept');
    assert.deepEqual(Object.keys(record.glyphs[record.font]).join(''), 'Liberaton s', 'each character once, in the order the text uses it');
    const object = (await session.objects(1)).objects.find((o) => o.ref.key === key);
    assert.deepEqual([object.record.format.family, object.record.format.bold], ['doc:LiberationSans', false]);

    // Its bold is the file's own bold font; a character the document hasn't drawn in it is refused.
    assert.equal(await session.formatText(1, [key], { bold: true }), true);
    record = store.edits.at(-1);
    assert.equal(record.font, liberation.faces[1]);
    await assert.rejects(session.edit(1, key, 'Liberation Quiz'), (e) => e instanceof EditError && e.kind === 'characters' && /seen the document draw/.test(e.message));
    await assert.rejects(session.formatText(1, [key], { italic: true }), (e) => e.kind === 'content' && /style asked for/.test(e.message));
    assert.equal(store.edits.at(-1), record, 'nothing changed');

    // It can't be pasted into another document, where that font object means something else.
    const clip = await session.copyObjects(1, [key]);
    await withSession(read('simple'), async ({ store: other, session: into }) => {
      await into.objects(1);
      await assert.rejects(into.pasteObjects(1, clip), (e) => e.kind === 'paste');
      assert.equal(other.edits.length, 0);
    });

    // Saved: the same font object, no new font program, and the text reopens as editable text in it.
    const saved = await composeDocument({ base: bytes, plan, edits: store.edits, sources });
    assert.equal(count(saved, /\/FontFile2/g), count(bytes, /\/FontFile2/g), 'no font was added to the file');
    const after = await analyzeFile(saved);
    const line = after.pages[0].runs.find((r) => r.text === 'Liberation notes');
    assert.ok(line, JSON.stringify(after.pages[0].runs.map((r) => r.text)));
    assert.match(line.font.name, /LiberationSans-Bold/);
    assert.ok(line.editable, [...line.reasons].join(', '));

    // A record whose glyphs don't match the font is never written.
    const tampered = store.edits.map((e) => (e === record
      ? { ...e, glyphs: { [e.font]: { ...e.glyphs[e.font], L: [e.glyphs[e.font].L[0], 1, e.glyphs[e.font].L[2] + 1] } } }
      : e));
    await assert.rejects(composeDocument({ base: bytes, plan, edits: tampered, sources }), (e) => e instanceof EditError && /can’t be written/.test(e.message));
  });
});

test('a space the font doesn’t draw is a gap in a TJ; every other glyph its own code and width', () => {
  const face = tableFace({ a: [0x41, 2, 500], ' ': [null, 0, 278] }, { name: 'Test', ascent: 0.9, descent: -0.2 });
  assert.equal(face.show('aa'), '<00410041> Tj');
  assert.equal(face.show('a  a'), '[<0041> -278 -278 <0041>] TJ');
  assert.equal(face.advance('a a'), 1.278);
  assert.deepEqual(face.missing('ab\n'), ['b']);
});

test('a composite (Type 0) font of the document: its two-byte codes, saved and reopened as its text', async () => {
  const bytes = read('composite');
  await withSession(bytes, async ({ store, session, sources, plan }) => {
    await session.objects(1);
    const family = (await session.fontFamilies()).find((f) => f.id.startsWith('doc:') && f.faces[0]);
    assert.ok(family, 'the composite font is offered');
    const key = await session.insertText(1, { basis: UPRIGHT, box: LETTER });
    assert.equal(await session.edit(1, key, 'font text spaces'), true);
    assert.equal(await session.formatText(1, [key], { family: family.id }), true);
    const record = store.edits.at(-1);
    assert.equal(record.glyphs[record.font].f[1], 2, 'two-byte codes, as the font has them');

    const saved = await composeDocument({ base: bytes, plan, edits: store.edits, sources });
    const after = await analyzeFile(saved);
    const line = after.pages[0].runs.find((r) => r.text.replace(/\s+/g, ' ') === 'font text spaces');
    assert.ok(line, JSON.stringify(after.pages[0].runs.map((r) => r.text)));
    assert.equal(line.font.kind, 'type0');
  });
});
