// PDF/A V1 (optimize/pdfa.js, optimize/pdfa-validate.js, optimize/srgb-icc.js): the copy is PDF/A-2b
// by Vellum's own check on the written bytes, it is still the same document, and a document that would
// have to be changed to conform is refused with the reason instead.
// Run: node --test "tests/editing/pdfa.test.mjs"

import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { loadPdfLib, openWithPdfjs, webModule } from './harness.mjs';
import { makeFixtures, FIXTURE_DIR } from './fixtures.mjs';

const { PDFA_PROFILE, PdfaError, convertToPdfa, findBlockers, isoDate } = await webModule('optimize/pdfa.js');
const { validatePdfa, CHECK_LABELS } = await webModule('optimize/pdfa-validate.js');
const { readIccHeader, srgbIccProfile } = await webModule('optimize/srgb-icc.js');
const { compareInventory, inventory } = await webModule('optimize/inventory.js');

let files;
let lib;
const read = (name) => new Uint8Array(fs.readFileSync(files[name]));
before(async () => {
  files = await makeFixtures(FIXTURE_DIR);
  lib = await loadPdfLib();
});

// 'families' embeds real font programs, which is what PDF/A needs; the standard-font fixtures can't
// conform at all and are the refusal cases below.
const REPRESENTATIVE = 'families';

test('the profile Vellum supports is named, and it is one profile', () => {
  assert.deepEqual({ ...PDFA_PROFILE }, { id: 'pdfa-2b', part: 2, conformance: 'B', label: 'PDF/A-2b' });
});

test('a representative document converts, and the copy passes Vellum’s own PDF/A-2b check', async () => {
  const bytes = read(REPRESENTATIVE);
  const report = await convertToPdfa({ lib, bytes });
  assert.equal(report.profile.label, 'PDF/A-2b');
  assert.deepEqual([...report.checks], [...CHECK_LABELS]);
  const check = await validatePdfa(lib, report.bytes);
  assert.deepEqual([...check.failures], []);
  assert.equal(check.ok, true);
  assert.deepEqual(check.claim, { part: 2, conformance: 'B' });
});

test('the source is not touched and the copy reopens with the same pages', async () => {
  const bytes = read(REPRESENTATIVE);
  const copy = bytes.slice();
  const report = await convertToPdfa({ lib, bytes });
  assert.deepEqual([...bytes], [...copy], 'converting must not write into the bytes it was given');
  const js = await openWithPdfjs(report.bytes);
  try {
    assert.equal(js.doc.numPages, report.pageCount);
    const text = await (await js.doc.getPage(1)).getTextContent();
    assert.ok(text.items.length > 0, 'the text is still there');
  } finally {
    await js.close();
  }
});

test('the document itself is preserved: pages, content, resources, annotations, fields', async () => {
  const bytes = read(REPRESENTATIVE);
  const before = await inventory(lib, bytes);
  const report = await convertToPdfa({ lib, bytes });
  const after = await inventory(lib, report.bytes);
  assert.deepEqual(after.pages.map((p) => p.contentHash), before.pages.map((p) => p.contentHash));
  assert.deepEqual(compareInventory(before, after), []);
});

test('the copy carries an sRGB output intent with a real ICC profile embedded in it', async () => {
  const report = await convertToPdfa({ lib, bytes: read(REPRESENTATIVE) });
  const doc = await lib.PDFDocument.load(report.bytes, { updateMetadata: false });
  const ctx = doc.context;
  const intents = ctx.lookup(doc.catalog.get(lib.PDFName.of('OutputIntents')));
  assert.equal(intents.size(), 1);
  const intent = ctx.lookup(intents.get(0));
  assert.equal(ctx.lookup(intent.get(lib.PDFName.of('S'))).decodeText(), 'GTS_PDFA1');
  const stream = ctx.lookup(intent.get(lib.PDFName.of('DestOutputProfile')));
  const profile = lib.decodePDFRawStream(stream).decode();
  const header = readIccHeader(profile);
  assert.equal(header.size, profile.length);
  assert.equal(header.deviceClass, 'mntr');
  assert.equal(header.colorSpace, 'RGB ');
  assert.equal(ctx.lookup(stream.dict.get(lib.PDFName.of('N'))).asNumber(), 3);
});

test('the ICC profile Vellum builds is a profile, and the same bytes every time', () => {
  const a = srgbIccProfile();
  const b = srgbIccProfile();
  assert.deepEqual([...a], [...b]);
  const header = readIccHeader(a);
  assert.equal(header.size, a.length);
  assert.equal(header.version, 0x02100000);
  assert.equal(header.connectionSpace, 'XYZ ');
  assert.ok(header.tagCount >= 9, `${header.tagCount} tags`);
  assert.equal(readIccHeader(new Uint8Array(200)), null, 'bytes that are not a profile are not one');
});

test('converting twice gives the same bytes', async () => {
  const bytes = read(REPRESENTATIVE);
  const a = await convertToPdfa({ lib, bytes });
  const b = await convertToPdfa({ lib, bytes });
  assert.deepEqual([...a.bytes], [...b.bytes]);
});

test('the metadata repeats the document information, entry for entry', async () => {
  const bytes = read(REPRESENTATIVE);
  const doc = await lib.PDFDocument.load(bytes, { updateMetadata: false });
  doc.setTitle('A report & its <tags>');
  doc.setAuthor('Ada Lovelace');
  doc.setProducer('Something Else 1.0');
  const report = await convertToPdfa({ lib, bytes: await doc.save({ useObjectStreams: false }) });
  const out = await lib.PDFDocument.load(report.bytes, { updateMetadata: false });
  const meta = out.context.lookup(out.catalog.get(lib.PDFName.of('Metadata')));
  const xml = new TextDecoder().decode(lib.decodePDFRawStream(meta).decode());
  assert.match(xml, /<pdfaid:part>2<\/pdfaid:part>/);
  assert.match(xml, /<pdfaid:conformance>B<\/pdfaid:conformance>/);
  assert.match(xml, /A report &amp; its &lt;tags&gt;/, 'the title, escaped');
  assert.match(xml, /Ada Lovelace/);
  assert.match(xml, /Something Else 1\.0/);
  // The metadata must stay readable without decoding it.
  assert.equal(meta.dict.has(lib.PDFName.of('Filter')), false);
  const check = await validatePdfa(lib, report.bytes);
  assert.deepEqual([...check.failures], []);
});

test('PDF dates become the same instant in the metadata', () => {
  assert.equal(isoDate("D:20260923114500+05'30'"), '2026-09-23T11:45:00+05:30');
  assert.equal(isoDate('D:20260101000000Z'), '2026-01-01T00:00:00Z');
  assert.equal(isoDate('D:20260101'), '2026-01-01');
  assert.equal(isoDate('nonsense'), null);
});

test('a protected PDF is refused, with the reason', async () => {
  await assert.rejects(() => convertToPdfa({ lib, bytes: read('encrypted-structure') }), (err) => {
    assert.ok(err instanceof PdfaError);
    assert.match(err.message, /protected/i);
    return true;
  });
});

test('a font that is used but not embedded is refused, and named', async () => {
  await assert.rejects(() => convertToPdfa({ lib, bytes: read('fonts') }), (err) => {
    assert.ok(err instanceof PdfaError);
    assert.ok(err.details.some((d) => /Helvetica/.test(d) && /not embedded/.test(d)), err.details.join(' | '));
    return true;
  });
});

test('a signed PDF is refused rather than quietly broken', async () => {
  await assert.rejects(() => convertToPdfa({ lib, bytes: read('signed') }), (err) => {
    assert.ok(err.details.some((d) => /signed/i.test(d)), err.details.join(' | '));
    return true;
  });
});

test('an XFA form, an attachment and a hidden annotation are each refused', async () => {
  const cases = [
    ['an XFA form', /XFA/, (doc, l) => {
      const xfa = doc.context.register(doc.context.flateStream('<xdp:xdp xmlns:xdp="http://ns.adobe.com/xdp/"></xdp:xdp>'));
      doc.catalog.set(l.PDFName.of('AcroForm'), doc.context.obj({ Fields: [], XFA: xfa }));
    }],
    ['an attachment', /attached/, (doc, l) => {
      const file = doc.context.register(doc.context.flateStream('data'));
      doc.catalog.set(l.PDFName.of('Names'), doc.context.obj({ EmbeddedFiles: { Names: [l.PDFString.of('notes.txt'), { Type: 'Filespec', F: l.PDFString.of('notes.txt'), EF: { F: file } }] } }));
    }],
    ['a hidden annotation', /hidden/, (doc, l) => {
      const page = doc.getPages()[0];
      const ap = doc.context.register(doc.context.flateStream('', { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 10, 10] }));
      page.node.set(l.PDFName.of('Annots'), doc.context.obj([{ Type: 'Annot', Subtype: 'Square', Rect: [0, 0, 10, 10], F: 2, AP: { N: ap } }]));
    }],
    ['a PostScript XObject', /PostScript/, (doc, l) => {
      doc.catalog.set(l.PDFName.of('VlPs'), doc.context.register(doc.context.flateStream('%!PS', { Type: 'XObject', Subtype: 'PS' })));
    }],
  ];
  for (const [what, pattern, damage] of cases) {
    const doc = await lib.PDFDocument.load(read(REPRESENTATIVE), { updateMetadata: false });
    damage(doc, lib);
    const bytes = await doc.save({ useObjectStreams: false });
    await assert.rejects(() => convertToPdfa({ lib, bytes }), (err) => {
      assert.ok(err instanceof PdfaError, what);
      assert.ok(err.details.some((d) => pattern.test(d)), `${what}: ${err.details.join(' | ')}`);
      return true;
    });
  }
});

test('LZW is re-stored as Flate, and the decoded bytes are unchanged', async () => {
  const doc = await lib.PDFDocument.load(read(REPRESENTATIVE), { updateMetadata: false });
  const ctx = doc.context;
  // An LZW stream pdf-lib can decode: encoded here with the only LZW code an encoder always may emit —
  // clear, then one literal code per byte, then end — so the decoded bytes are known exactly.
  const plain = new TextEncoder().encode('LZW content that PDF/A does not allow.');
  const lzwRef = ctx.register(lib.PDFRawStream.of(ctx.obj({ Filter: 'LZWDecode' }), lzwEncode(plain)));
  doc.catalog.set(lib.PDFName.of('VlLzw'), lzwRef);
  assert.deepEqual([...lib.decodePDFRawStream(ctx.lookup(lzwRef)).decode()], [...plain], 'the fixture itself decodes');

  const report = await convertToPdfa({ lib, bytes: await doc.save({ useObjectStreams: false }) });
  assert.equal(report.steps.find((s) => s.id === 'lzw').count, 1);
  const out = await lib.PDFDocument.load(report.bytes, { updateMetadata: false });
  const stream = out.context.lookup(out.catalog.get(lib.PDFName.of('VlLzw')));
  assert.equal(out.context.lookup(stream.dict.get(lib.PDFName.of('Filter'))).decodeText(), 'FlateDecode');
  assert.deepEqual([...lib.decodePDFRawStream(stream).decode()], [...plain]);
  const check = await validatePdfa(lib, report.bytes);
  assert.deepEqual([...check.failures], []);
});

test('image smoothing and forbidden actions are removed, and annotations are marked to print', async () => {
  const doc = await lib.PDFDocument.load(read(REPRESENTATIVE), { updateMetadata: false });
  const ctx = doc.context;
  const page = doc.getPages()[0];
  const ap = ctx.register(ctx.flateStream('', { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 10, 10] }));
  page.node.set(lib.PDFName.of('Annots'), ctx.obj([
    { Type: 'Annot', Subtype: 'Link', Rect: [0, 0, 10, 10], A: { S: 'Launch', F: lib.PDFString.of('app.exe') } },
    { Type: 'Annot', Subtype: 'Square', Rect: [0, 0, 10, 10], AP: { N: ap } },
  ]));
  ctx.register(ctx.flateStream('', { Type: 'XObject', Subtype: 'Image', Width: 1, Height: 1, BitsPerComponent: 8, ColorSpace: 'DeviceGray', Interpolate: true }));
  doc.catalog.set(lib.PDFName.of('Names'), ctx.obj({ JavaScript: { Names: [] } }));
  const bytes = await doc.save({ useObjectStreams: false });

  const report = await convertToPdfa({ lib, bytes });
  assert.ok(report.steps.find((s) => s.id === 'scripts').count >= 2, 'the Launch action and the JavaScript name tree');
  assert.equal(report.steps.find((s) => s.id === 'flags').count, 2, 'both annotations are marked to print');
  const check = await validatePdfa(lib, report.bytes);
  assert.deepEqual([...check.failures], []);
});

test('the check catches a file that only claims PDF/A', async () => {
  // The fixture's own XMP says PDF/A; nothing else about it conforms.
  const report = await validatePdfa(lib, read('pdfa'));
  assert.equal(report.ok, false);
  assert.ok(report.failures.some((f) => /no output intent/.test(f)), report.failures.join(' | '));
  assert.ok(report.failures.some((f) => /no file identifier/.test(f)), report.failures.join(' | '));
  // The claim itself is there and reads correctly — which is exactly why the claim alone proves nothing.
  assert.deepEqual(report.claim, { part: 2, conformance: 'B' });
});

test('the check catches a converted file that has been tampered with afterwards', async () => {
  const report = await convertToPdfa({ lib, bytes: read(REPRESENTATIVE) });
  const cases = [
    ['the output intent removed', /no output intent/, (doc, l) => doc.catalog.delete(l.PDFName.of('OutputIntents'))],
    ['the metadata removed', /no PDF\/A claim/, (doc, l) => doc.catalog.delete(l.PDFName.of('Metadata'))],
    ['the file identifier removed', /no file identifier/, (doc) => { doc.context.trailerInfo.ID = undefined; }],
    ['an unreadable colour profile', /isn’t an ICC profile/, (doc, l) => {
      const intents = doc.context.lookup(doc.catalog.get(l.PDFName.of('OutputIntents')));
      const intent = doc.context.lookup(intents.get(0));
      intent.set(l.PDFName.of('DestOutputProfile'), doc.context.register(doc.context.flateStream('not a profile at all, but long enough to be read as one................................................................................')));
    }],
  ];
  for (const [what, pattern, damage] of cases) {
    const doc = await lib.PDFDocument.load(report.bytes, { updateMetadata: false });
    damage(doc, lib);
    const check = await validatePdfa(lib, await doc.save({ useObjectStreams: false }));
    assert.equal(check.ok, false, what);
    assert.ok(check.failures.some((f) => pattern.test(f)), `${what}: ${check.failures.join(' | ')}`);
  }
});

test('a document that already carries a usable output intent keeps its own', async () => {
  const first = await convertToPdfa({ lib, bytes: read(REPRESENTATIVE) });
  const again = await convertToPdfa({ lib, bytes: first.bytes });
  assert.equal(again.steps.find((s) => s.id === 'intent').label, 'The document’s own output intent kept');
  const check = await validatePdfa(lib, again.bytes);
  assert.deepEqual([...check.failures], []);
});

test('a stopped run produces nothing', async () => {
  const stop = new AbortController();
  stop.abort();
  await assert.rejects(() => convertToPdfa({ lib, bytes: read(REPRESENTATIVE), signal: stop.signal }),
    (err) => err instanceof PdfaError);
});

test('findBlockers names everything it found, not only the first thing', async () => {
  const doc = await lib.PDFDocument.load(read('annotations'), { updateMetadata: false });
  const { openSource } = await import('../../src/Vellum/web/js/editing/source.js');
  const source = await openSource(lib, read('annotations'));
  const found = findBlockers(lib, doc, source);
  assert.ok(found.length >= 2, found.join(' | '));
  assert.ok(found.some((d) => /not embedded/.test(d)));
  assert.ok(found.some((d) => /no appearance/.test(d)));
});

/** The simplest legal LZW stream: a clear code, one 9-bit literal per byte, then end. */
function lzwEncode(bytes) {
  const out = [];
  let buffer = 0;
  let bits = 0;
  const push = (code, width) => {
    buffer = (buffer << width) | code;
    bits += width;
    while (bits >= 8) {
      bits -= 8;
      out.push((buffer >> bits) & 0xff);
    }
  };
  push(256, 9); // clear table
  // After 254 literals the encoder would have to widen to 10 bits; the test data is shorter than that.
  for (const b of bytes) push(b, 9);
  push(257, 9); // end of data
  if (bits) out.push((buffer << (8 - bits)) & 0xff);
  return Uint8Array.from(out);
}
