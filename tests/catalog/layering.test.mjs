// Which way the Tools foundation's modules may depend on each other, read from their import lines:
//   commands.js and requirements.js  no UI module, no bridge (they load anywhere, Node included)
//   catalog/*                        nothing from the app at all: data and pure functions
//   the palette                      loads the catalog only when it first opens, never at startup
//   operations/ and batch/engine.js  no UI module, no bridge, no catalog, no commands: automation runs
//                                    operations, never tools or commands (docs/TOOLS_UX_SPEC.md §29 Q13)
// Run: node --test "tests/catalog/*.test.mjs"

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { WEB } from '../editing/harness.mjs';

const JS = path.join(WEB, 'js');
const rel = (file) => path.relative(JS, file).replace(/\\/g, '/');

/** A module's imports, resolved: { static: [...], dynamic: [...] } (paths relative to web/js). */
function importsOf(file) {
  const source = fs.readFileSync(file, 'utf8');
  const resolve = (spec) => rel(path.resolve(path.dirname(file), spec));
  const local = (spec) => spec.startsWith('.');
  const statics = [...source.matchAll(/^\s*(?:import|export)\s+(?:[^'";]*?\sfrom\s+)?['"]([^'"]+)['"]/gm)].map((m) => m[1]);
  const dynamics = [...source.matchAll(/\bimport\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]);
  return { static: statics.filter(local).map(resolve), dynamic: dynamics.filter(local).map(resolve) };
}

/** Everything `start` loads when it is imported (static imports, followed). */
function loadedBy(start) {
  const seen = new Set();
  const visit = (name) => {
    if (seen.has(name)) return;
    seen.add(name);
    for (const next of importsOf(path.join(JS, name)).static) visit(next);
  };
  visit(start);
  seen.delete(start);
  return [...seen];
}

const uiOrBridge = (name) => name.startsWith('ui/') || name === 'bridge.js';
const catalogModules = fs.readdirSync(path.join(JS, 'catalog')).filter((f) => f.endsWith('.js')).map((f) => `catalog/${f}`);

test('commands.js and requirements.js load no UI module and no bridge, however indirectly', () => {
  for (const start of ['commands.js', 'requirements.js']) {
    assert.deepEqual(loadedBy(start).filter(uiOrBridge), [], start);
  }
});

test('catalog modules import nothing outside catalog/, and touch no DOM, bridge or storage', () => {
  assert.ok(catalogModules.includes('catalog/catalog.js') && catalogModules.includes('catalog/search.js'));
  for (const name of catalogModules) {
    const { static: statics, dynamic } = importsOf(path.join(JS, name));
    assert.deepEqual([...statics, ...dynamic].filter((n) => !n.startsWith('catalog/')), [], name);
    // The code alone: comments and quoted text left out.
    const code = fs.readFileSync(path.join(JS, name), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '').replace(/'(?:[^'\\\n]|\\.)*'/g, "''");
    assert.doesNotMatch(code, /\b(document|window|localStorage|navigator|bridge)\b\s*[.[(]/, name);
  }
});

test('the palette loads search and the catalog on first open only, and startup never imports them', () => {
  const palette = importsOf(path.join(JS, 'ui', 'palette.js'));
  assert.deepEqual(palette.static.filter((n) => n.startsWith('catalog/')), []);
  assert.deepEqual(palette.dynamic.sort(), ['catalog/catalog.js', 'catalog/search.js']);
  assert.deepEqual(loadedBy('app.js').filter((n) => n.startsWith('catalog/')), []);
});

test('nothing imports the palette from the catalog side, and the catalog never imports commands', () => {
  for (const name of catalogModules) {
    assert.ok(!loadedBy(name).some((n) => n === 'ui/palette.js' || n === 'commands.js' || n === 'requirements.js'), name);
  }
});

test('operations and the batch engine load no UI, bridge, catalog or command registry, however indirectly', () => {
  for (const start of ['operations/registry.js', 'batch/engine.js']) {
    const loaded = loadedBy(start);
    assert.deepEqual(loaded.filter((n) => uiOrBridge(n) || n.startsWith('catalog/') || n === 'commands.js' || n === 'requirements.js'), [], start);
  }
});
