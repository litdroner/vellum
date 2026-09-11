import { h, debounce, timeAgo, prettyKeys } from '../dom.js';
import { icon } from '../icons.js';
import { appIconSvg, iconColors } from '../brand.js';
import { showDialog } from './dialogs.js';
import { aboutContent } from './about.js';
import { THEMES, MODES, seedsFor, resolveMode, comfort, setReducedMotion, setReducedTransparency, originOf } from '../themes.js';

// Settings. Every control applies immediately; there is nothing to save.
// ctx (from app.js): appearance(), setAppearance(patch, { origin }), pageTones, pageTone(),
// setPageTone(tone), updates(), version(), commands(), setDefault().

const SECTIONS = [
  { id: 'appearance', label: 'Appearance', icon: 'palette' },
  { id: 'reading', label: 'Reading', icon: 'book-open' },
  { id: 'updates', label: 'Updates', icon: 'refresh-cw' },
  { id: 'shortcuts', label: 'Shortcuts', icon: 'keyboard' },
  { id: 'about', label: 'About', icon: 'info' },
];
const TONES = [
  { id: 'normal', label: 'Normal', icon: 'file' },
  { id: 'dark', label: 'Dark', icon: 'moon' },
  { id: 'sepia', label: 'Sepia', icon: 'book-open' },
];

export function showSettings(ctx, initial = 'appearance') {
  let current = SECTIONS.some((s) => s.id === initial) ? initial : 'appearance';
  const pane = h('div', { class: 'settings-pane', role: 'tabpanel' });
  const navButtons = SECTIONS.map((s) => h('button', {
    class: 'settings-nav-item', role: 'tab', dataset: { id: s.id }, onClick: () => { current = s.id; render(false); },
  }, h('span', { html: icon(s.icon, 17) }), h('span', { text: s.label })));
  const nav = h('nav', { class: 'settings-nav', role: 'tablist', 'aria-label': 'Settings' },
    h('div', { class: 'settings-heading', text: 'Settings' }), ...navButtons);

  function render(keepScroll = true) {
    const scroll = keepScroll ? pane.scrollTop : 0;
    for (const b of navButtons) b.setAttribute('aria-selected', String(b.dataset.id === current));
    const section = SECTIONS.find((s) => s.id === current);
    pane.replaceChildren(h('h3', { class: 'settings-title', text: section.label }), ...BUILDERS[current](ctx));
    pane.scrollTop = scroll;
  }
  // The appearance can also change from outside (Ctrl+Shift+L, Windows switching modes).
  const onAppearance = () => { if (current === 'appearance') render(); };
  document.addEventListener('appearancechange', onAppearance);
  render(false);

  return showDialog({
    title: 'Settings',
    className: 'settings-dialog',
    buttons: [],
    content: [h('div', { class: 'settings-layout' }, nav, pane)],
    bind: ({ finish, dialog }) => dialog.append(h('button', {
      class: 'tb-btn small settings-close', title: 'Close (Esc)', 'aria-label': 'Close settings', html: icon('x', 16), onClick: () => finish(null),
    })),
    onOpen: () => navButtons.find((b) => b.dataset.id === current),
  }).finally(() => document.removeEventListener('appearancechange', onAppearance));
}

const BUILDERS = {
  appearance(ctx) {
    const a = ctx.appearance();
    const mode = resolveMode(a.mode);
    const chips = h('div', { class: 'theme-chips', role: 'radiogroup', 'aria-label': 'Colour theme' },
      ...THEMES.map((t) => themeChip(t.name, seedsFor({ theme: t.id }, mode), mode === 'dark', !a.accent && a.theme === t.id,
        (btn) => ctx.setAppearance({ theme: t.id, accent: null }, { origin: originOf(btn) }))));

    const picker = h('input', { type: 'color', value: a.accent ?? toPickerValue(seedsFor({ theme: a.theme }, 'light').accent), 'aria-label': 'Accent colour' });
    picker.addEventListener('input', debounce(() => ctx.setAppearance({ accent: picker.value.toLowerCase() }), 50));
    const accent = h('div', { class: 'accent-control' },
      a.accent ? h('button', { class: 'link-btn', onClick: () => ctx.setAppearance({ accent: null }) }, 'Use theme colour') : null,
      h('label', { class: `color-well${a.accent ? ' active' : ''}`, title: 'Pick an accent colour' }, picker, h('span', { html: icon('pipette', 15) })));

    return [
      group('Mode', row('Appearance', 'Light, dark, or the same as Windows.',
        seg(MODES, a.mode, (id, btn) => ctx.setAppearance({ mode: id }, { origin: originOf(btn) })))),
      group('Colour theme', chips,
        row('Accent colour', a.accent ? 'Your own colour; hover, selection and focus shades follow it.' : 'Pick any colour to use instead of the theme’s.', accent)),
      group('Comfort',
        row('Reduce motion', 'Turns off animations and transitions.', toggle(comfort.reducedMotion, setReducedMotion, 'Reduce motion')),
        row('Reduce transparency', 'Solid panels instead of frosted glass. Lighter on older PCs.', toggle(comfort.reducedTransparency, setReducedTransparency, 'Reduce transparency'))),
    ];
  },

  reading(ctx) {
    return [
      group('Pages',
        row('Page colours', 'How pages look on screen. Printing and saved files are unchanged.',
          seg(TONES, ctx.pageTone(), (id) => ctx.setPageTone(id)))),
      group('Default app',
        row('Open PDFs with Vellum', 'Registers Vellum for .pdf; Windows asks you to confirm in its Settings.',
          h('button', { class: 'btn small', onClick: () => ctx.setDefault() }, 'Set as default…'))),
    ];
  },

  updates(ctx) {
    const updates = ctx.updates();
    const auto = toggle(true, (on) => updates.setAuto(on), 'Check for updates automatically');
    const last = h('small', { text: ' ' });
    updates.settings().then((s) => {
      auto.setAttribute('aria-checked', String(s.auto));
      last.textContent = s.lastCheck ? `Last checked ${timeAgo(s.lastCheck)}.` : 'Not checked yet.';
    }).catch(() => { last.textContent = 'Updates aren’t available in this build.'; });
    return [
      group('Automatic updates',
        row('Check once a day', 'New versions come from Vellum’s GitHub releases and are verified before installing.', auto)),
      group('This version',
        h('div', { class: 'setting-row' },
          h('div', { class: 'setting-text' }, h('span', { text: `Vellum ${ctx.version() || ''}`.trim() }), last),
          h('button', { class: 'btn small primary', onClick: () => updates.checkNow() }, 'Check now'))),
    ];
  },

  shortcuts(ctx) {
    const groups = new Map();
    for (const c of Object.values(ctx.commands())) {
      const keys = c.hint ? [c.hint] : (c.keys ?? []);
      if (!keys.length) continue;
      if (!groups.has(c.group)) groups.set(c.group, []);
      groups.get(c.group).push(h('div', { class: 'shortcut-row' },
        h('span', { text: c.label }),
        h('span', { class: 'shortcut-keys' }, ...keys.slice(0, 2).map((k) => h('kbd', { text: prettyKeys(k) })))));
    }
    return [...groups].map(([name, rows]) => group(name, h('div', { class: 'shortcut-list' }, ...rows)));
  },

  about(ctx) {
    return [aboutContent(ctx.version())];
  },
};

// ---- controls -------------------------------------------------------------------------------

function group(title, ...children) {
  return h('section', { class: 'settings-group' }, h('h4', { text: title }), ...children);
}

function row(title, description, control) {
  return h('div', { class: 'setting-row' },
    h('div', { class: 'setting-text' }, h('span', { text: title }), description ? h('small', { text: description }) : null),
    control);
}

/** Segmented choice; the knob moves at once, then `onPick(id, button)` applies the choice. */
function seg(options, value, onPick) {
  const index = Math.max(0, options.findIndex((o) => o.id === value));
  const el = h('div', { class: 'seg', role: 'radiogroup', style: `--seg-count:${options.length};--seg-index:${index}` });
  options.forEach((o, i) => el.append(h('button', {
    class: 'seg-btn', role: 'radio', 'aria-checked': String(i === index), 'aria-pressed': String(i === index),
    onClick: (e) => {
      el.style.setProperty('--seg-index', String(i));
      for (const [j, b] of [...el.children].entries()) {
        b.setAttribute('aria-checked', String(i === j));
        b.setAttribute('aria-pressed', String(i === j));
      }
      onPick(o.id, e.currentTarget);
    },
  }, o.icon ? h('span', { html: icon(o.icon, 15) }) : null, h('span', { text: o.label }))));
  return el;
}

function toggle(on, onChange, label) {
  const el = h('button', { class: 'switch', role: 'switch', 'aria-checked': String(on), 'aria-label': label });
  el.addEventListener('click', () => {
    const next = el.getAttribute('aria-checked') !== 'true';
    el.setAttribute('aria-checked', String(next));
    onChange(next);
  });
  return el;
}

/** A theme swatch: the Vellum icon in that theme's colours, on the theme's own background. */
function themeChip(name, s, dark, pressed, onPick) {
  return h('button', {
    class: 'theme-chip', role: 'radio', title: name, 'aria-checked': String(pressed), 'aria-pressed': String(pressed),
    style: `--c-bg:${s.bg};--c-tint:${s.tint};--c-accent:${s.accent}`,
    onClick: (e) => onPick(e.currentTarget),
  }, h('span', { class: 'theme-chip-well' }, h('span', { class: 'theme-chip-tile', html: appIconSvg(42, iconColors(s.accent, { dark })) })),
  h('span', { class: 'theme-chip-name', text: name }));
}

/** <input type=color> only takes #rrggbb. */
function toPickerValue(color) {
  return /^#[0-9a-f]{6}$/i.test(color) ? color : '#2e8c87';
}
