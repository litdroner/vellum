// Settings → History in the real app: every document with snapshots on this PC is listed with its path, snapshot
// count, size on disk and last snapshot; a document deleted from disk shows as missing and can only be removed;
// clearing one document's history removes that history folder only (the other histories and every PDF stay as they
// were); "Remove missing" removes the missing ones; Open history opens the document's own history dialog.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const files = { 'keep-doc': 'compare-a', 'clear-doc': 'compare-b', 'gone-doc': 'compare-a' };

export async function run(t) {
  const { q, check, sleep, shot, V, settled, waitFor, area } = t;
  const KEEP = t.file('keep-doc');
  const CLEAR = t.file('clear-doc');
  const GONE = t.file('gone-doc');
  const H = '__vellum.actions.history';
  const historyRoot = path.join(t.dir, 'data', 'history');
  // The host's key: the first 32 hex digits of SHA-256 over the upper-cased full path (Services/DocumentHistory.cs).
  const key = (file) => crypto.createHash('sha256').update(path.resolve(file).toUpperCase(), 'utf8').digest('hex').slice(0, 32).toUpperCase();
  const folderOf = (file) => path.join(historyRoot, key(file));
  const folderSize = (folder) => fs.readdirSync(folder).reduce((sum, f) => sum + fs.statSync(path.join(folder, f)).size, 0);
  const hash = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  const top = `[...document.querySelectorAll('.dialog')].at(-1)`;
  const button = (label) => `[...${top}.querySelectorAll('.dialog-actions button')].find((b) => b.textContent === ${JSON.stringify(label)})`;
  const row = (file) => `document.querySelector('.settings-dialog .stored-row[data-key="${key(file)}"]')`;
  const rows = () => q(`[...document.querySelectorAll('.settings-dialog .stored-row')].map((r) => ({ key: r.dataset.key, missing: r.dataset.missing, text: r.textContent }))`);
  const openSettings = async () => {
    await q(`__vellum.actions.settings('history')`);
    return waitFor(`document.querySelector('.settings-dialog .stored-summary')?.textContent.includes('on this PC')`, 5000);
  };

  for (const f of [KEEP, CLEAR, GONE]) await waitFor(settled(f), 25000);

  area('snapshots');
  for (const [file, n] of [[KEEP, 2], [CLEAR, 1], [GONE, 1]]) {
    for (let i = 0; i < n; i++) await q(`${H}.create(${V(file)}, ${JSON.stringify(`${path.basename(file)} ${i + 1}`)}).then(Boolean)`);
  }
  check('each document has its own history folder', [KEEP, CLEAR, GONE].every((f) => fs.existsSync(folderOf(f))));
  const keepHash = hash(KEEP);
  const clearHash = hash(CLEAR);
  const keepFolder = fs.readdirSync(folderOf(KEEP)).sort().join('|');

  // One document is deleted from disk (it's the test's own copy), after its tab is closed.
  await q(`__vellum.app.close(${V(GONE)})`);
  await sleep(500);
  fs.rmSync(GONE, { maxRetries: 10, retryDelay: 200 });

  area('list');
  check('Settings opens on History', await openSettings());
  const listed = await rows();
  check('the three documents with history are listed', listed.length === 3 && [KEEP, CLEAR, GONE].every((f) => listed.some((r) => r.key === key(f))), JSON.stringify(listed));
  const keepRow = listed.find((r) => r.key === key(KEEP));
  const sizeText = await q(`import('./js/history/model.js').then((m) => m.formatSize(${folderSize(folderOf(KEEP))}))`);
  check('name, path, snapshot count, size on disk and last snapshot are shown',
    keepRow?.text.startsWith('keep-doc.pdf') && keepRow.text.includes(KEEP) && keepRow.text.includes(`2 snapshots · ${sizeText} · last `), keepRow?.text);
  check('the summary adds them up', (await q(`document.querySelector('.settings-dialog .stored-summary').textContent`)).startsWith('3 documents · 4 snapshots · '));
  check('the deleted document is marked missing', listed.find((r) => r.key === key(GONE))?.missing === 'true' && listed.find((r) => r.key === key(KEEP))?.missing === 'false');
  check('a missing document’s history can’t be opened, only removed',
    await q(`!${row(GONE)}.querySelector('[data-act="open"]') && Boolean(${row(GONE)}.querySelector('[data-act="remove"]'))`));
  check('Remove missing counts them', await q(`document.querySelector('[data-act="remove-missing"]').textContent === 'Remove missing (1)' && !document.querySelector('[data-act="remove-missing"]').disabled`));
  await shot('settings-history');

  area('clear one');
  await q(`${row(CLEAR)}.querySelector('[data-act="clear"]').click()`);
  check('clearing asks first', await waitFor(`${top}.querySelector('.dialog-title')?.textContent === 'Clear the history of “clear-doc.pdf”?'`, 3000));
  await q(`${button('Cancel')}.click()`);
  await sleep(300);
  check('Cancel keeps it', fs.existsSync(folderOf(CLEAR)));
  await q(`${row(CLEAR)}.querySelector('[data-act="clear"]').click()`);
  await waitFor(`${top}.querySelector('.dialog-title')?.textContent?.startsWith('Clear the history of')`, 3000);
  await q(`${button('Clear history')}.click()`);
  check('its row goes', await waitFor(`!${row(CLEAR)} && document.querySelectorAll('.settings-dialog .stored-row').length === 2`, 4000));
  check('its history folder is gone', !fs.existsSync(folderOf(CLEAR)));
  check('the document itself is unchanged', fs.existsSync(CLEAR) && hash(CLEAR) === clearHash);
  check('another document’s history is untouched', fs.readdirSync(folderOf(KEEP)).sort().join('|') === keepFolder && hash(KEEP) === keepHash);
  check('its own history dialog agrees', (await q(`${H}.list(${V(CLEAR)}).then((l) => l.length)`)) === 0 && (await q(`${H}.list(${V(KEEP)}).then((l) => l.length)`)) === 2);

  area('remove missing');
  await q(`document.querySelector('[data-act="remove-missing"]').click()`);
  check('removing asks first', await waitFor(`${top}.querySelector('.dialog-title')?.textContent === 'Remove the history of 1 missing document?'`, 3000));
  await q(`${button('Remove')}.click()`);
  check('the missing document’s row goes', await waitFor(`!${row(GONE)} && document.querySelectorAll('.settings-dialog .stored-row').length === 1`, 4000));
  check('its history folder is gone', !fs.existsSync(folderOf(GONE)));
  check('the remaining history and its PDF stay', fs.readdirSync(folderOf(KEEP)).sort().join('|') === keepFolder && hash(KEEP) === keepHash);
  check('nothing is missing now', await q(`document.querySelector('[data-act="remove-missing"]').disabled`));
  const refused = await q(`import('./js/bridge.js').then(({ bridge }) => bridge.request('history.removeStored', { key: '..\\\\..' }).then(() => 'removed', (e) => e.message))`);
  check('a key that isn’t a history folder is refused', refused !== 'removed', refused);

  area('open history');
  await q(`__vellum.app.close(${V(KEEP)})`);
  await sleep(400);
  await q(`${row(KEEP)}.querySelector('[data-act="open"]').click()`);
  check('Open history closes Settings and opens the document’s own history dialog',
    await waitFor(`!document.querySelector('.settings-dialog') && document.querySelectorAll('.history-dialog .hist-item').length === 2`, 20000));
  check('with the document opened in a tab', await q(`Boolean(${V(KEEP)}) && ${V(KEEP)} === __vellum.app.active`));
  await shot('history-from-settings');
  await q(`${button('Close')}.click()`);
  await sleep(300);
  check('no errors were reported', (await q(`__vellum.errors.length`)) === 0, JSON.stringify(await q(`__vellum.errors.slice(0, 3)`)));
}
