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
const { identityPlan, duplicateEntries, copyEntries, rotateEntries } = await webModule('pages/plan.js');

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

test('a duplicated or pasted page shows the same fields, and a deleted page takes its fields out of the form', async () => {
  const forms = [{ name: 'name', type: 'text', value: 'Ada' }, { name: 'size', type: 'radiobutton', value: 'Large' }];
  const [page] = identityPlan(1);
  let plan = duplicateEntries([page], new Set([page.id])).plan;
  plan = rotateEntries(copyEntries(plan, new Set([page.id]), 0).plan, new Set([plan[1].id]), 90);
  const saved = await composeDocument({ base: bytes, plan, forms });
  const js = await openWithPdfjs(saved);
  const objects = await js.doc.getFieldObjects();
  js.close();
  const on = (name) => objects.get(name).filter((o) => o.type).map((o) => `${o.value}@${o.page}`);
  assert.deepEqual(on('name'), ['Ada@0', 'Ada@1', 'Ada@2'], 'one field, a widget on each page, one value');
  assert.deepEqual(on('size'), ['Large@0', 'Large@0', 'Large@1', 'Large@1', 'Large@2', 'Large@2']);

  const { PDFDocument } = await loadPdfLib();
  const doc = await PDFDocument.load(saved);
  assert.deepEqual(doc.getForm().getFields().map((f) => [f.getName(), f.acroField.getWidgets().length]).sort(),
    [['agree', 3], ['country', 3], ['name', 3], ['size', 6]], 'the same four fields, no copies outside the form');
  const refilled = await composeDocument({ base: saved, forms: [{ name: 'name', type: 'text', value: 'Bob' }] });
  assert.deepEqual((await fieldValues(refilled)).name, 'Bob', 'filled again after reopening');

  // Only a blank page left: the fields go with the page, and their values aren't refused.
  const blank = [{ id: 'blank', src: 'blank', width: 612, height: 792, rotate: 0 }];
  const emptied = await PDFDocument.load(await composeDocument({ base: bytes, plan: blank, forms }));
  assert.equal(emptied.getForm().getFields().length, 0);
});
