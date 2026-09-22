// Document provenance V1 (semantic/provenance.js): every Research and Collection research passage carries a
// record of where it came from — the document reference, its page, its box and the semantic model's IDs — and
// that record survives being exported as JSON without losing a field.
// Run: node --test tests/editing/provenance.test.mjs

import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { openWithPdfjs, webModule, withSession } from './harness.mjs';
import { makeFixtures, FIXTURE_DIR } from './fixtures.mjs';

const { readSessionPage } = await webModule('semantic/model.js');
const { pageCandidates, rankEvidence, researchTerms } = await webModule('semantic/research.js');
const { documentRef, evidenceProvenance, PROVENANCE_VERSION, provenanceDetail, provenanceLine, SOURCES } = await webModule('semantic/provenance.js');
const { documentPages, researchCollection, SkippedDocument } = await webModule('semantic/collection-research.js');

let files;
before(async () => { files = await makeFixtures(FIXTURE_DIR); });

const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex').toUpperCase();

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

/** Research of one document, as the Structure panel runs it: with the document it is reading. */
const research = (list, question, document) => {
  const terms = researchTerms(question);
  return rankEvidence(terms, list.flatMap((page) => pageCandidates(page, terms)), { document, source: SOURCES.document });
};

/** The collection as the host describes it; the reader stands in for the host's read-only URL. */
const collect = (...names) => names.map((name) => {
  const file = files[name] ?? path.join(FIXTURE_DIR, `${name}.pdf`);
  return { path: file, name: path.basename(file), exists: fs.existsSync(file) };
});

/** Reads like the app's reader, telling the research the content key the host returns with the bytes. */
async function* readDocument(doc, { identify } = {}) {
  if (!doc.exists || !fs.existsSync(doc.path)) throw new SkippedDocument('missing');
  const bytes = new Uint8Array(fs.readFileSync(doc.path));
  identify?.({ contentKey: sha256(doc.path) });
  yield* documentPages(bytes);
}

test('a document reference says how it identifies the file, and never more than it knows', () => {
  const withKey = documentRef({ name: 'report.pdf', path: 'C:\\docs\\report.pdf', contentKey: 'ABCD1234' });
  assert.deepEqual({ ...withKey }, { name: 'report.pdf', path: 'C:\\docs\\report.pdf', contentKey: 'ABCD1234', reference: 'content' });
  const noKey = documentRef({ name: 'report.pdf', path: 'C:\\docs\\report.pdf' });
  assert.equal(noKey.contentKey, null);
  assert.equal(noKey.reference, 'path', 'no content key: the file is referenced by its path, not by a guess');
  assert.deepEqual({ ...documentRef() }, { name: null, path: null, contentKey: null, reference: 'path' });
  assert.ok(Object.isFrozen(withKey));

  const prov = evidenceProvenance({ id: 'p2:run:7', kind: 'run', number: 2, box: [1, 2, 3, 4], blockId: 'p2:block:1' }, { document: withKey });
  assert.equal(prov.v, PROVENANCE_VERSION);
  assert.equal(prov.source, SOURCES.document);
  assert.equal(provenanceLine(prov), 'report.pdf · page 2 · p2:run:7');
  assert.deepEqual(provenanceDetail(prov).split('\n'), [
    'report.pdf · page 2 · p2:run:7',
    'C:\\docs\\report.pdf',
    'content abcd1234… (the file as it was read)',
  ]);
  const missing = evidenceProvenance({}, {});
  assert.deepEqual([missing.page, missing.box, missing.object.id, missing.object.blockId, missing.object.runIds], [null, null, null, null, null]);
});

test('Research evidence carries the document, page, box and model IDs it came from', async () => {
  const list = await pages('structure');
  const ref = documentRef({ name: 'structure.pdf', path: files['structure'], contentKey: sha256(files['structure']) });
  const found = research(list, 'Which figure is on page two?', ref);
  assert.equal(found.sufficient, true);
  const [e] = found.evidence;
  const prov = e.provenance;

  assert.equal(prov.source, SOURCES.document);
  assert.deepEqual({ ...prov.document }, { ...ref }, 'the document is the one being researched');
  assert.equal(prov.page, e.number);
  assert.equal(prov.page, 2);
  const run = list[1].runs.find((r) => r.id === e.id);
  assert.ok(run, 'the evidence is the model’s own text run');
  assert.deepEqual(prov.box, run.box, 'the box is the model’s, not measured again');
  assert.equal(prov.object.id, run.id);
  assert.equal(prov.object.kind, 'run');
  assert.equal(prov.object.blockId, run.blockId, 'and the block the run belongs to');
  assert.ok(prov.object.blockId, 'the model gives a run its block');
});

test('a paragraph’s provenance holds the runs it is made of', async () => {
  const list = await pages('structure');
  const found = research(list, 'figure two picture 1', documentRef({ name: 'structure.pdf', path: files['structure'] }));
  for (const e of found.evidence) {
    const model = e.kind === 'block' ? list[e.number - 1].blocks.find((b) => b.id === e.id) : list[e.number - 1].runs.find((r) => r.id === e.id);
    assert.ok(model, `the evidence ${e.id} is an object of the page model`);
    if (e.kind === 'block') assert.deepEqual(e.provenance.object.runIds, model.runIds);
    else assert.equal(e.provenance.object.blockId, model.blockId);
  }
});

test('Collection research evidence carries its document and page, with the host’s content key', async () => {
  const documents = collect('compare-a', 'compare-b');
  const found = await researchCollection({ documents, question: 'Where are the samples collected weekly?', readDocument });
  assert.equal(found.sufficient, true);
  assert.equal(found.evidence.length, 2);
  for (const e of found.evidence) {
    const doc = documents.find((d) => d.name === e.name);
    const prov = e.provenance;
    assert.equal(prov.source, SOURCES.collection, 'the source kind says which research found it');
    assert.equal(prov.document.name, doc.name);
    assert.equal(prov.document.path, doc.path);
    assert.equal(prov.document.contentKey, sha256(doc.path), 'the file as it was read, by the key the host gives for its bytes');
    assert.equal(prov.document.reference, 'content');
    assert.equal(prov.page, e.number);
    assert.deepEqual(prov.box, e.box);
    assert.equal(prov.object.id, e.id);
  }
  assert.notEqual(found.evidence[0].provenance.document.contentKey, found.evidence[1].provenance.document.contentKey,
    'each document keeps its own reference');
  assert.equal(provenanceLine(found.evidence[0].provenance), `compare-a.pdf · page 2 · ${found.evidence[0].id}`);
});

test('a reader that gives no content key leaves the document referenced by its path', async () => {
  const documents = collect('compare-a');
  const found = await researchCollection({
    documents,
    question: 'Where are the samples collected weekly?',
    async *readDocument(doc) { yield* documentPages(new Uint8Array(fs.readFileSync(doc.path))); },
  });
  const [e] = found.evidence;
  assert.equal(e.provenance.document.contentKey, null);
  assert.equal(e.provenance.document.reference, 'path');
  assert.equal(e.provenance.document.path, documents[0].path, 'the path is still there to open the file by');
});

test('provenance points at what navigation opens: the same path, page and box', async () => {
  const documents = collect('compare-a', 'compare-b');
  const found = await researchCollection({ documents, question: 'Where are the samples collected weekly?', readDocument });
  for (const e of found.evidence) {
    // app.js openEvidence({ path, number, box }) is what a chosen passage opens with.
    assert.equal(e.provenance.document.path, e.path);
    assert.equal(e.provenance.page, e.number);
    assert.deepEqual(e.provenance.box, e.box);
    assert.equal(e.box.length, 4);
  }
  // And the box is the one that page's model holds for that object.
  const [first] = found.evidence;
  const pagesOf = [];
  for await (const page of readDocument(documents[0])) pagesOf.push(page);
  const run = pagesOf[first.provenance.page - 1].runs.find((r) => r.id === first.provenance.object.id);
  assert.ok(run, 'the ID reaches the object on that page');
  assert.deepEqual(first.provenance.box, run.box);
});

test('export keeps every provenance field: the record is JSON as it stands', async () => {
  const documents = collect('compare-a');
  const found = await researchCollection({ documents, question: 'Where are the samples collected weekly?', readDocument });
  const [e] = found.evidence;
  const exported = JSON.parse(JSON.stringify(found));
  assert.deepEqual(exported.evidence[0].provenance, JSON.parse(JSON.stringify(e.provenance)));
  assert.deepEqual(Object.keys(exported.evidence[0].provenance).sort(), ['box', 'document', 'object', 'page', 'source', 'v']);
  assert.deepEqual(Object.keys(exported.evidence[0].provenance.document).sort(), ['contentKey', 'name', 'path', 'reference']);
  assert.deepEqual(Object.keys(exported.evidence[0].provenance.object).sort(), ['blockId', 'id', 'kind', 'runIds']);
  assert.equal(exported.evidence[0].provenance.document.contentKey, sha256(documents[0].path));
  assert.equal(exported.evidence[0].provenance.page, e.number);
  assert.deepEqual(exported.evidence[0].provenance.box, e.box);
  assert.equal(provenanceLine(exported.evidence[0].provenance), provenanceLine(e.provenance), 'the exported record reads back the same');
});

test('provenance is read-only and adds nothing to the model', async () => {
  const list = await pages('structure');
  const before = JSON.stringify(list);
  const found = research(list, 'Which figure is on page two?', documentRef({ name: 'structure.pdf', path: files['structure'] }));
  assert.equal(JSON.stringify(list), before, 'the page model is untouched');
  assert.ok(Object.isFrozen(found.evidence[0].provenance));
  assert.ok(Object.isFrozen(found.evidence[0].provenance.document));
});
