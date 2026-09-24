// Office → PDF, what the page knows without the host: the formats as the bridge names them, which presence
// names office.providers makes true, and how each outcome of office.toPdf is said. Imports nothing, so it
// loads anywhere (Node included). The rules themselves are the host's (Services/Conversion/).

export const OFFICE_FORMATS = Object.freeze(['word', 'excel', 'powerpoint']);

/** The extensions of each format, as the host takes them (Services/Conversion/OfficeConversion.cs OfficeFormats). */
export const OFFICE_EXTENSIONS = Object.freeze({ word: ['.docx', '.doc'], excel: ['.xlsx', '.xls'], powerpoint: ['.pptx', '.ppt'] });

/** The format a file name is, by its extension: 'word', 'excel', 'powerpoint', or null. */
export function officeFormatOf(name) {
  const dot = String(name ?? '').lastIndexOf('.');
  const extension = dot < 0 ? '' : String(name).slice(dot).toLowerCase();
  return OFFICE_FORMATS.find((f) => OFFICE_EXTENSIONS[f].includes(extension)) ?? null;
}

/** "Word document", "Excel workbook", "PowerPoint presentation": the host's own nouns. */
export const OFFICE_NOUNS = Object.freeze({ word: 'Word document', excel: 'Excel workbook', powerpoint: 'PowerPoint presentation' });

/** The presence name of one format's tool (requirements.js): `engine.office.word`… */
export const presenceName = (format) => `engine.office.${format}`;

/** Present when any format is: batch conversion (batch.officeToPdf), which takes all three. */
export const ANY_OFFICE = 'engine.office';

/**
 * The presence names office.providers makes true. A format is there when an installed provider can convert
 * it, even if that provider is busy right now (PowerPoint open): the tool stays, and says why when it runs.
 * With no provider for it, or a report that can't be read, it isn't there. `engine.office` is there when any
 * format is.
 */
export function presenceFrom(report) {
  const present = {};
  for (const f of Array.isArray(report?.formats) ? report.formats : []) {
    if (OFFICE_FORMATS.includes(f?.format) && (f.status === 'ready' || f.status === 'unavailable')) present[presenceName(f.format)] = true;
  }
  if (Object.keys(present).length) present[ANY_OFFICE] = true;
  return Object.freeze(present);
}

const TITLES = {
  protected: 'Can’t convert a protected document',
  unsupportedFormat: 'Can’t convert this file',
  invalidInput: 'Can’t convert this file',
  noProvider: 'Nothing on this PC can convert it',
  notSupported: 'Nothing on this PC can convert it',
  unavailable: 'Can’t convert right now',
};

/**
 * What to tell the person about one office.toPdf reply's `result`: { kind, title, message, recheck }.
 * kind: 'converted' (a PDF was written), 'cancelled' (said quietly), 'refused' (why, in a dialog). The message
 * is the host's own sentence; recheck: what this PC has may have changed since presence was read.
 */
export function describeOutcome(result) {
  const message = typeof result?.message === 'string' && result.message ? result.message : 'The document couldn’t be converted, so nothing was saved.';
  if (result?.status === 'converted') return { kind: 'converted', title: null, message, recheck: false };
  if (result?.status === 'cancelled') return { kind: 'cancelled', title: null, message, recheck: false };
  return {
    kind: 'refused',
    title: TITLES[result?.status] ?? 'Couldn’t make the PDF',
    message,
    recheck: result?.status === 'noProvider' || result?.status === 'notSupported',
  };
}
