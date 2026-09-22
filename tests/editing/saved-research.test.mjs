// Saved research V1 (semantic/saved-research.js): a Research or Collection research result written down and
// read back without the research being run again — the question, what it was asked of, the ranked evidence,
// its provenance and Vellum's summary, all exactly as they were found. A damaged record is dropped or read as
// far as it goes, never repaired into something that was never found, and a document that has gone stays the
// one the evidence names, marked missing.
// Run: node --test tests/editing/saved-research.test.mjs

import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { webModule } from './harness.mjs';
import { makeFixtures, FIXTURE_DIR } from './fixtures.mjs';

const { pageCandidates, rankEvidence, researchTerms } = await webModule('semantic/research.js');
const { documentRef, SOURCES } = await webModule('semantic/provenance.js');
const { documentPages, researchCollection, SkippedDocument } = await webModule('semantic/collection-research.js');
const {
  SAVED_RESEARCH_VERSION, cleanSavedName, readSavedResearch, savedResearchPaths,
  savedResearchRecord, savedResearchSubject, suggestedName, withAvailability,
} = await webModule('semantic/saved-research.js');

let files;
before(async () => { files = await makeFixtures(FIXTURE_DIR); });

const QUESTION = 'Where are the samples collected weekly?';

/** The collection as the host describes it: { path, name, exists }, in the collection's own order. */
const collect = (...names) => names.map((name) => {
  const file = files[name] ?? path.join(FIXTURE_DIR, `${name}.pdf`);
  return { path: file, name: path.basename(file), exists: fs.existsSync(file) };
});

/** Reads a document the way the app does, from the file instead of the host's read-only URL. */
async function* readDocument(doc, { identify } = {}) {
  if (!doc.exists || !fs.existsSync(doc.path)) throw new SkippedDocument('missing');
  identify?.({ contentKey: `KEY${path.basename(doc.path).toUpperCase()}` });
  yield* documentPages(new Uint8Array(fs.readFileSync(doc.path)));
}

/** Research of one document, as the Structure panel runs it: with the document it is reading. */
async function researchDocument(name, question = QUESTION) {
  const [doc] = collect(name);
  const document = documentRef({ name: doc.name, path: doc.path, contentKey: 'ABCDEF0123456789' });
  const terms = researchTerms(question);
  const candidates = [];
  for await (const page of readDocument(doc)) candidates.push(...pageCandidates(page, terms));
  return { document, found: rankEvidence(terms, candidates, { document, source: SOURCES.document }) };
}

/** Saving and loading, the way the host does it: the record is written as JSON and read back. */
const roundTrip = (record) => readSavedResearch(JSON.parse(JSON.stringify(record)));

test('a saved document research is given back exactly as it was found', async () => {
  const { document, found } = await researchDocument('compare-a');
  assert.ok(found.sufficient, 'the fixture answers the question');

  const read = roundTrip(savedResearchRecord({
    question: QUESTION, source: SOURCES.document, document,
    summary: found.summary, sufficient: found.sufficient, evidence: found.evidence,
  }));

  assert.equal(read.v, SAVED_RESEARCH_VERSION);
  assert.equal(read.question, QUESTION);
  assert.equal(read.source, SOURCES.document);
  assert.equal(read.summary, found.summary, 'Vellum’s summary is kept word for word, never rewritten');
  assert.equal(read.sufficient, true);
  assert.equal(read.evidence.length, found.evidence.length);
  for (const [i, passage] of read.evidence.entries()) {
    const original = found.evidence[i];
    assert.equal(passage.text, original.text, 'the quote is the one that was found');
    assert.equal(passage.page, original.number, 'on the page it was found on');
    assert.deepEqual([...passage.matched], original.matched, 'matching the same terms');
    assert.deepEqual(passage.box ? [...passage.box] : null, original.box ?? null);
    assert.equal(passage.kind, original.kind);
    assert.equal(passage.id, original.id);
  }
  assert.deepEqual({ ...read.document }, { ...document }, 'the document it was asked of survives');
  assert.deepEqual(JSON.parse(JSON.stringify(read)), JSON.parse(JSON.stringify(roundTrip(read))), 'reading it again changes nothing');
});

test('provenance survives the round trip, field for field', async () => {
  const { document, found } = await researchDocument('compare-a');
  const read = roundTrip(savedResearchRecord({ question: QUESTION, document, summary: found.summary, sufficient: true, evidence: found.evidence }));

  assert.ok(read.evidence.length);
  for (const [i, passage] of read.evidence.entries()) {
    const original = found.evidence[i].provenance;
    assert.ok(passage.provenance, 'every saved passage still says where it came from');
    assert.equal(passage.provenance.v, original.v);
    assert.equal(passage.provenance.source, original.source);
    assert.equal(passage.provenance.page, original.page);
    assert.deepEqual(passage.provenance.box ? [...passage.provenance.box] : null, original.box ? [...original.box] : null);
    assert.deepEqual({ ...passage.provenance.document }, { ...original.document }, 'the file reference and its content key are kept');
    assert.equal(passage.provenance.document.reference, 'content');
    assert.equal(passage.provenance.object.id, original.object.id);
    assert.equal(passage.provenance.object.kind, original.object.kind);
    assert.equal(passage.provenance.object.blockId, original.object.blockId);
    assert.deepEqual(passage.provenance.object.runIds ? [...passage.provenance.object.runIds] : null,
      original.object.runIds ? [...original.object.runIds] : null, 'the model’s own IDs for the passage too');
  }
});

test('the collection a research was asked of survives, and so does each passage’s document', async () => {
  const documents = collect('compare-a', 'compare-b');
  const found = await researchCollection({ documents, question: QUESTION, readDocument });
  assert.ok(found.evidence.length, 'the collection answers the question');

  const read = roundTrip(savedResearchRecord({
    question: QUESTION, source: SOURCES.collection,
    collection: { id: 'c1', name: 'Reports' },
    summary: found.summary, sufficient: found.sufficient, evidence: found.evidence,
  }));

  assert.equal(read.source, SOURCES.collection);
  assert.deepEqual({ ...read.collection }, { id: 'c1', name: 'Reports' });
  assert.equal(savedResearchSubject(read), 'Reports');
  assert.equal(read.document, null, 'a collection research was not asked of one document');
  assert.equal(read.summary, found.summary);
  for (const [i, passage] of read.evidence.entries()) {
    assert.equal(passage.name, found.evidence[i].name, 'the file the passage came from is named');
    assert.equal(passage.path, found.evidence[i].path, 'and where it was');
    assert.equal(passage.provenance.source, SOURCES.collection);
    assert.equal(passage.provenance.document.contentKey, found.evidence[i].provenance.document.contentKey);
  }
  const paths = savedResearchPaths(read);
  assert.deepEqual(paths, documents.map((d) => d.path), 'the host is told exactly the files the evidence quotes, each once');
});

test('a document that is gone stays the one the evidence names, marked missing', async () => {
  const documents = collect('compare-a', 'compare-b');
  const found = await researchCollection({ documents, question: QUESTION, readDocument });
  const read = roundTrip(savedResearchRecord({
    question: QUESTION, source: SOURCES.collection, collection: { id: 'c1', name: 'Reports' },
    summary: found.summary, sufficient: true, evidence: found.evidence,
  }));

  // The host lists what it found on disk when the saved research was opened: one file is no longer there.
  const gone = read.evidence[0].path;
  const shown = withAvailability(read, savedResearchPaths(read).map((p) => ({ path: p, exists: p !== gone })));
  const missing = shown.evidence.filter((e) => e.missing);
  assert.ok(missing.length, 'the passages of the missing file are marked missing');
  assert.equal(shown.missing, missing.length);
  assert.ok(missing.every((e) => e.path === gone && e.text && e.provenance), 'their quote and provenance are still there — nothing is searched for again');
  assert.ok(shown.evidence.filter((e) => !e.missing).every((e) => e.path !== gone), 'the rest are unchanged');
  assert.equal(shown.summary, read.summary, 'the summary is not rewritten because a file moved');

  const none = withAvailability(read, []);
  assert.equal(none.missing, none.evidence.length, 'a host that lists nothing leaves every passage missing, never guessed at');
});

test('a damaged saved result is dropped or read as far as it goes, never repaired', async () => {
  for (const bad of [null, undefined, 'x', 42, [], { v: SAVED_RESEARCH_VERSION + 1, question: 'q' }]) {
    assert.equal(readSavedResearch(bad), null, `${JSON.stringify(bad) ?? 'undefined'} can’t be read`);
  }
  const partly = readSavedResearch({
    v: 1, question: 'q', source: SOURCES.document, summary: 'one passage', sufficient: true,
    evidence: [
      { text: 'kept', number: 2, matched: ['q'], box: [1, 2, 3, 4], provenance: { v: 1, page: 2, document: { path: 'C:\\a.pdf', name: 'a.pdf' } } },
      { text: 'no page at all' },
      null,
      { number: 3 },
      { text: 'page from provenance', provenance: { page: 5, document: { name: 'b.pdf' } } },
    ],
  });
  assert.equal(partly.evidence.length, 2, 'the passages that can’t be read are dropped; the rest still open');
  assert.equal(partly.evidence[0].text, 'kept');
  assert.equal(partly.evidence[0].name, 'a.pdf', 'a passage takes its file from its provenance when it has none of its own');
  assert.equal(partly.evidence[1].page, 5);
  assert.equal(partly.evidence[1].provenance.document.reference, 'path', 'no content key means the file is referenced by its place');

  const empty = readSavedResearch({ v: 1, question: 'q', summary: 'nothing', sufficient: true, evidence: [{ text: '' }] });
  assert.equal(empty.sufficient, false, 'a result left with no readable evidence never claims to be sufficient');
  assert.deepEqual([...empty.evidence], []);
});

test('the name offered is the question, cleaned the way the host cleans it', () => {
  assert.equal(suggestedName(savedResearchRecord({ question: '  Hello   world  ', collection: { id: 'c1', name: 'Reports' } })), 'Hello world');
  assert.equal(cleanSavedName('  a   b '), 'a b');
  assert.equal(cleanSavedName('x'.repeat(200)).length, 80);
  assert.equal(suggestedName(savedResearchRecord({ question: '   ', collection: { id: 'c1', name: 'Reports' } })), 'Reports');
});
