// The Document graph in the real app: a collection saved before Vellum starts holds two readable PDFs and a
// file that is gone. Graph on the home screen lists the collection's documents by relationship, keeps the
// missing one listed as not found, and opens the document a row names. The open document's own graph
// (Tools → Document graph) names the collection that lists it. Read-only: nothing is written.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const files = { 'report-a': 'compare-a', 'report-b': 'compare-b' };

export async function prepare({ dir }) {
  const seeded = [{
    id: 'documentgraph00000000000000000a',
    name: 'Graphed',
    createdAt: new Date().toISOString(),
    paths: [path.join(dir, 'report-a.pdf'), path.join(dir, 'report-b.pdf'), path.join(dir, 'no-such-file.pdf')],
  }];
  fs.writeFileSync(path.join(dir, 'data', 'collections.json'), JSON.stringify(seeded, null, 2));
  return {};
}

export async function run(t) {
  const { q, check, shot, V, settled, waitFor, area } = t;
  const A = t.file('report-a');
  const B = t.file('report-b');
  const hash = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  const before = Object.fromEntries([A, B].map((f) => [f, hash(f)]));
  const section = `[...document.querySelectorAll('.collection')].find((el) => el.querySelector('.collection-name').textContent === 'Graphed')`;
  const dialog = `document.querySelector('.knowledge-graph-dialog')`;
  const headings = `[...${dialog}.querySelectorAll('.kg-heading')].map((el) => el.textContent)`;
  const rows = `[...${dialog}.querySelectorAll('.kg-node')].map((el) => ({ kind: el.dataset.kind, missing: el.dataset.missing, label: el.querySelector('.kg-label').textContent, detail: el.querySelector('.kg-detail').textContent, button: el.tagName === 'BUTTON' }))`;

  for (const f of [A, B]) await waitFor(settled(f), 25000);
  for (const f of [A, B]) await q(`__vellum.app.close(${V(f)})`);
  await waitFor(`!__vellum.app.active && document.querySelector('.start')`, 8000);
  await q(`__vellum.ui.start.refresh()`);
  check('the collection saved before this run is on the home screen', await waitFor(`Boolean(${section})`, 8000));

  area('collection graph');
  await q(`[...${section}.querySelectorAll('button')].find((b) => b.textContent === 'Graph').click()`);
  check('Graph opens a read-only view of the collection', await waitFor(`Boolean(${dialog})`, 5000));
  check('… named after the collection it is the graph of',
    await q(`${dialog}.querySelector('.dialog-title').textContent === 'Graph of “Graphed”'`),
    await q(`${dialog}?.querySelector('.dialog-title')?.textContent`));
  check('… with one group per relationship, counted',
    (await q(headings)).join(' | ') === 'Documents in this collection · 3', JSON.stringify(await q(headings)));

  const listed = await q(rows);
  check('every document the collection lists is a node', listed.length === 3 && listed.every((r) => r.kind === 'document'), JSON.stringify(listed));
  check('… in the collection’s own order, each with its path',
    listed.map((r) => r.label).join(', ') === 'report-a.pdf, report-b.pdf, no-such-file.pdf'
    && listed[0].detail.includes(A), JSON.stringify(listed));

  area('missing');
  const gone = listed[2];
  check('the file that is gone stays in the graph, as not found', gone.missing === 'true' && gone.detail.includes('not found'), JSON.stringify(gone));
  check('… and it cannot be opened', gone.button === false, JSON.stringify(gone));
  check('the view says so once more, in words',
    (await q(`${dialog}.querySelector('.kg-note')?.textContent ?? ''`)).includes('1 document not found'),
    await q(`${dialog}.querySelector('.kg-note')?.textContent`));
  await shot('document-graph-collection');

  area('open');
  await q(`${dialog}.querySelector('.kg-node').click()`);
  check('choosing a document closes the graph', await waitFor(`!${dialog}`, 5000));
  check('… and opens that document', await waitFor(settled(A), 25000), A);

  area('document graph');
  // `void`: the action resolves only when the dialog closes, and the evaluation awaits what it returns.
  await q('void __vellum.actions.showDocumentGraph()');
  check('the open document has a graph of its own', await waitFor(`Boolean(${dialog})`, 8000));
  check('… named after the document', await q(`${dialog}.querySelector('.dialog-title').textContent === 'Graph of “report-a.pdf”'`),
    await q(`${dialog}?.querySelector('.dialog-title')?.textContent`));
  check('… saying which collection lists it', (await q(headings)).join(' | ') === 'Is in · 1', JSON.stringify(await q(headings)));
  const owner = await q(rows);
  check('… and naming that collection', owner.length === 1 && owner[0].kind === 'collection' && owner[0].label === 'Graphed', JSON.stringify(owner));
  await shot('document-graph-document');
  await q(`${dialog}?.querySelector('.dialog-actions button')?.click()`);
  check('Close puts the graph away', await waitFor(`!${dialog}`, 5000));

  area('read-only');
  check('nothing is waiting to be saved', await q(`!${V(A)}.annotations.dirty`));
  check('every PDF in the collection is on disk, unchanged', [A, B].every((f) => fs.existsSync(f) && hash(f) === before[f]));
  check('the collection itself is unchanged',
    JSON.parse(fs.readFileSync(path.join(t.dir, 'data', 'collections.json'), 'utf8'))[0].paths.length === 3);
  check('no runtime errors', (await q('JSON.stringify(__vellum.errors)')) === '[]', await q('JSON.stringify(__vellum.errors)'));
}
