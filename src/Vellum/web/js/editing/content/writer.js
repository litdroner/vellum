// Writing PDF content-stream operands: the counterpart to content/lexer.js, which reads them.
// Numbers, names, strings, arrays and dictionaries go back out in the form a content stream wants,
// so a change can be written with exactly the values the page already used.

import { PdfName, PdfString } from './lexer.js';
import { EditError } from '../edits.js';

/** A number as a content stream wants it: four decimals at most, and never a negative zero. */
export function num(v) {
  if (!Number.isFinite(v)) throw new EditError('content', 'A number on the page couldn’t be written.');
  const r = Math.round(v * 10000) / 10000;
  return Object.is(r, -0) ? '0' : String(r);
}

export const hexString = (bytes) => `<${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}>`;

/** A name, with anything outside the printable ASCII a name may hold written as #xx. */
export function pdfName(name) {
  let out = '/';
  for (const ch of name) {
    const c = ch.charCodeAt(0);
    out += c < 0x21 || c > 0x7e || '#()<>[]{}/%'.includes(ch) ? `#${c.toString(16).padStart(2, '0')}` : ch;
  }
  return out;
}

/** Any operand the lexer produced, written back out (used to replay a page's own operators). */
export function operand(v) {
  if (typeof v === 'number') return num(v);
  if (v instanceof PdfName) return pdfName(v.name);
  if (v instanceof PdfString) return hexString(v.bytes);
  if (Array.isArray(v)) return `[${v.map(operand).join(' ')}]`;
  if (v instanceof Map) return `<<${[...v].map(([k, x]) => `${pdfName(k)} ${operand(x)}`).join(' ')}>>`;
  if (v === true || v === false) return String(v);
  return 'null';
}

export const ascii = (s) => Uint8Array.from(s, (c) => c.charCodeAt(0) & 0xff);

export function concat(parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}
