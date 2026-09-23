// requirements.js: one answer to "can this command run now?" for every surface, with the reason in
// words. Fixture states stand for the app's (no document, opening, ready, protected, a snapshot, a form,
// Edit mode selections), built from the same getters DocumentView has.
// Run: node --test "tests/catalog/*.test.mjs"

import test from 'node:test';
import assert from 'node:assert/strict';
import { webModule } from '../editing/harness.mjs';

const { REQUIREMENTS, availability, snapshot } = await webModule('requirements.js');
const { NO_FORM_FIELDS } = await webModule('forms/fields.js');
const { createCommands } = await webModule('commands.js');
const { presenceFrom, describeOutcome } = await webModule('office/formats.js');

const commands = createCommands({}, {}, {});
const PROTECTED = 'This PDF is protected (encrypted). Vellum opens it with the right password but can’t rewrite it, so its text can’t be edited.';

/** A document view as requirements read it (document-view.js, editing/session.js, ui/text-editor.js). */
const view = (over = {}) => ({
  status: 'ready', encrypted: false, hasFormFields: false, file: { readOnly: false },
  get canEditPages() { return this.status === 'ready' && !this.encrypted; },
  get textEditing() {
    return { unavailableReason: this.status !== 'ready' ? 'The document isn’t ready yet.' : this.encrypted ? PROTECTED : null };
  },
  annotLayer: { tool: 'select' }, objectSelection: { size: 0 }, textEditor: { pictureSelected: false },
  getSelectedText: () => '',
  ...over,
});
// history/actions.js canUse, which lives beside UI code Node can't load.
const actions = { history: { canUse: (v) => Boolean(v && v.status === 'ready' && !v.file.readOnly) } };
const snap = (active) => snapshot({ active }, {}, actions);
const check = (id, active) => availability(commands[id], snap(active));

const STATES = {
  none: null,
  opening: view({ status: 'loading' }),
  ready: view(),
  protected: view({ encrypted: true }),
  snapshot: view({ file: { readOnly: true } }),
  form: view({ hasFormFields: true }),
};

test('with no document ready, document commands say so; the others run', () => {
  for (const state of [STATES.none, STATES.opening]) {
    assert.deepEqual(check('tools.compress', state), { present: true, available: false, reason: 'Open a PDF first.', unmet: 'document' });
    assert.equal(check('export.word', state).unmet, 'document');
    for (const id of ['pages.merge', 'pages.imagesToPdf', 'pages.htmlToPdf', 'tools.compare', 'file.open']) {
      assert.equal(check(id, state).available, true, id);
    }
  }
});

test('a ready document: writing, reading and exporting all run', () => {
  for (const id of ['tools.compress', 'pages.split', 'edit.text', 'find.replace', 'file.history', 'export.excel', 'tools.health', 'tools.attachments']) {
    assert.deepEqual(check(id, STATES.ready), { present: true, available: true, reason: null, unmet: null }, id);
  }
});

test('a protected PDF: what rewrites it says why; reading and exporting still run', () => {
  assert.deepEqual(check('tools.compress', STATES.protected),
    { present: true, available: false, reason: REQUIREMENTS.writable.reason, unmet: 'writable' });
  // Text editing gives its own reason, word for word.
  assert.equal(check('edit.text', STATES.protected).reason, PROTECTED);
  assert.equal(check('find.replace', STATES.protected).reason, PROTECTED);
  for (const id of ['export.word', 'tools.health', 'tools.research', 'tools.structure', 'file.history']) {
    assert.equal(check(id, STATES.protected).available, true, id);
  }
});

test('history needs a document opened from disk, not a snapshot', () => {
  assert.deepEqual(check('file.history', STATES.snapshot),
    { present: true, available: false, reason: REQUIREMENTS.history.reason, unmet: 'history' });
});

test('Fill in form needs a form; the reason is the command’s own', () => {
  assert.deepEqual(check('forms.fill', STATES.ready), { present: true, available: false, reason: NO_FORM_FIELDS, unmet: 'formFields' });
  assert.equal(check('forms.fill', STATES.form).available, true);
});

test('selections: objects and one picture count only in Edit mode', () => {
  const edit = (over) => view({ annotLayer: { tool: 'edit' }, ...over });
  assert.equal(check('edit.redactSelection', STATES.ready).reason, 'Select text or pictures in Edit mode first.');
  assert.equal(check('edit.redactSelection', edit({ objectSelection: { size: 2 } })).available, true);
  assert.equal(check('edit.redactSelection', view({ objectSelection: { size: 2 } })).available, false, 'not in Edit mode');
  assert.equal(check('edit.replacePicture', edit({ objectSelection: { size: 2 } })).reason, 'Select a picture in Edit mode first.');
  assert.equal(check('edit.replacePicture', edit({ objectSelection: { size: 1 }, textEditor: { pictureSelected: true } })).available, true);
  // Protected first: the reason that can't be fixed by selecting something.
  assert.equal(check('edit.redactSelection', view({ encrypted: true })).unmet, 'writable');
  // Selected text: in the vocabulary for Tools' relevance and future commands.
  assert.equal(REQUIREMENTS['selection.text'].met(snap(view({ getSelectedText: () => 'Hello' }))), true);
  assert.equal(REQUIREMENTS['selection.text'].met(snap(STATES.ready)), false);
});

test('presence hides a command everywhere; only what a feature reports is present', () => {
  const ai = { label: 'Summarize…', doc: true, presentIf: 'ai.local', run() {} };
  assert.deepEqual(availability(ai, snap(STATES.ready)), { present: false, available: false, reason: null, unmet: null });
  assert.equal(availability(ai, { ...snap(STATES.ready), presence: { 'ai.local': true } }).available, true);
  assert.deepEqual(Object.keys(snap(STATES.ready).presence), []);
});

// office.providers as the host sends it (MainWindow.OfficeConversion.cs), one answer per format.
const report = (word, excel, powerpoint) => ({
  providers: [],
  formats: [['word', word], ['excel', excel], ['powerpoint', powerpoint]].map(([format, status]) => ({ format, status })),
});
const OFFICE = ['office.wordToPdf', 'office.excelToPdf', 'office.powerpointToPdf'];

test('Office tools: present where a provider can convert the format, busy or not; needing no document', () => {
  const withOffice = (r, active = null) => snapshot({ active }, {}, { ...actions, office: { presence: () => presenceFrom(r) } });
  const shown = (r, active) => OFFICE.filter((id) => availability(commands[id], withOffice(r, active)).present);
  // Before office.providers has answered, and on a PC with nothing that converts: none of them.
  assert.deepEqual(OFFICE.filter((id) => availability(commands[id], snap(null)).present), []);
  assert.deepEqual(shown(report('noProvider', 'noProvider', 'noProvider')), []);
  // Office without PowerPoint: that one isn't a tool here. PowerPoint open: still one, its reason said when run.
  assert.deepEqual(shown(report('ready', 'ready', 'notSupported')), OFFICE.slice(0, 2));
  assert.deepEqual(shown(report('ready', 'ready', 'unavailable')), OFFICE);
  // They convert files, so they run with or without a document open.
  for (const id of OFFICE) assert.equal(availability(commands[id], withOffice(report('ready', 'ready', 'ready'))).available, true, id);
  // A report that can't be read, or names something else, makes nothing present.
  for (const bad of [null, {}, { formats: 'x' }, { formats: [{ format: 'visio', status: 'ready' }] }]) assert.deepEqual(presenceFrom(bad), {});
});

test('Office outcomes: a PDF, a quiet cancel, or the host’s reason under a title that fits', () => {
  assert.equal(describeOutcome({ status: 'converted', message: 'Converted with Microsoft Office.' }).kind, 'converted');
  assert.deepEqual(describeOutcome({ status: 'cancelled', message: 'The conversion was cancelled; nothing was saved.' }),
    { kind: 'cancelled', title: null, message: 'The conversion was cancelled; nothing was saved.', recheck: false });
  const busy = describeOutcome({ status: 'unavailable', message: 'PowerPoint is open. Close it and try again.' });
  assert.deepEqual([busy.kind, busy.title, busy.message, busy.recheck], ['refused', 'Can’t convert right now', 'PowerPoint is open. Close it and try again.', false]);
  assert.equal(describeOutcome({ status: 'protected', message: 'x' }).title, 'Can’t convert a protected document');
  assert.equal(describeOutcome({ status: 'noProvider', message: 'x' }).recheck, true);
  for (const status of ['failed', 'timedOut', 'somethingNew']) assert.equal(describeOutcome({ status, message: 'x' }).title, 'Couldn’t make the PDF', status);
  // Never an empty dialog.
  assert.ok(describeOutcome({ status: 'failed' }).message.length > 0);
});

test('an unknown requirement is an error, not a silent pass', () => {
  assert.throws(() => availability({ requires: ['nonsense'] }, snap(STATES.ready)), /nonsense/);
});

test('the More menu gives the same answers as the checks it replaced, in every state', () => {
  // app.js before requirements.js: `ready`, `canEditPages`, `encrypted` and `history.canUse`, by hand.
  const before = {
    'file.saveAs': (v) => !(v?.status === 'ready'),
    'file.print': (v) => !(v?.status === 'ready'),
    'file.export': (v) => !(v?.status === 'ready'),
    'file.history': (v) => !actions.history.canUse(v),
    'pages.insert': (v) => !v?.canEditPages,
    'pages.extract': (v) => !v?.canEditPages,
    'pages.split': (v) => !v?.canEditPages,
    'tools.ocrPage': (v) => !v?.canEditPages,
    'tools.ocrDocument': (v) => !v?.canEditPages,
    'tools.structure': (v) => !(v?.status === 'ready'),
    'tools.graph': (v) => !(v?.status === 'ready'),
    'tools.health': (v) => !(v?.status === 'ready'),
    'tools.compress': (v) => !(v?.status === 'ready') || Boolean(v?.encrypted),
    'tools.pdfa': (v) => !(v?.status === 'ready') || Boolean(v?.encrypted),
  };
  for (const [name, state] of Object.entries(STATES)) {
    for (const [id, disabled] of Object.entries(before)) {
      assert.equal(!check(id, state).available, disabled(state), `${id} with ${name}`);
    }
  }
});

test('a snapshot is plain values', () => {
  const s = snap(STATES.form);
  for (const [key, value] of Object.entries(s)) {
    if (key !== 'presence') assert.ok(['boolean', 'string'].includes(typeof value) || value === null, key);
  }
});
