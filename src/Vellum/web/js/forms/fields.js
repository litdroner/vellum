// Filling the PDF's own form fields (AcroForm): text fields, checkboxes, radio buttons, dropdowns
// and list boxes. pdf.js draws the fields as inputs over the page; what is typed or chosen there is
// kept by field name (annotations/model.js setFormValue) and written into the same fields when the
// file is saved — the field's value (/V), a checkbox or radio button's state (/AS), and a new
// appearance so other readers show the value. Fields are never created, removed, flattened or
// rasterized, and no form script is run.

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
