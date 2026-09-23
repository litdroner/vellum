// Minimal Chrome DevTools Protocol client for driving Vellum's WebView2 in dev tests.
// The app must be started with tools/run.ps1 -Debug.
import fs from 'node:fs';

const VK = {
  Enter: 13, Escape: 27, Tab: 9, Space: 32, Backspace: 8, Delete: 46,
  PageUp: 33, PageDown: 34, End: 35, Home: 36, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40,
  F1: 112, F2: 113, F3: 114, F4: 115, F5: 116, F7: 118, F11: 122, F12: 123, '=': 187, '-': 189,
  // Punctuation needs its real virtual-key code and physical code, or Chromium drops the event.
  '[': 219, ']': 221, ',': 188, '.': 190, '/': 191, ';': 186, "'": 222, '`': 192,
};
const CODES = {
  '=': 'Equal', '-': 'Minus', ' ': 'Space',
  '[': 'BracketLeft', ']': 'BracketRight', ',': 'Comma', '.': 'Period', '/': 'Slash',
  ';': 'Semicolon', "'": 'Quote', '`': 'Backquote',
};

/**
 * Connects to Vellum's page. Nothing here waits without a limit:
 *   timeoutMs         for finding the page and opening the connection
 *   requestTimeoutMs  for each request's answer (default 60 s; one call can ask for longer, as
 *                     send(method, params, { timeoutMs }) and evaluate(expression, { timeoutMs }))
 * A request that isn't answered in time, or is pending when the connection closes, fails with a short
 * message naming it, so a hung page stops a test in seconds instead of holding it forever.
 */
export async function connect({ port = 9222, timeoutMs = 20000, requestTimeoutMs = 60000 } = {}) {
  let target;
  const deadline = Date.now() + timeoutMs;
  while (!target && Date.now() < deadline) {
    try {
      const signal = AbortSignal.timeout(Math.max(1, Math.min(5000, deadline - Date.now())));
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`, { signal })).json();
      target = list.find((t) => t.type === 'page' && t.url.startsWith('https://app.vellum'));
    } catch { /* not up yet */ }
    if (!target && Date.now() < deadline) await sleep(250);
  }
  if (!target) throw new Error(`No Vellum page target within ${Math.round(timeoutMs / 1000)} s`);

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  let openTimer;
  try {
    await new Promise((res, rej) => {
      ws.onopen = res;
      ws.onerror = () => rej(new Error('The DevTools connection couldn’t open'));
      openTimer = setTimeout(() => rej(new Error('The DevTools connection didn’t open within 10 s')), 10000);
    });
  } catch (err) {
    ws.close();
    throw err;
  } finally {
    clearTimeout(openTimer);
  }

  let nextId = 0;
  let closed = null;
  /** id → { resolve, reject, timer, what } of each request not answered yet. */
  const pending = new Map();
  const take = (id) => {
    const entry = pending.get(id);
    pending.delete(id);
    if (entry) clearTimeout(entry.timer);
    return entry;
  };
  const failAll = (reason) => {
    closed ??= reason;
    for (const id of [...pending.keys()]) { const entry = take(id); entry.reject(new Error(`${closed} (${entry.what})`)); }
  };
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id) take(m.id)?.resolve(m);
  };
  ws.onclose = () => failAll('The DevTools connection closed');
  ws.onerror = () => failAll('The DevTools connection failed');

  /** Sends one DevTools request; rejects if it isn't answered within the limit, or the connection closes. */
  const send = (method, params = {}, { timeoutMs: limit = requestTimeoutMs } = {}) => new Promise((resolve, reject) => {
    const what = method === 'Runtime.evaluate' ? `${method}: ${String(params.expression).replace(/\s+/g, ' ').slice(0, 100)}` : method;
    if (closed || ws.readyState !== WebSocket.OPEN) {
      reject(new Error(`${closed ?? 'The DevTools connection is closed'} (${what})`));
      return;
    }
    const id = ++nextId;
    const timer = setTimeout(() => take(id)?.reject(new Error(`${what} timed out after ${Math.round(limit / 1000)} s`)), limit);
    pending.set(id, { resolve, reject, timer, what });
    ws.send(JSON.stringify({ id, method, params }));
  });

  const evaluate = async (expression, { timeoutMs: limit } = {}) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, limit ? { timeoutMs: limit } : {});
    if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description ?? 'eval failed');
    return r.result?.result?.value;
  };

  /** key('Ctrl+Shift+F'), key('Enter'), key('F4'), key('Ctrl+=') */
  const key = async (combo) => {
    const parts = combo.split('+');
    let name = parts.pop();
    if (name === '' && combo.endsWith('+')) name = '+';
    const mods = new Set(parts);
    const modifiers = (mods.has('Alt') ? 1 : 0) | (mods.has('Ctrl') ? 2 : 0) | (mods.has('Shift') ? 8 : 0);
    let code;
    let keyValue = name;
    let vk = VK[name];
    if (/^[A-Z]$/i.test(name)) {
      code = `Key${name.toUpperCase()}`;
      vk = name.toUpperCase().charCodeAt(0);
      keyValue = mods.has('Shift') ? name.toUpperCase() : name.toLowerCase();
    } else if (/^\d$/.test(name)) {
      code = `Digit${name}`;
      vk = name.charCodeAt(0);
    } else {
      code = CODES[name] ?? name;
    }
    const base = { modifiers, key: keyValue, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk };
    await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
  };

  const type = (text) => send('Input.insertText', { text });

  /** modifiers: the same bits as key() uses (Alt 1, Ctrl 2, Shift 8), held for the whole click. */
  const mouse = async (x, y, { button = 'left', clickCount = 1, modifiers = 0 } = {}) => {
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, modifiers });
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button, clickCount, modifiers });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button, clickCount, modifiers });
  };

  const drag = async (from, to, steps = 8, { modifiers = 0 } = {}) => {
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: from[0], y: from[1], modifiers });
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: from[0], y: from[1], button: 'left', clickCount: 1, modifiers });
    for (let i = 1; i <= steps; i++) {
      const x = from[0] + ((to[0] - from[0]) * i) / steps;
      const y = from[1] + ((to[1] - from[1]) * i) / steps;
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'left', buttons: 1, modifiers });
    }
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: to[0], y: to[1], button: 'left', clickCount: 1, modifiers });
  };

  const wheel = (x, y, deltaY, modifiers = 0) =>
    send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: 0, deltaY, modifiers });

  const shot = async (file) => {
    const r = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(file, Buffer.from(r.result.data, 'base64'));
    return file;
  };

  return { send, evaluate, key, type, mouse, drag, wheel, shot, sleep, close: () => ws.close() };
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
