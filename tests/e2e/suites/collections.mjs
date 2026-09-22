// Collections on the home screen in the real app: a collection saved by an earlier run is there when Vellum
// starts, a file that's gone is shown as missing, a collection is made and renamed from the page, a document
// is added once (never twice), opens from its card, and removing a document or deleting the collection leaves
// every PDF on disk exactly as it was.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const files = { 'kept-doc': 'compare-a', 'other-doc': 'compare-b' };

// A collection written before Vellum starts: the host reads it at startup, like any earlier run's.
export async function prepare({ dir }) {
  const seeded = [{
    id: 'seededcollection00000000000000aa',
    name: 'Seeded',
    createdAt: new Date().toISOString(),
    paths: [path.join(dir, 'kept-doc.pdf'), path.join(dir, 'no-such-file.pdf')],
  }];
  fs.writeFileSync(path.join(dir, 'data', 'collections.json'), JSON.stringify(seeded, null, 2));
  return {};
}

export async function run(t) {
  const { q, check, shot, V, settled, waitFor, area } = t;
  const KEPT = t.file('kept-doc');
  const OTHER = t.file('other-doc');
  const stored = () => JSON.parse(fs.readFileSync(path.join(t.dir, 'data', 'collections.json'), 'utf8'));
  const hash = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  const section = (name) => `[...document.querySelectorAll('.collection')].find((el) => el.querySelector('.collection-name').textContent === ${JSON.stringify(name)})`;
  const button = (name, label) => `[...${section(name)}.querySelectorAll('button')].find((b) => b.textContent.startsWith(${JSON.stringify(label)}))`;
  const cards = (name) => q(`[...${section(name)}.querySelectorAll('.recent-card')].map((el) => ({ name: el.querySelector('.recent-name').textContent, missing: el.classList.contains('missing'), disabled: el.querySelector('.recent-open').disabled }))`);
  const home = async () => {
    for (const f of [KEPT, OTHER]) await q(`(${V(f)} ? __vellum.app.close(${V(f)}) : null)`);
    await waitFor(`!__vellum.app.active && document.querySelector('.start')`, 8000);
    await q(`__vellum.ui.start.refresh()`);
    return waitFor(`Boolean(document.querySelector('.collection'))`, 8000);
  };

  for (const f of [KEPT, OTHER]) await waitFor(settled(f), 25000);
  const keptHash = hash(KEPT);
  const otherHash = hash(OTHER);

  area('persisted');
  check('the home screen shows the collection saved before this run', await home());
  const seeded = await cards('Seeded');
  check('both documents of the saved collection are listed', seeded.length === 2, JSON.stringify(seeded));
  check('a file that is no longer there is shown as missing, not dropped',
    seeded[1]?.missing === true && seeded[1]?.disabled === true && seeded[0]?.missing === false, JSON.stringify(seeded));
  check('the summary counts the documents and the missing one',
    (await q(`${section('Seeded')}.querySelector('.collection-meta').textContent`)) === '2 documents · 1 not found');
  await shot('collections-home');

  area('create');
  await q(`[...document.querySelectorAll('.collections .recent-head button')][0].click()`);
  check('the New collection dialog asks for a name', await waitFor(`Boolean(document.querySelector('.dialog input.field'))`, 4000));
  await t.c.type('Tax 2026');
  await t.c.key('Enter');
  check('the collection appears on the home screen', await waitFor(`Boolean(${section('Tax 2026')})`, 5000));
  check('it is written to collections.json', stored().some((c) => c.name === 'Tax 2026' && c.paths.length === 0), JSON.stringify(stored()));

  area('membership');
  const id = (await q(`${section('Tax 2026')}.dataset.id`));
  const add = async (p) => q(`__vellum.ui.start.bridge.request('collections.add', { id: ${JSON.stringify(id)}, path: ${JSON.stringify(p)} }).then((r) => r.added)`);
  check('a document is added by its path', (await add(KEPT)) === 1);
  check('adding the same document again adds nothing', (await add(KEPT.toUpperCase())) === 0);
  await add(OTHER);
  await q(`__vellum.ui.start.refresh()`);
  await waitFor(`${section('Tax 2026')}.querySelectorAll('.recent-card').length === 2`, 5000);
  const listed = await cards('Tax 2026');
  check('the collection lists each document once', listed.length === 2 && listed.every((d) => !d.missing), JSON.stringify(listed));
  check('a path the page doesn’t already know is refused',
    await q(`__vellum.ui.start.bridge.request('collections.add', { id: ${JSON.stringify(id)}, path: 'C:\\\\Windows\\\\win.ini' }).then(() => false, () => true)`));

  area('open');
  await q(`${section('Tax 2026')}.querySelector('.recent-open').click()`);
  check('clicking a document opens it', await waitFor(settled(KEPT), 20000));
  check('… unchanged on disk', hash(KEPT) === keptHash);
  await home();

  area('remove');
  await q(`${section('Tax 2026')}.querySelector('.recent-card .recent-remove').click()`);
  check('the document is taken out of the collection', await waitFor(`${section('Tax 2026')}.querySelectorAll('.recent-card').length === 1`, 5000));
  check('… and stored that way', stored().find((c) => c.name === 'Tax 2026').paths.length === 1);
  check('… and the PDF is still on disk, unchanged', fs.existsSync(KEPT) && hash(KEPT) === keptHash);

  area('rename');
  await q(`${button('Tax 2026', 'Rename')}.click()`);
  await waitFor(`Boolean(document.querySelector('.dialog input.field'))`, 4000);
  await t.c.key('Ctrl+A');
  await t.c.type('Tax papers');
  await t.c.key('Enter');
  check('the collection is renamed, keeping its documents', await waitFor(`Boolean(${section('Tax papers')}) && ${section('Tax papers')}.querySelectorAll('.recent-card').length === 1`, 5000));
  check('… and renamed in collections.json, same id', stored().find((c) => c.id === id)?.name === 'Tax papers');

  area('delete');
  await q(`${button('Tax papers', 'Delete')}.click()`);
  check('deleting asks first, saying the documents aren’t touched',
    await waitFor(`document.querySelector('.dialog-message')?.textContent.includes('aren’t touched')`, 4000));
  await q(`[...document.querySelectorAll('.dialog-actions button')].find((b) => b.textContent === 'Delete collection').click()`);
  check('the collection is gone', await waitFor(`!${section('Tax papers')}`, 5000));
  check('… and only that one: the saved collection is still there', await q(`Boolean(${section('Seeded')})`) && stored().length === 1);
  check('… and both PDFs are on disk, unchanged', fs.existsSync(KEPT) && fs.existsSync(OTHER) && hash(KEPT) === keptHash && hash(OTHER) === otherHash);
  await shot('collections-after-delete');

  check('no runtime errors', (await q('JSON.stringify(__vellum.errors)')) === '[]', await q('JSON.stringify(__vellum.errors)'));
}
