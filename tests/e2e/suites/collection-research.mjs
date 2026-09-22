// Collection research in the real app: a collection saved before Vellum starts holds two readable PDFs, a
// protected one and a file that is gone. Research on the home screen asks one question of the collection,
// lists evidence quoted from more than one document with its file and page, names what it skipped and why,
// and opening a piece of evidence opens that document at that page with its box marked. Nothing is written.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const files = { 'report-a': 'compare-a', 'report-b': 'compare-b' };

// A collection written before Vellum starts, as an earlier run's would be. The protected PDF is copied in
// here rather than listed above, so the app doesn't ask for its password at startup: the collection lists
// it, and only the research reads it (and is turned away, as it should be).
export async function prepare({ dir }) {
  fs.copyFileSync(path.join(dir, '..', 'fixtures', 'encrypted-password.pdf'), path.join(dir, 'locked.pdf'));
  const seeded = [{
    id: 'researchcollection0000000000000a',
    name: 'Reports',
    createdAt: new Date().toISOString(),
    paths: [path.join(dir, 'report-a.pdf'), path.join(dir, 'report-b.pdf'), path.join(dir, 'locked.pdf'), path.join(dir, 'no-such-file.pdf')],
  }];
  fs.writeFileSync(path.join(dir, 'data', 'collections.json'), JSON.stringify(seeded, null, 2));
  return {};
}

export async function run(t) {
  const { c, q, check, shot, V, settled, waitFor, area } = t;
  const A = t.file('report-a');
  const B = t.file('report-b');
  const LOCKED = path.join(t.dir, 'locked.pdf');
  const hash = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  const before = Object.fromEntries([A, B, LOCKED].map((f) => [f, hash(f)]));
  const section = `[...document.querySelectorAll('.collection')].find((el) => el.querySelector('.collection-name').textContent === 'Reports')`;
  const dialog = `document.querySelector('.collection-research-dialog')`;
  const evidence = `[...document.querySelectorAll('.cr-evidence')].map((el) => ({ source: el.querySelector('.research-source').textContent, quote: el.querySelector('.research-quote').textContent, path: el.dataset.path, page: el.dataset.page }))`;

  // The fixtures open first so the copies are settled; the home screen comes back when they close.
  for (const f of [A, B]) await waitFor(settled(f), 25000);
  for (const f of [A, B]) await q(`__vellum.app.close(${V(f)})`);
  await waitFor(`!__vellum.app.active && document.querySelector('.start')`, 8000);
  await q(`__vellum.ui.start.refresh()`);
  check('the collection saved before this run is on the home screen', await waitFor(`Boolean(${section})`, 8000));

  area('ask');
  await q(`[...${section}.querySelectorAll('button')].find((b) => b.textContent === 'Research').click()`);
  check('Research asks a question about the collection', await waitFor(`Boolean(${dialog}) && ${dialog}.querySelector('.cr-ask input').placeholder === 'Ask a research question'`, 5000));
  await c.type('Where are the samples collected weekly?');
  await c.key('Enter');
  check('the collection is researched', await waitFor(`${dialog}?.querySelector('.research-summary[data-sufficient="true"]')`, 30000),
    await q(`${dialog}?.querySelector('.research-summary')?.textContent ?? 'no summary'`));

  area('evidence');
  const found = await q(evidence);
  check('evidence comes from more than one document', new Set(found.map((e) => e.path)).size === 2, JSON.stringify(found));
  check('each result names its document, page and quoted passage',
    found.every((e) => /\.pdf · page \d+ · matches /.test(e.source) && e.quote.includes('Samples were collected weekly')), JSON.stringify(found));
  check('the summary is marked as Vellum’s and the evidence as quoted from the documents',
    await q(`[...${dialog}.querySelectorAll('.research-heading')].map((h) => h.textContent).slice(0, 2).join(' | ') === 'Summary · by Vellum, from the matches | Evidence · quoted from the documents'`));

  area('skipped');
  const skipped = await q(`[...${dialog}.querySelectorAll('.cr-skipped')].map((el) => el.textContent)`);
  check('the protected document is skipped, with its reason', skipped.some((s) => s.startsWith('locked.pdf') && s.includes('protected')), JSON.stringify(skipped));
  check('the file that is gone is skipped, with its reason', skipped.some((s) => s.startsWith('no-such-file.pdf') && s.includes('not found')), JSON.stringify(skipped));
  check('and the summary counts what was read', await q(`${dialog}.querySelector('.research-summary').textContent.includes('2 documents of 4 read')`),
    await q(`${dialog}.querySelector('.research-summary').textContent`));
  await shot('collection-research-evidence');

  area('open');
  const first = found[0];
  await q(`document.querySelector('.cr-evidence').click()`);
  check('choosing a result closes the dialog', await waitFor(`!${dialog}`, 5000));
  check('… and opens the document it names', await waitFor(settled(first.path), 25000), first.path);
  check('… at the page the evidence came from', await waitFor(`${V(first.path)}.state.pageNumber === ${Number(first.page)}`, 8000),
    await q(`${V(first.path)}.state.pageNumber`));
  check('… with the passage’s box marked on that page',
    await waitFor(`document.querySelector('.structure-mark')?.closest('.page')?.dataset.pageNumber === '${first.page}'`, 5000));
  await shot('collection-research-opened');

  area('read-only');
  check('nothing is waiting to be saved', await q(`!${V(first.path)}.annotations.dirty`));
  check('every PDF in the collection is on disk, unchanged',
    [A, B, LOCKED].every((f) => fs.existsSync(f) && hash(f) === before[f]));
  check('the collection itself is unchanged',
    JSON.parse(fs.readFileSync(path.join(t.dir, 'data', 'collections.json'), 'utf8'))[0].paths.length === 4);
  check('no runtime errors', (await q('JSON.stringify(__vellum.errors)')) === '[]', await q('JSON.stringify(__vellum.errors)'));
}
