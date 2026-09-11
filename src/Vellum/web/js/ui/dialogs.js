import { h } from '../dom.js';
import { icon } from '../icons.js';

// Modal dialogs and toasts.

/**
 * Shows a modal. Resolves with the id of the button pressed, or null if dismissed (Esc / backdrop).
 * buttons: [{ id, label, primary? }]
 * bind({ finish, dialog }): for dialogs that manage their own controls (e.g. the update dialog).
 */
export function showDialog({ title, message, content = [], buttons = [{ id: 'ok', label: 'OK', primary: true }], iconName, className = '', onOpen, bind }) {
  return new Promise((resolve) => {
    const titleId = `dlg-${Math.random().toString(36).slice(2)}`;
    const footer = h('div', { class: 'dialog-actions' });
    const dialog = h('div', { class: `dialog ${className}`, role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId },
      iconName ? h('div', { class: 'dialog-icon', html: icon(iconName, 22) }) : null,
      h('h2', { id: titleId, class: 'dialog-title', text: title }),
      message ? h('p', { class: 'dialog-message', text: message }) : null,
      content,
      footer);
    const backdrop = h('div', { class: 'dialog-backdrop ui' }, dialog);
    const previousFocus = document.activeElement;

    let finished = false;
    const finish = (result) => {
      if (finished) return;
      finished = true;
      backdrop.classList.remove('open');
      backdrop.addEventListener('transitionend', () => backdrop.remove(), { once: true });
      setTimeout(() => backdrop.remove(), 250);
      previousFocus?.focus?.({ preventScroll: true });
      resolve(result);
    };

    for (const b of buttons) {
      footer.append(h('button', { class: `btn${b.primary ? ' primary' : ''}`, onClick: () => finish(b.id) }, b.label));
    }
    backdrop.addEventListener('mousedown', (e) => { if (e.target === backdrop) finish(null); });
    dialog.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(null); }
      // Keep Tab inside the dialog while it's open (it's modal).
      if (e.key === 'Tab') {
        const focusable = [...dialog.querySelectorAll('button, input, select, textarea, [href], [tabindex]:not([tabindex="-1"])')]
          .filter((el) => !el.disabled && el.offsetParent !== null);
        const first = focusable[0];
        const last = focusable.at(-1);
        if (first && e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (last && !e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
      if (e.key === 'Enter' && !(e.target instanceof HTMLButtonElement)) {
        const primary = buttons.find((b) => b.primary);
        if (primary) { e.preventDefault(); finish(primary.id); }
      }
    });

    footer.hidden = buttons.length === 0;
    bind?.({ finish, dialog });
    document.getElementById('overlay-root').append(backdrop);
    requestAnimationFrame(() => backdrop.classList.add('open'));
    // Focus the primary (safe) action, so Enter never picks e.g. "Don't save" by accident.
    (onOpen ? onOpen(dialog) : footer.querySelector('.primary') ?? footer.querySelector('.btn'))?.focus?.();
  });
}

/** Asks for a PDF password. Resolves with the password, or null if the user cancels. */
export async function promptPassword({ fileName, incorrect = false }) {
  const input = h('input', { class: 'field', type: 'password', autocomplete: 'off', spellcheck: 'false', 'aria-label': 'Password', placeholder: 'Password' });
  const result = await showDialog({
    title: incorrect ? 'Incorrect password' : 'Password required',
    message: incorrect ? `That password didn’t unlock “${fileName}”. Try again.` : `“${fileName}” is protected. Enter its password to open it.`,
    iconName: 'key-round',
    className: incorrect ? 'shake' : '',
    content: [input],
    buttons: [{ id: 'cancel', label: 'Cancel' }, { id: 'ok', label: 'Unlock', primary: true }],
    onOpen: () => input,
  });
  return result === 'ok' ? input.value : null;
}

/**
 * A short message. `action: { label, run }` adds a button (e.g. Undo); such toasts stay a little longer.
 * kind: info | success | error | update | busy (a spinner). Returns a function that dismisses it early.
 */
export function toast(message, { kind = 'info', timeout = 3600, action = null } = {}) {
  let host = document.getElementById('toasts');
  if (!host) {
    host = h('div', { id: 'toasts', class: 'ui', 'aria-live': 'polite' });
    document.getElementById('overlay-root').append(host);
  }
  const iconName = { error: 'triangle-alert', success: 'check', update: 'sparkles' }[kind] ?? 'info';
  const dismiss = () => {
    el.classList.remove('open');
    setTimeout(() => el.remove(), 300);
  };
  const el = h('div', { class: `toast ${kind}${action ? ' has-action' : ''}`, role: kind === 'error' ? 'alert' : 'status' },
    kind === 'busy'
      ? h('span', { class: 'toast-icon' }, h('span', { class: 'toast-spinner' }))
      : h('span', { class: 'toast-icon', html: icon(iconName, 16) }),
    h('span', { text: message }),
    action ? h('button', { class: 'toast-action', onClick: () => { dismiss(); action.run(); } }, action.label) : null);
  host.append(el);
  requestAnimationFrame(() => el.classList.add('open'));
  const timer = setTimeout(dismiss, action ? Math.max(timeout, 6000) : timeout);
  return () => {
    clearTimeout(timer);
    dismiss();
  };
}
