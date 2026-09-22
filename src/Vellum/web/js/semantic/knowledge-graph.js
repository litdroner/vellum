// The document graph: the relationships Vellum can already prove, said once, in one shape. Nothing here is
// stored, indexed or learned — the graph is built from what the caller already holds and thrown away again:
//
//   collections   the host's `collections.list` (Services/DocumentCollections.cs): named lists of file paths
//   document      the open document, as the view knows it (name, path, page count, content key)
//   evidence      Research (semantic/research.js) or Collection research (semantic/collection-research.js)
//                 passages, each with its provenance (semantic/provenance.js)
//
// Four kinds of node and four kinds of edge, and nothing else:
//
//   document MEMBER_OF collection       a collection lists that file's path
//   document CONTAINS page              a page of that document the graph has something to show for
//   evidence FROM page (or document)    the passage was quoted from there
//   evidence HAS_PROVENANCE document    the provenance record: how the file was referenced when it was read,
//                                       and the semantic model's IDs for the passage, when it carries them
//
// What this is not: a second document index, a second identity, or a source of truth. A document is matched
// by the path the collection already holds (case-insensitively, as the host matches it) — that is a matching
// key, not an identity; `contentKey` still means only what provenance.js says it means. Nothing is inferred:
// two documents are not "related" because they read alike, only because a collection lists both. A file that
// is gone stays in the graph as a document node with `missing: true`, exactly as the collection still lists it.
//
// Pure: no reading, no writing, no network, no state, and the same input always gives the same graph.

import { PROVENANCE_VERSION } from './provenance.js';

export const GRAPH_VERSION = 1;

export const NODES = Object.freeze({
  collection: 'collection',
  document: 'document',
  page: 'page',
  evidence: 'evidence',
});

export const EDGES = Object.freeze({
  memberOf: 'MEMBER_OF',
  contains: 'CONTAINS',
  from: 'FROM',
  hasProvenance: 'HAS_PROVENANCE',
});

/** How an edge reads in the view. One line per edge kind, nothing generated. */
export const EDGE_LABELS = Object.freeze({
  [EDGES.memberOf]: 'is in',
  [EDGES.contains]: 'contains',
  [EDGES.from]: 'quoted from',
  [EDGES.hasProvenance]: 'recorded from',
});

const text = (value) => (typeof value === 'string' && value ? value : null);
const pageNumber = (value) => (Number.isInteger(value) && value > 0 ? value : null);

/**
 * The key two paths are the same file by: the path the collection already holds, case-folded and with its
 * separators settled, the way the host compares them. A matching key only — it says nothing about the bytes.
 */
export function documentKey(path) {
  const value = text(path);
  return value ? value.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase() : null;
}

const fileName = (path) => (text(path) ? path.slice(Math.max(path.lastIndexOf('\\'), path.lastIndexOf('/')) + 1) : null);

const documentId = (key) => `document:${key}`;
const collectionId = (id) => `collection:${id}`;
const pageId = (key, number) => `document:${key}#page:${number}`;

/** The page an evidence item is on, whichever of the shapes Research hands over. */
const evidencePage = (item) => pageNumber(item?.number) ?? pageNumber(item?.page) ?? pageNumber(item?.provenance?.page);

/** The file an evidence item came from: its own path, or its provenance's. */
const evidencePath = (item) => text(item?.path) ?? text(item?.provenance?.document?.path);

class Graph {
  constructor() {
    this.nodes = new Map();
    this.edges = new Map();
  }

  node(id, make) {
    const existing = this.nodes.get(id);
    if (existing) return existing;
    const created = { id, ...make() };
    this.nodes.set(id, created);
    return created;
  }

  edge(type, from, to, extra = {}) {
    if (!from || !to || !this.nodes.has(from) || !this.nodes.has(to)) return null;
    const id = `${type}:${from}->${to}`;
    if (this.edges.has(id)) return this.edges.get(id);
    const created = { id, type, label: EDGE_LABELS[type] ?? type, from, to, ...extra };
    this.edges.set(id, created);
    return created;
  }
}

/** A document node from whatever the caller knows about the file. Later facts fill in what was null. */
function documentNode(graph, { path, name = null, exists = true, pages = null, contentKey = null } = {}) {
  const key = documentKey(path);
  if (!key) return null;
  const node = graph.node(documentId(key), () => ({
    kind: NODES.document,
    key,
    label: text(name) ?? fileName(path) ?? path,
    path: text(path),
    missing: exists === false,
    pageCount: pageNumber(pages),
    contentKey: text(contentKey),
  }));
  if (exists === false) node.missing = true;
  if (node.pageCount == null) node.pageCount = pageNumber(pages);
  if (node.contentKey == null) node.contentKey = text(contentKey);
  return node;
}

/** A page of a document, made only when the graph has something to show for it, with its CONTAINS edge. */
function pageNode(graph, doc, number) {
  if (!doc || !pageNumber(number)) return null;
  const node = graph.node(pageId(doc.key, number), () => ({
    kind: NODES.page,
    label: `Page ${number}`,
    number,
    path: doc.path,
    document: doc.id,
  }));
  graph.edge(EDGES.contains, doc.id, node.id);
  return node;
}

/**
 * The graph around one document or one collection.
 *
 *   focus        { kind: 'document', path, name?, pages?, contentKey? } or { kind: 'collection', id, name? }
 *   collections  [{ id, name, documents: [{ path, exists, pages }] }] — the host's list, read only
 *   document     what the caller knows about the focused document beyond its path (page count, content key)
 *   evidence     research passages to place; each is kept only when the graph can prove which document it
 *                came from and that document is already in the graph
 *
 * Returns { v, provenanceVersion, focus, nodes, edges, missing } — frozen, JSON-safe and deterministic:
 * the focus node first, then nodes in the order they were proven, edges in the order they were made.
 */
export function buildKnowledgeGraph({ focus = null, collections = [], document = null, evidence = [] } = {}) {
  const graph = new Graph();
  const list = Array.isArray(collections) ? collections : [];
  let focusId = null;

  if (focus?.kind === NODES.collection) {
    const found = list.find((c) => c?.id === focus.id) ?? null;
    const label = text(found?.name) ?? text(focus.name) ?? 'Collection';
    focusId = graph.node(collectionId(focus.id), () => ({ kind: NODES.collection, label, collectionId: focus.id })).id;
  } else if (focus?.path) {
    focusId = documentNode(graph, { ...(document ?? {}), path: focus.path, name: focus.name ?? document?.name, pages: focus.pages ?? document?.pages, contentKey: focus.contentKey ?? document?.contentKey })?.id ?? null;
  }

  // Collection membership, from the collections themselves. Every document a focused collection lists joins
  // the graph; for a focused document, only the collections that already list it do.
  for (const collection of list) {
    if (!collection?.id) continue;
    const documents = Array.isArray(collection.documents) ? collection.documents : [];
    const id = collectionId(collection.id);
    const focused = id === focusId;
    const members = documents.filter((d) => {
      const key = documentKey(d?.path);
      return key && (focused || graph.nodes.has(documentId(key)));
    });
    if (!focused && !members.length) continue;
    graph.node(id, () => ({ kind: NODES.collection, label: text(collection.name) ?? 'Collection', collectionId: collection.id }));
    for (const member of members) {
      const node = documentNode(graph, { path: member.path, name: member.name, exists: member.exists !== false, pages: member.pages });
      if (node) graph.edge(EDGES.memberOf, node.id, id);
    }
  }

  // Evidence, and the pages it proves. A passage from a document the focus doesn't reach is left out: the
  // graph never adds a document on evidence alone.
  const items = Array.isArray(evidence) ? evidence : [];
  for (const [index, item] of items.entries()) {
    const key = documentKey(evidencePath(item));
    const doc = key ? graph.nodes.get(documentId(key)) : null;
    const quote = text(item?.text);
    if (!doc || !quote) continue;
    const number = evidencePage(item);
    const id = `evidence:${doc.key}#${number ?? 0}#${text(item?.id) ?? text(item?.provenance?.object?.id) ?? index}`;
    if (graph.nodes.has(id)) continue;
    const node = graph.node(id, () => ({
      kind: NODES.evidence,
      label: quote,
      text: quote,
      matched: Array.isArray(item?.matched) ? [...item.matched] : [],
      number,
      path: doc.path,
      box: Array.isArray(item?.box) && item.box.length === 4 ? [...item.box] : null,
      source: text(item?.provenance?.source),
      provenance: item?.provenance ?? null,
      document: doc.id,
    }));
    const on = pageNode(graph, doc, number);
    graph.edge(EDGES.from, node.id, on?.id ?? doc.id);
    if (item?.provenance) {
      graph.edge(EDGES.hasProvenance, node.id, doc.id, {
        reference: text(item.provenance.document?.reference),
        contentKey: text(item.provenance.document?.contentKey),
        object: item.provenance.object ?? null,
      });
    }
  }

  const all = [...graph.nodes.values()];
  const ordered = focusId ? [graph.nodes.get(focusId), ...all.filter((n) => n.id !== focusId)].filter(Boolean) : all;
  return Object.freeze({
    v: GRAPH_VERSION,
    provenanceVersion: PROVENANCE_VERSION,
    focus: focusId,
    nodes: Object.freeze(ordered.map((n) => Object.freeze({ ...n }))),
    edges: Object.freeze([...graph.edges.values()].map((e) => Object.freeze({ ...e }))),
    missing: Object.freeze(ordered.filter((n) => n.kind === NODES.document && n.missing).map((n) => n.id)),
  });
}

/**
 * The graph as the view lists it: one group per relationship a node takes part in, each with the nodes on
 * the other end. Nothing is ranked, scored or hidden — the order is the graph's.
 */
export function relatedTo(graph, nodeId = graph?.focus) {
  if (!graph || !nodeId) return [];
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const groups = new Map();
  for (const edge of graph.edges) {
    const outward = edge.from === nodeId;
    if (!outward && edge.to !== nodeId) continue;
    const other = byId.get(outward ? edge.to : edge.from);
    if (!other) continue;
    const key = `${edge.type}:${outward ? 'out' : 'in'}`;
    if (!groups.has(key)) groups.set(key, { type: edge.type, direction: outward ? 'out' : 'in', label: edge.label, items: [] });
    groups.get(key).items.push({ edge, node: other });
  }
  return [...groups.values()];
}

/** How a node reads on one line, with what the graph can say about it and nothing more. */
export function nodeDetail(node) {
  if (!node) return '';
  if (node.kind === NODES.document) {
    return [node.path, node.missing ? 'not found' : null, node.pageCount ? `${node.pageCount} pages` : null].filter(Boolean).join(' · ');
  }
  if (node.kind === NODES.page) return [fileName(node.path), `page ${node.number}`].filter(Boolean).join(' · ');
  if (node.kind === NODES.evidence) {
    return [fileName(node.path), node.number ? `page ${node.number}` : null, node.provenance?.object?.id ?? null].filter(Boolean).join(' · ');
  }
  return '';
}
