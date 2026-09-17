// Forms v2: fields created in Vellum (text, checkbox, radio buttons, dropdown) are written by
// composeDocument as real AcroForm fields, read back by pdf.js, and filled like the file's own fields.
// Run: node --test tests/editing/forms-create.test.mjs

import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { loadPdfLib, openWithPdfjs, webModule } from './harness.mjs';
import { makeFixtures, FIXTURE_DIR } from './fixtures.mjs';

const { composeDocument } = await webModule('annotations/persist.js');
const { readFields, uniqueFieldName, FIELD_KINDS } = await webModule('forms/fields.js');
const { bounds, hitTest } = await webModule('annotations/geometry.js');

let bytes;
before(async () => { bytes = new Uint8Array(fs.readFileSync((await makeFixtures(FIXTURE_DIR)).form)); });

const field = (kind, name, rect, extra = {}) => ({ id: `f-${name}-${extra.value ?? ''}`, type: 'field', kind, page: 1, rect, name, ...extra });
const created = [
  field('text', 'Text1', [50, 700, 210, 722]),
  field('checkbox', 'Check1', [50, 670, 64, 684]),
  field('radio', 'Choice1', [50, 640, 64, 654], { value: 'Yes' }),
  field('radio', 'Choice1', [80, 640, 94, 654], { value: 'No' }),
  field('dropdown', 'Dropdown1', [50, 600, 210, 622], { options: ['Red', 'Green', ''] }),
];

test('created fields are saved as real fields of each kind, beside the file’s own', async () => {
  const saved = await composeDocument({ base: bytes, annotations: created });
  const js = await openWithPdfjs(saved);
  const types = [...(await readFields(js.doc)).values()].map((f) => `${f.name}:${f.type}:${f.exportValue ?? ''}`).sort();
  js.close();
  assert.deepEqual(types, [
    'Check1:checkbox:Yes', 'Choice1:radiobutton:No', 'Choice1:radiobutton:Yes', 'Dropdown1:combobox:', 'Text1:text:',
    'agree:checkbox:Yes', 'country:combobox:', 'name:text:', 'size:radiobutton:Large', 'size:radiobutton:Small',
  ]);

  const { PDFDocument } = await loadPdfLib();
  const form = (await PDFDocument.load(saved)).getForm();
  assert.deepEqual(form.getDropdown('Dropdown1').getOptions(), ['Red', 'Green'], 'empty options are left out');
  const [widget] = form.getTextField('Text1').acroField.getWidgets();
  const r = widget.getRectangle();
  assert.deepEqual([r.x, r.y, r.width, r.height], [50, 700, 160, 22], 'placed where it was drawn, at its size');
  for (const f of form.getFields()) for (const w of f.acroField.getWidgets()) assert.ok(w.getAppearances()?.normal, `${f.getName()} has an appearance`);
});

test('after reopening, created fields are filled and saved again like any other field', async () => {
  const saved = await composeDocument({ base: bytes, annotations: created });
  const filled = await composeDocument({ base: saved, forms: [
    { name: 'Text1', type: 'text', value: 'Ada' },
    { name: 'Check1', type: 'checkbox', value: true },
    { name: 'Choice1', type: 'radiobutton', value: 'No' },
    { name: 'Dropdown1', type: 'combobox', value: 'Green' },
  ] });
  const js = await openWithPdfjs(filled);
  const objects = await js.doc.getFieldObjects();
  js.close();
  const value = (name) => objects.get(name).filter((o) => o.type).map((o) => o.value);
  assert.deepEqual(value('Text1'), ['Ada']);
  assert.deepEqual(value('Check1'), ['Yes']);
  assert.deepEqual(value('Choice1'), ['No', 'No']);
  assert.deepEqual(value('Dropdown1'), ['Green']);
});

test('a moved or resized field is saved at its new place; saving twice from the same file adds it once', async () => {
  const moved = created.map((f) => (f.name === 'Text1' ? { ...f, rect: [100, 500, 300, 540] } : f));
  await composeDocument({ base: bytes, annotations: created });
  const saved = await composeDocument({ base: bytes, annotations: moved });
  const { PDFDocument } = await loadPdfLib();
  const form = (await PDFDocument.load(saved)).getForm();
  const widgets = form.getTextField('Text1').acroField.getWidgets();
  assert.equal(widgets.length, 1);
  const r = widgets[0].getRectangle();
  assert.deepEqual([r.x, r.y, r.width, r.height], [100, 500, 200, 40]);
});

test('a name the file already uses is refused with that name', async () => {
  await assert.rejects(composeDocument({ base: bytes, annotations: [field('text', 'name', [10, 10, 100, 30])] }), /“name”/);
});

test('names, bounds and hit testing for created fields', () => {
  assert.equal(uniqueFieldName(FIELD_KINDS.text.base, new Set(['Text1', 'Text2'])), 'Text3');
  const f = created[0];
  assert.deepEqual(bounds(f), [50, 700, 210, 722]);
  assert.equal(hitTest([f], [100, 710], 1), f);
  assert.equal(hitTest([f], [100, 690], 1), null);
});
