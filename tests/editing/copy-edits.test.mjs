// Vellum 0.6: retyping, reflowing and replacing a pasted copy before the document is saved
// (editing/session.js, editing/objects/copies.js).
//
// A pasted copy is changed through its one record: retyping and reflowing put the text and encoding the
// text planner chose (the run's own font, a standard font of the same style, or a refusal) into the
// `text-copy` record; replacing puts a picture into the `image-copy` record. Id, fingerprint, origin and
// placement stay. Pinned here: each is one undo step; the saved file draws the new text in the copied
// run's own font and the new picture in the copy's frame — on the same page, another page and in another
// document — with the original untouched; what can't be done is refused with nothing stored.
// Run: node --test "tests/editing/*.test.mjs"

import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import zlib from 'node:zlib';
import { analyzeFile, engine, webModule, withSession } from './harness.mjs';
import { makeFixtures, FIXTURE_DIR } from './fixtures.mjs';

const { objectsOf } = await engine('objects/page-objects.js');
const { textBlocks } = await engine('objects/text-block.js');
const { composeDocument } = await webModule('annotations/persist.js');

let files;
before(async () => { files = await makeFixtures(FIXTURE_DIR); });
const read = (name) => new Uint8Array(fs.readFileSync(files[name]));

const OFFSET = [1, 0, 0, 1, 10, -10];

async function reopen(bytes) {
  const { pages } = await analyzeFile(bytes);
  return pages.map((analysis) => ({ analysis, objects: objectsOf(analysis) }));
}

function png(width, height) {
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const out = Buffer.alloc(body.length + 8);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(zlib.crc32(body), body.length + 4);
    return out;
  };
  const rows = Buffer.alloc((1 + width * 3) * height, 90);
  for (let y = 0; y < height; y++) rows[y * (1 + width * 3)] = 0;
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8);
  return new Uint8Array(Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header), chunk('IDAT', zlib.deflateSync(rows)), chunk('IEND', Buffer.alloc(0)),
  ]));
}

test('retyping pasted text: its one record, one undo step, and the saved file has both texts', async () => {
  const bytes = read('images');
  await withSession(bytes, async ({ store, session, sources, plan }) => {
    const caption = (await session.objects(1)).objects.find((o) => o.text === 'Caption under the picture');
    const [key] = await session.pasteObjects(1, await session.copyObjects(1, [caption.ref.key]), OFFSET);
    const copy = (await session.objects(1)).objects.find((o) => o.ref.key === key);
    assert.equal(copy.capabilities.editText, true, 'a copy is retyped on its original’s terms');
    const [pasted] = store.edits;

    assert.deepEqual(await session.preview(1, key, 'Pasted and retyped'), { ok: true, mode: 'font', font: null, missing: [] });
    assert.equal(await session.edit(1, key, 'Pasted and retyped'), true);
    assert.equal(await session.edit(1, key, 'Pasted and retyped'), false, 'the same text again changes nothing');
    const [retyped] = store.edits;
    assert.deepEqual([store.edits.length, retyped.id, retyped.kind, retyped.text, retyped.encoding.mode], [1, pasted.id, 'text-copy', 'Pasted and retyped', 'font']);
    assert.deepEqual([retyped.target, retyped.transform], [pasted.target, pasted.transform], 'fingerprint and placement kept');
    assert.equal((await session.objects(1)).objects.find((o) => o.ref.key === key).text, 'Pasted and retyped');
    // Moving it afterwards keeps the text.
    assert.equal(await session.transformObject(1, key, [1, 0, 0, 1, 0, -20]), true);
    assert.equal(store.edits[0].text, 'Pasted and retyped');
    assert.deepEqual(store.edits[0].transform, [1, 0, 0, 1, 10, -30]);

    const saved = await composeDocument({ base: bytes, plan, edits: store.edits, sources });
    const [page] = await reopen(saved);
    const original = page.analysis.runs.find((r) => r.text === 'Caption under the picture');
    const run = page.analysis.runs.find((r) => r.text === 'Pasted and retyped');
    assert.ok(original && run, page.analysis.runs.map((r) => r.text).join(' | '));
    assert.equal(run.font.name, original.font.name, 'in the copied run’s own font');
    assert.ok(Math.abs(run.frame.size - original.frame.size) < 1e-6);
    assert.ok(Math.abs(run.origin[0] - original.origin[0] - 10) < 1e-3 && Math.abs(run.origin[1] - original.origin[1] + 30) < 1e-3, `${run.origin}`);
    assert.ok(run.editable);

    store.undo();
    assert.equal(store.edits[0].text, 'Pasted and retyped', 'undo takes back the move');
    store.undo();
    assert.deepEqual([store.edits[0].text, store.edits[0].encoding.mode], ['Caption under the picture', 'original'], 'and then the retyping');
    store.redo();

    // Typed back to the run's own text it draws the file's own glyphs again; emptied, the copy goes.
    assert.equal(await session.edit(1, key, 'Caption under the picture'), true);
    assert.equal(store.edits[0].encoding.mode, 'original');
    assert.deepEqual(await session.preview(1, key, '  '), { ok: true, mode: 'none', font: null, missing: [] });
    assert.equal(await session.edit(1, key, ''), true);
    assert.equal(store.edits.length, 0, 'emptying a copy takes its record away, as deleting it does');
    store.undo();
    assert.equal(store.edits.length, 1);

    // Refused, with nothing stored: characters neither the font nor a standard font has.
    const before = store.edits[0];
    const preview = await session.preview(1, key, 'Caption 日本');
    assert.equal(preview.ok, false);
    await assert.rejects(session.edit(1, key, 'Caption 日本'), (err) => err.kind === 'characters' || err.kind === 'font');
    assert.equal(store.edits[0], before);
  });
});

test('retyping text pasted onto another page and into another document: written in the origin’s font', async () => {
  const from = read('crosspage');
  await withSession(from, async ({ store, session, sources, plan }) => {
    const tinted = (await session.objects(1)).objects.find((o) => o.text === 'Tinted half text');
    const clip = await session.copyObjects(1, [tinted.ref.key]);
    const [key] = await session.pasteObjects(2, clip, OFFSET);
    assert.equal(await session.edit(2, key, 'half tint'), true);
    assert.deepEqual(store.edits[0].from, { src: 'base', index: 0 }, 'still drawn from page 1');
    const saved = await composeDocument({ base: from, plan, edits: store.edits, sources });
    const [one, two] = await reopen(saved);
    const run = two.analysis.runs.find((r) => r.text === 'half tint');
    assert.ok(run, two.analysis.runs.map((r) => r.text).join(' | '));
    assert.equal(run.font.name, one.analysis.runs.find((r) => r.text === 'Tinted half text').font.name);
    assert.equal(two.analysis.shows[run.glyphs[0][0]].ca, 0.5, 'at the origin’s opacity');
    assert.deepEqual(two.analysis.issues.filter((i) => /missing|unreadable/.test(i.kind)), []);

    await withSession(read('multipage'), async ({ store: into, session: other, sources: kept, plan: intoPlan }) => {
      const [pasted] = await other.pasteObjects(2, clip, OFFSET);
      assert.equal(await other.edit(2, pasted, 'Tinted'), true);
      const out = await composeDocument({ base: read('multipage'), plan: intoPlan, edits: into.edits, sources: kept });
      const pages = await reopen(out);
      const copy = pages[1].analysis.runs.find((r) => r.text === 'Tinted');
      assert.ok(copy, 'the retyped copy in the other document');
      assert.match(copy.font.name, /Liberation/);
    });
  });
});

test('reflowing a pasted paragraph: the copies’ records, one undo step, and the words on the pasted lines', async () => {
  const bytes = read('paragraphs');
  await withSession(bytes, async ({ store, session, sources, plan }) => {
    const { objects } = await session.objects(1);
    const [block] = textBlocks(objects);
    const words = block.keys.map((k) => objects.find((o) => o.ref.key === k).text).join(' ').split(' ');
    const keys = await session.pasteObjects(2, await session.copyObjects(1, block.keys), [1, 0, 0, 1, 0, -300]);
    assert.equal(keys.length, 4);

    // Not together with anything else.
    const own = (await session.objects(2)).objects.find((o) => o.kind === 'text-run' && !o.ref.copy);
    assert.ok(own, 'page 2 has text of its own');
    await assert.rejects(session.reflowParagraph(2, [...keys, own.ref.key], 400), (err) => err.detail?.reason === 'copy');

    assert.equal(await session.reflowParagraph(2, keys, 400), true);
    assert.ok(store.edits.every((e) => e.kind === 'text-copy' && e.encoding.mode === 'font'), JSON.stringify(store.edits.map((e) => [e.kind, e.encoding.mode])));
    assert.ok(store.edits.length < 4, 'a line the wider paragraph no longer needs is taken away');
    assert.deepEqual(store.edits.map((e) => e.text).join(' ').split(' '), words, 'every word, in order');
    store.undo();
    assert.equal(store.edits.length, 4, 'one undo step');
    assert.ok(store.edits.every((e) => e.encoding.mode === 'original'));
    store.redo();

    const saved = await composeDocument({ base: bytes, plan, edits: store.edits, sources });
    const [one, two] = (await analyzeFile(saved)).pages;
    const originals = one.runs.filter((r) => block.keys.includes(`run:${r.key}`)).sort((a, b) => b.origin[1] - a.origin[1]);
    assert.equal(originals.length, 4, 'page 1 keeps its paragraph');
    for (const [i, text] of store.edits.map((e) => e.text).entries()) {
      const line = two.runs.find((r) => r.text === text);
      assert.ok(line, `“${text}” is on page 2`);
      assert.ok(Math.abs(line.origin[0] - originals[i].origin[0]) < 0.01 && Math.abs(line.origin[1] - originals[i].origin[1] + 300) < 0.01, `line ${i + 1} on its pasted baseline`);
      assert.equal(line.font.name, originals[i].font.name);
      assert.ok(line.editable);
    }
  });
});

test('replacing a pasted picture: the copy keeps its frame and origin, and the saved file draws the new image there', async () => {
  const bytes = read('crosspage');
  await withSession(bytes, async ({ store, session, sources, plan }) => {
    const picture = (await session.objects(1)).objects.find((o) => o.kind === 'image');
    const clip = await session.copyObjects(1, [picture.ref.key]);
    const [same] = await session.pasteObjects(1, clip, OFFSET);
    const [other] = await session.pasteObjects(2, clip, OFFSET);
    const copy = (await session.objects(2)).objects.find((o) => o.ref.key === other);
    assert.equal(copy.capabilities.replace, true);
    const pasted = store.edits.map((e) => ({ ...e }));

    assert.equal(await session.replaceImage(1, same, png(8, 4)), true);
    assert.equal(await session.replaceImage(2, other, png(6, 3)), true);
    assert.deepEqual(store.edits.map((e) => [e.id, e.kind, e.transform, e.from ?? null, e.replacement?.width]),
      pasted.map((e, i) => [e.id, 'image-copy', e.transform, e.from ?? null, [8, 6][i]]));
    assert.equal(sources.size, 2, 'both pictures kept for saving');

    const saved = await composeDocument({ base: bytes, plan, edits: store.edits, sources });
    const [one, two] = await reopen(saved);
    const onOne = one.objects.filter((o) => o.kind === 'image');
    assert.deepEqual(onOne.map((o) => [o.record.info.width, o.record.ctm.join(' ')]), [[32, '200 0 0 150 72 500'], [8, '200 0 0 150 82 490']], 'the original untouched, the copy replaced in its frame');
    const onTwo = two.objects.filter((o) => o.kind === 'image');
    assert.deepEqual(onTwo.map((o) => o.record.info.width), [8, 6], 'page 2’s own picture, then the replaced copy');
    assert.equal(onTwo[1].record.ctm.join(' '), '200 0 0 150 82 490');
    assert.deepEqual(two.analysis.issues.filter((i) => /missing|unreadable/.test(i.kind)), []);

    store.undo();
    assert.equal(store.edits[1].replacement, undefined, 'one undo step takes the picture back out');
    // A picture copy has no text, and text no picture.
    await assert.rejects(session.edit(1, same, 'text'), (err) => err.kind === 'missing');
    const text = (await session.objects(1)).objects.find((o) => o.text === 'Plain caption');
    const [textKey] = await session.pasteObjects(1, await session.copyObjects(1, [text.ref.key]), OFFSET);
    const edits = store.edits.length;
    await assert.rejects(session.replaceImage(1, textKey, png(2, 2)), (err) => err.kind === 'not-editable');
    assert.equal(store.edits.length, edits);
  });
});
