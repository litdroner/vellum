import { h } from '../dom.js';
import { icon } from '../icons.js';
import { EDGES, NODES, buildKnowledgeGraph, nodeDetail, relatedTo } from '../semantic/knowledge-graph.js';
import { provenanceDetail } from '../semantic/provenance.js';
import { showDialog } from './dialogs.js';

// The Document graph: what Vellum can prove about one document or one collection, listed by relationship
// (semantic/knowledge-graph.js). Read-only and derived on the spot from the collections the host already
// keeps and the research already shown — nothing is stored, nothing is searched, no file is opened to build
// it, and closing the dialog leaves nothing behind.
//
// A row that names a place in a document opens it there, through the same actions the rest of the app uses:
// a document or a page opens the file, a piece of evidence opens its document at its page with its box
// marked. A document that is gone stays listed as not found and can't be opened.

const ICONS = {
  [NODES.collection]: 'files',
  [NODES.document]: 'file-text',
  [NODES.page]: 'file',
  [NODES.evidence]: 'book-open',
};

/** The heading one group of relationships gets, from the focus's side of the edge. */
function groupTitle(group, focus) {
  const focusKind = focus?.kind ?? '';
  if (group.type === EDGES.memberOf) return group.direction === 'out' ? 'Is in' : 'Documents in this collection';
  if (group.type === EDGES.contains) return group.direction === 'out' ? 'Pages with evidence' : 'Is a page of';
  if (group.type === EDGES.from) return group.direction === 'out' ? 'Quoted from' : `Evidence quoted from this ${focusKind || 'source'}`;
  if (group.type === EDGES.hasProvenance) return group.direction === 'out' ? 'Recorded from' : 'Evidence recorded from this document';
  return group.label;
}

/** How the node on the other end of an edge reads, and what happens when the row is chosen. */
function row(node, onOpen) {
  const missing = node.kind === NODES.document && node.missing;
  const openable = !missing && (node.kind === NODES.document || node.kind === NODES.page || node.kind === NODES.evidence);
  const detail = [nodeDetail(node), node.kind === NODES.evidence ? provenanceDetail(node.provenance) : null].filter(Boolean).join('\n');
  const label = node.kind === NODES.evidence ? `“${node.text}”` : node.label;
  return h(openable ? 'button' : 'div', {
    class: `structure-row structure-item kg-node${openable ? '' : ' kg-inert'}`,
    role: 'listitem',
    ...(openable ? { type: 'button', onClick: () => onOpen(node) } : {}),
    'data-kind': node.kind,
    'data-missing': String(Boolean(missing)),
    title: [openable ? 'Open' : null, detail].filter(Boolean).join('\n') || label,
  },
  h('span', { class: 'kg-glyph', html: icon(missing ? 'file-x' : ICONS[node.kind] ?? 'file', 14) }),
  h('span', { class: 'kg-text' },
    h('span', { class: 'kg-label', text: label }),
    h('span', { class: 'kg-detail', text: nodeDetail(node) || (missing ? 'not found' : '') })));
}

/**
 * Shows the graph around `focus` ({ kind: 'collection', id, name } or { kind: 'document', path, name, … }).
 *
 *   collections  the host's `collections.list` result, as it was read
 *   evidence     the research already shown, if any (each item with its provenance)
 *   document     what the caller knows about a focused document beyond its path
 *   onOpen(node) opens a document, page or evidence node; the dialog closes first
 *
 * Resolves when the dialog closes. Nothing here changes a document, a collection or the research.
 */
export function showKnowledgeGraph({ focus, collections = [], evidence = [], document = null, onOpen = () => {} }) {
  const graph = buildKnowledgeGraph({ focus, collections, document, evidence });
  const focusNode = graph.nodes.find((n) => n.id === graph.focus) ?? null;
  const groups = relatedTo(graph);
  let finish = () => {};
  const open = (node) => { finish('close'); onOpen(node); };

  const body = h('div', { class: 'kg-body' });
  body.append(h('div', { class: 'kg-focus' },
    h('span', { class: 'kg-glyph', html: icon(ICONS[focusNode?.kind] ?? 'list-tree', 16) }),
    h('span', { class: 'kg-text' },
      h('span', { class: 'kg-label', text: focusNode?.label ?? 'Nothing selected' }),
      h('span', { class: 'kg-detail', text: nodeDetail(focusNode) }))));

  if (!groups.length) {
    body.append(h('p', { class: 'structure-hint kg-empty', text: 'Nothing is related to this yet. Documents relate through the collections that list them, and evidence through the research that quoted it.' }));
  }
  for (const group of groups) {
    body.append(h('div', { class: 'structure-props-title kg-heading', text: `${groupTitle(group, focusNode)} · ${group.items.length}` }));
    const list = h('div', { class: 'kg-group', role: 'list' });
    for (const { node } of group.items) list.append(row(node, open));
    body.append(list);
  }
  if (graph.missing.length) {
    body.append(h('p', { class: 'kg-note', text: `${graph.missing.length} document${graph.missing.length === 1 ? '' : 's'} not found. ${graph.missing.length === 1 ? 'It stays' : 'They stay'} listed here, as the collection still lists ${graph.missing.length === 1 ? 'it' : 'them'}.` }));
  }

  return showDialog({
    title: `Graph of “${focusNode?.label ?? ''}”`,
    message: 'What Vellum can prove about this one, from the collections that list it and the research already shown. Read-only: nothing is stored and no document is changed.',
    iconName: 'list-tree',
    className: 'knowledge-graph-dialog',
    content: [body],
    buttons: [{ id: 'close', label: 'Close', primary: true }],
    bind: (api) => { finish = api.finish; },
  }).then(() => graph);
}
