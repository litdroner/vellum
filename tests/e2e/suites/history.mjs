// Document history in the real app: the palette opens the history dialog; a named snapshot is taken; the
// file then changes on disk (as another save would); Compare shows the snapshot against it; the snapshot
// opens read-only (its file refuses writes); Restore keeps the current version as a new snapshot and saves
// the snapshot's content into the document; the snapshot restored is byte for byte unchanged; Delete removes one.

import fs from 'node:fs';
import crypto from 'node:crypto';

export const files = { 'history-doc': 'compare-a', 'history-later': 'compare-b' };

export async function run(t) {
  const { c, q, check, sleep, shot, V, settled, waitFor, area } = t;
  const DOC = t.file('history-doc');
  const LATER = t.file('history-later');
  const hash = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  const original = hash(DOC);
  const later = hash(LATER);
  const H = '__vellum.actions.history';
  const top = `[...document.querySelectorAll('.dialog')].at(-1)`;
  const button = (label) => `[...${top}.querySelectorAll('.dialog-actions button')].find((b) => b.textContent === ${JSON.stringify(label)})`;
  const rowAct = (index, act) => `document.querySelectorAll('.history-dialog .hist-item')[${index}].querySelector('[data-act="${act}"]')`;
  const openDialog = async () => {
    await q(`__vellum.app.activate(${V(DOC)}); ${V(DOC)}.focus()`);
    await c.key('Ctrl+K');
    await waitFor(`document.activeElement?.closest?.('.palette')`, 3000);
    await c.type('Document history');
    await sleep(300);
    await c.key('Enter');
    return waitFor(`document.querySelector('.history-dialog.dialog') && document.activeElement?.matches('.history-dialog input')`, 4000);
  };
  const snapshots = () => q(`${H}.list(${V(DOC)}).then((l) => l.map((s) => ({ id: s.id, name: s.name })))`);
  const snapshotPath = (id) => q(`(async () => (await (await import('./js/bridge.js')).bridge.request('history.open', { path: ${V(DOC)}.file.path, id: ${JSON.stringify(id)} })).file.path)()`);

  await waitFor(settled(DOC), 25000);
  await waitFor(settled(LATER), 25000);

  area('create');
  check('the palette opens the history dialog, name field focused', await openDialog());
  check('no snapshots yet', await q(`Boolean(document.querySelector('.history-dialog .hist-empty'))`));
  await c.type('Original');
  await c.key('Enter');
  check('Enter in the name field takes a snapshot', await waitFor(`document.querySelectorAll('.history-dialog .hist-item').length === 1`, 5000));
  check('it is listed by name, with when it was taken', await q(`document.querySelector('.history-dialog .hist-name').textContent === 'Original' && /\\d/.test(document.querySelector('.history-dialog .hist-when').textContent)`));
  await shot('history-dialog');
  const [first] = await snapshots();
  const firstPath = await snapshotPath(first.id);
  check('the snapshot is a file in Vellum’s data folder on this PC', firstPath?.toLowerCase().startsWith(t.dir.toLowerCase()) && firstPath.includes('\\history\\'), firstPath);
  check('an exact copy of the document as saved', hash(firstPath) === original);
  await q(`${button('Close')}.click()`);
  await sleep(300);

  // The document changes on disk, as a later save would leave it.
  fs.copyFileSync(LATER, DOC);

  area('compare');
  await openDialog();
  await q(`${rowAct(0, 'compare')}.click()`);
  check('Compare: snapshot as A, the document as B', await waitFor(`__vellum.actions.compare.view?.status === 'ready'`, 20000));
  const count = await q(`__vellum.actions.compare.view.changes.length`);
  check('the differences between them are listed', count === 6, count);
  await c.key('Escape');
  await sleep(400);

  area('open');
  await openDialog();
  await q(`${rowAct(0, 'open')}.click()`);
  check('the snapshot opens in a tab', await waitFor(`__vellum.app.views.some((v) => v.file.readOnly && v.status === 'ready')`, 20000));
  const tab = await q(`(() => { const v = __vellum.app.views.find((x) => x.file.readOnly); return { name: v.file.name, active: v === __vellum.app.active }; })()`);
  check('named after the document and the snapshot, and shown', tab.active && tab.name.startsWith('history-doc — Original'), JSON.stringify(tab));
  const refused = await q(`(async () => { const v = __vellum.app.views.find((x) => x.file.readOnly); try { await v.writeFile(v.file, new TextEncoder().encode('%PDF-1.7 nothing')); return 'written'; } catch (e) { return e.message; } })()`);
  check('its file can’t be written', refused !== 'written' && /snapshot/i.test(refused), refused);
  check('the snapshot has no history of its own', (await q(`${H}.canUse(__vellum.app.active)`)) === false);
  await q(`__vellum.app.close(__vellum.app.views.find((x) => x.file.readOnly))`);
  await sleep(300);

  area('restore');
  await openDialog();
  const order = await q(`__vellum.app.views.map((v) => v.file.name).join('|')`);
  await q(`${rowAct(0, 'restore')}.click()`);
  check('Restore asks first', await waitFor(`${top}.querySelector('.dialog-title')?.textContent.startsWith('Restore “Original”')`, 3000));
  await q(`${button('Restore')}.click()`);
  check('the document reloads', await waitFor(`(() => { const v = ${V(DOC)}; return v && v.status === 'ready' && !v.rebuilding && !v.annotations.dirty && !document.querySelector('.dialog'); })()`, 20000));
  await sleep(600);
  check('the document on disk is the snapshot’s content again', hash(DOC) === original);
  check('the snapshot restored is unchanged', hash(firstPath) === original);
  const after = await snapshots();
  check('the version it replaced is kept as a new snapshot', after.length === 2 && after[0].name === 'Before restoring “Original”' && after[1].id === first.id, JSON.stringify(after));
  check('…holding exactly that version', hash(await snapshotPath(after[0].id)) === later);
  check('one tab for the document, in its place', (await q(`__vellum.app.views.map((v) => v.file.name).join('|')`)) === order, await q(`__vellum.app.views.map((v) => v.file.name).join('|')`));

  area('delete');
  check('the dialog opens again', await openDialog());
  const beforePath = await snapshotPath(after[0].id);
  await q(`${rowAct(0, 'delete')}.click()`);
  check('Delete asks first', await waitFor(`${top}.querySelector('.dialog-title')?.textContent.startsWith('Delete “Before restoring')`, 3000));
  await q(`${button('Delete')}.click()`);
  check('the snapshot leaves the list', await waitFor(`document.querySelectorAll('.history-dialog .hist-item').length === 1`, 4000));
  check('…and its file is removed', !fs.existsSync(beforePath));
  check('the other snapshot stays', hash(firstPath) === original && (await snapshots()).length === 1);
  await shot('history-after');
  await c.key('Escape');
  await sleep(300);

  check('no errors', (await q(`__vellum.errors.length`)) === 0, JSON.stringify(await q(`__vellum.errors`)));
  check('the other open file is unchanged', hash(LATER) === later);
}
