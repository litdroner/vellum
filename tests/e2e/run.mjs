// Vellum end-to-end tests: the real app (Debug build), driven over DevTools, on generated copies.
//
//   node tests/e2e/run.mjs [--no-build] [suite ...]
//
// Suites (tests/e2e/suites): text-editor, regression, editing-store, phase0, selection, manipulation,
// multi-select, page-changes, copy-paste, page-text-font, form-text, forms, forms-import, signature, redaction, page-stamps, find-replace, compare, history, history-storage, collections, collection-research, structure, semantic-search, research, document-graph, saved-research, edit-flicker, spread, new-text-ux, health, accessibility, export, compress by default;
// ocr, performance, updates and history-move (it fills in the real Save dialog) only when named (VELLUM_PERF_PDF=<file> measures a real document — copied, never changed;
// updates needs Inno Setup 6). A suite may export prepare({ dir }) returning { env, exe } (extra environment, another build to start), and cleanup().
//
// Safety: stops if Vellum is already running (it's single-instance, so a test would talk to that
// copy). The app runs with a throwaway data folder (VELLUM_DATA_DIR, honoured by Debug builds only),
// so a person's settings, recent files and WebView2 profile are never touched, and with automatic
// update checks off. Everything is written to a temp folder, printed at the start.
// Before a suite runs, its window is moved wholly onto one monitor (see window.mjs).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { makeFixtures } from '../editing/fixtures.mjs';
import { connect, sleep } from '../../tools/cdp-client.mjs';
import { createContext } from './lib.mjs';
import { placeOnOneMonitor } from './window.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const EXE = path.join(ROOT, 'src', 'Vellum', 'bin', 'Debug', 'net10.0-windows', 'Vellum.exe');
const DEFAULT_SUITES = ['text-editor', 'regression', 'editing-store', 'phase0', 'selection', 'manipulation', 'multi-select', 'page-changes', 'copy-paste', 'page-text-font', 'form-text', 'forms', 'forms-import', 'signature', 'redaction', 'page-stamps', 'find-replace', 'compare', 'history', 'history-storage', 'collections', 'collection-research', 'structure', 'semantic-search', 'research', 'document-graph', 'saved-research', 'edit-flicker', 'spread', 'new-text-ux', 'health', 'accessibility', 'export', 'compress'];

const args = process.argv.slice(2);
const named = args.filter((a) => !a.startsWith('--'));
const suites = named.length ? named : DEFAULT_SUITES;

const running = spawnSync('tasklist', ['/FI', 'IMAGENAME eq Vellum.exe', '/NH'], { encoding: 'utf8' }).stdout ?? '';
if (/Vellum\.exe/i.test(running)) {
  console.error('Vellum is running. Close it first: the tests start their own copy, and Vellum allows only one.');
  process.exit(2);
}

if (!args.includes('--no-build')) {
  const local = path.join(process.env.LOCALAPPDATA ?? '', 'Microsoft', 'dotnet');
  const hasLocal = fs.existsSync(path.join(local, 'dotnet.exe'));
  const result = spawnSync(hasLocal ? path.join(local, 'dotnet.exe') : 'dotnet',
    ['build', path.join(ROOT, 'src', 'Vellum', 'Vellum.csproj'), '-c', 'Debug', '--nologo', '-v', 'q'],
    { stdio: 'inherit', env: hasLocal ? { ...process.env, DOTNET_ROOT: local } : process.env });
  if (result.status !== 0) {
    console.error('The Debug build failed.');
    process.exit(1);
  }
}

const runDir = path.join(os.tmpdir(), 'vellum-e2e', new Date().toISOString().replace(/[:.]/g, '-'));
console.log(`Output: ${runDir}`);
const fixtures = await makeFixtures(path.join(runDir, 'fixtures'));
const report = [];

for (const name of suites) {
  const suite = await import(pathToFileURL(path.join(ROOT, 'tests', 'e2e', 'suites', `${name}.mjs`)).href);
  const dir = path.join(runDir, name);
  const dataDir = path.join(dir, 'data');
  fs.mkdirSync(path.join(dir, 'shots'), { recursive: true });
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'settings.json'), JSON.stringify({ autoUpdate: false }));
  const files = {};
  for (const [copy, fixture] of Object.entries(suite.files)) {
    const external = suite.external?.[copy] ? process.env[suite.external[copy]] : null;
    const to = path.join(dir, `${copy}.pdf`);
    fs.copyFileSync(external || fixtures[fixture], to);
    files[copy] = to;
  }
  console.log(`\n=== ${name}${Object.values(suite.external ?? {}).some((v) => process.env[v]) ? ' (with a document from the environment)' : ''}`);
  const results = [];
  let extraEnv = {};
  let exe = EXE;
  try {
    const prepared = (await suite.prepare?.({ dir })) ?? {};
    extraEnv = prepared.env ?? {};
    exe = prepared.exe ?? EXE;
  } catch (err) {
    results.push({ area: null, ok: false, label: 'the suite was prepared', detail: String(err?.message ?? err).slice(0, 800) });
    console.log(`FAIL  the suite couldn’t be prepared: ${err?.message ?? err}`);
    report.push({ suite: name, passed: 0, failed: 1, results });
    continue;
  }
  const app = spawn(exe, Object.values(files), {
    stdio: 'ignore',
    env: { ...process.env, ...extraEnv, VELLUM_DATA_DIR: dataDir, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=9222' },
  });
  const exited = new Promise((resolve) => app.once('exit', resolve));
  try {
    const c = await connect({ timeoutMs: 60000 });
    const t = createContext({ c, dir, files, results });
    if (!(await t.waitFor('Boolean(window.__vellum && __vellum.app && __vellum.ui)', 30000))) throw new Error('the app didn’t start');
    console.log(`Window: ${placeOnOneMonitor(app.pid, dir)}`);
    await viewportSettled(c);
    await suite.run(t);
    c.close();
  } catch (err) {
    results.push({ area: null, ok: false, label: 'the suite ran to the end', detail: String(err?.stack ?? err).slice(0, 800) });
    console.log(`FAIL  the suite stopped: ${err?.stack ?? err}`);
  } finally {
    // Only this test's own copy of the app (and its WebView2 processes) is stopped.
    spawnSync('taskkill', ['/PID', String(app.pid), '/T', '/F'], { stdio: 'ignore' });
    await Promise.race([exited, sleep(10000)]);
    await suite.cleanup?.();
    await sleep(1500);
  }
  const failed = results.filter((r) => !r.ok).length;
  report.push({ suite: name, passed: results.length - failed, failed, results });
  console.log(`--- ${name}: ${failed ? 'FAIL' : 'PASS'} (${results.length - failed}/${results.length})`);
}

/** Waits until the page's size and pixel ratio stop changing after the window was moved (up to 5 s). */
async function viewportSettled(c) {
  let last = '';
  let same = 0;
  for (const end = Date.now() + 5000; Date.now() < end && same < 3;) {
    const now = await c.evaluate('`${innerWidth}x${innerHeight}@${devicePixelRatio}`').catch(() => '');
    same = now && now === last ? same + 1 : 0;
    last = now;
    await sleep(150);
  }
}

fs.writeFileSync(path.join(runDir, 'report.json'), JSON.stringify(report, null, 2));
const total = report.reduce((n, r) => n + r.passed + r.failed, 0);
const failed = report.reduce((n, r) => n + r.failed, 0);
console.log(`\n${failed ? 'FAILED' : 'PASSED'}: ${total - failed}/${total} checks in ${report.length} suite(s). Report: ${path.join(runDir, 'report.json')}`);
process.exit(failed ? 1 : 0);
