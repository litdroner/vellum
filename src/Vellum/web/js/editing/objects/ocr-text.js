// The invisible text layer OCR (ocr/engine.js) puts on a scanned page: the words Tesseract read, drawn
// in text render mode 3 (neither filled nor stroked) after the page's own content. The page looks
// exactly as it did (its picture and everything else are untouched) while its text can be searched,
// selected and copied, in Vellum and in every other reader.
//
//   { id, kind: 'ocr', entry, lang, words: [[text, ox, oy, ex, ey, size], ...] }
//     entry   the page plan entry (pages/plan.js) the layer belongs to: it moves with its page
//     lang    the Tesseract language the words were read in: it chooses the font (below)
//     words   each word's baseline, from its start (ox, oy) to its end (ex, ey), and its line height,
//             in the ORIGINAL page's user space; text is what was read, with the space after it
//
// Latin-script languages are written in the standard Helvetica font, not embedded: invisible text never
// shows its shapes, and every reader has the font's metrics. Helvetica's WinAnsi encoding has no letters
// of other scripts, so a language in UNICODE_FONTS is written in a bundled font (objects/font-set.js)
// embedded as a subset of the glyphs its words use, whose ToUnicode map gives readers the real letters.
// Those words are laid out one glyph per character, never shaped: the text is invisible, so only the
// letters matter, and a shaped script (Devanagari) keeps them in their order rather than as drawn.
// Each word is stretched (Tz) to cover the width it has on the page and turned to run along its
// baseline, so a selection lands on the word the scan shows.

import { EditError } from '../edits.js';
import { addResource, addStandardFont } from './text-run.js';
import { embedBundledFonts } from './font-set.js';
import { hexString, num, pdfName } from '../content/writer.js';

export const kind = 'ocr';

const FONT = 'Helvetica';

/**
 * Languages whose letters Helvetica can't write, and the bundled font their text layer is embedded in: one
 * with a glyph for every letter of the script (tests/editing/ocr-languages.test.mjs checks). Only left-to-
 * right scripts belong here; one that needs shaping (Hindi) is written unshaped (below), as visible text
 * never is (objects/font-set.js: NEEDS_SHAPING).
 */
export const UNICODE_FONTS = Object.freeze({ rus: 'bundled:notosans/regular', hin: 'bundled:notosans/regular' });

/** The bundled font key the words of `lang` are written in, or null for Helvetica. */
export const unicodeFontOf = (lang) => (Object.hasOwn(UNICODE_FONTS, lang) ? UNICODE_FONTS[lang] : null);

/** The character codes Helvetica writes `text` with: accents it lacks folded away, anything else dropped. */
export function encodeWord(lib, text) {
  const { encoding } = lib.StandardFontEmbedder.for(FONT);
  const codes = [];
  let shown = '';
  for (const ch of String(text).normalize('NFC')) {
    const cp = ch.codePointAt(0);
    const usable = encoding.canEncodeUnicodeCodePoint(cp) ? ch
      : [...ch.normalize('NFKD').replace(/\p{M}/gu, '')].filter((c) => encoding.canEncodeUnicodeCodePoint(c.codePointAt(0))).join('');
    for (const c of usable) {
      codes.push(encoding.encodeUnicodeCodePoint(c.codePointAt(0)).code);
      shown += c;
    }
  }
  return { codes, shown };
}

/** `text` as an embedded font writes it: the characters the font has a glyph for (anything else dropped). */
const unicodeWord = (font, text) => [...String(text).normalize('NFC')].filter((ch) => font.embedder.font.hasGlyphForCodePoint(ch.codePointAt(0))).join('');

/**
 * The embedded font's embedder, laying text out as each character's own glyph (the font's cmap), in order:
 * no substitution, reordering or ligatures, so its ToUnicode map gives back exactly the characters written.
 * Everything else (the subset, the glyphs it includes) is the embedder's own.
 */
const unshaped = (font) => Object.create(font.embedder, {
  font: { value: { layout: (text) => ({ glyphs: [...text].map((ch) => font.embedder.font.glyphForCodePoint(ch.codePointAt(0))) }) } },
});

/** The bundled fonts the records' languages need, embedded once for the whole document. */
export function prepare({ lib, doc, records }) {
  return embedBundledFonts(lib, doc, records.map((r) => unicodeFontOf(r.lang)).filter(Boolean));
}

/** One page's recognised text: nothing patched, drawn invisibly after the page. `prepared` is prepare()'s. */
export function write({ lib, doc, page, index, records, prepared = null }) {
  const embedder = lib.StandardFontEmbedder.for(FONT);
  let helvetica = null;
  const names = new Map(); // bundled font key → its name in this page's /Font resources
  const append = records.map((record) => {
    const unusable = () => new EditError('content', `The recognised text on page ${index + 1} can’t be written as it is, so nothing was changed.`);
    if (!Array.isArray(record.words)) throw unusable();
    const key = unicodeFontOf(record.lang);
    const embedded = key ? prepared?.get(key)?.font : null;
    if (key && !embedded) throw unusable();
    const layout = embedded ? unshaped(embedded) : null;
    let font;
    if (embedded) {
      if (!names.has(key)) names.set(key, pdfName(addResource(lib, doc, page, 'Font', 'VlF', embedded.ref)));
      font = names.get(key);
    } else font = helvetica ??= pdfName(addStandardFont(lib, doc, page, FONT));
    const out = ['q', 'BT', '3 Tr 0 Tc 0 Tw 0 Ts'];
    for (const word of record.words) {
      const [text, ox, oy, ex, ey, size] = Array.isArray(word) ? word : [];
      if (typeof text !== 'string' || ![ox, oy, ex, ey, size].every(Number.isFinite) || !(size > 0)) throw unusable();
      const length = Math.hypot(ex - ox, ey - oy);
      let shown;
      let shows;
      if (embedded) {
        shown = unicodeWord(embedded, text);
        shows = `${layout.encodeText(shown).toString()} Tj`;
        embedded.modified = true; // re-embedded with these glyphs when the document is saved
      } else {
        const encoded = encodeWord(lib, text);
        shown = encoded.shown;
        shows = `${hexString(encoded.codes)} Tj`;
      }
      // The width is the word's own: a space after it runs on past its end, into the gap before the next.
      const width = (layout ?? embedder).widthOfTextAtSize(shown.trimEnd(), size);
      if (!(length > 0) || !(width > 0)) continue;
      const [ux, uy] = [(ex - ox) / length, (ey - oy) / length];
      out.push(
        `${font} ${num(size)} Tf`,
        `${num((100 * length) / width)} Tz`,
        `${[ux, uy, -uy, ux, ox, oy].map(num).join(' ')} Tm`,
        shows,
      );
    }
    out.push('ET', 'Q');
    return out.join('\n');
  });
  return { patches: [], append };
}
