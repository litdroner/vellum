// Page-level settings a plan entry can carry (see pages/plan.js), written onto arranged pages by
// annotations/persist.js while composing a document:
//
//   crop        { top, right, bottom, left }  points trimmed from the page's own visible box, as the
//               page is stored (unrotated). Written as the page's /CropBox: nothing is removed or
//               rasterized, so the page's content stays whole in the file.
//   pageNumber  { format, position, size, start, style, restart }  real text drawn in the visible box;
//               `format` holds {n} (this page's number) and {total}, and any words around them — that is
//               where a prefix or suffix goes. `style` writes the numbers as arabic (1, 2, 3) or roman
//               (i, ii, iii / I, II, III). The number follows the page's place in the plan; with
//               `restart` it counts from the first page of its own run instead of the first of the
//               document, so a front matter or a chapter can be numbered from one.
//   watermark   { text, position, size, opacity, rotation }  real text, drawn over the page content; or
//               { picture, position, scale, opacity, rotation }  a PNG or JPEG image, `picture` being
//               { source, format, width, height } as editing/objects/image.js readPicture() describes it
//               (its bytes in the document's sources) and `scale` its width in % of the shown page's.
//               The image is embedded once however many pages carry it, its own transparency with it.
//
// Text stamps are Helvetica (a standard PDF font, so every reader shows them), drawn upright as the page
// is displayed, inside /Artifact marked content so readers and screen readers treat them as page
// decoration. The page's own content is wrapped in q … Q first, so nothing it leaves set changes them.

export const PAGE_NUMBER_POSITIONS = ['bottom-center', 'bottom-right', 'bottom-left', 'top-center', 'top-right', 'top-left'];

/** How the numbers are written. 'ROMAN' is the same numeral in capitals. */
export const PAGE_NUMBER_STYLES = ['arabic', 'roman', 'ROMAN'];
import { embedPictures } from '../editing/objects/image.js';

export const WATERMARK_POSITIONS = ['center', 'top', 'bottom'];

const EDGE = 28; // points between a page number and the page edge

let measuring = null;
/** Characters a stamp can't show (Helvetica's WinAnsi set), or '' when every one can be written. */
export async function unsupportedCharacters(lib, text) {
  measuring ??= lib.PDFDocument.create().then((d) => d.embedFont(lib.StandardFonts.Helvetica));
  const font = await measuring;
  const bad = new Set();
  for (const ch of text) {
    try {
      if (ch.codePointAt(0) < 0x20) throw new Error();
      font.encodeText(ch);
    } catch { bad.add(ch); }
  }
  return [...bad].join('');
}

const ROMAN = [[1000, 'm'], [900, 'cm'], [500, 'd'], [400, 'cd'], [100, 'c'], [90, 'xc'], [50, 'l'], [40, 'xl'], [10, 'x'], [9, 'ix'], [5, 'v'], [4, 'iv'], [1, 'i']];

/** A roman numeral in lower case. Outside 1–3999 there is none, so the plain number is used. */
export function romanNumeral(value) {
  if (!Number.isInteger(value) || value < 1 || value > 3999) return String(value);
  let out = '';
  let left = value;
  for (const [step, letters] of ROMAN) while (left >= step) { out += letters; left -= step; }
  return out;
}

const numeral = (value, style) => (style === 'roman' ? romanNumeral(value)
  : style === 'ROMAN' ? romanNumeral(value).toUpperCase()
    : String(value));

/** The text of a page number for page `n` of `total`, in the style asked for. */
export function pageNumberText({ format = '{n}', start = 1, style = 'arabic' }, n, total) {
  return format
    .replaceAll('{n}', numeral(n + start - 1, style))
    .replaceAll('{total}', numeral(total + start - 1, style));
}

/** The fields that make two pages part of one numbering run (everything but where the text sits). */
const runKey = (s) => (s ? JSON.stringify([s.format, s.start, s.style, s.size, s.position]) : null);

/**
 * What each page's number counts from: { n, total } per plan entry, or null for a page with no number.
 * A page numbered from the document counts its place in the whole plan. A page whose numbering restarts
 * counts inside its run — the pages next to it, in an unbroken line, numbered in exactly the same way —
 * so two separate stretches numbered alike each begin again.
 */
export function numberingRuns(plan) {
  const out = new Array(plan.length).fill(null);
  let i = 0;
  while (i < plan.length) {
    const setting = plan[i].pageNumber;
    if (!setting) { i++; continue; }
    if (!setting.restart) { out[i] = { n: i + 1, total: plan.length }; i++; continue; }
    const key = runKey(setting);
    let end = i;
    while (end < plan.length && plan[end].pageNumber?.restart && runKey(plan[end].pageNumber) === key) end++;
    for (let p = i; p < end; p++) out[p] = { n: p - i + 1, total: end - i };
    i = end;
  }
  return out;
}

/** True when an entry has something for writeStamps to do. */
export const hasPageSettings = (e) => Boolean(e.crop || e.pageNumber || e.watermark);

/**
 * Applies crop, page numbers and watermarks. pages[i] shows plan[i]; content edits have already
 * been written. Pages without settings are left alone. `sources` holds picture watermarks' bytes.
 */
export async function writePageSettings({ lib, doc, pages, plan, sources }) {
  const { PDFName, PDFNumber, StandardFonts } = lib;
  const ctx = doc.context;
  let font = null;
  const { embedded } = await embedPictures(lib, doc, plan.map((e, i) => pages[i] && e.watermark?.picture), sources);
  const counts = numberingRuns(plan);
  for (let i = 0; i < plan.length; i++) {
    const e = plan[i];
    const page = pages[i];
    if (!page || !hasPageSettings(e)) continue;
    const media = boxOf(page.node, 'MediaBox', lib) ?? [0, 0, 612, 792];
    let box = boxOf(page.node, 'CropBox', lib) ?? media;
    box = intersect(box, media) ?? media;
    if (e.crop) {
      const { top = 0, right = 0, bottom = 0, left = 0 } = e.crop;
      const cropped = [box[0] + left, box[1] + bottom, box[2] - right, box[3] - top];
      if (cropped[2] - cropped[0] < 1 || cropped[3] - cropped[1] < 1) throw new Error(`The crop leaves nothing of page ${i + 1}.`);
      box = cropped;
      page.node.set(PDFName.of('CropBox'), ctx.obj(box.map((v) => PDFNumber.of(round(v)))));
    }
    const lines = [];
    const picture = e.watermark?.picture;
    if (e.watermark?.text || picture || e.pageNumber) {
      const lettered = Boolean(e.watermark?.text || e.pageNumber);
      if (lettered) font ??= await doc.embedFont(StandardFonts.Helvetica);
      const fontName = lettered ? page.node.newFontDictionary('VlStamp', font.ref) : null;
      const alpha = (opacity) => (opacity < 1 ? [`${page.node.newExtGState('VlStampGS', ctx.obj({ Type: 'ExtGState', ca: opacity, CA: opacity }))} gs`] : []);
      const turn = (rotation, x, y) => {
        const t = (rotation * Math.PI) / 180;
        const [c, s] = [Math.cos(t), Math.sin(t)];
        return `${fmt(c)} ${fmt(s)} ${fmt(-s)} ${fmt(c)} ${fmt(x)} ${fmt(y)} cm`;
      };
      const draw = (text, size, { x, y, anchor = 'center', rotation = 0, opacity = 1, gray = 0 }) => {
        const width = font.widthOfTextAtSize(text, size);
        const cap = font.heightAtSize(size, { descender: false }) * 0.72;
        const dx = anchor === 'left' ? 0 : anchor === 'right' ? -width : -width / 2;
        lines.push('q', ...alpha(opacity), turn(rotation, x, y),
          `${fmt(gray)} g BT ${fontName} ${fmt(size)} Tf ${fmt(dx)} ${fmt(-cap / 2)} Td ${font.encodeText(text).toString()} Tj ET`, 'Q');
      };
      const rotate = ((page.getRotation().angle % 360) + 360) % 360;
      const [w, h] = rotate % 180 ? [box[3] - box[1], box[2] - box[0]] : [box[2] - box[0], box[3] - box[1]];
      lines.push('/Artifact <</Type /Pagination>> BDC', 'q', displayMatrix(box, rotate).map(fmt).join(' ') + ' cm');
      if (e.watermark?.text) {
        const { text, size = 60, opacity = 0.2, rotation = 45, position = 'center' } = e.watermark;
        const y = position === 'top' ? h * 0.8 : position === 'bottom' ? h * 0.2 : h / 2;
        draw(text, size, { x: w / 2, y, rotation, opacity: clamp(opacity, 0, 1), gray: 0.5 });
      }
      if (picture) {
        // The image, `scale`% of the page wide at its own aspect ratio, centred on its point and turned about it.
        const { scale = 50, opacity = 0.3, rotation = 0, position = 'center' } = e.watermark;
        const y = position === 'top' ? h * 0.8 : position === 'bottom' ? h * 0.2 : h / 2;
        const iw = (w * clamp(scale, 1, 400)) / 100;
        const ih = (iw * picture.height) / picture.width;
        const name = page.node.newXObject('VlWatermark', embedded.get(picture.source));
        lines.push('q', ...alpha(clamp(opacity, 0, 1)), turn(rotation, w / 2, y),
          `${fmt(iw)} 0 0 ${fmt(ih)} ${fmt(-iw / 2)} ${fmt(-ih / 2)} cm`, `${name} Do`, 'Q');
      }
      if (e.pageNumber) {
        const { size = 10, position = 'bottom-center' } = e.pageNumber;
        const [edge, side] = position.split('-');
        const y = edge === 'top' ? h - EDGE : EDGE;
        const x = side === 'left' ? EDGE : side === 'right' ? w - EDGE : w / 2;
        const { n, total } = counts[i] ?? { n: i + 1, total: plan.length };
        draw(pageNumberText(e.pageNumber, n, total), size, { x, y, anchor: side });
      }
      lines.push('Q', 'EMC');
    }
    if (!lines.length) continue;
    const start = ctx.register(ctx.stream('q\n'));
    const end = ctx.register(ctx.flateStream(`Q\n${lines.join('\n')}\n`));
    if (!page.node.wrapContentStreams(start, end)) {
      page.node.set(PDFName.of('Contents'), ctx.obj([end]));
    }
  }
}

/** Matrix mapping the displayed page (origin bottom-left, y up, after /Rotate) into user space. */
function displayMatrix([x1, y1, x2, y2], rotate) {
  if (rotate === 90) return [0, 1, -1, 0, x2, y1];
  if (rotate === 180) return [-1, 0, 0, -1, x2, y2];
  if (rotate === 270) return [0, -1, 1, 0, x1, y2];
  return [1, 0, 0, 1, x1, y1];
}

function boxOf(node, key, lib) {
  const value = node.getInheritableAttribute?.(lib.PDFName.of(key)) ?? node.get(lib.PDFName.of(key));
  const arr = value instanceof lib.PDFRef ? node.context.lookup(value) : value;
  if (!(arr instanceof lib.PDFArray) || arr.size() !== 4) return null;
  const n = arr.asArray().map((v) => node.context.lookup(v)?.asNumber?.());
  if (n.some((v) => !Number.isFinite(v))) return null;
  return [Math.min(n[0], n[2]), Math.min(n[1], n[3]), Math.max(n[0], n[2]), Math.max(n[1], n[3])];
}

function intersect(a, b) {
  const r = [Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.min(a[2], b[2]), Math.min(a[3], b[3])];
  return r[2] > r[0] && r[3] > r[1] ? r : null;
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, Number(v) || 0));
const round = (v) => Math.round(v * 1000) / 1000;
const fmt = (v) => String(round(v));
