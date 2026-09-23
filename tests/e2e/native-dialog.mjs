// Driving a real Windows file dialog from an end-to-end suite, without ever getting stuck in one.
//
// A native dialog is the one part of these tests that isn't inside the page, so nothing in the
// harness can see it and nothing can cancel it from the inside. The rules here are therefore hard:
//
//   · every try is bounded twice — the script has its own deadline, and the process is killed if it
//     outlives it, so a suite can never block on the dialog;
//   · one retry at most, and only while the dialog is still there to be retried;
//   · a failure is a failure: it is reported with what the desktop looked like, the dialogs this test
//     opened are closed again so the app isn't left modal, and the suite stops rather than going on;
//   · the dialogs are found by the title the test asked for, so a window of the person's own is never
//     touched.
//
// The work itself is in native-dialog.ps1 (UI Automation patterns, no keystrokes, no focus).

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'native-dialog.ps1');

/** What each exit code of the script means, in the words the report should carry. */
const REASONS = {
  2: 'the script was called wrongly',
  3: 'the dialog never appeared',
  4: 'the dialog has no File name box',
  5: 'the File name box wouldn’t take the path',
  6: 'the dialog has no Open/Save button',
  7: 'the dialog was still open after Open/Save',
};

/** Runs the script once. Never waits longer than `timeoutMs` plus the slack PowerShell needs to start. */
function runScript(args, timeoutMs) {
  const result = spawnSync('powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT, ...args],
    { encoding: 'utf8', timeout: timeoutMs + 15000, killSignal: 'SIGKILL' });
  const killed = Boolean(result.error) || result.signal !== null;
  return {
    ok: !killed && result.status === 0,
    status: result.status,
    reason: killed ? 'the dialog script had to be killed: it outlived its own timeout'
      : REASONS[result.status] ?? `the dialog script exited ${result.status}`,
    output: `${result.stdout ?? ''}${result.stderr ?? ''}${result.error ? result.error.message : ''}`.trim(),
  };
}

/**
 * Closes the dialogs named in `titles`, if any of them are open. Cleanup only — it says nothing about
 * whether they were there, and it touches no other window.
 */
export function closeFileDialogs(titles) {
  return runScript(['-Mode', 'dismiss', '-Title', titles.join('|')], 10000);
}

/**
 * Puts `text` into the File name box of the dialog called `title` and presses its Open/Save button,
 * with one retry at most. Records one check either way. Returns true if it took; on false the caller
 * must stop — the dialogs named in `titles` have been closed and the diagnostics are in the report.
 */
export async function fillFileDialog(t, { title, text, titles = [title], timeoutMs = 15000 }) {
  const dump = path.join(t.dir, 'native-dialogs.log');
  const tries = [];
  for (let attempt = 1; attempt <= 2; attempt++) {
    const result = runScript(['-Mode', 'fill', '-Title', title, '-Text', text, '-TimeoutMs', String(timeoutMs), '-Dump', dump], timeoutMs);
    tries.push(`try ${attempt}: ${result.reason} (${result.output})`);
    if (result.ok) {
      t.check(`the “${title}” dialog took the path`, true, attempt > 1 ? 'on the second try' : '');
      return true;
    }
    // Only a dialog that is still up can be tried again; anything else would be the same failure twice.
    if (attempt === 1 && result.status === 3) break;
  }

  // One failed interaction, then diagnostics: what the page is showing, what went wrong on the
  // desktop, and no further attempt.
  const page = await t.q(`JSON.stringify({
    dialogs: [...document.querySelectorAll('.dialog-title')].map((el) => el.textContent),
    toasts: [...document.querySelectorAll('.toast')].map((el) => el.textContent),
    errors: __vellum.errors,
  })`).catch((err) => `the page could not be asked: ${err.message}`);
  const desktop = fs.existsSync(dump) ? fs.readFileSync(dump, 'utf8').trim().split('\n').slice(-40).join('\n') : 'nothing was dumped';
  t.check(`the “${title}” dialog took the path`, false, tries.join(' | '));
  console.log(`--- the app, page side: ${page}\n--- the desktop, at the failure:\n${desktop}`);
  closeFileDialogs(titles);
  return false;
}
