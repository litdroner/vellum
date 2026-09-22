// Crop, page numbers and watermarks: page settings carried by plan entries (pages/stamps.js),
// written by composeDocument and read back from scratch with pdf-lib and pdf.js. The page's own
// content must come through whole (nothing rasterized, nothing removed), the stamps must be real text
// placed upright as the page is shown, and the settings must follow the page plan and undo.
// Run: node --test "tests/editing/*.test.mjs"

import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import zlib from 'node:zlib';
import { engine, loadPdfLib, openWithPdfjs, webModule } from './harness.mjs';
import { makeFixtures, FIXTURE_DIR } from './fixtures.mjs';

const { composeDocument } = await webModule('annotations/persist.js');
const { AnnotationStore } = await webModule('annotations/model.js');
const { identityPlan, isIdentity, setPageSetting, moveEntries, duplicateEntries } = await webModule('pages/plan.js');
const { pageNumberText, unsupportedCharacters } = await webModule('pages/stamps.js');
const { openSource } = await engine('source.js');
const { readPicture } = await engine('objects/image.js');

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

// ---- picture watermarks ---------------------------------------------------------------------------

/** A PNG of `width` × `height` pixels, RGBA (half transparent) when `alpha`, else RGB. */
function png(width, height, alpha = false) {
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const out = Buffer.alloc(body.length + 8);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(zlib.crc32(body), body.length + 4);
    return out;
  };
  const px = alpha ? 4 : 3;
  const rows = Buffer.alloc((1 + width * px) * height, alpha ? 128 : 90);
  for (let y = 0; y < height; y++) rows[y * (1 + width * px)] = 0;
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, alpha ? 6 : 2, 0, 0, 0], 8);
  return new Uint8Array(Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header), chunk('IDAT', zlib.deflateSync(rows)), chunk('IEND', Buffer.alloc(0)),
  ]));
}

/** A 4 × 2 baseline JPEG (the one picture-replace.test.mjs uses). */
const JPEG = new Uint8Array(Buffer.from('/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoHBwYIDAoMDAsKCwsNDhIQDQ4RDgsLEBYQERMUFRUVDA8XGBYUGBIUFRT/2wBDAQMEBAUEBQkFBQkUDQsNFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBT/wAARCAACAAQDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDn/h74l1f/AIRe1/4mt7/4EP6D3ooor+ZMX/Hn6s93If8AkVYb/BH8j//Z', 'base64'));

/** A picture watermark setting for `bytes`, registered in `sources` under `source`. */
async function pictureMark(sources, source, bytes, settings = {}) {
  const picture = { source, ...(await readPicture(await loadPdfLib(), bytes)) };
  sources.set(source, bytes);
  return { picture, position: 'center', scale: 50, opacity: 0.3, rotation: 0, ...settings };
}

/** Each page's content (latin1) and its image XObjects ({ name, ref, stream }). */
async function imagesOf(bytes) {
  const lib = await loadPdfLib();
  const doc = await lib.PDFDocument.load(bytes, { updateMetadata: false });
  const source = await openSource(lib, bytes);
  return doc.getPages().map((page) => {
    const content = Buffer.from(source.contentBytes(page.node)).toString('latin1');
    const xobjects = page.node.Resources()?.lookup(lib.PDFName.of('XObject'));
    const images = xobjects ? xobjects.entries().map(([name, ref]) => ({ name: name.decodeText(), ref, stream: doc.context.lookup(ref) })) : [];
    return { content, images, lib, doc };
  });
}

test('picture watermark: a PNG, its transparency kept, placed by position, width, opacity and rotation', async () => {
  const sources = new Map();
  const bytes = read('simple');
  let plan = identityPlan(1);
  plan = setPageSetting(plan, new Set([plan[0].id]), 'watermark', await pictureMark(sources, 'p1', png(40, 20, true), { position: 'top', scale: 50, opacity: 0.35, rotation: 30 }));
  const out = await composeDocument({ base: bytes, plan, sources });
  const [{ content, images, lib, doc }] = await imagesOf(out);
  assert.equal(images.length, 1, 'one image, and nothing rasterized');
  const [image] = images;
  assert.equal(image.stream.dict.get(lib.PDFName.of('Subtype')).decodeText(), 'Image');
  assert.ok(image.stream.dict.get(lib.PDFName.of('SMask')), 'the PNG’s alpha is its soft mask');
  // Drawn at the top point of the shown page, turned 30°, half the page wide at the image's aspect ratio.
  const [, , w, h] = doc.getPage(0).node.MediaBox().asArray().map((v) => v.asNumber());
  const turn = `0.866 0.5 -0.5 0.866 ${w / 2} ${h * 0.8} cm`;
  const size = `${w / 2} 0 0 ${w / 4} ${-w / 4} ${-w / 8} cm`;
  assert.ok(content.includes(`${turn}\n${size}\n/${image.name} Do`), content.slice(-400));
  const states = doc.getPage(0).node.Resources().lookup(lib.PDFName.of('ExtGState'));
  assert.ok(states.values().some((v) => doc.context.lookup(v).get(lib.PDFName.of('ca'))?.asNumber() === 0.35), 'opacity written');
  const [page] = await pagesOf(out);
  assert.ok(find(page, 'Hello, world'), 'page text kept');
});

test('picture watermark: a JPEG goes in as it is, once for every page that carries it', async () => {
  const sources = new Map();
  let plan = identityPlan(5);
  plan = setPageSetting(plan, new Set(plan.map((e) => e.id)), 'watermark', await pictureMark(sources, 'j1', JPEG));
  const pages = await imagesOf(await composeDocument({ base: read('multipage'), plan, sources }));
  const refs = new Set(pages.map((p) => p.images.find((i) => i.name.startsWith('VlWatermark')).ref.toString()));
  assert.equal(refs.size, 1, 'embedded once');
  const { stream } = pages[0].images.find((i) => i.name.startsWith('VlWatermark'));
  assert.equal(stream.dict.get(pages[0].lib.PDFName.of('Filter')).asString(), '/DCTDecode');
  assert.deepEqual(Buffer.from(stream.getContents()), Buffer.from(JPEG), 'byte for byte');
  assert.ok(pages.every((p) => p.content.includes(`/${p.images.find((i) => i.name.startsWith('VlWatermark')).name} Do`)));
});

test('picture watermark follows duplicates and moves, undo and redo, and is removed', async () => {
  const sources = new Map();
  const store = new AnnotationStore();
  store.initPlan(identityPlan(5));
  const first = store.plan[0].id;
  store.applyPlan(setPageSetting(store.plan, new Set([first]), 'watermark', await pictureMark(sources, 'p1', png(8, 8))));
  store.applyPlan(duplicateEntries(store.plan, new Set([first])).plan);
  store.applyPlan(moveEntries(store.plan, new Set([first]), 6));
  const marked = async () => (await imagesOf(await composeDocument({ base: read('multipage'), plan: store.plan, sources })))
    .map((p) => p.images.some((i) => i.name.startsWith('VlWatermark')));
  assert.deepEqual(await marked(), [true, false, false, false, false, true], 'the copy stays first, the original moved last');
  store.undo();
  store.undo();
  store.undo();
  assert.equal(isIdentity(store.plan, 5), true);
  store.redo();
  assert.equal(store.plan[0].watermark.picture.source, 'p1');
  store.applyPlan(setPageSetting(store.plan, new Set([first]), 'watermark', null));
  assert.deepEqual(await marked(), [false, false, false, false, false]);
});

test('picture watermark: saved and reopened it stays; a text watermark on other pages is unchanged; bad files are refused', async () => {
  const sources = new Map();
  let plan = identityPlan(2);
  plan = setPageSetting(plan, new Set([plan[0].id]), 'watermark', await pictureMark(sources, 'p1', png(10, 10, true)));
  plan = setPageSetting(plan, new Set([plan[1].id]), 'watermark', { text: 'DRAFT', position: 'center', size: 60, opacity: 0.2, rotation: 45 });
  const saved = await composeDocument({ base: read('multipage'), plan: [...plan, ...identityPlan(5).slice(2)], sources });
  const again = await composeDocument({ base: saved, plan: identityPlan(5) });
  const pages = await imagesOf(again);
  assert.ok(pages[0].images.some((i) => i.name.startsWith('VlWatermark')), 'picture kept after reopening');
  assert.equal(pages[1].images.length, 0, 'the text watermark page has no image');
  assert.ok(find((await pagesOf(again))[1], 'DRAFT'), 'text watermark kept');
  // A picture whose bytes are gone refuses the save, rather than dropping the watermark silently.
  await assert.rejects(composeDocument({ base: read('multipage'), plan, sources: new Map() }), /isn’t available/);
  const lib = await loadPdfLib();
  await assert.rejects(readPicture(lib, new Uint8Array([1, 2, 3, 4])), /PNG or JPEG/);
  const broken = png(10, 10).slice(0, 40);
  await assert.rejects(readPicture(lib, broken), /couldn’t be read/);
});
