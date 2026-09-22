// Semantic search (semantic/query.js): queries read as words, a kind, an editable filter and exact or
// contains matching, then matched against pages of the semantic document model — the structure fixture's
// real pages, and a made-up page for editable and non-editable runs.
// Run: node --test tests/editing/semantic-search.test.mjs

import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { openWithPdfjs, webModule, withSession } from './harness.mjs';
import { makeFixtures, FIXTURE_DIR } from './fixtures.mjs';

const { readSessionPage } = await webModule('semantic/model.js');
const { describeQuery, isEmptyQuery, matchPage, needsContent, parseQuery } = await webModule('semantic/query.js');

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

const search = (list, text, options) => list.flatMap((page) => matchPage(page, parseQuery(text, options)));
const brief = (results) => results.map((r) => `${r.number}:${r.kind}:${r.label}`);

test('parsing: words, kinds, editable filters, contains and exact', () => {
  const q = (text) => { const { type, editable, match, text: words } = parseQuery(text); return [type, editable, match, words]; };
  assert.deepEqual(q('transformer'), [null, null, 'contains', 'transformer']);
  assert.deepEqual(q('  Transformer   Models '), [null, null, 'contains', 'Transformer Models'], 'case is kept; matching folds it');
  assert.deepEqual(q('all images'), ['image', null, 'contains', '']);
  assert.deepEqual(q('all pictures'), ['image', null, 'contains', '']);
  assert.deepEqual(q('all form fields'), ['field', null, 'contains', '']);
  assert.deepEqual(q('fields containing grace'), ['field', null, 'contains', 'grace']);
  assert.deepEqual(q('all links'), ['link', null, 'contains', '']);
  assert.deepEqual(q('annotations with figures'), ['annotation', null, 'contains', 'figures']);
  assert.deepEqual(q('editable text containing method'), ['text', true, 'contains', 'method']);
  assert.deepEqual(q('editable containing method'), ['text', true, 'contains', 'method']);
  assert.deepEqual(q('non-editable text'), ['text', false, 'contains', '']);
  assert.deepEqual(q('not editable text'), ['text', false, 'contains', '']);
  assert.deepEqual(q('text exactly Structure report'), ['text', null, 'exact', 'Structure report']);
  assert.deepEqual(q('exactly Figure 1: a picture'), [null, null, 'exact', 'Figure 1: a picture']);
  // Words that only look like the grammar stay words.
  assert.deepEqual(q('"all images"'), [null, null, 'contains', 'all images']);
  assert.deepEqual(q('all the best'), [null, null, 'contains', 'all the best']);
  assert.deepEqual(q('with love'), [null, null, 'contains', 'with love']);
  assert.deepEqual(q('linksys router'), [null, null, 'contains', 'linksys router']);
  assert.equal(isEmptyQuery(parseQuery('   ')), true);
  assert.equal(isEmptyQuery(parseQuery('all links')), false);
  assert.equal(needsContent(parseQuery('all links')), false);
  assert.equal(needsContent(parseQuery('all form fields')), false);
  assert.equal(needsContent(parseQuery('transformer')), true);
  assert.equal(needsContent(parseQuery('all images')), true);
  assert.equal(describeQuery(parseQuery('editable text containing Method')), 'Editable text containing “Method”');
  assert.equal(describeQuery(parseQuery('all images')), 'Images');
});

test('text: contains and exact, across a paragraph’s lines, in reading order', async () => {
  const list = await pages('structure');
  const before = JSON.stringify(list);
  assert.deepEqual(brief(search(list, 'structure report')), ['1:run:Structure report']);
  assert.deepEqual(brief(search(list, 'PARAGRAPH THAT runs on')), ['1:block:The first line of a plain paragraph that runs on to a second line and…'], 'a line break is a space');
  assert.deepEqual(brief(search(list, 'figure')), ['1:annotation:Text · Check the figures', '2:run:A figure on page two', '2:run:Figure 1: a picture'], 'plain words find a note’s contents too');
  assert.deepEqual(brief(search(list, 'text containing figure')), ['2:run:A figure on page two', '2:run:Figure 1: a picture']);
  assert.deepEqual(brief(search(list, 'exactly figure 1: a picture')), ['2:run:Figure 1: a picture']);
  assert.deepEqual(brief(search(list, 'exactly figure')), []);
  assert.deepEqual(brief(search(list, 'transformer')), []);
  assert.deepEqual(brief(search(list, 'text containing page')), ['1:run:Visit the project page', '2:run:A figure on page two']);
  assert.equal(JSON.stringify(list), before, 'searching reads the model, never changes it');
});

test('kinds: images, form fields, annotations and links, with and without words', async () => {
  const list = await pages('structure');
  assert.deepEqual(brief(search(list, 'all images')), ['2:image:Image 1 · 48×36']);
  assert.deepEqual(brief(search(list, 'images containing figure')), [], 'images have no text to match');
  assert.deepEqual(brief(search(list, 'all form fields')), ['1:field:reader.name · text']);
  assert.deepEqual(brief(search(list, 'fields containing grace')), ['1:field:reader.name · text'], 'a field matches on its value');
  assert.deepEqual(brief(search(list, 'grace hopper')), ['1:field:reader.name · text'], 'and plain words find it too');
  assert.deepEqual(brief(search(list, 'all annotations')), ['1:annotation:Text · Check the figures']);
  assert.deepEqual(brief(search(list, 'all links')), ['1:link:https://example.com/structure', '2:link:Link to page 1']);
  assert.deepEqual(brief(search(list, 'links containing example.com')), ['1:link:https://example.com/structure']);
  assert.deepEqual(brief(search(list, 'links containing page 1')), ['2:link:Link to page 1']);
  const [result] = search(list, 'all images');
  assert.equal(result.item, list[1].images[0], 'a result is the model’s own object');
  assert.deepEqual(result.item.box, [72, 480, 312, 660]);
});

test('editable and non-editable text, per run', () => {
  const run = (id, text, editable) => ({ id, key: id, blockId: 'p1:b', text, box: [0, 0, 10, 10], quad: null, font: null, size: 10, dir: 0, editable, invisible: false });
  const runs = [run('p1:1', 'The method we use', true), run('p1:2', 'Method, drawn as outlines', false), run('p1:3', 'Results', false)];
  const page = {
    id: 'p1', number: 1, contentRead: true, runs, images: [], fields: [], annotations: [], links: [],
    blocks: [{ id: 'p1:b', kind: 'paragraph', text: runs.map((r) => r.text).join('\n'), lines: 3, runIds: runs.map((r) => r.id), box: [0, 0, 10, 30] }],
    readingOrder: ['p1:b'],
  };
  const labels = (text) => matchPage(page, parseQuery(text)).map((r) => `${r.kind}:${r.label}`);
  assert.deepEqual(labels('editable text containing method'), ['run:The method we use']);
  assert.deepEqual(labels('non-editable text containing method'), ['run:Method, drawn as outlines']);
  assert.deepEqual(labels('non-editable text'), ['run:Method, drawn as outlines', 'run:Results']);
  assert.deepEqual(labels('method'), ['block:The method we use Method, drawn as outlines Results'], 'without a filter, the paragraph');
});

test('kind words: alone or before other words they are searched for; "all" or containing makes them kinds', () => {
  const q = (text) => { const { type, editable, match, text: words } = parseQuery(text); return [type, editable, match, words]; };
  for (const word of ['text', 'images', 'image', 'links', 'fields', 'form fields', 'comments', 'annotations', 'pictures', 'paragraphs']) {
    assert.deepEqual(q(word), [null, null, 'contains', word], word);
  }
  assert.deepEqual(q('Text  layout'), [null, null, 'contains', 'Text layout']);
  assert.deepEqual(q('comments on the draft'), [null, null, 'contains', 'comments on the draft']);
  assert.deepEqual(q('links to page 2'), [null, null, 'contains', 'links to page 2']);
  assert.deepEqual(q('all images'), ['image', null, 'contains', '']);
  assert.deepEqual(q('all comments'), ['annotation', null, 'contains', '']);
  assert.deepEqual(q('ALL Text'), ['text', null, 'contains', '']);
  assert.deepEqual(q('comments containing budget'), ['annotation', null, 'contains', 'budget']);
  assert.deepEqual(q('links exactly https://a.b'), ['link', null, 'exact', 'https://a.b']);
  assert.deepEqual(q('editable text'), ['text', true, 'contains', '']);
  assert.equal(needsContent(parseQuery('links')), true, 'the word "links" is looked for in the text too');
});

test('kind words as words find the word, not every object of the kind', async () => {
  const list = await pages('structure');
  assert.deepEqual(brief(search(list, 'links')), [], 'no text says "links"');
  assert.equal(search(list, 'all links').length, 2);
  assert.deepEqual(brief(search(list, 'text')), [], 'a note’s subtype (Text) only matches when notes are asked for by kind');
  assert.deepEqual(brief(search(list, 'picture')), ['2:run:Figure 1: a picture'], '"picture" is a word');
});

test('Match case and Whole words', () => {
  const run = (id, text) => ({ id, key: id, blockId: id, text, box: [0, 0, 10, 10], quad: null, font: null, size: 10, dir: 0, editable: true, invisible: false });
  const texts = ['Apple pie', 'apple sauce', 'Pineapple', 'APPLE_JUICE', 'apple-tree'];
  const runs = texts.map((t, i) => run(`p1:${i}`, t));
  const page = {
    id: 'p1', number: 1, contentRead: true, runs, images: [], annotations: [], links: [],
    fields: [{ id: 'p1:f', name: 'Fruit', type: 'text', value: 'Apple' }],
    blocks: runs.map((r) => ({ id: r.id, kind: 'line', text: r.text, lines: 1, runIds: [r.id], box: r.box })),
    readingOrder: runs.map((r) => r.id),
  };
  const labels = (text, options) => matchPage(page, parseQuery(text, options)).map((r) => r.label);
  assert.deepEqual(labels('apple'), [...texts, 'Fruit · text'], 'case ignored by default');
  assert.deepEqual(labels('apple', { caseSensitive: true }), ['apple sauce', 'Pineapple', 'apple-tree']);
  assert.deepEqual(labels('Apple', { caseSensitive: true }), ['Apple pie', 'Fruit · text']);
  assert.deepEqual(labels('apple', { entireWord: true }), ['Apple pie', 'apple sauce', 'apple-tree', 'Fruit · text'], 'not inside Pineapple or APPLE_JUICE');
  assert.deepEqual(labels('apple', { caseSensitive: true, entireWord: true }), ['apple sauce', 'apple-tree']);
  assert.deepEqual(labels('apple  PIE', { entireWord: true }), ['Apple pie'], 'white space runs match as one');
  assert.deepEqual(labels('exactly apple pie'), ['Apple pie']);
  assert.deepEqual(labels('exactly apple pie', { caseSensitive: true }), []);
  assert.deepEqual(labels('text containing Apple', { caseSensitive: true, entireWord: true }), ['Apple pie']);
  const parsed = parseQuery('x', { caseSensitive: true, entireWord: true });
  assert.equal(parsed.caseSensitive, true);
  assert.equal(parsed.entireWord, true);
});
