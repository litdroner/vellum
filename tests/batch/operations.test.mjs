// The operations batch processing runs (web/js/operations/registry.js), each through a fake host: Office → PDF
// asks the host for one file and says what the host's office.toPdf result means, stopping the conversion when
// the file is stopped; Compress runs the real Compress PDF V1 on generated PDFs and writes only what it made,
// never once stopped. No app, no Office, nothing written to disk.
// Run: node --test "tests/batch/*.test.mjs"

import test from 'node:test';
import assert from 'node:assert/strict';
import { loadPdfLib, webModule } from '../editing/harness.mjs';

const { OPERATIONS, operation, fromOffice } = await webModule('operations/registry.js');

const input = { token: 'tok', path: 'C:\\in\\Quarterly report.docx', name: 'Quarterly report.docx', url: 'https://app.vellum/doc/tok' };
const job = (over = {}) => ({ input, output: { folder: 'C:\\in', name: 'Quarterly report.pdf' }, params: {}, overwrite: 'keepBoth', ...over });

test('the registry: stable ids, one per operation, each complete; no tool id, command id or UI in a record', () => {
  assert.deepEqual([...OPERATIONS.keys()], ['office.toPdf', 'pdf.compress']);
  for (const op of OPERATIONS.values()) {
    for (const key of ['id', 'name', 'verb', 'noun', 'about', 'accept', 'unsupported']) assert.equal(typeof op[key], 'string', `${op.id}.${key}`);
    for (const key of ['accepts', 'outputName', 'checkParams', 'refusal', 'run']) assert.equal(typeof op[key], 'function', `${op.id}.${key}`);
    assert.ok(op.timeoutMs > 0 && Array.isArray(op.choices) && Object.isFrozen(op), op.id);
    assert.ok(!('command' in op) && !('tool' in op), op.id);
    // Parameters are plain data: they survive being written down (a Flow step will keep them).
    assert.deepEqual(JSON.parse(JSON.stringify(op.checkParams(op.params))), { ...op.checkParams(op.params) });
  }
  assert.equal(operation('nope'), null);
});

test('Office → PDF: takes Word, Excel and PowerPoint files only; the PDF keeps the document’s name', () => {
  const office = operation('office.toPdf');
  assert.deepEqual(['a.docx', 'a.DOC', 'b.xlsx', 'b.xls', 'c.pptx', 'c.ppt', 'd.pdf', 'e.txt', 'docx'].map(office.accepts),
    [true, true, true, true, true, true, false, false, false]);
  assert.equal(office.outputName('Quarterly report.v2.docx'), 'Quarterly report.v2.pdf');
});

test('Office → PDF: one bridge request per file, and each host result said as it is', async () => {
  const office = operation('office.toPdf');
  const requests = [];
  const reply = { status: 'converted', message: 'Converted with Microsoft Office.', provider: 'microsoft-office', providerName: 'Microsoft Office', output: { name: 'Quarterly report.pdf', path: 'C:\\in\\Quarterly report.pdf' }, diagnostics: 'exit 0' };
  const host = { request: async (type, payload) => { requests.push([type, payload]); return reply; } };
  const result = await office.run(job(), { signal: new AbortController().signal, host });
  assert.deepEqual(requests, [['batch.office', { source: 'tok', folder: 'C:\\in', name: 'Quarterly report.pdf', overwrite: 'keepBoth' }]]);
  assert.deepEqual([result.status, result.output.path, result.provider.name, result.diagnostics], ['succeeded', 'C:\\in\\Quarterly report.pdf', 'Microsoft Office', 'exit 0']);

  const said = (status) => fromOffice({ status, message: `host: ${status}` });
  assert.deepEqual(['cancelled', 'timedOut', 'unsupportedFormat', 'protected', 'invalidInput', 'notSupported', 'unavailable', 'failed', 'noProvider', 'surprise'].map((s) => said(s).status),
    ['cancelled', 'timedOut', 'skipped', 'failed', 'failed', 'failed', 'failed', 'failed', 'failed', 'failed']);
  assert.equal(said('protected').message, 'host: protected', 'the host’s own sentence');
  assert.equal(said('noProvider').stopBatch, true, 'no provider at all: the rest can’t succeed either');
  assert.equal(said('notSupported').stopBatch, false, 'one format missing: the others still can');
  assert.equal(fromOffice({ status: 'converted', message: 'ok' }).status, 'failed', 'converted with no PDF is not a success');
  assert.equal(fromOffice(null).status, 'failed');
});

test('Office → PDF: stopping the file asks the host to cancel the conversion that is running', async () => {
  const office = operation('office.toPdf');
  const controller = new AbortController();
  const sent = [];
  let finish;
  const host = {
    request: (type) => {
      sent.push(type);
      if (type === 'office.cancel') { finish({ status: 'cancelled', message: 'The conversion was cancelled; nothing was saved.' }); return Promise.resolve({}); }
      return new Promise((resolve) => { finish = resolve; });
    },
  };
  const running = office.run(job(), { signal: controller.signal, host });
  controller.abort();
  const result = await running;
  assert.deepEqual(sent, ['batch.office', 'office.cancel']);
  assert.equal(result.status, 'cancelled');
});

/** A small real PDF, with an uncompressed content stream Compress can shrink. */
async function pdf(lib) {
  const doc = await lib.PDFDocument.create({ updateMetadata: false });
  const page = doc.addPage([300, 300]);
  page.drawText('Batch '.repeat(40), { x: 10, y: 150, size: 6 });
  return doc.save({ useObjectStreams: false });
}

function compressEnv({ bytes, signal = new AbortController().signal, write = null } = {}) {
  const written = [];
  return {
    written,
    env: {
      signal, progress: () => {}, pdfLib: loadPdfLib,
      readFile: async () => { if (bytes instanceof Error) throw bytes; return bytes; },
      writeFile: async (target, data) => {
        if (write) return write(target, data);
        written.push({ target, data });
        return { name: target.name, path: `${target.folder}\\${target.name}` };
      },
    },
  };
}

test('Compress: a smaller copy through the host’s writer, under the planned name; the source bytes untouched', async () => {
  const compress = operation('pdf.compress');
  const lib = await loadPdfLib();
  const bytes = await pdf(lib);
  const before = bytes.slice();
  const { env, written } = compressEnv({ bytes });
  const params = compress.checkParams({ level: 'smaller' });
  const result = await compress.run(job({ input: { ...input, name: 'a.pdf' }, output: { folder: 'C:\\in', name: 'a (compressed).pdf' }, params }), env);
  assert.equal(result.status, 'succeeded', result.message);
  assert.deepEqual(written.map((w) => [w.target.folder, w.target.name, w.target.overwrite]), [['C:\\in', 'a (compressed).pdf', 'keepBoth']]);
  assert.equal(new TextDecoder().decode(written[0].data.slice(0, 5)), '%PDF-');
  assert.equal(result.output.path, 'C:\\in\\a (compressed).pdf');
  assert.ok(result.note, 'says how much smaller, or that it already was as small');
  assert.deepEqual(bytes, before);
});

test('Compress: an unreadable file, a file that isn’t a PDF, and a host that can’t write are each failures in words', async () => {
  const compress = operation('pdf.compress');
  const params = compress.checkParams({});
  const gone = compressEnv({ bytes: new Error('404') });
  const unreadable = await compress.run(job({ params }), gone.env);
  assert.deepEqual([unreadable.status, unreadable.code], ['failed', 'unreadable']);

  const garbage = compressEnv({ bytes: new TextEncoder().encode('not a pdf at all') });
  const refused = await compress.run(job({ params }), garbage.env);
  assert.deepEqual([refused.status, refused.code, garbage.written.length], ['failed', 'refused', 0]);
  assert.match(refused.message, /couldn’t be read/);

  const lib = await loadPdfLib();
  const denied = compressEnv({ bytes: await pdf(lib), write: async () => { throw new Error('Vellum isn’t allowed to write this file.'); } });
  const notWritten = await compress.run(job({ params }), denied.env);
  assert.deepEqual([notWritten.status, notWritten.code, notWritten.message], ['failed', 'notWritten', 'Vellum isn’t allowed to write this file.']);
});

test('Compress: stopped while it works, it writes nothing', async () => {
  const compress = operation('pdf.compress');
  const lib = await loadPdfLib();
  const controller = new AbortController();
  const { env, written } = compressEnv({ bytes: await pdf(lib), signal: controller.signal });
  env.progress = () => controller.abort(); // Stop pressed as soon as it starts
  const result = await compress.run(job({ params: compress.checkParams({}) }), env);
  assert.deepEqual([result.status, written.length], ['cancelled', 0]);
  assert.match(result.message, /Nothing was saved/);
});
