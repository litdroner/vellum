// Runs before the stylesheet paints: re-applies the saved appearance (see themes.js), page colours
// and comfort settings, so nothing flashes in the wrong colours on start.
(() => {
  const root = document.documentElement;
  const read = (key) => { try { return localStorage.getItem(key); } catch { return null; } };
  const vars = {
    bg: '--bg', surface: '--surface', tint: '--tint', accent: '--accent', accent2: '--accent-2',
    accent3: '--accent-3', ink: '--ink', shadow: '--shadow', onAccent: '--on-accent', accentInk: '--accent-ink',
  };
  try {
    const saved = JSON.parse(read('vellum.appearance.seeds') || 'null');
    let mode = saved ? saved.mode : (read('vellum.theme') === 'dark' ? 'dark' : 'light');
    if (mode === 'system') mode = matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    root.dataset.theme = mode === 'dark' ? 'dark' : 'light';
    const seeds = saved && saved[root.dataset.theme];
    if (seeds) for (const key in vars) if (seeds[key]) root.style.setProperty(vars[key], seeds[key]);
  } catch { /* keep the stylesheet defaults (Mist) */ }
  const tone = read('vellum.pageTone');
  root.dataset.pageTone = tone === 'dark' || tone === 'sepia' ? tone : 'normal';
  if (read('vellum.motion') === 'reduced') root.dataset.motion = 'reduced';
  if (read('vellum.glass') === 'off') root.dataset.glass = 'off';
})();
