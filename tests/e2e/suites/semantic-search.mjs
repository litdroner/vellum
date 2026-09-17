// Semantic search in the real app: the Structure tab's search over a two-page document with text, a
// paragraph, a form field, a note, a link and a picture. Words, then kinds (images, form fields, links) and
// an editable filter; Enter, Shift+Enter and the Next button step through results, each going to its page,
// showing its properties and marking its box over the object itself; Escape brings the tree back; and
// nothing in the document changes.

import fs from 'node:fs';
import crypto from 'node:crypto';

export const files = { structure: 'structure' };

export async function run(t) {
  const { c, q, check, sleep, shot, V, settled, waitFor, area } = t;
  const DOC = t.file('structure');
  const hash = () => crypto.createHash('sha256').update(fs.readFileSync(DOC)).digest('hex');
  const original = hash();
  const input = `document.querySelector('.structure-search-input')`;
  const status = `document.querySelector('.structure-search-status')?.textContent`;
  const title = `document.querySelector('.structure-props-title')?.textContent`;
  const results = () => q(`[...document.querySelectorAll('.structure-result')].map((r) => r.querySelector('.structure-count').textContent + ' ' + r.querySelector('.structure-kind').textContent + ': ' + r.querySelector('.structure-label').textContent)`);
  const selected = `document.querySelector('.structure-result[aria-selected="true"] .structure-label')?.textContent`;
  const markPage = () => q(`document.querySelector('.structure-mark')?.closest('.page')?.dataset.pageNumber ?? null`);
  const overlap = (target) => q(`(() => {
    const m = document.querySelector('.structure-mark')?.getBoundingClientRect();
    const o = (${target})?.getBoundingClientRect();
    if (!m || !o) return null;
    const w = Math.max(0, Math.min(m.right, o.right) - Math.max(m.left, o.left));
    const h = Math.max(0, Math.min(m.bottom, o.bottom) - Math.max(m.top, o.top));
    return { ofTarget: (w * h) / (o.width * o.height), ofMark: (w * h) / (m.width * m.height) };
  })()`);
  const searchFor = async (text) => {
    await q(`(() => { const i = ${input}; i.focus(); i.select(); })()`);
    await c.key('Ctrl+A');
    await c.type(text);
  };

  await waitFor(settled(DOC), 25000);
  const errorsBefore = await q(`__vellum.errors?.length ?? 0`);
  await q(`__vellum.ui.sidebar.showStructure()`);
  check('the Structure tab has a search field', await waitFor(`Boolean(${input}) && document.querySelector('.structure-page[data-page="1"]')?.dataset.read === ''`, 10000));

  area('words');
  await searchFor('figure');
  check('words find text and a note’s contents on both pages', await waitFor(`${status} === 'Anything containing “figure” · 3 results'`, 15000), await q(status));
  const words = JSON.stringify(await results());
  check('results show page, kind and label', words === JSON.stringify(['p. 1 Annotation: Text · Check the figures', 'p. 2 Text run: A figure on page two', 'p. 2 Text run: Figure 1: a picture']), words);
  check('the tree is hidden while searching', await q(`document.querySelector('.structure-tree:not(.structure-results)').hidden && !document.querySelector('.structure-results').hidden`));
  await c.key('Enter');
  check('Enter selects the first result', await waitFor(`${title} === 'Annotation' && ${status} === 'Anything containing “figure” · 1 of 3'`, 3000));
  check('its box is marked on page 1', (await waitFor(`Boolean(document.querySelector('.structure-mark'))`, 2000)) && (await markPage()) === '1');
  await c.key('Enter');
  check('Enter again goes to page 2', await waitFor(`${title} === 'Text run' && ${V(DOC)}.state.pageNumber === 2`, 3000));
  check('its properties show', (await q(`[...document.querySelectorAll('.structure-props dd')].map((d) => d.textContent)[0]`)) === 'A figure on page two');
  const textSpan = `[...document.querySelectorAll('.page[data-page-number="2"] .textLayer span')].find((s) => s.textContent === 'A figure on page two')`;
  await waitFor(`Boolean(${textSpan})`, 5000);
  const onText = await overlap(textSpan);
  check('the mark is on page 2, over the text', (await markPage()) === '2' && onText && onText.ofTarget > 0.8 && onText.ofMark > 0.4, JSON.stringify(onText));
  await shot('search-words');
  await c.key('Shift+Enter');
  check('Shift+Enter goes back', await waitFor(`${selected} === 'Text · Check the figures' && ${status} === 'Anything containing “figure” · 1 of 3'`, 3000));
  await c.key('Shift+Enter');
  check('and wraps around to the last', await waitFor(`${selected} === 'Figure 1: a picture'`, 3000));

  area('images');
  await searchFor('all images');
  check('all images: one', await waitFor(`${status} === 'Images · 1 result'`, 10000), await q(status));
  await q(`${V(DOC)}.goToPage(1)`);
  await sleep(300);
  await q(`document.querySelector('.structure-search .tb-btn[aria-label="Next result"]').click()`);
  check('Next selects it and goes to page 2', await waitFor(`${title} === 'Image' && ${V(DOC)}.state.pageNumber === 2`, 3000));
  const size = await q(`(() => { const m = document.querySelector('.structure-mark').getBoundingClientRect(); const v = ${V(DOC)}.viewer.getPageView(1); const k = v.div.getBoundingClientRect().width / v.pdfPage.view[2]; return [m.width / k, m.height / k]; })()`);
  check('the mark is the picture’s size', (await markPage()) === '2' && Math.abs(size[0] - 244) < 3 && Math.abs(size[1] - 184) < 3, JSON.stringify(size));
  await shot('search-image');

  area('form fields and links');
  await searchFor('all form fields');
  check('all form fields: one', await waitFor(`${status} === 'Form fields · 1 result'`, 10000), await q(status));
  await c.key('Enter');
  check('it goes to page 1 and shows the field', await waitFor(`${title} === 'Form field' && ${V(DOC)}.state.pageNumber === 1`, 3000));
  const onField = await overlap(`document.querySelector('.page[data-page-number="1"] .annotationLayer .textWidgetAnnotation')`);
  check('the mark lies over the field', onField && onField.ofTarget > 0.9 && onField.ofMark > 0.7, JSON.stringify(onField));
  await searchFor('all links');
  check('all links: two, one per page', await waitFor(`${status} === 'Links · 2 results'`, 10000) && JSON.stringify(await results()) === JSON.stringify(['p. 1 Link: https://example.com/structure', 'p. 2 Link: Link to page 1']), JSON.stringify(await results()));

  area('editable filter');
  await searchFor('editable text containing report');
  check('editable text containing report', await waitFor(`${status} === 'Editable text containing “report” · 1 result'`, 10000) && JSON.stringify(await results()) === JSON.stringify(['p. 1 Text run: Structure report']), await q(status));
  await searchFor('non-editable text');
  check('no non-editable text here', await waitFor(`${status} === 'Non-editable text · No results' && document.querySelector('.structure-results .structure-hint')?.textContent === 'Nothing found.'`, 10000), await q(status));

  area('clear');
  await c.key('Escape');
  check('Escape clears the search and shows the tree', await waitFor(`${input}.value === '' && !document.querySelector('.structure-tree:not(.structure-results)').hidden && document.querySelector('.structure-results').hidden`, 3000));
  check('Vellum’s Find bar is untouched', await q(`document.querySelector('.findbar')?.hidden !== false`));
  check('nothing to save, the file unchanged', (await q(`!${V(DOC)}.annotations.dirty`)) && hash() === original);
  const errors = await q(`JSON.stringify(__vellum.errors?.slice(${errorsBefore}) ?? [])`);
  check('no errors', errors === '[]', errors);
}
