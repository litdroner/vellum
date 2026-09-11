// Vellum 0.5.0 Phase 0 hardening in the real app: confirming the first change to a signed PDF (a
// note, Edit mode, a page change), the tagged-text notice, the PDF/A refusal, soft-mask and layer
// explanations, and thumbnails redrawn after an edit.

export const files = {
  signed: 'signed', 'signed-edit': 'signed', 'signed-pages': 'signed',
  tagged: 'tagged', pdfa: 'pdfa', transparency: 'transparency', objects: 'objects', thumbs: 'simple',
};

export async function run(t) {
  const { c, q, check, sleep, shot, V, settled, waitFor } = t;
  const F = (name) => t.file(name);
  const activate = async (path) => {
    await q(`__vellum.app.activate(${V(path)})`);
    await waitFor(settled(path), 20000);
    await q(`${V(path)}.focus()`);
    await sleep(400);
  };
  const dialogOpen = `Boolean(document.querySelector('.dialog-backdrop.open'))`;
  const dialogTitle = () => q(`document.querySelector('.dialog-backdrop.open .dialog-title')?.textContent ?? null`);
  const clickDialog = async (label) => {
    const at = await q(`(() => {
      const b = [...document.querySelectorAll('.dialog-backdrop.open .dialog-actions .btn')].find((x) => x.textContent === ${JSON.stringify(label)});
      if (!b) return null;
      const r = b.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    })()`);
    if (at) await c.mouse(at.x, at.y);
    await waitFor(`!${dialogOpen}`, 3000);
    await sleep(300);
    return Boolean(at);
  };
  /** Scrolls a line into the middle of the view, as a person would before clicking it. */
  const reveal = async (path, page, text) => {
    const found = await q(`(async () => {
      const v = ${V(path)};
      v.goToPage(${page});
      const p = await v.textEditing.page(${page});
      const item = p.runs.find((r) => r.text === ${JSON.stringify(text)});
      if (!item) return false;
      const pv = v.viewer.getPageView(${page} - 1);
      const vp = pv.viewport;
      const box = pv.div.getBoundingClientRect();
      const view = v.container.getBoundingClientRect();
      const [, vy] = vp.convertToViewportPoint(item.run.quad[6], item.run.quad[7]);
      const y = box.top + (vy * box.height) / vp.height;
      v.container.scrollTop += (y - view.top) - view.height / 2;
      return true;
    })()`);
    await sleep(500);
    return found;
  };
  const runAt = (path, page, text) => q(`(async () => {
    const v = ${V(path)};
    const p = await v.textEditing.page(${page});
    const item = p.runs.find((r) => r.text === ${JSON.stringify(text)});
    if (!item) return null;
    const pv = v.viewer.getPageView(${page} - 1);
    const vp = pv.viewport;
    const box = pv.div.getBoundingClientRect();
    let x = 0; let y = 0;
    for (let i = 0; i < 8; i += 2) {
      const [vx, vy] = vp.convertToViewportPoint(item.run.quad[i], item.run.quad[i + 1]);
      x += box.left + (vx * box.width) / vp.width;
      y += box.top + (vy * box.height) / vp.height;
    }
    return { x: x / 4, y: y / 4, editable: item.run.editable };
  })()`);
  const editorOpen = `Boolean(document.querySelector('.vl-text-editor'))`;
  const editorGone = `!document.querySelector('.vl-text-editor')`;
  const status = () => q(`(() => { const s = document.querySelector('.vl-edit-status'); return s ? { text: s.textContent, tone: s.className } : null; })()`);
  const replaceText = async (text) => {
    await q(`document.querySelector('.vl-text-input')?.select()`);
    await c.type(text);
    await sleep(300);
  };
  const tip = () => q(`document.querySelector('.vl-edit-tip')?.textContent ?? ''`);
  const toasts = (pattern) => q(`[...document.querySelectorAll('#toasts .toast')].filter((t) => ${pattern}.test(t.textContent)).length`);
  const pagePoint = (path, dy = 0) => q(`(() => { const r = ${V(path)}.viewer.getPageView(0).div.getBoundingClientRect(); return { x: r.left + r.width * 0.6, y: r.top + 220 + ${dy} }; })()`);
  const addNote = async (path, text, dy) => {
    await q(`${V(path)}.focus()`);
    await c.key('N');
    const at = await pagePoint(path, dy);
    await c.mouse(at.x, at.y);
    await waitFor(`Boolean(document.querySelector('.vl-note-editor'))`, 3000);
    await c.type(text);
    await q(`document.querySelector('.vl-note-editor .btn.primary').click()`);
  };
  const notes = (path) => q(`${V(path)}.annotations.all.length`);

  await waitFor(Object.values({ a: F('signed'), b: F('tagged'), c: F('thumbs') }).map((p) => settled(p)).join(' && '), 30000);

  // ---- signed PDF: a note --------------------------------------------------------------------------
  t.area('signed');
  const SIGNED = F('signed');
  await activate(SIGNED);
  await addNote(SIGNED, 'First note', 0);
  check('the first change to a signed PDF asks first', await waitFor(`document.querySelector('.dialog-backdrop.open .dialog-title')?.textContent === 'This PDF is digitally signed'`, 5000), await dialogTitle());
  check('…and says saving would invalidate the signature', /no longer be valid/.test(await q(`document.querySelector('.dialog-backdrop.open .dialog-message')?.textContent ?? ''`)));
  check('…with Cancel as the default choice', await q(`document.activeElement?.textContent === 'Cancel'`));
  check('…and nothing has changed while it asks', (await notes(SIGNED)) === 0 && !(await q(`${V(SIGNED)}.annotations.dirty`)));
  await shot('p0-01-signed-dialog');
  await clickDialog('Cancel');
  check('Cancel drops the change', (await notes(SIGNED)) === 0 && !(await q(`${V(SIGNED)}.annotations.dirty`)));
  await addNote(SIGNED, 'Second note', 40);
  check('it asks again next time', await waitFor(dialogOpen, 5000));
  await clickDialog('Make changes anyway');
  check('“Make changes anyway” applies the change', await waitFor(`${V(SIGNED)}.annotations.all.length === 1 && ${V(SIGNED)}.annotations.dirty`, 3000));
  await addNote(SIGNED, 'Third note', 80);
  await sleep(800);
  check('later changes don’t ask again', !(await q(dialogOpen)) && (await notes(SIGNED)) === 2);

  // ---- signed PDF: Edit mode -------------------------------------------------------------------------
  const SIGNED_EDIT = F('signed-edit');
  await activate(SIGNED_EDIT);
  await c.key('E');
  check('Edit text on a signed PDF asks first', await waitFor(dialogOpen, 5000), await dialogTitle());
  await clickDialog('Cancel');
  check('…Cancel leaves Edit mode off', await waitFor(`${V(SIGNED_EDIT)}.annotLayer.tool === 'select'`, 3000));
  await q(`${V(SIGNED_EDIT)}.focus()`);
  await c.key('E');
  await waitFor(dialogOpen, 5000);
  await clickDialog('Make changes anyway');
  check('…going ahead turns Edit mode on, with the text outlined', await waitFor(`${V(SIGNED_EDIT)}.annotLayer.tool === 'edit' && document.querySelectorAll('.vl-decor polygon.vl-edit-run').length >= 1`, 8000));
  const agreement = await runAt(SIGNED_EDIT, 1, 'A signed agreement');
  await c.mouse(agreement.x, agreement.y);
  await waitFor(editorOpen, 4000);
  await replaceText('A changed agreement');
  await c.key('Enter');
  check('…and text can then be edited without asking again', await waitFor(`${editorGone} && ${settled(SIGNED_EDIT)} && ${V(SIGNED_EDIT)}.annotations.edits.length === 1`, 10000) && !(await q(dialogOpen)));
  await c.key('V');

  // ---- signed PDF: a page change ---------------------------------------------------------------------
  const SIGNED_PAGES = F('signed-pages');
  await activate(SIGNED_PAGES);
  const rotateFromMenu = async () => {
    const at = await pagePoint(SIGNED_PAGES, 200);
    await c.mouse(at.x, at.y, { button: 'right' });
    await waitFor(`[...document.querySelectorAll('.menu-item .menu-label')].some((l) => l.textContent === 'Rotate page right')`, 3000);
    const item = await q(`(() => {
      const b = [...document.querySelectorAll('.menu-item')].find((x) => x.querySelector('.menu-label')?.textContent === 'Rotate page right');
      const r = b.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    })()`);
    await c.mouse(item.x, item.y);
  };
  await rotateFromMenu();
  check('rotating a page of a signed PDF asks first', await waitFor(dialogOpen, 5000));
  await clickDialog('Cancel');
  await sleep(500);
  check('…Cancel leaves the page as it was', (await q(`${V(SIGNED_PAGES)}.annotations.plan[0].rotate`)) === 0 && !(await q(`${V(SIGNED_PAGES)}.annotations.dirty`)));
  await rotateFromMenu();
  await waitFor(dialogOpen, 5000);
  await clickDialog('Make changes anyway');
  check('…going ahead rotates it', await waitFor(`${settled(SIGNED_PAGES)} && ${V(SIGNED_PAGES)}.shownPlan[0].rotate === 90`, 10000));

  // ---- tagged PDF ---------------------------------------------------------------------------------------
  t.area('tagged');
  const TAGGED = F('tagged');
  await activate(TAGGED);
  await c.key('E');
  await waitFor(`document.querySelectorAll('.vl-decor polygon.vl-edit-run').length >= 2`, 8000);
  await reveal(TAGGED, 1, 'A tagged heading');
  const heading = await runAt(TAGGED, 1, 'A tagged heading');
  await c.mouse(heading.x, heading.y);
  check('the tagged heading opens for editing', await waitFor(editorOpen, 4000));
  check('opening tagged text says Vellum doesn’t update accessibility tags',
    await waitFor(`[...document.querySelectorAll('#toasts .toast')].some((t) => /tagged for accessibility/.test(t.textContent))`, 5000));
  check('…without claiming the tags are kept', await q(`[...document.querySelectorAll('#toasts .toast')].some((t) => /doesn’t update those tags/.test(t.textContent))`));
  await shot('p0-02-tagged-notice');
  await c.key('Escape');
  await waitFor(editorGone, 3000);
  await reveal(TAGGED, 1, 'A tagged paragraph of text.');
  const paragraph = await runAt(TAGGED, 1, 'A tagged paragraph of text.');
  await c.mouse(paragraph.x, paragraph.y);
  await waitFor(editorOpen, 4000);
  await sleep(600);
  check('…and says it once per document', (await toasts('/tagged for accessibility/')) <= 1);
  await c.key('Escape');
  await waitFor(editorGone, 3000);
  await c.key('V');

  // ---- PDF/A ------------------------------------------------------------------------------------------------
  t.area('pdfa');
  const PDFA = F('pdfa');
  await activate(PDFA);
  await c.key('E');
  await waitFor(`document.querySelectorAll('.vl-decor polygon.vl-edit-run').length >= 1`, 8000);
  await reveal(PDFA, 1, 'Archived text in an embedded font');
  const archived = await runAt(PDFA, 1, 'Archived text in an embedded font');
  await c.mouse(archived.x, archived.y);
  await waitFor(editorOpen, 4000);
  await replaceText('Quartz');
  await waitFor(`document.querySelector('.vl-edit-status')?.classList.contains('error')`, 3000);
  const refused = await status();
  check('a change that needs a substitute font is refused, naming PDF/A', refused?.tone.includes('error') && /PDF\/A/.test(refused.text), refused?.text);
  check('…and Done is disabled', await q(`document.querySelector('.vl-edit-bar .btn.primary').disabled`));
  await shot('p0-03-pdfa-refused');
  await replaceText('Archived text');
  await waitFor(`!document.querySelector('.vl-edit-status')?.classList.contains('error')`, 3000);
  await c.key('Enter');
  check('…while a change in the embedded font is applied', await waitFor(`${editorGone} && ${settled(PDFA)} && ${V(PDFA)}.annotations.edits.length === 1`, 10000));
  await c.key('V');

  // ---- soft mask and layers: explained, not edited ---------------------------------------------------------
  t.area('explanations');
  const TRANSPARENCY = F('transparency');
  await activate(TRANSPARENCY);
  await c.key('E');
  await waitFor(`document.querySelectorAll('.vl-decor polygon.vl-edit-run').length >= 3`, 8000);
  await reveal(TRANSPARENCY, 1, 'Masked text');
  const masked = await runAt(TRANSPARENCY, 1, 'Masked text');
  check('text under a soft mask is not editable', masked && masked.editable === false);
  await c.mouse(masked.x, masked.y);
  check('…and clicking it explains the soft mask', await waitFor(`/soft mask/i.test(document.querySelector('.vl-edit-tip')?.textContent ?? '')`, 3000), await tip());
  check('…and no editor opens', await q(editorGone));
  await reveal(TRANSPARENCY, 1, 'Half-transparent text');
  const half = await runAt(TRANSPARENCY, 1, 'Half-transparent text');
  await c.mouse(half.x, half.y);
  check('half-transparent text still opens for editing', await waitFor(editorOpen, 4000));
  await c.key('Escape');
  await waitFor(editorGone, 3000);
  await c.key('V');
  const OBJECTS = F('objects');
  await activate(OBJECTS);
  await c.key('E');
  await sleep(1200);
  await reveal(OBJECTS, 1, 'Text on a visible layer');
  const layered = await runAt(OBJECTS, 1, 'Text on a visible layer');
  check('text on a layer is not editable', layered && layered.editable === false, JSON.stringify(layered));
  await c.mouse(layered.x, layered.y);
  check('text on a layer explains why it can’t be edited', await waitFor(`/layer/i.test(document.querySelector('.vl-edit-tip')?.textContent ?? '')`, 3000), await tip());
  await shot('p0-04-layer-tip');
  await c.key('V');

  // ---- thumbnails follow an edit ---------------------------------------------------------------------------
  t.area('thumbnails');
  const THUMBS = F('thumbs');
  await activate(THUMBS);
  await q(`__vellum.ui.sidebar.showPages()`);
  await waitFor(`Boolean(document.querySelector('.thumbs .thumb[data-page="1"] canvas'))`, 8000);
  await sleep(500);
  const before = await q(`document.querySelector('.thumbs .thumb[data-page="1"] canvas').toDataURL()`);
  await c.key('E');
  await waitFor(`document.querySelectorAll('.vl-decor polygon.vl-edit-run').length >= 3`, 8000);
  await reveal(THUMBS, 1, 'Hello, world');
  const hello = await runAt(THUMBS, 1, 'Hello, world');
  await c.mouse(hello.x, hello.y);
  await waitFor(editorOpen, 4000);
  await replaceText('Hello, thumbnails');
  await c.key('Enter');
  await waitFor(`${editorGone} && ${settled(THUMBS)}`, 10000);
  const redrawn = await waitFor(`(() => { const c = document.querySelector('.thumbs .thumb[data-page="1"] canvas'); return Boolean(c) && c.toDataURL() !== ${JSON.stringify(before)}; })()`, 10000);
  check('the page’s thumbnail is redrawn after its text is edited', redrawn);
  await c.key('V');

  const errors = await q('__vellum.errors');
  t.area(null);
  check('no runtime errors', errors.length === 0, JSON.stringify(errors).slice(0, 400));
}
