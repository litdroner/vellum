import { h } from '../dom.js';
import { markSvg } from '../brand.js';
import { showDialog } from './dialogs.js';

// "About Vellum": who made it, and the open-source work it stands on.

export function showAbout({ version }) {
  const content = h('div', { class: 'about' },
    h('div', { class: 'mark-tile about-mark', html: markSvg(34) }),
    h('div', { class: 'about-name', text: 'Vellum' }),
    h('div', { class: 'about-version', text: version ? `Version ${version}` : '' }),
    h('p', { class: 'about-credit' }, 'Developed by ', h('strong', { text: 'Pankaj Manhas' }), ' · Homelabs'),
    h('p', { class: 'about-origin', text: 'Made in India' }),
    h('p', { class: 'about-libs', text: 'Built with pdf.js (Apache-2.0), pdf-lib (MIT), Lucide icons (ISC) and the Jost typeface (SIL OFL).' }));
  return showDialog({
    title: 'About Vellum',
    content: [content],
    buttons: [{ id: 'ok', label: 'Close', primary: true }],
    className: 'about-dialog',
  });
}
