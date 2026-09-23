// Office → PDF providers in the real app, across the WPF/WebView2 boundary (MainWindow.OfficeConversion.cs): the
// host answers office.providers from the registry and files alone — no dialog opens and no Office application
// starts — naming both providers in the order they are chosen and, for each of Word, Excel and PowerPoint, the
// provider that would convert it now or the reason none can. It holds on any PC, with or without Office or
// LibreOffice: what is installed is reported, never assumed. Conversions are tested on the host (tests/host;
// VELLUM_OFFICE_SMOKE=1 runs a real one), not here.

import { spawnSync } from 'node:child_process';

export const files = {};
export const timeoutMs = 60000;

const FORMATS = ['word', 'excel', 'powerpoint'];
const STATUSES = ['ready', 'noProvider', 'notSupported', 'unavailable'];
const OFFICE = ['WINWORD.EXE', 'EXCEL.EXE', 'POWERPNT.EXE', 'soffice.bin'];

/** How many of each Office program are running, as "1,0,0,0". */
const running = () => OFFICE.map((name) => {
  const out = spawnSync('tasklist', ['/FI', `IMAGENAME eq ${name}`, '/NH'], { encoding: 'utf8', timeout: 15000, killSignal: 'SIGKILL' }).stdout ?? '';
  return out.split('\n').filter((line) => line.trim().toLowerCase().startsWith(name.toLowerCase())).length;
}).join(',');

export async function run(t) {
  const { q, check, area } = t;
  const errorsBefore = await q(`__vellum.errors?.length ?? 0`);
  const before = running();

  area('office.providers');
  const report = await q(`(async () => {
    const { bridge } = await import(new URL('js/bridge.js', location.href).href);
    return bridge.request('office.providers');
  })()`);
  const providers = report?.providers ?? [];
  const formats = report?.formats ?? [];
  check('both providers are reported, in the order they are chosen',
    JSON.stringify(providers.map((p) => p.id)) === '["microsoft-office","libreoffice"]', JSON.stringify(report));
  check('each says whether it is installed and what it can convert, and claims nothing when it isn’t installed',
    providers.every((p) => typeof p.installed === 'boolean' && typeof p.name === 'string' && typeof p.detail === 'string'
      && Array.isArray(p.formats) && p.formats.every((f) => FORMATS.includes(f)) && (p.installed || p.formats.length === 0)));
  check('Word, Excel and PowerPoint each have an answer', JSON.stringify(formats.map((f) => f.format)) === JSON.stringify(FORMATS));
  check('ready names its provider; anything else names none and says why',
    formats.every((f) => STATUSES.includes(f.status) && (f.status === 'ready' ? Boolean(f.provider && f.providerName) && !f.reason : !f.provider && Boolean(f.reason))),
    JSON.stringify(formats));
  check('a ready format is one its provider says it can convert',
    formats.filter((f) => f.provider).every((f) => providers.find((p) => p.id === f.provider)?.formats.includes(f.format)));
  check('no Office application was started to find out', running() === before, `${before} → ${running()}`);
  console.log(`      ${providers.map((p) => `${p.name}: ${p.installed ? p.formats.join('/') || 'nothing it can convert' : 'not installed'}`).join('; ')}`);

  const errors = await q(`JSON.stringify(__vellum.errors?.slice(${errorsBefore}) ?? [])`);
  check('no errors', errors === '[]', errors);
}
