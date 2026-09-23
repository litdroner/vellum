// What a rewritten PDF must still hold, read back from the written bytes. Both PDF operations that
// produce a new file — Compress (optimize/compress.js) and PDF/A (optimize/pdfa.js) — take an
// inventory of the source before they start and of their own output afterwards, and refuse the
// result when the two differ. It is the integrity check those operations are validated by, not a
// summary for the reader.
//
// It reads through the engine's own reader (editing/source.js openSource), so nothing here parses a
// PDF a second way, and it records only what a structural rewrite must never change:
//
//   per page   size, rotation, the decoded content stream (length and hash), the names of the
//              resources the page draws with and what each one is, and its annotations by subtype
//   document   the page count, every form field's full name, the outline's size and the names of
//              embedded files
//
// The content hash is a plain FNV-1a over the decoded bytes: it is a change detector between two
// readings of the same document, never a proof of authenticity.

import { openSource } from '../editing/source.js';

/** FNV-1a (32-bit), as an 8-digit hex string. Deterministic; not a cryptographic digest. */
export function hashBytes(bytes) {
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i];
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/** True when two byte arrays hold exactly the same bytes. */
export function sameBytes(a, b) {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * The inventory of a PDF's bytes. Throws whatever openSource throws when the file can't be read at
 * all (a SourceError), which is what "the output doesn't reopen" means here.
 */
export async function inventory(lib, bytes) {
  const source = await openSource(lib, bytes);
  const { PDFName, PDFDict, PDFArray, PDFStream } = lib;
  const pages = source.pages.map((page, index) => {
    const content = source.contentBytes(page.node);
    const box = page.getMediaBox();
    return {
      number: index + 1,
      width: round(box.width),
      height: round(box.height),
      rotate: ((page.getRotation().angle % 360) + 360) % 360,
      contentLength: content.length,
      contentHash: hashBytes(content),
      resources: resourceNames(source, lib, page.node.Resources()),
      annotations: annotationCounts(source, lib, page.node.get(PDFName.of('Annots'))),
    };
  });
  return Object.freeze({
    pageCount: pages.length,
    pages: Object.freeze(pages),
    fields: Object.freeze(fieldNames(source, lib)),
    outline: outlineCount(source, lib),
    embeddedFiles: Object.freeze(embeddedFileNames(source, lib)),
  });

  function round(n) { return Math.round(n * 1000) / 1000; }

  /** Every resource a page can draw with, as `category/name → what it is`, so nothing silently changes. */
  function resourceNames(src, l, raw) {
    const dict = src.lookup(raw);
    const out = [];
    if (!(dict instanceof PDFDict)) return Object.freeze(out);
    for (const [category, value] of dict.entries()) {
      const group = src.lookup(value);
      if (!(group instanceof PDFDict)) continue;
      const kind = category.decodeText();
      for (const [name] of group.entries()) {
        out.push(`${kind}/${name.decodeText()}=${describe(src, l, group.get(name), kind)}`);
      }
    }
    out.sort();
    return Object.freeze(out);
  }

  /** What one resource is, in the few facts a rewrite must keep: enough to catch a wrong substitution. */
  function describe(src, l, raw, kind) {
    const value = src.lookup(raw);
    if (kind === 'XObject' && value instanceof PDFStream) {
      const subtype = src.nameOf(value.dict.get(PDFName.of('Subtype')));
      if (subtype === 'Image') {
        const info = src.imageInfo(value.dict);
        return `Image ${info.width}x${info.height}x${info.bitsPerComponent ?? '?'} ${info.colorSpace ?? 'none'}${info.smask ? ' smask' : ''}${info.mask ? ' mask' : ''} ${rawSize(value)}`;
      }
      return `${subtype ?? 'XObject'} ${rawSize(value)}`;
    }
    if (kind === 'Font' && value instanceof PDFDict) {
      const descriptor = src.describeDescriptor(value.get(PDFName.of('FontDescriptor')));
      return `${src.nameOf(value.get(PDFName.of('Subtype'))) ?? '?'} ${src.nameOf(value.get(PDFName.of('BaseFont'))) ?? '?'} ${descriptor?.fontFile ?? 'not-embedded'}`;
    }
    if (value instanceof PDFStream) return `stream ${rawSize(value)}`;
    if (value instanceof PDFDict) return `dict ${value.keys().length}`;
    if (value instanceof PDFArray) return `array ${value.size()}`;
    return value ? value.constructor.name : 'missing';
  }

  /** A stream's stored size, without decoding it (an image may be megabytes of JPEG). */
  function rawSize(stream) {
    try { return stream.getContents().length; } catch { return '?'; }
  }

  /** The page's annotations counted by subtype, e.g. ['Link x2', 'Widget x1']. */
  function annotationCounts(src, l, raw) {
    const list = src.lookup(raw);
    if (!(list instanceof PDFArray)) return Object.freeze([]);
    const counts = new Map();
    for (const entry of list.asArray()) {
      const dict = src.lookup(entry);
      const subtype = dict instanceof PDFDict ? src.nameOf(dict.get(PDFName.of('Subtype'))) ?? 'unknown' : 'unreadable';
      counts.set(subtype, (counts.get(subtype) ?? 0) + 1);
    }
    return Object.freeze([...counts].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([name, n]) => `${name} x${n}`));
  }

  /** Every form field's full name, from the AcroForm tree itself (no appearances are generated). */
  function fieldNames(src, l) {
    const form = src.lookup(src.doc.catalog.get(PDFName.of('AcroForm')));
    if (!(form instanceof PDFDict)) return [];
    const names = [];
    const seen = new Set();
    const walk = (raw, prefix, depth) => {
      const dict = src.lookup(raw);
      if (!(dict instanceof PDFDict) || depth > 32 || seen.has(dict)) return;
      seen.add(dict);
      const partial = src.lookup(dict.get(PDFName.of('T')));
      const part = partial && typeof partial.decodeText === 'function' ? partial.decodeText() : null;
      const full = part ? (prefix ? `${prefix}.${part}` : part) : prefix;
      const kids = src.lookup(dict.get(PDFName.of('Kids')));
      const children = kids instanceof PDFArray ? kids.asArray() : [];
      // A kid with no /T of its own is a widget of this field, not a field: it adds no name.
      const named = children.filter((k) => {
        const kid = src.lookup(k);
        return kid instanceof PDFDict && kid.has(PDFName.of('T'));
      });
      if (!named.length) {
        if (full) names.push(full);
        return;
      }
      for (const kid of named) walk(kid, full, depth + 1);
    };
    const fields = src.lookup(form.get(PDFName.of('Fields')));
    if (fields instanceof PDFArray) for (const f of fields.asArray()) walk(f, '', 0);
    return [...new Set(names)].sort();
  }

  /** How many items the outline (bookmarks) has, followed through /First and /Next. */
  function outlineCount(src, l) {
    const root = src.lookup(src.doc.catalog.get(PDFName.of('Outlines')));
    if (!(root instanceof PDFDict)) return 0;
    let n = 0;
    const seen = new Set();
    const walk = (raw, depth) => {
      let dict = src.lookup(raw);
      while (dict instanceof PDFDict && !seen.has(dict) && depth <= 32 && n < 100000) {
        seen.add(dict);
        n++;
        walk(dict.get(PDFName.of('First')), depth + 1);
        dict = src.lookup(dict.get(PDFName.of('Next')));
      }
    };
    walk(root.get(PDFName.of('First')), 0);
    return n;
  }

  /** The names of the files embedded in the document (/Names /EmbeddedFiles), sorted. */
  function embeddedFileNames(src, l) {
    const names = src.lookup(src.doc.catalog.get(PDFName.of('Names')));
    const tree = names instanceof PDFDict ? src.lookup(names.get(PDFName.of('EmbeddedFiles'))) : null;
    if (!(tree instanceof PDFDict)) return [];
    const out = [];
    const seen = new Set();
    const walk = (node, depth) => {
      const dict = src.lookup(node);
      if (!(dict instanceof PDFDict) || depth > 32 || seen.has(dict)) return;
      seen.add(dict);
      const pairs = src.lookup(dict.get(PDFName.of('Names')));
      if (pairs instanceof PDFArray) {
        const list = pairs.asArray();
        for (let i = 0; i < list.length; i += 2) {
          const key = src.lookup(list[i]);
          out.push(key && typeof key.decodeText === 'function' ? key.decodeText() : `#${i / 2}`);
        }
      }
      const kids = src.lookup(dict.get(PDFName.of('Kids')));
      if (kids instanceof PDFArray) for (const kid of kids.asArray()) walk(kid, depth + 1);
    };
    walk(tree, 0);
    return out.sort();
  }
}

/**
 * How the inventory of a rewritten file differs from the source's: one plain sentence per difference,
 * empty when nothing was lost. The order is fixed, so the same pair of files always reads the same.
 */
export function compareInventory(before, after) {
  const out = [];
  if (before.pageCount !== after.pageCount) {
    out.push(`The document had ${before.pageCount} ${before.pageCount === 1 ? 'page' : 'pages'} and the result has ${after.pageCount}.`);
    return out;
  }
  for (let i = 0; i < before.pages.length; i++) {
    const a = before.pages[i];
    const b = after.pages[i];
    const at = `Page ${a.number}`;
    if (a.width !== b.width || a.height !== b.height) out.push(`${at} changed size (${a.width}×${a.height} to ${b.width}×${b.height}).`);
    if (a.rotate !== b.rotate) out.push(`${at} changed rotation (${a.rotate}° to ${b.rotate}°).`);
    if (a.contentHash !== b.contentHash || a.contentLength !== b.contentLength) out.push(`${at}’s content is not the same as it was.`);
    diffList(out, `${at}’s resources`, a.resources, b.resources);
    diffList(out, `${at}’s annotations`, a.annotations, b.annotations);
  }
  diffList(out, 'The form fields', before.fields, after.fields);
  diffList(out, 'The embedded files', before.embeddedFiles, after.embeddedFiles);
  if (before.outline !== after.outline) out.push(`The outline had ${before.outline} ${before.outline === 1 ? 'item' : 'items'} and the result has ${after.outline}.`);
  return out;
}

function diffList(out, what, before, after) {
  const gone = before.filter((x) => !after.includes(x));
  const added = after.filter((x) => !before.includes(x));
  if (gone.length) out.push(`${what}: ${describeList(gone)} ${gone.length === 1 ? 'is' : 'are'} no longer there.`);
  if (added.length) out.push(`${what}: ${describeList(added)} ${added.length === 1 ? 'was' : 'were'} not there before.`);
}

const describeList = (list) => (list.length > 4 ? `${list.slice(0, 4).join(', ')} and ${list.length - 4} more` : list.join(', '));
