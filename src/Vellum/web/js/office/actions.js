// Office → PDF, the page half: Word to PDF, Excel to PDF and PowerPoint to PDF. The conversion is the host's
// (MainWindow.OfficeConversion.cs): it picks the files, chooses the Office application already on this PC
// and runs it, so nothing of the document passes through here. The page decides whether each tool exists
// (presence, from office.providers, read once), shows that a conversion is running with a way to cancel it,
// and says how it ended.

import { bridge } from '../bridge.js';
import { h } from '../dom.js';
import { showDialog, toast } from '../ui/dialogs.js';
import { describeOutcome, presenceFrom } from './formats.js';

export function createOfficeActions({ onOpenFile }) {
  let presence = Object.freeze({});
  let probing = null;
  let running = false;

  /** Asks the host what this PC has (starting nothing), once; `again` asks afresh. Only the latest answer counts. */
  const probe = (again = false) => {
    if (again) probing = null;
    if (!probing) {
      const asked = bridge.request('office.providers').then(
        (report) => { if (probing === asked) presence = presenceFrom(report); return presence; },
        () => { if (probing === asked) probing = null; return presence; }, // try again next time; until then, what was known
      );
      probing = asked;
    }
    return probing;
  };

  return {
    /** The presence names this PC has (requirements.js reads it synchronously): none until probe() answers. */
    presence: () => presence,
    probe,

    /** Converts a document of `format` ('word', 'excel', 'powerpoint'), chosen by the person, to a PDF. */
    async toPdf(format) {
      // One at a time: the running dialog is modal, so this only stops a second start in the same moment.
      if (running) return;
      running = true;
      let busy = null;
      let name = null;
      const stop = bridge.on('office-converting', (e) => {
        name = e?.name ?? null;
        busy = showRunning(e ?? {});
      });
      let reply;
      try {
        reply = await bridge.request('office.toPdf', { format });
      } catch (err) {
        reply = { error: err };
      } finally {
        stop();
        busy?.close();
        running = false;
      }

      if (reply.error) {
        showDialog({ title: 'Couldn’t make the PDF', message: reply.error.message, iconName: 'triangle-alert' });
        return;
      }
      if (!reply.result) return; // a dialog was cancelled: nothing happened
      const outcome = describeOutcome(reply.result);
      if (outcome.kind === 'converted') {
        const file = reply.file;
        toast(file ? (name ? `Made “${file.name}” from “${name}”` : `Made “${file.name}”`) : outcome.message, {
          kind: 'success', action: file ? { label: 'Open', run: () => onOpenFile(file) } : null,
        });
      } else if (outcome.kind === 'cancelled') {
        toast(outcome.message);
      } else {
        if (outcome.recheck) probe(true);
        showDialog({ title: outcome.title, message: outcome.message, iconName: 'triangle-alert' });
      }
    },
  };
}

/**
 * The dialog shown while the host converts: what, with what, how long so far, and Cancel. Closing it any way
 * cancels the conversion. close() takes it away when the conversion has ended.
 */
function showRunning({ name, providerName }) {
  const started = Date.now();
  const note = h('p', { class: 'dialog-note', text: 'This can take a little while for a long document.' });
  const tick = setInterval(() => { note.textContent = `Working… ${Math.round((Date.now() - started) / 1000)} s`; }, 1000);
  let finish = null;
  let ended = false;
  showDialog({
    title: 'Converting to PDF',
    message: `${providerName ?? 'An Office application'} is converting “${name ?? 'the document'}” on this PC. The document itself isn’t changed.`,
    iconName: 'file-text',
    className: 'office-dialog',
    content: [note],
    buttons: [{ id: 'cancel', label: 'Cancel' }],
    bind: (d) => { finish = d.finish; },
  }).then(() => {
    clearInterval(tick);
    if (!ended) bridge.request('office.cancel').catch(() => {});
  });
  return {
    close() {
      ended = true;
      finish?.('done');
    },
  };
}
