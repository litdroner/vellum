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
  text: { label: 'Text field', width: 160, height: 22, base: 'Text' },
  checkbox: { label: 'Checkbox', width: 14, height: 14, base: 'Check' },
  radio: { label: 'Radio button', width: 14, height: 14, base: 'Choice' },
  dropdown: { label: 'Dropdown', width: 160, height: 22, base: 'Dropdown' },
};

/** Smallest a created field can be resized to, in points. */
export const MIN_FIELD_SIZE = 8;

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
        continue;
      }
      if (form.getFieldMaybe(name)) throw new Error('a field of that name is already in the file');
      if (item.kind === 'text') form.createTextField(name).addToPage(page, options);
      else if (item.kind === 'checkbox') form.createCheckBox(name).addToPage(page, options);
      else if (item.kind === 'dropdown') {
        const field = form.createDropdown(name);
        field.addOptions((item.options ?? []).filter(Boolean));
        field.addToPage(page, options);
      }
    } catch (err) {
      throw new Error(`The new form field “${name}” couldn’t be added (${err.message}).`);
    }
  }
}
