// Split by bookmarks V1 in the real app: the split dialog offers the document's own bookmarks as a way
// to cut it, names the sections it would write, and offers nothing when the document has no bookmarks
// Vellum can resolve. The page-range ways of splitting must be exactly as they were.
//
// The folder picker is a Windows dialog and can't be driven from here, so this stops at the point where
// it would open. What each file ends up holding is proved over the bytes in
// tests/editing/split-bookmarks.test.mjs.

export const files = { book: 'bookmarks', plain: 'multipage' };

export async function run(t) {
  const { c, q, check, sleep, shot, V, settled, waitFor, area } = t;

  const rest = async (file, ms = 25000) => {
    await waitFor(settled(file), ms);
    await sleep(400);
  };
  const openSplit = async (file) => {
    await q(`__vellum.app.activate(${V(file)})`);
    await rest(file);
    await q(`${V(file)}.focus()`);
    await c.key('Ctrl+K');
    await waitFor(`document.activeElement?.closest?.('.palette')`, 3000);
    await c.type('Split into files');
    await sleep(300);
    await c.key('Enter');
    await waitFor(`document.querySelector('.split-dialog')`, 8000);
    await sleep(400);
  };
  const close = async () => {
    await c.key('Escape');
    await waitFor(`!document.querySelector('.split-dialog')`, 5000);
  };
  const option = (value) => `document.querySelector('.split-dialog input[value="${value}"]')`;
  const label = (value) => q(`${option(value)}.closest('.choice').textContent`);
  const note = () => q(`document.querySelector('.split-dialog .dialog-note').textContent`);

  area('a document with bookmarks');
  await openSplit(t.file('book'));
  check('the split dialog offers the document’s bookmarks', await q(`Boolean(${option('bookmarks')}) && !${option('bookmarks')}.disabled`));
  check('the option counts the sections', /Before each bookmark \(4 sections\)/.test(await label('bookmarks')), await label('bookmarks'));
  check('it is chosen when no pages are selected', await q(`${option('bookmarks')}.checked`));
  check('the sections are named as they will be written',
    (await note()) === 'Creates 4 files: pages 1 · Introduction · Results / Findings: Q1* · Appendix', await note());
  await shot('split-by-bookmarks');

  area('the page ways of splitting are unchanged');
  await q(`${option('every')}.click()`);
  await sleep(250);
  check('every N pages still describes page ranges',
    (await note()) === 'Creates 2 files: pages 1–3 · pages 4–6', await note());
  await q(`${option('ranges')}.click()`);
  await q(`document.querySelector('.split-dialog input[type="text"]').focus()`);
  await c.type('1-2, 3-6');
  await sleep(300);
  check('page ranges still work', (await note()) === 'Creates 2 files: pages 1–2 · pages 3–6', await note());
  check('the primary button is enabled for a valid split', !(await q(`document.querySelector('.split-dialog .btn.primary').disabled`)));
  await close();

  area('a document without bookmarks');
  await openSplit(t.file('plain'));
  check('the bookmark option is there but can’t be chosen', await q(`Boolean(${option('bookmarks')}) && ${option('bookmarks')}.disabled`));
  check('the plain option is chosen instead', await q(`${option('every')}.checked`));
  check('nothing claims a section that isn’t there', /Creates 2 files: pages 1–3 · pages 4–5/.test(await note()), await note());
  await shot('split-without-bookmarks');
  await close();

  check('the documents are unchanged and nothing was written',
    await q(`__vellum.app.views.every((v) => !v.annotations.dirty)`));
  check('the app reported no errors', (await q(`JSON.stringify(__vellum.errors)`)) === '[]', await q(`JSON.stringify(__vellum.errors)`));
}
