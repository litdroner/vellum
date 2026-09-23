// In-app updates in the real app, against a loopback release feed (VELLUM_UPDATE_FEED) and test installers
// with their own AppIds that only ever write into this run's temp folder: never a real release, never
// the real install. Only when named (it needs Inno Setup 6 to build the test installers).
//
// The app runs from a scratch "installed" copy of the Debug build (the old version). A second copy of the
// project is built as version 99.0.0 (the new version). Both test installers include the installer code
// shared with Vellum.iss (installer/InAppUpdate.iss).
//
// An older release says "up to date". A download that doesn't match its published checksum is refused
// inside Vellum, which stays open and runs nothing. A verified one goes Downloading → Verifying →
// Installing → Restarting inside Vellum's own dialog with no "Restart" question; Setup gets
// /VERYSILENT and finds Vellum closed.
// Failure: the first installer fails on purpose; Vellum starts again by itself, reopens the document and
// says the update didn't install.
// Success: the second installer replaces the installed files with the 99.0.0 build and starts it: the old
// process is gone, the new version runs and says so, the document is back, no dialog or error, and no
// Setup window was ever visible.

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { connect, sleep } from '../../../tools/cdp-client.mjs';

export const files = { 'update-doc': 'compare-a' };
// Two builds, test installers, installs and restarts.
export const timeoutMs = 900000;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const DEBUG_OUT = path.join(ROOT, 'src', 'Vellum', 'bin', 'Debug', 'net10.0-windows');
const VERSION = '99.0.0';

let server = null;
let mode = 'good';
let runDir = null;
let installed = null;
let record = null;
const installers = {};

const iscc = () => [
  path.join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Inno Setup 6', 'ISCC.exe'),
  path.join(process.env['ProgramFiles(x86)'] ?? '', 'Inno Setup 6', 'ISCC.exe'),
  path.join(process.env.ProgramFiles ?? '', 'Inno Setup 6', 'ISCC.exe'),
].find((p) => fs.existsSync(p));

const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const esc = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The Pascal both test installers share: record what Setup saw, then the same update hooks as Vellum.iss. */
const commonCode = (extra) => `[Code]
#include "${path.join(ROOT, 'installer', 'InAppUpdate.iss')}"

procedure Note(Line: String);
begin
  SaveStringToFile(ExpandConstant('{%VELLUM_E2E_RECORD}'), Line + #13#10, True);
end;

function InitializeSetup(): Boolean;
begin
  WaitForVellumToClose();
  Note('args=' + GetCmdTail());
  Note('vellumRunning=' + IntToStr(Ord(CheckForMutexes('Local\\Vellum.Running'))));
  Result := True;
end;

procedure CurStepChanged(CurStep: TSetupStep);
begin
  NoteUpdateStep(CurStep);
  if CurStep = ssDone then Note('installed=1');
end;

procedure DeinitializeSetup();
begin
  RelaunchIfUpdateFailed();
end;
${extra}`;

function compile(compiler, name, script) {
  const out = path.join(runDir, 'installers', name);
  fs.mkdirSync(out, { recursive: true });
  const file = path.join(out, 'UpdateTest.iss');
  fs.writeFileSync(file, script.replace('@OUT@', out));
  const built = spawnSync(compiler, ['/Q', file], { encoding: 'utf8', timeout: 300000, killSignal: 'SIGKILL' });
  if (built.status !== 0) throw new Error(`the ${name} test installer didn’t build: ${built.stdout}${built.stderr}`);
  const bytes = fs.readFileSync(path.join(out, 'Vellum-Setup.exe'));
  installers[name] = { bytes, sha: sha256(bytes) };
}

/** Builds the old and new versions and the test installers, and starts the feed. */
export async function prepare({ dir }) {
  runDir = dir;
  const compiler = iscc();
  if (!compiler) throw new Error('Inno Setup 6 isn’t installed: the updates suite needs it to build its test installers');
  record = path.join(dir, 'installer-record.txt');

  // The old version, "installed" in the temp folder (the Debug build as it is).
  installed = path.join(dir, 'installed');
  fs.cpSync(DEBUG_OUT, installed, { recursive: true, filter: (src) => path.relative(DEBUG_OUT, src).split(path.sep)[0] !== 'win-x64' });

  // The new version: a copy of the project built as 99.0.0 (the repository's own build is left alone).
  const newSrc = path.join(dir, 'new-src');
  const newBuild = path.join(dir, 'new-build');
  const projectDir = path.join(ROOT, 'src', 'Vellum');
  fs.cpSync(projectDir, newSrc, { recursive: true, filter: (src) => !['bin', 'obj'].includes(path.relative(projectDir, src).split(path.sep)[0]) });
  const local = path.join(process.env.LOCALAPPDATA ?? '', 'Microsoft', 'dotnet');
  const hasLocal = fs.existsSync(path.join(local, 'dotnet.exe'));
  const build = spawnSync(hasLocal ? path.join(local, 'dotnet.exe') : 'dotnet',
    ['build', path.join(newSrc, 'Vellum.csproj'), '-c', 'Debug', `-p:Version=${VERSION}`, '-o', newBuild, '--nologo', '-v', 'q'],
    { encoding: 'utf8', env: hasLocal ? { ...process.env, DOTNET_ROOT: local } : process.env, timeout: 600000, killSignal: 'SIGKILL' });
  if (build.status !== 0) throw new Error(`the ${VERSION} build failed: ${build.error?.code === 'ETIMEDOUT' ? 'stopped after 10 minutes' : ''}${build.stdout}${build.stderr}`.slice(0, 2000));

  const setup = (appId) => `[Setup]
AppId=${appId}
AppName=Vellum update test
AppVersion=${VERSION}
PrivilegesRequired=lowest
OutputDir=@OUT@
OutputBaseFilename=Vellum-Setup
`;
  // Fails on purpose, after Vellum has closed: nothing is installed.
  compile(compiler, 'fail', `#define UpdateRelaunchExe "${path.join(installed, 'Vellum.exe')}"
${setup('VellumE2EUpdateFailTest')}CreateAppDir=no
Uninstallable=no

${commonCode(`
function PrepareToInstall(var NeedsRestart: Boolean): String;
begin
  Result := 'Simulated failure (Vellum end-to-end test)';
end;
`)}`);
  // Installs the new version over the old one in the temp folder, and starts it (as Vellum.iss does).
  compile(compiler, 'success', `${setup('VellumE2EUpdateSuccessTest')}DefaultDirName=${installed}
DisableDirPage=yes
DirExistsWarning=no
Uninstallable=no
Compression=zip/1
SolidCompression=no

[Files]
Source: "${newBuild}\\*"; DestDir: "{app}"; Flags: recursesubdirs createallsubdirs ignoreversion

[Run]
Filename: "{app}\\Vellum.exe"; Flags: nowait; Check: RelaunchAfterUpdate

${commonCode('')}`);

  server = http.createServer((req, res) => {
    const base = `http://127.0.0.1:${server.address().port}`;
    const installer = installers[mode === 'good' ? 'success' : 'fail'];
    if (req.url === '/release') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        tag_name: mode === 'old' ? 'v0.0.1' : `v${VERSION}`,
        name: `Vellum ${VERSION}`,
        body: 'Test release.',
        html_url: 'https://github.com/litdroner/vellum/releases',
        published_at: new Date().toISOString(),
        assets: [{
          name: 'Vellum-Setup.exe',
          size: installer.bytes.length,
          digest: `sha256:${mode === 'badsum' ? '0'.repeat(64) : installer.sha}`,
          browser_download_url: `${base}/Vellum-Setup-${mode}.exe`,
        }],
      }));
    } else if (req.url === `/Vellum-Setup-${mode}.exe`) {
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': installer.bytes.length });
      res.end(installer.bytes);
    } else {
      res.writeHead(404).end();
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    exe: path.join(installed, 'Vellum.exe'),
    env: { VELLUM_UPDATE_FEED: `http://127.0.0.1:${server.address().port}/release`, VELLUM_E2E_RECORD: record },
  };
}

/** Evaluating in a page that may be closing: gives up after a moment instead of waiting forever. */
function page(c) {
  const q = (expr) => c.evaluate(expr);
  const tryQ = (expr, ms = 1500) => Promise.race([q(expr).catch(() => null), sleep(ms).then(() => null)]);
  const waitFor = async (expr, ms = 15000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      try { if (await q(expr)) return true; } catch { /* busy */ }
      await sleep(80);
    }
    return false;
  };
  const top = `[...document.querySelectorAll('.dialog')].at(-1)`;
  const clickButton = (label) => q(`(() => { const b = [...${top}.querySelectorAll('button')].find((x) => x.textContent === ${JSON.stringify(label)}); b?.click(); return Boolean(b); })()`);
  return { c, q, tryQ, waitFor, top, clickButton };
}

/** Vellum processes started from the temp "installed" folder. */
function installedPids() {
  const ps = `Get-CimInstance Win32_Process -Filter "Name='Vellum.exe'" | Where-Object { $_.ExecutablePath -eq '${path.join(installed, 'Vellum.exe').replace(/'/g, "''")}' } | ForEach-Object { $_.ProcessId }`;
  const out = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], { encoding: 'utf8', timeout: 60000, killSignal: 'SIGKILL' }).stdout ?? '';
  return out.split(/\s+/).filter(Boolean).map(Number);
}

/**
 * Watches for visible top-level windows owned by Setup (Vellum-Setup-*.exe and its Vellum-Setup-*.tmp)
 * until stopped. Also counts how often a Setup process was seen, so "no window" isn't vacuous.
 */
async function watchSetupWindows() {
  const out = path.join(runDir, 'setup-windows.txt');
  const stop = path.join(runDir, 'setup-windows.stop');
  const ready = path.join(runDir, 'setup-windows.ready');
  const script = path.join(runDir, 'watch-setup-windows.ps1');
  fs.writeFileSync(script, `
Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class Win {
  public delegate bool EnumProc(IntPtr h, IntPtr p);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc f, IntPtr p);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr h, int i);
}
"@
$seen = 0
$hits = @{}
New-Item -ItemType File -Force '${ready}' | Out-Null
$end = (Get-Date).AddSeconds(150)
while (-not (Test-Path '${stop}') -and (Get-Date) -lt $end) {
  $setup = @(Get-Process | Where-Object { $_.ProcessName -like 'Vellum-Setup*' })
  if ($setup.Count -gt 0) {
    $seen++
    $ids = $setup | ForEach-Object { [uint32]$_.Id }
    [Win]::EnumWindows({ param($h, $p)
      $procId = [uint32]0
      [void][Win]::GetWindowThreadProcessId($h, [ref]$procId)
      if ($ids -contains $procId -and [Win]::IsWindowVisible($h)) {
        $t = New-Object System.Text.StringBuilder 256; [void][Win]::GetWindowText($h, $t, 256)
        $k = New-Object System.Text.StringBuilder 256; [void][Win]::GetClassName($h, $k, 256)
        $r = New-Object Win+RECT; [void][Win]::GetWindowRect($h, [ref]$r)
        $w = $r.Right - $r.Left; $hh = $r.Bottom - $r.Top
        $exStyle = '0x{0:X}' -f [Win]::GetWindowLong($h, -20)
        # A window with no area can't be seen; it is still reported, separately.
        $kind = if ($w -gt 1 -and $hh -gt 1) { 'visible' } else { 'zero-size' }
        $hits["$kind=$procId|$($k.ToString())|$($t.ToString())|$($w)x$($hh) at $($r.Left),$($r.Top)|exstyle $exStyle"] = 1
      }
      return $true }, [IntPtr]::Zero) | Out-Null
  }
  Start-Sleep -Milliseconds 40
}
Set-Content -Path '${out}' -Value (@("seen=$seen") + @($hits.Keys))
`);
  const child = spawn('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script], { stdio: 'ignore' });
  const exited = new Promise((resolve) => child.once('exit', resolve));
  const until = Date.now() + 30000;
  while (!fs.existsSync(ready) && Date.now() < until) await sleep(100);
  return async () => {
    fs.writeFileSync(stop, '');
    await Promise.race([exited, sleep(10000)]);
    const lines = fs.existsSync(out) ? fs.readFileSync(out, 'utf8').split(/\r?\n/).filter(Boolean) : [];
    return {
      seen: Number(lines.find((l) => l.startsWith('seen='))?.slice(5) ?? 0),
      visible: lines.filter((l) => l.startsWith('visible=')),
      zeroSize: lines.filter((l) => l.startsWith('zero-size=')),
    };
  };
}

/**
 * "Update now" in the dialog that's open, reading every status and button it shows until the window
 * closes; checks the four stages and that nothing asks to restart. Then waits for Setup's record.
 */
async function installFromDialog(t, p, marker) {
  const { check } = t;
  await p.q(`(() => {
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
  const before = fs.existsSync(record) ? fs.readFileSync(record, 'utf8').length : 0;
  await p.clickButton('Update now');
  // The window closes shortly after "Restarting…"; read what was shown before it goes.
  let seen = [];
  const until = Date.now() + 60000;
  while (Date.now() < until) {
    const now = await p.tryQ(`window.__updateSeen`);
    if (!now) break;
    seen = now;
    if (seen.some((s) => s.startsWith('Restarting…'))) break;
    await sleep(40);
  }
  const statuses = seen.map((s) => s.replace(/ ?\[.*$/, '').replace(/ \d.*$/, ''));
  const order = ['Downloading…', 'Verifying…', 'Installing…', 'Restarting…'].map((s) => statuses.indexOf(s));
  check('Vellum shows Downloading, Verifying, Installing and Restarting, in that order',
    order.every((i, n) => i >= 0 && (n === 0 || i > order[n - 1])), JSON.stringify(seen));
  check('…with no “Restart” question on the way', !seen.some((s) => /\[[^\]]*Restart/.test(s)), JSON.stringify(seen));
  check('…and no error', !seen.some((s) => /couldn’t|didn’t|failed/i.test(s)), JSON.stringify(seen));
  p.c.close();

  const end = Date.now() + 60000;
  let recorded = '';
  while (Date.now() < end) {
    recorded = fs.existsSync(record) ? fs.readFileSync(record, 'utf8').slice(before) : '';
    if (marker.test(recorded)) break;
    await sleep(200);
  }
  check('Setup ran', /vellumRunning=/.test(recorded), recorded.trim());
  check('…with no window of its own (/VERYSILENT)', /\/VERYSILENT\b/i.test(recorded) && !/\/SILENT\b/i.test(recorded), recorded.trim());
  check('…after Vellum had closed', /vellumRunning=0/.test(recorded), recorded.trim());
  return recorded;
}

async function reconnect(t) {
  let c;
  try {
    c = await connect({ timeoutMs: 90000 });
  } catch (err) {
    t.check('Vellum starts again by itself', false, String(err));
    return null;
  }
  const p = page(c);
  t.check('Vellum starts again by itself', await p.waitFor('Boolean(window.__vellum && __vellum.app && __vellum.ui)', 30000));
  return p;
}

export async function run(t) {
  const { check, V, settled, area, shot } = t;
  const DOC = t.file('update-doc');
  let p = page(t.c);
  const checkNow = () => p.q(`__vellum.ui.updates.checkNow(); true`);
  const dialogFor = (version) => p.waitFor(`${p.top}?.classList.contains('update-dialog') && /${esc(version)}/.test(${p.top}.textContent)`, 10000);

  await p.waitFor(settled(DOC), 25000);
  check('the old version is running from the temp install', installedPids().length > 0
    && await p.q(`(async () => (await (await import('./js/bridge.js')).bridge.request('update.settings')).current)()`) !== VERSION);

  area('version');
  mode = 'old';
  await checkNow();
  check('an older release says Vellum is up to date',
    await p.waitFor(`[...document.querySelectorAll('#toasts .toast')].some((x) => /up to date/.test(x.textContent))`, 10000));

  area('checksum');
  mode = 'badsum';
  await checkNow();
  check('a newer release opens the update dialog', await dialogFor(VERSION));
  check('…offering “Update now”', await p.clickButton('Update now'));
  check('a download that doesn’t match its checksum is refused inside Vellum',
    await p.waitFor(`/didn’t match its published checksum/.test(document.querySelector('.update-dialog .update-status')?.textContent)`, 20000));
  check('…nothing was run', !fs.existsSync(record));
  check('…and Vellum is still open with the document', await p.q(`Boolean(${V(DOC)})`));
  await p.clickButton('Close');
  await sleep(400);

  area('failed install');
  mode = 'fail';
  await checkNow();
  await dialogFor(VERSION);
  await installFromDialog(t, p, /vellumRunning=\d[\s\S]*$/);
  p = await reconnect(t);
  if (!p) return;
  check('…and reopens the document', await p.waitFor(settled(DOC), 25000));
  check('…and says the update didn’t install, keeping the version it has',
    await p.waitFor(`[...document.querySelectorAll('.dialog')].some((d) => /didn’t install/.test(d.textContent) && /${esc(VERSION)} couldn’t be installed/.test(d.textContent))`, 10000));
  await p.c.shot(path.join(t.dir, 'shots', 'update-failed.png')).catch(() => {});
  await p.clickButton('Close');
  await sleep(400);

  area('successful install');
  const newDll = sha256(fs.readFileSync(path.join(runDir, 'new-build', 'Vellum.dll')));
  const oldDll = sha256(fs.readFileSync(path.join(installed, 'Vellum.dll')));
  check('before: the installed files are the old version', oldDll !== newDll);
  const oldPids = installedPids();
  mode = 'good';
  await p.q(`__vellum.errors.length = 0; true`);
  await checkNow();
  check('the update is offered', await dialogFor(VERSION));
  const stopWatching = await watchSetupWindows();
  const recorded = await installFromDialog(t, p, /installed=1/);
  check('Setup finished installing', /installed=1/.test(recorded), recorded.trim());
  p = await reconnect(t);
  const windows = await stopWatching();
  if (!p) return;
  const pids = installedPids();
  check('the old Vellum process exited', oldPids.length > 0 && oldPids.every((id) => !pids.includes(id)), `before ${oldPids} after ${pids}`);
  check('the installed files were replaced by the new version', sha256(fs.readFileSync(path.join(installed, 'Vellum.dll'))) === newDll);
  const log = fs.readFileSync(path.join(t.dir, 'data', 'updates', 'install.log'), 'utf8');
  check('Setup’s log says the installation succeeded', /Installation process succeeded/.test(log));
  check('the new version is the one running',
    await p.q(`(async () => (await (await import('./js/bridge.js')).bridge.request('update.settings')).current)()`) === VERSION);
  check('…and says it was updated',
    await p.waitFor(`[...document.querySelectorAll('#toasts .toast')].some((x) => /updated to ${esc(VERSION)}/.test(x.textContent))`, 10000));
  check('the document is reopened', await p.waitFor(settled(DOC), 25000));
  await p.c.shot(path.join(t.dir, 'shots', 'updated.png')).catch(() => {});
  check('no dialog or prompt is open after the restart', await p.q(`document.querySelectorAll('.dialog').length === 0`));
  const errors = await p.q(`__vellum.errors.slice()`);
  check('no errors in the new version', errors.length === 0, JSON.stringify(errors));
  check('Setup was running while being watched', windows.seen > 0, `samples ${windows.seen}`);
  // Inno Setup keeps a zero-size helper window ("TWindowDisabler") while it works: nothing on screen.
  check('no Setup window was ever visible on screen', windows.visible.length === 0,
    [...windows.visible, ...windows.zeroSize.map((w) => `not on screen: ${w}`)].join('; '));
  p.c.close();
}

/** Stops the feed and any Vellum started from this run's temp folder (Setup starts them, not the harness). */
export async function cleanup() {
  server?.close();
  if (!runDir) return;
  const ps = `Get-CimInstance Win32_Process -Filter "Name='Vellum.exe'" | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith('${runDir.replace(/'/g, "''")}', [StringComparison]::OrdinalIgnoreCase) } | ForEach-Object { taskkill /PID $_.ProcessId /T /F | Out-Null }`;
  spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], { stdio: 'ignore', timeout: 60000, killSignal: 'SIGKILL' });
}
