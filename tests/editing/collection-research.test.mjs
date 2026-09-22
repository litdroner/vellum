// Collection research (semantic/collection-research.js): one question asked of every document in a
// collection, answered with passages those documents hold — each with the file it came from, its page and
// its box. Missing and protected documents are skipped with a reason, and no file is written.
// Run: node --test tests/editing/collection-research.test.mjs

import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { webModule } from './harness.mjs';
import { makeFixtures, FIXTURE_DIR } from './fixtures.mjs';

const { documentPages, MAX_EVIDENCE, researchCollection, SkippedDocument } = await webModule('semantic/collection-research.js');

let files;
before(async () => { files = await makeFixtures(FIXTURE_DIR); });

/** The collection as the host describes it: { path, name, exists }, in the collection's own order. */
const collect = (...names) => names.map((name) => {
  const file = files[name] ?? path.join(FIXTURE_DIR, `${name}.pdf`);
  return { path: file, name: path.basename(file), exists: fs.existsSync(file) };
});

/** Reads a document the way the app does, from the file instead of the host's read-only URL. */
async function* readDocument(doc) {
  if (!doc.exists || !fs.existsSync(doc.path)) throw new SkippedDocument('missing');
  yield* documentPages(new Uint8Array(fs.readFileSync(doc.path)));
}

const research = (documents, question, options) => researchCollection({ documents, question, readDocument, ...options });
const hash = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

test('evidence comes from several documents, each with its file, page and box', async () => {
  const documents = collect('compare-a', 'compare-b');
  const found = await research(documents, 'Where are the samples collected weekly?');
  assert.equal(found.sufficient, true);
  assert.deepEqual(found.terms, ['samples', 'collected', 'weekly']);
  assert.deepEqual(found.evidence.map((e) => [e.name, e.number, e.text]), [
    ['compare-a.pdf', 2, 'Samples were collected weekly from each site'],
    ['compare-b.pdf', 3, 'Samples were collected weekly from each site'],
  ], 'the same passage in both documents, in collection then page order');
  assert.equal(found.searched, 2);
  assert.deepEqual(found.skipped, []);
  for (const e of found.evidence) {
    assert.equal(e.path, documents.find((d) => d.name === e.name).path, 'evidence names the file it came from');
    assert.equal(e.box?.length, 4, 'and the box of the passage on its page');
    assert.ok(e.box[0] > 0 && e.box[3] > 0);
    assert.deepEqual(e.matched, ['samples', 'collected', 'weekly']);
  }
  assert.match(found.summary, /^2 passages in 2 documents \(compare-a\.pdf, compare-b\.pdf\); the closest holds 3 of 3 key terms\. 2 documents of 2 read\.$/);
});

test('the page and box are the document’s own, as its model reads them', async () => {
  const [doc] = collect('compare-a');
  const pages = [];
  for await (const page of readDocument(doc)) pages.push(page);
  const found = await research([doc], 'Where are the samples collected weekly?');
  const [e] = found.evidence;
  const run = pages[e.number - 1].runs.find((r) => r.id === e.id);
  assert.ok(run, 'the evidence is a text run of that page’s model');
  assert.deepEqual(e.box, run.box);
  assert.equal(e.text, run.text);
});

test('missing and protected documents are skipped with a reason, the rest still researched', async () => {
  const documents = collect('compare-a', 'encrypted-password', 'no-such-file');
  const before = hash(files['compare-a']);
  const found = await research(documents, 'Where are the samples collected weekly?');
  assert.equal(found.sufficient, true, 'the readable document still gives evidence');
  assert.deepEqual(found.evidence.map((e) => e.name), ['compare-a.pdf']);
  assert.equal(found.searched, 1);
  assert.deepEqual(found.skipped.map((s) => [s.name, s.reason]), [
    ['encrypted-password.pdf', 'protected'],
    ['no-such-file.pdf', 'missing'],
  ]);
  assert.match(found.summary, /1 document of 3 read\./);
  assert.match(found.summary, /2 documents skipped: encrypted-password\.pdf — protected \(its text isn’t read\); no-such-file\.pdf — not found\./);
  assert.equal(hash(files['compare-a']), before, 'no document is written');
});

test('one ranked list over the collection: the collection’s own order, and the existing limit of 8', async () => {
  const question = 'Where are the samples collected weekly?';
  const forward = await research(collect('compare-a', 'compare-b'), question);
  const reversed = await research(collect('compare-b', 'compare-a'), question);
  assert.deepEqual(forward.evidence.map((e) => e.name), ['compare-a.pdf', 'compare-b.pdf']);
  assert.deepEqual(reversed.evidence.map((e) => e.name), ['compare-b.pdf', 'compare-a.pdf'],
    'passages holding the same terms follow the collection’s order, not page number across documents');
  assert.equal(MAX_EVIDENCE, 8, 'the collection is held to the same limit one document is');
  const capped = await research(collect('compare-a', 'compare-b'), question, { limit: 1 });
  assert.deepEqual(capped.evidence.map((e) => e.name), ['compare-a.pdf'], 'the limit counts over the whole collection');
});

test('a question with no key terms, and one nothing answers, are said and not guessed', async () => {
  const documents = collect('compare-a', 'compare-b');
  const empty = await research(documents, 'what is the?');
  assert.equal(empty.sufficient, false);
  assert.deepEqual(empty.evidence, []);
  assert.equal(empty.searched, 0, 'no document is read for a question with no terms');
  assert.match(empty.summary, /no key terms/);

  const none = await research(documents, 'What is the transformer architecture?');
  assert.equal(none.sufficient, false);
  assert.deepEqual(none.missing, ['transformer', 'architecture']);
  assert.match(none.summary, /^Not enough evidence in this collection/);
  assert.match(none.summary, /Not found anywhere: “transformer”, “architecture”\./);
});
