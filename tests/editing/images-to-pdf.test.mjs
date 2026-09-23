// Images to PDF V1: JPEG and PNG files into one new PDF, one page per image.
//
// There is no engine of its own — pages/images-to-pdf.js builds a page plan of blank pages and one
// inserted-picture record each, and hands them to the writer every other page operation uses
// (annotations/persist.js composeDocument). Pinned here: one page per image in the order given;
// the page's size derived from the image's pixels at 96 DPI; the picture filling it, undistorted;
// a fixed page size fitting the picture centred without enlarging it; a JPEG stored byte for byte;
// the chosen files left exactly as they were; the same inputs giving the same bytes; and a file that
// isn't a picture refused by name before anything is written.
// Run: node --test "tests/editing/images-to-pdf.test.mjs"

import test from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { analyzeFile, engine, loadPdfLib, openWithPdfjs, webModule } from './harness.mjs';

const {
  MINIMUM_INPUTS, IMAGE_DPI, PAGE_SIZES, ImageInputError,
  imagePdfFileName, imagePlan, imagesToPdf, moveInput, pageSizeFor, placementFor, readImages,
} = await webModule('pages/images-to-pdf.js');
const { objectsOf } = await engine('objects/page-objects.js');

const DATE = new Date(Date.UTC(2026, 0, 2, 3, 4, 5));

/** An RGB PNG of `width` × `height` pixels. */
function png(width, height) {
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const out = Buffer.alloc(body.length + 8);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(zlib.crc32(body), body.length + 4);
    return out;
  };
  const rows = Buffer.alloc((1 + width * 3) * height, 90);
  for (let y = 0; y < height; y++) rows[y * (1 + width * 3)] = 0;
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8);
  return new Uint8Array(Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header), chunk('IDAT', zlib.deflateSync(rows)), chunk('IEND', Buffer.alloc(0)),
  ]));
}

/** A 4 × 2 baseline JPEG (the one picture-insert.test.mjs uses). */
const JPEG = new Uint8Array(Buffer.from('/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoHBwYIDAoMDAsKCwsNDhIQDQ4RDgsLEBYQERMUFRUVDA8XGBYUGBIUFRT/2wBDAQMEBAUEBQkFBQkUDQsNFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBT/wAARCAACAAQDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDn/h74l1f/AIRe1/4mt7/4EP6D3ooor+ZMX/Hn6s93If8AkVYb/BH8j//Z', 'base64'));

const input = (name, bytes) => ({ id: name, name, path: `C:\\pictures\\${name}`, bytes });

/** Every page of a PDF: its box, its rotation, and the pictures drawn on it with their placements. */
async function pagesOf(bytes) {
  const js = await openWithPdfjs(bytes);
  let boxes;
  try {
    boxes = [];
    for (let n = 1; n <= js.doc.numPages; n++) {
      const page = await js.doc.getPage(n);
      boxes.push({
        width: Math.round((page.view[2] - page.view[0]) * 100) / 100,
        height: Math.round((page.view[3] - page.view[1]) * 100) / 100,
        rotate: page.rotate,
      });
    }
  } finally {
    await js.close();
  }
  const analysis = await analyzeFile(bytes, { pages: boxes.map((_, i) => i) });
  return boxes.map((box, i) => ({
    ...box,
    pictures: objectsOf(analysis.pages[i]).filter((o) => o.kind === 'image').map((o) => o.record.ctm),
  }));
}

// ---- page geometry -------------------------------------------------------------------------

test('a page is the image’s own pixels at 96 DPI, and the picture fills it', () => {
  assert.equal(IMAGE_DPI, 96);
  assert.deepEqual(pageSizeFor({ width: 1200, height: 800 }), [900, 600]);
  assert.deepEqual(pageSizeFor({ width: 96, height: 96 }), [72, 72]);
  assert.deepEqual(placementFor({ width: 1200, height: 800 }, [900, 600]), [900, 0, 0, 600, 0, 0]);
});

test('a fixed page size turns to the picture and fits it centred, never enlarged past the page', () => {
  assert.deepEqual(PAGE_SIZES.map(([id]) => id), ['image', 'a4', 'letter']);
  assert.deepEqual(pageSizeFor({ width: 800, height: 1200 }, 'a4'), [595.28, 841.89], 'a portrait picture, a portrait page');
  assert.deepEqual(pageSizeFor({ width: 1200, height: 800 }, 'a4'), [841.89, 595.28], 'a landscape picture turns the page');
  assert.deepEqual(pageSizeFor({ width: 1200, height: 800 }, 'letter'), [792, 612]);

  // Fitted to the page's width, centred in what is left of its height.
  const [w, , , h, x, y] = placementFor({ width: 1000, height: 500 }, [792, 612]);
  assert.deepEqual([w, h], [792, 396]);
  assert.deepEqual([x, y], [0, 108]);
  assert.ok(Math.abs(w / h - 1000 / 500) < 1e-6, 'the proportions are the picture’s');
});

// ---- the documents written ------------------------------------------------------------------

test('one image makes one page of its own size, drawing the picture over the whole of it', async () => {
  const bytes = await imagesToPdf([input('shot.png', png(240, 120))], { date: DATE });
  const pages = await pagesOf(bytes);
  assert.equal(pages.length, 1);
  assert.deepEqual([pages[0].width, pages[0].height, pages[0].rotate], [180, 90, 0]);
  assert.deepEqual(pages[0].pictures, [[180, 0, 0, 90, 0, 0]]);
});

test('several images make a page each, in the order they were listed, portrait, landscape and square', async () => {
  const inputs = [
    input('wide.png', png(400, 200)),
    input('tall.png', png(200, 400)),
    input('square.png', png(96, 96)),
  ];
  const pages = await pagesOf(await imagesToPdf(inputs, { date: DATE }));
  assert.deepEqual(pages.map((p) => [p.width, p.height]), [[300, 150], [150, 300], [72, 72]]);
  assert.deepEqual(pages.map((p) => p.pictures), [[[300, 0, 0, 150, 0, 0]], [[150, 0, 0, 300, 0, 0]], [[72, 0, 0, 72, 0, 0]]]);

  // Reordering the list reorders the pages, and nothing else about them changes.
  const moved = await pagesOf(await imagesToPdf(moveInput(inputs, 'square.png', -2), { date: DATE }));
  assert.deepEqual(moved.map((p) => [p.width, p.height]), [[72, 72], [300, 150], [150, 300]]);
});

test('on a fixed page size every page is that size, with the picture fitted and centred', async () => {
  const pages = await pagesOf(await imagesToPdf([
    input('wide.png', png(400, 200)),
    input('tall.png', png(200, 400)),
  ], { size: 'letter', date: DATE }));
  assert.deepEqual(pages.map((p) => [p.width, p.height]), [[792, 612], [612, 792]]);
  assert.deepEqual(pages[0].pictures, [[792, 0, 0, 396, 0, 108]]);
  assert.deepEqual(pages[1].pictures, [[396, 0, 0, 792, 108, 0]]);
});

test('a JPEG is stored byte for byte — nothing is decoded or compressed again', async () => {
  const bytes = await imagesToPdf([input('photo.jpg', JPEG)], { date: DATE });
  const lib = await loadPdfLib();
  const doc = await lib.PDFDocument.load(bytes, { updateMetadata: false });
  const page = doc.getPages()[0];
  const xobjects = page.node.Resources().lookup(lib.PDFName.of('XObject'), lib.PDFDict);
  const [name] = [...xobjects.keys()];
  const stream = doc.context.lookup(xobjects.get(name));
  assert.deepEqual(Buffer.from(stream.getContents()), Buffer.from(JPEG));
  const [first] = await pagesOf(bytes);
  assert.deepEqual([first.width, first.height], [3, 1.5]);
});

test('the chosen files are left exactly as they were, and the same inputs give the same bytes', async () => {
  const picture = png(64, 48);
  const before = Buffer.from(picture);
  const inputs = [input('a.png', picture), input('b.jpg', JPEG)];
  const once = await imagesToPdf(inputs, { date: DATE });
  const twice = await imagesToPdf([input('a.png', picture), input('b.jpg', JPEG)], { date: DATE });
  assert.deepEqual(Buffer.from(picture), before, 'the picture’s own bytes are untouched');
  assert.deepEqual(Buffer.from(once), Buffer.from(twice), 'the same images in the same order give the same file');
  assert.notDeepEqual(
    Buffer.from(once),
    Buffer.from(await imagesToPdf([inputs[1], inputs[0]], { date: DATE })),
    'a different order is a different file',
  );
});

test('the written file reopens as a valid PDF with the pages it was given', async () => {
  const bytes = await imagesToPdf([input('a.png', png(120, 60)), input('b.jpg', JPEG)], { date: DATE });
  assert.equal(Buffer.from(bytes.slice(0, 5)).toString('latin1'), '%PDF-');
  const js = await openWithPdfjs(bytes);
  try {
    assert.equal(js.doc.numPages, 2);
    const first = await js.doc.getPage(1);
    assert.deepEqual([first.view[2], first.view[3]], [90, 45]);
    assert.ok((await first.getOperatorList()).fnArray.length > 0, 'the page draws something');
  } finally {
    await js.close();
  }
});

// ---- what is refused -----------------------------------------------------------------------

test('a file that isn’t a picture is refused by name, before anything is written', async () => {
  assert.equal(MINIMUM_INPUTS, 1);
  await assert.rejects(() => imagesToPdf([]), /at least one JPEG or PNG/);
  const bad = input('notes.txt', new Uint8Array([1, 2, 3, 4, 5]));
  await assert.rejects(() => readImages([bad]), (err) => {
    assert.ok(err instanceof ImageInputError);
    assert.equal(err.fileName, 'notes.txt');
    assert.match(err.message, /“notes\.txt” can’t be put into a PDF\./);
    assert.match(err.message, /PNG or JPEG/);
    return true;
  });
  await assert.rejects(() => imagesToPdf([input('ok.png', png(8, 8)), bad], { date: DATE }), ImageInputError);
});

test('the plan is one blank page and one inserted picture per image, each image’s bytes once', async () => {
  const measured = await readImages([input('a.png', png(40, 20)), input('b.jpg', JPEG)]);
  const { plan, edits, sources } = imagePlan(measured);
  assert.deepEqual(plan.map((e) => [e.src, e.width, e.height, e.rotate]), [['blank', 30, 15, 0], ['blank', 3, 1.5, 0]]);
  assert.deepEqual(edits.map((e) => [e.kind, e.entry, e.picture.format]), [
    ['inserted-image', plan[0].id, 'png'], ['inserted-image', plan[1].id, 'jpeg'],
  ]);
  assert.deepEqual([...sources.keys()], edits.map((e) => e.picture.source));
  assert.equal(sources.get(edits[1].picture.source), JPEG);
});

test('the file offered is the first picture’s name, as a PDF', () => {
  assert.equal(imagePdfFileName('Scan 01.png'), 'Scan 01.pdf');
  assert.equal(imagePdfFileName('photo.jpeg'), 'photo.pdf');
  assert.equal(imagePdfFileName(undefined), 'Images.pdf');
});
