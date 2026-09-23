// The PDF/A-2b check Vellum makes on a file it has written, before that file is handed back
// (optimize/pdfa.js). It reads the written bytes back with pdf-lib and the engine's own reader, and
// every check either passes or names what failed; a file that fails is not written.
//
// What this is, exactly: the set of PDF/A-2b requirements Vellum can decide from the file itself with
// what it already has. It is not the whole of ISO 19005-2 and doesn't claim to be — a validator like
// veraPDF checks things Vellum has no way to check here (that an embedded font program really contains
// every glyph the text asks for, that a colour space is used consistently through every nested form,
// that the XMP extension schemas are well formed). The checks are listed by name in CHECK_LABELS and
// shown in the result, so what was and wasn't verified is on the record rather than implied.
//
// It is also the check the conversion is tested against: a file that only claims PDF/A — the right XMP
// and nothing else — fails here.
//
//   validatePdfa(lib, bytes) -> { ok, failures, checks, claim }

import { openSource, pdfaClaim } from '../editing/source.js';
import { filterNames } from './compress.js';
import { readIccHeader } from './srgb-icc.js';

/** The name of every check, in the order they run: what Vellum verifies about its own output. */
export const CHECK_LABELS = Object.freeze([
  'the PDF/A-2b claim in the XMP metadata',
  'the metadata is stored unfiltered',
  'an output intent with an embedded ICC output profile',
  'a file identifier in the trailer',
  'no encryption',
  'every font embedded',
  'no LZW or Crypt filters',
  'no XFA form, embedded files or reference XObjects',
  'no JavaScript or forbidden actions',
  'every annotation printable, visible and with an appearance',
  'the document information agrees with the metadata',
]);

const FORBIDDEN_ACTIONS = new Set(['Launch', 'Sound', 'Movie', 'ResetForm', 'ImportData', 'JavaScript']);
const APPEARANCE_EXEMPT = new Set(['Link', 'Popup', 'Projection']);
const OUTPUT_CLASSES = new Set(['prtr', 'mntr']);
const FLAG = { invisible: 1, hidden: 2, print: 4, noView: 32 };

/** The document-information entries the metadata must repeat, and the XMP property each becomes. */
const MIRRORED = Object.freeze({
  Title: 'dc:title', Author: 'dc:creator', Subject: 'dc:description',
  Keywords: 'pdf:Keywords', Producer: 'pdf:Producer', Creator: 'xmp:CreatorTool',
});

/**
 * Checks PDF bytes against the PDF/A-2b requirements Vellum verifies. Resolves
 * { ok, failures, checks, claim }; throws when the bytes aren't a PDF that reopens at all.
 */
export async function validatePdfa(lib, bytes) {
  const { PDFName, PDFDict, PDFArray, PDFStream, PDFNumber, PDFHexString, PDFString } = lib;
  const source = await openSource(lib, bytes);
  const doc = source.doc;
  const ctx = doc.context;
  const look = (v) => (v ? ctx.lookup(v) : undefined);
  const nameOf = (v) => { const x = look(v); return x instanceof PDFName ? x.decodeText() : null; };
  const failures = [];
  const fail = (message) => failures.push(message);

  // 1 / 2 — the claim, and the metadata stream it is in.
  const claim = pdfaClaim(lib, doc);
  if (!claim) fail('The copy carries no PDF/A claim in its XMP metadata.');
  else if (claim.part !== 2 || claim.conformance !== 'B') fail(`The copy claims PDF/A-${claim.part}${claim.conformance ?? ''}, not PDF/A-2B.`);
  const metadata = look(doc.catalog.get(PDFName.of('Metadata')));
  if (!(metadata instanceof PDFStream)) fail('The copy has no document metadata stream.');
  else if (filterNames(lib, ctx, metadata.dict).length) fail('The copy’s metadata is compressed; PDF/A needs it readable without decoding.');

  // 3 — the output intent and the profile embedded in it.
  const intents = look(doc.catalog.get(PDFName.of('OutputIntents')));
  const list = intents instanceof PDFArray ? intents.asArray() : [];
  if (!list.length) fail('The copy has no output intent, so its colours have nothing to be read against.');
  let pdfaIntents = 0;
  for (const entry of list) {
    const intent = look(entry);
    if (!(intent instanceof PDFDict)) { fail('An output intent in the copy isn’t a dictionary.'); continue; }
    if (nameOf(intent.get(PDFName.of('S'))) === 'GTS_PDFA1') pdfaIntents++;
    const stream = look(intent.get(PDFName.of('DestOutputProfile')));
    if (!(stream instanceof PDFStream)) { fail('An output intent in the copy has no embedded colour profile.'); continue; }
    let profile;
    try {
      profile = stream instanceof lib.PDFRawStream ? lib.decodePDFRawStream(stream).decode() : stream.getUnencodedContents();
    } catch {
      fail('An output intent’s colour profile in the copy can’t be read.');
      continue;
    }
    const header = readIccHeader(profile);
    if (!header) fail('An output intent’s colour profile in the copy isn’t an ICC profile.');
    else if (header.size !== profile.length) fail(`An output intent’s colour profile says it is ${header.size} bytes but is ${profile.length}.`);
    else if (!OUTPUT_CLASSES.has(header.deviceClass)) fail(`An output intent’s colour profile is a “${header.deviceClass}” profile, which can’t be an output profile.`);
    const n = look(stream.dict.get(PDFName.of('N')));
    const expected = header ? { 'GRAY': 1, 'RGB ': 3, 'CMYK': 4 }[header.colorSpace] : null;
    if (expected && (!(n instanceof PDFNumber) || n.asNumber() !== expected)) {
      fail(`An output intent’s colour profile has ${expected} components but the file says ${n instanceof PDFNumber ? n.asNumber() : 'nothing'}.`);
    }
  }
  if (list.length && !pdfaIntents) fail('None of the copy’s output intents is a PDF/A output intent (/S /GTS_PDFA1).');

  // 4 / 5 — the file identifier, and that nothing is encrypted.
  const id = ctx.trailerInfo.ID;
  const ids = id instanceof PDFArray ? id.asArray() : [];
  if (ids.length !== 2 || !ids.every((v) => v instanceof PDFHexString || v instanceof PDFString)) {
    fail('The copy has no file identifier in its trailer.');
  }
  if (ctx.trailerInfo.Encrypt) fail('The copy is encrypted, which PDF/A doesn’t allow.');

  // 6 — every font the pages use is embedded.
  const missing = new Set();
  for (const font of source.scanFonts().values()) if (font && !font.embedded) missing.add(font.name || 'an unnamed font');
  if (missing.size) fail(`${[...missing].sort().join(', ')} ${missing.size === 1 ? 'is' : 'are'} used but not embedded in the copy.`);

  // 7 / 8 — filters and features the profile forbids, object by object.
  let lzw = 0;
  let crypt = 0;
  let ps = 0;
  let reference = 0;
  let interpolate = 0;
  for (const [, obj] of ctx.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFStream)) continue;
    const filters = filterNames(lib, ctx, obj.dict);
    if (filters.includes('LZWDecode')) lzw++;
    if (filters.includes('Crypt')) crypt++;
    const subtype = nameOf(obj.dict.get(PDFName.of('Subtype')));
    if (subtype === 'PS') ps++;
    if (subtype === 'Form' && obj.dict.has(PDFName.of('Ref'))) reference++;
    const smoothing = look(obj.dict.get(PDFName.of('Interpolate')));
    if (smoothing instanceof lib.PDFBool && smoothing.asBoolean()) interpolate++;
  }
  if (lzw) fail(`${lzw} stream${lzw === 1 ? '' : 's'} in the copy still ${lzw === 1 ? 'uses' : 'use'} LZW, which PDF/A doesn’t allow.`);
  if (crypt) fail(`${crypt} stream${crypt === 1 ? '' : 's'} in the copy ${crypt === 1 ? 'uses' : 'use'} a /Crypt filter.`);
  if (ps) fail(`The copy still embeds PostScript (${ps}).`);
  if (reference) fail(`The copy still draws content from other files (${reference} reference XObject${reference === 1 ? '' : 's'}).`);
  if (interpolate) fail(`${interpolate} image${interpolate === 1 ? '' : 's'} in the copy still ${interpolate === 1 ? 'asks' : 'ask'} to be smoothed (/Interpolate).`);

  const form = look(doc.catalog.get(PDFName.of('AcroForm')));
  if (form instanceof PDFDict && form.has(PDFName.of('XFA'))) fail('The copy still contains an XFA form.');
  if (form instanceof PDFDict && form.has(PDFName.of('NeedAppearances'))) fail('The copy still asks the reader to draw its form fields (NeedAppearances).');
  const names = look(doc.catalog.get(PDFName.of('Names')));
  if (names instanceof PDFDict && names.has(PDFName.of('EmbeddedFiles'))) fail('The copy still has files attached to it.');
  if (names instanceof PDFDict && names.has(PDFName.of('JavaScript'))) fail('The copy still contains document-level JavaScript.');
  if (doc.catalog.has(PDFName.of('AA'))) fail('The copy still has document additional actions.');

  // 9 / 10 — actions and annotations, page by page.
  let badActions = 0;
  let noAppearance = 0;
  let notPrinted = 0;
  let hidden = 0;
  for (const page of doc.getPages()) {
    if (page.node.has(PDFName.of('AA'))) badActions++;
    const annots = look(page.node.get(PDFName.of('Annots')));
    if (!(annots instanceof PDFArray)) continue;
    for (const entry of annots.asArray()) {
      const annot = look(entry);
      if (!(annot instanceof PDFDict)) continue;
      const subtype = nameOf(annot.get(PDFName.of('Subtype')));
      const appearance = look(annot.get(PDFName.of('AP')));
      if (!APPEARANCE_EXEMPT.has(subtype ?? '') && !(appearance instanceof PDFDict && appearance.has(PDFName.of('N')))) noAppearance++;
      const action = look(annot.get(PDFName.of('A')));
      if (action instanceof PDFDict && FORBIDDEN_ACTIONS.has(nameOf(action.get(PDFName.of('S'))) ?? '')) badActions++;
      if (annot.has(PDFName.of('AA'))) badActions++;
      const f = look(annot.get(PDFName.of('F')));
      const bits = f instanceof PDFNumber ? f.asNumber() : 0;
      if (!(bits & FLAG.print)) notPrinted++;
      if (bits & (FLAG.hidden | FLAG.noView)) hidden++;
    }
  }
  if (badActions) fail(`${badActions} action${badActions === 1 ? '' : 's'} PDF/A doesn’t allow ${badActions === 1 ? 'is' : 'are'} still in the copy.`);
  if (noAppearance) fail(`${noAppearance} annotation${noAppearance === 1 ? '' : 's'} in the copy ${noAppearance === 1 ? 'has' : 'have'} no appearance.`);
  if (notPrinted) fail(`${notPrinted} annotation${notPrinted === 1 ? '' : 's'} in the copy ${notPrinted === 1 ? 'is' : 'are'} not marked to print.`);
  if (hidden) fail(`${hidden} annotation${hidden === 1 ? '' : 's'} in the copy ${hidden === 1 ? 'is' : 'are'} hidden from view.`);

  // 11 — the document information and the metadata say the same thing.
  const xml = metadataText(lib, doc);
  const info = look(ctx.trailerInfo.Info);
  if (info instanceof PDFDict && xml) {
    for (const [key, property] of Object.entries(MIRRORED)) {
      const value = look(info.get(PDFName.of(key)));
      const text = value && typeof value.decodeText === 'function' ? value.decodeText() : null;
      if (text && !xml.includes(escapeXml(text))) fail(`The copy’s metadata doesn’t repeat the document’s ${key} as ${property}.`);
    }
    for (const key of ['CreationDate', 'ModDate']) {
      const value = look(info.get(PDFName.of(key)));
      const text = value && typeof value.decodeText === 'function' ? value.decodeText() : null;
      const year = text ? /^D?:?(\d{4})/.exec(text.trim())?.[1] : null;
      if (year && !new RegExp(`>${year}-`).test(xml)) fail(`The copy’s metadata doesn’t repeat the document’s ${key}.`);
    }
  }

  return Object.freeze({
    ok: failures.length === 0,
    failures: Object.freeze(failures),
    checks: CHECK_LABELS,
    claim,
  });
}

const escapeXml = (text) => String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** The document's XMP packet as text, or null. */
function metadataText(lib, doc) {
  const { PDFName, PDFStream, PDFRawStream } = lib;
  const stream = doc.context.lookup(doc.catalog.get(PDFName.of('Metadata')));
  if (!(stream instanceof PDFStream)) return null;
  try {
    const bytes = stream instanceof PDFRawStream ? lib.decodePDFRawStream(stream).decode() : stream.getUnencodedContents();
    return new TextDecoder().decode(bytes);
  } catch {
    return null;
  }
}
