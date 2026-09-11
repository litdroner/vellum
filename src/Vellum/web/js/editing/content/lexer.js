// Content-stream tokenizer: turns the bytes of a PDF content stream (or a CMap, which uses the same
// syntax) into operators with their operands and byte ranges. It only reads; nothing is changed.
//
//   lex(bytes) → { ops: [{ op: 'Tj', args: [PdfString], start, end }, ...], trailing }
//
// `start` is where the operator's first operand begins and `end` is just past the operator itself,
// so an operator can later be replaced in place without disturbing a single byte around it.
// Inline images (BI … ID … EI) come back as one 'BI' operator carrying the image dictionary and the
// byte range of the raw image data. Anything malformed throws ContentSyntaxError: a page we can't
// read completely is never edited.

export class PdfName {
  constructor(name) { this.name = name; }
}

export class PdfString {
  /** bytes: the string's bytes with escapes resolved; hex: it was written as <…>. */
  constructor(bytes, hex = false) {
    this.bytes = bytes;
    this.hex = hex;
  }
}

export class ContentSyntaxError extends Error {
  constructor(message, offset) {
    super(`${message} (at byte ${offset})`);
    this.name = 'ContentSyntaxError';
    this.offset = offset;
  }
}

const WHITESPACE = 1;
const DELIMITER = 2;
const CLASS = new Uint8Array(256);
for (const c of [0x00, 0x09, 0x0a, 0x0c, 0x0d, 0x20]) CLASS[c] = WHITESPACE;
for (const c of '()<>[]{}/%') CLASS[c.charCodeAt(0)] = DELIMITER;

const HEX = new Int8Array(256).fill(-1);
for (let i = 0; i < 16; i++) {
  HEX['0123456789abcdef'.charCodeAt(i)] = i;
  HEX['0123456789ABCDEF'.charCodeAt(i)] = i;
}

const NUMBER_START = new Uint8Array(256);
for (const c of '0123456789+-.') NUMBER_START[c.charCodeAt(0)] = 1;

const MAX_NESTING = 64;
const ascii = (bytes, from, to) => String.fromCharCode.apply(null, bytes.subarray(from, to));

export function lex(bytes) {
  const n = bytes.length;
  let pos = 0;
  const ops = [];
  let args = [];
  let argsStart = -1;

  const fail = (message, at = pos) => { throw new ContentSyntaxError(message, at); };

  function skipSpace() {
    while (pos < n) {
      const c = bytes[pos];
      if (CLASS[c] === WHITESPACE) {
        pos++;
      } else if (c === 0x25 /* % comment */) {
        while (pos < n && bytes[pos] !== 0x0a && bytes[pos] !== 0x0d) pos++;
      } else {
        return;
      }
    }
  }

  /** One token at `pos`: { value } for an operand, { keyword } for an operator. */
  function readToken(depth) {
    const c = bytes[pos];
    if (c === 0x28 /* ( */) return { value: readLiteralString() };
    if (c === 0x3c /* < */) return { value: bytes[pos + 1] === 0x3c ? readDictionary(depth) : readHexString() };
    if (c === 0x5b /* [ */) return { value: readArray(depth) };
    if (c === 0x2f /* / */) return { value: readName() };
    if (c === 0x7b || c === 0x7d /* { } (CMaps, procedures) */) {
      pos++;
      return { keyword: String.fromCharCode(c) };
    }
    if (CLASS[c] === DELIMITER) fail(`Unexpected "${String.fromCharCode(c)}"`);
    if (NUMBER_START[c]) return { value: readNumber() };
    const start = pos;
    while (pos < n && CLASS[bytes[pos]] === 0) pos++;
    const word = ascii(bytes, start, pos);
    if (word === 'true') return { value: true };
    if (word === 'false') return { value: false };
    if (word === 'null') return { value: null };
    return { keyword: word };
  }

  function readValue(depth) {
    const at = pos;
    const token = readToken(depth);
    if (token.keyword !== undefined) fail(`Operator "${token.keyword}" where a value was expected`, at);
    return token.value;
  }

  function readNumber() {
    const start = pos;
    while (pos < n && NUMBER_START[bytes[pos]]) pos++;
    // Some producers write exponents (1.5e-05); pdf.js accepts them, so do we.
    if (pos < n && (bytes[pos] === 0x65 || bytes[pos] === 0x45) && pos > start && bytes[pos - 1] >= 0x30 && bytes[pos - 1] <= 0x39) {
      let p = pos + 1;
      if (bytes[p] === 0x2b || bytes[p] === 0x2d) p++;
      if (bytes[p] >= 0x30 && bytes[p] <= 0x39) {
        while (p < n && bytes[p] >= 0x30 && bytes[p] <= 0x39) p++;
        pos = p;
      }
    }
    if (pos < n && CLASS[bytes[pos]] === 0) fail('Malformed number', start);
    const text = ascii(bytes, start, pos);
    const value = Number(text);
    if (!Number.isFinite(value)) fail(`Malformed number "${text}"`, start);
    return value;
  }

  function readName() {
    pos++; // '/'
    let name = '';
    while (pos < n && CLASS[bytes[pos]] === 0) {
      const c = bytes[pos];
      if (c === 0x23 /* # */ && HEX[bytes[pos + 1]] >= 0 && HEX[bytes[pos + 2]] >= 0) {
        name += String.fromCharCode(HEX[bytes[pos + 1]] * 16 + HEX[bytes[pos + 2]]);
        pos += 3;
      } else {
        name += String.fromCharCode(c);
        pos++;
      }
    }
    return new PdfName(name);
  }

  function readLiteralString() {
    const start = pos;
    pos++; // '('
    const out = [];
    let depth = 1;
    while (pos < n) {
      const c = bytes[pos++];
      if (c === 0x5c /* \ */) {
        if (pos >= n) break;
        const e = bytes[pos++];
        switch (e) {
          case 0x6e: out.push(0x0a); break; // \n
          case 0x72: out.push(0x0d); break; // \r
          case 0x74: out.push(0x09); break; // \t
          case 0x62: out.push(0x08); break; // \b
          case 0x66: out.push(0x0c); break; // \f
          case 0x0d: if (bytes[pos] === 0x0a) pos++; break; // line continuation
          case 0x0a: break;
          default:
            if (e >= 0x30 && e <= 0x37) {
              let v = e - 0x30;
              for (let k = 0; k < 2 && bytes[pos] >= 0x30 && bytes[pos] <= 0x37; k++) v = v * 8 + (bytes[pos++] - 0x30);
              out.push(v & 0xff);
            } else {
              out.push(e); // \( \) \\ and unknown escapes: the character itself
            }
        }
        continue;
      }
      if (c === 0x28) depth++;
      else if (c === 0x29 && --depth === 0) return new PdfString(Uint8Array.from(out), false);
      if (c === 0x0d) {
        // An unescaped end of line inside a string is read as a single \n.
        out.push(0x0a);
        if (bytes[pos] === 0x0a) pos++;
        continue;
      }
      out.push(c);
    }
    return fail('Unterminated string', start);
  }

  function readHexString() {
    const start = pos;
    pos++; // '<'
    const out = [];
    let high = -1;
    while (pos < n) {
      const c = bytes[pos++];
      if (c === 0x3e /* > */) {
        if (high >= 0) out.push(high << 4); // an odd final digit is followed by an implied 0
        return new PdfString(Uint8Array.from(out), true);
      }
      if (CLASS[c] === WHITESPACE) continue;
      const v = HEX[c];
      if (v < 0) fail('Invalid character in hex string', pos - 1);
      if (high < 0) high = v;
      else {
        out.push((high << 4) | v);
        high = -1;
      }
    }
    return fail('Unterminated hex string', start);
  }

  function readArray(depth) {
    if (depth >= MAX_NESTING) fail('Arrays nested too deeply');
    const start = pos;
    pos++; // '['
    const items = [];
    for (;;) {
      skipSpace();
      if (pos >= n) fail('Unterminated array', start);
      if (bytes[pos] === 0x5d /* ] */) {
        pos++;
        return items;
      }
      items.push(readValue(depth + 1));
    }
  }

  function readDictionary(depth) {
    if (depth >= MAX_NESTING) fail('Dictionaries nested too deeply');
    const start = pos;
    pos += 2; // '<<'
    const dict = new Map();
    for (;;) {
      skipSpace();
      if (pos >= n) fail('Unterminated dictionary', start);
      if (bytes[pos] === 0x3e && bytes[pos + 1] === 0x3e) {
        pos += 2;
        return dict;
      }
      const key = readValue(depth + 1);
      if (!(key instanceof PdfName)) fail('Dictionary key is not a name');
      skipSpace();
      if (pos >= n) fail('Unterminated dictionary', start);
      dict.set(key.name, readValue(depth + 1));
    }
  }

  /** BI <key value …> ID <data> EI — kept as one operator; the data is never interpreted. */
  function readInlineImage(start) {
    const dict = new Map();
    for (;;) {
      skipSpace();
      if (pos >= n) fail('Unterminated inline image', start);
      const at = pos;
      const token = readToken(1);
      if (token.keyword === 'ID') break;
      if (token.keyword !== undefined || !(token.value instanceof PdfName)) fail('Malformed inline image dictionary', at);
      skipSpace();
      dict.set(token.value.name, readValue(1));
    }
    if (pos < n && CLASS[bytes[pos]] === WHITESPACE) pos++; // the single space after ID
    const dataStart = pos;
    // The data's length: declared (PDF 2.0), or computed for an unfiltered image — binary image data
    // may well contain "EI", so knowing the length beats searching for it.
    const declared = dict.get('L') ?? dict.get('Length') ?? unfilteredLength(dict);
    let dataEnd = -1;
    if (Number.isInteger(declared) && declared >= 0 && dataStart + declared <= n) {
      pos = dataStart + declared;
      skipSpace();
      if (bytes[pos] === 0x45 && bytes[pos + 1] === 0x49 && (pos + 2 >= n || CLASS[bytes[pos + 2]] !== 0)) dataEnd = dataStart + declared;
    }
    if (dataEnd < 0) {
      dataEnd = findInlineImageEnd(dataStart);
      if (dataEnd < 0) fail('Inline image without EI', start);
      pos = dataEnd;
      skipSpace();
    }
    pos += 2; // 'EI'
    ops.push({ op: 'BI', args: [dict], data: { start: dataStart, end: dataEnd }, start, end: pos });
  }

  /**
   * Finds where raw inline image data ends: an "EI" preceded by white space and followed by white
   * space (or the end), after which the stream looks like text again (so image bytes that happen
   * to contain "EI" aren't mistaken for the end).
   */
  function findInlineImageEnd(from) {
    for (let i = from; i + 1 < n; i++) {
      if (bytes[i] !== 0x45 || bytes[i + 1] !== 0x49) continue;
      if (i > from && CLASS[bytes[i - 1]] !== WHITESPACE) continue;
      if (i + 2 < n && CLASS[bytes[i + 2]] !== WHITESPACE) continue;
      let plausible = true;
      for (let j = i + 2; j < Math.min(n, i + 2 + 32); j++) {
        const c = bytes[j];
        if (c > 0x7e || (c < 0x20 && CLASS[c] !== WHITESPACE)) {
          plausible = false;
          break;
        }
      }
      if (plausible) return i > from && CLASS[bytes[i - 1]] === WHITESPACE ? i - 1 : i;
    }
    return -1;
  }

  for (;;) {
    skipSpace();
    if (pos >= n) break;
    const tokenStart = pos;
    const token = readToken(0);
    if (token.keyword === undefined) {
      if (argsStart < 0) argsStart = tokenStart;
      args.push(token.value);
      continue;
    }
    if (token.keyword === 'BI') {
      if (args.length) fail('Operands before an inline image', argsStart);
      readInlineImage(tokenStart);
      continue;
    }
    ops.push({ op: token.keyword, args, start: argsStart >= 0 ? argsStart : tokenStart, end: pos });
    args = [];
    argsStart = -1;
  }
  // Operands left without an operator are ignored by viewers; report how many there were.
  return { ops, trailing: args.length };
}

const COMPONENTS = { G: 1, DeviceGray: 1, RGB: 3, DeviceRGB: 3, CMYK: 4, DeviceCMYK: 4, I: 1, Indexed: 1 };

/** Byte length of an inline image without filters, from its dictionary; null when it can't be known. */
function unfilteredLength(dict) {
  if (dict.has('F') || dict.has('Filter')) return null;
  const width = dict.get('W') ?? dict.get('Width');
  const height = dict.get('H') ?? dict.get('Height');
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) return null;
  const mask = dict.get('IM') ?? dict.get('ImageMask');
  let bpc = dict.get('BPC') ?? dict.get('BitsPerComponent');
  let components;
  if (mask === true) {
    components = 1;
    bpc = 1;
  } else {
    const cs = dict.get('CS') ?? dict.get('ColorSpace');
    const name = cs instanceof PdfName ? cs.name : Array.isArray(cs) && cs[0] instanceof PdfName ? cs[0].name : null;
    components = COMPONENTS[name];
  }
  if (!components || ![1, 2, 4, 8, 16].includes(bpc)) return null;
  return Math.ceil((width * components * bpc) / 8) * height;
}

/** The bytes of a PdfString operand as a big-endian integer (for CMap codes). */
export function bytesToCode(bytes) {
  let code = 0;
  for (const b of bytes) code = code * 256 + b;
  return code;
}
