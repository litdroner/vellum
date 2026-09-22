// JS half of the C# <-> JS bridge (see Hosting/BridgeHost.cs for the message shapes).

const webview = window.chrome?.webview ?? null;
const pending = new Map();
const listeners = new Map();
let nextId = 1;

webview?.addEventListener('message', (e) => {
  const msg = e.data;
  if (msg && msg.replyTo) {
    const p = pending.get(msg.replyTo);
    if (!p) return;
    pending.delete(msg.replyTo);
    msg.ok ? p.resolve(msg.result) : p.reject(new Error(msg.error || 'Native call failed'));
  } else if (msg && msg.event) {
    for (const fn of listeners.get(msg.event) ?? []) fn(msg.payload);
  }
});

export const bridge = {
  get available() { return webview !== null; },

  /** Calls a native handler and resolves with its result. */
  request(type, payload = {}, additionalObjects = null) {
    if (!webview) return Promise.reject(new Error('Native bridge unavailable'));
    const id = nextId++;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      const message = { id, type, payload };
      if (additionalObjects) webview.postMessageWithAdditionalObjects(message, additionalObjects);
      else webview.postMessage(message);
    });
  },

  /** Fire-and-forget. */
  send(type, payload = {}) {
    webview?.postMessage({ id: 0, type, payload });
  },

  on(event, fn) {
    if (!listeners.has(event)) listeners.set(event, new Set());
    listeners.get(event).add(fn);
    return () => listeners.get(event).delete(fn);
  },
};

/**
 * Sends finished PDF bytes to a file the host registered (and only to that file), which writes it
 * atomically. `target` is a file the host described — a Save As target, a split part, a merge result.
 */
export async function writePdfFile(target, bytes) {
  const result = await fetch(`${new URL(target.url).origin}/save/${target.token}`, {
    method: 'POST', body: bytes, headers: { 'Content-Type': 'application/pdf' },
  });
  const outcome = await result.json().catch(() => ({ ok: false, error: `The file couldn’t be written (${result.status}).` }));
  if (!outcome.ok) throw new Error(outcome.error);
}
