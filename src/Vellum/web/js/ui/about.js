import { h } from '../dom.js';
import { appIconSvg } from '../brand.js';
import { showDialog } from './dialogs.js';

// "About Vellum": who made it, the open-source work it stands on, and updates.

/** The about card itself (also shown in Settings → About). */
export function aboutContent(version) {
  return h('div', { class: 'about' },
    h('div', { class: 'about-mark', html: appIconSvg(88) }),
    h('div', { class: 'about-name', text: 'Vellum' }),
    h('div', { class: 'about-tagline', text: 'Paper meets possibilities' }),
    h('div', { class: 'about-version', text: version ? `Version ${version}` : '' }),
    h('p', { class: 'about-credit' }, 'Developed by ', h('strong', { text: 'Pankaj Manhas' }), ' · Homelabs'),
    h('p', { class: 'about-origin', text: 'Made in India' }),
    h('p', { class: 'about-libs', text: 'Built with pdf.js (Apache-2.0), pdf-lib (MIT), Lucide icons (ISC) and the Jost typeface (SIL OFL).' }));
}

export async function showAbout({ version, updates }) {
  const auto = h('input', { type: 'checkbox', class: 'check', checked: true });
  const autoRow = h('label', { class: 'about-auto' }, auto, 'Check for updates automatically');
  auto.addEventListener('change', () => updates?.setAuto(auto.checked));
  if (updates) updates.settings().then((s) => { auto.checked = s.auto; }).catch(() => { autoRow.hidden = true; });
  else autoRow.hidden = true;

  const content = aboutContent(version);
  content.append(autoRow);
  const choice = await showDialog({
    title: 'About Vellum',
    content: [content],
    buttons: [{ id: 'update', label: 'Check for updates' }, { id: 'ok', label: 'Close', primary: true }],
    className: 'about-dialog',
  });
  if (choice === 'update') updates?.checkNow();
}
