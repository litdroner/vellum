import { newId } from '../annotations/model.js';

// Local OCR: Tesseract 5 compiled to WebAssembly (tesseract.js), run in a worker inside Vellum with
// the English model bundled in vendor/tesseract. Nothing is downloaded and no page leaves the machine.
//
// A page is rendered by pdf.js as it is shown, read by Tesseract, and each word it finds is turned
// into page coordinates: the record editing/objects/ocr-text.js writes as invisible text.

const VENDOR = new URL('../../vendor/tesseract/', import.meta.url).href;
/** Tesseract reads best at about 300 dpi; the longer side stays within MAX_SIDE pixels. */
const DPI = 300;
const MAX_SIDE = 5000;
/** A page with this many letters or digits of real text already has a usable text layer. */
const USABLE_TEXT = 12;
/** Below this confidence a "word" is almost always a speck or a stroke of the picture. */
const MIN_CONFIDENCE = 15;

export const LANGUAGE = 'eng';

/** True when the page already has enough real text to search and select. */
export async function hasUsableText(pdfPage) {
  const { items } = await pdfPage.getTextContent();
  let letters = 0;
  for (const item of items) {
    letters += item.str?.match(/[\p{L}\p{N}]/gu)?.length ?? 0;
    if (letters >= USABLE_TEXT) return true;
  }
  return false;
}

/**
 * Starts the OCR engine. `onProgress(fraction)` follows the page being read. Resolves with
 * { recognize(pdfPage, entryId) → record or null when no text was found, terminate() }.
 */
export async function createRecognizer({ onProgress = null } = {}) {
  const { default: Tesseract } = await import('../../vendor/tesseract/tesseract.esm.min.js');
  const worker = await Tesseract.createWorker(LANGUAGE, Tesseract.OEM.LSTM_ONLY, {
    workerPath: `${VENDOR}worker.min.js`,
    corePath: `${VENDOR}tesseract-core-simd-lstm.wasm.js`,
    langPath: VENDOR.replace(/\/$/, ''),
    gzip: true,
    cacheMethod: 'none',
    workerBlobURL: false,
    logger: (m) => { if (m.status === 'recognizing text') onProgress?.(m.progress); },
  });

  return {
    async recognize(pdfPage, entryId) {
      const unscaled = pdfPage.getViewport({ scale: 1 });
      const viewport = pdfPage.getViewport({ scale: Math.min(DPI / 72, MAX_SIDE / Math.max(unscaled.width, unscaled.height)) });
      const canvas = document.createElement('canvas');
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      const ctx = canvas.getContext('2d', { alpha: false });
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      await pdfPage.render({ canvas, canvasContext: ctx, viewport }).promise;
      const { data } = await worker.recognize(canvas, {}, { text: false, blocks: true });
      canvas.width = canvas.height = 0;
      const words = wordsOf(data.blocks ?? [], viewport);
      return words.length ? { id: newId(), kind: 'ocr', entry: entryId, lang: LANGUAGE, words } : null;
    },
    terminate: () => worker.terminate(),
  };
}

/** Tesseract's words as [text, ox, oy, ex, ey, size] in page space (see editing/objects/ocr-text.js). */
function wordsOf(blocks, viewport) {
  const round = (v) => Math.round(v * 100) / 100;
  const out = [];
  for (const line of blocks.flatMap((b) => b.paragraphs ?? []).flatMap((p) => p.lines ?? [])) {
    const words = (line.words ?? []).filter((w) => w.text?.trim() && w.confidence >= MIN_CONFIDENCE);
    if (!words.length) continue;
    const box = line.bbox;
    const height = line.rowAttributes?.rowHeight > 0 ? line.rowAttributes.rowHeight : box.y1 - box.y0;
    const { x0, y0, x1, y1 } = line.baseline ?? { x0: box.x0, y0: box.y1, x1: box.x1, y1: box.y1 };
    const slope = x1 > x0 ? (y1 - y0) / (x1 - x0) : 0;
    const baseAt = (x) => y0 + slope * (x - x0);
    words.forEach((w, i) => {
      const o = viewport.convertToPdfPoint(w.bbox.x0, baseAt(w.bbox.x0));
      const e = viewport.convertToPdfPoint(w.bbox.x1, baseAt(w.bbox.x1));
      const up = viewport.convertToPdfPoint(w.bbox.x0, baseAt(w.bbox.x0) - height);
      const size = Math.hypot(up[0] - o[0], up[1] - o[1]);
      if (!(size > 0)) return;
      const text = w.text.trim() + (i < words.length - 1 ? ' ' : '');
      out.push([text, round(o[0]), round(o[1]), round(e[0]), round(e[1]), round(size)]);
    });
  }
  return out;
}
