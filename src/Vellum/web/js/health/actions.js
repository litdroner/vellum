import { h } from '../dom.js';
import { icon } from '../icons.js';
import { showDialog } from '../ui/dialogs.js';
import { checkDocument } from './health.js';

// PDF health: the report of health.js in a dialog. Read-only: the check reads the pages through the
// editing session's analysis and changes nothing; a page number goes to that page. Closing the dialog
// stops a check still running.

const LABELS = { refused: 'Won’t be changed', limited: 'Limited', info: 'Good to know' };

export function createHealthActions({ app }) {
  return {
    /** Checks the active document and shows what was found. */
    async show(view = app.active) {
      if (view?.status !== 'ready') return null;
      const status = h('p', { class: 'dialog-note health-status', 'aria-live': 'polite', text: 'Checking the document…' });
      const list = h('div', { class: 'health-list', role: 'list', 'aria-label': 'Findings' });
      const stop = new AbortController();
      let finish = () => {};

      const item = (f) => {
        const pages = f.pages.length > 1
          ? h('span', { class: 'health-pages' }, `Pages `, ...f.pages.slice(0, 12).flatMap((p, i) => [i ? ', ' : '', pageLink(p)]), f.pages.length > 12 ? ` and ${f.pages.length - 12} more` : '')
          : f.pages.length ? h('span', { class: 'health-pages' }, 'Page ', pageLink(f.pages[0])) : h('span', { class: 'health-pages', text: 'Whole document' });
        return h('div', { class: `health-item ${f.severity}`, role: 'listitem', 'data-id': f.id },
          h('span', { class: 'health-glyph', html: icon(f.severity === 'info' ? 'info' : 'triangle-alert', 16) }),
          h('div', { class: 'health-body' },
            h('div', { class: 'health-head' },
              h('span', { class: 'health-severity', text: LABELS[f.severity] }),
              pages,
              f.count != null ? h('span', { class: 'health-count', text: `${f.count} ${f.count === 1 ? 'piece' : 'pieces'} of text` }) : null),
            h('p', { class: 'health-message', text: f.message }),
            f.details.length ? h('ul', { class: 'health-details' }, f.details.map((d) => h('li', { text: d }))) : null));
      };
      const pageLink = (number) => h('button', {
        class: 'health-page', text: String(number), title: `Go to page ${number}`,
        onClick: () => { finish('page'); view.goToPage(number, { pulse: true }); },
      });

      const done = showDialog({
        title: 'PDF health',
        message: 'What Vellum can tell about this file before you edit it. Only what Vellum can prove is listed; nothing is scored, guessed or repaired, and the file isn’t changed.',
        iconName: 'list-checks',
        className: 'health-dialog',
        content: [status, list],
        buttons: [{ id: 'close', label: 'Close', primary: true }],
        bind: (d) => { finish = d.finish; },
      });
      done.then(() => stop.abort());

      try {
        const report = await checkDocument(view, {
          signal: stop.signal,
          onPage: (n, count) => { status.textContent = `Checking page ${n} of ${count}…`; },
        });
        list.replaceChildren(...report.findings.map(item));
        const checked = view.encrypted ? 'The pages’ content wasn’t read.' : `${report.pagesChecked} of ${report.pageCount} ${report.pageCount === 1 ? 'page' : 'pages'} checked.`;
        status.textContent = report.findings.length
          ? `${report.findings.length} ${report.findings.length === 1 ? 'finding' : 'findings'}. ${checked}`
          : `Nothing found that stops or limits editing. ${checked}`;
        status.classList.toggle('clean', !report.findings.length);
      } catch (err) {
        status.textContent = `The check couldn’t finish: ${err?.message ?? err}`;
      }
      return done;
    },
  };
}
