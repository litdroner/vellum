// Font models for the editing engine: how a font's character codes become widths and Unicode text
// (decode), and — conservatively — which text could be written back in the same font (planText).
// Built from a plain description of the font dictionary (see source.js), so no pdf-lib here.
//
// Supported for reading: simple fonts (Type 1, TrueType; Type 3 for positions only) and composite
// (Type 0) fonts with Identity-H or an embedded CMap. Anything else is still measured where
// possible but flagged, so text in it is never offered for editing.

import { parseCMap, IDENTITY_CMAP, readCharCode } from './cmap.js';

const FLAG = { fixedPitch: 1, serif: 2, symbolic: 4, script: 8, nonsymbolic: 32, italic: 64, forceBold: 1 << 18 };

const STANDARD_FAMILIES = {
  helvetica: 'Helvetica', arial: 'Helvetica', arialmt: 'Helvetica',
  times: 'Times', timesroman: 'Times', timesnewroman: 'Times', timesnewromanps: 'Times', timesnewromanpsmt: 'Times',
  courier: 'Courier', couriernew: 'Courier', couriernewps: 'Courier', couriernewpsmt: 'Courier',
  symbol: 'Symbol', zapfdingbats: 'ZapfDingbats', dingbats: 'ZapfDingbats',
};

const SYMBOL_NAMES = /symbol|dingbat|wingding|webding|marlett|bookshelf/i;
const SERIF_NAMES = /times|serif|roman|georgia|garamond|cambria|minion|caslon|palatino|baskerville|bodoni|century|didot|goudy|constantia|book ?antiqua|charter/i;
const MONO_NAMES = /courier|mono|consol|menlo|typewriter|lucidaconsole/i;
const BOLD_NAMES = /bold|black|heavy|semibold|demi/i;
const ITALIC_NAMES = /italic|oblique/i;

const ENCODING_NAMES = { WinAnsiEncoding: 'WinAnsi', MacRomanEncoding: 'MacRoman', StandardEncoding: 'Standard' };

const subsetTag = /^[A-Z]{6}\+/;

/** The standard-14 font a font name refers to (Arial → Helvetica, …), or null. */
export function standardFontName(baseFont) {
  if (!baseFont) return null;
  const clean = baseFont.replace(subsetTag, '').replace(/\s+/g, '');
  const match = /^([^,-]+)[,-]?(.*)$/.exec(clean);
  const family = match && STANDARD_FAMILIES[match[1].toLowerCase()];
  if (!family) return null;
  if (family === 'Symbol' || family === 'ZapfDingbats') return family;
  const style = match[2].toLowerCase();
  const bold = /bold|black|heavy/.test(style);
  const italic = /italic|oblique/.test(style);
  if (family === 'Times') return bold && italic ? 'Times-BoldItalic' : bold ? 'Times-Bold' : italic ? 'Times-Italic' : 'Times-Roman';
  return family + (bold && italic ? '-BoldOblique' : bold ? '-Bold' : italic ? '-Oblique' : '');
}

/**
 * env: { glyphs: buildGlyphData(lib), standardMetrics(name) → { widthOf(glyphName), ascent, descent, bbox } }
 */
export function createFont(desc, env) {
  return new FontModel(desc, env);
}

export class FontModel {
  /** code → { unicode, width, inFont, byteLength }: codes pdf.js drew exactly as we read them. */
  verified = new Map();
  /** Codes where we and pdf.js disagreed; never used for writing. */
  conflicts = new Set();
  issues = new Set();

  #toUnicode = null;
  #codeToName = null;
  #widths = null;
  #firstChar = 0;
  #missingWidth = 0;
  #metrics = null;
  #cmap = null;
  #cidWidths = null;
  #defaultWidth = 1000;
  #glyphs;
  #table = null;

  constructor(desc, env) {
    this.key = desc.key;
    this.subtype = desc.subtype ?? null;
    this.kind = desc.subtype === 'Type0' ? 'type0' : desc.subtype === 'Type3' ? 'type3' : 'simple';
    const descriptor = (this.kind === 'type0' ? desc.descendant?.descriptor : desc.descriptor) ?? null;
    this.baseFont = desc.baseFont ?? desc.descendant?.baseFont ?? null;
    this.name = (this.baseFont ?? '').replace(subsetTag, '');
    this.subset = subsetTag.test(this.baseFont ?? '');
    this.embedded = this.kind === 'type3' || Boolean(descriptor?.fontFile);
    this.standard = this.embedded ? null : standardFontName(this.name);
    this.#glyphs = env.glyphs;
    this.vertical = false;
    this.widthScale = 0.001;
    this.flags = describeFlags(descriptor, this.name);
    this.symbolFont = SYMBOL_NAMES.test(this.name) || this.standard === 'Symbol' || this.standard === 'ZapfDingbats';
    if (this.symbolFont) this.issues.add('symbol-font');

    if (desc.toUnicode) {
      try {
        this.#toUnicode = parseCMap(desc.toUnicode).unicode;
      } catch {
        this.issues.add('tounicode');
      }
    }

    if (this.kind === 'type0') this.#initComposite(desc);
    else this.#initSimple(desc, env);

    this.#initMetrics(desc, descriptor);
  }

  // ---- reading ---------------------------------------------------------------------

  /** Splits a string's bytes into glyphs: { code, byteStart, byteLength, unicode, width }. */
  decode(bytes) {
    const out = [];
    if (this.kind !== 'type0') {
      for (let i = 0; i < bytes.length; i++) {
        const code = bytes[i];
        out.push({ code, byteStart: i, byteLength: 1, unicode: this.unicodeOf(code), width: this.widthOf(code) });
      }
      return out;
    }
    if (!this.#cmap) {
      // An unsupported CMap: we can't even tell where one character ends.
      for (let i = 0; i < bytes.length; i++) out.push({ code: bytes[i], byteStart: i, byteLength: 1, unicode: null, width: null });
      return out;
    }
    for (let i = 0; i < bytes.length;) {
      const { code, length, matched } = readCharCode(this.#cmap.codespace, bytes, i);
      out.push({
        code, byteStart: i, byteLength: length,
        unicode: matched ? this.unicodeOf(code) : null,
        width: matched ? this.widthOf(code) : null,
      });
      i += length;
    }
    return out;
  }

  unicodeOf(code) {
    const mapped = this.#toUnicode?.get(code);
    if (mapped !== undefined) return mapped;
    if (this.kind === 'type0') return null; // no ToUnicode entry: we don't guess from CIDs
    const name = this.#codeToName?.[code];
    return name ? this.#glyphs.unicodeOf(name) : null;
  }

  /** The raw width (as written in the font's width table; ×widthScale gives text-space units). */
  widthOf(code) {
    if (this.kind === 'type0') {
      const cid = this.#cmap?.cids ? this.#cmap.cids.get(code) : code;
      if (cid === undefined) return null;
      return this.#cidWidths.get(cid) ?? this.#defaultWidth;
    }
    if (this.#widths) {
      const i = code - this.#firstChar;
      const w = i >= 0 && i < this.#widths.length ? this.#widths[i] : this.#missingWidth;
      return typeof w === 'number' && Number.isFinite(w) ? w : this.#missingWidth;
    }
    if (this.#metrics) {
      const name = this.#codeToName?.[code];
      const w = name ? this.#metrics.widthOf(name) : undefined;
      return typeof w === 'number' ? w : null;
    }
    return null;
  }

  // ---- pdf.js cross-check bookkeeping ------------------------------------------------

  noteVerified(code, info) {
    if (this.conflicts.has(code)) return;
    this.verified.set(code, info);
    this.#table = null;
  }

  noteConflict(code) {
    this.conflicts.add(code);
    this.verified.delete(code);
    this.#table = null;
  }

  // ---- writing (conservative) ----------------------------------------------------------

  /**
   * How `text` could be written with this font's own glyphs, without guessing:
   *   { ok, items: [{ code, byteLength, width, text } | { space: true, text }], missing: [chars] }
   * A character is writable only if pdf.js drew that exact code with that exact meaning somewhere
   * in the document and the glyph really is in the font (proven present), or — for fonts the
   * viewer supplies itself (not embedded) — if the font's encoding has it with a real width.
   * White space that the font can't draw is returned as { space } and becomes a gap.
   */
  planText(text) {
    if (this.kind === 'type3') return { ok: false, reason: 'type3', items: [], missing: [] };
    if (this.vertical) return { ok: false, reason: 'vertical', items: [], missing: [] };
    if (this.symbolFont) return { ok: false, reason: 'symbol-font', items: [], missing: [] };
    const table = this.#writableTable();
    const chars = Array.from(text.normalize('NFC'));
    const items = [];
    const missing = new Set();
    for (let i = 0; i < chars.length;) {
      let hit = null;
      let used = 0;
      for (let len = Math.min(3, chars.length - i); len >= 1 && !hit; len--) {
        const found = table.get(chars.slice(i, i + len).join(''));
        if (found) {
          hit = found;
          used = len;
        }
      }
      if (hit) {
        items.push({ ...hit, text: chars.slice(i, i + used).join('') });
        i += used;
      } else if (/^\s$/u.test(chars[i])) {
        items.push({ space: true, text: chars[i] });
        i++;
      } else {
        missing.add(chars[i]);
        i++;
      }
    }
    return { ok: missing.size === 0, items, missing: [...missing] };
  }

  #writableTable() {
    if (this.#table) return this.#table;
    const table = new Map();
    const consider = (code, unicode, width, byteLength) => {
      if (!unicode || this.conflicts.has(code) || table.has(unicode)) return;
      const blank = /^\s+$/u.test(unicode);
      if (!blank && !(width > 0)) return; // a zero-width glyph isn't a usable character
      table.set(unicode, { code, width, byteLength });
    };
    for (const [code, v] of this.verified) {
      if (v.inFont !== false) consider(code, v.unicode, v.width, v.byteLength);
    }
    // A font the viewer supplies itself has every glyph its encoding names (at a known width).
    if (!this.embedded && this.kind === 'simple' && this.#codeToName && this.verified.size) {
      for (let code = 32; code < 256; code++) consider(code, this.unicodeOf(code), this.widthOf(code), 1);
    }
    this.#table = table;
    return table;
  }

  // ---- setup -------------------------------------------------------------------------

  #initSimple(desc, env) {
    if (this.kind === 'type3') {
      this.issues.add('type3');
      const m = desc.fontMatrix;
      this.widthScale = Array.isArray(m) && Number.isFinite(m[0]) && m[0] ? m[0] : 0.001;
    }
    this.#firstChar = Number.isInteger(desc.firstChar) ? desc.firstChar : 0;
    this.#widths = Array.isArray(desc.widths) ? desc.widths : null;
    this.#missingWidth = numberOr(desc.descriptor?.missingWidth, 0);
    if (!this.#widths && this.standard && this.kind !== 'type3') this.#metrics = env.standardMetrics(this.standard);
    if (!this.#widths && !this.#metrics) this.issues.add('metrics');
    this.#codeToName = this.#simpleEncoding(desc);
  }

  /** code → glyph name for a simple font, or null when its encoding lives only inside the font program. */
  #simpleEncoding(desc) {
    const { encodings } = this.#glyphs;
    const enc = desc.encoding;
    let baseName = enc?.name ?? enc?.base ?? null;
    let base = null;
    if (baseName) {
      const key = ENCODING_NAMES[baseName];
      if (key) base = encodings[key];
      else this.issues.add('encoding');
    } else if (this.kind !== 'type3') {
      if (this.standard === 'Symbol') base = encodings.Symbol;
      else if (this.standard === 'ZapfDingbats') base = encodings.ZapfDingbats;
      else if (!this.embedded) {
        // Like pdf.js for fonts the viewer supplies: non-symbolic TrueType → WinAnsi, else Standard.
        const nonsymbolic = Boolean(this.flags.raw & FLAG.nonsymbolic);
        base = this.subtype === 'TrueType' && !nonsymbolic ? encodings.WinAnsi : encodings.Standard;
      }
      // An embedded font without /Encoding uses the encoding inside its font program, which we don't
      // read: codes are only understood through ToUnicode.
    }
    const differences = enc?.differences ?? [];
    if (!base && !differences.length) return null;
    const table = base ? base.slice() : new Array(256).fill(null);
    for (const [code, name] of differences) if (code >= 0 && code < 256) table[code] = name;
    return table;
  }

  #initComposite(desc) {
    const cmap = desc.cmap;
    if (cmap?.name === 'Identity-H') {
      this.#cmap = IDENTITY_CMAP;
    } else if (cmap?.name === 'Identity-V') {
      this.#cmap = IDENTITY_CMAP;
      this.vertical = true;
      this.issues.add('vertical');
    } else if (cmap?.bytes) {
      try {
        const parsed = parseCMap(cmap.bytes);
        if (parsed.usecmap || !parsed.codespace.length) this.issues.add('cmap');
        else this.#cmap = { ...parsed, cids: parsed.cids.size ? parsed.cids : null };
        if (parsed.vertical) {
          this.vertical = true;
          this.issues.add('vertical');
        }
      } catch {
        this.issues.add('cmap');
      }
    } else {
      this.issues.add('cmap'); // a predefined CMap (e.g. for CJK encodings): not supported yet
    }
    const d = desc.descendant ?? {};
    this.#cidWidths = parseW(d.w);
    this.#defaultWidth = numberOr(d.dw, 1000);
    if (!d.subtype) this.issues.add('metrics');
  }

  #initMetrics(desc, descriptor) {
    let ascent = null;
    let descent = null;
    if (this.kind === 'type3') {
      const [, y1, , y2] = desc.fontBBox ?? [];
      const d = desc.fontMatrix?.[3];
      if (Number.isFinite(y1) && Number.isFinite(y2) && Number.isFinite(d) && d) {
        ascent = Math.max(y1 * d, y2 * d);
        descent = Math.min(y1 * d, y2 * d);
      }
    } else {
      const a = descriptor?.ascent;
      const dsc = descriptor?.descent;
      if (Number.isFinite(a) && Number.isFinite(dsc) && a > dsc && (a || dsc)) {
        ascent = a / 1000;
        descent = dsc / 1000;
      } else if (Array.isArray(descriptor?.bbox) && descriptor.bbox[3] > descriptor.bbox[1]) {
        ascent = descriptor.bbox[3] / 1000;
        descent = descriptor.bbox[1] / 1000;
      } else if (this.#metrics) {
        const m = this.#metrics;
        const top = Number.isFinite(m.ascent) ? m.ascent : m.bbox?.[3];
        const bottom = Number.isFinite(m.descent) ? m.descent : m.bbox?.[1];
        if (Number.isFinite(top) && Number.isFinite(bottom)) {
          ascent = top / 1000;
          descent = bottom / 1000;
        }
      }
    }
    if (!(ascent > descent) || ascent - descent > 4) {
      ascent = 0.8;
      descent = -0.2;
    }
    this.ascent = ascent;
    this.descent = Math.min(descent, 0);
  }
}

function describeFlags(descriptor, name) {
  const raw = Number.isInteger(descriptor?.flags) ? descriptor.flags : 0;
  const weight = descriptor?.weight;
  return {
    raw,
    fixedPitch: Boolean(raw & FLAG.fixedPitch) || MONO_NAMES.test(name),
    serif: (Boolean(raw & FLAG.serif) || SERIF_NAMES.test(name)) && !/sans/i.test(name),
    script: Boolean(raw & FLAG.script),
    bold: Boolean(raw & FLAG.forceBold) || (Number.isFinite(weight) && weight >= 600) || BOLD_NAMES.test(name),
    italic: Boolean(raw & FLAG.italic) || (Number.isFinite(descriptor?.italicAngle) && descriptor.italicAngle !== 0) || ITALIC_NAMES.test(name),
  };
}

/** Parses a CIDFont /W array into CID → width. */
function parseW(w) {
  const map = new Map();
  if (!Array.isArray(w)) return map;
  for (let i = 0; i < w.length;) {
    const first = w[i];
    const next = w[i + 1];
    if (!Number.isInteger(first)) break;
    if (Array.isArray(next)) {
      next.forEach((v, k) => { if (Number.isFinite(v)) map.set(first + k, v); });
      i += 2;
    } else {
      const width = w[i + 2];
      if (!Number.isInteger(next) || !Number.isFinite(width) || next < first) break;
      for (let cid = first; cid <= next && cid - first < 0x10000; cid++) map.set(cid, width);
      i += 3;
    }
  }
  return map;
}

const numberOr = (v, fallback) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);

// ---- fallback fonts -------------------------------------------------------------------------

/**
 * The standard font to use when the original can't write some text, or null with a reason when a
 * substitute would be obviously wrong (symbol or script fonts).
 */
export function fallbackFontFor(font) {
  if (font.symbolFont) return { name: null, reason: 'symbol-font' };
  if (font.flags.script) return { name: null, reason: 'script-font' };
  const { bold, italic } = font.flags;
  if (font.flags.fixedPitch) return { name: `Courier${bold && italic ? '-BoldOblique' : bold ? '-Bold' : italic ? '-Oblique' : ''}` };
  if (font.flags.serif) return { name: bold && italic ? 'Times-BoldItalic' : bold ? 'Times-Bold' : italic ? 'Times-Italic' : 'Times-Roman' };
  return { name: `Helvetica${bold && italic ? '-BoldOblique' : bold ? '-Bold' : italic ? '-Oblique' : ''}` };
}

/** Characters of `text` the standard fonts (WinAnsi) can't write; empty when all can be written. */
export function charactersOutsideWinAnsi(text, glyphs) {
  const writable = glyphs.winAnsiCodePoints;
  const missing = new Set();
  for (const ch of text.normalize('NFC')) if (!writable.has(ch.codePointAt(0)) && !/^\s$/u.test(ch)) missing.add(ch);
  return [...missing];
}
