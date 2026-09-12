// Generates the controlled PDFs the editing-engine tests use, from the repo's own vendored pdf-lib
// and the fonts bundled with pdf.js (Liberation Sans: GPL with a font-embedding exception; Foxit:
// BSD-style). Nothing is downloaded and no system font is used. Files go to a temp folder.
//
//   node tests/editing/fixtures.mjs [outDir]

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { loadPdfLib, STANDARD_FONTS } from './harness.mjs';

export const FIXTURE_DIR = path.join(os.tmpdir(), 'vellum-editing-fixtures');

// ---- small font readers (test-only) ----------------------------------------------------------

/** Just enough TrueType parsing to embed a font: metrics, widths, Unicode → glyph id. */
function readTrueType(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tables = {};
  const count = view.getUint16(4);
  for (let i = 0; i < count; i++) {
    const at = 12 + i * 16;
    const tag = String.fromCharCode(...bytes.subarray(at, at + 4));
    tables[tag] = { offset: view.getUint32(at + 8), length: view.getUint32(at + 12) };
  }
  const head = tables.head.offset;
  const unitsPerEm = view.getUint16(head + 18);
  const bbox = [view.getInt16(head + 36), view.getInt16(head + 38), view.getInt16(head + 40), view.getInt16(head + 42)];
  const hhea = tables.hhea.offset;
  const ascender = view.getInt16(hhea + 4);
  const descender = view.getInt16(hhea + 6);
  const metrics = view.getUint16(hhea + 34);
  const numGlyphs = view.getUint16(tables.maxp.offset + 4);
  const advances = [];
  for (let g = 0; g < numGlyphs; g++) advances.push(view.getUint16(tables.hmtx.offset + 4 * Math.min(g, metrics - 1)));
  // cmap (3,1) format 4
  const cmap = tables.cmap.offset;
  let sub = -1;
  for (let i = 0; i < view.getUint16(cmap + 2); i++) {
    const rec = cmap + 4 + i * 8;
    if (view.getUint16(rec) === 3 && view.getUint16(rec + 2) === 1) sub = cmap + view.getUint32(rec + 4);
  }
  const segs = view.getUint16(sub + 6) / 2;
  const ends = sub + 14;
  const starts = ends + segs * 2 + 2;
  const deltas = starts + segs * 2;
  const ranges = deltas + segs * 2;
  const glyphOf = (cp) => {
    for (let s = 0; s < segs; s++) {
      const end = view.getUint16(ends + s * 2);
      if (cp > end) continue;
      const start = view.getUint16(starts + s * 2);
      if (cp < start) return 0;
      const delta = view.getInt16(deltas + s * 2);
      const range = view.getUint16(ranges + s * 2);
      if (!range) return (cp + delta) & 0xffff;
      const g = view.getUint16(ranges + s * 2 + range + (cp - start) * 2);
      return g ? (g + delta) & 0xffff : 0;
    }
    return 0;
  };
  const scale = (v) => Math.round((v * 1000) / unitsPerEm);
  return { unitsPerEm, bbox: bbox.map(scale), ascent: scale(ascender), descent: scale(descender), glyphOf, width: (g) => scale(advances[g] ?? 0) };
}

/** The font name inside a bare CFF font program (pdf.js ships its Foxit fonts in this form). */
function cffName(bytes) {
  if (bytes[0] !== 1) throw new Error('Not a CFF font program');
  const hdrSize = bytes[2];
  const count = (bytes[hdrSize] << 8) | bytes[hdrSize + 1];
  const offSize = bytes[hdrSize + 2];
  const read = (at) => { let v = 0; for (let i = 0; i < offSize; i++) v = v * 256 + bytes[at + i]; return v; };
  const offsets = hdrSize + 3;
  const data = offsets + (count + 1) * offSize - 1;
  return Buffer.from(bytes.subarray(data + read(offsets), data + read(offsets + offSize))).toString('latin1');
}

// ---- content helpers ---------------------------------------------------------------------------

/** A literal string operand with PDF escapes, from bytes. */
function lit(bytes) {
  let s = '(';
  for (const b of bytes) {
    if (b === 0x28 || b === 0x29 || b === 0x5c) s += `\\${String.fromCharCode(b)}`;
    else if (b < 32 || b > 126) s += `\\${b.toString(8).padStart(3, '0')}`;
    else s += String.fromCharCode(b);
  }
  return `${s})`;
}

const hex = (codes, width = 2) => `<${codes.map((c) => c.toString(16).padStart(width * 2, '0')).join('')}>`;

export async function makeFixtures(outDir = FIXTURE_DIR) {
  fs.mkdirSync(outDir, { recursive: true });
  const lib = await loadPdfLib();
  const { PDFDocument, PDFName, PDFString, PDFHexString, StandardFonts, PageSizes } = lib;
  const winAnsi = lib.StandardFontEmbedder.for(StandardFonts.Helvetica).encoding;
  const ansi = (text) => Uint8Array.from([...text].map((ch) => winAnsi.encodeUnicodeCodePoint(ch.codePointAt(0)).code));
  const written = {};

  /** A document builder over pdf-lib's low-level API: pages get hand-written content streams. */
  async function build(name, fill) {
    const doc = await PDFDocument.create({ updateMetadata: false });
    const ctx = doc.context;
    const api = {
      doc, ctx, lib,
      std: (font) => doc.embedStandardFont(font).ref,
      page(size, content, resources = {}, extra = {}) {
        const page = doc.addPage(size);
        const contents = Array.isArray(content)
          ? ctx.obj(content.map((c) => ctx.register(ctx.flateStream(c))))
          : ctx.register(ctx.flateStream(content));
        page.node.set(PDFName.of('Contents'), contents);
        page.node.set(PDFName.of('Resources'), ctx.obj(resources));
        if (extra.rotate) page.setRotation(lib.degrees(extra.rotate));
        return page;
      },
      image(width, height) {
        const data = new Uint8Array(width * height * 3);
        for (let i = 0; i < width * height; i++) {
          data[i * 3] = (i * 7) & 255;
          data[i * 3 + 1] = (i * 13) & 255;
          data[i * 3 + 2] = (i * 3) & 255;
        }
        return ctx.register(ctx.flateStream(data, { Type: 'XObject', Subtype: 'Image', Width: width, Height: height, ColorSpace: 'DeviceRGB', BitsPerComponent: 8 }));
      },
      trueTypeSimple(file, { subsetTag = null } = {}) {
        const bytes = new Uint8Array(fs.readFileSync(path.join(STANDARD_FONTS, file)));
        const tt = readTrueType(bytes);
        const base = path.basename(file, '.ttf').replace(/-Regular$/, '');
        const fontName = subsetTag ? `${subsetTag}+${base}` : base;
        const widths = [];
        for (let code = 32; code <= 255; code++) {
          let cp = null;
          for (const [u, [c]] of Object.entries(winAnsi.unicodeMappings)) if (c === code) { cp = Number(u); break; }
          widths.push(cp === null ? 0 : tt.width(tt.glyphOf(cp)));
        }
        const file2 = ctx.register(ctx.flateStream(bytes, { Length1: bytes.length }));
        const descriptor = ctx.register(ctx.obj({
          Type: 'FontDescriptor', FontName: fontName, Flags: 32, FontBBox: tt.bbox, ItalicAngle: 0,
          Ascent: tt.ascent, Descent: tt.descent, CapHeight: 700, StemV: 80, FontFile2: file2,
        }));
        return ctx.register(ctx.obj({
          Type: 'Font', Subtype: 'TrueType', BaseFont: fontName, FirstChar: 32, LastChar: 255,
          Widths: widths, Encoding: 'WinAnsiEncoding', FontDescriptor: descriptor,
        }));
      },
      /** Type 0 / Identity-H over a whole TrueType font (CID = glyph id), with a ToUnicode CMap. */
      trueTypeComposite(file, text, { subsetTag = 'ABCDEF' } = {}) {
        const bytes = new Uint8Array(fs.readFileSync(path.join(STANDARD_FONTS, file)));
        const tt = readTrueType(bytes);
        const base = `${subsetTag}+${path.basename(file, '.ttf')}`;
        const used = new Map();
        for (const ch of text) {
          const g = tt.glyphOf(ch.codePointAt(0));
          if (g) used.set(g, ch);
        }
        const gids = [...used.keys()].sort((a, b) => a - b);
        const w = [];
        for (const g of gids) w.push(g, [tt.width(g)]);
        const cmap = [
          '/CIDInit /ProcSet findresource begin', '12 dict begin', 'begincmap',
          '/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def',
          '/CMapName /Adobe-Identity-UCS def', '/CMapType 2 def',
          '1 begincodespacerange', '<0000> <FFFF>', 'endcodespacerange',
          `${gids.length} beginbfchar`,
          ...gids.map((g) => `${hex([g])} <${[...used.get(g)].map((c) => c.codePointAt(0).toString(16).padStart(4, '0')).join('')}>`),
          'endbfchar', 'endcmap', 'CMapName currentdict /CMap defineresource pop', 'end', 'end',
        ].join('\n');
        const file2 = ctx.register(ctx.flateStream(bytes, { Length1: bytes.length }));
        const descriptor = ctx.register(ctx.obj({
          Type: 'FontDescriptor', FontName: base, Flags: 4, FontBBox: tt.bbox, ItalicAngle: 0,
          Ascent: tt.ascent, Descent: tt.descent, CapHeight: 700, StemV: 80, FontFile2: file2,
        }));
        const cid = ctx.register(ctx.obj({
          Type: 'Font', Subtype: 'CIDFontType2', BaseFont: base,
          CIDSystemInfo: { Registry: PDFString.of('Adobe'), Ordering: PDFString.of('Identity'), Supplement: 0 },
          FontDescriptor: descriptor, W: w, DW: 1000, CIDToGIDMap: 'Identity',
        }));
        const ref = ctx.register(ctx.obj({
          Type: 'Font', Subtype: 'Type0', BaseFont: base, Encoding: 'Identity-H', DescendantFonts: [cid],
          ToUnicode: ctx.register(ctx.flateStream(cmap)),
        }));
        return { ref, encode: (s) => hex([...s].map((ch) => tt.glyphOf(ch.codePointAt(0)))) };
      },
      /** Type 0 over a TrueType font with an EMBEDDED CMap: one-byte codes (ASCII) → CIDs (= glyph ids). */
      trueTypeCMapped(file, text) {
        const bytes = new Uint8Array(fs.readFileSync(path.join(STANDARD_FONTS, file)));
        const tt = readTrueType(bytes);
        const base = `CMAPPD+${path.basename(file, '.ttf')}`;
        const chars = [...new Set(text)];
        const code = (ch) => ch.charCodeAt(0);
        const header = (name, type) => ['/CIDInit /ProcSet findresource begin', '12 dict begin', 'begincmap',
          `/CIDSystemInfo << /Registry (Adobe) /Ordering (${type === 1 ? 'Identity' : 'UCS'}) /Supplement 0 >> def`,
          `/CMapName /${name} def`, `/CMapType ${type} def`, '1 begincodespacerange', '<00> <FF>', 'endcodespacerange'];
        const footer = ['endcmap', 'CMapName currentdict /CMap defineresource pop', 'end', 'end'];
        const encoding = [...header('Vellum-OneByte', 1), `${chars.length} begincidchar`,
          ...chars.map((ch) => `${hex([code(ch)], 1)} ${tt.glyphOf(code(ch))}`), 'endcidchar', ...footer].join('\n');
        const toUnicode = [...header('Vellum-OneByte-UCS', 2), `${chars.length} beginbfchar`,
          ...chars.map((ch) => `${hex([code(ch)], 1)} <${code(ch).toString(16).padStart(4, '0')}>`), 'endbfchar', ...footer].join('\n');
        const gids = [...new Set(chars.map((ch) => tt.glyphOf(code(ch))))].sort((a, b) => a - b);
        const w = [];
        for (const g of gids) w.push(g, [tt.width(g)]);
        const file2 = ctx.register(ctx.flateStream(bytes, { Length1: bytes.length }));
        const descriptor = ctx.register(ctx.obj({
          Type: 'FontDescriptor', FontName: base, Flags: 32, FontBBox: tt.bbox, ItalicAngle: 0,
          Ascent: tt.ascent, Descent: tt.descent, CapHeight: 700, StemV: 80, FontFile2: file2,
        }));
        const system = { Registry: PDFString.of('Adobe'), Ordering: PDFString.of('Identity'), Supplement: 0 };
        const cid = ctx.register(ctx.obj({
          Type: 'Font', Subtype: 'CIDFontType2', BaseFont: base, CIDSystemInfo: system,
          FontDescriptor: descriptor, W: w, DW: 1000, CIDToGIDMap: 'Identity',
        }));
        const ref = ctx.register(ctx.obj({
          Type: 'Font', Subtype: 'Type0', BaseFont: base, DescendantFonts: [cid],
          Encoding: ctx.register(ctx.flateStream(encoding, { Type: 'CMap', CMapName: 'Vellum-OneByte', CIDSystemInfo: system })),
          ToUnicode: ctx.register(ctx.flateStream(toUnicode)),
        }));
        return { ref, encode: (s) => hex([...s].map(code), 1) };
      },
      /** Type 0 with a predefined CJK CMap named in the file (supported for display, not for editing). */
      trueTypePredefined(file, cmapName) {
        const bytes = new Uint8Array(fs.readFileSync(path.join(STANDARD_FONTS, file)));
        const tt = readTrueType(bytes);
        const base = path.basename(file, '.ttf');
        const file2 = ctx.register(ctx.flateStream(bytes, { Length1: bytes.length }));
        const descriptor = ctx.register(ctx.obj({
          Type: 'FontDescriptor', FontName: base, Flags: 4, FontBBox: tt.bbox, ItalicAngle: 0,
          Ascent: tt.ascent, Descent: tt.descent, CapHeight: 700, StemV: 80, FontFile2: file2,
        }));
        const cid = ctx.register(ctx.obj({
          Type: 'Font', Subtype: 'CIDFontType2', BaseFont: base,
          CIDSystemInfo: { Registry: PDFString.of('Adobe'), Ordering: PDFString.of('Japan1'), Supplement: 6 },
          FontDescriptor: descriptor, DW: 1000, CIDToGIDMap: 'Identity',
        }));
        return ctx.register(ctx.obj({ Type: 'Font', Subtype: 'Type0', BaseFont: `${base}-${cmapName}`, Encoding: cmapName, DescendantFonts: [cid] }));
      },
      /** A Type 1 font embedded as a bare CFF program (FontFile3 /Type1C), with WinAnsi and Times widths. */
      cff(file, { subsetTag = null } = {}) {
        const program = new Uint8Array(fs.readFileSync(path.join(STANDARD_FONTS, file)));
        const name = cffName(program);
        const fontName = subsetTag ? `${subsetTag}+${name}` : name;
        const times = lib.StandardFontEmbedder.for(StandardFonts.TimesRoman);
        const widths = [];
        for (let code = 32; code <= 255; code++) {
          let glyphName = null;
          for (const [, [c, n]] of Object.entries(winAnsi.unicodeMappings)) if (c === code) { glyphName = n; break; }
          widths.push(glyphName ? times.font.getWidthOfGlyph(glyphName) ?? 0 : 0);
        }
        const fontFile = ctx.register(ctx.flateStream(program, { Subtype: 'Type1C' }));
        const descriptor = ctx.register(ctx.obj({
          Type: 'FontDescriptor', FontName: fontName, Flags: 34, FontBBox: [-168, -218, 1000, 898], ItalicAngle: 0,
          Ascent: 683, Descent: -217, CapHeight: 662, StemV: 84, FontFile3: fontFile,
        }));
        return ctx.register(ctx.obj({
          Type: 'Font', Subtype: 'Type1', BaseFont: fontName, FirstChar: 32, LastChar: 255,
          Widths: widths, Encoding: 'WinAnsiEncoding', FontDescriptor: descriptor,
        }));
      },
    };
    await fill(api);
    const bytes = await doc.save({ useObjectStreams: false });
    const file = path.join(outDir, `${name}.pdf`);
    fs.writeFileSync(file, bytes);
    written[name] = file;
  }

  const text = (font, size, x, y, s) => `BT /${font} ${size} Tf ${x} ${y} Td ${lit(ansi(s))} Tj ET`;

  // 1. Simple one-page text (standard Helvetica, not embedded).
  await build('simple', async (b) => {
    const F1 = b.std(StandardFonts.Helvetica);
    b.page(PageSizes.Letter, [
      text('F1', 24, 72, 700, 'Hello, world'),
      text('F1', 12, 72, 660, 'A second line with punctuation: café, naïve — 50% off!'),
      text('F1', 12, 72, 640, 'Third line.'),
    ].join('\n'), { Font: { F1 } });
  });

  // 2. Multi-page, 3. landscape, 4. mixed page sizes (one page with /Rotate 90).
  await build('multipage', async (b) => {
    const F1 = b.std(StandardFonts.Helvetica);
    for (let p = 1; p <= 5; p++) b.page(PageSizes.A4, text('F1', 14, 60, 760, `Page ${p} of five`), { Font: { F1 } });
  });
  await build('landscape', async (b) => {
    const F1 = b.std(StandardFonts.Helvetica);
    b.page([792, 612], text('F1', 20, 72, 520, 'A landscape page'), { Font: { F1 } });
  });
  await build('mixed-sizes', async (b) => {
    const F1 = b.std(StandardFonts.Helvetica);
    b.page(PageSizes.Letter, text('F1', 12, 72, 700, 'Letter page'), { Font: { F1 } });
    b.page(PageSizes.A5, text('F1', 12, 40, 520, 'A5 page'), { Font: { F1 } });
    b.page([1224, 792], text('F1', 18, 100, 700, 'Tabloid landscape'), { Font: { F1 } });
    b.page(PageSizes.Letter, text('F1', 12, 72, 700, 'Rotated page'), { Font: { F1 } }, { rotate: 90 });
  });

  // 5–6. Several fonts; bold and italic (standard 14 and embedded Liberation / Foxit).
  await build('fonts', async (b) => {
    const res = {
      Font: {
        H: b.std(StandardFonts.Helvetica), HB: b.std(StandardFonts.HelveticaBold), HI: b.std(StandardFonts.HelveticaOblique),
        T: b.std(StandardFonts.TimesRoman), TB: b.std(StandardFonts.TimesRomanBold), TI: b.std(StandardFonts.TimesRomanItalic),
        C: b.std(StandardFonts.Courier),
        LS: b.trueTypeSimple('LiberationSans-Regular.ttf'),
        LB: b.trueTypeSimple('LiberationSans-Bold.ttf', { subsetTag: 'QWERTY' }),
        FX: b.cff('FoxitSerif.pfb'),
      },
    };
    b.page(PageSizes.Letter, [
      text('H', 14, 72, 720, 'Helvetica regular'), text('HB', 14, 72, 700, 'Helvetica bold'), text('HI', 14, 72, 680, 'Helvetica oblique'),
      text('T', 14, 72, 650, 'Times regular'), text('TB', 14, 72, 630, 'Times bold'), text('TI', 14, 72, 610, 'Times italic'),
      text('C', 14, 72, 580, 'Courier fixed'),
      text('LS', 14, 72, 550, 'Liberation Sans embedded'), text('LB', 14, 72, 530, 'Liberation Bold subset'),
      text('FX', 14, 72, 500, 'Foxit Serif Type 1'),
    ].join('\n'), res);
  });

  // Composite (Type 0, Identity-H) font with a ToUnicode CMap.
  await build('composite', async (b) => {
    const words = 'Composite Identity font text with spaces';
    // ToUnicode covers these characters only ('Q' is deliberately left out).
    const f = b.trueTypeComposite('LiberationSans-Regular.ttf', `${words} spaces with Tw`);
    b.page(PageSizes.Letter, [
      `BT /F0 16 Tf 72 700 Td ${f.encode(words)} Tj ET`,
      // Word spacing must not apply to two-byte codes (it would move the text if we got it wrong).
      `BT /F0 12 Tf 8 Tw 72 670 Td ${f.encode('spaces with Tw')} Tj ET`,
      `BT /F0 12 Tf 0 Tw 72 640 Td ${f.encode('Quiet')} Tj ET`,
    ].join('\n'), { Font: { F0: f.ref } });
  });

  // 7. Columns.
  await build('columns', async (b) => {
    const F1 = b.std(StandardFonts.TimesRoman);
    const rows = [];
    for (let i = 0; i < 12; i++) {
      rows.push(`BT /F1 11 Tf 72 ${700 - i * 14} Td ${lit(ansi(`Left column line ${i + 1}`))} Tj ET`);
      rows.push(`BT /F1 11 Tf 320 ${700 - i * 14} Td ${lit(ansi(`Right column line ${i + 1}`))} Tj ET`);
    }
    // One TJ spanning both columns with a big gap: must still become two runs.
    rows.push(`BT /F1 11 Tf 72 500 Td [${lit(ansi('Gap left'))} -18000 ${lit(ansi('Gap right'))}] TJ ET`);
    b.page(PageSizes.Letter, rows.join('\n'), { Font: { F1 } });
  });

  // 8. Images with text.
  await build('images', async (b) => {
    const F1 = b.std(StandardFonts.Helvetica);
    const Im1 = b.image(32, 32);
    b.page(PageSizes.Letter, [
      'q 200 0 0 150 72 500 cm /Im1 Do Q',
      text('F1', 12, 72, 480, 'Caption under the picture'),
      'q 100 0 0 100 400 600 cm /Im1 Do Q',
      text('F1', 12, 300, 700, 'Text beside another picture'),
    ].join('\n'), { Font: { F1 }, XObject: { Im1 } });
  });

  // 9. Annotations, links, an outline and a form field (for integrity checks when saving).
  await build('annotations', async (b) => {
    const F1 = b.std(StandardFonts.Helvetica);
    const page = b.page(PageSizes.Letter, [
      text('F1', 14, 72, 700, 'Text with a link and a note'),
      text('F1', 12, 72, 600, 'Field below:'),
    ].join('\n'), { Font: { F1 } });
    const ctx = b.ctx;
    const link = ctx.register(ctx.obj({ Type: 'Annot', Subtype: 'Link', Rect: [72, 695, 260, 715], Border: [0, 0, 0], A: { S: 'URI', URI: PDFString.of('https://example.com/') } }));
    const note = ctx.register(ctx.obj({ Type: 'Annot', Subtype: 'Text', Rect: [300, 690, 320, 710], Contents: PDFHexString.fromText('A reviewer note'), Name: 'Comment' }));
    page.node.set(PDFName.of('Annots'), ctx.obj([link, note]));
    const form = b.doc.getForm();
    const field = form.createTextField('customer.name');
    field.setText('Ada Lovelace');
    field.addToPage(page, { x: 72, y: 560, width: 200, height: 24 });
    const outline = ctx.register(ctx.obj({}));
    const item = ctx.register(ctx.obj({ Title: PDFHexString.fromText('First page'), Parent: outline, Dest: [page.ref, 'XYZ', 0, 792, 0] }));
    const o = ctx.lookup(outline);
    o.set(PDFName.of('Type'), PDFName.of('Outlines'));
    o.set(PDFName.of('First'), item);
    o.set(PDFName.of('Last'), item);
    o.set(PDFName.of('Count'), ctx.obj(1));
    b.doc.catalog.set(PDFName.of('Outlines'), outline);
    b.doc.setTitle('Annotations fixture');
  });

  // 11. Scanned pages: an image only, and an image with an invisible OCR text layer.
  await build('scanned', async (b) => {
    const F1 = b.std(StandardFonts.Helvetica);
    const Im1 = b.image(64, 80);
    b.page(PageSizes.Letter, 'q 612 0 0 792 0 0 cm /Im1 Do Q', { XObject: { Im1 } });
    b.page(PageSizes.Letter, ['q 612 0 0 792 0 0 cm /Im1 Do Q', `BT 3 Tr /F1 12 Tf 72 700 Td ${lit(ansi('Recognised text layer'))} Tj ET`].join('\n'), { Font: { F1 }, XObject: { Im1 } });
  });

  // 12. Large document.
  await build('large', async (b) => {
    const F1 = b.std(StandardFonts.TimesRoman);
    for (let p = 1; p <= 200; p++) {
      const lines = [];
      for (let i = 0; i < 40; i++) lines.push(`BT /F1 10 Tf 60 ${760 - i * 17} Td ${lit(ansi(`Page ${p}, line ${i + 1}: the quick brown fox jumps over the lazy dog.`))} Tj ET`);
      b.page(PageSizes.A4, lines.join('\n'), { Font: { F1 } });
    }
  });

  // 13. Unusual constructs, one per line/page.
  await build('constructs', async (b) => {
    const H = b.std(StandardFonts.Helvetica);
    const ctx = b.ctx;
    // Encodings: MacRoman, Differences with standard names, Differences with made-up names + ToUnicode.
    const MR = ctx.register(ctx.obj({ Type: 'Font', Subtype: 'Type1', BaseFont: 'Helvetica', Encoding: 'MacRomanEncoding' }));
    const DS = ctx.register(ctx.obj({ Type: 'Font', Subtype: 'Type1', BaseFont: 'Helvetica', Encoding: { Type: 'Encoding', BaseEncoding: 'WinAnsiEncoding', Differences: [1, 'H', 'i', 'exclam'] } }));
    const tu = ctx.register(ctx.flateStream('/CIDInit /ProcSet findresource begin 12 dict begin begincmap 1 begincodespacerange <00> <FF> endcodespacerange 2 beginbfchar <01> <004F> <02> <004B> endbfchar endcmap CMapName currentdict /CMap defineresource pop end end'));
    const DC = ctx.register(ctx.obj({ Type: 'Font', Subtype: 'Type1', BaseFont: 'Helvetica', Encoding: { Type: 'Encoding', Differences: [1, 'glyphOne', 'glyphTwo'] }, ToUnicode: tu }));
    // A Type 3 font with two box glyphs.
    const box = (w) => ctx.register(ctx.stream(`${w} 0 0 0 ${w} 700 d1 0 0 ${w} 700 re f`));
    const T3 = ctx.register(ctx.obj({
      Type: 'Font', Subtype: 'Type3', FontMatrix: [0.001, 0, 0, 0.001, 0, 0], FontBBox: [0, 0, 1000, 1000],
      CharProcs: { a: box(600), b: box(400) }, Encoding: { Type: 'Encoding', Differences: [97, 'a', 'b'] },
      FirstChar: 97, LastChar: 98, Widths: [600, 400], Resources: {},
    }));
    const Fm1 = ctx.register(ctx.flateStream(`BT /H 12 Tf 10 20 Td ${lit(ansi('Inside a form'))} Tj ET`, {
      Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 300, 50], Matrix: [1, 0, 0, 1, 300, 400], Resources: { Font: { H } },
    }));
    const inlineImage = 'BI /W 5 /H 1 /CS /G /BPC 8 ID \x45\x49 \x45\x49 EI'; // data bytes spell "EI EI"
    b.page(PageSizes.Letter, [
      `BT /H 14 Tf 72 740 Td [${lit(ansi('W'))} 120 ${lit(ansi('o'))} -30 ${lit(ansi('rld kerned'))}] TJ ET`,
      `BT /H 12 Tf 2 Tc 6 Tw 80 Tz 72 715 Td ${lit(ansi('Spaced and scaled words'))} Tj ET`,
      `BT /H 12 Tf 72 690 Td 5 Ts ${lit(ansi('Raised'))} Tj 0 Ts ET`,
      `BT /H 12 Tf 14 TL 72 670 Td ${lit(ansi('Line one'))} Tj ${lit(ansi('Line two'))} ' 1 0.5 ${lit(ansi('Line three'))} " ET`,
      `BT /H 12 Tf 72 610 Td <48657820737472696e67> Tj ET`,
      `BT /H 12 Tf 72 590 Td (Escapes \\(paren\\) back\\\\slash \\101\\102) Tj ET`,
      '% a comment between operators',
      inlineImage,
      `BT /H 12 Tf 72 570 Td ${lit(ansi('After the inline image'))} Tj ET`,
      `BT /MR 12 Tf 72 550 Td ${lit(Uint8Array.from([0x43, 0x61, 0x66, 0x8e]))} Tj ET`, // "Café" in MacRoman
      `BT /DS 12 Tf 72 530 Td <010203> Tj ET`, // "Hi!" through /Differences
      `BT /DC 12 Tf 72 510 Td <0102> Tj ET`, // "OK" through ToUnicode
      `BT /T3 12 Tf 72 490 Td (abab) Tj ET`,
      '/Fm1 Do',
      `BT /H 12 Tf 0 1 -1 0 540 300 Tm ${lit(ansi('Rotated text'))} Tj ET`,
      `BT /H 12 Tf 1 0 0.4 1 72 300 Tm ${lit(ansi('Skewed text'))} Tj ET`,
      // A negative size turns the text upside down (a 180° rotation, still editable)…
      `BT /H -12 Tf 200 280 Td ${lit(ansi('Upside-down text'))} Tj ET`,
      // …a negative horizontal scale mirrors it (not editable).
      `BT /H 12 Tf -1 0 0 1 400 280 Tm ${lit(ansi('Mirrored text'))} Tj ET`,
      'q 72 250 m 72 272 94 272 94 250 c h W n', `BT /H 12 Tf 72 255 Td ${lit(ansi('Clipped by a curve'))} Tj ET`, 'Q',
      'q 60 220 300 30 re W n', `BT /H 12 Tf 72 230 Td ${lit(ansi('Inside a rectangle clip'))} Tj ET`, 'Q',
      'q 60 200 50 30 re W n', `BT /H 12 Tf 72 210 Td ${lit(ansi('Cut by a rectangle clip'))} Tj ET`, 'Q',
      `BT /H 12 Tf 72 180 Td ${lit(ansi('Fake bold'))} Tj ET`, `BT /H 12 Tf 72.3 180 Td ${lit(ansi('Fake bold'))} Tj ET`,
      `/Span << /ActualText (Replacement) >> BDC BT /H 12 Tf 72 160 Td ${lit(ansi('Visible glyphs'))} Tj ET EMC`,
      `/Artifact BMC BT /H 10 Tf 72 40 Td ${lit(ansi('Page footer artifact'))} Tj ET EMC`,
      `BT 1 Tr 0.5 w /H 12 Tf 300 160 Td ${lit(ansi('Outlined text'))} Tj ET`,
      `BT 2 Tr /H 12 Tf 300 140 Td ${lit(ansi('Filled and outlined'))} Tj ET`,
      `BT 3 Tr /H 12 Tf 300 120 Td ${lit(ansi('Invisible text'))} Tj ET`,
      `BT 7 Tr /H 12 Tf 300 100 Td ${lit(ansi('Clip text'))} Tj ET`,
      // The render mode is graphics state: it survives ET, so reset it first.
      `BT 0 Tr /H 0 Tf 300 80 Td ${lit(ansi('Zero size'))} Tj ET`,
    ].join('\n'), { Font: { H, MR, DS, DC, T3 }, XObject: { Fm1 } });

    // Content split across two streams, a text object spanning both.
    b.page(PageSizes.Letter, [
      `BT /H 12 Tf 72 700 Td ${lit(ansi('Split'))} Tj`,
      `${lit(ansi(' across streams'))} Tj ET`,
    ], { Font: { H } });

    // Text shown before any font is selected (pdf.js skips it), then normal text.
    b.page(PageSizes.Letter, [
      `BT 72 700 Td ${lit(ansi('No font selected'))} Tj ET`,
      `BT /H 12 Tf 72 680 Td ${lit(ansi('Normal text after it'))} Tj ET`,
    ].join('\n'), { Font: { H } });

    // A stray Q (restores a state that was never saved): the page is left alone.
    b.page(PageSizes.Letter, `Q BT /H 12 Tf 72 700 Td ${lit(ansi('After a stray Q'))} Tj ET`, { Font: { H } });

    // Content that ends with states and a text object still open (viewers close them): editable.
    b.page(PageSizes.Letter, `q 1 0 0 1 20 0 cm q BT /H 12 Tf 52 700 Td ${lit(ansi('Left open'))} Tj`, { Font: { H } });
  });

  // 14. Transparency: a soft mask (refused), the mask switched off again, opacity and a blend mode (editable).
  await build('transparency', async (b) => {
    const F1 = b.std(StandardFonts.Helvetica);
    const ctx = b.ctx;
    // A luminosity soft mask: a grey rectangle in its own transparency group.
    const group = ctx.register(ctx.flateStream('0.5 g 0 0 612 792 re f', {
      Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 612, 792], Group: { S: 'Transparency', CS: 'DeviceGray' }, Resources: {},
    }));
    b.page(PageSizes.Letter, [
      `q /Mask gs ${text('F1', 14, 72, 700, 'Masked text')} Q`,
      `q /Mask gs /NoMask gs ${text('F1', 14, 72, 670, 'Mask cleared again')} Q`,
      `q /Half gs ${text('F1', 14, 72, 640, 'Half-transparent text')} Q`,
      `q /Multiply gs ${text('F1', 14, 72, 610, 'Multiplied text')} Q`,
      text('F1', 14, 72, 580, 'Plain text'),
    ].join('\n'), {
      Font: { F1 },
      ExtGState: {
        Mask: { Type: 'ExtGState', SMask: { Type: 'Mask', S: 'Luminosity', G: group } },
        NoMask: { Type: 'ExtGState', SMask: 'None' },
        Half: { Type: 'ExtGState', ca: 0.5, CA: 0.5 },
        Multiply: { Type: 'ExtGState', BM: 'Multiply' },
      },
    });
  });

  // 15. Page objects for later editing phases (read-only analysis): images of every kind, shapes, a
  // form, tagged and artifact content, and optional content (a visible and a hidden layer).
  await build('objects', async (b) => {
    const F1 = b.std(StandardFonts.Helvetica);
    const ctx = b.ctx;
    const Im1 = b.image(8, 8);
    const rgb = (extra = {}) => ctx.register(ctx.flateStream(new Uint8Array(8 * 8 * 3).fill(200), {
      Type: 'XObject', Subtype: 'Image', Width: 8, Height: 8, ColorSpace: 'DeviceRGB', BitsPerComponent: 8, ...extra,
    }));
    const Mask = ctx.register(ctx.flateStream(new Uint8Array(8).fill(0xaa), { Type: 'XObject', Subtype: 'Image', Width: 8, Height: 8, ImageMask: true, BitsPerComponent: 1 }));
    const alpha = ctx.register(ctx.flateStream(new Uint8Array(64).fill(128), { Type: 'XObject', Subtype: 'Image', Width: 8, Height: 8, ColorSpace: 'DeviceGray', BitsPerComponent: 8 }));
    const Im2 = rgb({ SMask: alpha });
    const on = ctx.register(ctx.obj({ Type: 'OCG', Name: PDFHexString.fromText('Visible layer') }));
    const off = ctx.register(ctx.obj({ Type: 'OCG', Name: PDFHexString.fromText('Hidden layer') }));
    b.doc.catalog.set(PDFName.of('OCProperties'), ctx.obj({ OCGs: [on, off], D: { ON: [on], OFF: [off], Order: [on, off] } }));
    const Im3 = rgb({ OC: on });
    const Fm1 = ctx.register(ctx.flateStream('q 50 0 0 50 0 0 cm /Im1 Do Q', {
      Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 50, 50], Matrix: [1, 0, 0, 1, 400, 100], Resources: { XObject: { Im1 } },
    }));
    b.page(PageSizes.Letter, [
      'q 100 0 0 50 72 650 cm /Im1 Do Q', // 0 plain
      'q 0 60 -40 0 300 650 cm /Im1 Do Q', // 1 rotated 90°
      'q 0 0 1 rg 40 0 0 40 72 560 cm /Mask Do Q', // 2 stencil mask
      'q /Half gs 40 0 0 40 150 560 cm /Im2 Do Q', // 3 own soft mask, half opacity
      'q 200 540 60 60 re W n 80 0 0 80 190 530 cm /Im1 Do Q', // 4 clipped
      '/Artifact BMC q 30 0 0 30 300 560 cm /Im1 Do Q EMC', // 5 artifact
      '/Figure <</MCID 3>> BDC q 30 0 0 30 350 560 cm /Im1 Do Q EMC', // 6 tagged
      '/OC /L1 BDC q 30 0 0 30 400 560 cm /Im1 Do Q EMC', // 7 visible layer
      '/OC /L2 BDC q 30 0 0 30 450 560 cm /Im1 Do Q EMC', // 8 hidden layer
      'q 30 0 0 30 500 560 cm /Im3 Do Q', // 9 the image's own /OC
      'q 20 0 0 10 72 480 cm BI /W 2 /H 1 /CS /RGB /BPC 8 ID ABCDEF EI Q', // 10 inline
      '/Fm1 Do', // 11 inside a form
      'q 0.9 g 72 400 200 40 re f Q',
      'q 0 G 2 w 72 380 m 272 380 l S Q',
      'q 300 370 200 30 re W n /Sh0 sh Q',
      `/P /MC0 BDC ${text('F1', 12, 72, 300, 'Tagged paragraph')} EMC`,
      `/Artifact BMC ${text('F1', 12, 72, 280, 'Artifact text')} EMC`,
      `/OC /L1 BDC ${text('F1', 12, 72, 260, 'Text on a visible layer')} EMC`,
      `/OC /L2 BDC ${text('F1', 12, 72, 240, 'Text on a hidden layer')} EMC`,
      text('F1', 12, 72, 220, 'Ordinary text'),
    ].join('\n'), {
      Font: { F1 },
      XObject: { Im1, Mask, Im2, Im3, Fm1 },
      Properties: { MC0: { MCID: 5 }, L1: on, L2: off },
      ExtGState: { Half: { Type: 'ExtGState', ca: 0.5, CA: 0.5 } },
      Shading: { Sh0: { ShadingType: 2, ColorSpace: 'DeviceGray', Coords: [300, 385, 500, 385], Function: { FunctionType: 2, Domain: [0, 1], C0: [0], C1: [1], N: 1 } } },
    });
  });

  // 16. A crop box that doesn't start at the origin.
  await build('cropbox', async (b) => {
    const F1 = b.std(StandardFonts.Helvetica);
    const page = b.page(PageSizes.Letter, [
      text('F1', 14, 120, 600, 'Inside an offset crop box'),
      text('F1', 14, 120, 150, 'Near the bottom of the crop'),
    ].join('\n'), { Font: { F1 } });
    page.setCropBox(100, 100, 400, 592);
  });

  // 17. CMaps: an embedded one-byte CMap (editable) and a predefined CJK CMap by name (refused).
  await build('cmaps', async (b) => {
    const words = 'One byte codes through an embedded CMap';
    const one = b.trueTypeCMapped('LiberationSans-Regular.ttf', words);
    const cjk = b.trueTypePredefined('LiberationSans-Regular.ttf', 'UniJIS-UCS2-H');
    b.page(PageSizes.Letter, [
      `BT /F0 14 Tf 72 700 Td ${one.encode(words)} Tj ET`,
      'BT /F1 14 Tf 72 670 Td <00480069> Tj ET', // "Hi" as UCS-2 codes
    ].join('\n'), { Font: { F0: one.ref, F1: cjk } });
  });

  // 18. A tagged PDF: a structure tree over marked content (MCIDs), and an artifact.
  await build('tagged', async (b) => {
    const F1 = b.std(StandardFonts.Helvetica);
    const ctx = b.ctx;
    const page = b.page(PageSizes.Letter, [
      `/H1 <</MCID 0>> BDC ${text('F1', 18, 72, 700, 'A tagged heading')} EMC`,
      `/P <</MCID 1>> BDC ${text('F1', 12, 72, 670, 'A tagged paragraph of text.')} EMC`,
      `/Artifact BMC ${text('F1', 9, 72, 40, 'Page 1')} EMC`,
    ].join('\n'), { Font: { F1 } });
    const root = ctx.register(ctx.obj({ Type: 'StructTreeRoot' }));
    const document = ctx.register(ctx.obj({ Type: 'StructElem', S: 'Document', P: root }));
    const heading = ctx.register(ctx.obj({ Type: 'StructElem', S: 'H1', P: document, Pg: page.ref, K: 0 }));
    const paragraph = ctx.register(ctx.obj({ Type: 'StructElem', S: 'P', P: document, Pg: page.ref, K: 1 }));
    ctx.lookup(document).set(PDFName.of('K'), ctx.obj([heading, paragraph]));
    ctx.lookup(root).set(PDFName.of('K'), document);
    ctx.lookup(root).set(PDFName.of('ParentTree'), ctx.obj({ Nums: [0, ctx.obj([heading, paragraph])] }));
    page.node.set(PDFName.of('StructParents'), ctx.obj(0));
    b.doc.catalog.set(PDFName.of('StructTreeRoot'), root);
    b.doc.catalog.set(PDFName.of('MarkInfo'), ctx.obj({ Marked: true }));
  });

  // 19. A PDF/A-2B claim (XMP metadata) over text in an embedded subset font.
  await build('pdfa', async (b) => {
    const LS = b.trueTypeSimple('LiberationSans-Regular.ttf', { subsetTag: 'PDFAAA' });
    b.page(PageSizes.Letter, text('LS', 14, 72, 700, 'Archived text in an embedded font'), { Font: { LS } });
    const xmp = [
      '<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?>',
      '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">',
      '<rdf:Description rdf:about="" xmlns:pdfaid="http://www.aiim.org/pdfa/ns/id/">',
      '<pdfaid:part>2</pdfaid:part><pdfaid:conformance>B</pdfaid:conformance>',
      '</rdf:Description></rdf:RDF></x:xmpmeta>', '<?xpacket end="w"?>',
    ].join('\n');
    b.doc.catalog.set(PDFName.of('Metadata'), b.ctx.register(b.ctx.stream(xmp, { Type: 'Metadata', Subtype: 'XML' })));
  });

  // 20–21. Signed PDFs — the SHAPE of a signature (not a cryptographically valid one): a signature
  // field whose value has /ByteRange and /Contents; with and without the SignaturesExist flag.
  for (const [name, flags] of [['signed', 3], ['signed-noflags', null]]) {
    await build(name, async (b) => {
      const F1 = b.std(StandardFonts.Helvetica);
      const ctx = b.ctx;
      const page = b.page(PageSizes.Letter, text('F1', 14, 72, 700, 'A signed agreement'), { Font: { F1 } });
      const value = ctx.register(ctx.obj({
        Type: 'Sig', Filter: 'Adobe.PPKLite', SubFilter: 'adbe.pkcs7.detached',
        ByteRange: [0, 100, 200, 100], Contents: PDFHexString.of('00'.repeat(64)), M: PDFString.fromDate(new Date(0)),
      }));
      const widget = ctx.register(ctx.obj({ Type: 'Annot', Subtype: 'Widget', FT: 'Sig', T: PDFString.of('Signature1'), V: value, Rect: [72, 600, 272, 640], F: 132, P: page.ref }));
      page.node.set(PDFName.of('Annots'), ctx.obj([widget]));
      b.doc.catalog.set(PDFName.of('AcroForm'), ctx.obj(flags === null ? { Fields: [widget] } : { Fields: [widget], SigFlags: flags }));
    });
  }

  // 22. Objects that genuinely overlap, so z-order can be tested through a real PDF rather than
  // only over constructed quads. Three pairs, each drawn back-to-front in the content stream:
  // an image under text, text under an image, and one image under another. Nothing else is on the
  // page, so a hit test has exactly one right answer everywhere.
  await build('overlap', async (b) => {
    const F1 = b.std(StandardFonts.Helvetica);
    const Im1 = b.image(8, 8);
    b.page(PageSizes.Letter, [
      // 1. an image, then text across the middle of it: the text is on top.
      'q 200 0 0 100 72 640 cm /Im1 Do Q',
      text('F1', 24, 90, 680, 'Over the picture'),
      // 2. text, then an image completely over it: the image is on top and the text is unreachable.
      text('F1', 24, 90, 520, 'Under the picture'),
      'q 230 0 0 100 72 480 cm /Im1 Do Q',
      // 3. two draws of the same image resource, the second over the first: identity is the draw,
      //    not the resource, so these are two objects and the later one wins.
      'q 150 0 0 100 72 300 cm /Im1 Do Q',
      'q 150 0 0 100 147 300 cm /Im1 Do Q',
    ].join('\n'), { Font: { F1 }, XObject: { Im1 } });
  });

  // 10. Encrypted files (RC4 40-bit, the classic standard security handler): an empty user
  // password (opens without asking, still encrypted) and a real password.
  written['encrypted-open'] = writeEncrypted(path.join(outDir, 'encrypted-open.pdf'), '');
  written['encrypted-password'] = writeEncrypted(path.join(outDir, 'encrypted-password.pdf'), 'secret');
  return written;
}

// ---- a tiny encrypted PDF writer (RC4, /V 1 /R 2) ---------------------------------------------------

const PADDING = Buffer.from('28BF4E5E4E758A4164004E56FFFA01082E2E00B6D0683E802F0CA9FE6453697A', 'hex');

function rc4(key, data) {
  const s = Array.from({ length: 256 }, (_, i) => i);
  let j = 0;
  for (let i = 0; i < 256; i++) {
    j = (j + s[i] + key[i % key.length]) & 255;
    [s[i], s[j]] = [s[j], s[i]];
  }
  const out = Buffer.alloc(data.length);
  let i = 0;
  j = 0;
  for (let k = 0; k < data.length; k++) {
    i = (i + 1) & 255;
    j = (j + s[i]) & 255;
    [s[i], s[j]] = [s[j], s[i]];
    out[k] = data[k] ^ s[(s[i] + s[j]) & 255];
  }
  return out;
}

const md5 = (...parts) => crypto.createHash('md5').update(Buffer.concat(parts)).digest();
const pad = (password) => Buffer.concat([Buffer.from(password, 'latin1'), PADDING]).subarray(0, 32);

function writeEncrypted(file, userPassword) {
  const id = crypto.createHash('md5').update(`vellum-${userPassword}`).digest();
  const permissions = -44;
  const ownerKey = md5(pad(`owner-${userPassword}`)).subarray(0, 5);
  const O = rc4(ownerKey, pad(userPassword));
  const P = Buffer.alloc(4);
  P.writeInt32LE(permissions);
  const key = md5(pad(userPassword), O, P, id).subarray(0, 5);
  const U = rc4(key, PADDING);
  const objectKey = (num) => md5(key, Buffer.from([num & 255, (num >> 8) & 255, (num >> 16) & 255, 0, 0])).subarray(0, 10);
  const content = Buffer.from('BT /F1 18 Tf 72 700 Td (Protected text) Tj ET');
  const encrypted = rc4(objectKey(5), content);
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    null,
    `<< /Filter /Standard /V 1 /R 2 /O <${O.toString('hex')}> /U <${U.toString('hex')}> /P ${permissions} >>`,
  ];
  const chunks = [Buffer.from('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n', 'latin1')];
  const offsets = [];
  let length = chunks[0].length;
  objects.forEach((body, i) => {
    offsets.push(length);
    const head = Buffer.from(`${i + 1} 0 obj\n`);
    const part = body === null
      ? Buffer.concat([head, Buffer.from(`<< /Length ${encrypted.length} >>\nstream\n`), encrypted, Buffer.from('\nendstream\nendobj\n')])
      : Buffer.concat([head, Buffer.from(`${body}\nendobj\n`)]);
    chunks.push(part);
    length += part.length;
  });
  const xref = [`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`, ...offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`)].join('');
  chunks.push(Buffer.from(`${xref}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Encrypt 6 0 R /ID [<${id.toString('hex')}> <${id.toString('hex')}>] >>\nstartxref\n${length}\n%%EOF\n`));
  fs.writeFileSync(file, Buffer.concat(chunks));
  return file;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const files = await makeFixtures(process.argv[2] ?? FIXTURE_DIR);
  for (const [name, file] of Object.entries(files)) console.log(`${name.padEnd(20)} ${fs.statSync(file).size} bytes  ${file}`);
}
