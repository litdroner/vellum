// Vellum 0.6: setting a line of the page's own text in another family of the fonts the same PDF has
// (editing/objects/run-face.js with { family }, session.formatText and session.runFontFamilies).
//
// Pinned here: the font menu lists the document's own families, the line's own marked and the ones it can't
// be set in said why; choosing one is one record and one undo step, keeps size and colour, and saved and
// reopened it is the same editable text from the same baseline start in that font object, no font added,
// nothing rasterized; its own family again, the face goes. Refused with nothing stored: a family that isn't
// the PDF's, a style that family hasn't got, characters it hasn't drawn, a wider line running into a picture.
// Run: node --test "tests/editing/*.test.mjs"

import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { analyzeFile, webModule, withSession } from './harness.mjs';
import { makeFixtures, FIXTURE_DIR } from './fixtures.mjs';

const { composeDocument } = await webModule('annotations/persist.js');

let files;
before(async () => { files = await makeFixtures(FIXTURE_DIR); });
const read = (name) => new Uint8Array(fs.readFileSync(files[name]));

const LINE = 'Plain sentence here';
const count = (bytes, pattern) => (Buffer.from(bytes).toString('latin1').match(pattern) ?? []).length;
const at = (objects, text, y) => objects.find((o) => o.text === text && Math.abs(o.record.origin[1] - y) < 0.01);
const runAt = (page, text, y) => page.runs.find((r) => r.text === text && Math.abs(r.origin[1] - y) < 0.01);

test('another family of the PDF’s own fonts: listed, one step, saved as the same editable text in that font', async () => {
  const bytes = read('families');
  await withSession(bytes, async ({ store, session, sources, plan }) => {
    const { objects } = await session.objects(1);
    const key = at(objects, LINE, 720).ref.key;
    const listed = await session.runFontFamilies(1, key);
    const sans = listed.find((f) => f.id === 'doc:LiberationSans');
    const fixed = listed.find((f) => /Fixed/.test(f.id));
    const serif = listed.find((f) => f.id !== sans?.id && f !== fixed);
    assert.ok(sans?.current && serif && !serif.current, JSON.stringify(listed));
    assert.equal(serif.refusal, null, 'the serif can be chosen');
    assert.equal(listed.length, 3, 'the document’s own families, each once (two Liberation Sans faces are one family)');
    assert.ok(fixed && !fixed.current && fixed.refusal, 'the family only page 2 has, not read yet: listed, can’t be chosen');
    await assert.rejects(session.formatText(1, [key], { family: fixed.id }), (err) => err.detail?.reason === 'family', 'and refused if asked for');
    assert.deepEqual(store.edits, [], 'nothing stored for it');
    const family = (await session.fontFamilies()).find((f) => f.id === serif.id);

    assert.equal(await session.formatText(1, [key], { size: 18, color: '#cc0000' }), true);
    assert.equal(await session.formatText(1, [key], { family: serif.id }), true);
    assert.equal(await session.formatText(1, [key], { family: serif.id }), false, 'already in it: no step');
    let [record] = store.edits;
    assert.equal(store.edits.length, 1);
    assert.deepEqual([record.encoding.mode, record.face.font, record.face.bold, record.face.italic], ['original', family.faces[0], false, false]);
    assert.equal(record.format.color, '#cc0000', 'the colour is kept');
    assert.ok((await session.runFontFamilies(1, key)).find((f) => f.id === serif.id).current, 'the menu reads the new family');

    const before = (await analyzeFile(bytes)).pages[0];
    const saved = await composeDocument({ base: bytes, plan, edits: store.edits, sources });
    const after = (await analyzeFile(saved)).pages[0];
    const runs = after.runs.filter((r) => r.text === LINE && Math.abs(r.origin[1] - 720) < 0.05);
    assert.equal(runs.length, 1, 'the original isn’t drawn as well');
    assert.ok(runs[0].editable, 'still editable text after reopening');
    assert.ok(runs[0].origin.every((v, i) => Math.abs(v - runAt(before, LINE, 720).origin[i]) < 0.05), 'the baseline start stays put');
    assert.equal(runs[0].font.key, runAt(before, 'Plain sentence here in serif', 690).font.key, 'the serif font object the PDF already has');
    assert.ok(Math.abs(runs[0].frame.size - 18) < 1e-3, 'the size is kept');
    assert.equal(count(saved, /\/FontFile[23]?/g), count(bytes, /\/FontFile[23]?/g), 'no font added');
    assert.equal(after.images.length, before.images.length, 'nothing rasterized');

    // Bold isn't a face the serif has; its own family again takes the face away, the format stays.
    await assert.rejects(session.formatText(1, [key], { bold: true }), (err) => err.detail?.reason === 'face');
    assert.equal(await session.formatText(1, [key], { family: sans.id }), true);
    assert.equal(store.edits[0].face, undefined);
    assert.equal(store.edits[0].format.color, '#cc0000');
    store.undo();
    assert.equal(store.edits[0].face.font, family.faces[0], 'undo brings the serif back');
    store.redo();
    assert.equal(store.edits[0].face, undefined);
  });
});

test('refused with nothing stored, and said in the menu: not the PDF’s, no such face, glyphs, width', async () => {
  await withSession(read('families'), async ({ store, session }) => {
    const { objects } = await session.objects(1);
    const serif = (await session.fontFamilies()).find((f) => f.group === 'document' && f.id !== 'doc:LiberationSans').id;
    const refused = async (object, changes, reason) => {
      await assert.rejects(session.formatText(1, [object.ref.key], changes), (err) => err.detail?.reason === reason, `${JSON.stringify(changes)}: ${reason}`);
      assert.deepEqual(store.edits, [], `nothing stored for ${JSON.stringify(changes)}`);
    };
    const line = at(objects, LINE, 720);
    await refused(line, { family: 'Times' }, 'font');
    await refused(line, { family: 'bundled:inter' }, 'font');
    await refused(line, { family: 'doc:NotInThisFile' }, 'family');
    const bold = at(objects, 'Plain sentence here in bold', 660);
    await refused(bold, { family: serif }, 'face');
    const quiz = at(objects, 'Plain quiz', 570);
    await refused(quiz, { family: serif }, 'glyphs');
    const narrow = at(objects, LINE, 600);
    await refused(narrow, { family: 'doc:LiberationSans' }, 'overlap');
    for (const [object, id] of [[bold, serif], [quiz, serif], [narrow, 'doc:LiberationSans']]) {
      const entry = (await session.runFontFamilies(1, object.ref.key)).find((f) => f.id === id);
      assert.ok(entry.refusal, `the menu says why for ${object.text}`);
    }
  });
});
