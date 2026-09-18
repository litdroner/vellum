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

/**
 * What kind of document a file is, for decisions about the whole file (read once):
 *   encrypted  protected: Vellum can't rewrite it (the rest is then unknown and false)
 *   signed     it carries a digital signature: a signature value (/ByteRange + /Contents), or the
 *              AcroForm's SignaturesExist flag. Saving any change invalidates it.
 *   certified  a certification signature says which changes the author allows (/Perms /DocMDP)
 *   tagged     it has an accessibility structure (/MarkInfo /Marked, or a /StructTreeRoot)
 *   pdfa       { part, conformance } when its XMP metadata claims PDF/A, else null
 */
export async function inspectDocument(lib, bytes) {
  let doc;
  try {
    doc = await lib.PDFDocument.load(bytes, { updateMetadata: false });
  } catch (err) {
    if (/encrypt/i.test(String(err?.message ?? err))) return { encrypted: true, signed: false, certified: false, tagged: false, pdfa: null };
    throw err;
  }
  return readProfile(lib, doc);
}

export function readProfile(lib, doc) {
  const { PDFName, PDFDict, PDFNumber, PDFBool } = lib;
  const catalog = doc.catalog;
  const lookup = (v) => (v ? doc.context.lookup(v) : undefined);
  const form = lookup(catalog.get(PDFName.of('AcroForm')));
  const flags = form instanceof PDFDict ? lookup(form.get(PDFName.of('SigFlags'))) : null;
  let signed = flags instanceof PDFNumber && (flags.asNumber() & 1) === 1;
  if (!signed) {
    for (const [, obj] of doc.context.enumerateIndirectObjects()) {
      if (obj instanceof PDFDict && isSignatureValue(lib, obj)) {
        signed = true;
        break;
      }
    }
  }
  const perms = lookup(catalog.get(PDFName.of('Perms')));
  const markInfo = lookup(catalog.get(PDFName.of('MarkInfo')));
  const marked = markInfo instanceof PDFDict ? lookup(markInfo.get(PDFName.of('Marked'))) : null;
  return {
    encrypted: false,
    signed,
    certified: perms instanceof PDFDict && perms.has(PDFName.of('DocMDP')),
    tagged: (marked instanceof PDFBool && marked.asBoolean()) || catalog.has(PDFName.of('StructTreeRoot')),
    pdfa: pdfaClaim(lib, doc),
  };
}

/**
 * Whether raw file bytes could hold a digital signature, without parsing them. False only when
 * that's certain: no signature value (/ByteRange — never compressed, since the signature covers the
 * bytes around it), no SignaturesExist flag (/SigFlags), and no object streams that could hide it.
 */
export function mayBeSigned(bytes) {
  return containsAscii(bytes, '/ByteRange') || containsAscii(bytes, '/SigFlags') || containsAscii(bytes, '/ObjStm');
}

function containsAscii(bytes, text) {
  const pattern = Uint8Array.from(text, (c) => c.charCodeAt(0));
  const last = bytes.length - pattern.length;
  for (let i = bytes.indexOf(pattern[0]); i !== -1 && i <= last; i = bytes.indexOf(pattern[0], i + 1)) {
    let k = 1;
    while (k < pattern.length && bytes[i + k] === pattern[k]) k++;
    if (k === pattern.length) return true;
  }
  return false;
}

/** A signature value dictionary: the byte range it signs and the signature itself. */
function isSignatureValue({ PDFName, PDFArray, PDFString, PDFHexString }, dict) {
  const range = dict.get(PDFName.of('ByteRange'));
  const contents = dict.get(PDFName.of('Contents'));
  return range instanceof PDFArray && (contents instanceof PDFHexString || contents instanceof PDFString);
}

/** { part, conformance } when the document's XMP metadata claims PDF/A conformance, else null. */
export function pdfaClaim(lib, doc) {
  const { PDFName, PDFRawStream, PDFStream } = lib;
  const meta = doc.context.lookup(doc.catalog.get(PDFName.of('Metadata')));
  if (!(meta instanceof PDFStream)) return null;
  let xml;
  try {
    const bytes = meta instanceof PDFRawStream ? lib.decodePDFRawStream(meta).decode() : meta.getUnencodedContents();
    xml = new TextDecoder().decode(bytes);
  } catch {
    return null;
  }
  // Written either as elements (<pdfaid:part>2</pdfaid:part>) or as attributes (pdfaid:part="2").
  const field = (name) => new RegExp(`pdfaid:${name}\\s*(?:=\\s*["']|>)\\s*([^"'<\\s]+)`, 'i').exec(xml)?.[1] ?? null;
  const part = Number(field('part'));
  if (!Number.isInteger(part) || part < 1) return null;
  return { part, conformance: field('conformance')?.toUpperCase() ?? null };
}

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

  #scanned = false;

  /**
   * Every font object the document's pages name in their resources, inherited ones too (and those of the
   * forms they draw), read into `fonts` the same way a page's analysis reads them and under the same keys:
   * the families a font menu can show before every page has been read. Done once per document. The font
   * programs aren't read, and no glyph is confirmed by this.
   */
  scanFonts() {
    if (this.#scanned) return this.fonts;
    this.#scanned = true;
    const { PDFName, PDFDict, PDFRef, PDFStream } = this.lib;
    const seen = new Set();
    const visit = (resources, scope, depth) => {
      const dict = this.lookup(resources);
      if (!(dict instanceof PDFDict) || seen.has(dict) || depth > 16) return;
      seen.add(dict);
      const fonts = this.lookup(dict.get(PDFName.of('Font')));
      if (fonts instanceof PDFDict) {
        for (const [name, raw] of fonts.entries()) {
          try { this.fontFor(raw, `${scope}/Font/${name.decodeText()}`); } catch { /* an unreadable entry adds nothing */ }
        }
      }
      const xobjects = this.lookup(dict.get(PDFName.of('XObject')));
      if (!(xobjects instanceof PDFDict)) return;
      for (const [name, raw] of xobjects.entries()) {
        try {
          const stream = this.lookup(raw);
          if (!(stream instanceof PDFStream) || this.nameOf(stream.dict.get(PDFName.of('Subtype'))) !== 'Form') continue;
          const key = raw instanceof PDFRef ? raw.toString() : `${scope}/XObject/${name.decodeText()}`;
          visit(stream.dict.get(PDFName.of('Resources')), key, depth + 1);
        } catch { /* an unreadable form adds nothing */ }
      }
    };
    this.pages.forEach((page, index) => {
      try { visit(page.node.Resources(), `page${index}`, 0); } catch { /* a page whose resources can't be read adds nothing */ }
    });
    return this.fonts;
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
      const ocRaw = stream.dict.get(PDFName.of('OC'));
      const oc = ocRaw ? this.optionalContent(ocRaw) : null;
      if (subtype === 'Image') {
        result = { kind: 'image', key, info: this.imageInfo(stream.dict), oc };
      } else if (subtype === 'Form') {
        const bbox = this.numbers(stream.dict.get(PDFName.of('BBox')));
        const resources = this.lookup(stream.dict.get(PDFName.of('Resources')));
        const own = resources instanceof PDFDict;
        result = {
          kind: 'form',
          key,
          oc,
          matrix: this.numbers(stream.dict.get(PDFName.of('Matrix'))) ?? IDENTITY,
          bbox: bbox?.length === 4 ? [Math.min(bbox[0], bbox[2]), Math.min(bbox[1], bbox[3]), Math.max(bbox[0], bbox[2]), Math.max(bbox[1], bbox[3])] : null,
          // A form without /Resources uses the resources of whatever draws it (older files rely on this).
          resources: own ? new Resolver(this, resources, key) : inheritedResources,
          // Whose resources those are decides whether the form can ever be copied on its own.
          ownResources: own,
          // A transparency group: the form is composited as a unit, so what it draws can't be moved out of it.
          group: this.groupOf(stream.dict),
          // The form's own stream exactly as the analysis read it. Kept so that a private copy of
          // the form can be written from these very bytes and these very operator offsets, and
          // never from a second reading that might not be the same (objects/form-copy.js).
          bytes: null,
          ops: null,
          error: null,
        };
        try {
          result.bytes = this.streamBytes(stream);
          result.ops = lex(result.bytes).ops;
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

  /** A form XObject's /Group subtype ('Transparency'), or null when it has no group at all. */
  groupOf(dict) {
    const { PDFName, PDFDict } = this.lib;
    const group = this.lookup(dict.get(PDFName.of('Group')));
    if (!(group instanceof PDFDict)) return null;
    return this.nameOf(group.get(PDFName.of('S'))) ?? 'Transparency';
  }

  /** What an image XObject is: size, colour space, and whether it's a stencil mask or has its own transparency. */
  imageInfo(dict) {
    const { PDFName, PDFArray, PDFBool } = this.lib;
    const get = (k) => this.lookup(dict.get(PDFName.of(k)));
    const cs = get('ColorSpace');
    const mask = get('ImageMask');
    return {
      width: this.numberOf(get('Width')),
      height: this.numberOf(get('Height')),
      bitsPerComponent: this.numberOf(get('BitsPerComponent')),
      colorSpace: cs instanceof PDFName ? cs.decodeText() : cs instanceof PDFArray ? this.nameOf(cs.get(0)) : null,
      imageMask: mask instanceof PDFBool ? mask.asBoolean() : false,
      smask: dict.has(PDFName.of('SMask')),
      mask: dict.has(PDFName.of('Mask')),
    };
  }

  // ---- optional content (layers) -------------------------------------------------------------

  /**
   * An optional-content group: { key, hidden } — hidden in the document's default view. hidden is
   * null when that can't be told here: a membership dictionary (OCMD, visibility by rules), or a
   * group the file's /OCProperties don't describe.
   */
  optionalContent(raw) {
    const { PDFRef, PDFDict, PDFName } = this.lib;
    const key = raw instanceof PDFRef ? raw.toString() : null;
    const dict = this.lookup(raw);
    if (!key || !(dict instanceof PDFDict) || this.nameOf(dict.get(PDFName.of('Type'))) !== 'OCG') return { key, hidden: null };
    const defaults = this.#ocDefaults();
    if (!defaults) return { key, hidden: null };
    return { key, hidden: defaults.base === 'OFF' ? !defaults.on.has(key) : defaults.off.has(key) };
  }

  #oc = undefined;

  #ocDefaults() {
    if (this.#oc !== undefined) return this.#oc;
    const { PDFName, PDFDict, PDFArray } = this.lib;
    const props = this.lookup(this.doc.catalog.get(PDFName.of('OCProperties')));
    const d = props instanceof PDFDict ? this.lookup(props.get(PDFName.of('D'))) : null;
    const refs = (value) => {
      const list = this.lookup(value);
      return new Set(list instanceof PDFArray ? list.asArray().map((r) => r.toString()) : []);
    };
    this.#oc = d instanceof PDFDict
      ? { base: this.nameOf(d.get(PDFName.of('BaseState'))) ?? 'ON', on: refs(d.get(PDFName.of('ON'))), off: refs(d.get(PDFName.of('OFF'))) }
      : null;
    return this.#oc;
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

  /** Is there a resource of this category under this name here at all? */
  has(category, name) {
    return this.#entry(category, name) !== null;
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
    // Transparency: fill / stroke opacity, blend mode, soft mask ('none' switches one off).
    const ca = this.source.numberOf(dict.get(PDFName.of('ca')));
    if (ca !== null) out.ca = ca;
    const CA = this.source.numberOf(dict.get(PDFName.of('CA')));
    if (CA !== null) out.CA = CA;
    const bm = this.source.lookup(dict.get(PDFName.of('BM')));
    const blend = bm instanceof PDFArray ? this.source.lookup(bm.get(0)) : bm;
    if (blend instanceof PDFName) out.blend = blend.decodeText();
    const smask = this.source.lookup(dict.get(PDFName.of('SMask')));
    if (smask instanceof PDFName) out.softMask = smask.decodeText() === 'None' ? 'none' : 'mask';
    else if (smask instanceof PDFDict) out.softMask = 'mask';
    return out;
  }

  /** A /Properties resource as marked content uses it: { mcid, actualText, oc } (oc: layers only). */
  properties(name) {
    const { PDFName, PDFDict } = this.source.lib;
    const raw = this.#entry('Properties', name);
    const dict = this.source.lookup(raw);
    if (!(dict instanceof PDFDict)) return null;
    const type = this.source.nameOf(dict.get(PDFName.of('Type')));
    return {
      mcid: this.source.numberOf(dict.get(PDFName.of('MCID'))),
      actualText: dict.has(PDFName.of('ActualText')),
      oc: type === 'OCG' || type === 'OCMD' ? this.source.optionalContent(raw) : null,
    };
  }
}

/** Adds the set of Unicode code points the standard (WinAnsi) fonts can write. */
function withWinAnsi(glyphs, lib) {
  const mappings = lib.StandardFontEmbedder.for(lib.StandardFonts.Helvetica).encoding.unicodeMappings;
  return { ...glyphs, winAnsiCodePoints: new Set(Object.keys(mappings).map(Number)) };
}
