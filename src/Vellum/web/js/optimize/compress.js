// Compress PDF V1: makes a smaller copy of a document without changing a single thing it draws.
//
// Everything it does is structural, and every step is one the PDF format itself provides for. Nothing
// is rasterized, no image is re-encoded, no image is scaled, no font is subset and no page content is
// rewritten — a page's operators come out of the optimizer byte for byte as they went in. The three
// steps are:
//
//   unused objects removed   the reachability sweep Vellum already uses when it saves after deleting
//                            pages (annotations/persist.js removeUnreachable): anything the trailer
//                            can no longer reach — the leftovers of a previous program's incremental
//                            saves — is dropped
//   identical streams merged the same bytes stored twice (the same logo on forty pages, the same font
//                            embedded once per section) become one object. Two streams are merged only
//                            when their stored bytes are identical and their dictionaries match entry
//                            for entry, so what the page draws cannot change
//   streams compressed       a stream stored with no filter at all is stored with Flate instead, and
//                            only when that is actually smaller. Already-compressed streams, and
//                            images of any kind, are left exactly as they are
//
// The "Smaller file" level adds one more thing the format provides for: the objects and the
// cross-reference table are written as PDF 1.5 streams, which is where most of the remaining bytes of
// an ordinary document are. Nothing about the pages differs between the two levels.
//
// The document being compressed is opened read-only and is never written to; the result is new bytes.
// Before those bytes are handed back they are reopened and checked against an inventory of the source
// (optimize/inventory.js) — page by page, content, resources, annotations, fields, outline. If
// anything at all differs, the result is refused and nothing is written. And if the optimized file is
// not actually smaller, the source's own bytes are returned unchanged: an exact copy, never a larger
// one.

import { removeUnreachable } from '../annotations/persist.js';
import { compareInventory, hashBytes, inventory, sameBytes } from './inventory.js';

export class CompressError extends Error {
  constructor(message, details = []) {
    super(message);
    this.name = 'CompressError';
    this.details = details;
  }
}

/** The optimization levels, in the order the dialog offers them. */
export const COMPRESSION_LEVELS = Object.freeze([
  Object.freeze({
    id: 'safe',
    label: 'Standard',
    note: 'Plain file structure. Opens in every PDF reader, however old.',
  }),
  Object.freeze({
    id: 'smaller',
    label: 'Smaller file',
    note: 'Also packs the objects and the cross-reference table (PDF 1.5). Usually much smaller; needs a reader from 2003 or later.',
  }),
]);

export const DEFAULT_LEVEL = 'smaller';

const levelOf = (id) => COMPRESSION_LEVELS.find((l) => l.id === id) ?? null;

/** Filters whose chain pdf-lib can decode, so a stream behind them can be read back for comparison. */
const DECODABLE = new Set(['FlateDecode', 'LZWDecode', 'ASCII85Decode', 'ASCIIHexDecode', 'RunLengthDecode']);
/** Streams that are never merged or re-filtered: the file's own plumbing. */
const RESERVED_TYPES = new Set(['XRef', 'ObjStm', 'Metadata']);

/**
 * Compresses PDF bytes. Resolves a report; throws CompressError when the file can't be read, or when
 * the result doesn't match the source.
 *
 *   lib          pdf-lib (annotations/persist.js loadPdfLib)
 *   bytes        the document, untouched
 *   level        'safe' | 'smaller'
 *   onProgress   ({ step, label, index, total }) before each step
 *   signal       an AbortSignal; a stopped run throws no result and writes nothing
 *
 * report { level, before, after, saved, ratio, identical, steps, warnings, pageCount }
 *   steps    [{ id, label, count, note }] — what each step actually did, in the order it ran
 *   warnings sentences about the copy that are true whatever level was chosen (a signature)
 */
export async function compressDocument({ lib, bytes, level = DEFAULT_LEVEL, onProgress = null, signal = null } = {}) {
  const chosen = levelOf(level);
  if (!chosen) throw new CompressError(`“${level}” isn’t an optimization level Vellum has.`);
  const before = bytes.length;
  const total = 5;
  let at = 0;
  const step = (id, label) => {
    stopIfAsked(signal);
    onProgress?.({ step: id, label, index: at++, total });
  };

  step('read', 'Reading the document…');
  const source = await inventory(lib, bytes).catch((err) => {
    throw new CompressError(readingFailed(err), []);
  });
  const doc = await load(lib, bytes);
  const ctx = doc.context;
  const warnings = [];
  if (isSigned(lib, doc)) warnings.push('This PDF is digitally signed. The compressed copy is a new file, so it doesn’t carry the signature.');

  step('unused', 'Removing unused objects…');
  const unused = removeUnreachable(ctx, lib, []);

  step('merge', 'Merging identical streams…');
  const merged = mergeIdenticalStreams(lib, ctx);

  step('compress', 'Compressing streams…');
  const compressed = compressRawStreams(lib, ctx);

  step('write', 'Writing the copy…');
  const written = await doc.save({
    useObjectStreams: chosen.id === 'smaller',
    updateFieldAppearances: false,
    addDefaultPage: false,
  });
  stopIfAsked(signal);

  // Never hand back a bigger file than the one that went in: an exact copy is the honest result.
  const identical = written.length >= before;
  const out = identical ? bytes : written;

  const check = await inventory(lib, out).catch((err) => {
    throw new CompressError(`The compressed copy couldn’t be reopened, so Vellum didn’t write it (${err?.message ?? err}).`);
  });
  const differences = compareInventory(source, check);
  if (differences.length) {
    throw new CompressError('The compressed copy isn’t the same document, so Vellum didn’t write it.', differences);
  }

  onProgress?.({ step: 'done', label: 'Done', index: total, total });
  return Object.freeze({
    level: chosen.id,
    bytes: out,
    before,
    after: out.length,
    saved: Math.max(0, before - out.length),
    ratio: before ? Math.max(0, before - out.length) / before : 0,
    identical,
    pageCount: source.pageCount,
    steps: Object.freeze([
      frozenStep('unused', 'Unused objects removed', unused),
      frozenStep('merge', 'Identical streams merged', merged.count, merged.bytes ? `${merged.bytes} bytes of stored data stored once` : null),
      frozenStep('compress', 'Streams compressed', compressed.count, compressed.bytes ? `${compressed.bytes} bytes smaller` : null),
      frozenStep('structure', chosen.id === 'smaller' ? 'Objects and cross-reference table packed' : 'Plain file structure kept', null),
    ]),
    warnings: Object.freeze(warnings),
  });
}

const frozenStep = (id, label, count, note = null) => Object.freeze({ id, label, count, note });

function stopIfAsked(signal) {
  if (signal?.aborted) throw new CompressError('Stopped.');
}

async function load(lib, bytes) {
  try {
    return await lib.PDFDocument.load(bytes, { updateMetadata: false });
  } catch (err) {
    throw new CompressError(readingFailed(err));
  }
}

const readingFailed = (err) => (/encrypt/i.test(String(err?.message ?? err))
  ? 'This PDF is protected (encrypted), so Vellum can’t rewrite it.'
  : `This PDF couldn’t be read for compressing (${err?.message ?? err}).`);

/** The same test the document profile uses (editing/source.js), on an already-loaded document. */
function isSigned(lib, doc) {
  const { PDFName, PDFDict, PDFNumber, PDFArray, PDFString, PDFHexString } = lib;
  const form = doc.context.lookup(doc.catalog.get(PDFName.of('AcroForm')));
  const flags = form instanceof PDFDict ? doc.context.lookup(form.get(PDFName.of('SigFlags'))) : null;
  if (flags instanceof PDFNumber && (flags.asNumber() & 1) === 1) return true;
  for (const [, obj] of doc.context.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFDict)) continue;
    const range = obj.get(PDFName.of('ByteRange'));
    const contents = obj.get(PDFName.of('Contents'));
    if (range instanceof PDFArray && (contents instanceof PDFHexString || contents instanceof PDFString)) return true;
  }
  return false;
}

// ---- merging identical streams -----------------------------------------------------------------

/**
 * Streams stored twice become one. Two streams are the same only when their stored bytes are
 * identical and their dictionaries are identical entry for entry (apart from /Length, which is
 * written from the contents anyway) — so nothing that any page draws can change. The object that
 * survives is always the lowest-numbered one, which is what makes the result the same every time.
 * Returns { count, bytes }: how many objects went away and how many stored bytes that saved.
 */
export function mergeIdenticalStreams(lib, ctx) {
  const { PDFName, PDFStream } = lib;
  const buckets = new Map();
  for (const [ref, obj] of sortedObjects(ctx)) {
    if (!(obj instanceof PDFStream)) continue;
    const type = nameOf(lib, ctx, obj.dict.get(PDFName.of('Type')));
    if (type && RESERVED_TYPES.has(type)) continue;
    let contents;
    try { contents = obj.getContents(); } catch { continue; }
    if (!(contents instanceof Uint8Array)) continue;
    const key = `${dictSignature(lib, obj.dict)}|${contents.length}|${hashBytes(contents)}`;
    const bucket = buckets.get(key);
    if (bucket) bucket.push({ ref, obj, contents });
    else buckets.set(key, [{ ref, obj, contents }]);
  }

  const replacement = new Map(); // duplicate ref string → the ref that survives
  let bytes = 0;
  for (const bucket of buckets.values()) {
    if (bucket.length < 2) continue;
    const [keep, ...rest] = bucket;
    for (const other of rest) {
      // The hash only groups candidates; the bytes themselves decide.
      if (!sameBytes(keep.contents, other.contents)) continue;
      replacement.set(other.ref.toString(), keep.ref);
      bytes += other.contents.length;
    }
  }
  if (!replacement.size) return { count: 0, bytes: 0 };

  const seen = new Set();
  for (const [, obj] of sortedObjects(ctx)) redirect(lib, obj, replacement, seen);
  for (const value of Object.values(ctx.trailerInfo)) redirect(lib, value, replacement, seen);
  let count = 0;
  for (const key of replacement.keys()) {
    const [number, generation] = key.split(' ');
    ctx.delete(lib.PDFRef.of(Number(number), Number(generation)));
    count++;
  }
  return { count, bytes };
}

/**
 * Points every reference inside one object at the object that survived the merge. Direct
 * dictionaries and arrays nested inside it are followed too; references are not, since every
 * indirect object is visited in its own right.
 */
function redirect(lib, obj, replacement, seen) {
  const { PDFDict, PDFArray, PDFStream, PDFRef } = lib;
  const target = obj instanceof PDFStream ? obj.dict : obj;
  if (!(target instanceof PDFDict) && !(target instanceof PDFArray)) return;
  if (seen.has(target)) return;
  seen.add(target);
  if (target instanceof PDFDict) {
    for (const [name, value] of target.entries()) {
      if (value instanceof PDFRef) {
        const to = replacement.get(value.toString());
        if (to) target.set(name, to);
      } else {
        redirect(lib, value, replacement, seen);
      }
    }
    return;
  }
  const list = target.asArray();
  for (let i = 0; i < list.length; i++) {
    const value = list[i];
    if (value instanceof PDFRef) {
      const to = replacement.get(value.toString());
      if (to) target.set(i, to);
    } else {
      redirect(lib, value, replacement, seen);
    }
  }
}

/** A stream's dictionary as text, without /Length: two streams match only when this matches too. */
function dictSignature(lib, dict) {
  const parts = [];
  for (const [name, value] of dict.entries()) {
    const key = name.decodeText();
    if (key === 'Length') continue;
    parts.push(`${key}=${value.toString()}`);
  }
  parts.sort();
  return parts.join(';');
}

// ---- compressing streams stored with no filter --------------------------------------------------

/**
 * A stream stored with no filter at all is stored with Flate instead — and only when Flate is
 * actually smaller. Its bytes are not touched: the same contents, differently stored. Streams that
 * already have a filter, and the file's own plumbing (/XRef, /ObjStm, /Metadata, which PDF/A requires
 * to stay readable), are left alone. Returns { count, bytes }.
 */
export function compressRawStreams(lib, ctx) {
  const { PDFName, PDFRawStream } = lib;
  let count = 0;
  let bytes = 0;
  for (const [ref, obj] of sortedObjects(ctx)) {
    if (!(obj instanceof PDFRawStream)) continue;
    if (obj.dict.has(PDFName.of('Filter'))) continue;
    const type = nameOf(lib, ctx, obj.dict.get(PDFName.of('Type')));
    if (type && RESERVED_TYPES.has(type)) continue;
    const contents = obj.getContents();
    if (!contents?.length) continue;
    const deflated = deflate(ctx, contents);
    if (deflated.length >= contents.length) continue;
    ctx.assign(ref, PDFRawStream.of(withFilter(lib, ctx, obj.dict, 'FlateDecode'), deflated));
    count++;
    bytes += contents.length - deflated.length;
  }
  return { count, bytes };
}

/**
 * Re-stores a stream whose filters pdf-lib can decode as a single Flate stream. Used by the PDF/A
 * conversion for LZW, which PDF/A doesn't allow (optimize/pdfa.js). The decoded bytes are unchanged.
 * Returns true when the stream was re-stored.
 */
export function reflate(lib, ctx, ref, stream) {
  const { PDFName, PDFRawStream } = lib;
  if (!(stream instanceof PDFRawStream) || !filtersDecodable(lib, ctx, stream.dict)) return false;
  let decoded;
  try { decoded = lib.decodePDFRawStream(stream).decode(); } catch { return false; }
  const dict = withFilter(lib, ctx, stream.dict, 'FlateDecode');
  dict.delete(PDFName.of('DecodeParms'));
  dict.delete(PDFName.of('DP'));
  ctx.assign(ref, PDFRawStream.of(dict, deflate(ctx, decoded)));
  return true;
}

/** Whether every filter on a stream is one pdf-lib can decode (so it can be re-stored as Flate). */
export function filtersDecodable(lib, ctx, dict) {
  for (const name of filterNames(lib, ctx, dict)) if (!DECODABLE.has(name)) return false;
  return true;
}

/** The names of a stream's filters, in order; [] when it has none. */
export function filterNames(lib, ctx, dict) {
  const { PDFName, PDFArray } = lib;
  const filter = ctx.lookup(dict.get(PDFName.of('Filter')));
  if (filter instanceof PDFName) return [filter.decodeText()];
  if (filter instanceof PDFArray) {
    return filter.asArray().map((f) => {
      const value = ctx.lookup(f);
      return value instanceof PDFName ? value.decodeText() : '?';
    });
  }
  return [];
}

/** A copy of a stream dictionary with one filter and no stale /Length (the writer sets it). */
function withFilter(lib, ctx, dict, filter) {
  const { PDFName } = lib;
  const copy = dict.clone(ctx);
  copy.set(PDFName.of('Filter'), PDFName.of(filter));
  copy.delete(PDFName.of('Length'));
  return copy;
}

/** Flate, through pdf-lib's own encoder, so there is only one deflate in Vellum. */
function deflate(ctx, contents) {
  return ctx.flateStream(contents).getContents();
}

/** Every indirect object, lowest number first: the order that makes every run give the same file. */
function sortedObjects(ctx) {
  return [...ctx.enumerateIndirectObjects()].sort(([a], [b]) => a.objectNumber - b.objectNumber || a.generationNumber - b.generationNumber);
}

function nameOf(lib, ctx, value) {
  const v = value ? ctx.lookup(value) : null;
  return v instanceof lib.PDFName ? v.decodeText() : null;
}

/** "1.2 MB", for the dialog and the result. */
export function formatBytes(n) {
  if (!Number.isFinite(n)) return '';
  if (n < 1024) return `${n} bytes`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}
