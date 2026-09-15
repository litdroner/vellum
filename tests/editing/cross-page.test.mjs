// Vellum 0.6: moving and pasting text and pictures onto another page, or into another document
// (editing/objects/copies.js `from`, editing/page-writer.js origins, editing/session.js).
//
// A copy on a page other than the one it was copied from draws that page's ORIGINAL content, and the
// writer carries every resource it draws with — font, image, ExtGState, colour space — onto the new
// page under names of its own. The fixture's page 2 uses the same names for different things, so a
// copy that drew by the old names would visibly draw the wrong font, image and opacity. Pinned here:
// appearance survives save and reopen; a move is one undo step; origins deleted, reordered, rotated or
// duplicated still write; another document's PDF is kept in the sources once; what can't be written
// is refused with nothing stored.
// Run: node --test "tests/editing/*.test.mjs"

import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { analyzeFile, engine, loadPdfLib, webModule, withSession } from './harness.mjs';
import { makeFixtures, FIXTURE_DIR } from './fixtures.mjs';

const { objectsOf } = await engine('objects/page-objects.js');
const { followEdits } = await engine('edits.js');
const { composeDocument } = await webModule('annotations/persist.js');

let files;
before(async () => { files = await makeFixtures(FIXTURE_DIR); });
const read = (name) => new Uint8Array(fs.readFileSync(files[name]));

const OFFSET = [1, 0, 0, 1, 10, -10];

async function reopen(bytes) {
  const { pages } = await analyzeFile(bytes);
  return pages.map((analysis) => ({ analysis, objects: objectsOf(analysis) }));
}

/** A run's first text operator: its font, size, opacity and fill as the saved page draws them. */
const styleOf = (analysis, run) => {
  const show = analysis.shows[run.glyphs[0][0]];
  return { font: run.font?.name, size: show.fontSize, ca: show.ca, space: show.fill.space?.op ?? null, color: show.fill.color?.args };
};

/** A page's resource dictionary names by category, after saving. */
async function resourcesOf(bytes, index) {
  const lib = await loadPdfLib();
  const doc = await lib.PDFDocument.load(bytes, { updateMetadata: false });
  const resources = doc.getPages()[index].node.Resources();
  const out = {};
  for (const category of ['Font', 'XObject', 'ExtGState', 'ColorSpace']) {
    const dict = resources?.lookup(lib.PDFName.of(category));
    out[category] = dict instanceof lib.PDFDict ? dict.keys().map((k) => k.asString().slice(1)).sort() : [];
  }
  return out;
}

const issuesOf = (analysis) => analysis.issues.filter((i) => /missing|unreadable/.test(i.kind));

test('pasted on another page: font, ExtGState, colour space and image come along, under names of their own', async () => {
  const bytes = read('crosspage');
  await withSession(bytes, async ({ store, session, sources, plan }) => {
    const { objects } = await session.objects(1);
    const tinted = objects.find((o) => o.kind === 'text-run' && o.text === 'Tinted half text');
    const picture = objects.find((o) => o.kind === 'image');
    const clip = await session.copyObjects(1, [tinted.ref.key, picture.ref.key]);
    const keys = await session.pasteObjects(2, clip, OFFSET);
    assert.equal(store.edits.length, 2, 'one undo step, two records');
    for (const e of store.edits) assert.deepEqual([e.entry, e.from], [plan[1].id, { src: 'base', index: 0 }]);

    // The copies are objects on page 2, drawn from page 1's content.
    const onTwo = (await session.objects(2)).objects;
    const [textCopy, imageCopy] = keys.map((key) => onTwo.find((o) => o.ref.key === key));
    assert.equal(textCopy.text, 'Tinted half text');
    assert.equal(imageCopy.record.info.width, 32);
    for (const verb of ['move', 'delete', 'copy']) assert.equal(textCopy.capabilities[verb], true, verb);

    const saved = await composeDocument({ base: bytes, plan, edits: store.edits, sources });
    const [one, two] = await reopen(saved);
    const original = one.analysis.runs.find((r) => r.text === 'Tinted half text');
    const copy = two.analysis.runs.find((r) => r.text === 'Tinted half text');
    assert.ok(copy, 'page 2 draws the text');
    assert.ok(copy.editable, 'as ordinary editable text');
    const [was, now] = [styleOf(one.analysis, original), styleOf(two.analysis, copy)];
    assert.equal(now.font, was.font, 'in page 1’s embedded font, not page 2’s Helvetica under the same name');
    assert.equal(now.ca, 0.5, 'at page 1’s opacity, not page 2’s /Half');
    assert.deepEqual([now.space, now.color], [was.space, was.color], 'in the same colour space and colour');
    assert.ok(Math.abs(copy.origin[0] - original.origin[0] - 10) < 1e-3 && Math.abs(copy.origin[1] - original.origin[1] + 10) < 1e-3);
    const images = two.objects.filter((o) => o.kind === 'image');
    assert.deepEqual(images.map((o) => o.record.info.width), [8, 32], 'page 2’s own picture, then page 1’s');
    assert.deepEqual(images[1].record.ctm, [200, 0, 0, 150, 82, 490]);
    assert.deepEqual(issuesOf(two.analysis), []);
    assert.equal(two.analysis.runs.find((r) => r.text === 'Second page text').font.name.includes('Helvetica'), true, 'page 2’s own text keeps its font');

    const names = await resourcesOf(saved, 1);
    assert.deepEqual(names.Font, ['F1', 'VlCpF1']);
    assert.deepEqual(names.XObject, ['Im1', 'VlCpIm1']);
    assert.deepEqual(names.ExtGState, ['Half', 'VlCpGS1']);
    assert.deepEqual(names.ColorSpace, ['VlCpCS1']);
    assert.deepEqual((await resourcesOf(saved, 0)).Font, ['F1'], 'page 1 is untouched');
  });
});

test('a move to another page is one undo step, and the file draws the objects only where they went', async () => {
  const bytes = read('crosspage');
  await withSession(bytes, async ({ store, session, sources, plan }) => {
    const { objects } = await session.objects(1);
    const keys = objects.filter((o) => o.kind === 'image' || o.text === 'Plain caption').map((o) => o.ref.key);
    assert.equal(keys.length, 2);
    const moved = await session.moveObjectsToPage(1, keys, 2, [1, 0, 0, 1, 0, -100]);
    assert.equal(moved.length, 2);
    assert.deepEqual(store.edits.map((e) => e.kind).sort(), ['image', 'image-copy', 'text', 'text-copy']);
    assert.equal((await session.objects(2)).objects.filter((o) => moved.includes(o.ref.key)).length, 2);

    const saved = await composeDocument({ base: bytes, plan, edits: store.edits, sources });
    const [one, two] = await reopen(saved);
    assert.equal(one.analysis.runs.some((r) => r.text === 'Plain caption'), false, 'gone from page 1');
    assert.equal(one.objects.filter((o) => o.kind === 'image').length, 0);
    assert.deepEqual((await resourcesOf(saved, 0)).XObject, [], 'page 1 no longer lists the image it doesn’t draw');
    assert.ok(two.analysis.runs.some((r) => r.text === 'Plain caption'), 'on page 2');
    assert.deepEqual(two.objects.filter((o) => o.kind === 'image').map((o) => o.record.ctm.join(' ')), ['50 0 0 50 300 300', '200 0 0 150 72 400']);
    assert.deepEqual(issuesOf(two.analysis), []);

    assert.equal(store.undo(), true);
    assert.equal(store.edits.length, 0, 'one undo puts both back');
    assert.equal(store.redo(), true);
    assert.equal(store.edits.length, 4);

    // Moved back to page 1, a copy draws page 1's own resources again, with no `from`.
    const [textKey] = moved.filter((k) => store.edits.find((e) => `copy:${e.id}` === k)?.kind === 'text-copy');
    const [back] = await session.moveObjectsToPage(2, [textKey], 1, [1, 0, 0, 1, 0, 100]);
    const record = store.edits.find((e) => `copy:${e.id}` === back);
    assert.equal(record.entry, plan[0].id);
    assert.equal(record.from, undefined);
    const again = await reopen(await composeDocument({ base: bytes, plan, edits: store.edits, sources }));
    assert.equal(again[0].analysis.runs.filter((r) => r.text === 'Plain caption').length, 1);
    assert.equal(again[1].analysis.runs.some((r) => r.text === 'Plain caption'), false);
  });
});

test('pages: the origin deleted, the destination duplicated, rotated and reordered — the copies still write', async () => {
  const bytes = read('crosspage');
  await withSession(bytes, async ({ store, session, sources, plan }) => {
    const { objects } = await session.objects(1);
    const keys = objects.filter((o) => o.kind === 'image' || o.text === 'Tinted half text').map((o) => o.ref.key);
    await session.pasteObjects(2, await session.copyObjects(1, keys), OFFSET);
    const [, second, third] = plan;
    const dup = { ...second, id: 'dup-2', rotate: 90 };
    const copied = followEdits(store.edits, [second], [[second.id, dup.id]]).map((c) => c.edit.after).filter(Boolean);
    // Page 1 — where the copies' content is — is no longer in the document at all.
    const saved = await composeDocument({ base: bytes, plan: [third, dup, second], edits: [...store.edits, ...copied], sources });
    const pages = await reopen(saved);
    assert.equal(pages.length, 3);
    for (const i of [1, 2]) {
      const run = pages[i].analysis.runs.find((r) => r.text === 'Tinted half text');
      assert.ok(run, `page ${i + 1} draws the copy`);
      assert.equal(styleOf(pages[i].analysis, run).ca, 0.5);
      assert.deepEqual(pages[i].objects.filter((o) => o.kind === 'image').map((o) => o.record.info.width), [8, 32]);
      assert.deepEqual(issuesOf(pages[i].analysis), []);
    }
    assert.equal(saved.length < bytes.length * 3, true, 'the deleted page isn’t kept whole');
  });
});

test('another document: its PDF is kept once, copies write in the other file’s font and image; PDF/A refuses', async () => {
  const from = read('crosspage');
  await withSession(from, async ({ session: other }) => {
    const { objects } = await other.objects(1);
    const keys = objects.filter((o) => o.kind === 'image' || o.text === 'Tinted half text').map((o) => o.ref.key);
    const clip = await other.copyObjects(1, keys);
    const into = read('multipage');
    await withSession(into, async ({ store, session, sources, plan }) => {
      await session.pasteObjects(1, clip, OFFSET);
      await session.pasteObjects(3, clip, OFFSET);
      assert.equal(sources.size, 1, 'the other PDF, once');
      const [[id, kept]] = sources;
      assert.equal(kept, from);
      assert.ok(store.edits.every((e) => e.from?.src === id && e.from.index === 0));
      assert.equal((await session.objects(3)).objects.filter((o) => o.ref.copy).length, 2);

      const saved = await composeDocument({ base: into, plan, edits: store.edits, sources });
      const pages = await reopen(saved);
      for (const i of [0, 2]) {
        const run = pages[i].analysis.runs.find((r) => r.text === 'Tinted half text');
        assert.ok(run, `page ${i + 1}`);
        assert.match(run.font.name, /Liberation/);
        assert.equal(styleOf(pages[i].analysis, run).ca, 0.5);
        assert.equal(pages[i].objects.filter((o) => o.kind === 'image')[0]?.record.info.width, 32);
        assert.deepEqual(issuesOf(pages[i].analysis), []);
      }
      assert.equal(pages[1].analysis.runs.some((r) => r.text === 'Tinted half text'), false);
    });
    await withSession(read('pdfa'), async ({ store, session }) => {
      await assert.rejects(session.pasteObjects(1, clip, OFFSET), (err) => err.kind === 'pdfa');
      assert.equal(store.edits.length, 0);
    });
  });
});

test('landing off a smaller page, objects come to its middle; forged, missing and unreadable origins refuse', async () => {
  const bytes = read('crosspage');
  await withSession(bytes, async ({ store, session, sources, plan }) => {
    const picture = (await session.objects(1)).objects.find((o) => o.kind === 'image');
    const clip = await session.copyObjects(1, [picture.ref.key]);
    await session.pasteObjects(3, clip);
    const [record] = store.edits;
    // 200 × 150 at (72, 500) on a 200 × 200 page: centred on it.
    assert.deepEqual(record.transform, [1, 0, 0, 1, -72, -475]);
    // A move is where the hand put it, even off the page.
    const moved = await session.moveObjectsToPage(1, [picture.ref.key], 3, [1, 0, 0, 1, 0, 0]);
    assert.deepEqual(store.edits.find((e) => `copy:${e.id}` === moved[0]).transform, [1, 0, 0, 1, 0, 0]);
    store.undo();

    const saved = await composeDocument({ base: bytes, plan, edits: store.edits, sources });
    assert.equal((await reopen(saved))[2].objects.filter((o) => o.kind === 'image').length, 1);

    const forged = { ...record, target: { ...record.target, ctm: [1, 0, 0, 1, 0, 0] } };
    await assert.rejects(composeDocument({ base: bytes, plan, edits: [forged], sources }), (err) => err.kind === 'changed');
    const gone = { ...record, from: { src: 'nowhere', index: 0 } };
    await assert.rejects(composeDocument({ base: bytes, plan, edits: [gone], sources }), (err) => err.kind === 'missing');
    // Something the copy is drawn with that the origin page doesn't have is never guessed at.
    const text = (await session.objects(1)).objects.find((o) => o.text === 'Tinted half text');
    await session.pasteObjects(2, await session.copyObjects(1, [text.ref.key]), OFFSET);
    const stripped = await loadPdfLib().then(async (lib) => {
      const doc = await lib.PDFDocument.load(bytes, { updateMetadata: false });
      doc.getPages()[0].node.Resources().delete(lib.PDFName.of('ColorSpace'));
      return doc.save({ useObjectStreams: false });
    });
    await assert.rejects(composeDocument({ base: stripped, plan, edits: [store.edits.at(-1)], sources }), (err) => err.kind === 'changed' || err.kind === 'content');
  });
});
