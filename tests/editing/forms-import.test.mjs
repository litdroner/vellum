// Imported form fields: pages inserted from another PDF bring their AcroForm fields into the opened
// file's own form (annotations/persist.js adoptImportedFields) — values, geometry, required /
// read-only, radio groups — renamed when a name is already taken, and following the pages when they
// are duplicated or deleted.
// Run: node --test tests/editing/forms-import.test.mjs

import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { loadPdfLib, openWithPdfjs, webModule } from './harness.mjs';
import { makeFixtures, FIXTURE_DIR } from './fixtures.mjs';

const { composeDocument } = await webModule('annotations/persist.js');
const { identityPlan, insertEntries, duplicateEntries, removeEntries } = await webModule('pages/plan.js');

let base; // fixture form: name, agree, size (Large / Small), country — all on page 1
let other; // the PDF pages are inserted from (below)
let otherCopy;

/** Two pages: fields named like the fixture's (conflicts), a radio group across both pages, a list box. */
async function makeOther() {
  const { PDFDocument } = await loadPdfLib();
  const doc = await PDFDocument.create();
  const p1 = doc.addPage([612, 792]);
  const p2 = doc.addPage([612, 792]);
  const form = doc.getForm();
  const name = form.createTextField('name');
  name.setText('Grace');
  name.enableRequired();
  name.addToPage(p1, { x: 50, y: 700, width: 200, height: 20 });
  const id = form.createTextField('ref');
  id.setText('R-7');
  id.enableReadOnly();
  id.addToPage(p1, { x: 50, y: 660, width: 100, height: 20 });
  const agree = form.createCheckBox('agree');
  agree.addToPage(p1, { x: 50, y: 620, width: 14, height: 14 });
  agree.check();
  const size = form.createRadioGroup('size');
  size.addOptionToPage('Tall', p1, { x: 50, y: 580, width: 14, height: 14 });
  size.addOptionToPage('Short', p2, { x: 50, y: 580, width: 14, height: 14 });
  size.select('Short');
  const country = form.createDropdown('country');
  country.addOptions(['Peru', 'Chile']);
  country.select('Chile');
  country.addToPage(p1, { x: 50, y: 540, width: 120, height: 20 });
  const langs = form.createOptionList('langs');
  langs.addOptions(['C', 'Lisp', 'Rust']);
  langs.enableMultiselect();
  langs.select(['Lisp', 'Rust']);
  langs.addToPage(p1, { x: 50, y: 440, width: 120, height: 60 });
  const notes = form.createTextField('notes');
  notes.setText('page two');
  notes.addToPage(p2, { x: 300, y: 300, width: 150, height: 30 });
  return doc.save();
}

before(async () => {
  base = new Uint8Array(fs.readFileSync((await makeFixtures(FIXTURE_DIR)).form));
  other = await makeOther();
  otherCopy = Uint8Array.from(other);
});

/** The opened file's page, then the other PDF's pages (all, or those listed). */
function planWith(src, indexes = [0, 1]) {
  return insertEntries(identityPlan(1), 1, indexes.map((index) => ({ id: `${src}-${index}`, src, index, rotate: 0 })));
}

async function fieldsOf(bytes) {
  const js = await openWithPdfjs(bytes);
  const objects = await js.doc.getFieldObjects();
  js.close();
  const out = {};
  for (const [name, list] of objects) {
    const widgets = list.filter((o) => o.type);
    if (widgets.length) out[name] = widgets;
  }
  return out;
}

const rectOf = (widget) => { const r = widget.getRectangle(); return [r.x, r.y, r.width, r.height].map((v) => Math.round(v)); };

test('inserted pages bring their fields, values, flags and geometry into the form; clashing names are renamed', async () => {
  const saved = await composeDocument({ base, plan: planWith('A'), sources: new Map([['A', other]]) });
  const { PDFDocument } = await loadPdfLib();
  const form = (await PDFDocument.load(saved)).getForm();
  const names = form.getFields().map((f) => f.getName()).sort();
  assert.deepEqual(names, ['agree', 'agree_2', 'country', 'country_2', 'langs', 'name', 'name_2', 'notes', 'ref', 'size', 'size_2']);

  // The opened file's own fields are untouched.
  assert.equal(form.getTextField('name').getText(), undefined);
  assert.equal(form.getCheckBox('agree').isChecked(), false);
  assert.deepEqual(form.getRadioGroup('size').getOptions().sort(), ['Large', 'Small']);

  // The imported ones keep what they held.
  assert.equal(form.getTextField('name_2').getText(), 'Grace');
  assert.equal(form.getTextField('name_2').isRequired(), true);
  assert.equal(form.getTextField('ref').isReadOnly(), true);
  assert.equal(form.getCheckBox('agree_2').isChecked(), true);
  assert.deepEqual(form.getRadioGroup('size_2').getOptions(), ['Tall', 'Short']);
  assert.equal(form.getRadioGroup('size_2').getSelected(), 'Short');
  assert.deepEqual(form.getDropdown('country_2').getSelected(), ['Chile']);
  assert.deepEqual(form.getOptionList('langs').getSelected(), ['Lisp', 'Rust']);
  const theirs = (await PDFDocument.load(other)).getForm();
  for (const [mine, their] of [['name_2', 'name'], ['notes', 'notes'], ['langs', 'langs'], ['country_2', 'country']]) {
    assert.deepEqual(rectOf(form.getField(mine).acroField.getWidgets()[0]), rectOf(theirs.getField(their).acroField.getWidgets()[0]), mine + ' is where it was');
  }
  assert.deepEqual(rectOf(form.getTextField('notes').acroField.getWidgets()[0]), [300, 300, 151, 31]);

  // pdf.js reads them on the right pages, with their values.
  const f = await fieldsOf(saved);
  assert.deepEqual(f.name_2.map((o) => `${o.value}@${o.page}`), ['Grace@1']);
  assert.deepEqual(f.notes.map((o) => `${o.value}@${o.page}`), ['page two@2']);
  assert.deepEqual(f.size_2.map((o) => o.page), [1, 2], 'one radio group across both inserted pages');
  assert.equal(f.langs[0].type, 'listbox');
  assert.deepEqual(other, otherCopy, 'the other PDF is not changed');
});

test('the imported fields are filled, saved and reopened like the file’s own', async () => {
  const sources = new Map([['A', other]]);
  const plan = planWith('A');
  const forms = [
    { name: 'name_2', type: 'text', value: 'Ada' },
    { name: 'size_2', type: 'radiobutton', value: 'Tall' },
    { name: 'langs', type: 'listbox', value: ['C'] },
    { name: 'name', type: 'text', value: 'Own' },
  ];
  const saved = await composeDocument({ base, plan, sources, forms });
  const again = await composeDocument({ base: saved, forms: [{ name: 'notes', type: 'text', value: 'refilled' }] });
  const f = await fieldsOf(again);
  assert.equal(f.name_2[0].value, 'Ada');
  assert.equal(f.name[0].value, 'Own');
  assert.deepEqual(f.size_2.map((o) => o.value), ['Tall', 'Tall']);
  assert.deepEqual([f.langs[0].value].flat(), ['C']);
  assert.equal(f.notes[0].value, 'refilled');
});

test('only the inserted pages’ widgets come: a radio group keeps the buttons on pages kept; deleted pages take their fields', async () => {
  const sources = new Map([['A', other]]);
  const saved = await composeDocument({ base, plan: planWith('A', [0]), sources, forms: [{ name: 'notes', type: 'text', value: 'typed before deleting' }] });
  const { PDFDocument } = await loadPdfLib();
  const form = (await PDFDocument.load(saved)).getForm();
  assert.equal(form.getFieldMaybe('notes'), undefined, 'page 2 was not inserted: its field is not in the form, its value is not refused');
  const size = form.getRadioGroup('size_2');
  assert.equal(size.acroField.getWidgets().length, 1);
  assert.deepEqual(size.getOptions(), ['Tall']);
  // Deleting the inserted page afterwards (in the plan) leaves only the file's own fields.
  const plan = planWith('A', [0]);
  const onlyOwn = await composeDocument({ base, plan: removeEntries(plan, new Set([plan[1].id])), sources });
  assert.deepEqual((await PDFDocument.load(onlyOwn)).getForm().getFields().map((f) => f.getName()).sort(), ['agree', 'country', 'name', 'size']);
  // After saving, deleting the page that came in is deleting a page of the file's own: its fields go.
  const reopened = await composeDocument({ base: saved, plan: identityPlan(1) });
  assert.deepEqual((await PDFDocument.load(reopened)).getForm().getFields().map((f) => f.getName()).sort(), ['agree', 'country', 'name', 'size']);
});

test('names stay the same when other inserted pages are deleted; the same PDF inserted twice gets its own fields', async () => {
  const sources = new Map([['A', other], ['B', other]]);
  const both = insertEntries(planWith('A', [0]), 2, [{ id: 'B-0', src: 'B', index: 0, rotate: 0 }]);
  const { PDFDocument } = await loadPdfLib();
  const names = async (plan) => (await PDFDocument.load(await composeDocument({ base, plan, sources }))).getForm().getFields().map((f) => f.getName()).sort();
  assert.deepEqual(await names(both), ['agree', 'agree_2', 'agree_3', 'country', 'country_2', 'country_3', 'langs', 'langs_2', 'name', 'name_2', 'name_3', 'ref', 'ref_2', 'size', 'size_2', 'size_3']);
  const withoutA = removeEntries(both, new Set(['A-0']));
  assert.deepEqual(await names(withoutA), ['agree', 'agree_3', 'country', 'country_3', 'langs_2', 'name', 'name_3', 'ref_2', 'size', 'size_3']);
});

test('a duplicated inserted page shows the same fields, sharing one value', async () => {
  const sources = new Map([['A', other]]);
  const plan = planWith('A', [0]);
  const dup = duplicateEntries(plan, new Set([plan[1].id])).plan;
  const saved = await composeDocument({ base, plan: dup, sources, forms: [{ name: 'name_2', type: 'text', value: 'Both' }] });
  const f = await fieldsOf(saved);
  assert.deepEqual(f.name_2.map((o) => `${o.value}@${o.page}`), ['Both@1', 'Both@2']);
  assert.deepEqual(f.size_2.map((o) => o.page), [1, 2]);
  const { PDFDocument } = await loadPdfLib();
  const form = (await PDFDocument.load(saved)).getForm();
  assert.equal(form.getFields().length, 10, 'no copies outside the form, no extra fields');
  assert.equal(form.getRadioGroup('size_2').acroField.getWidgets().length, 2);
});

test('a PDF with no form, and a destination with no form, both work', async () => {
  const { PDFDocument } = await loadPdfLib();
  const plain = await PDFDocument.create();
  plain.addPage([300, 300]);
  const plainBytes = await plain.save();
  // Fields from the other PDF into a file that had no form.
  const saved = await composeDocument({ base: plainBytes, plan: planWith('A', [0, 1]), sources: new Map([['A', other]]) });
  const names = (await PDFDocument.load(saved)).getForm().getFields().map((f) => f.getName()).sort();
  assert.deepEqual(names, ['agree', 'country', 'langs', 'name', 'notes', 'ref', 'size']);
  // A PDF with no form into one with a form: nothing changes about the form.
  const kept = await composeDocument({ base, plan: planWith('P', [0]), sources: new Map([['P', plainBytes]]) });
  assert.equal((await PDFDocument.load(kept)).getForm().getFields().length, 4);
});
