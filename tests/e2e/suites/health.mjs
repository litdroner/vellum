// PDF health in the real app: the More menu opens the report on a page whose text is drawn inside Form
// XObjects; it lists the engine's own refusals with their pages and what stands in the way; a page number
// goes to that page and closes the report; and the file is not changed.

import fs from 'node:fs';
import crypto from 'node:crypto';

export const files = { 'form-xobjects': 'form-xobjects' };

export async function run(t) {
  const { c, q, check, shot, settled, waitFor, area } = t;
  const DOC = t.file('form-xobjects');
  const hash = () => crypto.createHash('sha256').update(fs.readFileSync(DOC)).digest('hex');
  const original = hash();
  const clickAt = async (expr) => {
    const [x, y] = await q(`(() => { const r = (${expr}).getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()`);
    await c.mouse(x, y);
  };

  await waitFor(settled(DOC), 25000);
  const errorsBefore = await q(`__vellum.errors?.length ?? 0`);

  area('report');
  await clickAt(`__vellum.ui.toolbar.menuBtn`);
  const entry = `[...document.querySelectorAll('.menu-item')].find((b) => b.querySelector('.menu-label')?.textContent === 'PDF health…')`;
  check('the More menu lists PDF health…', await waitFor(`Boolean(${entry})`, 3000));
  await clickAt(entry);
  check('the report opens and finishes', await waitFor(`/pages? checked/.test(document.querySelector('.health-dialog .health-status')?.textContent ?? '')`, 15000));
  const ids = await q(`[...document.querySelectorAll('.health-dialog .health-item')].map((i) => i.dataset.id + ':' + i.classList[1])`);
  check('Form XObject text is reported as limited', ids.includes('text:form:limited'), ids.join(', '));
  check('with what stands in the way inside the forms', await q(`document.querySelectorAll('.health-item[data-id="text:form"] .health-details li').length > 0`));
  await shot('health-report');

  area('page link');
  await clickAt(`document.querySelector('.health-item[data-id="text:form"] .health-page')`);
  check('a page number closes the report', await waitFor(`!document.querySelector('.health-dialog')`, 3000));
  check('and shows that page', await q(`__vellum.app.active.state.pageNumber === 1`));

  area('read-only');
  check('the document is not marked changed', await q(`!__vellum.app.active.annotations.dirty`));
  check('the file is byte for byte unchanged', hash() === original);
  const errors = await q(`JSON.stringify(__vellum.errors?.slice(${errorsBefore}) ?? [])`);
  check('no errors', errors === '[]', errors);
}
