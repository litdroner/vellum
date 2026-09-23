// The files embedded in a PDF (/Names /EmbeddedFiles), read as one list and written back from it.
//
// This is an inspector, not a file manager: it says what the document carries, hands one of those
// files to a place the person chose, and — where the document can be rewritten — lets a file be
// attached or an attachment taken out. It never writes a file anywhere on its own, and it never
// touches the bytes of an attachment it didn't replace.
//
//   [{ id, name, description, mime, size, created, modified, data? }, ...]
//
// `id` is the name the file is filed under in the document, which is what identifies it; `data` is
// set only on a file being attached and not yet saved. The list is held in the edit store beside the
// page plan and the outline (annotations/model.js), so attaching or removing is one Ctrl+Z and
// reaches the file only when the file is saved. Everything here goes through pdf-lib, the library
// that writes the rest of the document — there is no second reader of embedded files.

/** The largest attachment Vellum will take in, in bytes. */
export const MAX_ATTACHMENT_BYTES = 32 * 1024 * 1024;

const name = (lib, value) => lib.PDFName.of(value);

/** The /Names /EmbeddedFiles name tree, flattened to [key, file specification] pairs, in tree order. */
function embeddedFilePairs(lib, doc) {
  const { PDFArray, PDFDict } = lib;
  const ctx = doc.context;
  const names = ctx.lookup(doc.catalog.get(name(lib, 'Names')));
  const tree = names instanceof PDFDict ? ctx.lookup(names.get(name(lib, 'EmbeddedFiles'))) : null;
  if (!(tree instanceof PDFDict)) return [];
  const out = [];
  const seen = new Set();
  const walk = (node, depth) => {
    const dict = ctx.lookup(node);
    if (!(dict instanceof PDFDict) || depth > 32 || seen.has(dict)) return;
    seen.add(dict);
    const pairs = ctx.lookup(dict.get(name(lib, 'Names')));
    if (pairs instanceof PDFArray) {
      const list = pairs.asArray();
      for (let i = 0; i + 1 < list.length; i += 2) {
        const key = ctx.lookup(list[i]);
        const spec = ctx.lookup(list[i + 1]);
        if (typeof key?.decodeText === 'function' && spec instanceof PDFDict) out.push([key.decodeText(), spec, list[i], list[i + 1]]);
      }
    }
    const kids = ctx.lookup(dict.get(name(lib, 'Kids')));
    if (kids instanceof PDFArray) for (const kid of kids.asArray()) walk(kid, depth + 1);
  };
  walk(tree, 0);
  return out;
}

/** The embedded stream of a file specification: /EF /F, or whichever platform entry it has. */
function embeddedStream(lib, doc, spec) {
  const ef = doc.context.lookup(spec.get(name(lib, 'EF')));
  if (!(ef instanceof lib.PDFDict)) return null;
  for (const key of ['UF', 'F', 'Unix', 'Mac', 'DOS']) {
    const stream = doc.context.lookup(ef.get(name(lib, key)));
    if (stream instanceof lib.PDFStream) return stream;
  }
  return null;
}

const text = (value) => (typeof value?.decodeText === 'function' ? value.decodeText() : typeof value?.asString === 'function' ? value.asString() : null);

/** "D:20240102030405+01'00'" as an ISO date, or the string itself when it isn't one Vellum reads. */
function pdfDate(value) {
  const raw = text(value);
  const m = /^D:(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?/.exec(String(raw ?? '').trim());
  if (!m) return raw || null;
  const [, y, mo = '01', d = '01', h = '00', mi = '00', s = '00'] = m;
  const date = new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s)));
  return Number.isNaN(date.getTime()) ? raw : date.toISOString();
}

/**
 * The files embedded in `doc` (a pdf-lib document), in the order the document files them. `size` is
 * the /Params /Size the document states, or the length of the stream when it states none; a file
 * whose stream is missing is still listed, with no size, rather than being hidden.
 */
export function readAttachments(lib, doc) {
  const list = [];
  for (const [key, spec] of embeddedFilePairs(lib, doc)) {
    const stream = embeddedStream(lib, doc, spec);
    const params = stream ? doc.context.lookup(stream.dict.get(name(lib, 'Params'))) : null;
    const stated = params instanceof lib.PDFDict ? doc.context.lookup(params.get(name(lib, 'Size')))?.asNumber?.() : null;
    list.push({
      id: key,
      name: text(spec.get(name(lib, 'UF'))) ?? text(spec.get(name(lib, 'F'))) ?? key,
      description: text(spec.get(name(lib, 'Desc'))) || null,
      mime: stream ? text(stream.dict.get(name(lib, 'Subtype')))?.replace(/#2F/gi, '/') ?? null : null,
      size: Number.isFinite(stated) ? stated : stream?.contents?.length ?? null,
      created: params instanceof lib.PDFDict ? pdfDate(doc.context.lookup(params.get(name(lib, 'CreationDate')))) : null,
      modified: params instanceof lib.PDFDict ? pdfDate(doc.context.lookup(params.get(name(lib, 'ModDate')))) : null,
      missing: !stream,
    });
  }
  return list;
}

/** The files embedded in PDF bytes. Reads only; the bytes are never changed. */
export async function readAttachmentsFrom(lib, bytes) {
  const doc = await lib.PDFDocument.load(bytes, { updateMetadata: false });
  return readAttachments(lib, doc);
}

/**
 * The bytes of one embedded file, decoded, or null when the document has no such attachment. This is
 * the only way an attachment leaves the document, and it hands the bytes back to the caller — it
 * never writes them anywhere.
 */
export async function extractAttachment(lib, bytes, id) {
  const doc = await lib.PDFDocument.load(bytes, { updateMetadata: false });
  const found = embeddedFilePairs(lib, doc).find(([key]) => key === id);
  if (!found) return null;
  const stream = embeddedStream(lib, doc, found[1]);
  if (!stream) return null;
  return stream instanceof lib.PDFRawStream ? lib.decodePDFRawStream(stream).decode() : stream.getContents();
}

/** A name for a file being attached that isn't already filed under one of `taken`. */
export function uniqueAttachmentName(wanted, taken) {
  const clean = String(wanted ?? '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim() || 'Attachment';
  if (!taken.includes(clean)) return clean;
  const dot = clean.lastIndexOf('.');
  const stem = dot > 0 ? clean.slice(0, dot) : clean;
  const extension = dot > 0 ? clean.slice(dot) : '';
  for (let i = 2; ; i++) {
    const candidate = `${stem} (${i})${extension}`;
    if (!taken.includes(candidate)) return candidate;
  }
}

/** The list with one more file in it, ready to be attached when the document is saved. */
export function addAttachment(list, { name: wanted, data, mime = null, description = null }) {
  const id = uniqueAttachmentName(wanted, list.map((a) => a.id));
  const now = new Date().toISOString();
  return [...list, { id, name: id, description, mime, size: data.length ?? data.byteLength ?? 0, created: now, modified: now, data }];
}

/** The list without one of its files. */
export const removeAttachment = (list, id) => list.filter((a) => a.id !== id);

/** Takes the named files out of the document's /Names /EmbeddedFiles tree and its /AF array. */
function detachFiles(lib, doc, ids) {
  if (!ids.size) return;
  const { PDFArray, PDFDict } = lib;
  const ctx = doc.context;
  const names = ctx.lookup(doc.catalog.get(name(lib, 'Names')));
  const tree = names instanceof PDFDict ? ctx.lookup(names.get(name(lib, 'EmbeddedFiles'))) : null;
  if (!(tree instanceof PDFDict)) return;
  const kept = [];
  const dropped = new Set();
  for (const [key, , keyRaw, specRaw] of embeddedFilePairs(lib, doc)) {
    if (ids.has(key)) dropped.add(String(specRaw));
    else kept.push(keyRaw, specRaw);
  }
  // The tree becomes one flat node holding what is left; an empty one goes altogether.
  tree.delete(name(lib, 'Kids'));
  tree.delete(name(lib, 'Limits'));
  if (kept.length) tree.set(name(lib, 'Names'), ctx.obj(kept));
  else {
    names.delete(name(lib, 'EmbeddedFiles'));
    if (names.keys().length === 0) doc.catalog.delete(name(lib, 'Names'));
  }
  const af = ctx.lookup(doc.catalog.get(name(lib, 'AF')));
  if (af instanceof PDFArray) {
    const left = af.asArray().filter((ref) => !dropped.has(String(ref)));
    if (left.length) doc.catalog.set(name(lib, 'AF'), ctx.obj(left));
    else doc.catalog.delete(name(lib, 'AF'));
  }
}

/**
 * Writes `list` as the document's attachments: files of the document that are no longer in the list
 * are taken out, and files in it that carry their own bytes (`data`) are embedded. Everything else is
 * left exactly as the document has it — no attachment is re-encoded, renamed or rewritten by being
 * listed here. A null list means "leave the document's attachments alone".
 */
export async function writeAttachments(lib, doc, list) {
  if (!list) return;
  const wanted = new Set(list.map((a) => a.id));
  const present = embeddedFilePairs(lib, doc).map(([key]) => key);
  detachFiles(lib, doc, new Set(present.filter((key) => !wanted.has(key))));
  for (const item of list) {
    if (!item.data) continue;
    if (item.data.length > MAX_ATTACHMENT_BYTES) throw new Error(`“${item.name}” is larger than ${Math.round(MAX_ATTACHMENT_BYTES / (1024 * 1024))} MB.`);
    await doc.attach(item.data, item.id, {
      mimeType: item.mime || undefined,
      description: item.description || undefined,
      creationDate: item.created ? new Date(item.created) : undefined,
      modificationDate: item.modified ? new Date(item.modified) : undefined,
    });
  }
}

const UNITS = ['bytes', 'KB', 'MB', 'GB'];

/** A size as it is shown in the inspector. */
export function attachmentSize(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return 'Size not known';
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${unit === 0 ? value : value.toFixed(value < 10 ? 1 : 0)} ${UNITS[unit]}`;
}

// Types a file name plainly says, for an attachment the document doesn't state a type for.
const BY_EXTENSION = {
  pdf: 'application/pdf', txt: 'text/plain', csv: 'text/csv', json: 'application/json', xml: 'application/xml',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', svg: 'image/svg+xml',
  zip: 'application/zip', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

/** The type of an attachment: what the document states, or what its name plainly says. */
export function attachmentType(item) {
  if (item?.mime) return item.mime;
  const extension = /\.([a-z0-9]+)$/i.exec(item?.name ?? '')?.[1]?.toLowerCase();
  return (extension && BY_EXTENSION[extension]) || (extension ? `${extension.toUpperCase()} file` : 'Type not known');
}
