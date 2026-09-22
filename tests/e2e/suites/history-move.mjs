// Document history follows Save As in the real app: snapshots are taken; File → Save As writes the document to a
// new path through the real Save dialog (typed into, as a person would); the document is closed and reopened from
// there, and its history shows the same snapshots (ids, names, times, sizes and files); Settings lists it under the
// new path only, never the old one as missing; Compare and Restore work from the new location.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

export const files = { 'move-doc': 'compare-a', 'move-later': 'compare-b' };

export async function run(t) {
  const { q, check, sleep, shot, V, settled, waitFor, area } = t;
  const DOC = t.file('move-doc');
  const LATER = t.file('move-later');
  const NEW = path.join(t.dir, 'moved', 'move-doc renamed.pdf');
  fs.mkdirSync(path.dirname(NEW), { recursive: true });
  const H = '__vellum.actions.history';
  const hash = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  const top = `[...document.querySelectorAll('.dialog')].at(-1)`;
  const button = (label) => `[...${top}.querySelectorAll('.dialog-actions button')].find((b) => b.textContent === ${JSON.stringify(label)})`;
  const rowAct = (index, act) => `document.querySelectorAll('.history-dialog .hist-item')[${index}].querySelector('[data-act="${act}"]')`;
  const list = (file) => q(`${H}.list(${V(file)}).then((l) => l.map((s) => ({ id: s.id, name: s.name, createdAt: s.createdAt, size: s.size })))`);
  const snapshotHashes = async (file, snaps) => {
    const out = [];
    for (const s of snaps) {
      const p = await q(`(async () => (await (await import('./js/bridge.js')).bridge.request('history.open', { path: ${JSON.stringify(file)}, id: ${JSON.stringify(s.id)} })).file.path)()`);
      out.push(hash(p));
    }
    return out;
  };
  const stored = () => q(`(async () => (await (await import('./js/bridge.js')).bridge.request('history.stored')).documents.map((d) => ({ path: d.path, missing: d.missing, count: d.count })))()`);

  await waitFor(settled(DOC), 25000);
  await waitFor(settled(LATER), 25000);

  area('snapshots');
  await q(`${H}.create(${V(DOC)}, 'First').then(Boolean)`);
  fs.copyFileSync(LATER, DOC); // the document changes on disk, as a later save would leave it
  await q(`${H}.create(${V(DOC)}, 'Second').then(Boolean)`);
  const before = await list(DOC);
  const beforeHashes = await snapshotHashes(DOC, before);
  check('two snapshots are taken', before.length === 2, JSON.stringify(before));

  area('save as');
  await q(`__vellum.app.activate(${V(DOC)}); __vellum.actions.saveAs(); true`);
  await sleep(1200);
  // The real Save dialog, filled in through UI Automation: the new path typed into its File name box, then Enter.
  const script = path.join(t.dir, 'save-dialog.ps1');
  fs.writeFileSync(script, `param([string]$Target)
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
$A = [System.Windows.Automation.AutomationElement]; $T = [System.Windows.Automation.TreeScope]; $C = [System.Windows.Automation.ControlType]
function Cond($prop, $value) { New-Object System.Windows.Automation.PropertyCondition($prop, $value) }
function Both($a, $b) { New-Object System.Windows.Automation.AndCondition($a, $b) }
$dialog = $null
for ($i = 0; $i -lt 50 -and -not $dialog; $i++) {
  $dialog = $A::RootElement.FindFirst($T::Descendants, (Both (Cond $A::NameProperty 'Save PDF as') (Cond $A::ControlTypeProperty $C::Window)))
  if (-not $dialog) { Start-Sleep -Milliseconds 200 }
}
if (-not $dialog) { Write-Output 'no Save dialog'; exit 3 }
$box = $dialog.FindFirst($T::Descendants, (Cond $A::AutomationIdProperty 'FileNameControlHost'))
if (-not $box) { Write-Output 'no File name box'; exit 4 }
Add-Type -AssemblyName System.Windows.Forms
$box.SetFocus()
Start-Sleep -Milliseconds 200
[System.Windows.Forms.SendKeys]::SendWait('^a')
[System.Windows.Forms.SendKeys]::SendWait(($Target -replace '[+^%~(){}\\[\\]]', '{$0}'))
Start-Sleep -Milliseconds 300
[System.Windows.Forms.SendKeys]::SendWait('{ENTER}')
`);
  const typed = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, NEW], { encoding: 'utf8' });
  check('the Save dialog took the new path', typed.status === 0, `${typed.status} ${typed.stdout} ${typed.stderr}`);
  check('the document now lives at the new path', await waitFor(`(() => { const v = ${V(NEW)}; return Boolean(v) && v.status === 'ready' && !v.rebuilding; })()`, 20000));
  check('the new file was written, the old one left where it was', fs.existsSync(NEW) && fs.existsSync(DOC));

  area('reopen');
  await q(`__vellum.app.close(${V(NEW)})`);
  await sleep(500);
  await q(`(async () => { const { bridge } = await import('./js/bridge.js'); const { file } = await bridge.request('openPath', { path: ${JSON.stringify(NEW)} }); await __vellum.app.open(file); return true; })()`);
  check('reopened from the new path', await waitFor(settled(NEW), 25000));
  const after = await list(NEW);
  check('its history shows the same snapshots: ids, names, times and sizes', JSON.stringify(after) === JSON.stringify(before), JSON.stringify(after));
  check('… with the same snapshot files', JSON.stringify(await snapshotHashes(NEW, after)) === JSON.stringify(beforeHashes));
  check('the old path has no history left', (await q(`(async () => (await (await import('./js/bridge.js')).bridge.request('history.list', { path: ${JSON.stringify(DOC)} })).snapshots.length)()`)) === 0);
  await q(`__vellum.app.activate(${V(NEW)}); ${V(NEW)}.focus(); ${H}.show(${V(NEW)}); true`);
  check('the history dialog lists both', await waitFor(`document.querySelectorAll('.history-dialog .hist-item').length === 2`, 5000));
  await shot('history-after-save-as');

  area('settings');
  fs.rmSync(DOC); // even with the old file gone, it isn't listed as a missing history
  const docs = await stored();
  check('Settings lists the history once, under the new path, not missing',
    docs.length === 1 && docs[0].path.toLowerCase() === NEW.toLowerCase() && !docs[0].missing && docs[0].count === 2, JSON.stringify(docs));

  area('compare and restore');
  await q(`${rowAct(1, 'compare')}.click()`);
  check('Compare works from the new location', await waitFor(`__vellum.actions.compare.view?.status === 'ready'`, 20000));
  await t.c.key('Escape');
  await sleep(400);
  await q(`__vellum.app.activate(${V(NEW)}); ${H}.show(${V(NEW)}); true`);
  await waitFor(`document.querySelectorAll('.history-dialog .hist-item').length === 2`, 5000);
  await q(`${rowAct(1, 'restore')}.click()`);
  await waitFor(`${top}.querySelector('.dialog-title')?.textContent.startsWith('Restore “First”')`, 3000);
  await q(`${button('Restore')}.click()`);
  check('Restore works from the new location', await waitFor(`(() => { const v = ${V(NEW)}; return v && v.status === 'ready' && !v.rebuilding && !document.querySelector('.dialog'); })()`, 20000));
  await sleep(600);
  check('… the new file holds the snapshot’s content', hash(NEW) === beforeHashes[1]);
}
