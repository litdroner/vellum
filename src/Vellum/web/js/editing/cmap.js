// CMaps: the tables that split a composite font's string into character codes (codespace ranges),
// map codes to CIDs, and — for ToUnicode CMaps — map codes to Unicode text. Parsed with the content
// lexer (CMaps use the same PostScript-like syntax). Behaviour mirrors pdf.js where it matters, so
// both read a string the same way.

import { lex, PdfName, PdfString, bytesToCode } from './content/lexer.js';

const MAX_ENTRIES = 1 << 17; // generous for real CMaps; a larger table is treated as unsupported

export class CMapError extends Error {}

/**
 *   codespace: [[length, low, high], ...]    code ranges by byte length (1–4)
 *   unicode:   Map code → string             (ToUnicode: bfchar / bfrange)
 *   cids:      Map code → CID                (encoding CMaps: cidchar / cidrange)
 *   vertical:  true for WMode 1
 *   usecmap:   name of a CMap this one builds on (not supported), or null
 */
export function parseCMap(bytes) {
  const { ops } = lex(bytes);
  const codespace = [];
  const unicode = new Map();
  const cids = new Map();
  let vertical = false;
  let usecmap = null;
  let entries = 0;
  const count = (n) => {
    entries += n;
    if (entries > MAX_ENTRIES) throw new CMapError('CMap too large');
  };

  for (const { op, args } of ops) {
    switch (op) {
      case 'endcodespacerange':
        for (let i = 0; i + 1 < args.length; i += 2) {
          const low = args[i];
          const high = args[i + 1];
          if (!(low instanceof PdfString) || !(high instanceof PdfString)) continue;
          const length = low.bytes.length;
          if (length < 1 || length > 4 || high.bytes.length !== length) continue;
          codespace.push([length, bytesToCode(low.bytes), bytesToCode(high.bytes)]);
        }
        break;
      case 'endbfchar':
        for (let i = 0; i + 1 < args.length; i += 2) {
          const src = args[i];
          if (!(src instanceof PdfString)) continue;
          const text = destination(args[i + 1]);
          if (text !== null) {
            count(1);
            unicode.set(bytesToCode(src.bytes), text);
          }
        }
        break;
      case 'endbfrange':
        for (let i = 0; i + 2 < args.length; i += 3) {
          const [low, high, dst] = [args[i], args[i + 1], args[i + 2]];
          if (!(low instanceof PdfString) || !(high instanceof PdfString)) continue;
          const lo = bytesToCode(low.bytes);
          const hi = bytesToCode(high.bytes);
          if (hi < lo) continue;
          count(hi - lo + 1);
          if (Array.isArray(dst)) {
            for (let code = lo, k = 0; code <= hi && k < dst.length; code++, k++) {
              const text = destination(dst[k]);
              if (text !== null) unicode.set(code, text);
            }
          } else if (dst instanceof PdfString) {
            mapRange(unicode, lo, hi, dst.bytes);
          }
        }
        break;
      case 'endcidchar':
        for (let i = 0; i + 1 < args.length; i += 2) {
          if (args[i] instanceof PdfString && Number.isInteger(args[i + 1])) {
            count(1);
            cids.set(bytesToCode(args[i].bytes), args[i + 1]);
          }
        }
        break;
      case 'endcidrange':
        for (let i = 0; i + 2 < args.length; i += 3) {
          const [low, high, start] = [args[i], args[i + 1], args[i + 2]];
          if (!(low instanceof PdfString) || !(high instanceof PdfString) || !Number.isInteger(start)) continue;
          const lo = bytesToCode(low.bytes);
          const hi = bytesToCode(high.bytes);
          if (hi < lo) continue;
          count(hi - lo + 1);
          for (let code = lo; code <= hi; code++) cids.set(code, start + (code - lo));
        }
        break;
      case 'def':
        if (args[0] instanceof PdfName && args[0].name === 'WMode' && args[1] === 1) vertical = true;
        break;
      case 'usecmap':
        if (args[0] instanceof PdfName) usecmap = args[0].name;
        break;
      default:
        break;
    }
  }
  return { codespace, unicode, cids, vertical, usecmap };
}

/** A bfchar / bfrange destination as text: UTF-16BE bytes (as pdf.js reads them). */
function destination(value) {
  if (value instanceof PdfString) return utf16(value.bytes);
  if (Number.isInteger(value) && value >= 0 && value <= 0x10ffff) return String.fromCodePoint(value);
  return null;
}

function utf16(bytes) {
  let b = bytes;
  if (b.length % 2 !== 0) b = Uint8Array.from([0, ...b]); // pdf.js restores an omitted leading zero
  const points = [];
  for (let k = 0; k + 1 < b.length; k += 2) {
    const w1 = (b[k] << 8) | b[k + 1];
    if ((w1 & 0xf800) !== 0xd800 || k + 3 >= b.length) {
      points.push(w1);
      continue;
    }
    k += 2;
    const w2 = (b[k] << 8) | b[k + 1];
    points.push(((w1 & 0x3ff) << 10) + (w2 & 0x3ff) + 0x10000);
  }
  return String.fromCodePoint(...points);
}

/** bfrange with a string destination: each next code maps to the destination with its last byte + 1. */
function mapRange(map, lo, hi, first) {
  const dst = Array.from(first);
  const last = dst.length - 1;
  for (let code = lo; code <= hi; code++) {
    map.set(code, utf16(Uint8Array.from(dst)));
    if (last < 0) continue;
    if (dst[last] === 0xff && last > 0) {
      // Like pdf.js: carry into the previous byte.
      dst[last - 1]++;
      dst[last] = 0;
    } else {
      dst[last]++;
    }
  }
}

/** The built-in Identity CMap: two-byte codes, CID = code. */
export const IDENTITY_CMAP = Object.freeze({
  codespace: [[2, 0, 0xffff]],
  unicode: new Map(),
  cids: null, // identity
  vertical: false,
  usecmap: null,
});

/**
 * Reads the next character code from `bytes` at `offset`, like pdf.js's CMap.readCharCode: the
 * shortest byte sequence that falls inside a codespace range. An unmatched byte reads as code 0 of
 * length 1 (and is flagged, so text containing it is never edited).
 */
export function readCharCode(codespace, bytes, offset) {
  let code = 0;
  for (let length = 1; length <= 4; length++) {
    if (offset + length > bytes.length) break;
    code = code * 256 + bytes[offset + length - 1];
    for (const [len, lo, hi] of codespace) {
      if (len === length && code >= lo && code <= hi) return { code, length, matched: true };
    }
  }
  return { code: 0, length: 1, matched: false };
}
