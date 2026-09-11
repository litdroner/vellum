// Glyph names and the simple-font encodings the editing engine needs to turn character codes into
// Unicode. WinAnsi, Symbol and ZapfDingbats (names and Unicode values) come from pdf-lib's bundled
// standard-font data; StandardEncoding, MacRoman and the extra names below are the PDF spec's
// tables. Names resolve the same way pdf.js resolves them, so the two can be cross-checked.

const ASCII = [
  'space', 'exclam', 'quotedbl', 'numbersign', 'dollar', 'percent', 'ampersand', 'quotesingle', 'parenleft', 'parenright',
  'asterisk', 'plus', 'comma', 'hyphen', 'period', 'slash', 'zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven',
  'eight', 'nine', 'colon', 'semicolon', 'less', 'equal', 'greater', 'question', 'at',
  ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
  'bracketleft', 'backslash', 'bracketright', 'asciicircum', 'underscore', 'grave',
  ...'abcdefghijklmnopqrstuvwxyz',
  'braceleft', 'bar', 'braceright', 'asciitilde',
]; // codes 32–126

function table(entries) {
  const out = new Array(256).fill(null);
  for (const [code, name] of entries) out[code] = name;
  return out;
}

const asciiEntries = (overrides = {}) => ASCII.map((name, i) => [32 + i, overrides[32 + i] ?? name]);

/** StandardEncoding (the built-in encoding of the standard Latin fonts). */
export const STANDARD_ENCODING = table([
  ...asciiEntries({ 39: 'quoteright', 96: 'quoteleft' }),
  [161, 'exclamdown'], [162, 'cent'], [163, 'sterling'], [164, 'fraction'], [165, 'yen'], [166, 'florin'], [167, 'section'],
  [168, 'currency'], [169, 'quotesingle'], [170, 'quotedblleft'], [171, 'guillemotleft'], [172, 'guilsinglleft'],
  [173, 'guilsinglright'], [174, 'fi'], [175, 'fl'], [177, 'endash'], [178, 'dagger'], [179, 'daggerdbl'],
  [180, 'periodcentered'], [182, 'paragraph'], [183, 'bullet'], [184, 'quotesinglbase'], [185, 'quotedblbase'],
  [186, 'quotedblright'], [187, 'guillemotright'], [188, 'ellipsis'], [189, 'perthousand'], [191, 'questiondown'],
  [193, 'grave'], [194, 'acute'], [195, 'circumflex'], [196, 'tilde'], [197, 'macron'], [198, 'breve'], [199, 'dotaccent'],
  [200, 'dieresis'], [202, 'ring'], [203, 'cedilla'], [205, 'hungarumlaut'], [206, 'ogonek'], [207, 'caron'], [208, 'emdash'],
  [225, 'AE'], [227, 'ordfeminine'], [232, 'Lslash'], [233, 'Oslash'], [234, 'OE'], [235, 'ordmasculine'], [241, 'ae'],
  [245, 'dotlessi'], [248, 'lslash'], [249, 'oslash'], [250, 'oe'], [251, 'germandbls'],
]);

const MAC_ROMAN_HIGH = [
  'Adieresis', 'Aring', 'Ccedilla', 'Eacute', 'Ntilde', 'Odieresis', 'Udieresis', 'aacute', 'agrave', 'acircumflex',
  'adieresis', 'atilde', 'aring', 'ccedilla', 'eacute', 'egrave', 'ecircumflex', 'edieresis', 'iacute', 'igrave',
  'icircumflex', 'idieresis', 'ntilde', 'oacute', 'ograve', 'ocircumflex', 'odieresis', 'otilde', 'uacute', 'ugrave',
  'ucircumflex', 'udieresis', 'dagger', 'degree', 'cent', 'sterling', 'section', 'bullet', 'paragraph', 'germandbls',
  'registered', 'copyright', 'trademark', 'acute', 'dieresis', 'notequal', 'AE', 'Oslash', 'infinity', 'plusminus',
  'lessequal', 'greaterequal', 'yen', 'mu', 'partialdiff', 'summation', 'product', 'pi', 'integral', 'ordfeminine',
  'ordmasculine', 'Omega', 'ae', 'oslash', 'questiondown', 'exclamdown', 'logicalnot', 'radical', 'florin', 'approxequal',
  'Delta', 'guillemotleft', 'guillemotright', 'ellipsis', 'space', 'Agrave', 'Atilde', 'Otilde', 'OE', 'oe', 'endash',
  'emdash', 'quotedblleft', 'quotedblright', 'quoteleft', 'quoteright', 'divide', 'lozenge', 'ydieresis', 'Ydieresis',
  'fraction', 'currency', 'guilsinglleft', 'guilsinglright', 'fi', 'fl', 'daggerdbl', 'periodcentered', 'quotesinglbase',
  'quotedblbase', 'perthousand', 'Acircumflex', 'Ecircumflex', 'Aacute', 'Edieresis', 'Egrave', 'Iacute', 'Icircumflex',
  'Idieresis', 'Igrave', 'Oacute', 'Ocircumflex', 'apple', 'Ograve', 'Uacute', 'Ucircumflex', 'Ugrave', 'dotlessi',
  'circumflex', 'tilde', 'macron', 'breve', 'dotaccent', 'ring', 'cedilla', 'hungarumlaut', 'ogonek', 'caron',
]; // codes 128–255

export const MAC_ROMAN_ENCODING = table([...asciiEntries(), ...MAC_ROMAN_HIGH.map((name, i) => [128 + i, name])]);

// Latin Extended-A (U+0100–U+017F) by their standard glyph names, in code point order.
const LATIN_EXTENDED_A = [
  'Amacron', 'amacron', 'Abreve', 'abreve', 'Aogonek', 'aogonek', 'Cacute', 'cacute', 'Ccircumflex', 'ccircumflex',
  'Cdotaccent', 'cdotaccent', 'Ccaron', 'ccaron', 'Dcaron', 'dcaron', 'Dcroat', 'dcroat', 'Emacron', 'emacron', 'Ebreve',
  'ebreve', 'Edotaccent', 'edotaccent', 'Eogonek', 'eogonek', 'Ecaron', 'ecaron', 'Gcircumflex', 'gcircumflex', 'Gbreve',
  'gbreve', 'Gdotaccent', 'gdotaccent', 'Gcommaaccent', 'gcommaaccent', 'Hcircumflex', 'hcircumflex', 'Hbar', 'hbar',
  'Itilde', 'itilde', 'Imacron', 'imacron', 'Ibreve', 'ibreve', 'Iogonek', 'iogonek', 'Idotaccent', 'dotlessi', 'IJ', 'ij',
  'Jcircumflex', 'jcircumflex', 'Kcommaaccent', 'kcommaaccent', 'kgreenlandic', 'Lacute', 'lacute', 'Lcommaaccent',
  'lcommaaccent', 'Lcaron', 'lcaron', 'Ldot', 'ldot', 'Lslash', 'lslash', 'Nacute', 'nacute', 'Ncommaaccent', 'ncommaaccent',
  'Ncaron', 'ncaron', 'napostrophe', 'Eng', 'eng', 'Omacron', 'omacron', 'Obreve', 'obreve', 'Ohungarumlaut',
  'ohungarumlaut', 'OE', 'oe', 'Racute', 'racute', 'Rcommaaccent', 'rcommaaccent', 'Rcaron', 'rcaron', 'Sacute', 'sacute',
  'Scircumflex', 'scircumflex', 'Scedilla', 'scedilla', 'Scaron', 'scaron', 'Tcommaaccent', 'tcommaaccent', 'Tcaron',
  'tcaron', 'Tbar', 'tbar', 'Utilde', 'utilde', 'Umacron', 'umacron', 'Ubreve', 'ubreve', 'Uring', 'uring', 'Uhungarumlaut',
  'uhungarumlaut', 'Uogonek', 'uogonek', 'Wcircumflex', 'wcircumflex', 'Ycircumflex', 'ycircumflex', 'Ydieresis', 'Zacute',
  'zacute', 'Zdotaccent', 'zdotaccent', 'Zcaron', 'zcaron', 'longs',
];

// Standard glyph names outside WinAnsi / Symbol / Dingbats that simple fonts commonly use.
const EXTRA_NAMES = {
  fi: 0xfb01, fl: 0xfb02, ff: 0xfb00, ffi: 0xfb03, ffl: 0xfb04, fraction: 0x2044, minus: 0x2212,
  notequal: 0x2260, infinity: 0x221e, lessequal: 0x2264, greaterequal: 0x2265, partialdiff: 0x2202, summation: 0x2211,
  product: 0x220f, pi: 0x03c0, integral: 0x222b, Omega: 0x2126, radical: 0x221a, approxequal: 0x2248, Delta: 0x2206,
  lozenge: 0x25ca, apple: 0xf8ff, breve: 0x02d8, dotaccent: 0x02d9, ring: 0x02da, ogonek: 0x02db, hungarumlaut: 0x02dd,
  caron: 0x02c7, nbspace: 0x00a0, nonbreakingspace: 0x00a0, sfthyphen: 0x00ad, softhyphen: 0x00ad, middot: 0x00b7,
  Cdot: 0x010a, cdot: 0x010b, Edot: 0x0116, edot: 0x0117, Gdot: 0x0120, gdot: 0x0121, Idot: 0x0130, Zdot: 0x017b,
  zdot: 0x017c, Dslash: 0x0110, dmacron: 0x0111, Gcedilla: 0x0122, gcedilla: 0x0123, Kcedilla: 0x0136, kcedilla: 0x0137,
  Lcedilla: 0x013b, lcedilla: 0x013c, Ncedilla: 0x0145, ncedilla: 0x0146, Rcedilla: 0x0156, rcedilla: 0x0157,
  Tcedilla: 0x0162, tcedilla: 0x0163, Odblacute: 0x0150, odblacute: 0x0151, Udblacute: 0x0170, udblacute: 0x0171,
  Scommaaccent: 0x0218, scommaaccent: 0x0219,
};

/**
 * Builds the glyph tables from pdf-lib (call once; the result is plain data):
 *   encodings.WinAnsi / MacRoman / Standard / Symbol / ZapfDingbats: code → glyph name
 *   unicodeOf(name): the Unicode string for a glyph name, or null (same rules as pdf.js)
 */
export function buildGlyphData(lib) {
  const names = new Map();
  const add = (name, codePoint) => { if (name && !names.has(name)) names.set(name, codePoint); };
  const fromPdfLib = (fontName) => {
    const out = new Array(256).fill(null);
    const mappings = lib.StandardFontEmbedder.for(fontName).encoding.unicodeMappings;
    for (const cp of Object.keys(mappings).map(Number).sort((a, b) => a - b)) {
      const [code, name] = mappings[cp];
      if (out[code] === null) out[code] = name;
      add(name, cp);
    }
    return out;
  };
  const winAnsi = fromPdfLib(lib.StandardFonts.Helvetica);
  const symbol = fromPdfLib(lib.StandardFonts.Symbol);
  const dingbats = fromPdfLib(lib.StandardFonts.ZapfDingbats);
  ASCII.forEach((name, i) => add(name, 32 + i));
  LATIN_EXTENDED_A.forEach((name, i) => add(name, 0x100 + i));
  for (const [name, cp] of Object.entries(EXTRA_NAMES)) add(name, cp);
  add('quoteleft', 0x2018);
  add('quoteright', 0x2019);

  return {
    encodings: { WinAnsi: winAnsi, MacRoman: MAC_ROMAN_ENCODING, Standard: STANDARD_ENCODING, Symbol: symbol, ZapfDingbats: dingbats },
    unicodeOf(name) {
      const cp = codePointOfGlyph(name, names);
      return cp >= 0 ? String.fromCodePoint(cp) : null;
    },
  };
}

/** Mirrors pdf.js's getUnicodeForGlyph: a known name, or 'uniXXXX' / 'uXXXX'–'uXXXXXX' in upper-case hex. */
function codePointOfGlyph(name, names) {
  if (!name) return -1;
  const known = names.get(name);
  if (known !== undefined) return known;
  if (name[0] !== 'u') return -1;
  let hex;
  if (name.length === 7 && name[1] === 'n' && name[2] === 'i') hex = name.slice(3);
  else if (name.length >= 5 && name.length <= 7) hex = name.slice(1);
  else return -1;
  if (hex !== hex.toUpperCase() || !/^[0-9A-F]+$/.test(hex)) return -1;
  const cp = parseInt(hex, 16);
  return cp >= 0 && cp <= 0x10ffff ? cp : -1;
}
