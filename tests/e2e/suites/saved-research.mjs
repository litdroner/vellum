// Saved research in the real app: a research result kept from the Structure panel, listed on the home screen,
// opened again with the same evidence — without the question being asked or the document read a second time —
// and deleted. The document is never modified.

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
  const saved = `document.querySelector('.saved-research')`;
  const item = `${saved}?.querySelector('.saved-item')`;
  const dialog = `document.querySelector('.saved-research-dialog')`;
  const button = (label) => `[...document.querySelectorAll('.dialog-actions button')].find((b) => b.textContent === ${JSON.stringify(label)})`;

  await waitFor(settled(DOC), 25000);
  const errorsBefore = await q(`__vellum.errors?.length ?? 0`);

  area('save');
  await q(`__vellum.ui.sidebar.showResearch()`);
  await waitFor(`Boolean(${input}) && ${input}.placeholder === 'Ask a research question'`, 10000);
  await q(`(() => { const i = ${input}; i.focus(); i.select(); })()`);
  await c.key('Ctrl+A');
  await c.type('Which figure is on page two?');
  check('the question gives evidence', await waitFor(`${research}?.sufficient === true`, 15000), JSON.stringify(await q(research)));
  const found = await q(research);
  check('Save this research is offered beside the evidence',
    await q(`(() => { const b = document.querySelector('button[aria-label="Save this research"]'); return Boolean(b) && !b.hidden && !b.disabled; })()`));
  await q(`document.querySelector('button[aria-label="Save this research"]').click()`);
  check('it asks for a name, offering the question', await waitFor(`document.querySelector('.dialog input.field')?.value === 'Which figure is on page two?'`, 5000),
    await q(`document.querySelector('.dialog input.field')?.value`));
  await q(`(() => { const i = document.querySelector('.dialog input.field'); i.value = 'Figures on page two'; })()`);
  await q(`${button('Save')}.click()`);
  check('it is saved', await waitFor(`!document.querySelector('.dialog input.field')`, 5000));

  area('home');
  await q(`__vellum.app.close(${V(DOC)})`);
  await waitFor(`!__vellum.app.active && document.querySelector('.start')`, 8000);
  await q(`__vellum.ui.start.refresh()`);
  check('the home screen lists it under Saved research', await waitFor(`${item}?.querySelector('.collection-name')?.textContent === 'Figures on page two'`, 8000),
    await q(`${saved}?.outerHTML?.slice(0, 300) ?? 'no section'`));
  const meta = await q(`${item}.querySelector('.collection-meta').textContent`);
  check('with what it was asked of and how much it found', meta === 'Document · structure.pdf · 1 passage', meta);
  await shot('saved-research-home');

  area('open');
  const readsBefore = await q(`__vellum.app.views.length`);
  await q(`[...${item}.querySelectorAll('.link-btn')].find((b) => b.textContent === 'Open').click()`);
  check('it opens read-only, with the evidence as it was saved', await waitFor(`Boolean(${dialog})`, 5000));
  check('the same passage, quoted word for word',
    await q(`${dialog}.querySelector('.research-quote').textContent`) === `“${found.evidence[0].text}”`,
    await q(`${dialog}.querySelector('.research-quote')?.textContent`));
  check('the summary is the one Vellum wrote then, not a new one',
    await q(`${dialog}.querySelector('.research-summary').textContent`) === found.summary,
    await q(`${dialog}.querySelector('.research-summary')?.textContent`));
  check('the heading says it is quoted as it was saved',
    await q(`[...${dialog}.querySelectorAll('.research-heading')].some((h) => h.textContent === 'Evidence · quoted as it was saved')`));
  check('no document was opened or read to show it', await q(`__vellum.app.views.length`) === readsBefore);
  await shot('saved-research-open');

  area('navigate');
  check('the passage is openable (its document is still there)',
    await q(`${dialog}.querySelector('.cr-evidence').tagName === 'BUTTON' && ${dialog}.querySelector('.cr-evidence').dataset.missing === 'false'`),
    await q(`(() => { const r = ${dialog}.querySelector('.cr-evidence'); return JSON.stringify({ tag: r.tagName, missing: r.dataset.missing, title: r.title }); })()`));
  await q(`${dialog}.querySelector('.cr-evidence').click()`);
  await waitFor(`!${dialog}`, 4000);
  check('choosing a passage opens its document at its page', await waitFor(`${V(DOC)} && ${V(DOC)}.state.pageNumber === ${found.evidence[0].page}`, 20000),
    await q(`JSON.stringify({ views: __vellum.app.views.map((v) => [v.file.path, v.status, v.state?.pageNumber]), toast: document.querySelector('.toast')?.textContent ?? null })`));
  check('and marks its box there', await waitFor(`document.querySelector('.structure-mark')?.closest('.page')?.dataset.pageNumber === '${found.evidence[0].page}'`, 4000));

  area('delete');
  await q(`__vellum.app.close(${V(DOC)})`);
  await waitFor(`!__vellum.app.active && document.querySelector('.start')`, 8000);
  await q(`__vellum.ui.start.refresh()`);
  await waitFor(`Boolean(${item})`, 8000);
  await q(`[...${item}.querySelectorAll('.link-btn')].find((b) => b.textContent === 'Delete').click()`);
  check('deleting says the documents aren’t touched',
    await waitFor(`document.querySelector('.dialog-message')?.textContent.includes('stay where they are')`, 4000));
  await q(`${button('Delete saved research')}.click()`);
  check('the saved research is gone from the home screen', await waitFor(`!${item}`, 8000));
  check('the document was never modified', hash() === original);
  const errors = await q(`JSON.stringify(__vellum.errors?.slice(${errorsBefore}) ?? [])`);
  check('no errors', errors === '[]', errors);
}
