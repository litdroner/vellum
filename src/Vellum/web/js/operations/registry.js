// Operations: what Vellum can do to a file with nobody at the screen. Each has a stable id, the files it takes,
// the file it makes, serialisable parameters and run(): no dialog, no open document, no tool id and no command.
// Batch processing (batch/) runs one over many files, and Vellum Flow will compose them
// (docs/ARCHITECTURE_GUIDELINES.md, "Operations and batch processing"). An operation is the feature's own core,
// reached without its UI — never a second implementation of it:
//
//   office.toPdf   the host's Office → PDF operation (Services/Conversion), one file per bridge call (batch.office)
//   pdf.compress   Compress PDF V1 (optimize/compress.js), on the file's bytes
//
// An operation:
//   id            stable forever: a Flow step will name it. Never a tool id or a command id
//   name, verb    "Compress PDFs", "Compressing"; noun: what one input is ("PDF"); about: one sentence on what
//                 it does and that the sources aren't changed
//   accept        the batch.choose kind ('pdf', 'office'); accepts(name): whether it takes a file by its name
//   outputName    the new file's name from the input's (a PDF beside a Word document keeps its name)
//   params        defaults; checkParams(params) gives them back whole and valid, or throws; choices: how a
//                 person picks each one ([{ param, options: [{ value, label, note }] }]), none when it has none
//   timeoutMs     how long one file may take before the runner stops it
//   refusal(input, context)   why it can't take this file on this PC now (context.presence), or null
//   run(job, env) the work, for one file. job: { input: { token, path, name, url }, output: { folder, name },
//                 params, overwrite: 'replace' | 'keepBoth' }. env: { signal, progress(label), host.request(),
//                 readFile(input), writeFile({ folder, name, overwrite }, bytes), pdfLib() }.
//                 Resolves an outcome: { status: 'succeeded' | 'failed' | 'skipped' | 'cancelled' | 'timedOut',
//                 code, message, output: { name, path } | null, note, details, provider, diagnostics, stopBatch }.
//                 A refusal is an outcome, never an exception; once env.signal is aborted it writes nothing more.
//                 stopBatch: nothing else in the batch can succeed either (no provider left on this PC)
//
// This module imports no UI and no bridge: env is how an operation reaches the host, so it runs anywhere.

import { COMPRESSION_LEVELS, CompressError, DEFAULT_LEVEL, compressDocument, formatBytes } from '../optimize/compress.js';
import { OFFICE_NOUNS, officeFormatOf, presenceName } from '../office/formats.js';

const stemOf = (name) => String(name).replace(/\.[^.\\]*$/, '');
const extensionOf = (name) => { const m = /\.[^.\\]*$/.exec(String(name)); return m ? m[0].toLowerCase() : ''; };

/** An outcome, with every field present; `status` is always the one given, whatever `fields` holds. */
export const outcome = (status, fields = {}) => Object.freeze({
  code: null, message: '', output: null, note: null, details: [], provider: null, diagnostics: null, stopBatch: false, ...fields, status,
});

const STOPPED = 'Stopped before it finished. Nothing was saved.';

const officeToPdf = Object.freeze({
  id: 'office.toPdf',
  name: 'Convert Office files to PDF',
  verb: 'Converting',
  noun: 'Office document',
  about: 'An Office application on this PC converts each document to a PDF, one at a time. The documents themselves aren’t changed.',
  accept: 'office',
  accepts: (name) => officeFormatOf(name) !== null,
  unsupported: 'Not a Word, Excel or PowerPoint document.',
  outputName: (name) => `${stemOf(name)}.pdf`,
  params: Object.freeze({}),
  choices: Object.freeze([]),
  checkParams: () => Object.freeze({}),
  // The host stops a conversion at 3 minutes by itself (OfficeConversion.DefaultTimeout); this is the net under it.
  timeoutMs: 4 * 60_000,
  /** Nothing on this PC converts this format (presence, from the host's office.providers). */
  refusal(input, { presence = {} } = {}) {
    const format = officeFormatOf(input.name);
    return format && presence[presenceName(format)] !== true ? `Nothing on this PC can convert a ${OFFICE_NOUNS[format]} to PDF.` : null;
  },
  async run({ input, output, overwrite }, env) {
    // The host converts one document at a time and stops it on office.cancel (the Office tools use the same).
    const cancel = () => { env.host.request('office.cancel').catch(() => {}); };
    env.signal.addEventListener('abort', cancel, { once: true });
    let reply;
    try {
      env.progress?.('Converting…');
      reply = await env.host.request('batch.office', { source: input.token, folder: output.folder, name: output.name, overwrite });
    } finally {
      env.signal.removeEventListener('abort', cancel);
    }
    return fromOffice(reply);
  },
});

/** One office.toPdf result (MainWindow.Batch.cs BatchItem) as an outcome. */
export function fromOffice(reply) {
  const provider = reply?.provider ? { id: reply.provider, name: reply.providerName ?? reply.provider } : null;
  const message = typeof reply?.message === 'string' && reply.message ? reply.message : 'The document couldn’t be converted, so nothing was saved.';
  const common = { code: reply?.status ?? 'failed', message, provider, diagnostics: reply?.diagnostics ?? null };
  switch (reply?.status) {
    case 'converted':
      return reply.output?.path
        ? outcome('succeeded', { ...common, output: { name: reply.output.name, path: reply.output.path }, note: provider ? `Converted with ${provider.name}` : null })
        : outcome('failed', { ...common, code: 'noOutput', message: 'The conversion reported no PDF, so nothing is shown as made.' });
    case 'cancelled': return outcome('cancelled', common);
    case 'timedOut': return outcome('timedOut', common);
    case 'unsupportedFormat': return outcome('skipped', common);
    // Nothing on this PC converts anything any more: the rest of the batch can't succeed either.
    case 'noProvider': return outcome('failed', { ...common, stopBatch: true });
    default: return outcome('failed', common);
  }
}

const compressPdf = Object.freeze({
  id: 'pdf.compress',
  name: 'Compress PDFs',
  verb: 'Compressing',
  noun: 'PDF',
  about: 'Vellum writes a smaller copy of each PDF without changing anything it shows. The PDFs themselves aren’t changed.',
  accept: 'pdf',
  accepts: (name) => extensionOf(name) === '.pdf',
  unsupported: 'Not a PDF.',
  outputName: (name) => `${stemOf(name)} (compressed).pdf`,
  params: Object.freeze({ level: DEFAULT_LEVEL }),
  choices: Object.freeze([Object.freeze({ param: 'level', options: COMPRESSION_LEVELS.map((l) => Object.freeze({ value: l.id, label: l.label, note: l.note })) })]),
  checkParams(params = {}) {
    const level = params.level ?? DEFAULT_LEVEL;
    if (!COMPRESSION_LEVELS.some((l) => l.id === level)) throw new Error(`“${level}” isn’t an optimization level Vellum has.`);
    return Object.freeze({ level });
  },
  timeoutMs: 10 * 60_000,
  refusal: () => null,
  async run({ input, output, params, overwrite }, env) {
    let bytes;
    try {
      bytes = await env.readFile(input);
    } catch (err) {
      if (env.signal.aborted) return outcome('cancelled', { message: STOPPED });
      return outcome('failed', { code: 'unreadable', message: 'Vellum couldn’t read this file. It may have been moved, renamed or deleted.', diagnostics: String(err?.message ?? err) });
    }
    let report;
    try {
      report = await compressDocument({
        lib: await env.pdfLib(), bytes, level: params.level, signal: env.signal,
        onProgress: ({ label }) => env.progress?.(label),
      });
    } catch (err) {
      if (env.signal.aborted) return outcome('cancelled', { message: STOPPED });
      if (err instanceof CompressError) return outcome('failed', { code: 'refused', message: err.message, details: [...(err.details ?? [])] });
      throw err;
    }
    // Stopped while the copy was being made: it is never written.
    if (env.signal.aborted) return outcome('cancelled', { message: STOPPED });
    let written;
    try {
      written = await env.writeFile({ folder: output.folder, name: output.name, overwrite }, report.bytes);
    } catch (err) {
      return outcome('failed', { code: 'notWritten', message: String(err?.message ?? err) });
    }
    const note = report.identical
      ? 'Already as small as Vellum can make it: the copy is the same file'
      : `${formatBytes(report.before)} → ${formatBytes(report.after)} (${Math.round(report.ratio * 100)}% smaller)`;
    return outcome('succeeded', {
      code: report.identical ? 'identical' : 'compressed', message: 'Compressed.', output: written, note, details: [...report.warnings],
    });
  },
});

/** Every operation, by id. */
export const OPERATIONS = Object.freeze(new Map([officeToPdf, compressPdf].map((op) => [op.id, op])));

/** The operation with this id, or null. */
export const operation = (id) => OPERATIONS.get(id) ?? null;
