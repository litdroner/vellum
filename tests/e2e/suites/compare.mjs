// Compare documents in the real app, the way a person does it: the command palette, the dialog (A is the
// active tab, B the other one), Compare; then the change list and count, F7 / Shift+F7, clicking a change,
// showing one type of change (V1.1), Overlay and Blink, Esc. Both files must be byte for byte the same afterwards. The comparison itself is
// proved in tests/editing/compare.test.mjs.

import fs from 'node:fs';
import crypto from 'node:crypto';

export const files = { 'compare-a': 'compare-a', 'compare-b': 'compare-b' };

export async function run(t) {
  const { c, q, check, sleep, shot, V, settled, waitFor, area } = t;
  const A = t.file('compare-a');
  const B = t.file('compare-b');
  const hash = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  const before = { a: hash(A), b: hash(B) };
  const CV = '__vellum.actions.compare.view';

  await waitFor(settled(A), 25000);
  await waitFor(settled(B), 25000);
  await q(`__vellum.app.activate(${V(A)})`);
  await sleep(400);

  area('choose');
  await q(`${V(A)}.focus()`);
  await c.key('Ctrl+K');
  await waitFor(`document.activeElement?.closest?.('.palette')`, 3000);
  await c.type('Compare documents');
  await sleep(300);
  await c.key('Enter');
  check('the dialog opens', await waitFor(`document.querySelector('.compare-dialog')`, 3000));
  await sleep(300);
  const names = await q(`[...document.querySelectorAll('.compare-dialog .cmp-pick-name')].map((e) => e.textContent)`);
  check('A is the active tab, B the other open tab', names?.[0] === 'compare-a.pdf' && names?.[1] === 'compare-b.pdf', JSON.stringify(names));
  const compareBtn = await q(`(() => { const r = document.querySelector('.compare-dialog .primary').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
  await c.mouse(compareBtn.x, compareBtn.y);

  area('compare');
  const ready = await waitFor(`${CV}?.status === 'ready'`, 20000);
  check('the comparison finishes', ready, await q(`${CV}?.status`));
  await sleep(500);
  const kinds = await q(`${CV}.changes.map((ch) => [ch.kind, ch.row, ch.before ?? '', ch.after ?? ''].join('|'))`);
  check('added, removed and changed text; a moved, a removed and an added page', JSON.stringify(kinds) === JSON.stringify([
    'text-removed|0|Prepared for the finance team|', 'text-changed|0|ten|twelve', 'text-added|0||Costs stayed flat',
    'page-moved|1||', 'page-removed|3||', 'page-added|4||',
  ]), JSON.stringify(kinds));
  check('the total is shown', (await q(`document.querySelector('.cmp-count').textContent`)) === '6 changes', await q(`document.querySelector('.cmp-count').textContent`));
  check('one list entry per change', (await q(`document.querySelectorAll('.cmp-item').length`)) === 6);
  check('pages side by side, drawn', await waitFor(`(() => { const cs = document.querySelectorAll('.cmp-row[data-row="0"] .cmp-canvas'); return cs.length === 2 && [...cs].every((x) => x.width > 0); })()`, 8000));
  check('changes are marked on both pages', await q(`document.querySelectorAll('.cmp-row[data-row="0"] .cmp-slot.a .cmp-mark').length >= 2 && document.querySelectorAll('.cmp-row[data-row="0"] .cmp-slot.b .cmp-mark').length >= 2`));
  await c.key('Ctrl+W');
  await sleep(300);
  check('app shortcuts are held while comparing (Ctrl+W closes no tab)', (await q(`__vellum.app.views.length`)) === 2);
  await shot('compare-side');

  area('navigate');
  await c.key('F7');
  await sleep(200);
  check('F7 selects the first change', (await q(`${CV}.index`)) === 0 && (await q(`document.querySelector('.cmp-item.current')?.dataset.change`)) === '0');
  await c.key('F7');
  await sleep(200);
  check('F7 again: the next', (await q(`${CV}.index`)) === 1 && (await q(`document.querySelector('.cmp-position').textContent`)) === '2 / 6');
  check('its marks are highlighted on both pages', (await q(`document.querySelectorAll('.cmp-mark.current').length`)) === 2);
  await c.key('Shift+F7');
  await sleep(200);
  check('Shift+F7: the previous', (await q(`${CV}.index`)) === 0);

  const at = await q(`(() => { const r = document.querySelector('.cmp-item[data-change="4"] button').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
  await c.mouse(at.x, at.y);
  await sleep(900);
  check('clicking a change selects it', (await q(`${CV}.index`)) === 4);
  const inView = await q(`(() => { const p = document.querySelector('.cmp-pages').getBoundingClientRect(); const r = document.querySelector('.cmp-row[data-row="3"] .cmp-page').getBoundingClientRect(); return r.top < p.bottom && r.bottom > p.top; })()`);
  check('…and scrolls its page into view', inView);
  check('the removed page is outlined', await q(`document.querySelector('.cmp-row[data-row="3"] .cmp-page').classList.contains('current')`));
  await shot('compare-jump');

  area('filter');
  const filterCounts = await q(`Object.fromEntries([...document.querySelectorAll('.cmp-filter-btn')].map((b) => [b.dataset.filter, b.querySelector('.cmp-filter-n').textContent]))`);
  check('each type shows its count', JSON.stringify(filterCounts) === JSON.stringify({ all: '6', added: '2', removed: '2', changed: '1', moved: '1' }), JSON.stringify(filterCounts));
  const clickFilter = async (id) => {
    const r = await q(`(() => { const r = document.querySelector('.cmp-filter-btn[data-filter="${id}"]').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
    await c.mouse(r.x, r.y);
    await sleep(300);
  };
  const shownItems = `[...document.querySelectorAll('.cmp-item')].filter((e) => e.offsetParent).map((e) => e.dataset.change).join(',')`;
  const shownMarks = `[...document.querySelectorAll('.cmp-row[data-row="0"] .cmp-mark')].filter((e) => getComputedStyle(e).display !== 'none').map((e) => e.dataset.change)`;
  await clickFilter('changed');
  check('Changed: only the changed text is listed', (await q(shownItems)) === '1', await q(shownItems));
  check('…and only its marks are on the pages', await q(`(() => { const m = ${shownMarks}; return m.length === 2 && m.every((x) => x === '1'); })()`));
  check('…the selected change is hidden, so no position among 1', (await q(`document.querySelector('.cmp-position').textContent`)) === '– / 1');
  await c.key('F7');
  await sleep(300);
  check('F7 goes to the changed text', (await q(`${CV}.index`)) === 1 && (await q(`document.querySelector('.cmp-position').textContent`)) === '1 / 1');
  await c.key('F7');
  await sleep(200);
  check('F7 again: still it (the only one)', (await q(`${CV}.index`)) === 1);
  await clickFilter('added');
  check('Added: added text and the added page', (await q(shownItems)) === '2,5', await q(shownItems));
  await c.key('Shift+F7');
  await sleep(300);
  check('Shift+F7 skips the hidden types, wrapping to the added page', (await q(`${CV}.index`)) === 5 && (await q(`document.querySelector('.cmp-position').textContent`)) === '2 / 2');
  await q(`document.querySelector('.cmp-filter-btn[data-filter="moved"]').click()`);
  await sleep(200);
  check('Moved: the moved page', (await q(shownItems)) === '3');
  await shot('compare-filter');
  await clickFilter('all');
  check('All: every change again', (await q(shownItems)) === '0,1,2,3,4,5' && (await q(`document.querySelector('.cmp-position').textContent`)) === '6 / 6');
  check('the comparison itself is unchanged', (await q(`${CV}.changes.length`)) === 6);
  await c.mouse(at.x, at.y); // back to the removed page, where the next area has always started
  await sleep(900);

  area('visual');
  await q(`document.querySelector('.cmp-modes [data-mode="overlay"]').click()`);
  await q(`document.querySelector('.cmp-pages').scrollTo({ top: 0 })`);
  const diffed = await waitFor(`(() => { const d = document.querySelector('.cmp-row[data-row="0"] .cmp-diff'); return d && d.width > 0; })()`, 8000);
  check('Overlay draws a difference image', diffed);
  const colours = await q(`(() => {
    const d = document.querySelector('.cmp-row[data-row="0"] .cmp-diff');
    const px = d.getContext('2d').getImageData(0, 0, d.width, d.height).data;
    let red = 0, green = 0;
    for (let p = 0; p < px.length; p += 4) { if (px[p] > 180 && px[p + 1] < 120) red++; if (px[p + 1] > 130 && px[p] < 90) green++; }
    return { red, green };
  })()`);
  check('ink only in A is red, only in B green', colours?.red > 50 && colours?.green > 50, JSON.stringify(colours));
  await q(`document.querySelector('.cmp-row[data-row="2"]').scrollIntoView()`);
  await waitFor(`document.querySelector('.cmp-row[data-row="2"] .cmp-diff')?.width > 0`, 8000);
  check('an unchanged page shows no colour', await q(`(() => {
    const d = document.querySelector('.cmp-row[data-row="2"] .cmp-diff');
    if (!d || !d.width) return 'not drawn';
    const px = d.getContext('2d').getImageData(0, 0, d.width, d.height).data;
    for (let p = 0; p < px.length; p += 4) if (Math.abs(px[p] - px[p + 1]) > 40) return false;
    return true;
  })()`) === true);
  await shot('compare-overlay');
  await q(`document.querySelector('.cmp-modes [data-mode="blink"]').click()`);
  const seen = new Set();
  for (let i = 0; i < 12; i++) {
    seen.add(await q(`document.querySelector('.compare').classList.contains('blink-b')`));
    await sleep(150);
  }
  check('Blink shows A and B in turn', seen.size === 2);

  area('close');
  await c.key('Escape');
  await sleep(400);
  check('Esc closes the comparison', (await q(`${CV} === null && !document.querySelector('.compare')`)) === true);
  check('no errors', (await q(`__vellum.errors.length`)) === 0, JSON.stringify(await q(`__vellum.errors`)));
  check('neither document has changes', (await q(`__vellum.app.views.every((v) => !v.annotations.dirty)`)) === true);
  check('both files are unchanged on disk', hash(A) === before.a && hash(B) === before.b);
}
