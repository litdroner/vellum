// Reads what the editing engine needs from a PDF, through pdf-lib: each page's content, resources,
// fonts and form XObjects, turned into plain data for the lexer, interpreter and font models.
// It only reads; the document is never changed here.

import { lex, PdfName, PdfString } from './content/lexer.js';
import { createFont } from './fonts.js';
import { buildGlyphData } from './glyph-names.js';
import { IDENTITY } from './matrix.js';

export class SourceError extends Error {
  constructor(kind, message) {
    super(message);
    this.name = 'SourceError';
    this.kind = kind; // 'encrypted' | 'unreadable'
  }
}

let glyphData = null;

/** Opens PDF bytes for analysis. Encrypted files are refused (pdf-lib can't decrypt them). */
export async function openSource(lib, bytes) {
  let doc;
  try {
    doc = await lib.PDFDocument.load(bytes, { updateMetadata: false });
  } catch (err) {
    const message = String(err?.message ?? err);
    throw new SourceError(/encrypt/i.test(message) ? 'encrypted' : 'unreadable', message);
  }
  return new PdfSource(lib, doc);
}

export class PdfSource {
  constructor(lib, doc) {
    this.lib = lib;
    this.doc = doc;
    this.context = doc.context;
    this.pages = doc.getPages();
    this.glyphs = (glyphData ??= withWinAnsi(buildGlyphData(lib), lib));
    /** Font models by object reference: shared by every page, so what pdf.js confirms on one page counts for all. */
    this.fonts = new Map();
    this.xobjects = new Map();
    const metrics = new Map();
    this.fontEnv = {
      glyphs: this.glyphs,
      standardMetrics(name) {
        if (!metrics.has(name)) {
          const font = lib.StandardFontEmbedder.for(name).font;
          metrics.set(name, {
            widthOf: (glyph) => font.getWidthOfGlyph(glyph),
            ascent: font.Ascender, descent: font.Descender, bbox: font.FontBBox,
          });
        }
        return metrics.get(name);
      },
    };
  }

  get pageCount() { return this.pages.length; }

  /** A page, ready for analyzePage(). */
  page(index) {
    return this.pageFor(this.pages[index], index);
  }

  /** The same for any pdf-lib page of this document (e.g. pages arranged by a page plan). */
  pageFor(page, index) {
    const crop = page.getCropBox();
    return {
      index,
      ref: page.ref.toString(),
      box: [crop.x, crop.y, crop.x + crop.width, crop.y + crop.height],
      rotate: page.getRotation().angle,
      contentBytes: () => this.contentBytes(page.node),
      resources: new Resolver(this, page.node.Resources() ?? null, `page${index}`),
    };
  }

  /** The page's content streams, decoded and joined (a newline between streams, as viewers read them). */
  contentBytes(node) {
    const { PDFName, PDFArray } = this.lib;
    const raw = node.get(PDFName.of('Contents'));
    if (!raw) return new Uint8Array(0);
    const resolved = this.context.lookup(raw);
    const streams = resolved instanceof PDFArray ? resolved.asArray().map((r) => this.context.lookup(r)) : [resolved];
    const parts = streams.map((s) => this.streamBytes(s));
    const total = parts.reduce((n, p) => n + p.length + 1, 0);
    const out = new Uint8Array(total);
    let at = 0;
    for (const p of parts) {
      out.set(p, at);
      at += p.length;
      out[at++] = 0x0a;
    }
    return out;
  }

  streamBytes(stream) {
    const { PDFRawStream } = this.lib;
    if (stream instanceof PDFRawStream) return this.lib.decodePDFRawStream(stream).decode();
    if (typeof stream?.getUnencodedContents === 'function') return stream.getUnencodedContents();
    throw new SourceError('unreadable', 'A content stream is missing or not a stream.');
  }

  // ---- plain-data helpers --------------------------------------------------------------

  lookup(value) { return value ? this.context.lookup(value) : undefined; }

  nameOf(value) {
    const v = this.lookup(value);
    return v instanceof this.lib.PDFName ? v.decodeText() : null;
  }

  numberOf(value) {
    const v = this.lookup(value);
    return v instanceof this.lib.PDFNumber ? v.asNumber() : null;
  }

  /** Numbers, names, strings and arrays of them as plain values (names → PdfName, strings → PdfString). */
  plain(value, depth = 0) {
    const { PDFNumber, PDFName, PDFString, PDFHexString, PDFArray, PDFBool } = this.lib;
    if (depth > 8) return null;
    const v = this.lookup(value);
    if (v instanceof PDFNumber) return v.asNumber();
    if (v instanceof PDFName) return new PdfName(v.decodeText());
    if (v instanceof PDFString || v instanceof PDFHexString) return new PdfString(v.asBytes());
    if (v instanceof PDFBool) return v.asBoolean();
    if (v instanceof PDFArray) return v.asArray().map((x) => this.plain(x, depth + 1));
    return null;
  }

  numbers(value) {
    const arr = this.plain(value);
    return Array.isArray(arr) && arr.every((x) => typeof x === 'number') ? arr : null;
  }

  // ---- fonts ----------------------------------------------------------------------------

  fontFor(raw, fallbackKey) {
    const key = raw instanceof this.lib.PDFRef ? raw.toString() : fallbackKey;
    if (this.fonts.has(key)) return this.fonts.get(key);
    let model = null;
    const dict = this.lookup(raw);
    if (dict instanceof this.lib.PDFDict) {
      try {
        model = createFont(this.describeFont(dict, key), this.fontEnv);
      } catch {
        model = createFont({ key, subtype: 'unknown' }, this.fontEnv); // unreadable: measured as unknown
        model.issues.add('unreadable-font');
      }
    }
    this.fonts.set(key, model);
    return model;
  }

  describeFont(dict, key) {
    const { PDFName, PDFDict, PDFArray, PDFStream } = this.lib;
    const get = (d, k) => (d instanceof PDFDict ? this.lookup(d.get(PDFName.of(k))) : undefined);
    const subtype = this.nameOf(get(dict, 'Subtype'));
    const desc = { key, subtype, baseFont: this.nameOf(get(dict, 'BaseFont')) };
    const toUnicode = get(dict, 'ToUnicode');
    if (toUnicode instanceof PDFStream) {
      try { desc.toUnicode = this.streamBytes(toUnicode); } catch { desc.toUnicode = null; }
    }
    if (subtype === 'Type0') {
      const encoding = get(dict, 'Encoding');
      if (encoding instanceof PDFName) desc.cmap = { name: encoding.decodeText() };
      else if (encoding instanceof PDFStream) {
        try { desc.cmap = { bytes: this.streamBytes(encoding) }; } catch { desc.cmap = null; }
      }
      const kids = get(dict, 'DescendantFonts');
      const cid = kids instanceof PDFArray ? this.lookup(kids.get(0)) : null;
      if (cid instanceof PDFDict) {
        desc.descendant = {
          subtype: this.nameOf(get(cid, 'Subtype')),
          baseFont: this.nameOf(get(cid, 'BaseFont')),
          w: this.plain(get(cid, 'W')),
          dw: this.numberOf(get(cid, 'DW')),
          descriptor: this.describeDescriptor(get(cid, 'FontDescriptor')),
        };
      }
      return desc;
    }
    desc.firstChar = this.numberOf(get(dict, 'FirstChar'));
    desc.widths = this.numbers(get(dict, 'Widths'));
    desc.descriptor = this.describeDescriptor(get(dict, 'FontDescriptor'));
    const encoding = get(dict, 'Encoding');
    if (encoding instanceof PDFName) {
      desc.encoding = { name: encoding.decodeText() };
    } else if (encoding instanceof PDFDict) {
      const differences = [];
      const list = this.plain(get(encoding, 'Differences'));
      if (Array.isArray(list)) {
        let code = 0;
        for (const item of list) {
          if (typeof item === 'number') code = item;
          else if (item instanceof PdfName) differences.push([code++, item.name]);
        }
      }
      desc.encoding = { base: this.nameOf(get(encoding, 'BaseEncoding')), differences };
    }
    if (subtype === 'Type3') {
      desc.fontMatrix = this.numbers(get(dict, 'FontMatrix'));
      desc.fontBBox = this.numbers(get(dict, 'FontBBox'));
    }
    return desc;
  }

  describeDescriptor(value) {
    const { PDFName, PDFDict } = this.lib;
    const d = this.lookup(value);
    if (!(d instanceof PDFDict)) return null;
    const get = (k) => this.lookup(d.get(PDFName.of(k)));
    const fontFile = ['FontFile', 'FontFile2', 'FontFile3'].find((k) => d.has(PDFName.of(k))) ?? null;
    return {
      flags: this.numberOf(get('Flags')),
      ascent: this.numberOf(get('Ascent')),
      descent: this.numberOf(get('Descent')),
      bbox: this.numbers(get('FontBBox')),
      italicAngle: this.numberOf(get('ItalicAngle')),
      weight: this.numberOf(get('FontWeight')),
      missingWidth: this.numberOf(get('MissingWidth')),
      fontFile,
    };
  }

  // ---- XObjects ---------------------------------------------------------------------------

  xobjectFor(raw, fallbackKey, inheritedResources) {
    const { PDFName, PDFRef, PDFStream, PDFDict } = this.lib;
    const key = raw instanceof PDFRef ? raw.toString() : fallbackKey;
    if (this.xobjects.has(key)) return this.xobjects.get(key);
    const stream = this.lookup(raw);
    let result = null;
    if (stream instanceof PDFStream) {
      const subtype = this.nameOf(stream.dict.get(PDFName.of('Subtype')));
      if (subtype === 'Image') {
        result = { kind: 'image', key };
      } else if (subtype === 'Form') {
        const bbox = this.numbers(stream.dict.get(PDFName.of('BBox')));
        const resources = this.lookup(stream.dict.get(PDFName.of('Resources')));
        result = {
          kind: 'form',
          key,
          matrix: this.numbers(stream.dict.get(PDFName.of('Matrix'))) ?? IDENTITY,
          bbox: bbox?.length === 4 ? [Math.min(bbox[0], bbox[2]), Math.min(bbox[1], bbox[3]), Math.max(bbox[0], bbox[2]), Math.max(bbox[1], bbox[3])] : null,
          // A form without /Resources uses the resources of whatever draws it (older files rely on this).
          resources: resources instanceof PDFDict ? new Resolver(this, resources, key) : inheritedResources,
          ops: null,
          error: null,
        };
        try {
          result.ops = lex(this.streamBytes(stream)).ops;
        } catch (err) {
          result.error = err.message;
        }
      } else {
        result = { kind: 'other', key };
      }
    }
    // Forms without their own resources depend on the caller's, so they aren't shared by key.
    if (result?.kind !== 'form' || result.resources !== inheritedResources) this.xobjects.set(key, result);
    return result;
  }
}

/** Resource lookups for one content stream (a page, or a form with its own /Resources). */
class Resolver {
  constructor(source, dict, scope) {
    this.source = source;
    this.dict = dict;
    this.scope = scope;
  }

  #entry(category, name) {
    const { PDFName, PDFDict } = this.source.lib;
    const group = this.dict ? this.source.lookup(this.dict.get(PDFName.of(category))) : null;
    return group instanceof PDFDict ? group.get(PDFName.of(name)) ?? null : null;
  }

  font(name) {
    const raw = this.#entry('Font', name);
    return raw ? this.source.fontFor(raw, `${this.scope}/Font/${name}`) : null;
  }

  xobject(name) {
    const raw = this.#entry('XObject', name);
    return raw ? this.source.xobjectFor(raw, `${this.scope}/XObject/${name}`, this) : null;
  }

  extGState(name) {
    const { PDFName, PDFDict, PDFArray } = this.source.lib;
    const dict = this.source.lookup(this.#entry('ExtGState', name));
    if (!(dict instanceof PDFDict)) return null;
    const out = {};
    const font = this.source.lookup(dict.get(PDFName.of('Font')));
    if (font instanceof PDFArray && font.size() === 2) {
      const model = this.source.fontFor(font.get(0), `${this.scope}/ExtGState/${name}/Font`);
      const size = this.source.numberOf(font.get(1));
      if (model && size !== null) out.font = { model, size };
    }
    const lw = this.source.numberOf(dict.get(PDFName.of('LW')));
    if (lw !== null) out.lineWidth = lw;
    return out;
  }

  properties(name) {
    const { PDFDict } = this.source.lib;
    const dict = this.source.lookup(this.#entry('Properties', name));
    if (!(dict instanceof PDFDict)) return null;
    return new Map(dict.entries().map(([k, v]) => [k.decodeText(), v]));
  }
}

/** Adds the set of Unicode code points the standard (WinAnsi) fonts can write. */
function withWinAnsi(glyphs, lib) {
  const mappings = lib.StandardFontEmbedder.for(lib.StandardFonts.Helvetica).encoding.unicodeMappings;
  return { ...glyphs, winAnsiCodePoints: new Set(Object.keys(mappings).map(Number)) };
}
