// New text, where a person puts it and how its width handle behaves, in the real app on a document with
// an upright page and a /Rotate 90 page: right-click → Add Text Box starts the box at the point clicked
// (zoomed in and scrolled, on the upright and the turned page, and with the view itself turned), and the
// box's right-edge handle changes only the width its lines wrap to — never the text's size — on the turned
// page as on the upright one.

export const files = { mixed: 'mixed-sizes' };

export async function run(t) {
  const { c, q, check, sleep, V, settled, waitFor, area, shot } = t;
  const DOC = t.file('mixed');
  const v = V(DOC);
  const rest = async () => { await waitFor(settled(DOC), 25000); await sleep(400); };
  const newTexts = () => q(`${v}.annotations.edits.filter((e) => e.kind === 'inserted-text').map((e) => ({ id: e.id, size: e.size, width: e.width, transform: e.transform, box: e.box }))`);
  const pageEl = (n) => `${v}.viewerEl.querySelector('.page[data-page-number="${n}"]')`;
  const select = async (n, id) => {
    await q(`${v}.objectSelection.set(${n}, ['text:' + ${JSON.stringify(id)}])`);
    await waitFor(`${pageEl(n)}?.querySelectorAll('.vl-object-handle:not(.edge)').length === 4`, 5000);
    await sleep(300);
  };
  // Where the selected box is drawn, from its four corner handles: its top-left and its size, in client pixels.
  const drawn = (n) => q(`(() => {
    const hs = [...${pageEl(n)}.querySelectorAll('.vl-object-handle:not(.edge)')].map((h) => { const r = h.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; });
    if (hs.length !== 4) return null;
    const xs = hs.map((p) => p[0]), ys = hs.map((p) => p[1]);
    return { left: Math.min(...xs), top: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) };
  })()`);
  // A point on page n, `fx`/`fy` of the way across and down the page as it is shown, in client pixels.
  const onPage = (n, fx, fy) => q(`(() => { const r = ${v}.viewer.getPageView(${n} - 1).div.getBoundingClientRect(); return [r.left + r.width * ${fx}, r.top + r.height * ${fy}]; })()`);
  // Client pixels per PDF point on page n at the current zoom.
  const pxPerPoint = (n) => q(`(() => { const pv = ${v}.viewer.getPageView(${n} - 1); return pv.div.getBoundingClientRect().width / pv.viewport.width * pv.viewport.scale; })()`);

  const placedAt = async (n, at, label) => {
    const before = new Set((await newTexts()).map((r) => r.id));
    await c.mouse(at[0], at[1], { button: 'right' });
    await waitFor(`document.querySelector('.menu')`, 3000);
    const found = await q(`(() => { const b = [...document.querySelectorAll('.menu > *')].find((el) => el.textContent.includes('Add Text Box')); b?.click(); return Boolean(b); })()`);
    await waitFor(`(() => { const i = document.querySelector('.vl-text-input'); return i && i.value === 'New text' && i.selectionStart === 0 && i.selectionEnd === 8; })()`, 8000);
    await c.key('Escape');
    await rest();
    const added = (await newTexts()).find((r) => !before.has(r.id));
    if (added) await select(n, added.id);
    const box = added ? await drawn(n) : null;
    const off = box ? Math.hypot(box.left - at[0], box.top - at[1]) : Infinity;
    check(label, found && off < 3 && box.width > box.height, `clicked ${at.map(Math.round)}, box ${JSON.stringify(box && Object.fromEntries(Object.entries(box).map(([k, x]) => [k, Math.round(x)])))}, ${off.toFixed(1)} px off`);
    return added;
  };

  const wrapped = async (n, record, label) => {
    await select(n, record.id);
    const grip = await q(`(() => { const h = ${pageEl(n)}.querySelector('.vl-object-handle.reflow'); if (!h) return null; const r = h.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; })()`);
    const box = await drawn(n);
    // The handle is on the box's right edge as shown, halfway down.
    const onRight = grip && box && Math.abs(grip[0] - (box.left + box.width)) < 2 && Math.abs(grip[1] - (box.top + box.height / 2)) < 2;
    check(`${label}: the wrap handle is on the box's right edge as shown`, onRight, JSON.stringify({ grip, box }));
    if (!grip) return;
    const px = await pxPerPoint(n);
    await c.drag(grip, [grip[0] - 30, grip[1]], 10);
    await rest();
    const after = (await newTexts()).find((r) => r.id === record.id);
    const expected = record.box[2] - 30 / px;
    check(`${label}: dragging it 30 px left narrows the wrap width by 30 px worth of points`,
      after.width !== null && Math.abs(after.width - expected) < 1.5, `width ${after.width}, expected about ${expected.toFixed(2)}`);
    const sameLinear = record.transform.slice(0, 4).every((x, i) => Math.abs(x - after.transform[i]) < 1e-6);
    check(`${label}: the text keeps its size and scale`, after.size === record.size && sameLinear,
      `size ${record.size} → ${after.size}, ${JSON.stringify(record.transform)} → ${JSON.stringify(after.transform)}`);
    check(`${label}: its lines wrap to the new width`, after.box[2] <= after.width + 1e-6 && after.box[3] - after.box[1] > record.box[3] - record.box[1], JSON.stringify(after.box));
  };

  await waitFor(settled(DOC), 25000);
  const errorsBefore = await q(`__vellum.errors?.length ?? 0`);
  await q(`${v}.setTool('edit')`);
  await sleep(500);

  area('right-click placement and the wrap handle');
  await q(`${v}.zoomTo(1.6)`);
  await rest();
  // Page 1 scrolled so its top is out of view and a little sideways.
  await q(`${v}.goToPage(1)`);
  await sleep(200);
  await q(`${v}.container.scrollTop += 180; ${v}.container.scrollLeft = 40`);
  await sleep(400);
  const upright = await placedAt(1, await onPage(1, 0.2, 0.35), 'zoomed and scrolled: the box starts where page 1 was right-clicked, upright');
  if (upright) await wrapped(1, upright, 'the upright page (unchanged)');
  // The /Rotate 90 page.
  await q(`${v}.goToPage(4)`);
  await sleep(200);
  await q(`${v}.container.scrollTop += 120`);
  await sleep(400);
  const turned = await placedAt(4, await onPage(4, 0.3, 0.3), 'on the /Rotate 90 page the box starts where it was right-clicked, upright');
  await shot('placed-on-turned-page');

  if (turned) await wrapped(4, turned, 'the /Rotate 90 page');
  await shot('wrapped-on-turned-page');

  area('turned view');
  // The view turned too: page 4 is then shown at 180°.
  await q(`${v}.rotate(90)`);
  await rest();
  await q(`${v}.goToPage(4)`);
  await sleep(400);
  await placedAt(4, await onPage(4, 0.55, 0.4), 'with the view turned as well, the box starts where page 4 was right-clicked, upright');
  await q(`${v}.rotate(-90)`);
  await rest();

  area('selection moved to another page from outside a click');
  // Both pages in view at once, so a handle left behind on the page the selection left would show.
  await q(`${v}.zoomTo(0.3)`);
  await rest();
  await waitFor(`[1, 4].every((n) => ${v}.viewer.getPageView(n - 1)?.renderingState === 3)`, 10000);
  // Nothing may redraw a page by chance: no render still to come, and the pointer off the pages (a
  // hover redraws the page under it, selection and all).
  const bar = await q(`(() => { const r = ${v}.container.getBoundingClientRect(); return [r.left + r.width / 2, Math.max(2, r.top - 12)]; })()`);
  await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: bar[0], y: bar[1] });
  await sleep(1500);
  const marks = (n) => q(`(() => { const p = ${pageEl(n)}; return p ? p.querySelectorAll('.vl-object-handle, .vl-object-sel').length : -1; })()`);
  // Set straight on the model, then only a fixed wait: waiting for handles would pass on a stale one.
  const setFromOutside = async (n, id) => { await q(`${v}.objectSelection.set(${n}, ['text:' + ${JSON.stringify(id)}])`); await sleep(600); };
  const state = async () => ({ page: await q(`${v}.objectSelection.page`), p1: await marks(1), p4: await marks(4) });
  if (upright && turned) {
    await setFromOutside(1, upright.id);
    const first = await state();
    check('page 1 shows the selected box with its handles', first.page === 1 && first.p1 > 0 && first.p4 === 0, JSON.stringify(first));
    await setFromOutside(4, turned.id);
    const moved = await state();
    check('set from outside a click: page 1 keeps no handles, page 4 shows them', moved.page === 4 && moved.p1 === 0 && moved.p4 > 0, JSON.stringify(moved));
    await shot('selection-moved-programmatically');
    await q(`${v}.objectSelection.clear()`);
    await sleep(300);
    const cleared = await state();
    check('cleared from outside a click: no handles on either page', cleared.page === null && cleared.p1 === 0 && cleared.p4 === 0, JSON.stringify(cleared));
    // Then the same move made by a person: a click on the page-4 box, found where its handles were.
    await select(4, turned.id);
    const at = await q(`(() => { const hs = [...${pageEl(4)}.querySelectorAll('.vl-object-handle:not(.edge)')].map((h) => { const r = h.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; }); return [hs.reduce((s, p) => s + p[0], 0) / 4, hs.reduce((s, p) => s + p[1], 0) / 4]; })()`);
    await setFromOutside(1, upright.id);
    const back = await state();
    await c.mouse(at[0], at[1]);
    await waitFor(`${v}.objectSelection.page === 4 && document.querySelector('.vl-text-input')`, 5000);
    await sleep(300);
    // A click on text selects it and opens the editor over it, which stands in for its handles.
    const clicked = { ...(await state()), editing: await q(`Boolean(document.querySelector('.vl-text-input'))`) };
    check('set back to page 1 from outside, then a click on page 4: each leaves only the page it chose marked',
      back.page === 1 && back.p1 > 0 && back.p4 === 0 && clicked.page === 4 && clicked.p1 === 0 && clicked.editing,
      JSON.stringify({ back, clicked }));
    await c.key('Escape');
    await rest();
  } else {
    check('both new text boxes were placed for the selection check', false, JSON.stringify({ upright: Boolean(upright), turned: Boolean(turned) }));
  }
  check('no errors in the page', (await q(`__vellum.errors?.length ?? 0`)) === errorsBefore, JSON.stringify(await q(`__vellum.errors`)));
}
