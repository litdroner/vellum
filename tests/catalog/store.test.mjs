// Recent and favourite tools (catalog/store.js): what is kept under `vellum.catalog`, in what order and
// how many, that nothing from a document is ever kept, and that storage which fails or holds something
// unreadable counts as empty without ever throwing. The Home row's choice of tools is tested here too.
// Run: node --test "tests/catalog/*.test.mjs"

import test from 'node:test';
import assert from 'node:assert/strict';
import { webModule } from '../editing/harness.mjs';

const { createToolPrefs, STORE_KEY, RECENT_LIMIT, FAVORITES_LIMIT, HOME_LIMIT } = await webModule('catalog/store.js');
const { TOOLS, HOME_TOOLS } = await webModule('catalog/catalog.js');
const { createCommands } = await webModule('commands.js');
const { requirementsOf } = await webModule('requirements.js');

const commands = createCommands({}, {}, {});
const IDS = TOOLS.map((t) => t.id);
const TOOL = new Map(TOOLS.map((t) => [t.id, t]));

/** localStorage's shape over a Map; `fail` makes reads or writes throw. */
function memoryStorage(entries = {}, fail = {}) {
  const map = new Map(Object.entries(entries));
  return {
    map,
    getItem(key) { if (fail.read) throw new Error('read'); return map.has(key) ? map.get(key) : null; },
    setItem(key, value) { if (fail.write) throw new Error('write'); map.set(key, String(value)); },
  };
}
const stored = (storage) => JSON.parse(storage.map.get(STORE_KEY));
const noDocument = (t) => requirementsOf(commands[t.command]).length === 0;

test('starts empty, under vellum.catalog', () => {
  const storage = memoryStorage();
  const prefs = createToolPrefs(storage);
  assert.equal(STORE_KEY, 'vellum.catalog');
  assert.deepEqual(prefs.recent(), []);
  assert.deepEqual(prefs.favorites(), []);
  assert.equal(storage.map.size, 0, 'reading writes nothing');
});

test('a run is kept and read back, in the v1 shape: ids and times only', () => {
  const storage = memoryStorage();
  createToolPrefs(storage).recordRun('merge-pdfs', 1000);
  createToolPrefs(storage).toggleFavorite('compress-pdf');
  assert.deepEqual(stored(storage), { v: 1, recent: [{ id: 'merge-pdfs', t: 1000 }], favorites: ['compress-pdf'] });
  const again = createToolPrefs(storage);
  assert.deepEqual(again.recent(), ['merge-pdfs']);
  assert.deepEqual(again.favorites(), ['compress-pdf']);
});

test('Recent: newest first, each tool once, at most 8', () => {
  const prefs = createToolPrefs(memoryStorage());
  prefs.recordRun('merge-pdfs', 1);
  prefs.recordRun('compress-pdf', 2);
  assert.deepEqual(prefs.recent(), ['compress-pdf', 'merge-pdfs']);
  prefs.recordRun('merge-pdfs', 3);
  assert.deepEqual(prefs.recent(), ['merge-pdfs', 'compress-pdf']);
  IDS.slice(0, RECENT_LIMIT + 3).forEach((id, i) => prefs.recordRun(id, 10 + i));
  assert.equal(RECENT_LIMIT, 8);
  assert.deepEqual(prefs.recent(), IDS.slice(3, RECENT_LIMIT + 3).reverse());
});

test('a command run records the tool it belongs to, and nothing for other commands', () => {
  const storage = memoryStorage();
  const prefs = createToolPrefs(storage);
  prefs.recordCommand('pages.merge', 1);
  prefs.recordCommand('app.palette', 2);
  prefs.recordCommand('no.such.command', 3);
  assert.deepEqual(prefs.recent(), ['merge-pdfs']);
  // A variant's command records its tool.
  const withVariant = TOOLS.find((t) => t.variants?.some((v) => v.command !== t.command));
  if (withVariant) {
    prefs.recordCommand(withVariant.variants.find((v) => v.command !== withVariant.command).command, 4);
    assert.equal(prefs.recent()[0], withVariant.id);
  }
});

test('Favorites: star and unstar, in the order starred, at most 12', () => {
  const prefs = createToolPrefs(memoryStorage());
  assert.equal(prefs.toggleFavorite('compress-pdf'), true);
  assert.equal(prefs.toggleFavorite('merge-pdfs'), true);
  assert.deepEqual(prefs.favorites(), ['compress-pdf', 'merge-pdfs']);
  assert.equal(prefs.isFavorite('compress-pdf'), true);
  assert.equal(prefs.toggleFavorite('compress-pdf'), false);
  assert.deepEqual(prefs.favorites(), ['merge-pdfs']);
  assert.equal(prefs.toggleFavorite('no-such-tool'), false);
  const others = IDS.filter((id) => id !== 'merge-pdfs');
  for (const id of others.slice(0, FAVORITES_LIMIT - 1)) assert.equal(prefs.toggleFavorite(id), true);
  assert.equal(FAVORITES_LIMIT, 12);
  assert.equal(prefs.toggleFavorite(others[FAVORITES_LIMIT]), null, 'the list is full');
  assert.equal(prefs.favorites().length, FAVORITES_LIMIT);
});

test('tools that no longer exist, repeats and too many entries are dropped when read', () => {
  const recent = [{ id: 'gone', t: 9 }, { id: 'merge-pdfs', t: 8 }, { id: 'merge-pdfs', t: 7 }, ...IDS.map((id, i) => ({ id, t: i }))];
  const storage = memoryStorage({ [STORE_KEY]: JSON.stringify({ v: 1, recent, favorites: ['gone', 'compress-pdf', 'compress-pdf', ...IDS] }) });
  const prefs = createToolPrefs(storage);
  assert.equal(prefs.recent()[0], 'merge-pdfs');
  assert.equal(prefs.recent().length, RECENT_LIMIT);
  assert.equal(new Set(prefs.recent()).size, RECENT_LIMIT);
  assert.equal(prefs.favorites()[0], 'compress-pdf');
  assert.equal(prefs.favorites().length, FAVORITES_LIMIT);
  assert.ok(!prefs.favorites().includes('gone') && !prefs.recent().includes('gone'));
  // The next write keeps only what was read.
  prefs.recordRun('compress-pdf', 100);
  const kept = stored(storage);
  assert.equal(kept.recent.length, RECENT_LIMIT);
  assert.ok(kept.recent.every((e) => IDS.includes(e.id)) && kept.favorites.every((id) => IDS.includes(id)));
});

test('unreadable or wrongly shaped data counts as empty', () => {
  for (const value of ['{not json', 'null', '42', '"text"', '[]', '{}', JSON.stringify({ v: 2, recent: [{ id: 'compress-pdf', t: 1 }] }),
    JSON.stringify({ v: 1 }), JSON.stringify({ v: 1, recent: 'compress-pdf', favorites: { a: 1 } }),
    JSON.stringify({ v: 1, recent: [null, 'compress-pdf', { id: 'compress-pdf' }, { id: 'compress-pdf', t: 'x' }], favorites: [null, 5] })]) {
    const prefs = createToolPrefs(memoryStorage({ [STORE_KEY]: value }));
    assert.deepEqual(prefs.recent(), [], value);
    assert.deepEqual(prefs.favorites(), [], value);
    prefs.recordRun('compress-pdf', 1); // and it can be written over
    assert.deepEqual(prefs.recent(), ['compress-pdf'], value);
  }
});

test('storage that fails never throws: reads are empty, writes are simply not kept', () => {
  const unreadable = createToolPrefs(memoryStorage({}, { read: true }));
  assert.deepEqual(unreadable.recent(), []);
  assert.deepEqual(unreadable.favorites(), []);
  assert.doesNotThrow(() => unreadable.recordRun('compress-pdf'));
  const unwritable = createToolPrefs(memoryStorage({}, { write: true }));
  assert.doesNotThrow(() => unwritable.recordRun('compress-pdf'));
  assert.doesNotThrow(() => unwritable.toggleFavorite('compress-pdf'));
  assert.deepEqual(unwritable.recent(), []);
  const none = createToolPrefs(null);
  assert.deepEqual(none.recent(), []);
  assert.doesNotThrow(() => none.recordCommand('pages.merge'));
  assert.deepEqual(none.homeTools(noDocument).map((t) => t.id), HOME_TOOLS);
});

test('only vellum.catalog is written: the annotation colours (vellum.tools) are left alone', () => {
  const colours = JSON.stringify({ highlight: '#ffd400' });
  const storage = memoryStorage({ 'vellum.tools': colours });
  const prefs = createToolPrefs(storage);
  prefs.recordRun('compress-pdf');
  prefs.toggleFavorite('merge-pdfs');
  prefs.clearRecent();
  assert.deepEqual([...storage.map.keys()].sort(), ['vellum.catalog', 'vellum.tools']);
  assert.equal(storage.map.get('vellum.tools'), colours);
});

test('nothing from a document is kept: only tool ids and times', () => {
  const storage = memoryStorage();
  const prefs = createToolPrefs(storage);
  prefs.recordRun('compress-pdf', 5);
  prefs.recordCommand('C:\\Users\\someone\\Lease agreement.pdf');
  prefs.toggleFavorite('C:\\Users\\someone\\Lease agreement.pdf');
  prefs.toggleFavorite('merge-pdfs');
  const data = stored(storage);
  assert.deepEqual(Object.keys(data).sort(), ['favorites', 'recent', 'v']);
  assert.ok(data.recent.every((e) => Object.keys(e).sort().join() === 'id,t' && IDS.includes(e.id)));
  assert.ok(data.favorites.every((id) => IDS.includes(id)));
  assert.doesNotMatch(storage.map.get(STORE_KEY), /Lease|Users|\.pdf/);
});

test('onChange is told of each write, and of nothing else', () => {
  let changes = 0;
  const prefs = createToolPrefs(memoryStorage(), { onChange: () => { changes++; } });
  prefs.recent();
  prefs.favorites();
  prefs.homeTools(noDocument);
  assert.equal(changes, 0);
  prefs.recordRun('compress-pdf');
  prefs.recordCommand('pages.merge');
  prefs.recordCommand('app.palette'); // not a tool: no write
  prefs.toggleFavorite('compress-pdf');
  assert.equal(changes, 3);
  const failing = createToolPrefs(memoryStorage(), { onChange: () => { throw new Error('listener'); } });
  assert.doesNotThrow(() => failing.recordRun('compress-pdf'));
});

test('the Home defaults are catalog tools that need no document', () => {
  assert.equal(HOME_TOOLS.length, HOME_LIMIT);
  for (const id of HOME_TOOLS) {
    assert.ok(TOOL.has(id), id);
    assert.ok(noDocument(TOOL.get(id)), id);
  }
});

test('the Home row: recently run no-document tools first, then the defaults, each once, at most 4', () => {
  const prefs = createToolPrefs(memoryStorage());
  assert.deepEqual(prefs.homeTools(noDocument).map((t) => t.id), HOME_TOOLS);
  prefs.recordRun('html-to-pdf', 1);
  prefs.recordRun('compress-pdf', 2); // needs a document: never on Home
  const row = prefs.homeTools(noDocument).map((t) => t.id);
  assert.deepEqual(row, ['html-to-pdf', 'merge-pdfs', 'images-to-pdf', 'compare-documents']);
  assert.equal(new Set(row).size, row.length);
  // Every no-document tool run: still 4, newest first.
  const free = TOOLS.filter(noDocument).map((t) => t.id);
  free.forEach((id, i) => prefs.recordRun(id, 10 + i));
  const full = prefs.homeTools(noDocument).map((t) => t.id);
  assert.equal(full.length, Math.min(HOME_LIMIT, free.length));
  assert.deepEqual(full, [...free].reverse().slice(0, HOME_LIMIT));
  // Tool records from the catalog itself, never copies.
  assert.ok(prefs.homeTools(noDocument).every((t) => t === TOOL.get(t.id)));
  // What `fits` leaves out stays out, whatever Recent holds.
  assert.deepEqual(prefs.homeTools((t) => t.id === 'merge-pdfs').map((t) => t.id), ['merge-pdfs']);
});
