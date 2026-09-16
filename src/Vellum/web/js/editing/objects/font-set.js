// The fonts new text may be written in, as one set (docs/VELLUM_VISION.md §4.3): families of faces, each
// face named by the font key a record holds (objects/text-format.js):
//
//   'Helvetica-Bold', …          a standard PDF font: measured from pdf-lib's metrics, never embedded
//   'bundled:<family>/<style>'   a font bundled with Vellum (web/fonts/document): read by fontkit, and
//                                embedded — a subset of the glyphs the text uses — when the file is saved
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
import { STANDARD_FAMILIES, STYLES, bundledKey, FONTS, standardFaces } from './text-format.js';

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

/**
 * The document fonts bundled with Vellum, as their files in web/fonts/document: { id, name, faces:
 * { regular, bold?, italic?, 'bold-italic'? } }. A font is listed here only with its licence beside it
 * in that folder, and only when the licence allows bundling it, using it in the app and embedding it in PDFs.
 */
const BUNDLED = Object.freeze([]);

const FONTS_DIR = new URL('../../../fonts/document/', import.meta.url);

/** family id → { id, name, faces: Map style → () => Promise<Uint8Array> } */
const families = new Map();
/** font key → Promise<{ font, bytes, refusal }> */
const loaded = new Map();

/**
 * Makes a family of bundled fonts available: `id` (lower-case letters, digits and hyphens), its `name` as
 * the font selector shows it, and `faces`, style → the font file's bytes or a function that reads them.
 * The fonts listed in BUNDLED are registered this way when this module loads; tests register their own.
 */
export function registerBundledFamily({ id, name, faces }) {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id) || typeof name !== 'string' || !name) throw new TypeError('A bundled family needs an id and a name.');
  const readers = new Map();
  for (const [style, source] of Object.entries(faces)) {
    if (!STYLES.includes(style)) throw new TypeError(`Unknown style ${style}.`);
    readers.set(style, typeof source === 'function' ? source : async () => source);
  }
  if (!readers.has('regular')) throw new TypeError('A bundled family needs a regular face.');
  families.set(`bundled:${id}`, { id: `bundled:${id}`, name, faces: readers });
  for (const style of STYLES) loaded.delete(`bundled:${id}/${style}`);
}

for (const { id, name, faces } of BUNDLED) {
  registerBundledFamily({
    id,
    name,
    faces: Object.fromEntries(Object.entries(faces).map(([style, file]) => [style, async () => {
      const response = await fetch(new URL(file, FONTS_DIR));
      if (!response.ok) throw new Error(`${file}: ${response.status}`);
      return new Uint8Array(await response.arrayBuffer());
    }])),
  });
}

/** The bundled families, as the font selector lists them (faces as keys; null where a family hasn't got one). */
export function bundledFamilies() {
  return [...families.values()].map(({ id, name, faces }) => ({
    id, name, faces: STYLES.map((style) => (faces.has(style) ? `${id}/${style}` : null)),
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
 * their own advance widths. `show`, when given, is what a `Tj` of that text shows (an embedded font's
 * encodeText); a face planned with has none.
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

/**
 * Every font new text may be written in: the standard families, then the bundled families whose faces
 * could all be read. `lib` is pdf-lib.
 */
export async function fontSet(lib) {
  const standard = standardFontSet(lib);
  const faces = new Map();
  const usable = [];
  for (const family of bundledFamilies()) {
    const read = await Promise.all(family.faces.map((key) => (key ? readBundledFont(key).catch(() => null) : null)));
    if (read.some((r, i) => family.faces[i] && !r)) continue; // a face that can't be read: the family isn't offered
    read.forEach((r, i) => { if (r) faces.set(family.faces[i], fontkitFace(r.font, { name: faceName(family.faces[i]), refusal: r.refusal })); });
    usable.push(family);
  }
  return {
    families: [...standard.families, ...usable],
    face: (key) => standard.face(key) ?? faces.get(key) ?? null,
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
    embedded.set(key, { font, face: fontkitFace(font.embedder.font, { name: faceName(key), show: (text) => font.encodeText(text).toString() }) });
  }
  return embedded;
}
