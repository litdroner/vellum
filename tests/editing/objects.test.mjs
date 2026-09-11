// Vellum 0.5.0 Phase 0: the read-only object data page analysis records for later editing phases —
// images, shapes, forms, marked content and layers — plus crop boxes and CMaps. Nothing here edits
// images or shapes. Run: node --test "tests/editing/*.test.mjs"

import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { analyzeFile, describeRuns, engine, loadPdfLib, openWithPdfjs, webModule } from './harness.mjs';
import { makeFixtures, FIXTURE_DIR } from './fixtures.mjs';

const { planTextEdit } = await engine('edits.js');
const { composeDocument } = await webModule('annotations/persist.js');
const { identityPlan } = await webModule('pages/plan.js');

let files;
const cache = new Map();
before(async () => { files = await makeFixtures(FIXTURE_DIR); });
const read = (name) => new Uint8Array(fs.readFileSync(files[name]));
async function analyzed(name) {
  if (!cache.has(name)) cache.set(name, await analyzeFile(read(name)));
  return cache.get(name);
}

const round = (list) => list.map((v) => Math.round(v * 1000) / 1000);
const bytesOf = (bytes, [start, end]) => Buffer.from(bytes.subarray(start, end)).toString('latin1');
const runNamed = (analysis, text) => {
  const run = analysis.runs.find((r) => r.text === text);
  assert.ok(run, `no run ${JSON.stringify(text)}`);
  return run;
};

async function drawnText(bytes, pageNumber) {
  const js = await openWithPdfjs(bytes);
  try {
    const content = await (await js.doc.getPage(pageNumber)).getTextContent();
    return content.items.filter((i) => i.str.trim()).map((i) => ({ str: i.str, x: Math.round(i.transform[4] * 100) / 100, y: Math.round(i.transform[5] * 100) / 100 }));
  } finally {
    await js.close();
  }
}

test('images: operator and bytes, CTM and unit square, clip, transparency, tags, layers, form context', async () => {
  const page = (await analyzed('objects')).pages[0];
  const im = page.images;
  assert.equal(im.length, 12);
  // Page-level images point at exactly their own "Do" operator.
  for (let i = 0; i <= 9; i++) assert.equal(bytesOf(page.bytes, im[i].range), `/${im[i].name} Do`, `image ${i}`);
  assert.ok(im.slice(0, 11).every((i) => i.stream === 'page' && i.form === null));

  assert.deepEqual(round(im[0].ctm), [100, 0, 0, 50, 72, 650]);
  assert.deepEqual(round(im[0].quad), [72, 650, 172, 650, 172, 700, 72, 700]);
  assert.deepEqual(round(im[0].box), [72, 650, 172, 700]);
  assert.deepEqual([im[0].info.width, im[0].info.height, im[0].info.colorSpace, im[0].info.imageMask, im[0].inline], [8, 8, 'DeviceRGB', false, false]);
  assert.deepEqual([im[0].ca, im[0].blend, im[0].softMask, im[0].clip, im[0].oc, im[0].mcid, im[0].artifact], [1, 'Normal', null, null, null, null, false]);

  assert.deepEqual(round(im[1].quad), [300, 650, 300, 710, 260, 710, 260, 650], 'a rotated image keeps its true corners');
  assert.deepEqual(round(im[1].box), [260, 650, 300, 710]);
  assert.equal(im[2].info.imageMask, true, 'stencil mask');
  assert.deepEqual([im[3].info.smask, im[3].ca, im[3].CA], [true, 0.5, 0.5], 'own soft mask, drawn at half opacity');
  assert.deepEqual([im[4].clip.exact, round(im[4].clip.box)], [true, [200, 540, 260, 600]], 'clipped by a rectangle');
  assert.deepEqual([im[5].artifact, im[5].mcid], [true, null], 'artifact');
  assert.deepEqual([im[6].artifact, im[6].mcid], [false, 3], 'tagged figure (MCID from an inline dictionary)');
  assert.deepEqual([im[7].oc.hidden, im[8].oc.hidden, im[9].oc.hidden], [false, true, false], 'visible layer, hidden layer, the image’s own /OC');
  assert.equal(im[7].oc.keys[0], im[9].oc.keys[0], 'the same layer, named by the page and by the image itself');

  const inline = im[10];
  assert.deepEqual([inline.inline, inline.key, inline.info.width, inline.info.height, inline.info.colorSpace, inline.info.bitsPerComponent], [true, null, 2, 1, 'DeviceRGB', 8]);
  const block = bytesOf(page.bytes, inline.range);
  assert.ok(block.startsWith('BI') && block.endsWith('EI'), `the whole inline image: ${JSON.stringify(block)}`);
  assert.deepEqual(round(inline.box), [72, 480, 92, 490]);

  const inForm = im[11];
  assert.ok(inForm.form && inForm.stream === inForm.form, 'drawn by a form: its bytes are in the form’s stream');
  assert.deepEqual(round(inForm.ctm), [50, 0, 0, 50, 400, 100]);
  assert.deepEqual(round(inForm.clip.box), [400, 100, 450, 150], 'clipped to the form’s bounding box');
});

test('forms: where each is drawn, with what matrix, box and bytes', async () => {
  const page = (await analyzed('objects')).pages[0];
  assert.equal(page.forms.length, 1);
  const [form] = page.forms;
  assert.deepEqual([form.name, form.depth, form.stream, form.error], ['Fm1', 1, 'page', null]);
  assert.equal(bytesOf(page.bytes, form.range), '/Fm1 Do');
  assert.deepEqual(round(form.ctm), [1, 0, 0, 1, 400, 100]);
  assert.deepEqual(round(form.box), [400, 100, 450, 150]);
  assert.equal(page.images[11].form, form.key);
});

test('vector shapes: painted paths and shadings with their bounds; clipping paths are not shapes', async () => {
  const page = (await analyzed('objects')).pages[0];
  const fill = page.paths.find((p) => p.paint === 'fill');
  assert.deepEqual([fill.op, round(fill.box)], ['f', [72, 400, 272, 440]]);
  const stroke = page.paths.find((p) => p.paint === 'stroke');
  assert.deepEqual([stroke.op, round(stroke.box), stroke.lineWidth], ['S', [72, 380, 272, 380], 2]);
  const shading = page.paths.find((p) => p.paint === 'shading');
  assert.deepEqual([shading.op, round(shading.box)], ['sh', [300, 370, 500, 400]], 'a shading fills its clip');
  assert.equal(page.paths.length, 3, 'the "re W n" clipping paths are not recorded as shapes');
  assert.ok(page.paths.every((p) => page.bytes && p.stream === 'page'));
});

test('marked content: tagged text, artifacts; text on layers is refused with a reason', async () => {
  const page = (await analyzed('objects')).pages[0];
  const tagged = runNamed(page, 'Tagged paragraph');
  assert.deepEqual([tagged.editable, tagged.tagged, tagged.first.mcid], [true, true, 5], 'MCID from a /Properties resource');
  const artifact = runNamed(page, 'Artifact text');
  assert.deepEqual([artifact.editable, artifact.tagged, artifact.first.artifact], [true, false, true]);
  for (const text of ['Text on a visible layer', 'Text on a hidden layer']) {
    const run = runNamed(page, text);
    assert.equal(run.editable, false, text);
    assert.ok(run.reasons.has('layer'), `${text}: ${[...run.reasons]}`);
  }
  assert.equal(runNamed(page, 'Text on a hidden layer').first.oc.hidden, true);
  assert.equal(runNamed(page, 'Text on a visible layer').first.oc.hidden, false);
  const ordinary = runNamed(page, 'Ordinary text');
  assert.deepEqual([ordinary.editable, ordinary.tagged, ordinary.first.oc], [true, false, null]);
  assert.equal(page.summary.kind, 'text');
});

test('non-zero crop-box origin: text is found, verified and edited in user space', async () => {
  const d = await analyzed('cropbox');
  const page = d.pages[0];
  assert.deepEqual(round(page.box), [100, 100, 500, 692]);
  assert.deepEqual(describeRuns(page).map((r) => [r.text, r.editable, r.origin]),
    [['Inside an offset crop box', true, [120, 600]], ['Near the bottom of the crop', true, [120, 150]]]);
  const plan = identityPlan(1);
  const bytes = read('cropbox');
  const saved = await composeDocument({ base: bytes, plan, edits: [planTextEdit({ run: runNamed(page, 'Inside an offset crop box'), text: 'Still inside the crop box', entry: plan[0].id, glyphs: d.source.glyphs })] });
  const lib = await loadPdfLib();
  const crop = (await lib.PDFDocument.load(saved)).getPage(0).getCropBox();
  assert.deepEqual([crop.x, crop.y, crop.width, crop.height], [100, 100, 400, 592]);
  const drawn = await drawnText(saved, 1);
  assert.ok(drawn.some((i) => i.str === 'Still inside the crop box' && i.x === 120 && i.y === 600), JSON.stringify(drawn));
});

test('CMaps: an embedded one-byte CMap is read and written; a predefined CJK CMap is refused', async () => {
  const d = await analyzed('cmaps');
  const page = d.pages[0];
  const one = runNamed(page, 'One byte codes through an embedded CMap');
  assert.deepEqual([one.editable, [...one.reasons]], [true, []]);
  const cjk = page.runs.find((r) => r !== one);
  assert.equal(cjk.editable, false);
  assert.ok(cjk.reasons.has('encoding'), [...cjk.reasons].join(','));
  const plan = identityPlan(1);
  const record = planTextEdit({ run: one, text: 'One embedded CMap', entry: plan[0].id, glyphs: d.source.glyphs });
  assert.equal(record.encoding.mode, 'font');
  assert.ok(record.encoding.items.every((i) => i.space || i.byteLength === 1), 'one-byte codes');
  const saved = await composeDocument({ base: read('cmaps'), plan, edits: [record] });
  assert.ok((await drawnText(saved, 1)).some((i) => i.str === 'One embedded CMap'));
});
