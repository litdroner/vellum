// Document structure in the real app: the More menu opens the Structure tab of the sidebar on the semantic
// model of a two-page document with text, a paragraph, a form field, a note, a link and a picture; selecting
// a text run, the field and the picture shows their properties, goes to their page and marks their box over
// the object itself; an internal link shows the page it goes to; the command palette opens it too; and
// nothing in the document changes. Then a text edit made while the tab is open reads that page again; and a
// password-protected document, unlocked with its password, shows its fields, notes and links (no text).

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const files = { structure: 'structure' };

export async function run(t) {
  const { c, q, check, sleep, shot, V, settled, waitFor, area } = t;
  const DOC = t.file('structure');
  // The protected copy is opened during the run, handed to the running app as a second launch would, not at
  // start-up, where its password prompt would hold up the app.
  const LOCKED = path.join(t.dir, 'structure-locked.pdf');
  fs.copyFileSync(path.join(t.dir, '..', 'fixtures', 'encrypted-structure.pdf'), LOCKED);
  const hash = () => crypto.createHash('sha256').update(fs.readFileSync(DOC)).digest('hex');
  const original = hash();
  const centreOf = (expr) => q(`(() => { const r = (${expr}).getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()`);
  const clickAt = async (expr) => { const [x, y] = await centreOf(expr); await c.mouse(x, y); };
  const row = (label) => `[...document.querySelectorAll('.structure-item')].find((b) => b.textContent === ${JSON.stringify(label)})`;
  const title = `document.querySelector('.structure-props-title')?.textContent`;
  const prop = (label) => q(`(() => { const dt = [...document.querySelectorAll('.structure-props dt')].find((d) => d.textContent === ${JSON.stringify(label)}); return dt?.nextElementSibling?.textContent ?? null; })()`);
  // How much of `target` the mark covers, and how much of the mark lies over it (both 0 to 1).
  const overlap = (target) => q(`(() => {
    const m = document.querySelector('.structure-mark')?.getBoundingClientRect();
    const o = (${target})?.getBoundingClientRect();
    if (!m || !o) return null;
    const w = Math.max(0, Math.min(m.right, o.right) - Math.max(m.left, o.left));
    const h = Math.max(0, Math.min(m.bottom, o.bottom) - Math.max(m.top, o.top));
    return { ofTarget: (w * h) / (o.width * o.height), ofMark: (w * h) / (m.width * m.height) };
  })()`);
  const markPage = () => q(`document.querySelector('.structure-mark')?.closest('.page')?.dataset.pageNumber ?? null`);
  const groupsOf = (n) => q(`[...document.querySelectorAll('.structure-page[data-page="${n}"] .structure-group')].map((g) => g.dataset.group + ':' + g.querySelector('.structure-count').textContent)`);

  await waitFor(settled(DOC), 25000);
  const errorsBefore = await q(`__vellum.errors?.length ?? 0`);
  await q(`__vellum.ui.sidebar.setMode('thumbs')`);

  area('open');
  await clickAt(`__vellum.ui.toolbar.menuBtn`);
  const menuEntry = `[...document.querySelectorAll('.menu-item')].find((b) => b.querySelector('.menu-label')?.textContent === 'Document structure')`;
  check('the More menu lists Document structure', await waitFor(`Boolean(${menuEntry})`, 3000));
  await clickAt(menuEntry);
  check('it opens the Structure tab of the sidebar', await waitFor(`__vellum.ui.sidebar.mode === 'structure' && !__vellum.ui.sidebar.structureTab.hidden && Boolean(document.querySelector('.sidebar-body .structure-tree'))`, 3000));
  check('page 1, the page shown, is read and opened', await waitFor(`document.querySelector('.structure-page[data-page="1"]')?.dataset.read === '' && document.querySelector('.structure-page[data-page="1"]').classList.contains('open')`, 10000));
  const counts = await q(`document.querySelector('.structure-summary').textContent + ' / ' + document.querySelector('.structure-page[data-page="1"] .structure-count').textContent`);
  check('document and page counts', counts === '2 pages · 1 read / 7', counts);
  const groups = JSON.stringify(await groupsOf(1));
  check('page 1: text, form fields, annotations, links, with counts', groups === JSON.stringify(['text:4', 'fields:1', 'annotations:1', 'links:1']), groups);
  check('a paragraph lists its two runs', await q(`document.querySelectorAll('.structure-block .structure-item[data-kind="run"]').length === 2`));
  await shot('structure-open');

  area('text');
  await clickAt(row('Structure report'));
  check('selecting a text run shows its properties', await waitFor(`${title} === 'Text run'`, 3000));
  const textProps = [await prop('Text'), await prop('Font'), await prop('Font size'), await prop('Editable'), await prop('Invisible')];
  check('text, font, size, editable, invisible', textProps[0] === 'Structure report' && Boolean(textProps[1]) && textProps[2] === '20 pt' && textProps[3] === 'Yes' && textProps[4] === 'No', textProps.join(' / '));
  check('its box is marked on page 1', (await waitFor(`Boolean(document.querySelector('.structure-mark'))`, 2000)) && (await markPage()) === '1');
  const textSpan = `[...document.querySelectorAll('.page[data-page-number="1"] .textLayer span')].find((s) => s.textContent === 'Structure report')`;
  await waitFor(`Boolean(${textSpan})`, 5000);
  const onText = await overlap(textSpan);
  check('the mark lies over the text itself', onText && onText.ofTarget > 0.8 && onText.ofMark > 0.4, JSON.stringify(onText));

  area('field');
  await clickAt(row('reader.name · text'));
  check('selecting the form field shows its properties', await waitFor(`${title} === 'Form field'`, 3000));
  const fieldProps = [await prop('Name'), await prop('Type'), await prop('Value'), await prop('Read-only')];
  check('type, name, value, read-only', JSON.stringify(fieldProps) === JSON.stringify(['reader.name', 'text', 'Grace Hopper', 'No']), fieldProps.join(' / '));
  const onField = await overlap(`document.querySelector('.page[data-page-number="1"] .annotationLayer .textWidgetAnnotation')`);
  check('the mark lies over the field', (await markPage()) === '1' && onField && onField.ofTarget > 0.9 && onField.ofMark > 0.7, JSON.stringify(onField));
  await shot('structure-field');

  area('link and note');
  await clickAt(row('https://example.com/structure'));
  check('a link shows its destination', (await waitFor(`${title} === 'Link'`, 3000)) && (await prop('Destination')) === 'https://example.com/structure');
  await clickAt(`document.querySelector('.structure-page[data-page="1"] [data-group="annotations"] .structure-item')`);
  check('an annotation shows its subtype and contents', (await waitFor(`${title} === 'Annotation'`, 3000)) && (await prop('Subtype')) === 'Text' && (await prop('Contents')) === 'Check the figures');

  area('image');
  await clickAt(`document.querySelector('.structure-page[data-page="2"] .structure-page-row')`);
  check('opening page 2 reads it', await waitFor(`document.querySelector('.structure-page[data-page="2"]')?.dataset.read === '' && document.querySelector('.structure-summary').textContent === '2 pages'`, 10000));
  const groups2 = JSON.stringify(await groupsOf(2));
  check('page 2: text, one image and a link', groups2 === JSON.stringify(['text:2', 'images:1', 'links:1']), groups2);
  await q(`document.querySelector('.structure-page[data-page="2"] [data-group="links"] .structure-item').scrollIntoView({ block: 'center' })`);
  await clickAt(`document.querySelector('.structure-page[data-page="2"] [data-group="links"] .structure-item')`);
  check('an internal link shows the page it goes to', (await waitFor(`${title} === 'Link'`, 3000)) && (await prop('Destination')) === 'Page 1'
    && (await q(`document.querySelector('.structure-page[data-page="2"] [data-group="links"] .structure-item').textContent`)) === 'Link to page 1');
  await q(`${V(DOC)}.goToPage(1)`);
  await sleep(400);
  await clickAt(`document.querySelector('.structure-page[data-page="2"] [data-group="images"] .structure-item')`);
  check('selecting the picture shows its properties', await waitFor(`${title} === 'Image'`, 3000));
  const imageProps = [await prop('Pixels'), await prop('Type'), await prop('Size on page')];
  check('pixels, type, size on the page', JSON.stringify(imageProps) === JSON.stringify(['48 × 36', 'Image object', '240 × 180 pt']), imageProps.join(' / '));
  check('it goes to page 2', await waitFor(`${V(DOC)}.state.pageNumber === 2`, 3000));
  check('the mark is on page 2', (await markPage()) === '2');
  const size = await q(`(() => { const m = document.querySelector('.structure-mark').getBoundingClientRect(); const v = ${V(DOC)}.viewer.getPageView(1); const k = v.div.getBoundingClientRect().width / v.pdfPage.view[2]; return [m.width / k, m.height / k]; })()`);
  check('the mark is the picture’s size on the page', Math.abs(size[0] - 244) < 3 && Math.abs(size[1] - 184) < 3, JSON.stringify(size));
  check('and is scrolled into view', await waitFor(`(() => { const m = document.querySelector('.structure-mark')?.getBoundingClientRect(); const s = ${V(DOC)}.container.getBoundingClientRect(); return Boolean(m) && m.top >= s.top - 1 && m.bottom <= s.bottom + 1; })()`, 2000));
  await shot('structure-image');
  check('the mark goes away by itself', await waitFor(`!document.querySelector('.structure-mark')`, 4000));

  area('palette');
  await q(`__vellum.ui.sidebar.setMode('thumbs')`);
  await c.key('Ctrl+K');
  await waitFor(`document.activeElement?.closest?.('.palette')`, 3000);
  await c.type('Document structure');
  await sleep(300);
  await c.key('Enter');
  check('the command palette opens it', await waitFor(`__vellum.ui.sidebar.mode === 'structure' && Boolean(document.querySelector('.sidebar-body .structure'))`, 3000));

  area('read-only');
  check('nothing to save, nothing selected in Edit mode', await q(`!${V(DOC)}.annotations.dirty && !${V(DOC)}.objectSelection?.current`));
  check('the file is byte for byte unchanged', hash() === original);

  area('refresh after a change');
  check('page 1 is open and shows the title', await q(`Boolean(${row('Structure report')}) && document.querySelector('.structure-page[data-page="1"]').classList.contains('open')`));
  const edited = await q(`(async () => {
    const v = ${V(DOC)};
    const item = (await v.textEditing.page(1)).runs.find((r) => r.text === 'Structure report');
    return v.textEditing.edit(1, item.run.key, 'Structure summary');
  })()`);
  check('the title is edited through Vellum', edited === true);
  check('the open page is read again and shows the edited text', await waitFor(`Boolean(${row('Structure summary')}) && !${row('Structure report')} && document.querySelector('.structure-page[data-page="1"]')?.dataset.read === ''`, 15000));
  check('the page keeps its counts and stays open', await q(`document.querySelector('.structure-page[data-page="1"]').classList.contains('open') && document.querySelector('.structure-page[data-page="1"] .structure-count').textContent === '7'`));
  await shot('structure-refreshed');

  area('protected document');
  const exe = fileURLToPath(new URL('../../../src/Vellum/bin/Debug/net10.0-windows/Vellum.exe', import.meta.url));
  spawn(exe, [LOCKED], { stdio: 'ignore', detached: true, env: { ...process.env, VELLUM_DATA_DIR: path.join(t.dir, 'data') } }).unref();
  const passwordInput = `document.querySelector('.dialog input[type="password"]')`;
  check('the protected document asks for its password', await waitFor(`Boolean(${passwordInput})`, 15000));
  await q(`${passwordInput}.focus()`);
  await c.type('secret');
  await clickAt(`[...document.querySelectorAll('.dialog .btn')].find((b) => b.textContent === 'Unlock')`);
  check('the right password opens it', await waitFor(settled(LOCKED), 15000));
  await q(`__vellum.app.activate(${V(LOCKED)})`);
  await sleep(400);
  await q(`__vellum.ui.sidebar.showStructure()`);
  check('its Structure tab opens with its pages', await waitFor(`__vellum.app.active === ${V(LOCKED)} && document.querySelector('.sidebar-body .structure-summary')?.textContent?.startsWith('2 pages')`, 5000));
  check('page 1 is read from what the PDF exposes', await waitFor(`document.querySelector('.sidebar-body .structure-page[data-page="1"]')?.dataset.read === ''`, 10000));
  const lockedGroups = JSON.stringify(await groupsOf(1));
  check('page 1: a field, a note and a link — no text', lockedGroups === JSON.stringify(['fields:1', 'annotations:1', 'links:1']), lockedGroups);
  const note = await q(`document.querySelector('.structure-page[data-page="1"] .structure-note')?.textContent ?? ''`);
  check('it says text and images aren’t read, with the page size', note === '612 × 792 pt · Text and images aren’t read in a protected PDF.', note);
  await clickAt(`document.querySelector('.structure-page[data-page="1"] [data-group="fields"] .structure-item')`);
  const lockedField = [await prop('Name'), await prop('Value')];
  check('its field shows name and value', (await q(title)) === 'Form field' && JSON.stringify(lockedField) === JSON.stringify(['secret.name', 'Ada Lovelace']), lockedField.join(' / '));
  await clickAt(`document.querySelector('.structure-page[data-page="1"] [data-group="links"] .structure-item')`);
  check('its internal link goes to page 2', (await waitFor(`${title} === 'Link'`, 3000)) && (await prop('Destination')) === 'Page 2');
  await clickAt(`document.querySelector('.structure-page[data-page="2"] .structure-page-row')`);
  const rotated = await waitFor(`/turned 90°/.test(document.querySelector('.structure-page[data-page="2"] .structure-note')?.textContent ?? '')`, 5000);
  check('page 2: its geometry, turned 90°', rotated);
  await shot('structure-protected');
  check('Edit stays unavailable on it', await q(`Boolean(${V(LOCKED)}.textEditing.unavailableReason)`));

  const errors = await q(`JSON.stringify(__vellum.errors?.slice(${errorsBefore}) ?? [])`);
  check('no errors', errors === '[]', errors);
}
