// The fonts new text may be written in, as one set (docs/VELLUM_VISION.md §4.3): families of faces, each
// face named by the font key a record holds (objects/text-format.js):
//
//   'Helvetica-Bold', …          a standard PDF font: measured from pdf-lib's metrics, never embedded
//   'bundled:<family>/<style>'   a font bundled with Vellum (web/fonts/document): read by fontkit, and
//                                embedded — a subset of the glyphs the text uses — when the file is saved
//   'doc:<object>-<generation>'  a font the opened PDF already has, written only in glyphs pdf.js has seen
//                                it draw (below: "the document's own fonts")
//
//   fontSet: { families: [{ id, name, faces: [regular, bold, italic, bold italic] }], face(key) → face | null }
//
// A family lists only the faces it really has (null for the rest), and a font set only the bundled
// families whose files could be read, so nothing offered is a stand-in for something else. A face that
// can't be used says why (`refusal`): a font whose licence flags (OS/2 fsType) don't allow it to be
// embedded, subset and edited is never written into a file.
//
// Bundled fonts are measured the way pdf-lib writes them: fontkit lays a piece of text out into glyphs,
// the glyphs' own advance widths add up, and the `Tj` shows those glyphs' ids (Identity-H) at those
// widths. Nothing is shaped between glyphs (noShaping: no ligatures or contextual alternates), so a
// piece of text is always as many glyphs as it has characters and measures the same however a line is
// broken. fontkit (web/vendor/fontkit) is loaded the first time a bundled font is read.

import { EditError } from '../edits.js';
import { STANDARD_FAMILIES, STYLES, bundledKey, documentKey, FONTS, standardFaces } from './text-format.js';
import { BUNDLED_FONTS } from './bundled-fonts.js';

export { documentKey };

const FONTKIT = new URL('../../../vendor/fontkit/fontkit.es.min.js', import.meta.url).href;
let fontkitPromise = null;

/** fontkit, loaded once, when a bundled font is first read. */
export const loadFontkit = () => (fontkitPromise ??= import(FONTKIT).then((m) => m.default));

/**
 * The OpenType features turned off when laying text out: none that turns several characters into one glyph.
 * A new object each time: fontkit adds to the features it is given.
 */
export const noShaping = () => ({ liga: false, clig: false, dlig: false, hlig: false, rlig: false, calt: false });

/**
 * Characters of scripts that are only written correctly shaped or right to left — Hebrew, Arabic and its
 * neighbours, the Indic scripts, Thai, Lao, Tibetan, Myanmar, Khmer, and combining marks — which glyph by
 * glyph would come out wrong, so they are refused (face.unshaped) rather than written that way.
 */
const NEEDS_SHAPING = /[̀-ͯ֐-ࣿऀ-෿฀-࿿က-႟ក-៿᪰-᫿᷀-᷿⃐-⃿יִ-﷿︠-︯ﹰ-﻿]/u;

const FONTS_DIR = new URL('../../../fonts/document/', import.meta.url);

/** family id → { id, name, group, faces: Map style → () => Promise<Uint8Array> } */
const families = new Map();
/** font key → Promise<{ font, bytes, refusal }> */
const loaded = new Map();

/**
 * Makes a family of bundled fonts available: `id` (lower-case letters, digits and hyphens), its `name` as
 * the font selector shows it, the `group` the selector lists it in, and `faces`, style → the font file's
 * bytes or a function that reads them. The fonts of objects/bundled-fonts.js are registered this way when
 * this module loads; tests register their own.
 */
export function registerBundledFamily({ id, name, group = 'bundled', faces }) {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id) || typeof name !== 'string' || !name) throw new TypeError('A bundled family needs an id and a name.');
  const readers = new Map();
  for (const [style, source] of Object.entries(faces)) {
    if (!STYLES.includes(style)) throw new TypeError(`Unknown style ${style}.`);
    readers.set(style, typeof source === 'function' ? source : async () => source);
  }
  if (!readers.has('regular')) throw new TypeError('A bundled family needs a regular face.');
  families.set(`bundled:${id}`, { id: `bundled:${id}`, name, group, faces: readers });
  for (const style of STYLES) loaded.delete(`bundled:${id}/${style}`);
}

for (const { id, name, group, faces } of BUNDLED_FONTS) {
  registerBundledFamily({
    id,
    name,
    group,
    faces: Object.fromEntries(Object.entries(faces).map(([style, file]) => [style, async () => {
      const response = await fetch(new URL(file, FONTS_DIR));
      if (!response.ok) throw new Error(`${file}: ${response.status}`);
      return new Uint8Array(await response.arrayBuffer());
    }])),
  });
}

/** The bundled families, as the font selector lists them (faces as keys; null where a family hasn't got one). */
export function bundledFamilies() {
  return [...families.values()].map(({ id, name, group, faces }) => ({
    id, name, group, faces: STYLES.map((style) => (faces.has(style) ? `${id}/${style}` : null)),
  }));
}

/** Why the licence flags of a font (fontkit's OS/2 fsType) don't let it be written into a PDF, or null. */
function licenceRefusal(font) {
  const flags = font['OS/2']?.fsType ?? {};
  if (flags.noEmbedding || flags.viewOnly) return 'The font’s licence doesn’t allow it to be embedded in an editable PDF, so nothing was changed.';
  if (flags.noSubsetting) return 'The font’s licence doesn’t allow a part of it to be embedded, so nothing was changed.';
  if (flags.bitmapOnly) return 'The font’s licence only allows its bitmaps to be embedded, so nothing was changed.';
  return null;
}

/**
 * A bundled font read: { font (fontkit's), bytes, refusal } — each read once. Rejects when the key
 * isn't a registered face or its file can't be read as one font.
 */
export function readBundledFont(key) {
  if (!loaded.has(key)) {
    loaded.set(key, (async () => {
      const parsed = bundledKey(key);
      const read = parsed && families.get(parsed.family)?.faces.get(parsed.style);
      if (!read) throw new Error(`No bundled font ${key}.`);
      const bytes = await read();
      const fontkit = await loadFontkit();
      const font = fontkit.create(bytes);
      if (!font || !font.unitsPerEm || typeof font.layout !== 'function') throw new Error(`${key} isn’t one font.`);
      return { font, bytes, refusal: licenceRefusal(font) };
    })());
    loaded.get(key).catch(() => loaded.delete(key)); // a file that couldn't be read is read again next time
  }
  return loaded.get(key);
}

/**
 * A face of a font fontkit has read (objects/text-format.js): its glyphs laid out without shaping, and
 * their own advance widths. `show`, when given, is the operator that draws that text (a `Tj` of an
 * embedded font's encodeText); a face planned with has none.
 */
export function fontkitFace(font, { name, refusal = null, show = null }) {
  const em = font.unitsPerEm;
  return {
    name,
    refusal,
    ascent: font.ascent / em,
    descent: Math.min(font.descent, 0) / em,
    underline: { position: font.underlinePosition / em, thickness: font.underlineThickness / em },
    missing: (text) => [...new Set([...text].filter((ch) => ch !== '\n' && !font.hasGlyphForCodePoint(ch.codePointAt(0))))],
    unshaped: (text) => [...new Set([...text].filter((ch) => NEEDS_SHAPING.test(ch)))],
    advance: (text) => (text ? font.layout(text, noShaping()).glyphs.reduce((sum, glyph) => sum + glyph.advanceWidth, 0) / em : 0),
    ...(show ? { show } : {}),
  };
}

/** A bundled face's name, as a refusal says it: the family's name and its style (“Sans Bold Italic”). */
function faceName(key) {
  const { family, style } = bundledKey(key);
  const suffix = style === 'regular' ? '' : ` ${style.split('-').map((w) => w[0].toUpperCase() + w.slice(1)).join(' ')}`;
  return `${families.get(family)?.name ?? family}${suffix}`;
}

/** The standard fonts alone: what new text is planned in where no bundled font is wanted. */
export function standardFontSet(lib) {
  const standard = standardFaces(lib);
  return { families: STANDARD_FAMILIES, face: (key) => (FONTS.includes(key) ? standard(key) : null) };
}

// ---- the document's own fonts ---------------------------------------------------------------------
//
//   'doc:<object>-<generation>'   a font the opened PDF already has (its font dictionary's object), written
//                                with the codes pdf.js confirmed it draws (editing/fonts.js FontModel.planText)
//
// Only characters the document has been SEEN to draw in that font are written, each with exactly the code
// and width pdf.js drew it with — never a glyph looked up in the font program, which is never changed or
// read. A space the font doesn't draw is a gap as wide as its space, or a quarter em, as for edited text
// (objects/text-run.js). The table a record was planned with is kept in the record (`glyphs`), and the
// writer checks every entry of it against the font dictionary it writes with, so a record never draws
// codes that mean something else there.

const SPACE_GAP = 250; // thousandths of an em: a space the font doesn't draw, as objects/text-run.js writes one

/** A FontModel's key ('12 0 R') as a font key, or null for a font that isn't an object of its own. */
const keyOfModel = (model) => {
  const match = /^(\d+) (\d+) R$/.exec(model?.key ?? '');
  return match ? `doc:${match[1]}-${match[2]}` : null;
};

/** “LiberationSans-BoldItalic” → “Liberation Sans Bold Italic”: a PostScript name as a person reads it. */
const readable = (name) => name.replace(/[-,_]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/\s+/g, ' ').trim();

/** Can new text be written in this font of the document: embedded, drawn left to right, text and not pictures, confirmed by pdf.js? */
function usableModel(model) {
  if (!model || !keyOfModel(model) || !model.embedded || model.kind === 'type3' || model.vertical || model.symbolFont) return false;
  if (['unreadable-font', 'metrics', 'cmap', 'tounicode', 'encoding'].some((issue) => model.issues.has(issue))) return false;
  return model.verified.size > 0;
}

/** The width of a space the font doesn't draw, in its own thousandths: its space's width where the file says it, else a quarter em. */
function spaceGap(model) {
  const width = model.kind === 'simple' && model.unicodeOf(32) === ' ' ? model.widthOf(32) : null;
  return width > 0 ? width : SPACE_GAP;
}

/**
 * A face of a document font from what a record holds (`table`: character → [code, byteLength, width], a
 * space the font doesn't draw as [null, 0, width]): what the writer lays out and draws with. `table` must
 * already have been checked against the font.
 */
export function tableFace(table, { name, ascent, descent }) {
  const entry = (ch) => (Object.hasOwn(table, ch) ? table[ch] : null);
  return {
    name,
    ascent,
    descent,
    underline: { position: -0.1, thickness: 0.05 }, // the file doesn't say: a rule a tenth of an em below the baseline
    missing: (text) => [...new Set([...text].filter((ch) => ch !== '\n' && !entry(ch)))],
    unshaped: (text) => [...new Set([...text].filter((ch) => NEEDS_SHAPING.test(ch)))],
    advance: (text) => [...text].reduce((sum, ch) => sum + (entry(ch)?.[2] ?? 0), 0) / 1000,
    /** A `Tj` of the glyphs, or a `TJ` whose gaps are the spaces the font doesn't draw. */
    show: (text) => {
      const parts = [];
      let glyphs = [];
      for (const ch of text) {
        const [value, length, width] = entry(ch);
        if (value === null) {
          if (glyphs.length) parts.push(glyphs);
          glyphs = [];
          parts.push(-width);
          continue;
        }
        for (let i = length - 1; i >= 0; i--) glyphs.push((value >> (8 * i)) & 0xff);
      }
      if (glyphs.length) parts.push(glyphs);
      const hex = (bytes) => `<${bytes.map((b) => b.toString(16).padStart(2, '0')).join('')}>`;
      if (parts.length === 1 && Array.isArray(parts[0])) return `${hex(parts[0])} Tj`;
      return `[${parts.map((p) => (Array.isArray(p) ? hex(p) : String(Math.round(p * 1000) / 1000))).join(' ')}] TJ`;
    },
    /** The table entries for `text`'s characters, for a record to keep. */
    glyphs: (text) => Object.fromEntries([...new Set(text)].filter((ch) => ch !== '\n' && entry(ch)).map((ch) => [ch, entry(ch)])),
  };
}

/** A document font's face, from what pdf.js has confirmed it draws so far. */
function documentFace(model) {
  const table = {};
  const gap = spaceGap(model);
  const lookup = (ch) => {
    if (Object.hasOwn(table, ch)) return;
    const plan = model.planText(ch);
    const item = plan.ok && plan.items.length === 1 ? plan.items[0] : null;
    if (item && !item.space && item.text === ch && Number.isInteger(item.code) && item.width > 0) table[ch] = [item.code, item.byteLength, item.width];
    else if (ch === ' ' && (!item || item.space)) table[ch] = [null, 0, gap];
  };
  const face = tableFace(table, { name: readable(model.name || 'Document font'), ascent: model.ascent, descent: model.descent });
  const withLookup = (fn) => (text) => {
    for (const ch of text) if (ch !== '\n') lookup(ch);
    return fn(text);
  };
  return {
    ...face,
    missing: withLookup(face.missing),
    advance: withLookup(face.advance),
    show: withLookup(face.show),
    glyphs: withLookup(face.glyphs),
    document: true,
  };
}

/**
 * The document's own fonts as families, from its FontModels (editing/source.js PdfSource.fonts): the
 * usable ones, grouped by family name with each one's bold and italic from the font itself. Where a
 * family has two fonts of one style (two subsets), the one pdf.js has confirmed more glyphs of is used.
 * `loaded` maps a FontModel key to the name pdf.js loaded it under, for showing it while typing.
 */
export function documentFontSet(models, loaded = new Map()) {
  const groups = new Map();
  for (const model of models) {
    if (!usableModel(model)) continue;
    const base = model.name.replace(/[-,].*$/, '') || model.name;
    const id = `doc:${base}`;
    const group = groups.get(id) ?? { id, name: readable(base), models: [null, null, null, null] };
    const i = (model.flags.bold ? 1 : 0) + (model.flags.italic ? 2 : 0);
    if (!group.models[i] || model.verified.size > group.models[i].verified.size) group.models[i] = model;
    groups.set(id, group);
  }
  const faces = new Map();
  const families = [...groups.values()].map(({ id, name, models: chosen }) => {
    const keys = chosen.map((m) => (m ? keyOfModel(m) : null));
    chosen.forEach((m, i) => { if (m) faces.set(keys[i], { model: m, face: null }); });
    const css = chosen.map((m) => {
      const generic = m?.flags.fixedPitch ? 'monospace' : m?.flags.serif ? 'serif' : 'sans-serif';
      return m && loaded.get(m.key) ? `"${loaded.get(m.key)}", ${generic}` : generic;
    });
    return { id, name, group: 'document', faces: keys, css };
  });
  return {
    families,
    face: (key) => {
      const found = faces.get(key);
      if (!found) return null;
      found.face ??= documentFace(found.model);
      return found.face;
    },
  };
}

/** A font set with the document's own fonts added: the standard families, the document's, then the bundled ones. */
export function withDocumentFonts(set, models, loaded) {
  const documents = documentFontSet(models, loaded);
  const standard = set.families.filter((f) => STANDARD_FAMILIES.includes(f));
  const rest = set.families.filter((f) => !STANDARD_FAMILIES.includes(f));
  return {
    families: [...standard, ...documents.families, ...rest],
    face: (key) => (documentKey(key) ? documents.face(key) : set.face(key)),
    load: (keys) => set.load?.(keys),
  };
}

/**
 * The faces of a record's document fonts for writing: each key's table from the record checked, entry
 * by entry, against the font dictionary `source` (editing/source.js) reads at that object — the code must
 * be one character long in the font, mean that character and have that width. Map key → face, or
 * null when anything doesn't match.
 */
export function checkedDocumentFaces(lib, source, record, keys) {
  const faces = new Map();
  for (const key of keys) {
    const parsed = documentKey(key);
    const table = record.glyphs?.[key];
    if (!parsed || !table || typeof table !== 'object') return null;
    let model = null;
    try {
      model = source.fontFor(lib.PDFRef.of(parsed.objectNumber, parsed.generation), parsed.ref);
    } catch {
      return null;
    }
    if (!model || model.key !== parsed.ref || !model.embedded || model.kind === 'type3' || model.vertical) return null;
    for (const [ch, entry] of Object.entries(table)) {
      if (!Array.isArray(entry) || entry.length !== 3 || [...ch].length !== 1) return null;
      const [code, length, width] = entry;
      if (code === null) {
        if (ch !== ' ' || length !== 0 || !(width > 0 && width <= 2000)) return null;
        continue;
      }
      if (!Number.isInteger(code) || !Number.isInteger(length) || length < 1 || length > 4 || !(width > 0)) return null;
      const bytes = Uint8Array.from({ length }, (_, i) => (code >> (8 * (length - 1 - i))) & 0xff);
      const decoded = model.decode(bytes);
      if (decoded.length !== 1 || decoded[0].code !== code || decoded[0].unicode !== ch || decoded[0].width !== width) return null;
    }
    faces.set(key, { face: tableFace(table, { name: readable(model.name), ascent: model.ascent, descent: model.descent }), ref: lib.PDFRef.of(parsed.objectNumber, parsed.generation) });
  }
  return faces;
}

/**
 * Every font new text may be written in: the standard families, then the bundled families. A bundled face
 * is read only when it is wanted — `load(keys)` reads the faces those font keys name (a family's id: all of
 * its faces), and until then `face(key)` is null for it, so text is never planned in a face that hasn't been
 * measured. A family any of whose faces couldn't be read is no longer offered. `lib` is pdf-lib.
 */
export async function fontSet(lib) {
  const standard = standardFontSet(lib);
  const faces = new Map();
  const unreadable = new Set();
  return {
    get families() {
      return [...standard.families, ...bundledFamilies().filter((family) => !unreadable.has(family.id))];
    },
    face: (key) => standard.face(key) ?? faces.get(key) ?? null,
    async load(keys) {
      const wanted = new Set();
      for (const key of keys ?? []) {
        const family = bundledKey(key)?.family ?? (families.has(key) ? key : null);
        if (!family || unreadable.has(family)) continue;
        if (family === key) bundledFamilies().find((f) => f.id === family).faces.forEach((k) => { if (k) wanted.add(k); });
        else wanted.add(key);
      }
      await Promise.all([...wanted].filter((key) => !faces.has(key)).map(async (key) => {
        const read = await readBundledFont(key).catch(() => null);
        if (!read) unreadable.add(bundledKey(key).family); // a face that can't be read: the family isn't offered
        else faces.set(key, fontkitFace(read.font, { name: faceName(key), refusal: read.refusal }));
      }));
    },
  };
}

/**
 * The bundled fonts `keys` names, embedded in `doc` for writing: Map key → { font (pdf-lib's PDFFont),
 * face (whose `show` is that font's encodeText) }. pdf-lib embeds each as a subset of the glyphs shown
 * with it when the document is saved. EditError when one can't be read or may not be embedded.
 */
export async function embedBundledFonts(lib, doc, keys) {
  const wanted = [...new Set(keys)].filter((key) => bundledKey(key));
  const embedded = new Map();
  if (!wanted.length) return embedded;
  doc.registerFontkit(await loadFontkit());
  for (const key of wanted) {
    const read = await readBundledFont(key).catch(() => null);
    if (!read) throw new EditError('font', 'New text is written in a font Vellum can’t read any more, so nothing was saved.', { font: key });
    if (read.refusal) throw new EditError('font', read.refusal, { font: key });
    const font = await doc.embedFont(read.bytes, { subset: true, features: noShaping() });
    embedded.set(key, { font, face: fontkitFace(font.embedder.font, { name: faceName(key), show: (text) => `${font.encodeText(text).toString()} Tj` }) });
  }
  return embedded;
}
