// What every end-to-end suite gets: the DevTools client, checks, waiting and screenshots.
import path from 'node:path';
import { sleep } from '../../tools/cdp-client.mjs';

export function createContext({ c, dir, files, results }) {
  const q = (expr) => c.evaluate(expr);
  let area = null;
  const check = (label, ok, detail = '') => {
    const entry = { area, ok: Boolean(ok), label, detail: detail === undefined || detail === null ? '' : String(detail).slice(0, 600) };
    results.push(entry);
    console.log(`${entry.ok ? 'PASS' : 'FAIL'}  ${area ? `[${area}] ` : ''}${label}${entry.detail ? ` — ${entry.detail}` : ''}`);
    return entry.ok;
  };
  const waitFor = async (expr, ms = 15000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      try { if (await q(expr)) return true; } catch { /* busy */ }
      await sleep(80);
    }
    return false;
  };
  const V = (file) => `__vellum.app.views.find((v) => v.file.path.toLowerCase() === ${JSON.stringify(file.toLowerCase())})`;
  const settled = (file) => `(() => { const v = ${V(file)}; return Boolean(v) && v.status === 'ready' && !v.rebuilding; })()`;
  return {
    c, q, check, waitFor, sleep, V, settled, dir, results,
    /** The copy of a fixture this suite asked for (see its `files`). */
    file: (name) => files[name],
    /** Groups the following checks under a heading in the report. */
    area: (name) => { area = name; },
    shot: (name) => c.shot(path.join(dir, 'shots', `${name}.png`)),
  };
}
