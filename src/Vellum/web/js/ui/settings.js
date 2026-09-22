import { h, debounce, timeAgo, prettyKeys } from '../dom.js';
import { icon } from '../icons.js';
import { appIconSvg, iconColors } from '../brand.js';
import { showDialog } from './dialogs.js';
import { aboutContent } from './about.js';
import { formatSize, missingDocuments, storedLine, storedSummary, totalSize } from '../history/model.js';
import { availableLanguages, formatMB, installedLanguages } from '../ocr/languages.js';
import { languagePacks } from '../ocr/language-packs.js';
import { THEMES, MODES, seedsFor, resolveMode, comfort, setReducedMotion, setReducedTransparency, originOf } from '../themes.js';

// Settings. Every control applies immediately; there is nothing to save.
// ctx (from app.js): appearance(), setAppearance(patch, { origin }), pageTones, pageTone(),
// setPageTone(tone), updates(), history(), version(), commands(), setDefault().

const SECTIONS = [
  { id: 'appearance', label: 'Appearance', icon: 'palette' },
  { id: 'reading', label: 'Reading', icon: 'book-open' },
  { id: 'ocr', label: 'OCR', icon: 'text-select' },
  { id: 'history', label: 'History', icon: 'clock' },
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
    pane.replaceChildren(h('h3', { class: 'settings-title', text: section.label }), ...BUILDERS[current](ctx, { close: () => close(null) }));
    pane.scrollTop = scroll;
  }
  // The appearance can also change from outside (Ctrl+Shift+L, Windows switching modes).
  const onAppearance = () => { if (current === 'appearance') render(); };
  let close = () => {};
  document.addEventListener('appearancechange', onAppearance);
  render(false);

  return showDialog({
    title: 'Settings',
    className: 'settings-dialog',
    buttons: [],
    content: [h('div', { class: 'settings-layout' }, nav, pane)],
    bind: ({ finish, dialog }) => {
      close = finish;
      dialog.append(h('button', {
        class: 'tb-btn small settings-close', title: 'Close (Esc)', 'aria-label': 'Close settings', html: icon('x', 16), onClick: () => finish(null),
      }));
    },
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

  // Every document with snapshots on this PC. Each document's own history dialog stays where snapshots are
  // taken and restored; here a history can be opened, cleared, or removed once its document is gone.
  history(ctx, { close }) {
    const history = ctx.history();
    const summary = h('small', { class: 'stored-summary', 'aria-live': 'polite', text: 'Reading…' });
    const list = h('div', { class: 'stored-list' });
    const removeMissingBtn = h('button', { class: 'btn small', 'data-act': 'remove-missing', disabled: true }, 'Remove missing');
    let documents = [];

    const confirm = (title, message, label) => showDialog({
      title, message, iconName: 'trash-2',
      buttons: [{ id: 'cancel', label: 'Cancel', primary: true }, { id: 'ok', label }],
    }).then((choice) => choice === 'ok');
    const fail = (err) => showDialog({ title: 'Couldn’t change the history', message: err.message, iconName: 'triangle-alert' });

    const render = () => {
      const missing = missingDocuments(documents);
      summary.textContent = documents.length ? storedSummary(documents) : 'No document has history on this PC.';
      removeMissingBtn.disabled = missing.length === 0;
      removeMissingBtn.textContent = missing.length ? `Remove missing (${missing.length})` : 'Remove missing';
      list.replaceChildren(...documents.map((d) => h('div', { class: 'setting-row stored-row', dataset: { key: d.key, missing: String(Boolean(d.missing)) } },
        h('div', { class: 'setting-text' },
          h('span', { text: d.name, title: d.name }),
          h('small', { class: 'stored-path', text: d.path || 'Its index can’t be read', title: d.path }),
          h('small', {}, d.missing ? h('span', { class: 'stored-missing', text: 'Document missing · ' }) : null, storedLine(d))),
        h('div', { class: 'stored-actions' },
          d.missing ? null : h('button', {
            class: 'btn small', 'data-act': 'open',
            onClick: async () => {
              close();
              try { await history.showStored(d); } catch (err) { await fail(err); }
            },
          }, 'Open history'),
          h('button', {
            class: 'btn small', 'data-act': d.missing ? 'remove' : 'clear',
            onClick: async () => {
              const size = formatSize(d.size);
              const sure = d.missing
                ? await confirm('Remove this history?', `“${d.name}” is no longer at ${d.path || 'its old place'}. Its ${d.count === 1 ? 'snapshot' : `${d.count} snapshots`} (${size}) will be removed from this PC. Nothing else is deleted.`, 'Remove')
                : await confirm(`Clear the history of “${d.name}”?`, `${d.count === 1 ? 'Its snapshot' : `All ${d.count} snapshots`} (${size}) will be removed from this PC. The document itself doesn’t change.`, 'Clear history');
              if (!sure) return;
              try {
                await history.removeStored(d, { onlyIfMissing: Boolean(d.missing) });
                await load();
              } catch (err) { await fail(err); }
            },
          }, d.missing ? 'Remove' : 'Clear')))));
    };
    const load = async () => {
      try {
        documents = await history.stored();
        render();
      } catch (err) {
        summary.textContent = err.message;
      }
    };
    removeMissingBtn.addEventListener('click', async () => {
      const missing = missingDocuments(documents);
      const sure = await confirm(
        `Remove the history of ${missing.length === 1 ? '1 missing document' : `${missing.length} missing documents`}?`,
        `These documents are no longer where they were, so their history can’t be opened. Their snapshots (${formatSize(totalSize(missing))}) will be removed from this PC. Nothing else is deleted.`,
        'Remove');
      if (!sure) return;
      try {
        await history.removeMissing();
        await load();
      } catch (err) { await fail(err); }
    });
    load();

    return [
      group('Storage',
        h('div', { class: 'setting-row' },
          h('div', { class: 'setting-text' }, h('span', { text: 'Document history on this PC' }), summary),
          removeMissingBtn)),
      group('Documents', list),
    ];
  },

  // The language OCR reads in. English is built in; other languages are downloaded only on request, checked
  // by the host before they can be used, and can be removed again (ocr/languages.js, Services/OcrLanguages.cs).
  ocr() {
    const status = h('small', { 'aria-live': 'polite', text: 'Reading…' });
    const installed = h('div', { class: 'stored-list', 'data-list': 'installed' });
    const available = h('div', { class: 'stored-list', 'data-list': 'available' });
    const bars = new Map();
    let list = null;
    const fail = (err) => showDialog({ title: 'OCR languages', message: err.message, iconName: 'triangle-alert' });

    const act = (label, name, run, extra = {}) => h('button', { class: 'btn small', 'data-act': name, onClick: run, ...extra }, label);
    const langRow = (l) => {
      const chosen = l.code === list.selected;
      const busy = list.downloading === l.code;
      const note = h('small', {
        text: l.builtIn ? 'Built in'
          : l.installed ? `Installed · ${formatMB(l.size)}`
            : busy ? 'Downloading…'
              : `Available · ${formatMB(l.size)} download${chosen ? ' · chosen for OCR, download it to use it' : ''}`,
      });
      const fill = h('div', { class: 'progress-fill' });
      if (busy) bars.set(l.code, { fill, note });
      return h('div', { class: 'setting-row stored-row ocr-lang', dataset: { code: l.code, state: l.installed ? 'installed' : busy ? 'downloading' : 'available', chosen: String(chosen) } },
        h('div', { class: 'setting-text' }, h('span', { text: l.name }), note,
          busy ? h('div', { class: 'progress ocr-lang-progress' }, fill) : null),
        h('div', { class: 'stored-actions' },
          l.installed && chosen ? h('span', { class: 'ocr-lang-current' }, h('span', { html: icon('check', 14) }), 'Used for OCR') : null,
          l.installed && !chosen ? act('Use', 'use', () => change(() => languagePacks.select(l.code))) : null,
          l.installed && !l.builtIn ? act('Remove', 'remove', () => change(async () => {
            const next = await languagePacks.remove(l.code);
            return chosen ? languagePacks.select('eng') : next;
          })) : null,
          !l.installed && busy ? act('Cancel', 'cancel', () => languagePacks.cancel().catch(() => {})) : null,
          !l.installed && !busy ? act('Download', 'download', () => download(l), { disabled: Boolean(list.downloading) }) : null));
    };
    const render = () => {
      bars.clear();
      const chosen = list.languages.find((l) => l.code === list.selected);
      status.textContent = `OCR reads in ${chosen.name}.`;
      installed.replaceChildren(...installedLanguages(list).map(langRow));
      const rest = availableLanguages(list);
      available.replaceChildren(...(rest.length ? rest.map(langRow) : [h('small', { class: 'dialog-note', text: 'Every language is installed.' })]));
    };
    const change = async (run) => {
      try { list = await run(); } catch (err) { await fail(err); list = await languagePacks.list().catch(() => list); }
      render();
    };
    const download = (l) => change(async () => {
      list = { ...list, downloading: l.code };
      render();
      const result = await languagePacks.download(l.code);
      return result.list;
    });
    const off = languagePacks.onProgress((p) => {
      if (!installed.isConnected) { off(); return; }
      const bar = bars.get(p.code);
      if (!bar) return;
      if (p.verifying) bar.note.textContent = 'Checking the download…';
      else {
        const pct = p.total ? Math.round((p.received / p.total) * 100) : 0;
        bar.fill.style.width = `${pct}%`;
        bar.note.textContent = `Downloading… ${pct}% of ${formatMB(p.total)}`;
      }
    });
    languagePacks.list().then((l) => { list = l; render(); }).catch((err) => { status.textContent = err.message; });

    return [
      group('Language',
        row('Language for OCR', null, status),
        h('p', { class: 'dialog-note', text: 'English is built in. Other languages are downloaded only when you click Download, from Tesseract’s language data on GitHub, and checked before OCR can use them. Your documents never leave this PC.' })),
      group('Installed', installed),
      group('Available to download', available),
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
