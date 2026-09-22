// Research (semantic/research.js): a question's key terms, searched for with semantic search over the
// structure fixture's real pages, give evidence passages with their page and box — or say the evidence is
// insufficient.
// Run: node --test tests/editing/research.test.mjs

import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { openWithPdfjs, webModule, withSession } from './harness.mjs';
import { makeFixtures, FIXTURE_DIR } from './fixtures.mjs';

const { readSessionPage } = await webModule('semantic/model.js');
const { needed, pageCandidates, rankEvidence, researchTerms } = await webModule('semantic/research.js');

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

const research = (list, question) => {
  const terms = researchTerms(question);
  return rankEvidence(terms, list.flatMap((page) => pageCandidates(page, terms)));
};

test('terms: stop words dropped, quoted phrases kept whole, each once', () => {
  assert.deepEqual(researchTerms('Which figure is shown on page two?'), ['figure', 'shown', 'two']);
  assert.deepEqual(researchTerms('What does the "project page" say about Figure 1, figure?'), ['project page', 'figure', '1']);
  assert.deepEqual(researchTerms('what is the?'), []);
  assert.deepEqual([1, 2, 3, 4, 5].map(needed), [1, 2, 2, 2, 3]);
});

test('query → relevant evidence, with page and box from the model', async () => {
  const list = await pages('structure');
  const before = JSON.stringify(list);
  const found = research(list, 'Which figure is on page two?');
  assert.equal(found.sufficient, true);
  assert.deepEqual(found.evidence.map((e) => [e.number, e.text, e.matched]), [[2, 'A figure on page two', ['figure', 'two']]],
    '“Figure 1: a picture” holds only one of the two terms and is not evidence');
  const [e] = found.evidence;
  const run = list[1].runs.find((r) => r.id === e.id);
  assert.ok(run, 'the evidence is the model’s own text run');
  assert.deepEqual(e.box, run.box);
  assert.equal(e.number, list[1].number);
  assert.match(found.summary, /^1 passage on page 2; the closest holds 2 of 2 key terms\.$/);
  assert.equal(JSON.stringify(list), before, 'research reads the model, never changes it');
});

test('ranking: the passage holding the most terms first, then page order', async () => {
  const list = await pages('structure');
  const found = research(list, 'figure two picture 1');
  assert.deepEqual(found.evidence.map((e) => `${e.number}:${e.matched.length}:${e.text}`), [
    '2:3:Figure 1: a picture',
    '2:2:A figure on page two',
  ], 'three terms before two, though it comes later on the page');
});

test('insufficient or empty evidence is said, not guessed', async () => {
  const list = await pages('structure');
  const none = research(list, 'What is the transformer architecture?');
  assert.equal(none.sufficient, false);
  assert.deepEqual(none.evidence, []);
  assert.deepEqual(none.missing, ['transformer', 'architecture']);
  assert.match(none.summary, /^Not enough evidence in this document/);
  const weak = research(list, 'figure transformer architecture');
  assert.equal(weak.sufficient, false, 'one of three terms is not enough');
  assert.match(weak.summary, /Not found anywhere: “transformer”, “architecture”/);
  const empty = research(list, 'what is the?');
  assert.equal(empty.sufficient, false);
  assert.match(empty.summary, /no key terms/);
});
