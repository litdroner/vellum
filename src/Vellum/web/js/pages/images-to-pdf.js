// Images to PDF V1 — JPEG and PNG files chosen from disk into one new PDF, one page per image.
//
// There is no new PDF writer here, and nothing is rasterized. Each image becomes a blank page of the
// size it asks for (a page plan entry, pages/plan.js) with the picture put on it as an inserted
// picture (editing/objects/inserted-image.js) — the same record the editor writes when a picture is
// placed on a page — and the whole thing is handed to composeDocument (annotations/persist.js), the
// writer every other page operation already uses. So each image's own bytes are embedded once,
// undecoded for a JPEG, and the file that comes out is written the way every other Vellum file is.
//
// Page size. "Image size" gives each page the picture's own proportions: its pixels at IMAGE_DPI
// (96, the density Vellum already treats an image's natural size at, see objects/inserted-image.js),
// so a 1200 × 800 photograph becomes a 900 × 600 pt page the picture fills exactly. A fixed size
// (A4, Letter) turns to match the picture and fits it inside, centred, keeping its proportions and
// never enlarging it past the page.
//
// The chosen files are only read. The same images, in the same order, with the same page size and
// the same date give the same bytes.

import { newId } from '../annotations/model.js';
import { composeDocument, loadPdfLib } from '../annotations/persist.js';
import { readPicture } from '../editing/objects/image.js';
import { planInsertion } from '../editing/objects/inserted-image.js';
import { moveInput, removeInput, withoutDuplicates } from './merge.js';

// The list is the merge list's: reordered, dropped and de-duplicated in exactly the same way.
export { moveInput, removeInput, withoutDuplicates };

/** An image to PDF needs at least this many pictures. */
export const MINIMUM_INPUTS = 1;

/** The density an image's pixels are laid out at — the one a picture placed on a page already uses. */
export const IMAGE_DPI = 96;

/** Page sizes to choose from: the image's own, or a fixed one the picture is fitted into. */
export const PAGE_SIZES = [
  ['image', 'Image size'],
  ['a4', 'A4'],
  ['letter', 'Letter'],
];

/** Fixed page sizes in points, portrait; a landscape picture turns them. */
const FIXED = { a4: [595.28, 841.89], letter: [612, 792] };

/** One picture couldn't be used (not a PNG or JPEG, damaged); `fileName` is the file it came from. */
export class ImageInputError extends Error {
  constructor(name, message) {
    super(message);
    this.name = 'ImageInputError';
    this.fileName = name;
  }
}

/** Points, to the hundredth: page sizes and placements are pinned, never left to float. */
const pt = (n) => Math.round(n * 100) / 100;

/** The page an image of these pixels gets under `size`: [width, height] in points. */
export function pageSizeFor({ width, height }, size = 'image') {
  const fixed = FIXED[size];
  if (!fixed) return [pt((width * 72) / IMAGE_DPI), pt((height * 72) / IMAGE_DPI)];
  // The page turns to match the picture, so a landscape photograph isn't fitted into a portrait page.
  return width > height ? [fixed[1], fixed[0]] : [fixed[0], fixed[1]];
}

/**
 * Where the picture goes on that page: the transform from its unit square into the page's user
 * space. On a page of its own size it fills the page exactly; inside a fixed page it is centred,
 * keeps its proportions and is never enlarged past the page.
 */
export function placementFor({ width, height }, [pageWidth, pageHeight]) {
  const factor = Math.min(pageWidth / width, pageHeight / height);
  const w = pt(width * factor);
  const h = pt(height * factor);
  return [w, 0, 0, h, pt((pageWidth - w) / 2), pt((pageHeight - h) / 2)];
}

/**
 * Measures the chosen pictures, refusing one Vellum can't put into a page by name.
 * `inputs` is [{ id, name, bytes }]; the answer is the same list with `format`, `width` and `height`.
 */
export async function readImages(inputs) {
  const lib = await loadPdfLib();
  const measured = [];
  for (const input of inputs) {
    try {
      measured.push({ ...input, ...(await readPicture(lib, input.bytes)) });
    } catch (err) {
      throw new ImageInputError(input.name, `“${input.name}” can’t be put into a PDF. ${err.message}`);
    }
  }
  return measured;
}

/**
 * The page plan and the records that draw the pictures on it, for measured images under `size`.
 * One page per image, in the order given; each picture's bytes go into `sources` under its own id.
 */
export function imagePlan(measured, size = 'image') {
  const plan = [];
  const edits = [];
  const sources = new Map();
  measured.forEach((image, i) => {
    const [width, height] = pageSizeFor(image, size);
    const entry = { id: newId(), src: 'blank', width, height, rotate: 0 };
    const source = `img${i}`;
    sources.set(source, image.bytes);
    plan.push(entry);
    edits.push(planInsertion({
      picture: { source, format: image.format, width: image.width, height: image.height },
      transform: placementFor(image, [width, height]),
      entry: entry.id,
    }));
  });
  return { plan, edits, sources };
}

/**
 * The document the pages are composed onto: one throwaway page, dropped by the plan (which names
 * only blank pages) and swept up with it, so nothing of it reaches the file but its metadata.
 */
async function seedDocument(lib, date) {
  const doc = await lib.PDFDocument.create();
  doc.addPage([1, 1]);
  doc.setProducer('Vellum');
  doc.setCreator('Vellum');
  doc.setCreationDate(date);
  doc.setModificationDate(date);
  return doc.save({ useObjectStreams: false });
}

/**
 * Writes `inputs` — [{ id, name, bytes }] in the order they should appear — as one PDF's bytes, one
 * page per image. `size` is a PAGE_SIZES key; `date` is the document's creation date, and the same
 * inputs with the same size and date give the same file. The inputs' own bytes are never written to.
 */
export async function imagesToPdf(inputs, { size = 'image', date = new Date() } = {}) {
  if (!Array.isArray(inputs) || inputs.length < MINIMUM_INPUTS) {
    throw new Error('Choose at least one JPEG or PNG picture.');
  }
  const measured = inputs.every((i) => i.format && i.width && i.height) ? inputs : await readImages(inputs);
  const { plan, edits, sources } = imagePlan(measured, size);
  const lib = await loadPdfLib();
  return composeDocument({ base: await seedDocument(lib, date), plan, edits, sources });
}

/** The name offered for the new file: the first picture's, as a PDF. */
export function imagePdfFileName(firstName) {
  const base = String(firstName ?? 'Images').replace(/\.[^.]+$/, '').trim();
  return `${base || 'Images'}.pdf`;
}
