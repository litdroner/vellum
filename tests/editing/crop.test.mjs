// Crop PDF V1 (pages/crop.js on the page plan's existing `crop` setting, pages/stamps.js). Pinned here:
// that a rectangle drawn on the page and the four margins typed beside it are one and the same crop,
// that the crop a person draws on a page shown sideways trims the sides they see, that the scopes pick
// the pages they name, that an empty or impossible crop is refused before anything is applied, that the
// crop is a real /CropBox inside the page's own box with the page's content and resources left whole,
// that it survives a save and a reopen, and that the file it was read from is unchanged.
// Run: node --test tests/editing/crop.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { loadPdfLib, openWithPdfjs, webModule } from './harness.mjs';

const crop = await webModule('pages/crop.js');
const { identityPlan, setPageSetting } = await webModule('pages/plan.js');
const { composeDocument } = await webModule('annotations/persist.js');

const A4 = { width: 595, height: 842 };

/** A document of `count` pages, each with a line of text near the top and one near the bottom. */
async function pdfOf(count = 3, size = [595, 842], rotate = 0) {
  const { PDFDocument, StandardFonts } = await loadPdfLib();
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let n = 1; n <= count; n++) {
    const page = doc.addPage(size);
    if (rotate) page.setRotation({ type: 'degrees', angle: rotate });
    page.drawText(`Top of page ${n}`, { x: 60, y: size[1] - 60, size: 12, font });
    page.drawText(`Bottom of page ${n}`, { x: 60, y: 40, size: 12, font });
  }
  return doc.save({ useObjectStreams: false });
}

/** The boxes and the text of each page of some PDF bytes, read back with pdf.js. */
async function reopen(bytes) {
  const js = await openWithPdfjs(bytes);
  try {
    const out = [];
    for (let n = 1; n <= js.doc.numPages; n++) {
      const page = await js.doc.getPage(n);
      const text = (await page.getTextContent()).items.map((i) => i.str).join(' ');
      out.push({ view: page.view.map((v) => Math.round(v * 100) / 100), rotate: page.rotate, text });
    }
    return out;
  } finally {
    await js.close();
  }
}

const planOf = (n) => identityPlan(n);

/**
 * What the first page of some bytes is made of, as the file holds it: its own /MediaBox, whether
 * anything was rasterized into it, and its drawing instructions.
 */
async function pageParts(bytes) {
  const lib = await loadPdfLib();
  const doc = await lib.PDFDocument.load(bytes);
  const page = doc.getPage(0);
  const contents = page.node.Contents();
  const streams = contents instanceof lib.PDFArray
    ? contents.asArray().map((ref) => doc.context.lookup(ref))
    : [contents];
  const drawn = streams.map((stream) => {
    const raw = Buffer.from(stream.getContents());
    const text = (() => { try { return zlib.inflateSync(raw).toString('latin1'); } catch { return raw.toString('latin1'); } })();
    // The words a page draws are hex strings; show them as words so a test can read them.
    return text.replace(/<([0-9A-Fa-f]+)>/g, (_, hex) => Buffer.from(hex, 'hex').toString('latin1'));
  }).join('\n');
  const xobjects = page.node.Resources()?.lookup(lib.PDFName.of('XObject'));
  const images = (xobjects?.entries?.() ?? []).some(([, ref]) =>
    String(doc.context.lookup(ref)?.dict?.get(lib.PDFName.of('Subtype'))) === '/Image');
  return { mediaBox: page.getMediaBox(), images, drawn };
}

// ---- the rectangle and the four margins are one crop ------------------------------------------------

test('a rectangle drawn on the page and the margins beside it are the same crop', () => {
  const rect = { x: 50, y: 80, width: 400, height: 600 };
  const margins = crop.marginsFromRect(rect, A4);
  assert.deepEqual(margins, { top: 80, right: 145, bottom: 162, left: 50 });
  // And back again, exactly: one is never a rounding away from the other.
  assert.deepEqual(crop.rectFromMargins(margins, A4), { x: 50, y: 80, width: 400, height: 600 });
});

test('a rectangle is kept inside the page, however far it is dragged', () => {
  assert.deepEqual(crop.marginsFromRect({ x: -40, y: -40, width: 900, height: 900 }, A4), { top: 0, right: 0, bottom: 0, left: 0 });
  const past = crop.marginsFromRect({ x: 500, y: 800, width: 400, height: 400 }, A4);
  assert.deepEqual(past, { top: 800, right: 0, bottom: 0, left: 500 });
  assert.deepEqual(crop.rectFromMargins(past, A4), { x: 500, y: 800, width: 95, height: 42 });
});

test('a crop of nothing is not a crop', () => {
  assert.equal(crop.isCrop({ top: 0, right: 0, bottom: 0, left: 0 }), false);
  assert.equal(crop.isCrop(null), false);
  assert.equal(crop.isCrop({ top: 0, right: 0, bottom: 0.5, left: 0 }), true);
});

// ---- a page shown sideways ---------------------------------------------------------------------------

test('a crop drawn on a page shown sideways trims the sides a person sees', () => {
  const shown = { top: 10, right: 20, bottom: 30, left: 40 };
  // A page turned a quarter clockwise: what a person calls the top is the page's own left.
  assert.deepEqual(crop.ownSides(shown, 1), { top: 20, right: 30, bottom: 40, left: 10 });
  assert.deepEqual(crop.ownSides(shown, 2), { top: 30, right: 40, bottom: 10, left: 20 });
  assert.deepEqual(crop.ownSides(shown, 3), { top: 40, right: 10, bottom: 20, left: 30 });
  assert.deepEqual(crop.ownSides(shown, 0), shown);

  // And reading one back out shows it the way it was drawn, for every turn.
  for (const turns of [0, 1, 2, 3]) assert.deepEqual(crop.shownSides(crop.ownSides(shown, turns), turns), shown);
});

// ---- which pages ---------------------------------------------------------------------------------------

test('the scopes pick the pages they name', () => {
  const plan = planOf(5);
  const ids = (list) => list.map((e) => plan.indexOf(e) + 1);
  const pages = (scope, selected = []) => crop.scopeIds(scope, { plan, selected })
    .map((id) => plan.findIndex((e) => e.id === id) + 1);
  assert.deepEqual(pages('all'), [1, 2, 3, 4, 5]);
  assert.deepEqual(pages('odd'), [1, 3, 5], 'page 1 is odd, as a person numbers pages');
  assert.deepEqual(pages('even'), [2, 4]);
  assert.deepEqual(pages('selected', [plan[3].id, plan[0].id]), [1, 4], 'in the document’s order, not the order they were picked');
  assert.deepEqual(pages('selected'), []);
  assert.equal(ids([]).length, 0);
});

// ---- an invalid or empty crop --------------------------------------------------------------------------

test('a crop that would leave nothing of the page is refused, safely', () => {
  assert.equal(crop.cropProblem({ top: 10, right: 10, bottom: 10, left: 10 }, A4), null);
  assert.match(crop.cropProblem({ top: 0, right: 0, bottom: 841.5, left: 0 }, A4), /leaves nothing/);
  assert.match(crop.cropProblem({ top: 0, right: 595, bottom: 0, left: 0 }, A4), /leaves nothing/);
  assert.match(crop.cropProblem({ top: 500, right: 0, bottom: 500, left: 0 }, A4), /leaves nothing/);
  // A page whose size isn't known is not judged here; the page writer still refuses it.
  assert.equal(crop.cropProblem({ top: 999, right: 0, bottom: 0, left: 0 }, { width: 0, height: 0 }), null);
});

test('the page writer refuses the same crop the dialog would, so neither can be got round', async () => {
  const bytes = await pdfOf(1);
  const plan = planOf(1);
  const bad = setPageSetting(plan, new Set([plan[0].id]), 'crop', { left: 400, right: 400 });
  assert.match(crop.cropProblem({ top: 0, right: 400, bottom: 0, left: 400 }, A4), /leaves nothing/);
  await assert.rejects(composeDocument({ base: bytes, plan: bad }), /crop leaves nothing/);
});

// ---- the crop as it is written -----------------------------------------------------------------------

test('cropping a page sets its crop box inside its own box and keeps its content', async () => {
  const bytes = await pdfOf(1);
  const before = crypto.createHash('sha256').update(bytes).digest('hex');
  const base = planOf(1);
  const plan = setPageSetting(base, new Set([base[0].id]), 'crop',
    crop.ownSides(crop.marginsFromRect({ x: 40, y: 30, width: 500, height: 700 }, A4), 0));
  const out = await composeDocument({ base: bytes, plan });

  const [page] = await reopen(out);
  assert.deepEqual(page.view, [40, 112, 540, 812], 'the crop box the rectangle asked for, inside the page’s own box');
  assert.match(page.text, /Top of page 1/, 'the page still reads');

  // Nothing was deleted or rasterized: the page's own box is untouched and what the crop box now hides
  // is still in the page's own drawing instructions.
  const parts = await pageParts(out);
  assert.deepEqual(parts.mediaBox, { x: 0, y: 0, width: 595, height: 842 }, 'the page’s own box is untouched');
  assert.equal(parts.images, false, 'no picture of the page was put into it');
  assert.match(parts.drawn, /Top of page 1/);
  assert.match(parts.drawn, /Bottom of page 1/, 'the hidden part stays in the file');
  assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), before, 'the file it was read from is unchanged');
});

test('a crop applies to the pages a scope names, and to no others', async () => {
  const bytes = await pdfOf(4);
  const plan = planOf(4);
  const odd = crop.scopeIds('odd', { plan });
  const cropped = setPageSetting(plan, new Set(odd), 'crop', crop.ownSides({ top: 20, right: 10, bottom: 30, left: 15 }, 0));
  const pages = await reopen(await composeDocument({ base: bytes, plan: cropped }));
  assert.deepEqual(pages.map((p) => p.view), [
    [15, 30, 585, 822], [0, 0, 595, 842], [15, 30, 585, 822], [0, 0, 595, 842],
  ], 'pages 1 and 3 are cropped; 2 and 4 are as they were');
  for (const page of pages) assert.match(page.text, /Top of page/, 'every page still holds its own content');
});

test('a crop drawn on a turned page survives being written and read back', async () => {
  const bytes = await pdfOf(1, [595, 842], 90);
  const shown = { top: 20, right: 10, bottom: 30, left: 15 };
  const base = planOf(1);
  const plan = setPageSetting(base, new Set([base[0].id]), 'crop', crop.ownSides(shown, 1));
  const [page] = await reopen(await composeDocument({ base: bytes, plan }));
  assert.equal(page.rotate, 90, 'the page is still turned');
  // Shown sideways, the person's top is the page's own left, so the box is trimmed there.
  assert.deepEqual(page.view, [20, 15, 565, 832]);
});

test('a cropped document saved and opened again keeps its crop', async () => {
  const bytes = await pdfOf(2);
  const margins = crop.marginsFromRect({ x: 50, y: 60, width: 460, height: 700 }, A4);
  const base = planOf(2);
  const once = await composeDocument({ base: bytes, plan: setPageSetting(base, new Set(crop.scopeIds('all', { plan: base })), 'crop', crop.ownSides(margins, 0)) });
  const first = await reopen(once);
  assert.deepEqual(first.map((p) => p.view), [[50, 82, 510, 782], [50, 82, 510, 782]]);

  // Saved again from what was read back: the crop is the file's own now, and it does not creep.
  const again = await composeDocument({ base: once, plan: planOf(2) });
  assert.deepEqual((await reopen(again)).map((p) => p.view), first.map((p) => p.view));
});
