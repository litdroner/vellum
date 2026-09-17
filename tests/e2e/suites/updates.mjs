// In-app updates in the real app, against a loopback release feed (VELLUM_UPDATE_FEED) and a test
// installer with its own AppId that installs nothing: never a real release, never a real install.
// Only when named (it needs Inno Setup 6 to build the test installer).
//
// An older release says "up to date". A download that doesn't match its published checksum is refused
// inside Vellum, which stays open and runs nothing. A verified one goes Downloading → Verifying →
// Installing → Restarting inside Vellum's own dialog with no "Restart" question; Setup gets
// /VERYSILENT (no Setup window) and finds Vellum closed. The test installer then fails on purpose, so
// the installer code shared with Vellum.iss (installer/InAppUpdate.iss) starts Vellum again by itself:
// the document comes back and Vellum says the update didn't install.

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { connect } from '../../../tools/cdp-client.mjs';

export const files = { 'update-doc': 'compare-a' };

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const EXE = path.join(ROOT, 'src', 'Vellum', 'bin', 'Debug', 'net10.0-windows', 'Vellum.exe');
const VERSION = '99.0.0';

let server = null;
let mode = 'good';
let setupBytes = null;
let record = null;

const iscc = () => [
  path.join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Inno Setup 6', 'ISCC.exe'),
  path.join(process.env['ProgramFiles(x86)'] ?? '', 'Inno Setup 6', 'ISCC.exe'),
  path.join(process.env.ProgramFiles ?? '', 'Inno Setup 6', 'ISCC.exe'),
].find((p) => fs.existsSync(p));

/** Builds the test installer and starts the feed; returns the environment for the app. */
export async function prepare({ dir }) {
  const compiler = iscc();
  if (!compiler) throw new Error('Inno Setup 6 isn’t installed: the updates suite needs it to build its test installer');
  const out = path.join(dir, 'installer');
  fs.mkdirSync(out, { recursive: true });
  record = path.join(dir, 'installer-record.txt');
  const script = path.join(out, 'UpdateTest.iss');
  fs.writeFileSync(script, `#define UpdateRelaunchExe "{%VELLUM_E2E_EXE}"
[Setup]
AppId=VellumE2EUpdateTest
AppName=Vellum update test
AppVersion=${VERSION}
CreateAppDir=no
Uninstallable=no
PrivilegesRequired=lowest
OutputDir=${out}
OutputBaseFilename=Vellum-Setup

[Code]
#include "${path.join(ROOT, 'installer', 'InAppUpdate.iss')}"

function InitializeSetup(): Boolean;
begin
  WaitForVellumToClose();
  SaveStringToFile(ExpandConstant('{%VELLUM_E2E_RECORD}'), 'args=' + GetCmdTail() + #13#10 +
    'vellumRunning=' + IntToStr(Ord(CheckForMutexes('Local\\Vellum.Running'))) + #13#10, False);
  Result := True;
end;

// Fails on purpose, after Vellum has closed: nothing is installed.
function PrepareToInstall(var NeedsRestart: Boolean): String;
begin
  Result := 'Simulated failure (Vellum end-to-end test)';
end;

procedure CurStepChanged(CurStep: TSetupStep);
begin
  NoteUpdateStep(CurStep);
end;

procedure DeinitializeSetup();
begin
  RelaunchIfUpdateFailed();
end;
`);
  const built = spawnSync(compiler, ['/Q', script], { encoding: 'utf8' });
  if (built.status !== 0) throw new Error(`the test installer didn’t build: ${built.stdout}${built.stderr}`);
  setupBytes = fs.readFileSync(path.join(out, 'Vellum-Setup.exe'));
  const sha = crypto.createHash('sha256').update(setupBytes).digest('hex');

  server = http.createServer((req, res) => {
    const base = `http://127.0.0.1:${server.address().port}`;
    if (req.url === '/release') {
      const wrong = mode === 'badsum' ? '0'.repeat(64) : sha;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        tag_name: mode === 'old' ? 'v0.0.1' : `v${VERSION}`,
        name: `Vellum ${VERSION}`,
        body: 'Test release.',
        html_url: 'https://github.com/litdroner/vellum/releases',
        published_at: new Date().toISOString(),
        assets: [{ name: 'Vellum-Setup.exe', size: setupBytes.length, digest: `sha256:${wrong}`, browser_download_url: `${base}/Vellum-Setup-${mode}.exe` }],
      }));
    } else if (req.url.startsWith('/Vellum-Setup')) {
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': setupBytes.length });
      res.end(setupBytes);
    } else {
      res.writeHead(404).end();
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    VELLUM_UPDATE_FEED: `http://127.0.0.1:${server.address().port}/release`,
    VELLUM_E2E_EXE: EXE,
    VELLUM_E2E_RECORD: record,
  };
}

export async function run(t) {
  const { c, q, check, sleep, shot, V, settled, waitFor, area } = t;
  const DOC = t.file('update-doc');
  const top = `[...document.querySelectorAll('.dialog')].at(-1)`;
  const clickButton = (label) => q(`(() => { const b = [...${top}.querySelectorAll('button')].find((x) => x.textContent === ${JSON.stringify(label)}); b?.click(); return Boolean(b); })()`);
  const closeDialogs = () => q(`document.querySelectorAll('.dialog').forEach((d) => d.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))`);

  await waitFor(settled(DOC), 25000);

  area('version');
  mode = 'old';
  await q(`__vellum.ui.updates.checkNow(); true`);
  check('an older release says Vellum is up to date',
    await waitFor(`[...document.querySelectorAll('#toasts .toast')].some((x) => /up to date/.test(x.textContent))`, 10000));

  area('checksum');
  mode = 'badsum';
  await q(`__vellum.ui.updates.checkNow(); true`);
  check('a newer release opens the update dialog', await waitFor(`${top}?.classList.contains('update-dialog') && /${VERSION.replace(/\./g, '\\.')}/.test(${top}.textContent)`, 10000));
  check('…offering “Update now”', await clickButton('Update now'));
  check('a download that doesn’t match its checksum is refused inside Vellum',
    await waitFor(`/didn’t match its published checksum/.test(document.querySelector('.update-dialog .update-status')?.textContent)`, 20000));
  check('…nothing was run', !fs.existsSync(record));
  check('…and Vellum is still open with the document', await q(`Boolean(${V(DOC)})`));
  await closeDialogs();
  await sleep(400);

  area('install');
  mode = 'good';
  await q(`__vellum.ui.updates.checkNow(); true`);
  await waitFor(`${top}?.classList.contains('update-dialog')`, 10000);
  // Every status and every button label the dialog shows from here on.
  await q(`(() => {
    const d = document.querySelector('.update-dialog');
    window.__updateSeen = [];
    const note = () => {
      const status = d.querySelector('.update-status')?.textContent ?? '';
      const buttons = [...d.querySelectorAll('.update-actions button')].map((b) => b.textContent).join('|');
      const entry = status + ' [' + buttons + ']';
      if (window.__updateSeen.at(-1) !== entry) window.__updateSeen.push(entry);
    };
    new MutationObserver(note).observe(d, { subtree: true, childList: true, characterData: true });
    return true;
  })()`);
  await clickButton('Update now');
  // The window closes shortly after "Restarting…"; read what was shown before it goes.
  let seen = [];
  const until = Date.now() + 30000;
  while (Date.now() < until) {
    const now = await Promise.race([q(`window.__updateSeen`).catch(() => null), sleep(1500).then(() => null)]);
    if (!now) break;
    seen = now;
    if (seen.some((s) => s.startsWith('Restarting…'))) break;
    await sleep(40);
  }
  await shot('restarting').catch(() => {});
  const statuses = seen.map((s) => s.replace(/ ?\[.*$/, '').replace(/ \d.*$/, ''));
  const order = ['Downloading…', 'Verifying…', 'Installing…', 'Restarting…'].map((s) => statuses.indexOf(s));
  check('Vellum shows Downloading, Verifying, Installing and Restarting, in that order',
    order.every((i, n) => i >= 0 && (n === 0 || i > order[n - 1])), JSON.stringify(seen));
  check('…with no “Restart” question on the way', !seen.some((s) => /\[[^\]]*Restart/.test(s)), JSON.stringify(seen));
  c.close();

  const setupRan = await (async () => {
    const end = Date.now() + 40000;
    while (Date.now() < end) {
      if (fs.existsSync(record) && fs.readFileSync(record, 'utf8').includes('vellumRunning=')) return true;
      await sleep(200);
    }
    return false;
  })();
  check('Setup ran', setupRan);
  const recorded = setupRan ? fs.readFileSync(record, 'utf8') : '';
  check('…with no window of its own (/VERYSILENT)', /\/VERYSILENT\b/i.test(recorded) && !/\/SILENT\b/i.test(recorded), recorded.trim());
  check('…after Vellum had closed', /vellumRunning=0/.test(recorded), recorded.trim());

  area('restart');
  let c2 = null;
  try {
    c2 = await connect({ timeoutMs: 60000 });
  } catch (err) {
    check('Vellum starts again by itself', false, String(err));
    return;
  }
  const q2 = (expr) => c2.evaluate(expr);
  const wait2 = async (expr, ms) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      try { if (await q2(expr)) return true; } catch { /* busy */ }
      await sleep(100);
    }
    return false;
  };
  check('Vellum starts again by itself', await wait2('Boolean(window.__vellum && __vellum.app && __vellum.ui)', 30000));
  check('…and reopens the document', await wait2(settled(DOC), 25000));
  check('…and says the update didn’t install, keeping the version it has',
    await wait2(`[...document.querySelectorAll('.dialog')].some((d) => /didn’t install/.test(d.textContent) && /${VERSION.replace(/\./g, '\\.')} couldn’t be installed/.test(d.textContent))`, 10000));
  await c2.shot(path.join(t.dir, 'shots', 'update-failed.png')).catch(() => {});
  c2.close();
}

/** Stops the feed and the Vellum that Setup started (it isn't the harness's own process). */
export async function cleanup() {
  server?.close();
  const ps = `Get-CimInstance Win32_Process -Filter "Name='Vellum.exe'" | Where-Object { $_.ExecutablePath -eq '${EXE.replace(/'/g, "''")}' } | ForEach-Object { taskkill /PID $_.ProcessId /T /F | Out-Null }`;
  spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], { stdio: 'ignore' });
}
