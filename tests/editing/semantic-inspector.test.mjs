// The Structure panel's adapter (semantic/inspector.js) over the semantic document model: a page's objects as
// rows in reading order, paragraphs with their runs and one-line blocks as their run, counts, and the
// properties shown for each kind — all read from the model, which stays as it was.
// Run: node --test tests/editing/semantic-inspector.test.mjs

import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { openWithPdfjs, webModule, withSession } from './harness.mjs';
import { makeFixtures, FIXTURE_DIR } from './fixtures.mjs';

const { readSessionPage } = await webModule('semantic/model.js');
const { countsLabel, pageCounts, pageRows, properties } = await webModule('semantic/inspector.js');

let files;
before(async () => { files = await makeFixtures(FIXTURE_DIR); });

async function pages(name) {
  const list = [];
  await withSession(new Uint8Array(fs.readFileSync(files[name])), async ({ bytes, session }) => {
    const js = await openWithPdfjs(bytes);
    try {
      for (let n = 1; n <= js.doc.numPages; n++) list.push(await readSessionPage(session, js.doc, n));
    } finally {
      await js.close();
    }
  });
  return list;
}

const values = (kind, item) => Object.fromEntries(properties(kind, item));

test('rows: text in reading order, a paragraph holding its runs, then images, fields, annotations and links', async () => {
  const [one, two] = await pages('structure');
  const before = JSON.stringify(one);
  const groups = pageRows(one);
  assert.deepEqual(groups.map((g) => g.key), ['text', 'fields', 'annotations', 'links']);
  const text = groups[0].rows;
  assert.deepEqual(text.map((r) => r.kind), ['run', 'block', 'run', 'run']);
  assert.equal(text[0].label, 'Structure report');
  assert.deepEqual(text[1].children.map((c) => c.item.text), ['The first line of a plain paragraph that', 'runs on to a second line and ends here.']);
  assert.equal(groups[1].rows[0].label, 'reader.name · text');
  assert.equal(groups[3].rows[0].label, 'https://example.com/structure');
  assert.deepEqual(pageCounts(one), { blocks: 4, runs: 5, images: 0, fields: 1, annotations: 1, links: 1, total: 7 });
  assert.equal(countsLabel(one), '4 text blocks · 1 field · 1 annotation · 1 link');
  assert.deepEqual(pageRows(two).map((g) => [g.key, g.rows.length]), [['text', 2], ['images', 1]]);
  assert.equal(pageRows(two)[1].rows[0].label, 'Image 1 · 48×36');
  assert.equal(JSON.stringify(one), before, 'the model is read, never changed');
});

test('properties: text, image, field, annotation and link, from the model’s own values', async () => {
  const [one, two] = await pages('structure');
  const run = values('run', one.runs.find((r) => r.text === 'Structure report'));
  assert.equal(run.Font.length > 0, true);
  assert.equal(run['Font size'], '20 pt');
  assert.equal(run.Editable, 'Yes');
  assert.equal(run.Invisible, 'No');
  const image = values('image', two.images[0]);
  assert.equal(image.Pixels, '48 × 36');
  assert.equal(image.Type, 'Image object');
  assert.equal(image['Size on page'], '240 × 180 pt');
  assert.deepEqual([values('field', one.fields[0]).Name, values('field', one.fields[0]).Type, values('field', one.fields[0]).Value, values('field', one.fields[0])['Read-only']], ['reader.name', 'text', 'Grace Hopper', 'No']);
  assert.deepEqual([values('annotation', one.annotations[0]).Subtype, values('annotation', one.annotations[0]).Contents], ['Text', 'Check the figures']);
  assert.equal(values('link', one.links[0]).Destination, 'https://example.com/structure');
  assert.equal(values('link', { id: 'p1:annot:9', url: null, internal: true, box: null }).Destination, 'A place in this document');
  assert.equal(values('block', one.blocks[1]).Lines, '2');
});
