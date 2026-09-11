// Unit tests for the pure parts of the editing engine: lexer, CMaps, matrices, font models.
// Run: node --test "tests/editing/*.test.mjs"

import test from 'node:test';
import assert from 'node:assert/strict';
import { engine, loadPdfLib } from './harness.mjs';

const { lex, PdfName, PdfString, ContentSyntaxError } = await engine('content/lexer.js');
const { parseCMap, readCharCode, IDENTITY_CMAP } = await engine('cmap.js');
const { multiply, apply, invert } = await engine('matrix.js');
const { createFont, standardFontName, fallbackFontFor, charactersOutsideWinAnsi } = await engine('fonts.js');
const { buildGlyphData } = await engine('glyph-names.js');

const bytes = (s) => Uint8Array.from(Buffer.from(s, 'latin1'));
const text = (u8) => Buffer.from(u8).toString('latin1');

test('lexer: operators, operands and exact byte ranges', () => {
  const src = 'BT /F1 12 Tf 72 700 Td (Hello) Tj ET';
  const { ops, trailing } = lex(bytes(src));
  assert.deepEqual(ops.map((o) => o.op), ['BT', 'Tf', 'Td', 'Tj', 'ET']);
  assert.equal(trailing, 0);
  const tf = ops[1];
  assert.ok(tf.args[0] instanceof PdfName && tf.args[0].name === 'F1');
  assert.equal(tf.args[1], 12);
  // Each operator's range covers exactly its operands and keyword.
  assert.deepEqual(ops.map((o) => src.slice(o.start, o.end)), ['BT', '/F1 12 Tf', '72 700 Td', '(Hello) Tj', 'ET']);
});

test('lexer: string escapes, nesting, octal and line continuation', () => {
  const { ops } = lex(bytes('(a\\(b\\)c\\\\d\\101\\12x (nested) \\\ncont\\q) Tj'));
  const s = ops[0].args[0];
  assert.ok(s instanceof PdfString && !s.hex);
  assert.equal(text(s.bytes), 'a(b)c\\dA\nx (nested) contq');
});

test('lexer: unescaped CR/CRLF inside a string reads as LF', () => {
  const { ops } = lex(bytes('(one\r\ntwo\rthree) Tj'));
  assert.equal(text(ops[0].args[0].bytes), 'one\ntwo\nthree');
});

test('lexer: hex strings (whitespace, odd digit count)', () => {
  const { ops } = lex(bytes('<48 65 6C6c6F> Tj <414> Tj'));
  assert.equal(text(ops[0].args[0].bytes), 'Hello');
  assert.ok(ops[0].args[0].hex);
  assert.deepEqual([...ops[1].args[0].bytes], [0x41, 0x40]);
});

test('lexer: names with #xx escapes, numbers (incl. exponents), arrays, dicts, booleans', () => {
  const { ops } = lex(bytes('/A#20B -.5 +3 4. 1.5e-2 [1 (x) /N [2]] <</K true /L null>> op'));
  const [name, a, b, c, d, arr, dict] = ops[0].args;
  assert.equal(name.name, 'A B');
  assert.deepEqual([a, b, c, d], [-0.5, 3, 4, 0.015]);
  assert.equal(arr.length, 4);
  assert.ok(arr[1] instanceof PdfString && arr[2] instanceof PdfName && Array.isArray(arr[3]));
  assert.ok(dict instanceof Map && dict.get('K') === true && dict.get('L') === null);
});

test('lexer: comments are skipped', () => {
  const { ops } = lex(bytes('% leading comment\nq % trailing\nQ'));
  assert.deepEqual(ops.map((o) => o.op), ['q', 'Q']);
});

test('lexer: inline image data containing "EI" is skipped correctly', () => {
  // Five bytes of image data that happen to read "EI EI": the computed length (5 × 1 × 8 bits)
  // tells where the data really ends.
  const src = 'q BI /W 5 /H 1 /CS /G /BPC 8 ID \x45\x49 \x45\x49 EI Q BT ET';
  const { ops } = lex(bytes(src));
  assert.deepEqual(ops.map((o) => o.op), ['q', 'BI', 'Q', 'BT', 'ET']);
  const bi = ops[1];
  assert.equal(bi.args[0].get('W'), 5);
  assert.equal(src.slice(bi.data.start, bi.data.end), 'EI EI');
  // Filtered data can't be measured; the search then stops at the first plausible "EI".
  const filtered = lex(bytes('BI /W 2 /H 1 /CS /G /BPC 8 /F /AHx ID 00FF> EI Q'));
  assert.deepEqual(filtered.ops.map((o) => o.op), ['BI', 'Q']);
});

test('lexer: inline image with an explicit /L length', () => {
  const src = 'BI /W 2 /H 1 /CS /G /BPC 8 /L 2 ID \xff\x00 EI Q';
  const { ops } = lex(bytes(src));
  assert.deepEqual(ops.map((o) => o.op), ['BI', 'Q']);
  assert.equal(ops[0].data.end - ops[0].data.start, 2);
});

test('lexer: malformed input throws instead of guessing', () => {
  assert.throws(() => lex(bytes('(unterminated Tj')), ContentSyntaxError);
  assert.throws(() => lex(bytes('<4G> Tj')), ContentSyntaxError);
  assert.throws(() => lex(bytes('[1 2 Tj')), ContentSyntaxError);
  assert.throws(() => lex(bytes('1.2.3 Tw')), ContentSyntaxError);
  assert.throws(() => lex(bytes('[1 Tj]')), ContentSyntaxError);
});

test('matrices: multiply, apply, invert', () => {
  const m = multiply([2, 0, 0, 2, 10, 20], [1, 0, 0, 1, 5, 5]);
  assert.deepEqual(m, [2, 0, 0, 2, 15, 25]);
  assert.deepEqual(apply(m, 1, 1), [17, 27]);
  const inv = invert([0, 1, -1, 0, 300, 400]);
  assert.deepEqual(apply(inv, ...apply([0, 1, -1, 0, 300, 400], 3, 4)).map((v) => Math.round(v * 1e9) / 1e9), [3, 4]);
  assert.equal(invert([0, 0, 0, 0, 1, 1]), null);
});

test('CMaps: bfchar, bfrange (string and array), surrogate pairs, codespace', () => {
  const cmap = parseCMap(bytes([
    '/CIDInit /ProcSet findresource begin 12 dict begin begincmap',
    '1 begincodespacerange <0000> <FFFF> endcodespacerange',
    '2 beginbfchar <0001> <0041> <0002> <D83DDE00> endbfchar',
    '2 beginbfrange <0010> <0012> <0061> <0020> <0021> [<0066006C> <263A>] endbfrange',
    'endcmap end end',
  ].join('\n')));
  assert.deepEqual(cmap.codespace, [[2, 0, 0xffff]]);
  assert.equal(cmap.unicode.get(1), 'A');
  assert.equal(cmap.unicode.get(2), '😀');
  assert.equal(cmap.unicode.get(0x11), 'b');
  assert.equal(cmap.unicode.get(0x12), 'c');
  assert.equal(cmap.unicode.get(0x20), 'fl');
  assert.equal(cmap.unicode.get(0x21), '☺');
  assert.equal(cmap.vertical, false);
});

test('CMaps: cid ranges, WMode, usecmap, readCharCode like pdf.js', () => {
  const cmap = parseCMap(bytes('1 begincodespacerange <00> <80> endcodespacerange 1 begincodespacerange <8140> <9FFC> endcodespacerange 1 begincidrange <8140> <8142> 100 endcidrange /WMode 1 def /Foo usecmap'));
  assert.equal(cmap.cids.get(0x8141), 101);
  assert.equal(cmap.vertical, true);
  assert.equal(cmap.usecmap, 'Foo');
  const data = Uint8Array.from([0x41, 0x81, 0x40, 0xff]);
  assert.deepEqual(readCharCode(cmap.codespace, data, 0), { code: 0x41, length: 1, matched: true });
  assert.deepEqual(readCharCode(cmap.codespace, data, 1), { code: 0x8140, length: 2, matched: true });
  assert.deepEqual(readCharCode(cmap.codespace, data, 3), { code: 0, length: 1, matched: false });
  assert.deepEqual(readCharCode(IDENTITY_CMAP.codespace, Uint8Array.from([0, 0x41]), 0), { code: 0x41, length: 2, matched: true });
});

const lib = await loadPdfLib();
const glyphs = { ...buildGlyphData(lib), winAnsiCodePoints: new Set(Object.keys(lib.StandardFontEmbedder.for('Helvetica').encoding.unicodeMappings).map(Number)) };
const env = {
  glyphs,
  standardMetrics(name) {
    const f = lib.StandardFontEmbedder.for(name).font;
    return { widthOf: (g) => f.getWidthOfGlyph(g), ascent: f.Ascender, descent: f.Descender, bbox: f.FontBBox };
  },
};

test('glyph names resolve like pdf.js (known names, uniXXXX, uXXXX; not lower-case hex)', () => {
  assert.equal(glyphs.unicodeOf('Aacute'), 'Á');
  assert.equal(glyphs.unicodeOf('Lslash'), 'Ł');
  assert.equal(glyphs.unicodeOf('Ccaron'), 'Č');
  assert.equal(glyphs.unicodeOf('fi'), 'ﬁ');
  assert.equal(glyphs.unicodeOf('uni20AC'), '€');
  assert.equal(glyphs.unicodeOf('u1F600'), '😀');
  assert.equal(glyphs.unicodeOf('uni20ac'), null);
  assert.equal(glyphs.unicodeOf('g123'), null);
  assert.equal(glyphs.unicodeOf('alpha'), 'α');
});

test('standard font names and aliases', () => {
  assert.equal(standardFontName('Helvetica'), 'Helvetica');
  assert.equal(standardFontName('Arial,Bold'), 'Helvetica-Bold');
  assert.equal(standardFontName('ABCDEF+Arial-BoldItalicMT'), 'Helvetica-BoldOblique');
  assert.equal(standardFontName('TimesNewRomanPS-ItalicMT'), 'Times-Italic');
  assert.equal(standardFontName('Times-Roman'), 'Times-Roman');
  assert.equal(standardFontName('CourierNewPS-BoldMT'), 'Courier-Bold');
  assert.equal(standardFontName('Calibri'), null);
});

test('simple standard font: decoding, widths and conservative writing', () => {
  const font = createFont({ key: 'k', subtype: 'Type1', baseFont: 'Helvetica', encoding: { name: 'WinAnsiEncoding' } }, env);
  const g = font.decode(bytes('Caf\xe9 \x80'));
  assert.equal(g.map((x) => x.unicode).join(''), 'Café €');
  assert.equal(g[0].width, 722); // 'C' in Helvetica
  // Nothing has been confirmed by pdf.js yet: nothing is writable.
  assert.equal(font.planText('Cafe').ok, false);
  font.noteVerified(67, { unicode: 'C', width: 722, inFont: true, byteLength: 1 });
  // A font the viewer supplies itself: once confirmed, its whole encoding is writable…
  const plan = font.planText('Café — naïve');
  assert.equal(plan.ok, true);
  // …but not characters its encoding doesn't have.
  const hindi = font.planText('नमस्ते');
  assert.equal(hindi.ok, false);
  assert.deepEqual(hindi.missing, [...'नमस्ते'.normalize('NFC')].filter((c, i, a) => a.indexOf(c) === i));
});

test('embedded subset font: only characters pdf.js proved present are writable', () => {
  const font = createFont({
    key: 'e', subtype: 'TrueType', baseFont: 'ABCDEF+Liberation', firstChar: 32, widths: new Array(224).fill(500),
    encoding: { name: 'WinAnsiEncoding' }, descriptor: { flags: 32, fontFile: 'FontFile2', ascent: 900, descent: -200 },
  }, env);
  assert.equal(font.embedded, true);
  assert.equal(font.subset, true);
  for (const ch of 'Helo') font.noteVerified(ch.charCodeAt(0), { unicode: ch, width: 500, inFont: true, byteLength: 1 });
  assert.equal(font.planText('Hello').ok, true);
  const plan = font.planText('Help');
  assert.equal(plan.ok, false);
  assert.deepEqual(plan.missing, ['p']);
  // A space the font never drew becomes a gap rather than a guess.
  assert.deepEqual(font.planText('He lo').items.map((i) => (i.space ? '␣' : i.text)).join(''), 'He␣lo');
  // A conflict with pdf.js removes a code for good.
  font.noteConflict('o'.charCodeAt(0));
  assert.equal(font.planText('Hello').ok, false);
});

test('composite Identity-H font: two-byte codes through ToUnicode, widths from /W', () => {
  const toUnicode = bytes('1 begincodespacerange <0000> <FFFF> endcodespacerange 2 beginbfchar <0024> <0041> <0025> <0042> endbfchar');
  const font = createFont({
    key: 'c', subtype: 'Type0', baseFont: 'XYZABC+Arial', cmap: { name: 'Identity-H' }, toUnicode,
    descendant: { subtype: 'CIDFontType2', w: [36, [667, 700]], dw: 1000, descriptor: { flags: 4, fontFile: 'FontFile2' } },
  }, env);
  const g = font.decode(Uint8Array.from([0, 0x24, 0, 0x25, 0, 0x26]));
  assert.deepEqual(g.map((x) => [x.code, x.unicode, x.width, x.byteLength]), [[0x24, 'A', 667, 2], [0x25, 'B', 700, 2], [0x26, null, 1000, 2]]);
});

test('unsupported encodings are flagged, not guessed', () => {
  const cjk = createFont({ key: 'j', subtype: 'Type0', baseFont: 'MSMincho', cmap: { name: '90ms-RKSJ-H' }, descendant: { subtype: 'CIDFontType0' } }, env);
  assert.ok(cjk.issues.has('cmap'));
  assert.ok(cjk.decode(bytes('ab')).every((g) => g.unicode === null && g.width === null));
  const vertical = createFont({ key: 'v', subtype: 'Type0', baseFont: 'X', cmap: { name: 'Identity-V' }, descendant: { subtype: 'CIDFontType2' } }, env);
  assert.ok(vertical.vertical && vertical.issues.has('vertical'));
  const type3 = createFont({ key: 't', subtype: 'Type3', fontMatrix: [0.001, 0, 0, 0.001, 0, 0], firstChar: 97, widths: [600], encoding: { differences: [[97, 'a']] } }, env);
  assert.ok(type3.issues.has('type3'));
  assert.equal(type3.planText('a').ok, false);
  // An embedded font without /Encoding or ToUnicode: its codes can't be read as text.
  const opaque = createFont({ key: 'o', subtype: 'Type1', baseFont: 'Custom', firstChar: 32, widths: [500], descriptor: { fontFile: 'FontFile3' } }, env);
  assert.equal(opaque.decode(bytes(' '))[0].unicode, null);
});

test('fallback fonts match the original style and refuse symbol/script fonts', () => {
  const make = (baseFont, flags, extra = {}) => createFont({ key: baseFont, subtype: 'TrueType', baseFont, firstChar: 32, widths: [500], descriptor: { flags, fontFile: 'FontFile2', ...extra } }, env);
  assert.equal(fallbackFontFor(make('Calibri-Bold', 32)).name, 'Helvetica-Bold');
  assert.equal(fallbackFontFor(make('Georgia-Italic', 32 | 2)).name, 'Times-Italic');
  assert.equal(fallbackFontFor(make('Consolas', 32 | 1)).name, 'Courier');
  assert.equal(fallbackFontFor(make('Garamond', 32, { weight: 700, italicAngle: -12 })).name, 'Times-BoldItalic');
  assert.equal(fallbackFontFor(make('Wingdings-Regular', 4)).name, null);
  assert.equal(fallbackFontFor(make('BrushScript', 8 | 32)).name, null);
  assert.deepEqual(charactersOutsideWinAnsi('Café € naïve', glyphs), []);
  assert.deepEqual(charactersOutsideWinAnsi('中文 हिन्दी', glyphs).length > 0, true);
});
