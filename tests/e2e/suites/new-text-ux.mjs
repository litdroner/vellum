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
  check('no errors in the page', (await q(`__vellum.errors?.length ?? 0`)) === errorsBefore, JSON.stringify(await q(`__vellum.errors`)));
}
