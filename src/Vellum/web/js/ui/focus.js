// Where keyboard focus goes when a dialog, the command palette or a menu closes: back to what had it,
// or, when that is gone or hidden (a menu item that opened the dialog, a closed tab), to the document.
// And what makes a surface modal (openModal): the one way to do it, so every modal behaves the same.

let fallback = () => {};

/** app.js: what gets focus when the previous element can't (the active document). */
export function setFocusFallback(fn) { fallback = fn; }

export function restoreFocus(previous) {
  const usable = previous instanceof HTMLElement && previous !== document.body && previous.isConnected
    && !previous.closest('[inert], [aria-hidden="true"], [hidden]') && previous.getClientRects().length > 0;
  if (usable) previous.focus({ preventScroll: true });
  else fallback();
}

const TAB_STOPS = 'button, input, select, textarea, [href], [tabindex]';

/** Keeps Tab and Shift+Tab going round inside `container` (a modal) instead of leaving it. */
export function keepTabInside(e, container) {
  if (e.key !== 'Tab') return;
  const stops = [...container.querySelectorAll(TAB_STOPS)]
    .filter((el) => el.tabIndex >= 0 && !el.disabled && el.getClientRects().length > 0);
  const first = stops[0];
  const last = stops.at(-1);
  if (first && e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
  else if (last && !e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
}

/** A modal is open (a dialog, Compare, Tools): nothing else modal may open over it. */
export function modalOpen() {
  return document.querySelector('#overlay-root :is([aria-modal="true"], [data-own-keys])') !== null;
}

/**
 * Opens `surface` in #overlay-root as the one modal, `dialog` (role="dialog", inside it) being what
 * holds the keyboard: the app behind it is inert, so no pointer, Tab or screen reader reaches it;
 * shortcuts stop (data-own-keys, shortcuts.js), so no single-letter key acts on the document under it;
 * Tab goes round inside it; and Esc calls `onEscape`. A text selection on the page is kept for when it
 * closes. Returns close(), which gives all of that back (the surface stays, inert, for its owner to
 * animate out and remove), or null when another modal is open.
 */
export function openModal(surface, { dialog = surface, onEscape }) {
  if (modalOpen()) return null;
  const app = document.getElementById('app');
  const returnTo = document.activeElement;
  const putBackSelection = keepSelection();
  const onKey = (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      onEscape();
    } else keepTabInside(e, dialog);
  };
  dialog.setAttribute('aria-modal', 'true');
  dialog.dataset.ownKeys = '';
  dialog.addEventListener('keydown', onKey);
  document.getElementById('overlay-root').append(surface);
  app.inert = true;
  let open = true;
  return () => {
    if (!open) return;
    open = false;
    dialog.removeEventListener('keydown', onKey);
    dialog.removeAttribute('aria-modal');
    delete dialog.dataset.ownKeys;
    surface.inert = true; // what fades out can't be reached
    // The app first: restoreFocus won't hand focus to anything that is still inert.
    app.inert = false;
    restoreFocus(returnTo);
    // With nothing to go back to (Home: no document), focus still leaves the surface, for the page itself.
    if (surface.contains(document.activeElement)) document.activeElement.blur();
    putBackSelection?.();
  };
}

/** The page's text selection, if there is one, as a function that puts it back (while its text is still there). */
function keepSelection() {
  const selection = getSelection();
  if (!selection?.rangeCount || selection.isCollapsed) return null;
  const ranges = Array.from({ length: selection.rangeCount }, (_, i) => selection.getRangeAt(i).cloneRange());
  return () => {
    if (!ranges.every((r) => r.startContainer.isConnected && r.endContainer.isConnected)) return;
    const now = getSelection();
    now.removeAllRanges();
    for (const range of ranges) now.addRange(range);
  };
}
