// Forms v2.1: the file's own form fields are edited — moved, resized, renamed, made required or
// read-only, given a maximum length, deleted — through the same store items as created fields, and
// saving writes those changes into the same AcroForm fields.
// Run: node --test tests/editing/forms-edit.test.mjs

import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { loadPdfLib, openWithPdfjs, webModule } from './harness.mjs';
import { makeFixtures, FIXTURE_DIR } from './fixtures.mjs';

const { composeDocument } = await webModule('annotations/persist.js');
const { existingFieldItem, validFieldName } = await webModule('forms/fields.js');
const { hitTest } = await webModule('annotations/geometry.js');

let bytes;
before(async () => { bytes = new Uint8Array(fs.readFileSync((await makeFixtures(FIXTURE_DIR)).form)); });

/** Store items for every widget of the file's own fields on page 1, keyed "name" or "name=value". */
async function editable(pdf = bytes) {
  const js = await openWithPdfjs(pdf);
  const annotations = await (await js.doc.getPage(1)).getAnnotations();
  js.close();
  const out = {};
  for (const data of annotations) {
    const item = existingFieldItem(data, 1);
    if (item) out[item.kind === 'radio' ? `${item.name}=${item.value}` : item.name] = { id: `e-${data.id}`, ...item };
  }
  return out;
}

const form = async (pdf) => (await (await loadPdfLib()).PDFDocument.load(pdf)).getForm();
const rectOf = (widget) => { const r = widget.getRectangle(); return [r.x, r.y, r.x + r.width, r.y + r.height]; };

test('existing widgets become editable store items of each kind, with their flags', async () => {
  const items = await editable();
  assert.deepEqual(Object.keys(items).sort(), ['agree', 'country', 'name', 'size=Large', 'size=Small']);
  assert.equal(items.name.kind, 'text');
  assert.deepEqual(items.name.rect, [71.5, 679.5, 312.5, 704.5], 'as drawn: pdf-lib grows the fixture widget by half its border');
  assert.equal(items.name.maxLength, null);
  assert.equal(items.agree.kind, 'checkbox');
  assert.equal(items['size=Large'].kind, 'radio');
  assert.equal(items.country.kind, 'dropdown');
  assert.deepEqual(items.country.options, ['India', 'Sweden']);
  assert.equal(items.name.required, false);
  assert.equal(items.name.readOnly, false);
  assert.deepEqual(items.name.existing.rect, items.name.rect);
});

test('move, resize, rename, required, read-only and max length are saved into the same field', async () => {
  const { name, agree } = await editable();
  const saved = await composeDocument({ base: bytes, annotations: [
    { ...name, rect: [100, 600, 250, 630], name: 'fullName', required: true, maxLength: 12 },
    { ...agree, rect: [300, 300, 318, 318], readOnly: true },
  ] });
  const f = await form(saved);
  assert.equal(f.getFieldMaybe('name'), undefined, 'the old name is gone');
  const text = f.getTextField('fullName');
  assert.deepEqual(rectOf(text.acroField.getWidgets()[0]), [100, 600, 250, 630]);
  assert.equal(text.isRequired(), true);
  assert.equal(text.isReadOnly(), false);
  assert.equal(text.getMaxLength(), 12);
  const box = f.getCheckBox('agree');
  assert.deepEqual(rectOf(box.acroField.getWidgets()[0]), [300, 300, 318, 318]);
  assert.equal(box.isReadOnly(), true);
  assert.equal(f.getFields().length, 4, 'no field added or lost');

  // Reopened, the changes are what pdf.js reads, and they can be edited (and undone) again.
  const again = await editable(saved);
  assert.deepEqual(again.fullName.rect, [100, 600, 250, 630]);
  assert.equal(again.fullName.required, true);
  assert.equal(again.fullName.maxLength, 12);
  assert.equal(again.agree.readOnly, true);
  const back = await composeDocument({ base: saved, annotations: [{ ...again.fullName, name: 'name', required: false, maxLength: null }] });
  const g = await form(back);
  assert.equal(g.getTextField('name').isRequired(), false);
  assert.equal(g.getTextField('name').getMaxLength(), undefined);
});

test('values are kept: a renamed, filled, moved field keeps what was typed into it', async () => {
  const { name } = await editable();
  const saved = await composeDocument({ base: bytes,
    forms: [{ name: 'name', type: 'text', value: 'Ada Lovelace' }],
    annotations: [{ ...name, name: 'applicant', rect: [72, 400, 312, 424] }] });
  const js = await openWithPdfjs(saved);
  const objects = await js.doc.getFieldObjects();
  js.close();
  assert.equal(objects.get('applicant').find((o) => o.type).value, 'Ada Lovelace');
});

test('a maximum length shorter than the text already there is refused with a reason', async () => {
  const { name } = await editable();
  await assert.rejects(composeDocument({ base: bytes,
    forms: [{ name: 'name', type: 'text', value: 'Ada Lovelace' }],
    annotations: [{ ...name, maxLength: 3 }] }), /“name”.*longer than 3/);
});

test('conflicting or invalid names are refused, and nothing is written', async () => {
  const { name } = await editable();
  await assert.rejects(composeDocument({ base: bytes, annotations: [{ ...name, name: 'agree' }] }), /“name”.*already in the file/);
  await assert.rejects(composeDocument({ base: bytes, annotations: [{ ...name, name: 'a.b' }] }), /isn’t a name/);
  // A created field can't take the name an existing field is renamed to, nor one still in the file.
  await assert.rejects(composeDocument({ base: bytes, annotations: [
    { id: 'n1', type: 'field', kind: 'text', page: 1, rect: [50, 50, 200, 72], name: 'agree' },
  ] }), /already in the file/);
  assert.equal(validFieldName('ok'), true);
  for (const bad of ['', ' x', 'a.b', null]) assert.equal(validFieldName(bad), false);
});

test('delete removes the field and its widget; undoing (not deleted) leaves it in place', async () => {
  const { name, country } = await editable();
  const saved = await composeDocument({ base: bytes, annotations: [{ ...name, deleted: true }, { ...country }] });
  const f = await form(saved);
  assert.equal(f.getFieldMaybe('name'), undefined);
  assert.deepEqual(f.getFields().map((x) => x.getName()).sort(), ['agree', 'country', 'size']);
  const annots = (await openWithPdfjs(saved));
  const left = (await (await annots.doc.getPage(1)).getAnnotations()).map((a) => a.fieldName);
  annots.close();
  assert.ok(!left.includes('name'), 'its widget is gone from the page');
  // Deleted items are never hit.
  assert.equal(hitTest([{ ...name, deleted: true }], [100, 690], 1), null);
  assert.equal(hitTest([name], [100, 690], 1)?.name, 'name');
});

test('radio buttons keep their group and export values: move one, delete one, rename the group', async () => {
  const items = await editable();
  const small = items['size=Small'];
  const large = items['size=Large'];
  const saved = await composeDocument({ base: bytes,
    forms: [{ name: 'size', type: 'radiobutton', value: 'Large' }],
    annotations: [{ ...large, rect: [200, 580, 218, 598], name: 'tshirt', required: true }] });
  const js = await openWithPdfjs(saved);
  const objects = await js.doc.getFieldObjects();
  js.close();
  const group = objects.get('tshirt').filter((o) => o.type);
  assert.deepEqual(group.map((o) => o.exportValues).sort(), ['Large', 'Small'], 'export values kept');
  assert.deepEqual(group.map((o) => o.value), ['Large', 'Large'], 'the chosen value kept');
  const f = await form(saved);
  assert.equal(f.getRadioGroup('tshirt').isRequired(), true);
  assert.deepEqual(f.getRadioGroup('tshirt').acroField.getWidgets().map(rectOf).sort(), [[200, 580, 218, 598], [71.5, 579.5, 90.5, 598.5]].sort());

  // One button of the group deleted: the group stays, with the other button.
  const one = await composeDocument({ base: bytes, annotations: [{ ...small, deleted: true }] });
  const g = await form(one);
  assert.deepEqual(g.getRadioGroup('size').getOptions(), ['Large']);
  // Both deleted: the group is gone.
  const none = await composeDocument({ base: bytes, annotations: [{ ...small, deleted: true }, { ...large, deleted: true }] });
  assert.equal((await form(none)).getFieldMaybe('size'), undefined);
  // Buttons of one group given different names are refused.
  await assert.rejects(composeDocument({ base: bytes, annotations: [{ ...small, name: 'a' }, { ...large, name: 'b' }] }), /different names/);
});

test('a dropdown keeps its options and export values when moved and resized', async () => {
  const { country } = await editable();
  const saved = await composeDocument({ base: bytes,
    forms: [{ name: 'country', type: 'combobox', value: 'se' }],
    annotations: [{ ...country, rect: [72, 300, 272, 330] }] });
  const js = await openWithPdfjs(saved);
  const [data] = (await (await js.doc.getPage(1)).getAnnotations()).filter((a) => a.fieldName === 'country');
  js.close();
  assert.deepEqual(data.options.map((o) => [o.exportValue, o.displayValue]), [['in', 'India'], ['se', 'Sweden']]);
  assert.deepEqual(data.fieldValue, ['se']);
  assert.deepEqual(data.rect, [72, 300, 272, 330]);
});

test('created fields take required, read-only and a maximum length too', async () => {
  const saved = await composeDocument({ base: bytes, annotations: [
    { id: 'c1', type: 'field', kind: 'text', page: 1, rect: [50, 50, 200, 72], name: 'Text1', required: true, maxLength: 5 },
    { id: 'c2', type: 'field', kind: 'radio', page: 1, rect: [50, 90, 64, 104], name: 'Choice1', value: 'A', readOnly: true },
    { id: 'c3', type: 'field', kind: 'radio', page: 1, rect: [80, 90, 94, 104], name: 'Choice1', value: 'B', readOnly: true },
  ] });
  const f = await form(saved);
  assert.equal(f.getTextField('Text1').isRequired(), true);
  assert.equal(f.getTextField('Text1').getMaxLength(), 5);
  assert.equal(f.getRadioGroup('Choice1').isReadOnly(), true);
  assert.deepEqual(f.getRadioGroup('Choice1').getOptions(), ['A', 'B']);
});
