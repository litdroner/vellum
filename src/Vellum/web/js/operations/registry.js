// Operations: what Vellum can do to a file with nobody at the screen. Each has a stable id, the files it takes,
// the file it makes, serialisable parameters and run(): no dialog, no open document, no tool id and no command.
// Batch processing (batch/) runs one over many files, and a workflow (flow/) runs several in a row
// (docs/ARCHITECTURE_GUIDELINES.md, "Operations, batch processing and workflows"). An operation is the feature's own core,
// reached without its UI — never a second implementation of it:
//
//   office.toPdf      the host's Office → PDF operation (Services/Conversion), one file per bridge call (batch.office)
//   pdf.compress      Compress PDF V1 (optimize/compress.js), on the file's bytes
//   pdf.pageNumbers   Page numbers (pages/stamps.js writePageSettings, what saving writes), on every page
//   pdf.watermark     Watermark, text only (the same writer), on every page
//
// An operation:
//   id            stable forever: a workflow step names it. Never a tool id or a command id
//   name, verb    "Compress PDFs", "Compressing"; step: what it is as one step of a workflow ("Compress");
//                 noun: what one input is ("PDF"); about: one sentence on what it does and that the sources
//                 aren't changed
//   accept        the batch.choose kind ('pdf', 'office'); accepts(name): whether it takes a file by its name;
//                 makes: the kind of file it makes ('pdf'), which the next step of a workflow must accept
//   outputName    the new file's name from the input's (a PDF beside a Word document keeps its name)
//   params        defaults; checkParams(params) gives them back whole and valid, or throws; choices: how a
//                 person picks each one — [{ param, label, options: [{ value, label, note }] }], or
//                 { param, label, kind: 'text', maxLength } for words — none when it has none.
//                 verify(params, { pdfLib }) (optional, async): what checkParams can't know without pdf-lib, as a
//                 sentence, or null
//   timeoutMs     how long one file may take before the runner stops it
//   refusal(input, context)   why it can't take this file on this PC now (context.presence), or null
//   presentIf     (optional) the presence name (requirements.js) it needs on this PC at all; absent: the sentence
//                 that says it isn't there. Without it a workflow can't offer or run the operation
//   run(job, env) the work, for one file. job: { input: { token, path, name, url } | { name, bytes }, output:
//                 { folder, name } | { held: true, name }, params, overwrite: 'replace' | 'keepBoth' }. env: { signal,
//                 progress(label), host.request(), readFile(input), writeFile({ folder, name, overwrite }, bytes),
//                 pdfLib() }. A held output is a workflow's step in between: its file is kept in memory for the
//                 next step (writeFile gives back { name, held, bytes }), never written where the person looks.
//                 Resolves an outcome: { status: 'succeeded' | 'failed' | 'skipped' | 'cancelled' | 'timedOut',
//                 code, message, output: { name, path } | { name, held, bytes } | null, note, details, provider,
//                 diagnostics, stopBatch }. A refusal is an outcome, never an exception; once env.signal is
//                 aborted it writes nothing more. stopBatch: nothing else in the batch can succeed either (no
//                 provider left on this PC)
//
// This module imports no UI and no bridge: env is how an operation reaches the host, so it runs anywhere.

import { COMPRESSION_LEVELS, CompressError, DEFAULT_LEVEL, compressDocument, formatBytes, isSigned } from '../optimize/compress.js';
import { ANY_OFFICE, OFFICE_NOUNS, officeFormatOf, presenceName } from '../office/formats.js';
import { PAGE_NUMBER_POSITIONS, WATERMARK_POSITIONS, unsupportedCharacters, writePageSettings } from '../pages/stamps.js';

const stemOf = (name) => String(name).replace(/\.[^.\\]*$/, '');
const extensionOf = (name) => { const m = /\.[^.\\]*$/.exec(String(name)); return m ? m[0].toLowerCase() : ''; };
const isPdfName = (name) => extensionOf(name) === '.pdf';
const frozenOptions = (list) => Object.freeze(list.map(([value, label, note = null]) => Object.freeze({ value, label, note })));

/** An outcome, with every field present; `status` is always the one given, whatever `fields` holds. */
export const outcome = (status, fields = {}) => Object.freeze({
  code: null, message: '', output: null, note: null, details: [], provider: null, diagnostics: null, stopBatch: false, ...fields, status,
});

const STOPPED = 'Stopped before it finished. Nothing was saved.';
const SIGNED = 'This PDF is digitally signed. The new file is a changed copy, so it doesn’t carry the signature.';

const officeToPdf = Object.freeze({
  id: 'office.toPdf',
  name: 'Convert Office files to PDF',
  step: 'Convert to PDF',
  verb: 'Converting',
  noun: 'Office document',
  about: 'An Office application on this PC converts each document to a PDF, one at a time. The documents themselves aren’t changed.',
  accept: 'office',
  makes: 'pdf',
  accepts: (name) => officeFormatOf(name) !== null,
  unsupported: 'Not a Word, Excel or PowerPoint document.',
  outputName: (name) => `${stemOf(name)}.pdf`,
  params: Object.freeze({}),
  choices: Object.freeze([]),
  checkParams: () => Object.freeze({}),
  // The host stops a conversion at 3 minutes by itself (OfficeConversion.DefaultTimeout); this is the net under it.
  timeoutMs: 4 * 60_000,
  presentIf: ANY_OFFICE,
  absent: 'No Office application on this PC converts documents to PDF.',
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
      // A held PDF is converted into the host's own work folder, and handed over by a read-only token.
      reply = await env.host.request('batch.office', output.held
        ? { source: input.token, name: output.name, hold: true }
        : { source: input.token, folder: output.folder, name: output.name, overwrite });
    } finally {
      env.signal.removeEventListener('abort', cancel);
    }
    return output.held ? takeHeld(reply, env) : fromOffice(reply);
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

/** A held conversion: the PDF read into memory from the host's work folder, which then lets it go. */
async function takeHeld(reply, env) {
  const result = fromOffice(reply);
  const token = reply?.output?.token ?? null;
  try {
    if (result.status !== 'succeeded') return result;
    if (!token || !reply.output.url) return outcome('failed', { ...result, output: null, code: 'noOutput', message: 'The conversion reported no PDF, so nothing is shown as made.' });
    if (env.signal.aborted) return outcome('cancelled', { ...result, output: null, message: STOPPED });
    let bytes;
    try {
      bytes = await env.readFile({ token, url: reply.output.url, name: reply.output.name });
    } catch (err) {
      if (env.signal.aborted) return outcome('cancelled', { ...result, output: null, message: STOPPED });
      return outcome('failed', { ...result, output: null, code: 'unreadable', message: 'Vellum couldn’t read the converted PDF.', diagnostics: String(err?.message ?? err) });
    }
    return outcome('succeeded', { ...result, output: { name: reply.output.name, held: true, bytes } });
  } finally {
    if (token) env.host.request('batch.release', { token }).catch(() => {});
  }
}

/** The input's bytes, or the outcome that says why there are none. */
async function readInput(input, env) {
  try {
    return { bytes: await env.readFile(input) };
  } catch (err) {
    if (env.signal.aborted) return { stopped: outcome('cancelled', { message: STOPPED }) };
    return { stopped: outcome('failed', { code: 'unreadable', message: 'Vellum couldn’t read this file. It may have been moved, renamed or deleted.', diagnostics: String(err?.message ?? err) }) };
  }
}

/** Writes `bytes` as the job's output: a failure to write is an outcome, and nothing is written once stopped. */
async function writeOutput({ output, overwrite }, env, bytes, fields) {
  if (env.signal.aborted) return outcome('cancelled', { message: STOPPED });
  let written;
  try {
    written = await env.writeFile({ folder: output.folder, name: output.name, overwrite }, bytes);
  } catch (err) {
    return outcome('failed', { code: 'notWritten', message: String(err?.message ?? err) });
  }
  return outcome('succeeded', { ...fields, output: written });
}

const compressPdf = Object.freeze({
  id: 'pdf.compress',
  name: 'Compress PDFs',
  step: 'Compress',
  verb: 'Compressing',
  noun: 'PDF',
  about: 'Vellum writes a smaller copy of each PDF without changing anything it shows. The PDFs themselves aren’t changed.',
  accept: 'pdf',
  makes: 'pdf',
  accepts: isPdfName,
  unsupported: 'Not a PDF.',
  outputName: (name) => `${stemOf(name)} (compressed).pdf`,
  params: Object.freeze({ level: DEFAULT_LEVEL }),
  choices: Object.freeze([Object.freeze({ param: 'level', label: 'Level', options: frozenOptions(COMPRESSION_LEVELS.map((l) => [l.id, l.label, l.note])) })]),
  checkParams(params = {}) {
    const level = params.level ?? DEFAULT_LEVEL;
    if (!COMPRESSION_LEVELS.some((l) => l.id === level)) throw new Error(`“${level}” isn’t an optimization level Vellum has.`);
    return Object.freeze({ level });
  },
  timeoutMs: 10 * 60_000,
  refusal: () => null,
  async run(job, env) {
    const { bytes, stopped } = await readInput(job.input, env);
    if (stopped) return stopped;
    let report;
    try {
      report = await compressDocument({
        lib: await env.pdfLib(), bytes, level: job.params.level, signal: env.signal,
        onProgress: ({ label }) => env.progress?.(label),
      });
    } catch (err) {
      if (env.signal.aborted) return outcome('cancelled', { message: STOPPED });
      if (err instanceof CompressError) return outcome('failed', { code: 'refused', message: err.message, details: [...(err.details ?? [])] });
      throw err;
    }
    // Stopped while the copy was being made: it is never written.
    const note = report.identical
      ? 'Already as small as Vellum can make it: the copy is the same file'
      : `${formatBytes(report.before)} → ${formatBytes(report.after)} (${Math.round(report.ratio * 100)}% smaller)`;
    return writeOutput(job, env, report.bytes, {
      code: report.identical ? 'identical' : 'compressed', message: 'Compressed.', note, details: [...report.warnings],
    });
  },
});

// ---- page numbers and watermarks ---------------------------------------------------------------

const PAGE_FORMATS = frozenOptions([['{n}', '1, 2, 3'], ['Page {n}', 'Page 1'], ['Page {n} of {total}', 'Page 1 of 9'], ['{n} / {total}', '1 / 9']]);
const NUMERALS = frozenOptions([['arabic', '1, 2, 3'], ['roman', 'i, ii, iii'], ['ROMAN', 'I, II, III']]);
const placeLabel = (p) => p.split('-').map((w, i) => (i ? w : w[0].toUpperCase() + w.slice(1))).join(' ');
const PAGE_POSITIONS = frozenOptions(PAGE_NUMBER_POSITIONS.map((p) => [p, placeLabel(p)]));
const MARK_POSITIONS = frozenOptions(WATERMARK_POSITIONS.map((p) => [p, placeLabel(p)]));
const ANGLES = frozenOptions([['diagonal', 'Diagonal'], ['level', 'Level']]);
const WATERMARK_TEXT_MAX = 100;
const NUMBERS_DEFAULT = Object.freeze({ format: 'Page {n} of {total}', position: 'bottom-center', style: 'arabic' });
const MARK_DEFAULT = Object.freeze({ text: 'DRAFT', position: 'center', angle: 'diagonal' });

/** `value` if it is one of `options`' values; otherwise an error that names `what`. */
function oneOf(value, options, what) {
  if (!options.some((o) => o.value === value)) throw new Error(`“${value}” isn’t a ${what} Vellum has.`);
  return value;
}

/** Characters the standard PDF font can't write, as the Page numbers and Watermark dialogs say it. */
async function fontProblem(text, pdfLib) {
  const bad = await unsupportedCharacters(await pdfLib(), text);
  return bad ? `These characters can’t be written in the standard PDF font: ${bad}` : null;
}

/**
 * The shared core of the two stamps: every page of the file gets `setting` (a page plan entry: pageNumber or
 * watermark) through writePageSettings — the writer saving a document uses — and the result is a new file.
 */
async function stampEvery(job, env, setting, { verb, done }) {
  const { bytes, stopped } = await readInput(job.input, env);
  if (stopped) return stopped;
  const lib = await env.pdfLib();
  if (env.signal.aborted) return outcome('cancelled', { message: STOPPED });
  let doc;
  try {
    doc = await lib.PDFDocument.load(bytes, { updateMetadata: false });
  } catch (err) {
    const message = /encrypt/i.test(String(err?.message ?? err))
      ? 'This PDF is protected (encrypted), so Vellum can’t change it.'
      : `This PDF couldn’t be read (${err?.message ?? err}).`;
    return outcome('failed', { code: 'unreadable', message });
  }
  env.progress?.(`${verb}…`);
  const pages = doc.getPages();
  if (!pages.length) return outcome('failed', { code: 'noPages', message: 'This PDF has no pages.' });
  let out;
  try {
    await writePageSettings({ lib, doc, pages, plan: pages.map(() => setting), sources: new Map() });
    out = await doc.save({ useObjectStreams: false });
  } catch (err) {
    if (env.signal.aborted) return outcome('cancelled', { message: STOPPED });
    return outcome('failed', { code: 'notWritten', message: 'Vellum couldn’t write the changed copy of this PDF.', diagnostics: String(err?.stack ?? err) });
  }
  const pageCount = `${pages.length} ${pages.length === 1 ? 'page' : 'pages'}`;
  return writeOutput(job, env, out, { code: 'stamped', message: `${done}.`, note: `${done} on ${pageCount}`, details: isSigned(lib, doc) ? [SIGNED] : [] });
}

const pageNumbers = Object.freeze({
  id: 'pdf.pageNumbers',
  name: 'Number the pages of PDFs',
  step: 'Add page numbers',
  verb: 'Numbering',
  noun: 'PDF',
  about: 'Vellum writes a copy of each PDF with every page’s number on it, as text. The PDFs themselves aren’t changed.',
  accept: 'pdf',
  makes: 'pdf',
  accepts: isPdfName,
  unsupported: 'Not a PDF.',
  outputName: (name) => `${stemOf(name)} (numbered).pdf`,
  params: NUMBERS_DEFAULT,
  choices: Object.freeze([
    Object.freeze({ param: 'format', label: 'Text', options: PAGE_FORMATS }),
    Object.freeze({ param: 'style', label: 'Numerals', options: NUMERALS }),
    Object.freeze({ param: 'position', label: 'Position', options: PAGE_POSITIONS }),
  ]),
  checkParams(params = {}) {
    return Object.freeze({
      format: oneOf(params.format ?? NUMBERS_DEFAULT.format, PAGE_FORMATS, 'page number text'),
      style: oneOf(params.style ?? NUMBERS_DEFAULT.style, NUMERALS, 'kind of numeral'),
      position: oneOf(params.position ?? NUMBERS_DEFAULT.position, PAGE_POSITIONS, 'page number position'),
    });
  },
  timeoutMs: 5 * 60_000,
  refusal: () => null,
  run(job, env) {
    // The Page numbers dialog's own size and counting, from the first page of the document.
    const { format, style, position } = job.params;
    return stampEvery(job, env, { pageNumber: { format, style, position, size: 10, start: 1, restart: false } }, { verb: 'Numbering the pages', done: 'Numbered' });
  },
});

const watermark = Object.freeze({
  id: 'pdf.watermark',
  name: 'Watermark PDFs',
  step: 'Add a watermark',
  verb: 'Watermarking',
  noun: 'PDF',
  about: 'Vellum writes a copy of each PDF with the words over every page. The PDFs themselves aren’t changed.',
  accept: 'pdf',
  makes: 'pdf',
  accepts: isPdfName,
  unsupported: 'Not a PDF.',
  outputName: (name) => `${stemOf(name)} (watermarked).pdf`,
  params: MARK_DEFAULT,
  choices: Object.freeze([
    Object.freeze({ param: 'text', label: 'Text', kind: 'text', maxLength: WATERMARK_TEXT_MAX }),
    Object.freeze({ param: 'position', label: 'Position', options: MARK_POSITIONS }),
    Object.freeze({ param: 'angle', label: 'Angle', options: ANGLES }),
  ]),
  checkParams(params = {}) {
    const text = typeof params.text === 'string' ? params.text.trim() : MARK_DEFAULT.text;
    if (!text) throw new Error('Enter the watermark text.');
    if (text.length > WATERMARK_TEXT_MAX) throw new Error(`A watermark can be at most ${WATERMARK_TEXT_MAX} characters.`);
    return Object.freeze({
      text,
      position: oneOf(params.position ?? MARK_DEFAULT.position, MARK_POSITIONS, 'watermark position'),
      angle: oneOf(params.angle ?? MARK_DEFAULT.angle, ANGLES, 'watermark angle'),
    });
  },
  verify: (params, { pdfLib }) => fontProblem(params.text, pdfLib),
  timeoutMs: 5 * 60_000,
  refusal: () => null,
  async run(job, env) {
    const { text, position, angle } = job.params;
    const problem = await fontProblem(text, env.pdfLib);
    if (problem) return outcome('failed', { code: 'refused', message: problem });
    // The Watermark dialog's own size and opacity.
    return stampEvery(job, env, { watermark: { text, position, size: 60, opacity: 0.2, rotation: angle === 'level' ? 0 : 45 } }, { verb: 'Adding the watermark', done: 'Watermarked' });
  },
});

/** Every operation, by id. */
export const OPERATIONS = Object.freeze(new Map([officeToPdf, compressPdf, pageNumbers, watermark].map((op) => [op.id, op])));

/** The operation with this id, or null. */
export const operation = (id) => OPERATIONS.get(id) ?? null;
