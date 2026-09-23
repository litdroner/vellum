// The Tools catalog's integrity: every tool points at a real command, each command backs one tool at
// most, the categories hold together, and the aliases only ever describe what Vellum really does.
// Run: node --test "tests/catalog/*.test.mjs"

import test from 'node:test';
import assert from 'node:assert/strict';
import { webModule } from '../editing/harness.mjs';

const { CATEGORIES, TOOLS, SHARED_ALIASES, toolCommands, aliasesByCommand } = await webModule('catalog/catalog.js');
const { normalise, tokenise } = await webModule('catalog/search.js');
const { createCommands } = await webModule('commands.js');
const { REQUIREMENTS } = await webModule('requirements.js');
const { icon } = await webModule('icons.js');

const commands = createCommands({}, {}, {});
const words = (text) => tokenise(text).join(' ');

// Words for features Vellum doesn't have. An alias may use them only once the feature ships.
const FORBIDDEN = [
  'encrypt', 'decrypt', 'password', 'unlock', 'permission', 'bates', 'translate', 'translation', 'ai', 'chat',
  'summarize', 'summary', 'cloud', 'share', 'upload', 'certificate', 'digital signature', 'repair', 'batch',
  'workflow', 'template',
];
const RECORD_KEYS = ['id', 'name', 'blurb', 'category', 'section', 'command', 'variants', 'aliases', 'fits', 'scope', 'icon'];

test('52 tools, each a discovery record and nothing more', () => {
  assert.equal(TOOLS.length, 52);
  for (const t of TOOLS) {
    assert.deepEqual(Object.keys(t).sort(), [...RECORD_KEYS].sort(), `${t.id}: no requires, presentIf, preset or run on a tool`);
    assert.ok(Object.isFrozen(t), t.id);
  }
  assert.ok(Object.isFrozen(TOOLS));
});

test('ids are stable task slugs: unique, never namespaced by category, never a command id', () => {
  const ids = TOOLS.map((t) => t.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const t of TOOLS) {
    assert.match(t.id, /^[a-z0-9]+(-[a-z0-9]+)*$/, t.id);
    assert.ok(!commands[t.id], `${t.id} is a command id`);
    for (const c of CATEGORIES) assert.ok(!t.id.startsWith(`${c.id}.`) && !t.id.startsWith(`${c.id}/`), t.id);
  }
});

test('every tool runs a real command with a label, in the palette; variants too', () => {
  for (const t of TOOLS) {
    for (const id of toolCommands(t)) {
      const c = commands[id];
      assert.ok(c, `${t.id}: no command ${id}`);
      assert.ok(c.label, id);
      assert.notEqual(c.palette, false, id);
    }
    if (t.variants) {
      assert.ok(t.variants.length >= 2, t.id);
      assert.equal(t.variants[0].command, t.command, `${t.id}: the first variant is the tool's command`);
      for (const v of t.variants) assert.ok(v.label, t.id);
    }
  }
});

test('a command backs one tool at most', () => {
  const owner = new Map();
  for (const t of TOOLS) {
    for (const id of toolCommands(t)) {
      assert.ok(!owner.has(id), `${id} backs ${owner.get(id)} and ${t.id}`);
      owner.set(id, t.id);
    }
  }
});

test('the five PDF to … tools each have their own export command; Fill in form has forms.fill', () => {
  const byId = new Map(TOOLS.map((t) => [t.id, t]));
  const expected = {
    'pdf-to-word': 'export.word', 'pdf-to-excel': 'export.excel', 'pdf-to-powerpoint': 'export.powerpoint',
    'pdf-to-images': 'export.images', 'pdf-to-markdown': 'export.markdown', 'fill-form': 'forms.fill',
  };
  for (const [id, command] of Object.entries(expected)) assert.equal(byId.get(id)?.command, command, id);
  assert.ok(!TOOLS.some((t) => toolCommands(t).includes('file.export')), 'Export… itself stays off Tools');
});

test('categories: the eight, in order, then Automate reserved, hidden and empty', () => {
  assert.deepEqual(CATEGORIES.map((c) => c.name), ['Edit', 'Review', 'Organize', 'Convert', 'Fill & Sign', 'Protect', 'Optimize', 'Research', 'Automate']);
  const automate = CATEGORIES.find((c) => c.id === 'automate');
  assert.equal(automate.reserved, true);
  assert.equal(TOOLS.filter((t) => t.category === 'automate').length, 0, 'Automate appears with its first real tool');
  assert.deepEqual(CATEGORIES.filter((c) => c.reserved).map((c) => c.id), ['automate']);
  assert.equal(new Set(CATEGORIES.map((c) => c.id)).size, CATEGORIES.length);
  for (const c of CATEGORIES) {
    assert.doesNotThrow(() => icon(c.icon), c.id);
    assert.ok(c.blurb.length <= 80, c.id);
  }
});

test('every tool is in exactly one category and section that exist; 2 to 14 per category', () => {
  const byId = new Map(CATEGORIES.map((c) => [c.id, c]));
  for (const t of TOOLS) {
    const c = byId.get(t.category);
    assert.ok(c && !c.reserved, t.id);
    if (c.sections.length) assert.ok(c.sections.some((s) => s.id === t.section), `${t.id}: section ${t.section}`);
    else assert.equal(t.section, null, t.id);
  }
  for (const c of CATEGORIES.filter((x) => !x.reserved)) {
    const n = TOOLS.filter((t) => t.category === c.id).length;
    assert.ok(n >= 2 && n <= 14, `${c.name}: ${n}`);
    if (n > 8) assert.ok(c.sections.length >= 2, `${c.name} has more than 8 tools, so it needs sections`);
    for (const s of c.sections) assert.ok(TOOLS.some((t) => t.section === s.id && t.category === c.id), `${c.id}/${s.id} is empty`);
  }
  // Tools of a category are listed together, section by section.
  const order = TOOLS.map((t) => `${t.category}/${t.section}`);
  assert.equal(new Set(order).size, order.filter((k, i) => k !== order[i - 1]).length, 'a category or section is split');
});

test('names, blurbs, scopes, fits and icons', () => {
  const scopes = new Set(['files', 'document', 'pages', 'page', 'selection']);
  const fits = new Set([...Object.keys(REQUIREMENTS), 'pages.selected']);
  const names = new Set();
  for (const t of TOOLS) {
    assert.match(t.name, /^[A-Z]/, t.id);
    assert.doesNotMatch(t.name, /→|->|…|\.$/, t.id);
    assert.ok(!names.has(t.name), `two tools named ${t.name}`);
    names.add(t.name);
    assert.ok(t.blurb.length > 0 && t.blurb.length <= 80, `${t.id}: blurb of ${t.blurb.length}`);
    assert.ok(scopes.has(t.scope), `${t.id}: scope ${t.scope}`);
    assert.ok(t.fits === null || fits.has(t.fits), `${t.id}: fits ${t.fits}`);
    if (t.icon) assert.doesNotThrow(() => icon(t.icon), t.id);
  }
});

test('aliases: at least three, written plainly, each one tool’s own', () => {
  const owner = new Map();
  const shared = new Map(SHARED_ALIASES.map(([alias, ids]) => [words(alias), new Set(ids)]));
  for (const t of TOOLS) {
    assert.ok(t.aliases.length >= 3, `${t.id} has ${t.aliases.length} aliases`);
    for (const alias of t.aliases) {
      assert.equal(alias, alias.toLowerCase().trim(), `${t.id}: “${alias}”`);
      assert.doesNotMatch(alias, /\s{2}/, t.id);
      const key = words(alias);
      assert.ok(key, `${t.id}: “${alias}” has no words`);
      assert.notEqual(key, words(t.name), `${t.id}: “${alias}” only repeats the name`);
      if (owner.has(key) && owner.get(key) !== t.id) {
        assert.ok(shared.get(key)?.has(t.id) && shared.get(key)?.has(owner.get(key)), `“${alias}” is both ${owner.get(key)}’s and ${t.id}’s`);
      }
      owner.set(key, t.id);
    }
  }
  for (const [alias, ids] of SHARED_ALIASES) {
    for (const id of ids) assert.ok(TOOLS.find((t) => t.id === id)?.aliases.some((a) => words(a) === words(alias)), `${alias}: ${id}`);
  }
});

test('no alias, name or blurb suggests a feature Vellum doesn’t have', () => {
  const has = (text, phrase) => ` ${normalise(text)} `.includes(` ${normalise(phrase)} `);
  for (const t of TOOLS) {
    for (const text of [t.name, t.blurb, ...t.aliases]) {
      for (const phrase of FORBIDDEN) assert.ok(!has(text, phrase), `${t.id}: “${text}” mentions ${phrase}`);
    }
  }
});

test('no alias is another command’s label (typing a label always finds that command)', () => {
  const labels = new Map(Object.entries(commands).filter(([, c]) => c.label).map(([id, c]) => [words(c.label), id]));
  for (const t of TOOLS) {
    const own = new Set(toolCommands(t));
    for (const alias of t.aliases) {
      const id = labels.get(words(alias));
      assert.ok(!id || own.has(id), `${t.id}: “${alias}” is the label of ${id}`);
    }
  }
});

test('the palette gets each tool’s aliases on every command that runs it', () => {
  const map = aliasesByCommand();
  for (const t of TOOLS) for (const id of toolCommands(t)) assert.equal(map.get(id), t.aliases, id);
  assert.equal(map.size, TOOLS.reduce((n, t) => n + toolCommands(t).length, 0));
});
