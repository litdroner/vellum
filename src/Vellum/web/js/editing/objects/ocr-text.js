// The invisible text layer OCR (ocr/engine.js) puts on a scanned page: the words Tesseract read, drawn
// in text render mode 3 (neither filled nor stroked) after the page's own content. The page looks
// exactly as it did (its picture and everything else are untouched) while its text can be searched,
// selected and copied, in Vellum and in every other reader.
//
//   { id, kind: 'ocr', entry, lang, words: [[text, ox, oy, ex, ey, size], ...] }
//     entry   the page plan entry (pages/plan.js) the layer belongs to: it moves with its page
//     words   each word's baseline, from its start (ox, oy) to its end (ex, ey), and its line height,
//             in the ORIGINAL page's user space; text is what was read, with the space after it
//
// Written in the standard Helvetica font, not embedded: invisible text never shows its shapes, and
// every reader has the font's metrics. Each word is stretched (Tz) to cover the width it has on the
// page and turned to run along its baseline, so a selection lands on the word the scan shows.

import { EditError } from '../edits.js';
import { addStandardFont } from './text-run.js';
import { hexString, num, pdfName } from '../content/writer.js';

export const kind = 'ocr';

const FONT = 'Helvetica';

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

/** One page's recognised text: nothing patched, drawn invisibly after the page. */
export function write({ lib, doc, page, index, records }) {
  const embedder = lib.StandardFontEmbedder.for(FONT);
  const font = pdfName(addStandardFont(lib, doc, page, FONT));
  const append = records.map((record) => {
    const unusable = () => new EditError('content', `The recognised text on page ${index + 1} can’t be written as it is, so nothing was changed.`);
    if (!Array.isArray(record.words)) throw unusable();
    const out = ['q', 'BT', '3 Tr 0 Tc 0 Tw 0 Ts'];
    for (const word of record.words) {
      const [text, ox, oy, ex, ey, size] = Array.isArray(word) ? word : [];
      if (typeof text !== 'string' || ![ox, oy, ex, ey, size].every(Number.isFinite) || !(size > 0)) throw unusable();
      const length = Math.hypot(ex - ox, ey - oy);
      const { codes, shown } = encodeWord(lib, text);
      // The width is the word's own: a space after it runs on past its end, into the gap before the next.
      const width = embedder.widthOfTextAtSize(shown.trimEnd(), size);
      if (!(length > 0) || !(width > 0)) continue;
      const [ux, uy] = [(ex - ox) / length, (ey - oy) / length];
      out.push(
        `${font} ${num(size)} Tf`,
        `${num((100 * length) / width)} Tz`,
        `${[ux, uy, -uy, ux, ox, oy].map(num).join(' ')} Tm`,
        `${hexString(codes)} Tj`,
      );
    }
    out.push('ET', 'Q');
    return out.join('\n');
  });
  return { patches: [], append };
}
