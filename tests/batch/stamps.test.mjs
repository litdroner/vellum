// The operations workflows added to the registry (web/js/operations/registry.js): Page numbers and Watermark on
// every page, through the writer saving a document uses (pages/stamps.js writePageSettings), on generated PDFs,
// read back with pdf.js; and Office → PDF as a step in between (held): the host converts into its own work
// folder, the PDF is read into memory and let go. No app, no Office, nothing written to disk.
// Run: node --test "tests/batch/*.test.mjs"

import test from 'node:test';
import assert from 'node:assert/strict';
import { loadPdfLib, openWithPdfjs, webModule } from '../editing/harness.mjs';

const { operation } = await webModule('operations/registry.js');

const input = { token: 'tok', path: 'C:\\in\\Report.pdf', name: 'Report.pdf', url: 'https://app.vellum/doc/tok' };

async function pdf(pages = 2) {
  const lib = await loadPdfLib();
  const doc = await lib.PDFDocument.create({ updateMetadata: false });
  for (let i = 0; i < pages; i++) doc.addPage([612, 792]).drawText(`Body ${i + 1}`, { x: 20, y: 200, size: 12 });
  return doc.save({ useObjectStreams: false });
}

function fakeEnv({ bytes, signal = new AbortController().signal } = {}) {
  const written = [];
  return {
    written,
    env: {
      signal, progress: () => {}, pdfLib: loadPdfLib,
      readFile: async () => { if (bytes instanceof Error) throw bytes; return bytes; },
      writeFile: async (target, data) => { written.push({ target, data }); return { name: target.name, path: `${target.folder}\\${target.name}` }; },
    },
  };
}

/** Each page's text, as pdf.js reads it. */
async function texts(bytes) {
  const js = await openWithPdfjs(bytes);
  try {
    const out = [];
    for (let n = 1; n <= js.doc.numPages; n++) out.push((await (await js.doc.getPage(n)).getTextContent()).items.map((i) => i.str).join(' '));
    return out;
  } finally {
    await js.close();
  }
}

test('Page numbers: every page gets its number, the source bytes untouched, under "(numbered)"', async () => {
  const numbers = operation('pdf.pageNumbers');
  const bytes = await pdf(2);
  const before = bytes.slice();
  const { env, written } = fakeEnv({ bytes });
  const params = numbers.checkParams({ format: 'Page {n} of {total}', style: 'arabic', position: 'bottom-right' });
  assert.equal(numbers.outputName('Report.pdf'), 'Report (numbered).pdf');
  const result = await numbers.run({ input, output: { folder: 'C:\\out', name: 'Report (numbered).pdf' }, params, overwrite: 'keepBoth' }, env);
  assert.equal(result.status, 'succeeded', result.message);
  assert.equal(written.length, 1);
  assert.equal(result.note, 'Numbered on 2 pages');
  const read = await texts(written[0].data);
  assert.ok(read[0].includes('Page 1 of 2') && read[1].includes('Page 2 of 2') && read[0].includes('Body 1'), JSON.stringify(read));
  assert.deepEqual(bytes, before);
});

test('Page numbers: roman numerals; settings outside the choices are refused in words', async () => {
  const numbers = operation('pdf.pageNumbers');
  const { env, written } = fakeEnv({ bytes: await pdf(3) });
  const result = await numbers.run({ input, output: { folder: 'C:\\out', name: 'x.pdf' }, params: numbers.checkParams({ format: '{n}', style: 'ROMAN' }), overwrite: 'keepBoth' }, env);
  assert.equal(result.status, 'succeeded');
  const read = await texts(written[0].data);
  assert.deepEqual(read.map((t) => t.split(' ').at(-1)), ['I', 'II', 'III']);
  assert.throws(() => numbers.checkParams({ format: 'Page {total}' }), /isn’t a page number text/);
  assert.throws(() => numbers.checkParams({ position: 'middle' }), /isn’t a page number position/);
  assert.deepEqual({ ...numbers.checkParams({}) }, { ...numbers.params }, 'nothing given: the defaults');
});

test('Watermark: the words over every page; empty, too long or unwritable words are refused', async () => {
  const mark = operation('pdf.watermark');
  const { env, written } = fakeEnv({ bytes: await pdf(2) });
  const params = mark.checkParams({ text: '  CONFIDENTIAL ', position: 'top', angle: 'level' });
  assert.equal(params.text, 'CONFIDENTIAL');
  const result = await mark.run({ input, output: { folder: 'C:\\out', name: 'Report (watermarked).pdf' }, params, overwrite: 'replace' }, env);
  assert.equal(result.status, 'succeeded', result.message);
  assert.equal(written[0].target.overwrite, 'replace');
  const read = await texts(written[0].data);
  assert.ok(read.every((t) => t.includes('CONFIDENTIAL')), JSON.stringify(read));

  assert.throws(() => mark.checkParams({ text: '   ' }), /Enter the watermark text/);
  assert.throws(() => mark.checkParams({ text: 'x'.repeat(101) }), /at most 100/);
  assert.equal(await mark.verify({ text: 'DRAFT' }, { pdfLib: loadPdfLib }), null);
  assert.match(await mark.verify({ text: '草稿' }, { pdfLib: loadPdfLib }), /can’t be written in the standard PDF font/);
  const bad = fakeEnv({ bytes: await pdf(1) });
  const refused = await mark.run({ input, output: { folder: 'C:\\out', name: 'x.pdf' }, params: mark.checkParams({ text: '草稿' }), overwrite: 'keepBoth' }, bad.env);
  assert.deepEqual([refused.status, refused.code, bad.written.length], ['failed', 'refused', 0]);
});

test('Stamps: an unreadable file fails in words; stopped, nothing is written', async () => {
  const numbers = operation('pdf.pageNumbers');
  const params = numbers.checkParams({});
  const garbage = fakeEnv({ bytes: new TextEncoder().encode('not a pdf') });
  const failed = await numbers.run({ input, output: { folder: 'C:\\out', name: 'x.pdf' }, params, overwrite: 'keepBoth' }, garbage.env);
  assert.deepEqual([failed.status, failed.code, garbage.written.length], ['failed', 'unreadable', 0]);

  const controller = new AbortController();
  const stopped = fakeEnv({ bytes: await pdf(1), signal: controller.signal });
  stopped.env.progress = () => controller.abort(); // Stop pressed while it works
  const result = await numbers.run({ input, output: { folder: 'C:\\out', name: 'x.pdf' }, params, overwrite: 'keepBoth' }, stopped.env);
  assert.deepEqual([result.status, stopped.written.length], ['cancelled', 0]);
});

test('Office → PDF held: converted into the host’s work folder, read into memory, then let go', async () => {
  const office = operation('office.toPdf');
  const bytes = await pdf(1);
  const sent = [];
  const reply = { status: 'converted', message: 'Converted with Microsoft Office.', provider: 'msoffice', providerName: 'Microsoft Office',
    output: { name: 'Report.pdf', path: 'C:\\data\\flow-work\\1\\Report.pdf', token: 'held-1', url: 'https://app.vellum/doc/held-1' } };
  const host = { request: async (type, payload) => { sent.push([type, payload]); return type === 'batch.office' ? reply : {}; } };
  const reads = [];
  const env = { signal: new AbortController().signal, host, readFile: async (file) => { reads.push(file.url); return bytes; } };
  const result = await office.run({ input: { ...input, name: 'Report.docx' }, output: { held: true, name: 'Report.pdf' }, params: {}, overwrite: 'keepBoth' }, env);
  assert.equal(result.status, 'succeeded');
  assert.deepEqual([result.output.held, result.output.bytes, result.output.name, result.note], [true, bytes, 'Report.pdf', 'Converted with Microsoft Office']);
  assert.deepEqual(sent, [['batch.office', { source: 'tok', name: 'Report.pdf', hold: true }], ['batch.release', { token: 'held-1' }]]);
  assert.deepEqual(reads, ['https://app.vellum/doc/held-1']);

  // A failed conversion holds nothing, so there is nothing to let go; one read that fails still lets it go.
  sent.length = 0;
  const failing = { request: async (type, payload) => { sent.push([type, payload]); return type === 'batch.office' ? { status: 'failed', message: 'Word couldn’t open it.' } : {}; } };
  const failed = await office.run({ input, output: { held: true, name: 'x.pdf' }, params: {} }, { ...env, host: failing });
  assert.deepEqual([failed.status, failed.message, sent.map((s) => s[0])], ['failed', 'Word couldn’t open it.', ['batch.office']]);
  sent.length = 0;
  const unread = await office.run({ input, output: { held: true, name: 'x.pdf' }, params: {} }, { ...env, readFile: async () => { throw new Error('gone'); } });
  assert.deepEqual([unread.status, unread.code, sent.map((s) => s[0])], ['failed', 'unreadable', ['batch.office', 'batch.release']]);
});
