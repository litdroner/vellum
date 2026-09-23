// Attachment inspector V1: the files embedded in a PDF are listed with what the document states about
// them, extracted on request, and — where the document can be rewritten — attached or removed.
// Run: node --test tests/editing/attachments.test.mjs

import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { loadPdfLib, openWithPdfjs, webModule } from './harness.mjs';
import { makeFixtures, FIXTURE_DIR } from './fixtures.mjs';

const { composeDocument, readEmbeddedFiles } = await webModule('annotations/persist.js');
const { AnnotationStore } = await webModule('annotations/model.js');
const {
  addAttachment, attachmentSize, attachmentType, extractAttachment, readAttachmentsFrom,
  removeAttachment, uniqueAttachmentName,
} = await webModule('attachments/attachments.js');

const decode = (bytes) => new TextDecoder().decode(bytes);
const encode = (text) => new TextEncoder().encode(text);

let bytes;
let lib;
before(async () => {
  bytes = new Uint8Array(fs.readFileSync((await makeFixtures(FIXTURE_DIR)).attachments));
  lib = await loadPdfLib();
});

test('the embedded files are listed with the name, type, size and dates the document states', async () => {
  const before = Buffer.from(bytes);
  const list = await readEmbeddedFiles(bytes);
  assert.deepEqual(list.map((a) => a.name), ['notes.txt', 'data.csv']);

  const [notes, data] = list;
  assert.equal(notes.mime, 'text/plain');
  assert.equal(notes.size, 25);
  assert.equal(notes.description, 'Notes taken while reading');
  assert.equal(notes.created, '2024-01-02T03:04:05.000Z');
  assert.equal(notes.modified, '2024-05-06T07:08:09.000Z');
  assert.equal(notes.missing, false);

  // The second file states nothing but its name: it is still listed, and its type read from that name.
  assert.equal(data.mime, null);
  assert.equal(data.description, null);
  assert.equal(attachmentType(data), 'text/csv');
  assert.ok(data.size > 0, 'its size falls back to the length of its stream');

  assert.ok(before.equals(Buffer.from(bytes)), 'inspecting never changes the opened bytes');
});

test('a document with no attachments lists none', async () => {
  const plain = new Uint8Array(fs.readFileSync((await makeFixtures(FIXTURE_DIR)).simple));
  assert.deepEqual(await readEmbeddedFiles(plain), []);
});

test('an attachment is extracted with its own bytes, and only when asked for', async () => {
  assert.equal(decode(await extractAttachment(lib, bytes, 'notes.txt')), 'Notes about the figures.\n');
  assert.equal(decode(await extractAttachment(lib, bytes, 'data.csv')), 'a,b\n1,2\n');
  assert.equal(await extractAttachment(lib, bytes, 'nothing.txt'), null, 'a name the file doesn’t carry');
});

test('saving without touching the attachments leaves both exactly as they were', async () => {
  const saved = await composeDocument({ base: bytes });
  assert.deepEqual((await readAttachmentsFrom(lib, saved)).map((a) => a.name), ['notes.txt', 'data.csv']);
  assert.equal(decode(await extractAttachment(lib, saved, 'notes.txt')), 'Notes about the figures.\n');
  const kept = (await readAttachmentsFrom(lib, saved))[0];
  assert.equal(kept.mime, 'text/plain', 'its stated type is not rewritten');
  assert.equal(kept.created, '2024-01-02T03:04:05.000Z', 'nor its dates');
});

test('a file is attached, and reopens with its name, type and bytes', async () => {
  const list = addAttachment(await readEmbeddedFiles(bytes), {
    name: 'report.txt', data: encode('The quarterly report.'), mime: 'text/plain', description: 'Added in Vellum',
  });
  const saved = await composeDocument({ base: bytes, attachments: list });
  const after = await readAttachmentsFrom(lib, saved);
  assert.deepEqual(after.map((a) => a.name).sort(), ['data.csv', 'notes.txt', 'report.txt']);
  const added = after.find((a) => a.name === 'report.txt');
  assert.equal(added.mime, 'text/plain');
  assert.equal(added.description, 'Added in Vellum');
  assert.equal(decode(await extractAttachment(lib, saved, 'report.txt')), 'The quarterly report.');
  // The files that were already there are untouched.
  assert.equal(decode(await extractAttachment(lib, saved, 'notes.txt')), 'Notes about the figures.\n');
});

test('an attachment is removed; the other one and the page are left alone', async () => {
  const list = removeAttachment(await readEmbeddedFiles(bytes), 'notes.txt');
  const saved = await composeDocument({ base: bytes, attachments: list });
  const after = await readAttachmentsFrom(lib, saved);
  assert.deepEqual(after.map((a) => a.name), ['data.csv']);
  assert.equal(decode(await extractAttachment(lib, saved, 'data.csv')), 'a,b\n1,2\n', 'the file that stayed is byte for byte what it was');
  assert.equal(await extractAttachment(lib, saved, 'notes.txt'), null);

  const js = await openWithPdfjs(saved);
  const page = await js.doc.getPage(1);
  const text = (await page.getTextContent()).items.map((i) => i.str).join('');
  js.close();
  assert.ok(text.includes('A document with files attached'), 'the page is untouched');
});

test('removing every attachment takes the embedded-file tree out of the document', async () => {
  const saved = await composeDocument({ base: bytes, attachments: [] });
  assert.deepEqual(await readAttachmentsFrom(lib, saved), []);
  const js = await openWithPdfjs(saved);
  const attachments = await js.doc.getAttachments();
  js.close();
  assert.equal(attachments, null, 'pdf.js sees none either');
});

test('a change survives being saved and opened again', async () => {
  const once = await composeDocument({
    base: bytes,
    attachments: addAttachment(removeAttachment(await readEmbeddedFiles(bytes), 'data.csv'), { name: 'extra.txt', data: encode('x') }),
  });
  const reopened = await readAttachmentsFrom(lib, once);
  assert.deepEqual(reopened.map((a) => a.name).sort(), ['extra.txt', 'notes.txt']);
  // Saving again from the reopened file changes nothing further.
  const twice = await composeDocument({ base: once, attachments: reopened });
  assert.deepEqual((await readAttachmentsFrom(lib, twice)).map((a) => a.name).sort(), ['extra.txt', 'notes.txt']);
  assert.equal(decode(await extractAttachment(lib, twice, 'extra.txt')), 'x');
});

test('a name the document already files something under is never used twice', async () => {
  const list = await readEmbeddedFiles(bytes);
  assert.equal(uniqueAttachmentName('notes.txt', list.map((a) => a.id)), 'notes (2).txt');
  assert.equal(uniqueAttachmentName('fresh.txt', list.map((a) => a.id)), 'fresh.txt');
  assert.equal(uniqueAttachmentName('a/b\\c:d.txt', []), 'a b c d.txt', 'path separators can’t get into a name');
  assert.equal(uniqueAttachmentName('   ', []), 'Attachment');

  const twice = addAttachment(addAttachment(list, { name: 'notes.txt', data: encode('one') }), { name: 'notes.txt', data: encode('two') });
  const saved = await composeDocument({ base: bytes, attachments: twice });
  const after = await readAttachmentsFrom(lib, saved);
  assert.deepEqual(after.map((a) => a.name).sort(), ['data.csv', 'notes (2).txt', 'notes (3).txt', 'notes.txt']);
  assert.equal(decode(await extractAttachment(lib, saved, 'notes.txt')), 'Notes about the figures.\n', 'the file’s own is not replaced');
  assert.equal(decode(await extractAttachment(lib, saved, 'notes (2).txt')), 'one');
});

test('attaching or removing is one undo step in the same store as everything else', () => {
  const store = new AnnotationStore({ author: 'Test' });
  const opened = [{ id: 'notes.txt', name: 'notes.txt', size: 25 }];
  store.initAttachments(opened);
  assert.equal(store.canUndo, false, 'what the document opened with is not an edit');

  store.applyAttachments(addAttachment(opened, { name: 'new.txt', data: encode('hello') }));
  assert.deepEqual(store.attachments.map((a) => a.name), ['notes.txt', 'new.txt']);
  store.undo();
  assert.deepEqual(store.attachments.map((a) => a.name), ['notes.txt']);
  store.redo();
  assert.deepEqual(store.attachments.map((a) => a.name), ['notes.txt', 'new.txt']);
});

test('sizes and types are described the way the inspector shows them', () => {
  assert.equal(attachmentSize(0), '0 bytes');
  assert.equal(attachmentSize(900), '900 bytes');
  assert.equal(attachmentSize(2048), '2.0 KB');
  assert.equal(attachmentSize(5 * 1024 * 1024), '5.0 MB');
  assert.equal(attachmentSize(null), 'Size not known');
  assert.equal(attachmentType({ mime: 'application/zip', name: 'x.pdf' }), 'application/zip', 'what the document states wins');
  assert.equal(attachmentType({ mime: null, name: 'sheet.xlsx' }), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  assert.equal(attachmentType({ mime: null, name: 'thing.odd' }), 'ODD file');
  assert.equal(attachmentType({ mime: null, name: 'thing' }), 'Type not known');
});
