import { bridge } from '../bridge.js';
import { h } from '../dom.js';
import { promptPassword, showDialog, toast } from '../ui/dialogs.js';
import { CompareView } from './compare-view.js';

// Compare documents: picking Document A and Document B, then the comparison window (compare-view.js).
// Both files are only read; neither is opened for editing or changed.

export function createCompareActions({ app, pdfjsLib }) {
  let current = null;

  const actions = {
    /** The comparison on screen, if any. */
    get view() { return current; },

    /** Asks for the two documents: A starts as the active tab, B as another open tab. */
    async choose() {
      const ready = app.views.filter((v) => v.status === 'ready');
      const active = app.active?.status === 'ready' ? app.active : null;
      const chosen = {
        a: active?.file ?? null,
        b: ready.find((v) => v !== active)?.file ?? null,
      };
      let refresh = () => {};
      const row = (side) => {
        const name = h('span', { class: 'cmp-pick-name' });
        const button = h('button', {
          class: 'btn small',
          onClick: async () => {
            try {
              const { files } = await bridge.request('openDialog', { title: `Choose Document ${side.toUpperCase()}` });
              if (files?.[0]) chosen[side] = files[0];
              refresh();
            } catch (err) {
              toast(err.message, { kind: 'error' });
            }
          },
        }, 'Choose…');
        const el = h('div', { class: 'cmp-pick' },
          h('span', { class: `cmp-file-tag ${side}`, text: side.toUpperCase() }),
          h('span', { class: 'cmp-pick-text' }, h('span', { class: 'cmp-pick-label', text: `Document ${side.toUpperCase()}` }), name),
          button);
        return { el, update: () => { name.textContent = chosen[side]?.name ?? 'No document chosen'; name.classList.toggle('empty', !chosen[side]); } };
      };
      const rows = [row('a'), row('b')];
      const choice = await showDialog({
        title: 'Compare documents',
        message: 'Shows what changed from Document A to Document B: text added, removed and changed, and pages added, removed or moved. Both files are only read.',
        iconName: 'files',
        className: 'compare-dialog',
        content: [h('div', { class: 'cmp-picks' }, rows.map((r) => r.el))],
        buttons: [{ id: 'cancel', label: 'Cancel' }, { id: 'compare', label: 'Compare', primary: true }],
        bind: ({ dialog }) => {
          refresh = () => {
            for (const r of rows) r.update();
            const primary = dialog.querySelector('.dialog-actions .primary');
            if (primary) primary.disabled = !(chosen.a && chosen.b);
          };
          refresh();
        },
      });
      if (choice !== 'compare' || !chosen.a || !chosen.b) return null;
      return actions.start(chosen.a, chosen.b);
    },

    /** Compares two host-described files ({ name, path, url }). */
    async start(a, b) {
      current?.close();
      const view = new CompareView({
        pdfjsLib,
        files: { a, b },
        askPassword: promptPassword,
        onClose: (closed) => { if (current === closed) current = null; app.active?.focus?.(); },
      });
      current = view;
      await view.start();
      return view;
    },

    close() {
      current?.close();
    },
  };
  return actions;
}
