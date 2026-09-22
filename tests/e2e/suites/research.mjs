// Research in the real app: the Structure tab's Research mode over the two-page structure document. A
// question gives evidence quoted from the document with its page, under Vellum's summary; selecting a
// passage goes to its page and marks its box; a question the document can't answer says so; nothing in the
// document changes. Each passage also carries its provenance (semantic/provenance.js): the document as the
// host identified it when its bytes were read, the page, the box and the model IDs — and that record survives
// being exported as JSON.

import fs from 'node:fs';
import crypto from 'node:crypto';

export const files = { structure: 'structure' };

export async function run(t) {
  const { c, q, check, shot, V, settled, waitFor, area } = t;
  const DOC = t.file('structure');
  const hash = () => crypto.createHash('sha256').update(fs.readFileSync(DOC)).digest('hex');
  const original = hash();
  const input = `document.querySelector('.structure-search-input')`;
  const research = `__vellum.ui.sidebar.structure?.research`;
  const ask = async (text) => {
    await q(`(() => { const i = ${input}; i.focus(); i.select(); })()`);
    await c.key('Ctrl+A');
    await c.type(text);
  };

  await waitFor(settled(DOC), 25000);
  const errorsBefore = await q(`__vellum.errors?.length ?? 0`);
  await q(`__vellum.ui.sidebar.showResearch()`);
  check('Research opens the Structure tab asking a question', await waitFor(`Boolean(${input}) && ${input}.placeholder === 'Ask a research question'`, 10000));

  area('evidence');
  await ask('Which figure is on page two?');
  check('the question gives evidence', await waitFor(`${research}?.sufficient === true`, 15000), JSON.stringify(await q(research)));
  const found = await q(research);
  check('evidence is the document’s own passage, with its page', JSON.stringify(found.evidence.map((e) => [e.page, e.text])) === JSON.stringify([[2, 'A figure on page two']]), JSON.stringify(found.evidence));
  check('the summary is marked as Vellum’s, the evidence as quoted', await q(`[...document.querySelectorAll('.research-heading')].map((h) => h.textContent).join(' | ') === 'Summary · by Vellum, from the matches | Evidence · quoted from the document'`));
  check('the evidence row shows its page', await q(`document.querySelector('.research-evidence .research-source').textContent.startsWith('Page 2 ·')`));
  await q(`${V(DOC)}.goToPage(1)`);
  await waitFor(`${V(DOC)}.state.pageNumber === 1`, 3000);
  await q(`document.querySelector('.research-evidence').click()`);
  check('selecting evidence goes to its page', await waitFor(`${V(DOC)}.state.pageNumber === 2`, 3000));
  check('and marks its box there', await waitFor(`document.querySelector('.structure-mark')?.closest('.page')?.dataset.pageNumber === '2'`, 2000));
  await shot('research-evidence');

  area('provenance');
  const [item] = found.evidence;
  const prov = item.provenance;
  check('evidence carries provenance', Boolean(prov), JSON.stringify(item));
  check('it names the source kind', prov?.source === 'document-research', prov?.source);
  check('it references the open document by name, path and the host’s content key',
    prov?.document.name === (await q(`${V(DOC)}.file.name`))
    && prov.document.path.toLowerCase() === DOC.toLowerCase()
    && prov.document.contentKey === (await q(`${V(DOC)}.docKey ?? null`))
    && /^[0-9A-F]{64}$/.test(prov.document.contentKey ?? '')
    && prov.document.reference === 'content', JSON.stringify(prov?.document));
  check('it holds the page, the box and the model’s IDs',
    prov?.page === item.page && prov.page === 2
    && Array.isArray(prov.box) && prov.box.length === 4
    && prov.object.id === item.id && prov.object.kind === 'run' && typeof prov.object.blockId === 'string',
    JSON.stringify(prov));
  check('the page it names is the page navigation just reached',
    await q(`(() => { const p = ${research}.evidence[0].provenance; const m = document.querySelector('.structure-mark'); return Boolean(m) && m.closest('.page').dataset.pageNumber === String(p.page); })()`));
  check('the evidence row shows where it came from', await q(`document.querySelector('.research-evidence').title.includes('page 2')`),
    await q(`document.querySelector('.research-evidence').title`));
  check('the result exports as JSON without losing a provenance field',
    await q(`(() => { const r = ${research}; const back = JSON.parse(JSON.stringify(r)); return JSON.stringify(back.evidence[0].provenance) === JSON.stringify(r.evidence[0].provenance) && back.document.contentKey === r.document.contentKey; })()`));

  area('insufficient');
  await ask('What is the transformer architecture?');
  check('a question the document can’t answer says so', await waitFor(`${research}?.sufficient === false`, 15000), JSON.stringify(await q(research)));
  check('with no evidence listed', await q(`${research}.evidence.length === 0 && ${research}.summary.startsWith('Not enough evidence in this document')`));
  await shot('research-insufficient');

  area('clear');
  await q(`document.querySelector('button[aria-label="Research"]').click()`);
  check('Research off: the field searches again', await waitFor(`${input}.placeholder === 'Search structure'`, 3000));
  check('nothing to save, the file unchanged', (await q(`!${V(DOC)}.annotations.dirty`)) && hash() === original);
  const errors = await q(`JSON.stringify(__vellum.errors?.slice(${errorsBefore}) ?? [])`);
  check('no errors', errors === '[]', errors);
}
