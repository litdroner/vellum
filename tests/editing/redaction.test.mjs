// True redaction (editing/objects/redaction.js): text and pictures in an area are taken out of the saved
// file, not covered. Every check reads the SAVED bytes back — pdf.js's text, and every stream in the file
// decoded — so a box painted over content still in the file fails here.
// Run: node --test "tests/editing/redaction.test.mjs"

import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { analyzeFile, engine, loadPdfLib, openWithPdfjs, webModule } from './harness.mjs';
import { makeFixtures, FIXTURE_DIR } from './fixtures.mjs';

const { EditError, planTextEdit } = await engine('edits.js');
const { planRedaction } = await engine('objects/redaction.js');
const { composeDocument } = await webModule('annotations/persist.js');
const { identityPlan } = await webModule('pages/plan.js');

let files;
before(async () => { files = await makeFixtures(FIXTURE_DIR); });

async function open(name) {
  const bytes = new Uint8Array(fs.readFileSync(files[name]));
  const result = await analyzeFile(bytes);
  return { bytes, result, plan: identityPlan(result.source.pageCount) };
}

const save = (d, edits) => composeDocument({ base: d.bytes, plan: d.plan, edits });
const redact = (d, rects, page = 0) => planRedaction({ entry: d.plan[page].id, rects });

/** The page's text as pdf.js extracts it from the saved file, with each item's x. */
async function textOf(bytes, page = 1) {
  const js = await openWithPdfjs(bytes);
  try {
    const { items } = await (await js.doc.getPage(page)).getTextContent();
    return items.map((i) => ({ str: i.str, x: i.transform[4], y: i.transform[5] }));
  } finally {
    await js.close();
  }
}

/** Every stream in the saved file, decoded, as latin1 — and whether any is an image. */
async function streamsOf(bytes) {
  const lib = await loadPdfLib();
  const doc = await lib.PDFDocument.load(bytes, { updateMetadata: false });
  const out = { text: '', images: 0 };
  for (const [, obj] of doc.context.enumerateIndirectObjects()) {
    if (!(obj instanceof lib.PDFRawStream)) continue;
    if (obj.dict.lookup(lib.PDFName.of('Subtype'))?.asString?.() === '/Image') out.images++;
    out.text += Buffer.from(lib.decodePDFRawStream(obj).decode()).toString('latin1');
  }
  return out;
}

const hex = (s) => Buffer.from(s, 'latin1').toString('hex');
const absent = (all, word) => !all.text.includes(word) && !all.text.toLowerCase().includes(hex(word));

test('a redacted line is gone from the saved file; the other lines stay where they were', async () => {
  const d = await open('simple');
  const bytes = await save(d, [redact(d, [[60, 690, 400, 730]])]);
  const text = await textOf(bytes);
  assert.ok(!text.some((t) => /Hello|world/.test(t.str)), JSON.stringify(text));
  const before = await textOf(d.bytes);
  for (const line of ['Third line.']) {
    const a = before.find((t) => t.str === line);
    const b = text.find((t) => t.str === line);
    assert.ok(a && b && Math.abs(a.x - b.x) < 1e-3 && Math.abs(a.y - b.y) < 1e-3, line);
  }
  assert.ok(text.some((t) => t.str.includes('A second line')));
  const all = await streamsOf(bytes);
  assert.ok(absent(all, 'Hello') && absent(all, 'world'), 'no stream in the file still holds the words');
  assert.match(all.text, /0 g 60 690 340 40 re f/, 'the area is painted');
});

test('part of a line: only the glyphs in the area go, the rest keeps its place', async () => {
  const d = await open('simple');
  const before = await textOf(d.bytes);
  const hello = before.find((t) => t.str.startsWith('Hello'));
  const bytes = await save(d, [redact(d, [[140, 690, 400, 730]])]); // "world" at 24pt starts past x=140
  const text = await textOf(bytes);
  const joined = text.map((t) => t.str).join('|');
  assert.ok(joined.includes('Hello,') && !joined.includes('world'), joined);
  assert.ok(Math.abs(text.find((t) => t.str.startsWith('Hello')).x - hello.x) < 1e-3);
  assert.ok(absent(await streamsOf(bytes), 'world'));
});

test('a picture in the area is removed with its image data; one drawn elsewhere stays', async () => {
  const d = await open('images');
  const one = await save(d, [redact(d, [[100, 520, 120, 540]])]); // inside the first draw of Im1 only
  const oneStreams = await streamsOf(one);
  assert.equal(oneStreams.images, 1, 'Im1 is still drawn at the second place');
  assert.equal((oneStreams.text.match(/\/Im1 Do/g) ?? []).length, 1);
  const both = await save(d, [redact(d, [[100, 520, 120, 540], [420, 620, 440, 640]])]);
  const bothStreams = await streamsOf(both);
  assert.equal(bothStreams.images, 0, 'no image data is left in the file');
  assert.ok(!bothStreams.text.includes('/Im1 Do'));
  assert.ok((await textOf(both)).some((t) => t.str === 'Caption under the picture'), 'text outside the areas stays');
});

test('text edited into an area is redacted too', async () => {
  const d = await open('simple');
  const run = d.result.pages[0].runs.find((r) => r.text === 'Third line.');
  const edit = planTextEdit({ run, text: 'Secret words', entry: d.plan[0].id, glyphs: d.result.source.glyphs });
  const control = await save(d, [edit]);
  assert.ok(!absent(await streamsOf(control), 'Secret') && (await textOf(control)).some((t) => t.str.includes('Secret')), 'the checks see the words when they are there');
  const bytes = await save(d, [edit, redact(d, [[60, 630, 400, 655]])]);
  assert.ok(!(await textOf(bytes)).some((t) => /Secret|Third/.test(t.str)));
  const all = await streamsOf(bytes);
  assert.ok(absent(all, 'Secret') && absent(all, 'Third'), 'neither the new nor the old text is in the file');
  assert.ok((await textOf(bytes)).some((t) => t.str.startsWith('Hello')));
});

test('content it can’t prove it removes refuses the save: a form in the area', async () => {
  const d = await open('objects');
  await assert.rejects(save(d, [redact(d, [[410, 110, 420, 120]])]), (err) => err instanceof EditError && err.kind === 'redact');
  assert.throws(() => planRedaction({ entry: d.plan[0].id, rects: [[1, 1, 1, 5]] }), EditError);
});
