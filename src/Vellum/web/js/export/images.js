// Export Center V1 — PDF to JPEG and PNG. One image per page, drawn by the same pdf.js renderer the viewer
// and printing use (print.js), at a fixed resolution, on white. Annotations Vellum has drawn are painted on
// top exactly as printing paints them, so the image is the page as it is on screen. Nothing is written here
// and the document is never changed.
//
// There is no second renderer and no image library: the page is rendered to a canvas and the canvas encodes
// itself (canvas.toBlob), which is Chromium's own JPEG and PNG encoder in WebView2.
//
// `createCanvas` and `paint` are given in, so the exporter can be driven without a browser in tests.

export const EXPORT_DPI = 150;
export const JPEG_QUALITY = 0.92;

/** The pdf.js viewport scale for a resolution in dots per inch (a PDF point is 1/72 inch). */
export const dpiScale = (dpi = EXPORT_DPI) => dpi / 72;

const defaultCanvas = (width, height) => Object.assign(document.createElement('canvas'), { width, height });

/**
 * One page as image bytes (Uint8Array).
 *   pdf        the pdf.js document
 *   number     the 1-based page
 *   format     an EXPORT_FORMATS entry of kind 'image'
 *   paint      optional (ctx, number, viewport): Vellum's own annotations, as printing paints them
 *   pdfjsLib   pdf.js, for AnnotationMode (the PDF's own form and annotation appearances)
 */
export async function renderPageImage({ pdf, number, format, dpi = EXPORT_DPI, quality = JPEG_QUALITY, paint = null, pdfjsLib = null, createCanvas = defaultCanvas, signal = null }) {
  const page = await pdf.getPage(number);
  const viewport = page.getViewport({ scale: dpiScale(dpi) });
  const canvas = createCanvas(Math.max(1, Math.floor(viewport.width)), Math.max(1, Math.floor(viewport.height)));
  const ctx = canvas.getContext('2d');
  // A PDF page is paper: JPEG has no transparency and PNG should not be see-through either.
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  try {
    await page.render({
      canvas, canvasContext: ctx, viewport, intent: 'print',
      annotationMode: pdfjsLib?.AnnotationMode?.ENABLE_STORAGE,
    }).promise;
    if (signal?.aborted) throw new Error('Export cancelled.');
    await paint?.(ctx, number, viewport);
    return await canvasBytes(canvas, format.mime, quality);
  } finally {
    canvas.width = canvas.height = 0; // release the bitmap right away, as printing does
  }
}

/** The canvas encoded as its format's bytes. */
async function canvasBytes(canvas, mime, quality) {
  const blob = await new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('The page couldn’t be turned into an image.'))), mime, quality);
  });
  return new Uint8Array(await blob.arrayBuffer());
}
