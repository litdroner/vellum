// Vellum 0.6: setting a line of the page's own text in another face of its font that the same PDF has
// (editing/objects/run-face.js, the text writer objects/text-run.js, session.formatText with bold/italic).
//
// Pinned here: regular ↔ bold, regular ↔ italic and bold ↔ bold italic, one record and one undo step per
// change; saved and reopened it is the same editable text from the same baseline start, drawn by the
// sibling font object with the codes pdf.js confirmed that font draws, the original not drawn as well and
// no font added; back in its own style the record goes; moving, copying and pasting keep the face. Refused
// with nothing stored: a face the PDF hasn't got, a face that hasn't drawn every character of the line, a
// retyped line, retyping a line set in another face, a wider line that would run into a picture or past
// the page's edge — and the writer refuses a glyph table that doesn't match the font.
// Run: node --test "tests/editing/*.test.mjs"

import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { analyzeFile, engine, webModule, withSession } from './harness.mjs';
import { makeFixtures, FIXTURE_DIR } from './fixtures.mjs';

const { runFormatOf } = await engine('objects/run-format.js');
const { faceQuadOf, runFaceRefusal } = await engine('objects/run-face.js');
const { composeDocument } = await webModule('annotations/persist.js');

let files;
before(async () => { files = await makeFixtures(FIXTURE_DIR); });
const read = (name) => new Uint8Array(fs.readFileSync(files[name]));

const LINE = 'Plain sentence here';
const count = (bytes, pattern) => (Buffer.from(bytes).toString('latin1').match(pattern) ?? []).length;
const lineAt = (objects, y) => objects.find((o) => o.text === LINE && Math.abs(o.record.origin[1] - y) < 0.01);
const runAt = (page, text, y) => page.runs.find((r) => r.text === text && Math.abs(r.origin[1] - y) < 0.01);
const codesOf = (analysis, run) => run.glyphs.map(([s, g]) => analysis.shows[s].glyphs[g].code);
const depth = (store) => {
  let n = 0;
  while (store.canUndo) { store.undo(); n++; }
  for (let i = 0; i < n; i++) store.redo();
  return n;
};

test('regular ↔ bold, italic and bold italic: one step each, saved as the same text in the PDF’s own face', async () => {
  const bytes = read('faces');
  await withSession(bytes, async ({ store, session, sources, plan }) => {
    const { objects, analysis } = await session.objects(1);
    const line = lineAt(objects, 720);
    const key = line.ref.key;
    assert.deepEqual([runFormatOf(line.record).bold, runFormatOf(line.record).italic], [false, false]);
    const family = (await session.fontFamilies()).find((f) => f.id === 'doc:LiberationSans');
    assert.ok(family?.faces.every(Boolean), 'all four faces of the family are the PDF’s own');

    assert.equal(await session.formatText(1, [key], { bold: true }), true);
    assert.equal(await session.formatText(1, [key], { bold: true }), false, 'already bold: no step');
    let [record] = store.edits;
    assert.equal(store.edits.length, 1);
    assert.deepEqual([record.kind, record.encoding.mode, record.face.font, record.face.bold, record.face.italic], ['text', 'original', family.faces[1], true, false]);
    assert.equal(record.transform, undefined, 'nothing moved');
    assert.equal(runFaceRefusal(record.face), null);
    let live = lineAt((await session.objects(1)).objects, 720);
    assert.equal(runFormatOf(live.record, record).bold, true, 'the format bar reads it as bold');
    const wider = faceQuadOf(analysis, live.record, record.face);
    assert.ok(wider[2] > live.record.quad[2] && wider[0] === live.record.quad[0], 'longer, from the same start');

    const before = (await analyzeFile(bytes)).pages[0];
    const original = runAt(before, LINE, 720);
    const bold = runAt(before, 'Plain sentence here in bold', 690);
    let saved = await composeDocument({ base: bytes, plan, edits: store.edits, sources });
    let after = (await analyzeFile(saved)).pages[0];
    let runs = after.runs.filter((r) => r.text === LINE && Math.abs(r.origin[1] - 720) < 0.01);
    assert.equal(runs.length, 1, 'the original isn’t drawn as well');
    assert.ok(runs[0].editable, 'still editable text after reopening');
    assert.deepEqual(runs[0].origin.map((v) => Math.round(v * 1000) / 1000), original.origin, 'the baseline start stays put');
    assert.equal(runs[0].font.name, 'LiberationSans-Bold');
    assert.equal(runs[0].font.key, bold.font.key, 'the bold font object the PDF already has');
    assert.deepEqual(codesOf(after, runs[0]), codesOf(before, bold).slice(0, LINE.length), 'the codes that font draws those characters with');
    assert.equal(count(saved, /\/FontFile2/g), count(bytes, /\/FontFile2/g), 'no font added');
    assert.equal(after.images.length, before.images.length, 'nothing rasterized');
    assert.ok(Math.abs(runs[0].end[0] - wider[2]) < 0.05, `as long as it was said to be: ${runs[0].end[0]} vs ${wider[2]}`);

    // Bold italic, then italic off again: the bold face; then regular: no record at all.
    assert.equal(await session.formatText(1, [key], { italic: true }), true);
    [record] = store.edits;
    assert.equal(record.face.font, family.faces[3]);
    saved = await composeDocument({ base: bytes, plan, edits: store.edits, sources });
    after = (await analyzeFile(saved)).pages[0];
    assert.equal(runAt(after, LINE, 720).font.name, 'LiberationSans-BoldItalic');
    assert.equal(await session.formatText(1, [key], { italic: false }), true);
    assert.equal(store.edits[0].face.font, family.faces[1]);
    assert.equal(await session.formatText(1, [key], { bold: false }), true);
    assert.deepEqual(store.edits, [], 'back in its own face: nothing to store');
    assert.equal(depth(store), 4, 'one undo step per change');
    store.undo(); store.undo(); store.undo();
    assert.equal(store.edits[0].face.font, family.faces[1], 'undo brings the bold face back');
    store.redo(); store.redo(); store.redo();
    assert.deepEqual(store.edits, []);

    // Bold italic back to bold: the bold italic line's own face.
    const boldItalic = objects.find((o) => o.text === 'Plain sentence here bold italic');
    assert.deepEqual([runFormatOf(boldItalic.record).bold, runFormatOf(boldItalic.record).italic], [true, true]);
    assert.equal(await session.formatText(1, [boldItalic.ref.key], { italic: false }), true);
    assert.equal(store.edits[0].face.font, family.faces[1]);
    saved = await composeDocument({ base: bytes, plan, edits: store.edits, sources });
    assert.equal(runAt((await analyzeFile(saved)).pages[0], 'Plain sentence here bold italic', 630).font.name, 'LiberationSans-Bold');
  });
});

test('moved, copied and pasted, the line keeps its face; size and colour go with it', async () => {
  const bytes = read('faces');
  await withSession(bytes, async ({ store, session, sources, plan }) => {
    const key = lineAt((await session.objects(1)).objects, 720).ref.key;
    assert.equal(await session.formatText(1, [key], { bold: true }), true);
    assert.equal(await session.formatText(1, [key], { color: '#cc0000', size: 18 }), true);
    assert.equal(await session.transformObject(1, key, [1, 0, 0, 1, 0, 40]), true);
    const [record] = store.edits;
    assert.ok(record.face && record.format && record.transform, 'one record says all of it');
    const clip = await session.copyObjects(1, [key]);
    const [pasted] = await session.pasteObjects(1, clip, [1, 0, 0, 1, 0, -300]);
    const copy = store.edits.find((e) => e.kind === 'text-copy');
    assert.deepEqual(copy.face, record.face, 'the copy carries the face');
    assert.equal(store.edits.length, 2);

    const saved = await composeDocument({ base: bytes, plan, edits: store.edits, sources });
    const after = (await analyzeFile(saved)).pages[0];
    const runs = after.runs.filter((r) => r.text === LINE && r.font.name === 'LiberationSans-Bold');
    assert.equal(runs.length, 2, 'the moved line and its copy, both bold');
    for (const run of runs) assert.ok(run.editable && Math.abs(run.frame.size - 18) < 1e-3);
    assert.ok(runs.some((r) => Math.abs(r.origin[1] - 760) < 0.05) && runs.some((r) => Math.abs(r.origin[1] - 460) < 0.05), runs.map((r) => r.origin).join(' '));

    // The copy set back in the line's own face, on its own.
    assert.equal(await session.formatText(1, [pasted], { bold: false }), true);
    assert.equal(store.edits.find((e) => e.kind === 'text-copy').face, undefined);
    assert.ok(store.edits.find((e) => e.kind === 'text').face, 'the line it was copied from is still bold');
  });
});

test('refused with nothing stored: faces the PDF hasn’t got or hasn’t seen draw the line, retyping, width', async () => {
  await withSession(read('faces'), async ({ store, session }) => {
    const { objects } = await session.objects(1);
    const refused = async (keys, changes, reason) => {
      const kept = store.edits.slice();
      await assert.rejects(session.formatText(1, keys, changes), (err) => err.detail?.reason === reason, `${JSON.stringify(changes)}: ${reason}`);
      assert.deepEqual(store.edits, kept, `nothing stored for ${JSON.stringify(changes)}`);
    };
    const line = lineAt(objects, 720);
    await refused([line.ref.key], { italic: true }, 'glyphs');
    await assert.rejects(session.formatText(1, [line.ref.key], { italic: true }), /“h”, “r”/);
    await refused([lineAt(objects, 600).ref.key], { bold: true }, 'overlap');
    await refused([lineAt(objects, 570).ref.key], { bold: true }, 'bounds');
    await refused([objects.find((o) => o.text === 'Helvetica plain').ref.key], { bold: true }, 'face');
    await refused([line.ref.key], { bold: true, family: 'Times' }, 'font');

    // A retyped line keeps its own font; a line set in another face isn't retyped.
    assert.equal(await session.edit(1, line.record.key, 'Plain sentence'), true);
    await refused([line.ref.key], { bold: true }, 'retyped');
    store.undo();
    assert.equal(await session.formatText(1, [line.ref.key], { bold: true }), true);
    const kept = store.edits.slice();
    await assert.rejects(session.edit(1, line.record.key, 'Plain sentence'), (err) => err.detail?.reason === 'retype');
    assert.deepEqual(store.edits, kept);
    assert.equal(await session.edit(1, line.record.key, LINE), false, 'its own text again changes nothing');

    // Two lines at once, one of which can't: neither changes.
    store.undo();
    await refused([line.ref.key, lineAt(objects, 600).ref.key], { bold: true }, 'overlap');
  });
});

test('the writer checks the face against the font before drawing', async () => {
  const bytes = read('faces');
  await withSession(bytes, async ({ store, session, sources, plan }) => {
    const key = lineAt((await session.objects(1)).objects, 720).ref.key;
    assert.equal(await session.formatText(1, [key], { bold: true }), true);
    const [record] = store.edits;
    const wrong = (face) => [{ ...record, face }];
    const P = record.face.glyphs.P;
    for (const face of [
      { ...record.face, glyphs: { ...record.face.glyphs, P: [81, 1, P[2]] } }, // a code that means something else there
      { ...record.face, glyphs: { ...record.face.glyphs, P: [P[0], 1, P[2] + 1] } }, // a width the font doesn't have
      { ...record.face, glyphs: Object.fromEntries(Object.entries(record.face.glyphs).filter(([ch]) => ch !== 'e')) }, // a glyph of the line missing
      { ...record.face, font: 'doc:1-0' }, // another object
    ]) {
      await assert.rejects(composeDocument({ base: bytes, plan, edits: wrong(face), sources }), (err) => err.kind === 'changed', JSON.stringify(face.glyphs.P));
    }
    await assert.rejects(composeDocument({ base: bytes, plan, edits: wrong({ ...record.face, bold: 'yes' }), sources }), (err) => err.kind === 'content');
    await assert.rejects(composeDocument({ base: bytes, plan, edits: [{ ...record, encoding: { mode: 'font', items: [] } }], sources }), (err) => err.kind === 'content');
  });
});

test('a space the face hasn’t been seen to draw is a gap as wide as its space, with the line’s own spacing', async () => {
  const bytes = read('faces');
  await withSession(bytes, async ({ store, session, sources, plan }) => {
    const { objects, analysis } = await session.objects(1);
    // As pdf.js in the app reports it: the bold font's space not confirmed as a glyph in the font.
    objects.find((o) => o.text === 'Plain sentence here in bold').record.font.noteConflict(32);
    const line = lineAt(objects, 720);
    assert.equal(await session.formatText(1, [line.ref.key], { bold: true }), true);
    const [record] = store.edits;
    assert.deepEqual(record.face.glyphs[' '].slice(0, 2), [null, 0]);
    assert.equal(runFaceRefusal(record.face), null);
    const expected = faceQuadOf(analysis, line.record, record.face);

    const saved = await composeDocument({ base: bytes, plan, edits: store.edits, sources });
    const after = (await analyzeFile(saved)).pages[0];
    const run = runAt(after, LINE, 720);
    assert.ok(run?.editable, 'the same editable text, spaces and all');
    assert.equal(run.font.name, 'LiberationSans-Bold');
    assert.ok(!codesOf(after, run).includes(32), 'no space glyph drawn');
    assert.ok(Math.abs(run.end[0] - expected[2]) < 0.05, `as long as it was said to be: ${run.end[0]} vs ${expected[2]}`);
  });
});
