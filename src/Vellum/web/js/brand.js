// Vellum's app icon: a sheet of cream clay paper with its top-right corner peeled back over the page,
// lying in a glass well inside a soft clay tile. SVG, so it's crisp at every size. Its colours follow an accent: the
// theme's own (CSS variables, in the app) or an explicit hex (theme swatches, the .ico file).

let uid = 0;
const HEX = /^#[0-9a-f]{6}$/i;

function hexMix(a, percent, b) {
  const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  const [x, y] = [rgb(a), rgb(b)];
  const t = percent / 100;
  return `#${x.map((v, i) => Math.round(v * t + y[i] * (1 - t)).toString(16).padStart(2, '0')).join('')}`;
}
const cssMix = (a, percent, b) => `color-mix(in oklab, ${a} ${percent}%, ${b})`;

/** Icon colours for an accent. `dark` gives the smoked obsidian tile used in dark mode. */
export function iconColors(accent = 'var(--accent)', { dark = false } = {}) {
  const mix = HEX.test(accent) ? hexMix : cssMix;
  return {
    frameHi: dark ? '#3a4346' : mix(accent, 16, '#ffffff'),
    frameLo: dark ? '#161b1d' : mix(accent, 44, '#ffffff'),
    rim: dark ? 0.16 : 0.6,
    wellHi: mix(accent, 60, '#ffffff'),
    well: accent,
    wellLo: mix(accent, 68, '#000000'),
    slot: mix(accent, 42, '#a3aba9'),
  };
}

export function appIconSvg(size = 64, c = iconColors()) {
  const id = `vi${++uid}`;
  const stop = (offset, color, opacity = 1) => `<stop offset="${offset}" style="stop-color:${color};stop-opacity:${opacity}"/>`;
  // The sheet with its corner cut along a curved fold (A = 34,12 on the top edge, B = 51,33 on the
  // right); the flap is that corner flipped over the fold, its tip landing near 30.5,28.6.
  const sheet = 'M17 12h17c5 8 10 15 17 21v15a4 4 0 0 1-4 4H17a4 4 0 0 1-4-4V16a4 4 0 0 1 4-4z';
  const flap = 'M34 12c-.5 7-2.5 13-3.5 16.6 6.5 1.2 14 2.4 20.5 4.4-7-6-12-13-17-21z';
  return `<svg class="app-icon" width="${size}" height="${size}" viewBox="0 0 64 64" aria-hidden="true">
  <defs>
    <linearGradient id="${id}f" x1="0" y1="0" x2="1" y2="1">${stop(0, c.frameHi)}${stop(1, c.frameLo)}</linearGradient>
    <linearGradient id="${id}w" x1=".15" y1="0" x2=".85" y2="1">${stop(0, c.wellHi)}${stop(0.55, c.well)}${stop(1, c.wellLo)}</linearGradient>
    <linearGradient id="${id}g" x1="0" y1="0" x2="0" y2="1">${stop(0, '#ffffff', 0.5)}${stop(1, '#ffffff', 0)}</linearGradient>
    <linearGradient id="${id}p" x1="0" y1="0" x2="1" y2="1">${stop(0, '#fdfbf6')}${stop(1, '#eee7da')}</linearGradient>
    <linearGradient id="${id}c" x1="1" y1="0" x2="0" y2="1">${stop(0, '#d5cab9')}${stop(0.5, '#fbf7ef')}${stop(1, '#ece4d6')}</linearGradient>
  </defs>
  <rect x="2" y="2" width="60" height="60" rx="17" fill="url(#${id}f)"/>
  <rect x="2.6" y="2.6" width="58.8" height="58.8" rx="16.4" fill="none" stroke="#ffffff" stroke-opacity="${c.rim}" stroke-width="1.2"/>
  <rect x="7" y="7" width="50" height="50" rx="12.5" fill="url(#${id}w)"/>
  <path d="M7 27C19 20 34 33 57 22v-2.5A12.5 12.5 0 0 0 44.5 7h-25A12.5 12.5 0 0 0 7 19.5z" fill="url(#${id}g)"/>
  <path d="M7 47c14-9 30 7 50-5v2.5A12.5 12.5 0 0 1 44.5 57h-25A12.5 12.5 0 0 1 7 44.5z" fill="#ffffff" fill-opacity=".14"/>
  <path d="${sheet}" transform="translate(0 1.8)" style="fill:${c.wellLo}" fill-opacity=".45"/>
  <path d="${sheet}" fill="url(#${id}p)"/>
  <path d="${flap}" transform="translate(-1.2 2)" fill="#5b4a36" fill-opacity=".2"/>
  <path d="${flap}" fill="url(#${id}c)"/>
  <path d="M34 12c-.5 7-2.5 13-3.5 16.6" fill="none" stroke="#ffffff" stroke-opacity=".9" stroke-width="1" stroke-linecap="round"/>
  <rect x="18" y="35" width="12" height="4.2" rx="2.1" style="fill:${c.slot}"/>
  <rect x="18" y="43" width="17" height="4.2" rx="2.1" style="fill:${c.slot}"/>
</svg>`;
}
