// Forms v1: the PDF's own form fields are found, filled through composeDocument (the app's only PDF
// writer) and read back by pdf.js and pdf-lib, still real fields.
// Run: node --test tests/editing/forms.test.mjs

import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { loadPdfLib, openWithPdfjs, webModule } from './harness.mjs';
import { makeFixtures, FIXTURE_DIR } from './fixtures.mjs';

const { composeDocument } = await webModule('annotations/persist.js');
const { readFields } = await webModule('forms/fields.js');

let bytes;
before(async () => { bytes = new Uint8Array(fs.readFileSync((await makeFixtures(FIXTURE_DIR)).form)); });

async function fieldValues(data) {
  const js = await openWithPdfjs(data);
  const objects = await js.doc.getFieldObjects();
  js.close();
  const value = (name) => objects.get(name).filter((o) => o.type).map((o) => o.value);
  return { name: value('name')[0], agree: value('agree')[0], size: value('size'), country: value('country')[0] };
}

test('the form fields are detected with their types', async () => {
  const js = await openWithPdfjs(bytes);
  const types = [...(await readFields(js.doc)).values()].map((f) => `${f.name}:${f.type}:${f.exportValue ?? ''}`).sort();
  assert.deepEqual(types, ['agree:checkbox:Yes', 'country:combobox:', 'name:text:', 'size:radiobutton:Large', 'size:radiobutton:Small']);
  js.close();
});

test('filled values are saved into the same fields and read back after reopening', async () => {
  const forms = [
    { name: 'name', type: 'text', value: 'Ada Lovelace' },
    { name: 'agree', type: 'checkbox', value: true },
    { name: 'size', type: 'radiobutton', value: 'Large' },
    { name: 'country', type: 'combobox', value: 'se' },
  ];
  const saved = await composeDocument({ base: bytes, forms });
  const back = await fieldValues(saved);
  assert.equal(back.name, 'Ada Lovelace');
  assert.equal(back.agree, 'Yes');
  assert.deepEqual(back.size, ['Large', 'Large']);
  assert.equal(back.country, 'se');

  // Still real, interactive fields: the same four, not flattened, each with an appearance.
  const { PDFDocument } = await loadPdfLib();
  const doc = await PDFDocument.load(saved);
  const fields = doc.getForm().getFields();
  assert.deepEqual(fields.map((f) => f.getName()).sort(), ['agree', 'country', 'name', 'size']);
  assert.equal(doc.getForm().getTextField('name').getText(), 'Ada Lovelace');
  assert.equal(doc.getForm().getRadioGroup('size').getSelected(), 'Large');
  assert.ok(doc.getForm().getCheckBox('agree').isChecked());
  for (const f of fields) for (const w of f.acroField.getWidgets()) assert.ok(w.getAppearances()?.normal, `${f.getName()} has an appearance`);

  // Changed again in the saved file: cleared text, unticked, the other option.
  const again = await fieldValues(await composeDocument({ base: saved, forms: [
    { name: 'name', type: 'text', value: '' },
    { name: 'agree', type: 'checkbox', value: false },
    { name: 'size', type: 'radiobutton', value: 'Small' },
  ] }));
  assert.equal(again.name, '');
  assert.equal(again.agree, 'Off');
  assert.deepEqual(again.size, ['Small', 'Small']);
  assert.equal(again.country, 'se');
});

test('characters the standard font lacks are kept, and readers are asked to draw them', async () => {
  const saved = await composeDocument({ base: bytes, forms: [{ name: 'name', type: 'text', value: 'Łukasz 漢字' }] });
  assert.equal((await fieldValues(saved)).name, 'Łukasz 漢字');
  const { PDFDocument, PDFName } = await loadPdfLib();
  const doc = await PDFDocument.load(saved);
  assert.equal(String(doc.getForm().acroForm.dict.get(PDFName.of('NeedAppearances'))), 'true');
});

test('a field that is not in the file is refused with its name', async () => {
  await assert.rejects(composeDocument({ base: bytes, forms: [{ name: 'missing', type: 'text', value: 'x' }] }), /“missing”/);
});
