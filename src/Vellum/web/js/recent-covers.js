// A small picture of a document's first page, stored by the host with the recent-files list so the
// home screen can show real covers without opening every file.

const WIDTH = 220;
const MAX_HEIGHT = 440;

/** Renders page 1 and resolves with a JPEG data URL. */
export async function captureCover(pdf) {
  const page = await pdf.getPage(1);
  const base = page.getViewport({ scale: 1 });
  const scale = Math.min(WIDTH / base.width, MAX_HEIGHT / base.height);
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(viewport.width));
  canvas.height = Math.max(1, Math.round(viewport.height));
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff'; // JPEG has no transparency; paper is white
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvas, canvasContext: ctx, viewport }).promise;
  return canvas.toDataURL('image/jpeg', 0.82);
}
