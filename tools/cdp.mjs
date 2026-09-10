// Dev tool: drive the running app's WebView2 over the Chrome DevTools Protocol.
// Start Vellum with tools/run.ps1 -Debug (exposes port 9222), then:
//   node tools/cdp.mjs eval "document.title"
//   node tools/cdp.mjs shot out.png
//   node tools/cdp.mjs send Input.dispatchKeyEvent '{"type":"keyDown","key":"F"}'
import fs from 'node:fs';

const port = process.env.CDP_PORT || 9222;
const [cmd, arg, arg2] = process.argv.slice(2);

// The app may still be starting: poll for the page target for up to 20s.
let target;
for (let i = 0; i < 80 && !target; i++) {
  try {
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    target = targets.find((t) => t.type === 'page' && t.url.startsWith('https://app.vellum'));
  } catch { /* not listening yet */ }
  if (!target) await new Promise((r) => setTimeout(r, 250));
}
if (!target) { console.error('No Vellum page target found'); process.exit(2); }

const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let nextId = 0;
const pending = new Map();
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
};
const send = (method, params = {}) => new Promise((res) => {
  const id = ++nextId;
  pending.set(id, res);
  ws.send(JSON.stringify({ id, method, params }));
});

if (cmd === 'eval') {
  const r = await send('Runtime.evaluate', { expression: arg, awaitPromise: true, returnByValue: true });
  const res = r.result?.result;
  if (r.result?.exceptionDetails) console.log('EXCEPTION', JSON.stringify(r.result.exceptionDetails.exception?.description ?? r.result.exceptionDetails));
  else console.log(typeof res?.value === 'string' ? res.value : JSON.stringify(res?.value ?? res, null, 1));
} else if (cmd === 'wait') {
  // Poll until the expression is truthy (default 20s), then print its value.
  const deadline = Date.now() + Number(arg2 || 20000);
  let value;
  while (Date.now() < deadline) {
    const r = await send('Runtime.evaluate', { expression: arg, awaitPromise: true, returnByValue: true });
    value = r.result?.result?.value;
    if (value) break;
    await new Promise((res) => setTimeout(res, 250));
  }
  console.log(value ? 'OK ' + JSON.stringify(value) : 'TIMEOUT');
} else if (cmd === 'shot') {
  const r = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(arg, Buffer.from(r.result.data, 'base64'));
  console.log('saved', arg);
} else if (cmd === 'send') {
  const r = await send(arg, arg2 ? JSON.parse(arg2) : {});
  console.log(JSON.stringify(r.result ?? r.error));
} else {
  console.error('usage: cdp.mjs eval <expr> | shot <file.png> | send <method> [json]');
}
ws.close();
