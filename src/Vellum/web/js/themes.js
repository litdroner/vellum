import { reducedMotion } from './dom.js';

// Appearance: a colour theme (Mist, Ocean, …) shown in a mode (light, dark or following Windows),
// optionally with the user's own accent colour. A theme is only nine seed colours per mode; app.css
// derives everything else (text shades, glass, clay, shadows, focus rings). theme-boot.js re-applies
// the saved seeds before first paint, so nothing flashes in the wrong colours on start.

const SEED_VARS = {
  bg: '--bg', surface: '--surface', tint: '--tint', accent: '--accent', accent2: '--accent-2',
  accent3: '--accent-3', ink: '--ink', shadow: '--shadow', onAccent: '--on-accent',
  accentInk: '--accent-ink', // derived here (not by CSS): accent-coloured text that always reads
};
const SEED_KEYS = Object.keys(SEED_VARS);
const seeds = (list) => Object.fromEntries(SEED_KEYS.slice(0, 9).map((key, i) => [key, list[i]]));

//                 bg         surface    tint       accent     accent 2   accent 3   ink        shadow     on accent
export const THEMES = [
  {
    id: 'mist', name: 'Mist',
    light: seeds(['#edf1f0', '#fbfcfc', '#e0eeec', '#2e8c87', '#e8a48c', '#7fbf9a', '#1d2729', '#1f3a3d', '#ffffff']),
    dark: seeds(['#121617', '#1b2022', '#1c2b2b', '#6cc3bc', '#eeb096', '#8fd0a8', '#ece7de', '#000000', '#062623']),
  },
  {
    id: 'ocean', name: 'Ocean',
    light: seeds(['#eaf0f5', '#fbfcfe', '#dce8f5', '#2f76b8', '#e9a27f', '#6fb9b0', '#1b2530', '#1c3350', '#ffffff']),
    dark: seeds(['#10151b', '#19202a', '#1a2636', '#74aee8', '#efab8a', '#7fcfc4', '#e9ecf1', '#000000', '#07203a']),
  },
  {
    id: 'sage', name: 'Sage',
    light: seeds(['#edf0ea', '#fbfcf9', '#e1ecdb', '#4a8757', '#e0a47e', '#a8c77e', '#1f2720', '#263a2a', '#ffffff']),
    dark: seeds(['#121613', '#1b211c', '#1f2b21', '#8dc79a', '#e6b08c', '#c4d68f', '#ebeee6', '#000000', '#0d2614']),
  },
  {
    id: 'blush', name: 'Blush',
    light: seeds(['#f5eeef', '#fefcfc', '#f6e0e5', '#bf5577', '#e9a07d', '#a78fd0', '#2e2226', '#4a2833', '#ffffff']),
    dark: seeds(['#171213', '#221a1c', '#2d1f24', '#ec9ab4', '#f0b08f', '#bca6ec', '#f1e8ea', '#000000', '#3a0d1e']),
  },
  {
    id: 'sand', name: 'Sand',
    light: seeds(['#f3efe8', '#fefcf8', '#f0e4d1', '#a4692c', '#d98c6e', '#9cb87a', '#2c261f', '#4a3620', '#ffffff']),
    dark: seeds(['#161410', '#211e18', '#2c261c', '#e0ae72', '#e59c7e', '#b8cd92', '#efe9df', '#000000', '#33200a']),
  },
  {
    id: 'lavender', name: 'Lavender',
    light: seeds(['#f0eef6', '#fdfcff', '#e6e0f5', '#6f57b6', '#e59ab8', '#7fb9d3', '#25212f', '#2e2650', '#ffffff']),
    dark: seeds(['#141219', '#1e1b25', '#262134', '#b6a3f0', '#f0a6c4', '#93cde2', '#ece8f4', '#000000', '#1f1245']),
  },
  {
    id: 'graphite', name: 'Graphite',
    light: seeds(['#eeeff1', '#fcfcfd', '#e3e5e9', '#48525f', '#d9a26a', '#8fb3a5', '#1d2025', '#1d2430', '#ffffff']),
    dark: seeds(['#121315', '#1c1e21', '#24272c', '#b9c3d0', '#e0b27a', '#9cc4b4', '#eceae6', '#000000', '#15191f']),
  },
];

export const MODES = [
  { id: 'light', label: 'Light', icon: 'sun' },
  { id: 'system', label: 'System', icon: 'monitor' },
  { id: 'dark', label: 'Dark', icon: 'moon' },
];

const DEFAULT = { theme: 'mist', mode: 'light', accent: null };
const KEY = 'vellum.appearance';
const SEEDS_KEY = 'vellum.appearance.seeds'; // resolved seeds for both modes, read by theme-boot.js
const darkQuery = matchMedia('(prefers-color-scheme: dark)');

const read = (key) => { try { return localStorage.getItem(key); } catch { return null; } };
const write = (key, value) => { try { localStorage.setItem(key, value); } catch { /* storage unavailable */ } };

/** The saved appearance: { theme, mode, accent }. Before themes existed there was only light/dark. */
export function loadAppearance() {
  let saved = null;
  try { saved = JSON.parse(read(KEY) ?? 'null'); } catch { /* ignore */ }
  const legacyMode = read('vellum.theme') === 'dark' ? 'dark' : DEFAULT.mode;
  const theme = THEMES.some((t) => t.id === saved?.theme) ? saved.theme : DEFAULT.theme;
  const mode = MODES.some((m) => m.id === saved?.mode) ? saved.mode : legacyMode;
  const accent = /^#[0-9a-f]{6}$/i.test(saved?.accent ?? '') ? saved.accent.toLowerCase() : null;
  return { theme, mode, accent };
}

/** 'light' or 'dark' for a mode, asking Windows when it's 'system'. */
export function resolveMode(mode) {
  return mode === 'system' ? (darkQuery.matches ? 'dark' : 'light') : mode;
}

/** The nine seed colours for an appearance in one mode. */
export function seedsFor({ theme, accent }, mode) {
  const base = { ...(THEMES.find((t) => t.id === theme) ?? THEMES[0])[mode] };
  if (accent) {
    // The user's accent, kept usable: not so pale it vanishes on light surfaces, not so dark it
    // vanishes on obsidian; paired with whichever text colour contrasts more; the tint (selected
    // rows, soft fills) is a whisper of it over the surface.
    let color = accent;
    for (let i = 0; i < 8 && mode === 'light' && luminance(color) > 0.5; i++) color = mix(color, '#000000', 0.12);
    for (let i = 0; i < 8 && mode === 'dark' && luminance(color) < 0.28; i++) color = mix(color, '#ffffff', 0.15);
    base.accent = color;
    base.onAccent = contrast(color, '#ffffff') >= contrast(color, '#111418') ? '#ffffff' : '#111418';
    base.tint = mix(base.surface, color, mode === 'dark' ? 0.16 : 0.14);
  }
  // Accent-coloured text (selected tools, links, active tab icon): the accent itself where it reads,
  // otherwise moved towards the text colour until it reaches 4.5:1 on the surface.
  let ink = base.accent;
  for (let i = 0; i < 10 && contrast(ink, base.surface) < 4.5; i++) ink = mix(ink, base.ink, 0.15);
  base.accentInk = ink;
  return base;
}

/** Applies an appearance to the page and remembers it. Returns the resolved mode. */
export function applyAppearance(appearance) {
  const root = document.documentElement;
  const mode = resolveMode(appearance.mode);
  const values = seedsFor(appearance, mode);
  for (const key of SEED_KEYS) root.style.setProperty(SEED_VARS[key], values[key]);
  root.dataset.theme = mode;
  root.dataset.palette = appearance.accent ? 'custom' : appearance.theme;
  write(KEY, JSON.stringify(appearance));
  write(SEEDS_KEY, JSON.stringify({ mode: appearance.mode, light: seedsFor(appearance, 'light'), dark: seedsFor(appearance, 'dark') }));
  return mode;
}

/**
 * Changes appearance with the new colours growing as a circle from `origin` (the control that was
 * used), via a view transition; instant when motion is reduced.
 */
export function switchAppearance(appearance, { origin, onApplied } = {}) {
  const apply = () => onApplied?.(applyAppearance(appearance));
  if (!document.startViewTransition || reducedMotion()) {
    apply();
    return;
  }
  const [x, y] = origin ?? [innerWidth / 2, 24];
  const transition = document.startViewTransition(apply);
  transition.ready.then(() => {
    const radius = Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y));
    document.documentElement.animate(
      { clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${radius}px at ${x}px ${y}px)`] },
      { duration: 480, easing: 'cubic-bezier(.4, 0, .2, 1)', pseudoElement: '::view-transition-new(root)' });
  }).catch(() => { /* skipped: the appearance is applied anyway */ });
}

/** Calls back when Windows switches between light and dark (only matters in 'system' mode). */
export function onSystemModeChange(callback) {
  darkQuery.addEventListener('change', callback);
}

/** Centre of an element, as a transition origin. */
export function originOf(el) {
  const r = el?.getBoundingClientRect();
  return r ? [r.left + r.width / 2, r.top + r.height / 2] : undefined;
}

// ---- comfort settings ------------------------------------------------------------------------

/** Reduce motion: turns off transitions and animations (Windows' own setting is honoured too). */
export function setReducedMotion(on) {
  document.documentElement.toggleAttribute('data-motion', on);
  if (on) document.documentElement.dataset.motion = 'reduced';
  write('vellum.motion', on ? 'reduced' : 'full');
}

/** Reduce transparency: solid surfaces instead of blurred glass (lighter on slow machines). */
export function setReducedTransparency(on) {
  document.documentElement.toggleAttribute('data-glass', on);
  if (on) document.documentElement.dataset.glass = 'off';
  write('vellum.glass', on ? 'off' : 'on');
}

export const comfort = {
  get reducedMotion() { return read('vellum.motion') === 'reduced'; },
  get reducedTransparency() { return read('vellum.glass') === 'off'; },
};

// ---- colour helpers ------------------------------------------------------------------------

const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const toHexRgb = (values) => `#${values.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`;

function mix(a, b, amount) {
  const [x, y] = [rgb(a), rgb(b)];
  return toHexRgb(x.map((v, i) => v + (y[i] - v) * amount));
}

function luminance(hex) {
  const [r, g, b] = rgb(hex).map((v) => {
    const c = v / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a, b) {
  const [la, lb] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (la + 0.05) / (lb + 0.05);
}

/** Any CSS colour as #rrggbb (the window frame behind the page needs plain RGB). */
export function toHex(color) {
  if (/^#[0-9a-f]{6}$/i.test(color)) return color.toLowerCase();
  const canvas = (toHex.canvas ??= Object.assign(document.createElement('canvas'), { width: 1, height: 1 }));
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.clearRect(0, 0, 1, 1);
  ctx.fillStyle = '#000';
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, 1, 1);
  return toHexRgb([...ctx.getImageData(0, 0, 1, 1).data.slice(0, 3)]);
}
