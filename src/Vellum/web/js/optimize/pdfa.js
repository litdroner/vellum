// PDF/A V1: writes an archiving copy of a document as PDF/A-2b — one profile, the only one Vellum can
// both produce and check, named as such everywhere rather than "PDF/A".
//
// Why PDF/A-2b, and only it:
//
//   part 2   allows transparency, JPEG 2000 images, object streams and cross-reference streams, so
//            ordinary documents are converted rather than refused; part 1 would refuse most of them
//   level B  "basic": the file shows the same thing forever. Level U would need every font to map to
//            Unicode and level A would need a tagged structure Vellum doesn't build, so claiming
//            either would be claiming something Vellum hasn't checked
//
// What conversion is, here: Vellum adds what the profile requires and Vellum can add correctly, and
// refuses outright when a document would need its content changed to conform. It never rewrites a page,
// never substitutes or embeds a font into text the document already draws, and never drops a page,
// annotation or form field to make a file pass — the same inventory check compression uses
// (optimize/inventory.js) compares the copy with the source before anything is written.
//
//   added      an output intent with an embedded sRGB ICC profile Vellum builds itself
//              (optimize/srgb-icc.js), XMP metadata claiming PDF/A-2b and agreeing entry for entry
//              with the document information, and a file identifier
//   changed    LZW-compressed streams re-stored as Flate (the profile doesn't allow LZW; the decoded
//              bytes are identical), /Interpolate removed from images, document-level JavaScript and
//              additional actions removed, prohibited annotation actions (Launch, Sound, Movie,
//              ResetForm, ImportData, JavaScript) removed, the Print flag set on annotations, and
//              objects nothing can reach dropped
//   refused    a protected or signed document, a font used but not embedded, an XFA form, embedded
//              files, PostScript or reference XObjects, an annotation with no appearance or hidden
//              from view, an output intent Vellum can't read, and optional content the profile forbids
//
// The copy is then checked against PDF/A-2b by optimize/pdfa-validate.js, on the written bytes, before
// they are handed back: a file that fails is not written and Vellum says which check failed. That is
// what keeps "PDF/A-2b" from being a label. The checks it makes are listed in the result and in
// pdfa-validate.js — they are what Vellum verifies, not the whole of ISO 19005-2.

import { openSource } from '../editing/source.js';
import { removeUnreachable } from '../annotations/persist.js';
import { compareInventory, hashBytes, inventory } from './inventory.js';
import { filterNames, reflate } from './compress.js';
import { ICC_COMPONENTS, readIccHeader, srgbIccProfile } from './srgb-icc.js';
import { CHECK_LABELS, validatePdfa } from './pdfa-validate.js';

/** The one PDF/A profile Vellum converts to and checks. */
export const PDFA_PROFILE = Object.freeze({ id: 'pdfa-2b', part: 2, conformance: 'B', label: 'PDF/A-2b' });

export class PdfaError extends Error {
  constructor(message, details = []) {
    super(message);
    this.name = 'PdfaError';
    this.details = details;
  }
}

/** Annotation actions PDF/A doesn't allow; /GoTo, /GoToR and /URI are kept. */
const FORBIDDEN_ACTIONS = new Set(['Launch', 'Sound', 'Movie', 'ResetForm', 'ImportData', 'JavaScript']);
/** Annotations that need no appearance stream of their own. */
const APPEARANCE_EXEMPT = new Set(['Link', 'Popup', 'Projection']);
/** Annotation flags: 1 Invisible, 2 Hidden, 4 Print, 32 NoView. */
const FLAG = { invisible: 1, hidden: 2, print: 4, noView: 32 };
/** The ICC device classes a PDF/A output intent's destination profile may have. */
const OUTPUT_CLASSES = new Set(['prtr', 'mntr']);

const OUTPUT_CONDITION = 'sRGB IEC61966-2.1';

/**
 * Converts PDF bytes to PDF/A-2b. Resolves a report; throws PdfaError when the document can't be
 * converted, when the copy fails the PDF/A check, or when it isn't the same document any more.
 *
 *   lib          pdf-lib (annotations/persist.js loadPdfLib)
 *   bytes        the document, untouched (a page selection is applied before this by the caller)
 *   onProgress   ({ step, label, index, total })
 *   signal       an AbortSignal; a stopped run writes nothing
 *
 * report { profile, bytes, pageCount, before, after, steps, checks }
 */
export async function convertToPdfa({ lib, bytes, onProgress = null, signal = null } = {}) {
  const total = 5;
  let at = 0;
  const step = (id, label) => {
    if (signal?.aborted) throw new PdfaError('Stopped.');
    onProgress?.({ step: id, label, index: at++, total });
  };

  step('read', 'Reading the document…');
  const before = await inventory(lib, bytes).catch((err) => { throw new PdfaError(readingFailed(err)); });
  const doc = await load(lib, bytes);
  const ctx = doc.context;
  const source = await openSource(lib, bytes).catch((err) => { throw new PdfaError(readingFailed(err)); });

  step('check', 'Checking what the profile allows…');
  const refusals = findBlockers(lib, doc, source);
  if (refusals.length) {
    throw new PdfaError(`This PDF can’t be converted to ${PDFA_PROFILE.label} without changing what it shows, so Vellum didn’t write anything.`, refusals);
  }

  step('fix', 'Removing what the profile doesn’t allow…');
  const lzw = transcodeLzw(lib, ctx);
  const interpolate = removeInterpolate(lib, ctx);
  const scripts = removeScriptsAndActions(lib, doc);
  const flags = setPrintFlags(lib, doc);
  const unused = removeUnreachable(ctx, lib, []);

  step('mark', `Writing the ${PDFA_PROFILE.label} metadata and output intent…`);
  const intent = writeOutputIntent(lib, doc);
  writeXmp(lib, doc);
  writeFileId(lib, ctx, bytes);
  ctx.header = lib.PDFHeader.forVersion(1, 7);
  doc.catalog.delete(lib.PDFName.of('Version'));

  step('write', 'Writing the copy…');
  const out = await doc.save({ useObjectStreams: true, updateFieldAppearances: false, addDefaultPage: false });
  if (signal?.aborted) throw new PdfaError('Stopped.');

  const report = await validatePdfa(lib, out).catch((err) => { throw new PdfaError(`The copy couldn’t be reopened, so Vellum didn’t write it (${err?.message ?? err}).`); });
  if (!report.ok) {
    throw new PdfaError(`The copy didn’t pass Vellum’s own ${PDFA_PROFILE.label} check, so it wasn’t written.`, report.failures);
  }
  const differences = compareInventory(before, await inventory(lib, out));
  if (differences.length) {
    throw new PdfaError('The converted copy isn’t the same document, so Vellum didn’t write it.', differences);
  }

  onProgress?.({ step: 'done', label: 'Done', index: total, total });
  return Object.freeze({
    profile: PDFA_PROFILE,
    bytes: out,
    pageCount: before.pageCount,
    before: bytes.length,
    after: out.length,
    steps: Object.freeze([
      frozenStep('intent', intent.kept ? 'The document’s own output intent kept' : 'sRGB output intent embedded', null, intent.kept ? null : `${intent.profileBytes} bytes of ICC profile`),
      frozenStep('metadata', `XMP metadata claiming ${PDFA_PROFILE.label}, and a file identifier`, null),
      frozenStep('lzw', 'LZW streams re-stored as Flate', lzw),
      frozenStep('interpolate', 'Image smoothing (/Interpolate) removed', interpolate),
      frozenStep('scripts', 'JavaScript and actions the profile forbids removed', scripts),
      frozenStep('flags', 'Annotations marked to print', flags),
      frozenStep('unused', 'Unused objects removed', unused),
    ]),
    checks: Object.freeze(report.checks),
  });
}

/** The checks the result says it made, for a caller that wants them before running anything. */
export const PDFA_CHECKS = CHECK_LABELS;

const frozenStep = (id, label, count, note = null) => Object.freeze({ id, label, count, note });

async function load(lib, bytes) {
  try {
    return await lib.PDFDocument.load(bytes, { updateMetadata: false });
  } catch (err) {
    throw new PdfaError(readingFailed(err));
  }
}

const readingFailed = (err) => (/encrypt/i.test(String(err?.message ?? err))
  ? `This PDF is protected (encrypted). ${PDFA_PROFILE.label} doesn’t allow encryption and Vellum can’t rewrite a protected file, so it can’t be converted.`
  : `This PDF couldn’t be read for converting (${err?.message ?? err}).`);

// ---- what cannot be converted -------------------------------------------------------------------

/**
 * Everything about this document that PDF/A-2b forbids and Vellum will not change on its own, each in
 * one sentence. Empty when the document can be converted. Nothing here is a guess: each is read from
 * the file, or from the engine's own reading of it (editing/source.js).
 */
export function findBlockers(lib, doc, source) {
  const { PDFName, PDFDict, PDFArray, PDFStream, PDFBool, PDFNumber } = lib;
  const ctx = doc.context;
  const out = [];
  const look = (v) => (v ? ctx.lookup(v) : undefined);
  const nameOf = (v) => { const x = look(v); return x instanceof PDFName ? x.decodeText() : null; };

  const profile = readProfileFor(lib, doc);
  if (profile.signed) {
    out.push(`This PDF is digitally signed${profile.certified ? ' and certified' : ''}. Converting it writes a new file, which the signature would no longer cover, so Vellum doesn’t convert a signed document.`);
  }

  // Fonts: the profile needs every font the pages use to be embedded, and Vellum never substitutes one.
  const missing = new Set();
  for (const font of source.scanFonts().values()) {
    if (font && !font.embedded) missing.add(font.name || font.baseFont || 'an unnamed font');
  }
  if (missing.size) {
    out.push(`${[...missing].sort().join(', ')} ${missing.size === 1 ? 'is used but not embedded' : 'are used but not embedded'} in this PDF. ${PDFA_PROFILE.label} needs every font embedded, and Vellum won’t put a different font in place of one the document draws.`);
  }

  const form = look(doc.catalog.get(PDFName.of('AcroForm')));
  if (form instanceof PDFDict && form.has(PDFName.of('XFA'))) {
    out.push(`This PDF contains an XFA form, which ${PDFA_PROFILE.label} doesn’t allow. Vellum doesn’t read XFA and won’t remove a form it can’t read.`);
  }

  const names = look(doc.catalog.get(PDFName.of('Names')));
  if (names instanceof PDFDict && names.has(PDFName.of('EmbeddedFiles'))) {
    out.push(`This PDF has files attached to it. ${PDFA_PROFILE.label} allows only attachments that are themselves PDF/A, which Vellum can’t check, and it won’t quietly throw attachments away.`);
  }

  // Optional content (layers): the profile needs every group named, and no automatic-state list.
  const oc = look(doc.catalog.get(PDFName.of('OCProperties')));
  if (oc instanceof PDFDict) {
    const groups = look(oc.get(PDFName.of('OCGs')));
    const unnamed = groups instanceof PDFArray
      ? groups.asArray().filter((g) => { const d = look(g); return !(d instanceof PDFDict) || !d.has(PDFName.of('Name')); }).length
      : 0;
    if (unnamed) out.push(`${unnamed} of this PDF’s layers ${unnamed === 1 ? 'has' : 'have'} no name, which ${PDFA_PROFILE.label} requires.`);
    const d = look(oc.get(PDFName.of('D')));
    if (d instanceof PDFDict && d.has(PDFName.of('AS'))) {
      out.push(`This PDF’s layers change by themselves depending on how the page is used (an /AS list), which ${PDFA_PROFILE.label} doesn’t allow.`);
    }
  }

  // An output intent already in the file: kept when Vellum can read it, never replaced silently.
  const intents = look(doc.catalog.get(PDFName.of('OutputIntents')));
  if (intents instanceof PDFArray && intents.size()) {
    const usable = intents.asArray().every((entry) => Boolean(readIntentProfile(lib, ctx, entry)));
    if (!usable) {
      out.push('This PDF already declares an output intent whose colour profile Vellum can’t read. Replacing it would change how its colours are meant to be read, so Vellum doesn’t convert it.');
    }
  }

  // Streams and annotations, object by object.
  let ps = 0;
  let reference = 0;
  let alternates = 0;
  let crypt = 0;
  for (const [, obj] of ctx.enumerateIndirectObjects()) {
    if (obj instanceof PDFStream) {
      const subtype = nameOf(obj.dict.get(PDFName.of('Subtype')));
      if (subtype === 'PS') ps++;
      if (subtype === 'Form' && obj.dict.has(PDFName.of('Ref'))) reference++;
      if (subtype === 'Image' && obj.dict.has(PDFName.of('Alternates'))) alternates++;
      if (filterNames(lib, ctx, obj.dict).includes('Crypt')) crypt++;
    }
  }
  if (ps) out.push(`This PDF embeds PostScript (${ps} ${ps === 1 ? 'object' : 'objects'}), which ${PDFA_PROFILE.label} doesn’t allow.`);
  if (reference) out.push(`This PDF draws content from other files (${reference} reference XObject${reference === 1 ? '' : 's'}), which ${PDFA_PROFILE.label} doesn’t allow.`);
  if (alternates) out.push(`${alternates} image${alternates === 1 ? '' : 's'} in this PDF ${alternates === 1 ? 'carries an alternate version' : 'carry alternate versions'}, which ${PDFA_PROFILE.label} doesn’t allow.`);
  if (crypt) out.push(`${crypt} stream${crypt === 1 ? '' : 's'} in this PDF ${crypt === 1 ? 'uses' : 'use'} a /Crypt filter, which ${PDFA_PROFILE.label} doesn’t allow.`);

  let noAppearance = 0;
  let hidden = 0;
  let widgetsWithoutAppearance = 0;
  for (const page of doc.getPages()) {
    const annots = look(page.node.get(PDFName.of('Annots')));
    if (!(annots instanceof PDFArray)) continue;
    for (const entry of annots.asArray()) {
      const annot = look(entry);
      if (!(annot instanceof PDFDict)) continue;
      const subtype = nameOf(annot.get(PDFName.of('Subtype')));
      const appearance = look(annot.get(PDFName.of('AP')));
      const hasNormal = appearance instanceof PDFDict && appearance.has(PDFName.of('N'));
      if (!APPEARANCE_EXEMPT.has(subtype ?? '') && !hasNormal) noAppearance++;
      if (subtype === 'Widget' && !hasNormal) widgetsWithoutAppearance++;
      const f = look(annot.get(PDFName.of('F')));
      const bits = f instanceof PDFNumber ? f.asNumber() : 0;
      if (bits & (FLAG.hidden | FLAG.noView)) hidden++;
    }
  }
  if (noAppearance) {
    out.push(`${noAppearance} annotation${noAppearance === 1 ? '' : 's'} in this PDF ${noAppearance === 1 ? 'has' : 'have'} no appearance of ${noAppearance === 1 ? 'its' : 'their'} own. ${PDFA_PROFILE.label} needs one, and Vellum won’t invent how an annotation should look.`);
  }
  if (hidden) {
    out.push(`${hidden} annotation${hidden === 1 ? '' : 's'} in this PDF ${hidden === 1 ? 'is' : 'are'} hidden from view. ${PDFA_PROFILE.label} doesn’t allow that, and showing ${hidden === 1 ? 'it' : 'them'} would change what the document shows.`);
  }
  const needs = form instanceof PDFDict ? look(form.get(PDFName.of('NeedAppearances'))) : null;
  if (needs instanceof PDFBool && needs.asBoolean() && widgetsWithoutAppearance) {
    out.push(`This PDF asks the reader to draw its form fields itself (NeedAppearances), which ${PDFA_PROFILE.label} doesn’t allow, and ${widgetsWithoutAppearance} field${widgetsWithoutAppearance === 1 ? ' has' : 's have'} no appearance to fall back on.`);
  }
  return out;
}

/** The document profile's signature test (editing/source.js readProfile), on a loaded document. */
function readProfileFor(lib, doc) {
  const { PDFName, PDFDict, PDFNumber, PDFArray, PDFString, PDFHexString } = lib;
  const ctx = doc.context;
  const form = ctx.lookup(doc.catalog.get(PDFName.of('AcroForm')));
  const flags = form instanceof PDFDict ? ctx.lookup(form.get(PDFName.of('SigFlags'))) : null;
  let signed = flags instanceof PDFNumber && (flags.asNumber() & 1) === 1;
  if (!signed) {
    for (const [, obj] of ctx.enumerateIndirectObjects()) {
      if (!(obj instanceof PDFDict)) continue;
      const range = obj.get(PDFName.of('ByteRange'));
      const contents = obj.get(PDFName.of('Contents'));
      if (range instanceof PDFArray && (contents instanceof PDFHexString || contents instanceof PDFString)) { signed = true; break; }
    }
  }
  const perms = ctx.lookup(doc.catalog.get(PDFName.of('Perms')));
  return { signed, certified: perms instanceof PDFDict && perms.has(PDFName.of('DocMDP')) };
}

// ---- what is changed ----------------------------------------------------------------------------

/** LZW-compressed streams re-stored as Flate. The decoded bytes are unchanged. */
function transcodeLzw(lib, ctx) {
  let count = 0;
  for (const [ref, obj] of [...ctx.enumerateIndirectObjects()]) {
    if (!(obj instanceof lib.PDFStream)) continue;
    if (!filterNames(lib, ctx, obj.dict).includes('LZWDecode')) continue;
    if (reflate(lib, ctx, ref, obj)) count++;
  }
  return count;
}

/** /Interpolate removed from image XObjects (its default, false, is what the profile allows). */
function removeInterpolate(lib, ctx) {
  const { PDFName, PDFStream, PDFBool } = lib;
  let count = 0;
  for (const [, obj] of ctx.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFStream)) continue;
    const value = ctx.lookup(obj.dict.get(PDFName.of('Interpolate')));
    if (!(value instanceof PDFBool) || !value.asBoolean()) continue;
    obj.dict.delete(PDFName.of('Interpolate'));
    count++;
  }
  return count;
}

/** Document JavaScript, additional actions, and annotation actions the profile forbids. */
function removeScriptsAndActions(lib, doc) {
  const { PDFName, PDFDict, PDFArray } = lib;
  const ctx = doc.context;
  const look = (v) => (v ? ctx.lookup(v) : undefined);
  const nameOf = (v) => { const x = look(v); return x instanceof PDFName ? x.decodeText() : null; };
  let count = 0;

  const names = look(doc.catalog.get(PDFName.of('Names')));
  if (names instanceof PDFDict && names.has(PDFName.of('JavaScript'))) { names.delete(PDFName.of('JavaScript')); count++; }
  const open = look(doc.catalog.get(PDFName.of('OpenAction')));
  if (open instanceof PDFDict && FORBIDDEN_ACTIONS.has(nameOf(open.get(PDFName.of('S'))) ?? '')) {
    doc.catalog.delete(PDFName.of('OpenAction'));
    count++;
  }
  if (doc.catalog.has(PDFName.of('AA'))) { doc.catalog.delete(PDFName.of('AA')); count++; }

  const form = look(doc.catalog.get(PDFName.of('AcroForm')));
  if (form instanceof PDFDict && form.has(PDFName.of('NeedAppearances'))) { form.delete(PDFName.of('NeedAppearances')); count++; }

  for (const page of doc.getPages()) {
    if (page.node.has(PDFName.of('AA'))) { page.node.delete(PDFName.of('AA')); count++; }
    const annots = look(page.node.get(PDFName.of('Annots')));
    if (!(annots instanceof PDFArray)) continue;
    for (const entry of annots.asArray()) {
      const annot = look(entry);
      if (!(annot instanceof PDFDict)) continue;
      if (annot.has(PDFName.of('AA'))) { annot.delete(PDFName.of('AA')); count++; }
      const action = look(annot.get(PDFName.of('A')));
      if (action instanceof PDFDict && FORBIDDEN_ACTIONS.has(nameOf(action.get(PDFName.of('S'))) ?? '')) {
        annot.delete(PDFName.of('A'));
        count++;
      }
    }
  }
  return count;
}

/** Every annotation gets the Print flag the profile requires; nothing else about /F is touched. */
function setPrintFlags(lib, doc) {
  const { PDFName, PDFDict, PDFArray, PDFNumber } = lib;
  const ctx = doc.context;
  let count = 0;
  for (const page of doc.getPages()) {
    const annots = ctx.lookup(page.node.get(PDFName.of('Annots')));
    if (!(annots instanceof PDFArray)) continue;
    for (const entry of annots.asArray()) {
      const annot = ctx.lookup(entry);
      if (!(annot instanceof PDFDict)) continue;
      const f = ctx.lookup(annot.get(PDFName.of('F')));
      const bits = f instanceof PDFNumber ? f.asNumber() : 0;
      if (bits & FLAG.print) continue;
      annot.set(PDFName.of('F'), PDFNumber.of((bits | FLAG.print) & ~FLAG.invisible));
      count++;
    }
  }
  return count;
}

// ---- what is added ------------------------------------------------------------------------------

/**
 * The output intent: the document's own when Vellum can read it, else one naming the sRGB profile
 * Vellum builds (optimize/srgb-icc.js), embedded in the file as the profile requires.
 */
function writeOutputIntent(lib, doc) {
  const { PDFName, PDFArray, PDFString } = lib;
  const ctx = doc.context;
  const existing = ctx.lookup(doc.catalog.get(PDFName.of('OutputIntents')));
  if (existing instanceof PDFArray && existing.size() && existing.asArray().every((e) => readIntentProfile(lib, ctx, e))) {
    return { kept: true, profileBytes: 0 };
  }
  const icc = srgbIccProfile();
  const stream = ctx.flateStream(icc, { N: ICC_COMPONENTS['RGB '] });
  const intent = ctx.obj({
    Type: 'OutputIntent',
    S: 'GTS_PDFA1',
    OutputConditionIdentifier: PDFString.of(OUTPUT_CONDITION),
    Info: PDFString.of(OUTPUT_CONDITION),
    DestOutputProfile: ctx.register(stream),
  });
  doc.catalog.set(PDFName.of('OutputIntents'), ctx.obj([intent]));
  return { kept: false, profileBytes: icc.length };
}

/** An output intent's destination profile, read back, or null when it isn't one Vellum can read. */
export function readIntentProfile(lib, ctx, entry) {
  const { PDFName, PDFDict, PDFStream } = lib;
  const intent = ctx.lookup(entry);
  if (!(intent instanceof PDFDict)) return null;
  const stream = ctx.lookup(intent.get(PDFName.of('DestOutputProfile')));
  if (!(stream instanceof PDFStream)) return null;
  let bytes;
  try {
    bytes = stream instanceof lib.PDFRawStream ? lib.decodePDFRawStream(stream).decode() : stream.getUnencodedContents();
  } catch {
    return null;
  }
  const header = readIccHeader(bytes);
  if (!header || !OUTPUT_CLASSES.has(header.deviceClass) || header.size !== bytes.length) return null;
  return header;
}

/**
 * The XMP packet: the PDF/A-2b claim, and every document-information entry that has an XMP
 * equivalent, with the same value — the profile requires the two to agree, so the packet is written
 * from the document information itself and nothing is invented.
 */
function writeXmp(lib, doc) {
  const { PDFName, PDFDict, PDFRawStream } = lib;
  const ctx = doc.context;
  const info = ctx.lookup(ctx.trailerInfo.Info);
  const value = (key) => {
    const v = info instanceof PDFDict ? ctx.lookup(info.get(PDFName.of(key))) : null;
    return v && typeof v.decodeText === 'function' ? v.decodeText() : null;
  };
  const dateValue = (key) => {
    const raw = value(key);
    const iso = raw ? isoDate(raw) : null;
    // A date Vellum can't read can't be mirrored, so it doesn't stay in the document information either.
    if (raw && !iso && info instanceof PDFDict) info.delete(PDFName.of(key));
    return iso;
  };
  const created = dateValue('CreationDate');
  const modified = dateValue('ModDate');

  const fields = [
    altText('dc:title', value('Title')),
    seqText('dc:creator', value('Author')),
    altText('dc:description', value('Subject')),
    simple('pdf:Keywords', value('Keywords')),
    simple('pdf:Producer', value('Producer')),
    simple('xmp:CreatorTool', value('Creator')),
    simple('xmp:CreateDate', created),
    simple('xmp:ModifyDate', modified),
    `<pdfaid:part>${PDFA_PROFILE.part}</pdfaid:part>`,
    `<pdfaid:conformance>${PDFA_PROFILE.conformance}</pdfaid:conformance>`,
  ].filter(Boolean);

  const xml = `<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about=""
    xmlns:dc="http://purl.org/dc/elements/1.1/"
    xmlns:pdf="http://ns.adobe.com/pdf/1.3/"
    xmlns:xmp="http://ns.adobe.com/xap/1.0/"
    xmlns:pdfaid="http://www.aiim.org/pdfa/ns/id/">
${fields.map((f) => `   ${f}`).join('\n')}
  </rdf:Description>
 </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>`;

  // The profile needs the metadata readable without decoding it, so it is stored with no filter.
  const bytes = new TextEncoder().encode(xml);
  const stream = PDFRawStream.of(ctx.obj({ Type: 'Metadata', Subtype: 'XML', Length: bytes.length }), bytes);
  doc.catalog.set(PDFName.of('Metadata'), ctx.register(stream));
}

const escapeXml = (text) => String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const simple = (tag, value) => (value ? `<${tag}>${escapeXml(value)}</${tag}>` : null);
const altText = (tag, value) => (value ? `<${tag}><rdf:Alt><rdf:li xml:lang="x-default">${escapeXml(value)}</rdf:li></rdf:Alt></${tag}>` : null);
const seqText = (tag, value) => (value ? `<${tag}><rdf:Seq><rdf:li>${escapeXml(value)}</rdf:li></rdf:Seq></${tag}>` : null);

/** A PDF date string (D:YYYYMMDDHHmmSSOHH'mm') as XMP writes it, or null when it can't be read. */
export function isoDate(text) {
  const m = /^D?:?(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?(?:(Z)|([+-])(\d{2})'?(?:(\d{2})'?)?)?/.exec(String(text).trim());
  if (!m) return null;
  const [, year, month = '01', day = '01', hour, minute = '00', second = '00', utc, sign, offsetHour, offsetMinute = '00'] = m;
  if (hour === undefined) return `${year}-${month}-${day}`;
  const zone = utc ? 'Z' : sign ? `${sign}${offsetHour}:${offsetMinute}` : '';
  return `${year}-${month}-${day}T${hour}:${minute}:${second}${zone}`;
}

/** A file identifier, derived from the document itself so the same file always gets the same one. */
function writeFileId(lib, ctx, bytes) {
  const { PDFHexString, PDFArray } = lib;
  const seed = `${bytes.length}:${hashBytes(bytes)}:${hashBytes(bytes.subarray(0, Math.min(bytes.length, 65536)))}`;
  let digest = '';
  for (let i = 0; i < 4; i++) digest += hashBytes(new TextEncoder().encode(`${seed}:${i}`));
  const id = PDFHexString.of(digest.toUpperCase());
  const array = PDFArray.withContext(ctx);
  array.push(id);
  array.push(id);
  ctx.trailerInfo.ID = array;
}
