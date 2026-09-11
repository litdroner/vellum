// Test harness for the text-editing engine: loads the app's own pdf.js build and pdf-lib in Node,
// and runs the engine's page analysis plus the pdf.js cross-check over PDF bytes.

import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(here, '..', '..');
export const WEB = path.join(ROOT, 'src', 'Vellum', 'web');
export const VENDOR = path.join(WEB, 'vendor');
export const STANDARD_FONTS = path.join(VENDOR, 'pdfjs', 'standard_fonts');

/** Chromium (WebView2) built-ins that Node 24 doesn't have yet; the app's pdf.js build uses them. */
function polyfill() {
  const U8 = Uint8Array;
  if (!U8.prototype.toHex) U8.prototype.toHex = function toHex() { return Buffer.from(this).toString('hex'); };
  if (!U8.fromHex) U8.fromHex = (s) => new U8(Buffer.from(s, 'hex'));
  if (!U8.prototype.toBase64) U8.prototype.toBase64 = function toBase64() { return Buffer.from(this).toString('base64'); };
  if (!U8.fromBase64) U8.fromBase64 = (s) => new U8(Buffer.from(s, 'base64'));
  for (const M of [Map, WeakMap]) {
    if (!M.prototype.getOrInsertComputed) {
      M.prototype.getOrInsertComputed = function getOrInsertComputed(k, f) { if (!this.has(k)) this.set(k, f(k)); return this.get(k); };
    }
    if (!M.prototype.getOrInsert) {
      M.prototype.getOrInsert = function getOrInsert(k, v) { if (!this.has(k)) this.set(k, v); return this.get(k); };
    }
  }
}

const url = (...parts) => pathToFileURL(path.join(...parts)).href;

let pdfjsPromise = null;
export function loadPdfjs() {
  pdfjsPromise ??= (async () => {
    polyfill();
    const pdfjs = await import(url(VENDOR, 'pdfjs', 'pdf.min.mjs'));
    pdfjs.GlobalWorkerOptions.workerSrc = url(VENDOR, 'pdfjs', 'pdf.worker.min.mjs');
    return pdfjs;
  })();
  return pdfjsPromise;
}

export const loadPdfLib = () => import(url(VENDOR, 'pdf-lib', 'pdf-lib.esm.min.js'));
export const engine = (file) => import(url(WEB, 'js', 'editing', file));
/** Any module of the app's web code, e.g. webModule('annotations/model.js'). */
export const webModule = (file) => import(url(WEB, 'js', ...file.split('/')));

/** A folder as pdf.js's asset factories want it: forward slashes and a trailing slash. */
const folder = (...parts) => `${path.join(...parts).replace(/\\/g, '/')}/`;

/** Opens bytes with pdf.js (a copy: pdf.js takes ownership of what it's given). */
export async function openWithPdfjs(bytes, { password } = {}) {
  const pdfjs = await loadPdfjs();
  const task = pdfjs.getDocument({
    data: bytes.slice(),
    password,
    standardFontDataUrl: folder(STANDARD_FONTS),
    cMapUrl: folder(VENDOR, 'pdfjs', 'cmaps'),
    cMapPacked: true,
    isEvalSupported: false,
    verbosity: 0,
  });
  const doc = await task.promise;
  return { pdfjs, doc, close: () => task.destroy() };
}

/** pdf.js's reading of one page, in the form verifyPage() takes. */
export async function pdfjsPageData(js, pageNumber) {
  const page = await js.doc.getPage(pageNumber);
  const [operatorList, textContent] = await Promise.all([
    page.getOperatorList({ annotationMode: js.pdfjs.AnnotationMode.DISABLE }),
    page.getTextContent(),
  ]);
  return { operatorList, textContent, OPS: js.pdfjs.OPS };
}

/** Analyzes and verifies every page (or the listed 0-based pages) of a PDF. */
export async function analyzeFile(bytes, { pages } = {}) {
  const lib = await loadPdfLib();
  const { openSource } = await engine('source.js');
  const { analyzePage, verifyPage } = await engine('runs.js');
  const source = await openSource(lib, bytes);
  const js = await openWithPdfjs(bytes);
  const results = [];
  const timing = { analyze: 0, pdfjs: 0, verify: 0 };
  try {
    const list = pages ?? Array.from({ length: source.pageCount }, (_, i) => i);
    for (const i of list) {
      let t = performance.now();
      const analysis = analyzePage(source.page(i));
      timing.analyze += performance.now() - t;
      t = performance.now();
      const data = await pdfjsPageData(js, i + 1);
      timing.pdfjs += performance.now() - t;
      t = performance.now();
      verifyPage(analysis, data);
      timing.verify += performance.now() - t;
      results.push(analysis);
    }
  } finally {
    await js.close();
  }
  return { source, pages: results, timing };
}

/** Plain summary of a page's runs, for assertions and reports. */
export function describeRuns(analysis) {
  return analysis.runs.map((r) => ({
    text: r.text,
    editable: r.editable,
    reasons: [...r.reasons],
    font: r.font?.name ?? null,
    size: Math.round(r.frame.size * 100) / 100,
    origin: r.origin.map((v) => Math.round(v * 100) / 100),
  }));
}
