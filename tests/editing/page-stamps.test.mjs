// Crop, page numbers and watermarks: page settings carried by plan entries (pages/stamps.js),
// written by composeDocument and read back from scratch with pdf-lib and pdf.js. The page's own
// content must come through whole (nothing rasterized, nothing removed), the stamps must be real text
// placed upright as the page is shown, and the settings must follow the page plan and undo.
// Run: node --test "tests/editing/*.test.mjs"

import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { loadPdfLib, openWithPdfjs, webModule } from './harness.mjs';
import { makeFixtures, FIXTURE_DIR } from './fixtures.mjs';

const { composeDocument } = await webModule('annotations/persist.js');
const { AnnotationStore } = await webModule('annotations/model.js');
const { identityPlan, isIdentity, setPageSetting, moveEntries, duplicateEntries } = await webModule('pages/plan.js');
const { pageNumberText, unsupportedCharacters } = await webModule('pages/stamps.js');

let files;
before(async () => { files = await makeFixtures(FIXTURE_DIR); });
const read = (name) => new Uint8Array(fs.readFileSync(files[name]));

async function pagesOf(bytes) {
  const js = await openWithPdfjs(bytes);
  try {
    const out = [];
    for (let n = 1; n <= js.doc.numPages; n++) {
      const page = await js.doc.getPage(n);
      const viewport = page.getViewport({ scale: 1 });
      const items = (await page.getTextContent()).items.filter((i) => i.str.trim()).map((i) => {
        // Where the text starts, in displayed page coordinates (origin top-left).
        const [x, y] = viewport.convertToViewportPoint(i.transform[4], i.transform[5]);
        return { str: i.str, x, y, angle: Math.round((Math.atan2(i.transform[1], i.transform[0]) * 180) / Math.PI) };
      });
      out.push({ view: page.view, rotate: page.rotate, width: viewport.width, height: viewport.height, items });
    }
    return out;
  } finally {
    await js.close();
  }
}
const find = (page, str) => page.items.find((i) => i.str === str);

test('crop sets the crop box inside the page’s own box and keeps its content', async () => {
  const bytes = read('cropbox');
  let plan = identityPlan(1);
  plan = setPageSetting(plan, new Set([plan[0].id]), 'crop', { top: 10, right: 20, bottom: 30, left: 10 });
  assert.equal(isIdentity(plan, 1), false);
  const out = await composeDocument({ base: bytes, plan });
  const [page] = await pagesOf(out);
  assert.deepEqual(page.view, [110, 130, 480, 682]);
  assert.ok(find(page, 'Inside an offset crop box') && find(page, 'Near the bottom of the crop'), 'text is still there');
  const lib = await loadPdfLib();
  const doc = await lib.PDFDocument.load(out);
  assert.deepEqual(doc.getPage(0).getMediaBox(), { x: 0, y: 0, width: 612, height: 792 }, 'media box untouched');
  assert.equal(doc.getPage(0).node.Resources().lookup(lib.PDFName.of('XObject')), undefined, 'nothing rasterized');
  // Cropping away everything is refused.
  const all = setPageSetting(identityPlan(1), new Set(), 'crop', null);
  const bad = setPageSetting(all, new Set([all[0].id]), 'crop', { left: 400 });
  await assert.rejects(composeDocument({ base: bytes, plan: bad }), /crop leaves nothing/);
});

test('page numbers are real text, follow the page order, and sit upright on rotated pages', async () => {
  const bytes = read('mixed-sizes');
  let plan = identityPlan(4);
  const settings = { format: 'Page {n} of {total}', position: 'bottom-right', size: 10, start: 1 };
  plan = setPageSetting(plan, new Set(plan.map((e) => e.id)), 'pageNumber', settings);
  plan = moveEntries(plan, new Set([plan[3].id]), 0); // the rotated page first
  const pages = await pagesOf(await composeDocument({ base: bytes, plan }));
  assert.equal(pages.length, 4);
  pages.forEach((p, i) => {
    const label = find(p, `Page ${i + 1} of 4`);
    assert.ok(label, `page ${i + 1} is numbered`);
    assert.ok(label.y > p.height - 40 && label.y < p.height, `page ${i + 1}: near the bottom as shown (${label.y} of ${p.height})`);
    assert.ok(label.x > p.width / 2 && label.x < p.width - 28, `page ${i + 1}: on the right as shown`);
  });
  assert.equal(pages[0].rotate, 90);
  assert.ok(find(pages[0], 'Rotated page'), 'the rotated page’s own text is kept');
  assert.equal(pageNumberText({ format: '{n}', start: 5 }, 2, 3), '6');
});

test('watermark: text, size, opacity and rotation, over the page, after crop', async () => {
  const lib = await loadPdfLib();
  const bytes = read('simple');
  let plan = identityPlan(1);
  const ids = new Set([plan[0].id]);
  plan = setPageSetting(plan, ids, 'crop', { top: 92 });
  plan = setPageSetting(plan, ids, 'watermark', { text: 'DRAFT', position: 'center', size: 72, opacity: 0.25, rotation: 30 });
  const out = await composeDocument({ base: bytes, plan });
  const [page] = await pagesOf(out);
  const mark = find(page, 'DRAFT');
  assert.ok(mark, 'watermark is text');
  assert.equal(mark.angle, 30);
  assert.ok(find(page, 'Hello, world'), 'page text kept');
  // Centred in the cropped (shown) page: the middle of the word is near the middle.
  const doc = await lib.PDFDocument.load(out);
  const font = await (await lib.PDFDocument.create()).embedFont(lib.StandardFonts.Helvetica);
  const w = font.widthOfTextAtSize('DRAFT', 72);
  const cx = mark.x + (w / 2) * Math.cos(Math.PI / 6);
  const cy = mark.y - (w / 2) * Math.sin(Math.PI / 6);
  assert.ok(Math.abs(cx - page.width / 2) < 20 && Math.abs(cy - page.height / 2) < 30, `centred (${cx}, ${cy})`);
  const resources = doc.getPage(0).node.Resources();
  const states = resources.lookup(lib.PDFName.of('ExtGState'));
  const alpha = states.values().map((v) => doc.context.lookup(v).get(lib.PDFName.of('ca'))?.asNumber());
  assert.ok(alpha.includes(0.25), 'opacity written');
});

test('settings follow duplicates and moves, undo and redo, and a second compose does not stack them', async () => {
  const bytes = read('multipage');
  const store = new AnnotationStore();
  store.initPlan(identityPlan(5));
  const first = store.plan[0].id;
  store.applyPlan(setPageSetting(store.plan, new Set([first]), 'watermark', { text: 'COPY' }));
  store.applyPlan(duplicateEntries(store.plan, new Set([first])).plan);
  assert.equal(store.plan[1].watermark.text, 'COPY');
  const pages = await pagesOf(await composeDocument({ base: bytes, plan: store.plan }));
  assert.equal(pages[0].items.filter((i) => i.str === 'COPY').length, 1);
  assert.equal(pages[1].items.filter((i) => i.str === 'COPY').length, 1);
  assert.equal(pages[2].items.filter((i) => i.str === 'COPY').length, 0);
  store.undo();
  store.undo();
  assert.equal(store.plan[0].watermark, undefined);
  assert.equal(isIdentity(store.plan, 5), true);
  store.redo();
  assert.equal(store.plan[0].watermark.text, 'COPY');
  // Removing a setting.
  store.applyPlan(setPageSetting(store.plan, new Set([first]), 'watermark', null));
  assert.equal('watermark' in store.plan[0], false);
});

test('saved stamps reopen as ordinary content; unsupported characters are reported', async () => {
  const bytes = read('simple');
  let plan = identityPlan(1);
  plan = setPageSetting(plan, new Set([plan[0].id]), 'pageNumber', { format: '– {n} –' });
  const saved = await composeDocument({ base: bytes, plan });
  const again = await composeDocument({ base: saved, plan: identityPlan(1) });
  const [page] = await pagesOf(again);
  assert.equal(page.items.filter((i) => i.str === '– 1 –').length, 1);
  const lib = await loadPdfLib();
  assert.equal(await unsupportedCharacters(lib, 'Confidential – café'), '');
  assert.equal(await unsupportedCharacters(lib, 'Draft ₹ 草'), '₹草');
});
