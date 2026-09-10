// Runs before the stylesheet paints, so the light theme never flashes dark first (and vice versa),
// and pages already have their chosen tone (normal / dark / sepia) when they first appear.
try {
  const theme = localStorage.getItem('vellum.theme');
  if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme;
  const tone = localStorage.getItem('vellum.pageTone');
  document.documentElement.dataset.pageTone = tone === 'dark' || tone === 'sepia' ? tone : 'normal';
} catch { /* storage unavailable: keep the defaults */ }
