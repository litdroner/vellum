// Where keyboard focus goes when a dialog, the command palette or a menu closes: back to what had it,
// or, when that is gone or hidden (a menu item that opened the dialog, a closed tab), to the document.

let fallback = () => {};

/** app.js: what gets focus when the previous element can't (the active document). */
export function setFocusFallback(fn) { fallback = fn; }

export function restoreFocus(previous) {
  const usable = previous instanceof HTMLElement && previous !== document.body && previous.isConnected
    && !previous.closest('[inert], [aria-hidden="true"], [hidden]') && previous.getClientRects().length > 0;
  if (usable) previous.focus({ preventScroll: true });
  else fallback();
}
