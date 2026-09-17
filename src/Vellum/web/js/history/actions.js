import { bridge } from '../bridge.js';
import { h } from '../dom.js';
import { icon } from '../icons.js';
import { showDialog, toast } from '../ui/dialogs.js';
import { beforeRestoreName, formatSize, formatWhen, historySummary, snapshotLabel, sortSnapshots, totalSize, withoutSnapshot } from './model.js';

// Document history: snapshots a person takes of a document, kept on this PC (see Services/DocumentHistory.cs).
// Only a manual feature: nothing is snapshotted unless asked, except the current version just before a restore.
// A snapshot is an exact copy of the saved file. It opens read-only, compares with the document through
// Compare, and restores by writing a copy of it into the document with the normal save; it never changes.

export function createHistoryActions({ app, compare, save }) {
  const list = async (view) => sortSnapshots((await bridge.request('history.list', { path: view.file.path })).snapshots ?? []);

  const actions = {
    /** True for a document that can have history (open from disk, not itself a snapshot). */
    canUse(view) {
      return Boolean(view && view.status === 'ready' && !view.file.readOnly);
    },

    /** Takes a snapshot of the document as saved. Unsaved changes: save first, or keep the saved version. */
    async create(view, name = '') {
      if (!actions.canUse(view)) return null;
      await view.textEditor?.commitPending();
      if (view.annotations.dirty) {
        const choice = await showDialog({
          title: 'Save before taking a snapshot?',
          message: `A snapshot keeps “${view.file.name}” as it is saved on disk. It has unsaved changes, which won’t be in the snapshot unless you save first.`,
          iconName: 'save',
          buttons: [{ id: 'cancel', label: 'Cancel' }, { id: 'saved', label: 'Use saved version' }, { id: 'save', label: 'Save and snapshot', primary: true }],
        });
        if (!choice || choice === 'cancel') return null;
        if (choice === 'save' && !(await save(view))) return null;
      }
      try {
        const { snapshot } = await bridge.request('history.create', { path: view.file.path, name });
        toast(`Snapshot “${snapshotLabel(snapshot)}” kept`, { kind: 'success' });
        return snapshot;
      } catch (err) {
        toast(err.message, { kind: 'error' });
        return null;
      }
    },

    list,

    /** Opens a snapshot in a tab of its own, read-only (Save becomes Save As). */
    async open(view, snapshot) {
      const { file } = await bridge.request('history.open', { path: view.file.path, id: snapshot.id });
      return app.open(file);
    },

    /** Compare: the snapshot as Document A, the document as saved as Document B. */
    async compare(view, snapshot) {
      const { file } = await bridge.request('history.open', { path: view.file.path, id: snapshot.id });
      return compare.start(file, view.file);
    },

    /**
     * Puts a snapshot's content back into the document: the current version is kept as a new snapshot
     * first, then a copy of the snapshot is saved into the document and the tab reloads. The snapshot
     * itself stays in the history, unchanged.
     */
    async restore(view, snapshot, { confirm = true } = {}) {
      if (!actions.canUse(view)) return null;
      if (confirm) {
        const choice = await showDialog({
          title: `Restore “${snapshotLabel(snapshot)}”?`,
          message: `“${view.file.name}” will be saved with the content of this snapshot. Its current saved version is kept first, as a new snapshot.${view.annotations.dirty ? ' Unsaved changes will be lost.' : ''}`,
          iconName: 'rotate-ccw',
          buttons: [{ id: 'cancel', label: 'Cancel', primary: true }, { id: 'restore', label: 'Restore' }],
        });
        if (choice !== 'restore') return null;
      }
      try {
        await bridge.request('history.create', { path: view.file.path, name: beforeRestoreName(snapshot) });
        const { file } = await bridge.request('history.open', { path: view.file.path, id: snapshot.id });
        const response = await fetch(file.url);
        if (!response.ok) throw new Error('The snapshot couldn’t be read.');
        await view.writeFile(view.file, new Uint8Array(await response.arrayBuffer()));
      } catch (err) {
        await showDialog({ title: 'Couldn’t restore', message: err.message, iconName: 'triangle-alert' });
        return null;
      }
      const index = app.views.indexOf(view);
      const target = view.file;
      app.close(view);
      const restored = await app.open(target);
      app.move(restored, index);
      toast(`Restored “${snapshotLabel(snapshot)}”`, { kind: 'success' });
      return restored;
    },

    async remove(view, snapshot) {
      await bridge.request('history.delete', { path: view.file.path, id: snapshot.id });
    },

    /** Removes every snapshot of the document from this PC. The document itself doesn't change. */
    async clear(view) {
      return (await bridge.request('history.clear', { path: view.file.path })).removed ?? 0;
    },

    /** The history dialog: take a snapshot, and open, compare, restore or delete the ones kept. */
    async show(view = app.active) {
      if (!actions.canUse(view)) {
        if (view?.file.readOnly) toast('This is a snapshot. Its history is in the document it was taken from.');
        return;
      }
      let snapshots = [];
      try {
        snapshots = await list(view);
      } catch (err) {
        toast(err.message, { kind: 'error' });
        return;
      }
      const nameInput = h('input', { class: 'field', type: 'text', maxlength: '80', spellcheck: 'false', placeholder: 'Snapshot name (optional)', 'aria-label': 'Snapshot name' });
      const listEl = h('div', { class: 'hist-list', role: 'list' });
      const totalEl = h('span', { class: 'hist-total', 'aria-live': 'polite' });
      const clearBtn = h('button', {
        class: 'btn small', 'data-act': 'clear',
        onClick: async () => {
          const sure = await showDialog({
            title: 'Clear this document’s history?',
            message: `${snapshots.length === 1 ? 'Its snapshot' : `All ${snapshots.length} snapshots`} of “${view.file.name}” (${formatSize(totalSize(snapshots))}) will be removed from this PC. The document itself doesn’t change.`,
            iconName: 'trash-2',
            buttons: [{ id: 'cancel', label: 'Cancel', primary: true }, { id: 'clear', label: 'Clear history' }],
          });
          if (sure !== 'clear') return;
          try {
            await actions.clear(view);
            snapshots = [];
            render();
          } catch (err) {
            toast(err.message, { kind: 'error' });
          }
        },
      }, 'Clear history');
      let finish = () => {};
      let next = null; // what to do once the dialog has closed

      const render = () => {
        totalEl.textContent = historySummary(snapshots);
        clearBtn.disabled = snapshots.length === 0;
        listEl.replaceChildren(...(snapshots.length ? snapshots.map((s) => h('div', { class: 'hist-item', role: 'listitem', 'data-id': s.id },
          h('span', { class: 'hist-text' },
            h('span', { class: 'hist-name', text: snapshotLabel(s) }),
            h('span', { class: 'hist-when', text: `${s.name ? formatWhen(s.createdAt) : 'No name'} · ${formatSize(s.size)}` })),
          h('button', { class: 'btn small', 'data-act': 'open', onClick: () => { next = () => actions.open(view, s); finish('close'); } }, 'Open'),
          h('button', { class: 'btn small', 'data-act': 'compare', onClick: () => { next = () => actions.compare(view, s); finish('close'); } }, 'Compare'),
          h('button', { class: 'btn small', 'data-act': 'restore', onClick: () => { next = () => actions.restore(view, s); finish('close'); } }, 'Restore'),
          h('button', {
            class: 'tb-btn small hist-delete', 'data-act': 'delete', title: 'Delete snapshot', 'aria-label': 'Delete snapshot', html: icon('trash-2', 15),
            onClick: async () => {
              const sure = await showDialog({
                title: `Delete “${snapshotLabel(s)}”?`,
                message: 'The snapshot is removed from this PC. The document itself doesn’t change.',
                iconName: 'trash-2',
                buttons: [{ id: 'cancel', label: 'Cancel', primary: true }, { id: 'delete', label: 'Delete' }],
              });
              if (sure !== 'delete') return;
              try {
                await actions.remove(view, s);
                snapshots = withoutSnapshot(snapshots, s.id);
                render();
              } catch (err) {
                toast(err.message, { kind: 'error' });
              }
            },
          }))) : [h('p', { class: 'hist-empty', text: 'No snapshots yet. A snapshot keeps this document as it is saved now, on this PC, so you can go back to it.' })]));
      };
      const createBtn = h('button', {
        class: 'btn small', 'data-act': 'create',
        onClick: async () => {
          createBtn.disabled = true;
          try {
            const made = await actions.create(view, nameInput.value);
            if (made) {
              nameInput.value = '';
              snapshots = sortSnapshots([made, ...snapshots]);
              render();
            }
          } finally {
            createBtn.disabled = false;
          }
        },
      }, 'Create snapshot');
      nameInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); createBtn.click(); }
      });
      render();

      await showDialog({
        title: 'Document history',
        message: `Snapshots of “${view.file.name}”, kept on this PC only.`,
        iconName: 'clock',
        className: 'history-dialog',
        content: [h('div', { class: 'hist-create' }, nameInput, createBtn), listEl, h('div', { class: 'hist-storage' }, totalEl, clearBtn)],
        buttons: [{ id: 'close', label: 'Close', primary: true }],
        onOpen: () => nameInput,
        bind: (dialog) => { finish = dialog.finish; },
      });
      if (next) {
        try {
          await next();
        } catch (err) {
          toast(err.message, { kind: 'error' });
        }
      }
    },
  };
  return actions;
}
