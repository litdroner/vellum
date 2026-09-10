// Loads pdf.js (the engine) and its viewer components, all from the local vendor folder.

const base = new URL('../vendor/pdfjs/', import.meta.url);

export async function loadPdfjs() {
  const pdfjsLib = await import('../vendor/pdfjs/pdf.min.mjs');
  pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('pdf.worker.min.mjs', base).href;
  // The viewer components read the engine from this global, so it must be set before importing them.
  globalThis.pdfjsLib = pdfjsLib;
  const viewerLib = await import('../vendor/pdfjs/web/pdf_viewer.mjs');
  return { pdfjsLib, viewerLib };
}

/** Options every getDocument() call needs so fonts, CJK text and JPEG2000/JBIG2 images work offline. */
export const documentAssetOptions = {
  cMapUrl: new URL('cmaps/', base).href,
  cMapPacked: true,
  standardFontDataUrl: new URL('standard_fonts/', base).href,
  wasmUrl: new URL('wasm/', base).href,
  iccUrl: new URL('iccs/', base).href,
  isEvalSupported: false,
  enableXfa: false,
};
