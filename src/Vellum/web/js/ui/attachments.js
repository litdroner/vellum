import { h } from '../dom.js';
import { icon } from '../icons.js';
import { showDialog, toast } from './dialogs.js';
import { bridge } from '../bridge.js';
import { loadPdfLib } from '../annotations/persist.js';
import {
  MAX_ATTACHMENT_BYTES, addAttachment, attachmentSize, attachmentType, extractAttachment, removeAttachment,
} from '../attachments/attachments.js';

// The attachment inspector: what files this PDF carries, and what can be done with them.
//
// It lists each embedded file with its name, type, size, description and dates, exactly as the
// document states them (attachments/attachments.js). Save writes ONE attachment, to a folder the
// person picked in the host's own dialog, through the same write tokens an export uses
// (MainWindow.Export.cs) — nothing is ever written without that choice, and nothing is extracted
// until Save is pressed. Attach and Remove change the list in the edit store: one Ctrl+Z, and the
// document on disk is untouched until it is saved. An attachment that isn't replaced keeps its own
// bytes, byte for byte.
//
// A protected PDF can't be rewritten, so its attachments are listed and saved out but not changed.

const when = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });

const dateLabel = (value) => {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : when.format(date);
};

/**
 * Opens the inspector for a document. `view` is the DocumentView: its edit store holds the list, and
 * its base bytes are what an attachment is read out of.
 */
export function showAttachments(view) {
  const editable = view.canEditPages;
  const body = h('div', { class: 'attach-list', role: 'list' });
  const summary = h('p', { class: 'dialog-message', 'aria-live': 'polite' });

  const list = () => view.annotations.attachments ?? [];
  const onChange = (e) => { if (e.detail.attachments) render(); };
  const apply = (next) => view.annotations.applyAttachments(next);

  const render = () => {
    const items = list();
    summary.textContent = items.length
      ? `${items.length} file${items.length === 1 ? '' : 's'} embedded in this PDF.`
      : 'This PDF doesn’t carry any embedded files.';
    if (!items.length) {
      body.replaceChildren(h('div', { class: 'panel-empty' },
        h('span', { html: icon('paperclip', 22) }),
        h('strong', { text: 'No attachments' }),
        h('span', { text: editable ? 'Attach a file to add one.' : 'This PDF is protected, so files can’t be attached to it.' })));
      return;
    }
    body.replaceChildren(...items.map((item) => {
      const facts = [attachmentType(item), attachmentSize(item.size)];
      const modified = dateLabel(item.modified);
      if (modified) facts.push(modified);
      if (item.data) facts.push('not saved yet');
      if (item.missing) facts.push('its contents are missing from the file');
      const row = h('div', { class: 'attach-row', role: 'listitem' },
        h('span', { class: 'attach-glyph', html: icon('paperclip', 16) }),
        h('div', { class: 'attach-detail' },
          h('strong', { class: 'attach-name', text: item.name, title: item.id }),
          h('span', { class: 'attach-facts', text: facts.join(' · ') }),
          item.description ? h('span', { class: 'attach-desc', text: item.description }) : null),
        h('div', { class: 'attach-actions' },
          h('button', {
            class: 'btn small', title: `Save “${item.name}” to a folder you choose`,
            disabled: item.missing || undefined, onClick: () => save(view, item),
          }, 'Save…'),
          editable
            ? h('button', {
              class: 'btn small danger', title: `Remove “${item.name}” from this PDF`,
              onClick: () => { apply(removeAttachment(list(), item.id)); render(); },
            }, 'Remove')
            : null));
      return row;
    }));
  };

  const attach = async () => {
    try {
      const { file } = await bridge.request('attachDialog');
      if (!file) return;
      const data = Uint8Array.fromBase64
        ? Uint8Array.fromBase64(file.data)
        : Uint8Array.from(atob(file.data), (c) => c.charCodeAt(0));
      if (data.length > MAX_ATTACHMENT_BYTES) throw new Error(`“${file.name}” is larger than ${Math.round(MAX_ATTACHMENT_BYTES / (1024 * 1024))} MB.`);
      apply(addAttachment(list(), { name: file.name, data, mime: file.mime ?? null }));
      render();
      toast(`“${file.name}” will be attached when you save this PDF.`, { kind: 'info' });
    } catch (err) {
      showDialog({ title: 'Couldn’t attach the file', message: err.message, iconName: 'triangle-alert' });
    }
  };

  return showDialog({
    title: 'Attachments',
    className: 'attach-dialog',
    content: [summary, body],
    buttons: [{ id: 'close', label: 'Close', primary: true }],
    bind: ({ dialog }) => {
      render();
      if (editable) {
        dialog.querySelector('.dialog-actions').prepend(h('button', {
          class: 'btn', onClick: () => attach(),
        }, h('span', { html: icon('plus', 14) }), 'Attach a file…'));
      }
      // The list is redrawn when an attachment change is undone or redone while the dialog is open.
      view.annotations.addEventListener('change', onChange);
    },
  }).finally(() => view.annotations.removeEventListener('change', onChange));
}

/** Extracts one attachment and writes it to a file in a folder the person chooses. */
async function save(view, item) {
  try {
    const folderOf = (path) => path.slice(0, Math.max(0, path.lastIndexOf('\\')));
    const { folder } = await bridge.request('export.folder', { folder: folderOf(view.file.path) });
    if (!folder) return;
    const data = item.data ?? await extractAttachment(await loadPdfLib(), await view.baseBytes(), item.id);
    if (!data) throw new Error('Its contents are missing from this PDF.');
    const { files } = await bridge.request('export.targets', { folder, names: [item.name], overwrite: 'keepBoth' });
    const target = files?.[0];
    if (!target?.token) throw new Error('The file couldn’t be created there.');
    const response = await fetch(`${new URL(view.file.url).origin}/export/${target.token}`, {
      method: 'POST', body: data, headers: { 'Content-Type': 'application/octet-stream' },
    });
    const outcome = await response.json().catch(() => ({ ok: false, error: `The file couldn’t be written (${response.status}).` }));
    if (!outcome.ok) throw new Error(outcome.error);
    toast(`Saved “${target.name}”.`, { kind: 'success', action: { label: 'Show', run: () => bridge.request('showInFolder', { path: target.path }) } });
  } catch (err) {
    showDialog({ title: 'Couldn’t save the attachment', message: err.message, iconName: 'triangle-alert' });
  }
}
