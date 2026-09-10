// Vellum's mark: a sheet with a folded corner, two lines of text and a highlighter stroke between them.
// Monoline, like the icon set.
export function markSvg(size = 18) {
  return `<svg class="mark" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M7 3.5h7l4.5 4.5v11.2a1.3 1.3 0 0 1-1.3 1.3H7a1.3 1.3 0 0 1-1.3-1.3V4.8A1.3 1.3 0 0 1 7 3.5z" stroke="currentColor" stroke-width="1.6"/>
    <path d="M14 3.5V7a1 1 0 0 0 1 1h3.5" stroke="var(--aqua)" stroke-width="1.6"/>
    <path d="M9 11.6h5.6" stroke="currentColor" stroke-width="1.6" opacity=".55"/>
    <path d="M8.8 14.6h6.6" stroke="var(--peach)" stroke-width="2.6" opacity=".9"/>
    <path d="M9 17.6h3.8" stroke="currentColor" stroke-width="1.6" opacity=".55"/>
  </svg>`;
}
