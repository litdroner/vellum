// The document graph (semantic/knowledge-graph.js): the relationships Vellum can already prove, derived from
// the collections the host keeps and the research already shown. Nothing is stored and nothing is inferred —
// these tests check that the nodes and edges are exactly what the inputs support, that collection membership
// is the collection's own, that evidence points back at the document and page its provenance names, and that
// a document that is gone stays in the graph as missing.
// Run: node --test tests/editing/knowledge-graph.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { webModule } from './harness.mjs';

const { EDGES, NODES, buildKnowledgeGraph, documentKey, nodeDetail, relatedTo } = await webModule('semantic/knowledge-graph.js');
const { documentRef, evidenceProvenance, SOURCES } = await webModule('semantic/provenance.js');

const REPORT = 'C:\\Docs\\report.pdf';
const NOTES = 'C:\\Docs\\notes.pdf';
const GONE = 'C:\\Docs\\gone.pdf';

const collections = () => [
  {
    id: 'c1',
    name: 'Fieldwork',
    documents: [
      { path: REPORT, name: 'report.pdf', exists: true, pages: 12 },
      { path: NOTES, name: 'notes.pdf', exists: true, pages: 4 },
      { path: GONE, name: 'gone.pdf', exists: false, pages: null },
    ],
  },
  { id: 'c2', name: 'Archive', documents: [{ path: REPORT, name: 'report.pdf', exists: true, pages: 12 }] },
  { id: 'c3', name: 'Unrelated', documents: [{ path: 'C:\\Other\\x.pdf', name: 'x.pdf', exists: true }] },
];

/** A passage as Research hands it over, with the provenance record it already carries. */
function passage({ path, name, page, text, id = 'p1:run:1', matched = ['samples'], contentKey = null }) {
  const candidate = { id, kind: 'run', number: page, text, box: [10, 20, 100, 32], matched, blockId: 'p1:block:1', runIds: [id] };
  return {
    ...candidate,
    path,
    name,
    provenance: evidenceProvenance(candidate, { document: documentRef({ name, path, contentKey }), source: SOURCES.collection }),
  };
}

const edgesOf = (graph, type) => graph.edges.filter((e) => e.type === type).map((e) => [e.from, e.to]);
const node = (graph, id) => graph.nodes.find((n) => n.id === id) ?? null;

test('a collection graph holds the collection, its documents and nothing else', () => {
  const graph = buildKnowledgeGraph({ focus: { kind: NODES.collection, id: 'c1' }, collections: collections() });
  assert.equal(graph.focus, 'collection:c1');
  assert.equal(graph.nodes[0].label, 'Fieldwork', 'the focus comes first');
  assert.deepEqual(graph.nodes.map((n) => n.kind), [NODES.collection, NODES.document, NODES.document, NODES.document, NODES.collection]);
  // Archive joins because it lists report.pdf; Unrelated shares no document, so it is not in the graph.
  assert.deepEqual(graph.nodes.filter((n) => n.kind === NODES.collection).map((n) => n.label), ['Fieldwork', 'Archive']);
  assert.deepEqual(edgesOf(graph, EDGES.memberOf), [
    [`document:${documentKey(REPORT)}`, 'collection:c1'],
    [`document:${documentKey(NOTES)}`, 'collection:c1'],
    [`document:${documentKey(GONE)}`, 'collection:c1'],
    [`document:${documentKey(REPORT)}`, 'collection:c2'],
  ]);
  assert.deepEqual(edgesOf(graph, EDGES.contains), [], 'no page has anything to show yet');
  assert.equal(node(graph, `document:${documentKey(REPORT)}`).pageCount, 12);
});

test('a document graph holds only the collections that list that document', () => {
  const graph = buildKnowledgeGraph({
    focus: { kind: NODES.document, path: REPORT, name: 'report.pdf' },
    document: { path: REPORT, name: 'report.pdf', pages: 12, contentKey: 'a'.repeat(64) },
    collections: collections(),
  });
  assert.equal(graph.focus, `document:${documentKey(REPORT)}`);
  assert.deepEqual(graph.nodes.filter((n) => n.kind === NODES.collection).map((n) => n.label), ['Fieldwork', 'Archive']);
  assert.deepEqual(graph.nodes.filter((n) => n.kind === NODES.document).map((n) => n.path), [REPORT], 'the other documents of those collections are not pulled in');
  assert.deepEqual(edgesOf(graph, EDGES.memberOf), [
    [`document:${documentKey(REPORT)}`, 'collection:c1'],
    [`document:${documentKey(REPORT)}`, 'collection:c2'],
  ]);
  assert.equal(node(graph, graph.focus).contentKey, 'a'.repeat(64));
});

test('a path is matched the way the host matches it, and a document is never doubled', () => {
  const graph = buildKnowledgeGraph({
    focus: { kind: NODES.document, path: 'c:/docs/REPORT.pdf', name: 'REPORT.pdf' },
    collections: collections(),
  });
  assert.equal(graph.nodes.filter((n) => n.kind === NODES.document).length, 1);
  assert.deepEqual(graph.nodes.filter((n) => n.kind === NODES.collection).map((n) => n.label), ['Fieldwork', 'Archive']);
});

test('evidence links to the document and page its provenance names', () => {
  const evidence = [
    passage({ path: REPORT, name: 'report.pdf', page: 3, text: 'Samples were collected weekly', id: 'p3:run:7' }),
    passage({ path: NOTES, name: 'notes.pdf', page: 1, text: 'Samples arrive on Mondays', id: 'p1:run:2', contentKey: 'b'.repeat(64) }),
  ];
  const graph = buildKnowledgeGraph({ focus: { kind: NODES.collection, id: 'c1' }, collections: collections(), evidence });
  const reportId = `document:${documentKey(REPORT)}`;
  const notesId = `document:${documentKey(NOTES)}`;

  assert.deepEqual(edgesOf(graph, EDGES.contains), [[reportId, `${reportId}#page:3`], [notesId, `${notesId}#page:1`]]);
  assert.deepEqual(edgesOf(graph, EDGES.from), [
    [`evidence:${documentKey(REPORT)}#3#p3:run:7`, `${reportId}#page:3`],
    [`evidence:${documentKey(NOTES)}#1#p1:run:2`, `${notesId}#page:1`],
  ]);
  assert.deepEqual(edgesOf(graph, EDGES.hasProvenance), [
    [`evidence:${documentKey(REPORT)}#3#p3:run:7`, reportId],
    [`evidence:${documentKey(NOTES)}#1#p1:run:2`, notesId],
  ]);

  const provenanceEdge = graph.edges.find((e) => e.type === EDGES.hasProvenance && e.to === notesId);
  assert.equal(provenanceEdge.reference, 'content', 'the file was referenced by the bytes that were read');
  assert.equal(provenanceEdge.contentKey, 'b'.repeat(64));
  assert.deepEqual(provenanceEdge.object, { id: 'p1:run:2', kind: 'run', blockId: 'p1:block:1', runIds: ['p1:run:2'] });

  const quote = node(graph, `evidence:${documentKey(REPORT)}#3#p3:run:7`);
  assert.equal(quote.text, 'Samples were collected weekly');
  assert.equal(quote.number, 3);
  assert.deepEqual(quote.box, [10, 20, 100, 32]);
  assert.equal(nodeDetail(quote), 'report.pdf · page 3 · p3:run:7');
});

test('evidence from a document the focus does not reach is left out', () => {
  const evidence = [passage({ path: 'C:\\Other\\x.pdf', name: 'x.pdf', page: 2, text: 'Something else' })];
  const graph = buildKnowledgeGraph({ focus: { kind: NODES.collection, id: 'c1' }, collections: collections(), evidence });
  assert.deepEqual(graph.nodes.filter((n) => n.kind === NODES.evidence), []);
  assert.deepEqual(graph.nodes.filter((n) => n.path === 'C:\\Other\\x.pdf'), []);
});

test('a document that is gone stays in the graph, as missing', () => {
  const graph = buildKnowledgeGraph({ focus: { kind: NODES.collection, id: 'c1' }, collections: collections() });
  const gone = node(graph, `document:${documentKey(GONE)}`);
  assert.equal(gone.missing, true);
  assert.equal(gone.label, 'gone.pdf');
  assert.deepEqual(graph.missing, [`document:${documentKey(GONE)}`]);
  assert.match(nodeDetail(gone), /not found/);
  assert.ok(graph.edges.some((e) => e.type === EDGES.memberOf && e.from === gone.id), 'it is still listed by its collection');
});

test('the same graph twice is the same graph, and it is frozen', () => {
  const evidence = [passage({ path: REPORT, name: 'report.pdf', page: 3, text: 'Samples were collected weekly', id: 'p3:run:7' })];
  const once = buildKnowledgeGraph({ focus: { kind: NODES.collection, id: 'c1' }, collections: collections(), evidence });
  const twice = buildKnowledgeGraph({ focus: { kind: NODES.collection, id: 'c1' }, collections: collections(), evidence });
  assert.deepEqual(JSON.parse(JSON.stringify(once)), JSON.parse(JSON.stringify(twice)));
  assert.equal(Object.isFrozen(once), true);
  assert.equal(Object.isFrozen(once.nodes[0]), true);
});

test('the view lists the focus’s relationships, each with the nodes on the other end', () => {
  const evidence = [passage({ path: REPORT, name: 'report.pdf', page: 3, text: 'Samples were collected weekly', id: 'p3:run:7' })];
  const graph = buildKnowledgeGraph({ focus: { kind: NODES.collection, id: 'c1' }, collections: collections(), evidence });
  const groups = relatedTo(graph);
  assert.deepEqual(groups.map((g) => [g.type, g.direction, g.items.length]), [[EDGES.memberOf, 'in', 3]]);
  assert.deepEqual(groups[0].items.map(({ node: n }) => n.label), ['report.pdf', 'notes.pdf', 'gone.pdf']);

  const onReport = relatedTo(graph, `document:${documentKey(REPORT)}`);
  assert.deepEqual(onReport.map((g) => [g.type, g.direction, g.items.length]), [
    [EDGES.memberOf, 'out', 2],
    [EDGES.contains, 'out', 1],
    [EDGES.hasProvenance, 'in', 1],
  ]);
});

test('nothing at all still gives a graph, and an unknown focus gives an empty one', () => {
  const empty = buildKnowledgeGraph();
  assert.equal(empty.focus, null);
  assert.deepEqual(empty.nodes, []);
  assert.deepEqual(empty.edges, []);
  const unknown = buildKnowledgeGraph({ focus: { kind: NODES.collection, id: 'nope' }, collections: collections() });
  assert.equal(unknown.focus, 'collection:nope');
  assert.deepEqual(unknown.nodes.map((n) => n.id), ['collection:nope']);
  assert.deepEqual(relatedTo(unknown), []);
});
