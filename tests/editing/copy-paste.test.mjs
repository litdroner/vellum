// Vellum 0.6: copying, pasting and duplicating objects (editing/objects/copies.js, session.js).
//
// A pasted copy of text or of a picture the page draws is a record of its own — `text-copy` or
// `image-copy` — drawn after the page from the page's ORIGINAL content, checked against it every time;
// a copy of a picture put there from a file is simply another inserted-image record. What is pinned
// here: copies keep text, font, size, colour, image and placement, and survive save and reopen; paste
// is one undo step; copies are objects that move, delete and copy again; a picture the copy still
// draws keeps its resource when its originals are deleted; duplicated pages take copies along; and
// what can't be written — another page's content, another document, a changed file — is refused with
// nothing stored.
// Run: node --test "tests/editing/*.test.mjs"

import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import zlib from 'node:zlib';
import { analyzeFile, engine, loadPdfLib, openWithPdfjs, webModule, withSession } from './harness.mjs';
import { makeFixtures, FIXTURE_DIR } from './fixtures.mjs';

const { openSource } = await engine('source.js');
const { objectsOf } = await engine('objects/page-objects.js');
const { followEdits } = await engine('edits.js');
const { multiply } = await engine('matrix.js');
const { composeDocument } = await webModule('annotations/persist.js');

let files;
before(async () => { files = await makeFixtures(FIXTURE_DIR); });
const read = (name) => new Uint8Array(fs.readFileSync(files[name]));

const OFFSET = [1, 0, 0, 1, 10, -10];
const close = (a, b, tol = 1e-3) => a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) <= tol);

/** A saved file reopened: every page's objects, from a verified analysis (as the app reads a file). */
async function reopen(bytes) {
  const { pages } = await analyzeFile(bytes);
  return pages.map((analysis) => ({ analysis, objects: objectsOf(analysis) }));
}

/** The page's content after saving (latin1) and its /XObject names. */
async function contentOf(bytes, index = 0) {
  const lib = await loadPdfLib();
  const doc = await lib.PDFDocument.load(bytes, { updateMetadata: false });
  const page = doc.getPages()[index];
  const source = await openSource(lib, bytes);
  const dict = page.node.Resources()?.lookup(lib.PDFName.of('XObject'));
  return {
    content: Buffer.from(source.contentBytes(page.node)).toString('latin1'),
    xobjects: dict instanceof lib.PDFDict ? dict.keys().map((k) => k.asString().slice(1)).sort() : [],
  };
}

async function shownOf(bytes, pageNumber) {
  const js = await openWithPdfjs(bytes);
  try {
    const page = await js.doc.getPage(pageNumber);
    const [a, b, c, d] = page.getViewport({ scale: 1 }).transform;
    return { basis: [a, b, c, d, 0, 0], box: page.view };
  } finally {
    await js.close();
  }
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

test('copy and paste text and a picture: one undo step, selected keys back, and the saved file draws both again', async () => {
  const bytes = read('images');
  await withSession(bytes, async ({ store, session, sources, plan }) => {
    const { objects } = await session.objects(1);
    const caption = objects.find((o) => o.kind === 'text-run' && o.text === 'Caption under the picture');
    const picture = objects.find((o) => o.kind === 'image');
    assert.equal(caption.capabilities.copy, true);
    assert.equal(picture.capabilities.copy, true);

    const clip = await session.copyObjects(1, [caption.ref.key, picture.ref.key]);
    assert.equal(store.edits.length, 0, 'copying changes nothing');
    const keys = await session.pasteObjects(1, clip, OFFSET);
    assert.equal(keys.length, 2);
    assert.deepEqual(store.edits.map((e) => e.kind), ['text-copy', 'image-copy']);
    assert.deepEqual(store.edits.map((e) => `copy:${e.id}`), keys);

    // To the object model they are the objects they were copied from, under keys of their own.
    const after = (await session.objects(1)).objects;
    const [textCopy, imageCopy] = keys.map((key) => after.find((o) => o.ref.key === key));
    assert.deepEqual([textCopy.kind, textCopy.text, imageCopy.kind], ['text-run', 'Caption under the picture', 'image']);
    for (const verb of ['move', 'scale', 'delete', 'copy']) assert.equal(textCopy.capabilities[verb], true, verb);
    assert.equal(textCopy.capabilities.editText, true, 'a copy is retyped on its original’s terms (copy-edits.test.mjs)');
    assert.equal(imageCopy.capabilities.rotate, true);
    assert.equal(imageCopy.capabilities.replace, true);

    // Saved and reopened.
    const saved = await composeDocument({ base: bytes, plan, edits: store.edits, sources });
    const [page] = await reopen(saved);
    const runs = page.analysis.runs.filter((r) => r.text === 'Caption under the picture');
    assert.equal(runs.length, 2, 'the caption is there twice');
    const [original, copy] = runs;
    assert.ok(copy.editable, 'and the copy is ordinary editable text once saved');
    assert.ok(close(copy.origin, [original.origin[0] + 10, original.origin[1] - 10]), `ten points right and down: ${copy.origin}`);
    assert.equal(copy.font.name, original.font.name, 'in the same font');
    assert.ok(Math.abs(copy.frame.size - original.frame.size) < 1e-6, 'at the same size');
    const images = page.objects.filter((o) => o.kind === 'image');
    assert.equal(images.length, 3, 'one more picture');
    assert.deepEqual(images[0].record.ctm, [200, 0, 0, 150, 72, 500], 'the original is untouched');
    assert.deepEqual(images.at(-1).record.ctm, [200, 0, 0, 150, 82, 490], 'the copy is offset');
    assert.equal(images.at(-1).record.name, 'Im1', 'drawn from the same image');

    // One undo step takes both away; redo brings both back.
    assert.equal(store.undo(), true);
    assert.equal(store.edits.length, 0);
    assert.equal(store.redo(), true);
    assert.equal(store.edits.length, 2);
  });
});

test('what is copied is the object as it is now: retyped and moved text, a replaced picture', async () => {
  const bytes = read('images');
  const JPEG_PNG = png(8, 4);
  await withSession(bytes, async ({ store, session, sources, plan }) => {
    const { objects } = await session.objects(1);
    const caption = objects.find((o) => o.kind === 'text-run' && o.text === 'Caption under the picture');
    const picture = objects.find((o) => o.kind === 'image');
    assert.equal(await session.edit(1, caption.ref.runKey, 'Caption here'), true);
    assert.equal(await session.transformObject(1, caption.ref.key, [1, 0, 0, 1, 0, -40]), true);
    assert.equal(await session.replaceImage(1, picture.ref.key, JPEG_PNG), true);
    const clip = await session.copyObjects(1, [caption.ref.key, picture.ref.key]);
    // A later change to the original doesn't change what was copied.
    assert.equal(await session.edit(1, caption.ref.runKey, 'Changed again'), true);
    const edits = store.edits.length;
    await session.pasteObjects(1, clip, OFFSET);
    assert.equal(store.edits.length, edits + 2);
    const [textCopy, imageCopy] = store.edits.slice(-2);
    assert.equal(textCopy.text, 'Caption here');
    assert.deepEqual(textCopy.transform, [1, 0, 0, 1, 10, -50]);
    assert.ok(imageCopy.replacement, 'the replaced picture’s own image');

    const saved = await composeDocument({ base: bytes, plan, edits: store.edits, sources });
    const [page] = await reopen(saved);
    const texts = page.analysis.runs.map((r) => r.text);
    assert.ok(texts.includes('Changed again') && texts.includes('Caption here'), texts.join(' | '));
    const pictures = page.objects.filter((o) => o.kind === 'image');
    assert.deepEqual(pictures.filter((o) => o.record.info?.width === 8).length, 2, 'the replacement, drawn twice');
  });
});

test('a copy is an object: moved, copied again and deleted, each through its one record', async () => {
  const bytes = read('images');
  await withSession(bytes, async ({ store, session }) => {
    const picture = (await session.objects(1)).objects.find((o) => o.kind === 'image');
    const [key] = await session.pasteObjects(1, await session.copyObjects(1, [picture.ref.key]), OFFSET);
    const id = store.edits[0].id;
    assert.equal(await session.transformObject(1, key, [1, 0, 0, 1, 5, 5]), true);
    assert.deepEqual([store.edits.length, store.edits[0].id, store.edits[0].transform], [1, id, [1, 0, 0, 1, 15, -5]]);
    // Copying a copy copies where it is now.
    const [again] = await session.pasteObjects(1, await session.copyObjects(1, [key]), OFFSET);
    assert.deepEqual(store.edits[1].transform, [1, 0, 0, 1, 25, -15]);
    assert.equal(await session.removeObjects(1, [key, again]), true);
    assert.equal(store.edits.length, 0, 'deleting a copy takes its record away');
    assert.equal(store.undo(), true);
    assert.equal(store.edits.length, 2);
    // One pasted line is not a paragraph.
    const text = (await session.objects(1)).objects.find((o) => o.kind === 'text-run');
    const [textKey] = await session.pasteObjects(1, await session.copyObjects(1, [text.ref.key]), OFFSET);
    await assert.rejects(session.reflowParagraph(1, [textKey], 100), (err) => err.kind === 'reflow');
  });
});

test('deleting every original a copy draws keeps the image resource, so the file stays whole', async () => {
  const bytes = read('images');
  await withSession(bytes, async ({ store, session, sources, plan }) => {
    const pictures = (await session.objects(1)).objects.filter((o) => o.kind === 'image');
    assert.equal(pictures.length, 2);
    await session.pasteObjects(1, await session.copyObjects(1, [pictures[0].ref.key]), OFFSET);
    assert.equal(await session.removeObjects(1, pictures.map((p) => p.ref.key)), true);
    const saved = await composeDocument({ base: bytes, plan, edits: store.edits, sources });
    const { xobjects } = await contentOf(saved);
    assert.deepEqual(xobjects, ['Im1'], 'the copy still has its image');
    const [page] = await reopen(saved);
    const images = page.objects.filter((o) => o.kind === 'image');
    assert.equal(images.length, 1);
    assert.deepEqual(images[0].record.ctm, [200, 0, 0, 150, 82, 490]);
    assert.equal(page.analysis.issues.filter((i) => i.kind === 'missing-xobject').length, 0);
  });
});

test('pages: a duplicated page takes its copies along; reordered and rotated pages keep them', async () => {
  const bytes = read('images');
  await withSession(bytes, async ({ store, session, sources, plan }) => {
    const text = (await session.objects(1)).objects.find((o) => o.kind === 'text-run');
    await session.pasteObjects(1, await session.copyObjects(1, [text.ref.key]), OFFSET);
    const [first] = plan;
    const dup = { ...first, id: 'dup-1' };
    const rotated = { ...first, id: 'rot-1', rotate: 90 };
    const copied = followEdits(store.edits, [first, dup], [[first.id, dup.id], [first.id, rotated.id]]).map((c) => c.edit.after).filter(Boolean);
    const edits = [...store.edits, ...copied];
    // Reordered too: the rotated duplicate first, the original last.
    const saved = await composeDocument({ base: bytes, plan: [rotated, dup, first], edits, sources });
    const pages = await reopen(saved);
    for (const [i, page] of pages.entries()) {
      assert.equal(page.analysis.runs.filter((r) => r.text === text.text).length, 2, `page ${i + 1} draws the copy`);
    }
  });
});

test('refused, with nothing stored: nothing copied, PDF/A, a changed file; a picture from a file goes anywhere', async () => {
  await withSession(read('multipage'), async ({ store, session, plan, bytes, sources }) => {
    const text = (await session.objects(1)).objects.find((o) => o.kind === 'text-run');
    const clip = await session.copyObjects(1, [text.ref.key]);
    // (Another page and another document: tests/editing/cross-page.test.mjs.)
    await assert.rejects(session.pasteObjects(1, { ...clip, items: [] }, OFFSET), (err) => err.kind === 'missing');
    await assert.rejects(session.pasteObjects(1, { ...clip, owner: {}, documents: new Map() }, OFFSET), (err) => err.kind === 'missing', 'another document’s PDF not given');
    assert.equal(store.edits.length, 0);

    // A picture put there from a file carries its own image, so it goes on any page — and any document.
    const shown = await shownOf(bytes, 1);
    const key = await session.insertImage(1, png(20, 10), shown);
    const pictureClip = await session.copyObjects(1, [key]);
    const [onTwo] = await session.pasteObjects(2, pictureClip, OFFSET);
    assert.ok(onTwo.startsWith('inserted:'));
    assert.equal(store.edits.at(-1).entry, plan[1].id);
    assert.deepEqual(store.edits.at(-1).transform, multiply(store.edits[0].transform, OFFSET));
    // A mixed clip is all or nothing.
    const mixed = await session.copyObjects(1, [key, text.ref.key]);
    const count = store.edits.length;
    await assert.rejects(session.pasteObjects(2, { ...mixed, items: [mixed.items[0], { ...mixed.items[1], target: { ...mixed.items[1].target, key: 'nothing' } }] }, OFFSET), (err) => err.kind === 'missing');
    assert.equal(store.edits.length, count);

    // The writer checks the fingerprint again: a copy of text that isn't in the file refuses the save.
    await session.pasteObjects(1, clip, OFFSET);
    const forged = { ...store.edits.at(-1), target: { ...store.edits.at(-1).target, text: 'Something else' } };
    await assert.rejects(composeDocument({ base: bytes, plan, edits: [forged], sources }), (err) => err.kind === 'changed');
  });
  await withSession(read('pdfa'), async ({ store, session }) => {
    const shown = await shownOf(read('images'), 1);
    await withSession(read('images'), async ({ session: other }) => {
      const key = await other.insertImage(1, png(20, 10), shown);
      const clip = await other.copyObjects(1, [key]);
      await assert.rejects(session.pasteObjects(1, clip, OFFSET), (err) => err.kind === 'pdfa');
    });
    assert.equal(store.edits.length, 0);
  });
  // An inline image has no name to draw it again by.
  const inline = (await analyzeFile(read('objects'), { pages: [0] })).pages[0];
  const images = objectsOf(inline).filter((o) => o.kind === 'image' && o.record.inline);
  assert.ok(images.length > 0);
  for (const o of images) assert.notEqual(o.capabilities.copy, true);
});
