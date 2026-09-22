// Filling the PDF's own form fields (AcroForm): text fields, checkboxes, radio buttons, dropdowns
// and list boxes. pdf.js draws the fields as inputs over the page; what is typed or chosen there is
// kept by field name (annotations/model.js setFormValue) and written into the same fields when the
// file is saved — the field's value (/V), a checkbox or radio button's state (/AS), and a new
// appearance so other readers show the value. Fields the file already has are never removed, flattened
// or rasterized, and no form script is run.
//
// Forms v2 adds new fields: text fields, checkboxes, radio buttons and dropdowns placed on a page. Until
// the file is saved they are items of the edit store ({ type: 'field', kind, page, rect, name, value?,
// options? }), drawn, moved and resized by the annotation layer; saving writes them as ordinary AcroForm
// fields with widgets (writeNewFields), so after reopening they are filled like any other field.
//
// Forms v2.1 edits the file's own fields the same way: a widget picked for editing becomes a store item
// of type 'field' too, with `existing: { id, name, rect }` naming the field and widget it stands for
// (existingFieldItem). Moving, resizing, renaming, required / read-only, a text field's maximum length
// and deleting (`deleted: true`, so it can be undone) are written into that same field when the file
// is saved (writeFieldChanges); its value, options, radio export values and appearance are kept.

/** The fields pdf.js found, by widget id: { name, type, exportValue }. Empty when there is no form. */
export async function readFields(pdf) {
  const byId = new Map();
  const objects = await pdf.getFieldObjects().catch(() => null);
  // pdf.js 6 answers with a Map of field name → widgets.
  for (const [name, list] of objects instanceof Map ? objects : Object.entries(objects ?? {})) {
    for (const o of list) {
      if (!o.type || o.type === 'button' || !o.id) continue;
      byId.set(o.id, { name, type: o.type, exportValue: o.exportValues ?? null });
    }
  }
  return byId;
}

/**
 * The value an input of pdf.js's annotation layer now holds, as setFormValue takes it, or null when
 * the element isn't a form field Vellum fills. `fields` is readFields' map.
 */
export function valueOfInput(element, fields) {
  const holder = element.closest?.('[data-element-id]');
  const field = holder && fields.get(holder.dataset.elementId);
  if (!field) return null;
  const { name, type, exportValue } = field;
  switch (type) {
    case 'text': return { name, type, value: element.value };
    case 'checkbox': return { name, type, value: element.checked };
    case 'radiobutton': return element.checked ? { name, type, value: exportValue } : null;
    case 'combobox':
    case 'listbox': {
      if (!element.options) return null;
      const chosen = [...element.options].filter((o) => o.selected).map((o) => o.value);
      return { name, type, value: element.multiple ? chosen : (chosen[0] ?? '') };
    }
    default: return null;
  }
}

/** Writes the kept values into the document's own fields (pdf-lib). Throws with a readable reason. */
export async function writeFormValues(lib, doc, values) {
  if (!values.length) return;
  const { PDFHexString, PDFName, PDFBool, StandardFonts } = lib;
  const form = doc.getForm();
  let font = null;
  let needAppearances = false;
  for (const { name, type, value } of values) {
    const field = form.getFieldMaybe(name);
    if (!field) throw new Error(`The form field “${name}” is no longer in the file.`);
    try {
      if (type === 'checkbox') {
        if (value) field.check(); else field.uncheck();
        continue;
      }
      if (type === 'radiobutton') {
        field.select(value);
        continue;
      }
      if (type === 'text') {
        field.setText(value === '' ? undefined : value);
      } else {
        // A choice field's value is the option's export value, as pdf.js reads it back (pdf-lib's own
        // setter only takes the text an option shows).
        const list = Array.isArray(value) ? value : value === '' ? [] : [value];
        const key = PDFName.of('V');
        if (!list.length) field.acroField.dict.delete(key);
        else field.acroField.dict.set(key, list.length === 1 ? PDFHexString.fromText(list[0]) : doc.context.obj(list.map((v) => PDFHexString.fromText(v))));
        // pdf-lib would draw the export value; where that isn't what the option shows, readers draw it.
        const shown = field.getOptions();
        if (!list.every((v) => shown.includes(v))) {
          needAppearances = true;
          continue;
        }
      }
    } catch (err) {
      throw new Error(`The form field “${name}” couldn’t be filled (${err.message}).`);
    }
    try {
      font ??= await doc.embedFont(StandardFonts.Helvetica);
      field.updateAppearances(font);
    } catch {
      // Characters the standard font can't show: readers draw the value themselves instead.
      needAppearances = true;
    }
  }
  if (needAppearances) form.acroForm.dict.set(PDFName.of('NeedAppearances'), PDFBool.True);
}

/** The kinds of field that can be created, with their default size in points and base name. */
export const FIELD_KINDS = {
  text: { label: 'Text Field', width: 160, height: 22, base: 'Text' },
  checkbox: { label: 'Checkbox', width: 14, height: 14, base: 'Check' },
  radio: { label: 'Radio Button', width: 14, height: 14, base: 'Choice' },
  dropdown: { label: 'Dropdown', width: 160, height: 22, base: 'Dropdown' },
  listbox: { label: 'List Box', width: 160, height: 60, base: 'List' }, // only the file's own; never created
};

/** Smallest a created field can be resized to, in points. */
export const MIN_FIELD_SIZE = 8;

/** A name a field can be given: not empty, no spaces around it, and no "." (that makes it part of another field). */
export const validFieldName = (name) => typeof name === 'string' && name !== '' && name.trim() === name && !name.includes('.');

/**
 * The store item that lets one widget of the file's own form be edited, from pdf.js's annotation data
 * (page.getAnnotations()), on page `page`; null for what isn't a field Vellum edits (push buttons,
 * signature fields).
 */
export function existingFieldItem(data, page) {
  if (data?.annotationType !== 20 /* widget */ || !data.fieldName || !data.rect) return null;
  const kind = data.fieldType === 'Tx' ? 'text'
    : data.fieldType === 'Btn' ? (data.checkBox ? 'checkbox' : data.radioButton ? 'radio' : null)
      : data.fieldType === 'Ch' ? (data.combo ? 'dropdown' : 'listbox') : null;
  if (!kind) return null;
  const [a, b, c, d] = data.rect;
  const rect = [Math.min(a, c), Math.min(b, d), Math.max(a, c), Math.max(b, d)];
  const item = {
    type: 'field', kind, page, rect, name: data.fieldName, required: Boolean(data.required), readOnly: Boolean(data.readOnly),
    existing: { id: data.id, name: data.fieldName, rect },
  };
  if (kind === 'text') item.maxLength = data.maxLen > 0 ? data.maxLen : null;
  if (kind === 'radio') item.value = data.buttonValue ?? '';
  if (kind === 'dropdown' || kind === 'listbox') item.options = (data.options ?? []).map((o) => o.displayValue ?? o.exportValue ?? '');
  return item;
}

/** The first name "Base1", "Base2"… not in `taken` (a Set of field names). */
export function uniqueFieldName(base, taken) {
  for (let i = 1; ; i++) if (!taken.has(`${base}${i}`)) return `${base}${i}`;
}

/**
 * Writes created fields (store items of type 'field') into the document as real AcroForm fields, on
 * `pages` (1-based item.page). Radio buttons sharing a name become one group, each with its own export
 * value. Throws with a readable reason when a name is already a field of the file.
 */
export async function writeNewFields(lib, doc, pages, items) {
  if (!items.length) return;
  const { rgb, degrees } = lib;
  const form = doc.getForm();
  const groups = new Map();
  for (const item of items) {
    const page = pages[item.page - 1];
    if (!page) continue;
    const [x1, y1, x2, y2] = item.rect;
    // pdf-lib grows the widget by half the border on each side; take it off so the field is where it was drawn.
    const options = {
      x: x1 + 0.5, y: y1 + 0.5, width: x2 - x1 - 1, height: y2 - y1 - 1,
      rotate: degrees(page.getRotation().angle),
      borderWidth: 1, borderColor: rgb(0.45, 0.45, 0.45), backgroundColor: rgb(1, 1, 1),
    };
    const name = item.name;
    try {
      if (item.kind === 'radio') {
        let group = groups.get(name);
        if (!group) {
          if (form.getFieldMaybe(name)) throw new Error('a field of that name is already in the file');
          group = form.createRadioGroup(name);
          groups.set(name, group);
        }
        group.addOptionToPage(item.value || name, page, options);
        // A group is required or read-only when any of its buttons was made so (the bar sets them together).
        setFlags(group, { required: item.required || group.isRequired(), readOnly: item.readOnly || group.isReadOnly() });
        continue;
      }
      if (form.getFieldMaybe(name)) throw new Error('a field of that name is already in the file');
      let field = null;
      if (item.kind === 'text') {
        field = form.createTextField(name);
        if (item.maxLength > 0) field.setMaxLength(item.maxLength);
      } else if (item.kind === 'checkbox') field = form.createCheckBox(name);
      else if (item.kind === 'dropdown') {
        field = form.createDropdown(name);
        field.addOptions((item.options ?? []).filter(Boolean));
      }
      if (!field) continue;
      field.addToPage(page, options);
      setFlags(field, item);
    } catch (err) {
      throw new Error(`The new form field “${name}” couldn’t be added (${err.message}).`);
    }
  }
}

function setFlags(field, { required, readOnly }) {
  if (required) field.enableRequired(); else field.disableRequired();
  if (readOnly) field.enableReadOnly(); else field.disableReadOnly();
}

/**
 * Writes the edits made to the file's own fields (store items with `existing`, see existingFieldItem)
 * into those fields: a widget's place and size, the field's name, required / read-only and maximum
 * length, or its removal. Values, options, export values and appearances stay as they are (a resized
 * text or choice field is redrawn at its new size). Throws with a readable reason. Fields no longer in
 * the file (their page was deleted) are skipped.
 */
export async function writeFieldChanges(lib, doc, items) {
  if (!items.length) return;
  const { PDFHexString, PDFName, PDFBool, StandardFonts } = lib;
  const form = doc.getForm();
  const byField = new Map();
  for (const item of items) {
    const list = byField.get(item.existing.name) ?? [];
    list.push(item);
    byField.set(item.existing.name, list);
  }
  let font = null;
  let needAppearances = false;
  for (const [name, list] of byField) {
    const field = form.getFieldMaybe(name);
    if (!field) continue;
    try {
      const widgets = widgetsOf(doc, field);
      const matched = list.map((item) => ({ item, entry: closestWidget(widgets, item.existing.rect) }));
      if (matched.some((m) => !m.entry)) throw new Error('one of its widgets is no longer where it was');
      const gone = new Set(matched.filter((m) => m.item.deleted).map((m) => m.entry));
      if (gone.size === widgets.length) {
        form.removeField(field);
        continue;
      }
      for (const entry of gone) removeWidget(doc, field, entry.ref);
      const kept = matched.filter((m) => !m.item.deleted);
      if (!kept.length) continue;
      let resized = false;
      for (const { item, entry } of kept) {
        const [x1, y1, x2, y2] = item.rect;
        const old = entry.widget.getRectangle();
        if (Math.abs(old.width - (x2 - x1)) > 0.01 || Math.abs(old.height - (y2 - y1)) > 0.01) resized = true;
        entry.widget.setRectangle({ x: x1, y: y1, width: x2 - x1, height: y2 - y1 });
      }
      const last = kept.at(-1).item;
      setFlags(field, last);
      if (last.kind === 'text') {
        const max = last.maxLength > 0 ? last.maxLength : undefined;
        const text = field.getText() ?? '';
        if (max !== undefined && text.length > max) throw new Error(`its text is longer than ${max} characters`);
        field.setMaxLength(max);
      }
      if (new Set(kept.map((m) => m.item.name)).size > 1) throw new Error('its buttons were given different names');
      const renamed = last.name;
      if (renamed !== name) {
        if (field.acroField.getParent() || name.includes('.')) throw new Error('it belongs to a group of fields, so it can’t be renamed');
        if (!validFieldName(renamed)) throw new Error(`“${renamed}” isn’t a name a field can have`);
        if (form.getFieldMaybe(renamed)) throw new Error(`a field named “${renamed}” is already in the file`);
        field.acroField.dict.set(PDFName.of('T'), PDFHexString.fromText(renamed));
      }
      if (resized && ['text', 'dropdown', 'listbox'].includes(last.kind)) {
        try {
          font ??= await doc.embedFont(StandardFonts.Helvetica);
          field.updateAppearances(font);
        } catch {
          needAppearances = true;
        }
      }
    } catch (err) {
      throw new Error(`The form field “${name}” couldn’t be changed (${err.message}).`);
    }
  }
  if (needAppearances) form.acroForm.dict.set(PDFName.of('NeedAppearances'), PDFBool.True);
}

/** A field's widgets, each with the reference it is stored under. */
function widgetsOf(doc, field) {
  const kids = field.acroField.Kids();
  return field.acroField.getWidgets().map((widget) => {
    let ref = field.ref;
    for (let i = 0; kids && i < kids.size(); i++) {
      if (doc.context.lookup(kids.get(i)) === widget.dict) ref = kids.get(i);
    }
    return { ref, widget };
  });
}

/** The widget whose rectangle is (within 2 points) the one given, or null. */
function closestWidget(widgets, [x1, y1, x2, y2]) {
  let best = null;
  let bestDistance = 2;
  for (const entry of widgets) {
    const r = entry.widget.getRectangle();
    const distance = Math.max(Math.abs(r.x - x1), Math.abs(r.y - y1), Math.abs(r.x + r.width - x2), Math.abs(r.y + r.height - y2));
    if (distance <= bestDistance) {
      best = entry;
      bestDistance = distance;
    }
  }
  return best;
}

/** Takes one widget (a radio button of a group, say) out of its field and off its page. */
function removeWidget(doc, field, ref) {
  const kids = field.acroField.Kids();
  const index = kids?.indexOf(ref);
  if (index === undefined || index < 0) return;
  // A radio group's /Opt holds the export value of each widget by position: the entry goes with it.
  const opt = field.acroField.dict.lookup(doc.context.obj('Opt'));
  if (opt?.size?.() === kids.size()) opt.remove(index);
  field.acroField.removeWidget(index);
  for (const page of doc.getPages()) page.node.removeAnnot(ref);
  doc.context.delete(ref);
}
