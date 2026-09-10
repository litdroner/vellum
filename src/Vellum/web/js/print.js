import { h } from './dom.js';

// Printing: render every page to an image at print resolution, put them in a print-only container,
// then open the standard print dialog (printer choice, page range, copies, preview).
// This is the same approach Firefox's built-in PDF viewer uses.

const PRINT_DPI = 150;
let busy = false;

export async function printDocument(view, pdfjsLib) {
  if (busy || !view?.pdf) return;
  busy = true;
  const pdf = view.pdf;
  const total = pdf.numPages;
  let cancelled = false;

  const fill = h('div', { class: 'progress-fill' });
  const label = h('p', { class: 'dialog-message', text: `Page 1 of ${total}` });
  const panel = h('div', { class: 'dialog-backdrop ui open' },
    h('div', { class: 'dialog', role: 'dialog', 'aria-modal': 'true' },
      h('h2', { class: 'dialog-title', text: 'Preparing to print' }),
      label,
      h('div', { class: 'progress' }, fill),
      h('div', { class: 'dialog-actions' },
        h('button', { class: 'btn', onClick: () => { cancelled = true; } }, 'Cancel'))));
  document.getElementById('overlay-root').append(panel);

  const container = h('div', { id: 'print-container' });
  const pageStyle = h('style');
  const urls = [];
  try {
    const first = await pdf.getPage(1);
    const size = first.getViewport({ scale: 1 });
    pageStyle.textContent = `@page { size: ${size.width}pt ${size.height}pt; margin: 0; }`;

    for (let n = 1; n <= total && !cancelled; n++) {
      label.textContent = `Page ${n} of ${total}`;
      fill.style.width = `${((n - 1) / total) * 100}%`;
      const page = await pdf.getPage(n);
      const viewport = page.getViewport({ scale: PRINT_DPI / 72 });
      const canvas = document.createElement('canvas');
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({
        canvas, canvasContext: ctx, viewport, intent: 'print',
        annotationMode: pdfjsLib.AnnotationMode.ENABLE_STORAGE,
      }).promise;
      // Annotations drawn in Vellum are painted on top (added in the annotations phase).
      await view.paintAnnotations?.(ctx, n, viewport);
      const blob = await new Promise((resolve) => canvas.toBlob(resolve));
      const url = URL.createObjectURL(blob);
      urls.push(url);
      container.append(h('div', { class: 'print-page' }, h('img', { src: url, alt: '' })));
      canvas.width = canvas.height = 0; // release the bitmap right away
    }
    if (cancelled) return;

    fill.style.width = '100%';
    document.head.append(pageStyle);
    document.body.append(container);
    await Promise.all([...container.querySelectorAll('img')].map((img) => img.decode().catch(() => {})));
    panel.remove();
    await new Promise((resolve) => {
      window.addEventListener('afterprint', resolve, { once: true });
      window.print();
    });
  } finally {
    panel.remove();
    container.remove();
    pageStyle.remove();
    urls.forEach((url) => URL.revokeObjectURL(url));
    busy = false;
  }
}
