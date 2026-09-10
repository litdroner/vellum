// Runs before the stylesheet paints, so the light theme never flashes dark first (and vice versa).
try {
  const theme = localStorage.getItem('vellum.theme');
  if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme;
} catch { /* storage unavailable: keep the default */ }
