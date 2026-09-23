// The command registry as Tools builds on it: it loads in Node with no app, UI or bridge; what its
// commands need is named from one vocabulary; and the commands added for Tools run what they say.
// Run: node --test "tests/catalog/*.test.mjs"

import test from 'node:test';
import assert from 'node:assert/strict';
import { webModule } from '../editing/harness.mjs';

const { createCommands } = await webModule('commands.js');
const { REQUIREMENTS, requirementsOf } = await webModule('requirements.js');
const { EXPORT_FORMATS } = await webModule('export/model.js');
const { icon } = await webModule('icons.js');

const commands = createCommands({}, {}, {});

test('the registry is built from nothing: no app, no UI, no bridge', () => {
  assert.ok(Object.keys(commands).length > 100);
  for (const [id, c] of Object.entries(commands)) assert.equal(typeof c.run, 'function', id);
});

test('every requirement a command names is in the vocabulary, and doc stays the document gate', () => {
  for (const [id, c] of Object.entries(commands)) {
    for (const name of c.requires ?? []) assert.ok(REQUIREMENTS[name], `${id} requires unknown “${name}”`);
    assert.ok(!(c.requires ?? []).includes('document'), `${id}: use doc: true for the document`);
    if (c.requires?.length) assert.equal(c.doc, true, `${id} has requirements, all of which need a document`);
    assert.equal(requirementsOf(c)[0] === 'document', Boolean(c.doc), id);
  }
});

test('every command has an icon that exists', () => {
  for (const [id, c] of Object.entries(commands)) assert.doesNotThrow(() => icon(c.icon), id);
});

test('each export command opens Export on its own format; Export… on the first', () => {
  const calls = [];
  const view = { status: 'ready' };
  const cmds = createCommands({ active: view }, {}, { export: { run: (...args) => calls.push(args) } });
  const formats = { 'export.word': 'word', 'export.excel': 'excel', 'export.powerpoint': 'powerpoint', 'export.images': 'jpg', 'export.markdown': 'markdown' };
  for (const [id, format] of Object.entries(formats)) {
    assert.ok(EXPORT_FORMATS[format], `${format} is an export format`);
    assert.equal(cmds[id].doc, true, id);
    assert.match(cmds[id].label, /^Export .+…$/, id);
    calls.length = 0;
    cmds[id].run();
    assert.deepEqual(calls, [[view, { format }]], id);
  }
  calls.length = 0;
  cmds['file.export'].run();
  assert.deepEqual(calls, [[view]]);
});

test('an export command with no document ready asks Export about no document (it refuses)', () => {
  const calls = [];
  const cmds = createCommands({ active: { status: 'loading' } }, {}, { export: { run: (...args) => calls.push(args) } });
  cmds['export.word'].run();
  assert.deepEqual(calls, [[null, { format: 'word' }]]);
});

test('Fill in form needs form fields, and only finds the field to fill', () => {
  assert.deepEqual(requirementsOf(commands['forms.fill']), ['document', 'formFields']);
  let found = 0;
  createCommands({ active: { status: 'ready', focusFormField: () => { found++; } } }, {}, {})['forms.fill'].run();
  assert.equal(found, 1);
  assert.doesNotThrow(() => createCommands({ active: null }, {}, {})['forms.fill'].run());
});

test('Attachments… opens through actions.attachments, like every other feature', () => {
  const shown = [];
  const view = { status: 'ready' };
  createCommands({ active: view }, {}, { attachments: { show: (v) => shown.push(v) } })['tools.attachments'].run();
  assert.deepEqual(shown, [view]);
});
