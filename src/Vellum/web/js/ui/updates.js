import { h } from '../dom.js';
import { showDialog, toast } from './dialogs.js';
import { renderMarkdown } from './markdown.js';

// In-app updates. Once a day (unless turned off) Vellum quietly asks GitHub for the newest release; if
// there is one, an "Update" pill appears in the title bar. The update dialog shows what's new, downloads
// the installer with progress, verifies it (the host checks it against GitHub's published checksum), then
// installs it with no installer window of its own: Vellum closes, and the new version starts by itself
// and reopens your documents. If the install fails, the version you had starts again and says so.

const megabytes = (bytes) => `${(bytes / 1048576).toFixed(bytes >= 10 * 1048576 ? 0 : 1)} MB`;
const longDate = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'long', year: 'numeric' });

export class Updates {
  /** The last "update available" answer, while it's still relevant. */
  offer = null;
  #onProgress = null;
  #onStage = null;

  constructor({ bridge, titlebar, prepareToQuit, openFiles }) {
    this.bridge = bridge;
    this.titlebar = titlebar;
    this.prepareToQuit = prepareToQuit;
    this.openFiles = openFiles;
    titlebar.onUpdate = () => { if (this.offer) this.show(this.offer); };
    bridge.on('update-progress', (p) => this.#onProgress?.(p));
    bridge.on('update-stage', (s) => this.#onStage?.(s.stage));
  }

  settings() {
    return this.bridge.request('update.settings');
  }

  setAuto(enabled) {
    return this.bridge.request('update.setAuto', { enabled });
  }

  /** The daily background check: says nothing unless there's a new version. */
  async checkQuietly() {
    try {
      const result = await this.bridge.request('update.check', { auto: true });
      if (!result.available) return;
      this.#setOffer(result);
      toast(`Vellum ${result.version} is available`, {
        kind: 'update', timeout: 9000, action: { label: 'See what’s new', run: () => this.show(result) },
      });
    } catch { /* offline, or no host: try again next time */ }
  }

  /** "Check for updates…": always answers. */
  async checkNow() {
    const hideBusy = toast('Checking for updates…', { kind: 'busy', timeout: 30000 });
    let result;
    try {
      result = await this.bridge.request('update.check', { auto: false });
    } catch (err) {
      hideBusy();
      showDialog({ title: 'Couldn’t check for updates', message: err.message, iconName: 'wifi-off' });
      return;
    }
    hideBusy();
    if (!result.available) {
      this.#setOffer(null);
      toast(`You’re up to date: Vellum ${result.current} is the latest version`, { kind: 'success', timeout: 4500 });
      return;
    }
    this.#setOffer(result);
    this.show(result);
  }

  /** After an update: say so once, with the notes a click away. */
  announce(version) {
    toast(`Vellum was updated to ${version}`, {
      kind: 'update', timeout: 8000, action: { label: 'What’s new', run: () => this.whatsNew(version) },
    });
  }

  /** Setup couldn't install an update and started this version again (its changes were rolled back). */
  async failed(version, current) {
    const choice = await showDialog({
      title: 'The update didn’t install',
      iconName: 'triangle-alert',
      message: `Vellum ${version} couldn’t be installed, so Vellum ${current} was kept and your documents were reopened. You can try again now or later.`,
      buttons: [{ id: 'close', label: 'Close' }, { id: 'retry', label: 'Try again', primary: true }],
    });
    if (choice === 'retry') this.checkNow();
  }

  async whatsNew(version) {
    let notes = '';
    let page = null;
    try { ({ notes, page } = await this.bridge.request('update.notes')); } catch { /* offline */ }
    const choice = await showDialog({
      title: `What’s new in Vellum ${version}`,
      iconName: 'sparkles',
      className: 'update-dialog',
      content: [h('div', { class: 'update-notes' },
        notes?.trim() ? renderMarkdown(notes) : h('p', { text: 'The release notes couldn’t be loaded right now.' }))],
      buttons: [...(page ? [{ id: 'page', label: 'Open on GitHub' }] : []), { id: 'ok', label: 'Close', primary: true }],
    });
    if (choice === 'page') window.open(page, '_blank');
  }

  /** The update dialog: what's new → downloading → verifying → installing → restarting into the new version. */
  show(offer) {
    const meta = [
      `You have ${offer.current}`,
      offer.size ? megabytes(offer.size) : null,
      offer.publishedAt ? `released ${longDate.format(new Date(offer.publishedAt))}` : null,
    ].filter(Boolean).join(' · ');
    const fill = h('div', { class: 'progress-fill' });
    const bar = h('div', { class: 'progress update-progress', hidden: true }, fill);
    const status = h('p', { class: 'update-status', 'aria-live': 'polite' });
    const actions = h('div', { class: 'dialog-actions update-actions' });
    let downloading = false;

    const button = (label, run, primary = false, kind = 'btn') => h('button', { class: `${kind}${primary ? ' primary' : ''}`, onClick: run }, label);
    const setStatus = (text, error = false) => {
      status.textContent = text;
      status.classList.toggle('error', error);
    };
    const setActions = (...buttons) => {
      actions.replaceChildren(...buttons);
      (actions.querySelector('.primary') ?? actions.querySelector('button'))?.focus();
    };

    return showDialog({
      title: `Vellum ${offer.version} is available`,
      iconName: 'sparkles',
      className: 'update-dialog',
      buttons: [],
      content: [
        h('p', { class: 'update-meta', text: meta }),
        h('div', { class: 'update-notes' },
          offer.notes?.trim() ? renderMarkdown(offer.notes) : h('p', { text: 'No release notes were published for this version.' })),
        bar, status, actions,
      ],
      onOpen: () => actions.querySelector('.primary'),
      bind: ({ finish }) => {
        const offerStage = () => {
          bar.hidden = true;
          if (!offer.verified) {
            setStatus('This release has no published checksum, so Vellum won’t install it by itself. You can download it from GitHub instead.');
            setActions(button('Later', () => finish('later')),
              button('Open download page', () => { window.open(offer.page, '_blank'); finish('page'); }, true));
            return;
          }
          setStatus('');
          setActions(
            button('Skip this version', async () => {
              await this.bridge.request('update.skip', { version: offer.version }).catch(() => {});
              this.#setOffer(null);
              finish('skip');
            }, false, 'link-btn'),
            button('Later', () => finish('later')),
            button('Update now', download, true));
        };

        const download = async () => {
          downloading = true;
          bar.hidden = false;
          fill.style.width = '0%';
          setStatus('Downloading…');
          setActions(button('Cancel', () => this.bridge.request('update.cancel').catch(() => {})));
          this.#onProgress = ({ received, total }) => {
            fill.style.width = `${total > 0 ? Math.min(100, (received / total) * 100).toFixed(1) : 0}%`;
            setStatus(total > 0 ? `Downloading… ${megabytes(received)} of ${megabytes(total)}` : `Downloading… ${megabytes(received)}`);
          };
          this.#onStage = (stage) => {
            if (stage !== 'verifying') return;
            this.#onProgress = null;
            fill.style.width = '100%';
            setStatus('Verifying…');
          };
          let ready = false;
          try {
            const result = await this.bridge.request('update.download');
            if (result.cancelled) {
              offerStage();
              return;
            }
            ready = true;
          } catch (err) {
            setStatus(err.message, true);
            setActions(button('Close', () => finish('error')), button('Try again', download, true));
          } finally {
            downloading = false;
            this.#onProgress = null;
            this.#onStage = null;
          }
          if (ready) install();
        };

        // Verified: install straight away. Only unsaved changes can hold it up (the usual save prompt).
        const install = async () => {
          fill.style.width = '100%';
          setActions();
          if (!(await this.prepareToQuit())) {
            setStatus('The update is downloaded and verified. It installs when you’re ready; Vellum restarts by itself.');
            setActions(button('Later', () => finish('later')), button('Install update', install, true));
            return;
          }
          setStatus('Installing…');
          try {
            await this.bridge.request('update.install', { files: this.openFiles() });
            setStatus('Restarting…');
          } catch (err) {
            setStatus(err.message, true);
            setActions(button('Close', () => finish('error')), button('Try again', install, true));
          }
        };

        offerStage();
      },
    }).finally(() => {
      if (downloading) this.bridge.request('update.cancel').catch(() => {});
    });
  }

  #setOffer(offer) {
    this.offer = offer;
    this.titlebar.setUpdate(offer);
  }
}
