// Semantic document model V1 (semantic/model.js): a read-only adapter over the object model, paragraph
// grouping and pdf.js's annotations. Pinned here: paragraphs and runs as grouping and the analysis have
// them, columns never joined, images, fields, annotations and links kept apart with their boxes, IDs the
// same on every build, and the whole document built through an editing session from a real PDF.
// Run: node --test tests/editing/semantic-model.test.mjs

import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { analyzeFile, openWithPdfjs, webModule, withSession } from './harness.mjs';
import { makeFixtures, FIXTURE_DIR } from './fixtures.mjs';

const { semanticPage, semanticDocument, readSemanticPage, readSemanticDocument } = await webModule('semantic/model.js');
const { objectsOf } = await webModule('editing/objects/page-objects.js');

let files;
before(async () => { files = await makeFixtures(FIXTURE_DIR); });
const read = (name) => new Uint8Array(fs.readFileSync(files[name]));

/** Every page of a fixture as the model, with pdf.js's annotations. */
async function model(name) {
  const bytes = read(name);
  const { pages } = await analyzeFile(bytes);
  const js = await openWithPdfjs(bytes);
  try {
    const list = [];
    for (const analysis of pages) list.push(await readSemanticPage(analysis, await js.doc.getPage(analysis.page + 1)));
    return semanticDocument(list);
  } finally {
    await js.close();
  }
}

const within = (inner, outer) => inner[0] >= outer[0] - 0.01 && inner[1] >= outer[1] - 0.01 && inner[2] <= outer[2] + 0.01 && inner[3] <= outer[3] + 0.01;

test('text: a paragraph is one block of its runs, top line first; other lines are blocks of their own', async () => {
  const doc = await model('paragraphs');
  const page = doc.pages[0];
  const paragraph = page.blocks.find((b) => b.text.startsWith('The first line'));
  assert.equal(paragraph.kind, 'paragraph');
  assert.equal(paragraph.lines, 4);
  assert.deepEqual(paragraph.text.split('\n'), ['The first line of a plain paragraph that', 'runs on to a second line, then a third', 'line, and ends on this fourth one, which', 'is shorter.']);
  for (const id of paragraph.runIds) {
    const run = doc.byId(id);
    assert.equal(run.blockId, paragraph.id);
    assert.ok(within(run.box, paragraph.box), 'every line lies inside its block');
    assert.equal(run.font, 'Helvetica');
    assert.equal(run.size, 11);
  }
  // Every non-blank run is in exactly one block, and the blocks' runs are all the runs.
  assert.deepEqual(page.blocks.flatMap((b) => b.runIds).sort(), page.runs.map((r) => r.id).sort());
  assert.equal(page.blocks.find((b) => b.text === '• First bullet').kind, 'line', 'a list item is not joined');
  assert.equal(page.blocks.find((b) => b.text === 'A heading over the paragraph').kind, 'line');
  assert.deepEqual(page.readingOrder, page.blocks.map((b) => b.id));
  assert.ok(page.readingOrder.indexOf(page.blocks.find((b) => b.text.startsWith('A heading')).id) < page.readingOrder.indexOf(paragraph.id), 'content order: heading before its paragraph');
});

test('columns: text in two columns is never joined into one block', async () => {
  for (const [name, left, right] of [['columns', /^Left column|^Gap left/, /^Right column|^Gap right/], ['paragraphs', /^Left column/, /^Right column/]]) {
    const page = (await model(name)).pages[0];
    for (const block of page.blocks) {
      const lines = block.text.split('\n');
      assert.ok(!(lines.some((l) => left.test(l)) && lines.some((l) => right.test(l))), `${name}: ${JSON.stringify(block.text)} mixes columns`);
    }
    const lefts = page.runs.filter((r) => left.test(r.text));
    const rights = page.runs.filter((r) => right.test(r.text));
    assert.ok(lefts.length && rights.length);
    assert.ok(Math.max(...lefts.map((r) => r.box[2])) < Math.min(...rights.map((r) => r.box[0])), `${name}: the columns' boxes do not overlap`);
  }
  // One TJ operator that spans both columns is still two runs, in two blocks.
  const page = (await model('columns')).pages[0];
  const [a, b] = ['Gap left', 'Gap right'].map((t) => page.runs.find((r) => r.text === t));
  assert.notEqual(a.blockId, b.blockId);
});

test('objects: images, form fields, annotations and links stay distinct, each with a box', async () => {
  const images = (await model('images')).pages[0];
  assert.equal(images.images.length, 2);
  assert.deepEqual(images.images.map((i) => i.box), [[72, 500, 272, 650], [400, 600, 500, 700]]);
  assert.deepEqual(images.images.map((i) => i.pixels), [[32, 32], [32, 32]]);
  assert.deepEqual(images.blocks.map((b) => b.text), ['Caption under the picture', 'Text beside another picture']);
  assert.deepEqual([images.fields.length, images.annotations.length, images.links.length], [0, 0, 0]);

  const annotated = (await model('annotations')).pages[0];
  assert.deepEqual(annotated.links.map((l) => [l.url, l.internal, l.box]), [['https://example.com/', false, [72, 695, 260, 715]]]);
  assert.deepEqual(annotated.annotations.map((a) => [a.subtype, a.contents]), [['Text', 'A reviewer note']]);
  assert.deepEqual(annotated.fields.map((f) => [f.name, f.type, f.value]), [['customer.name', 'text', 'Ada Lovelace']]);
  assert.equal(annotated.images.length, 0);
  assert.ok(annotated.runs.every((r) => !r.id.includes(':annot:')), 'text is never an annotation');

  const form = (await model('form')).pages[0];
  assert.deepEqual(form.fields.map((f) => `${f.name}:${f.type}`), ['name:text', 'agree:checkbox', 'size:radio', 'size:radio', 'country:dropdown']);
  assert.equal(new Set(form.fields.map((f) => f.id)).size, 5, 'two widgets of one radio group are two fields with their own IDs');
  assert.equal(form.links.length + form.annotations.length, 0, 'widgets are fields, not annotations or links');

  const all = [...annotated.blocks, ...annotated.runs, ...annotated.images, ...annotated.fields, ...annotated.annotations, ...annotated.links].map((x) => x.id);
  assert.equal(new Set(all).size, all.length, 'no two entities share an ID');
});

test('geometry and identity: page boxes, boxes inside their page, the same IDs on every build, read-only', async () => {
  const doc = await model('crosspage');
  assert.deepEqual(doc.pages.map((p) => p.number), [1, 2, 3]);
  assert.deepEqual(doc.pages[0].box, [0, 0, 612, 792]);
  assert.deepEqual(doc.pages[2].box, [0, 0, 200, 200]);
  for (const page of doc.pages) {
    assert.equal(page.rotate, 0);
    for (const item of [...page.blocks, ...page.runs, ...page.images]) assert.ok(within(item.box, page.box), `${item.id} lies on its page`);
  }
  assert.ok(doc.pages[1].runs.length && doc.pages[1].runs.every((r) => r.id.startsWith('p2:')));
  const ids = (d) => d.pages.map((p) => [...p.readingOrder, ...p.runs.map((r) => r.id), ...p.images.map((i) => i.id)]);
  assert.deepEqual(ids(await model('crosspage')), ids(doc));
  const [page] = doc.pages;
  assert.ok(Object.isFrozen(page) && Object.isFrozen(page.runs) && Object.isFrozen(page.runs[0]) && Object.isFrozen(page.blocks[0].box));
  assert.throws(() => { page.runs[0].text = 'changed'; }, TypeError);
  assert.equal(doc.byId('p9:nothing'), null);
});

test('pure: built from objects alone, and building changes nothing it reads', async () => {
  const [analysis] = (await analyzeFile(read('paragraphs'))).pages;
  const objects = objectsOf(analysis);
  const runsBefore = JSON.stringify(analysis.runs.map((r) => [r.key, r.text, r.box]));
  const page = semanticPage({ number: 1, objects });
  assert.equal(page.box, null);
  assert.deepEqual([page.fields.length, page.links.length, page.annotations.length], [0, 0, 0]);
  assert.equal(page.blocks.filter((b) => b.kind === 'paragraph').length, 2);
  assert.equal(JSON.stringify(analysis.runs.map((r) => [r.key, r.text, r.box])), runsBefore);
  assert.equal(objectsOf(analysis), objects, 'the object model it read is untouched');
});

test('integration: the document open in an editing session is described page by page', async () => {
  await withSession(read('annotations'), async ({ bytes, session }) => {
    const js = await openWithPdfjs(bytes);
    try {
      const doc = await readSemanticDocument(session, js.doc);
      assert.equal(doc.pageCount, 1);
      const [page] = doc.pages;
      assert.deepEqual(page.blocks.map((b) => b.text), ['Text with a link and a note', 'Field below:']);
      assert.deepEqual([page.links.length, page.fields.length, page.annotations.length], [1, 1, 1]);
      // The link lies over the text it links.
      const text = doc.byId(page.blocks[0].runIds[0]);
      assert.ok(text.box[0] >= page.links[0].box[0] && text.box[2] <= page.links[0].box[2]);
    } finally {
      await js.close();
    }
  });
});
