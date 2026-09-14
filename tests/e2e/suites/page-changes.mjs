// Vellum 0.5.0: objects moved in Edit mode follow their page through the page organiser, in the real
// app. A picture and its caption are moved together, the page is duplicated and turned from the
// command palette and moved to the front, and then the document is saved, closed and opened again:
// both copies of the page must hold the objects where they were put. (The engine proves every case
// of this in tests/editing/object-pages.test.mjs; this proves the path a person takes.)

export const files = { gallery: 'gallery' };

const SHIFT = 8;

export async function run(t) {
  const { c, q, check, sleep, shot, V, settled, waitFor, area } = t;
  const DOC = t.file('gallery');

  const rest = async (ms = 25000) => {
    await waitFor(settled(DOC), ms);
    await sleep(400);
  };

  /** The selectable objects of a page where they are now: in points, and on screen for the mouse. */
  const objectsOn = (n) => q(`(async () => {
    const v = ${V(DOC)};
    const { objects, records } = await v.textEditing.objects(${n});
    const pv = v.viewer.getPageView(${n} - 1);
    const vp = pv.viewport;
    const box = pv.div.getBoundingClientRect();
    const at = (m, x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
    return objects.map((o) => {
      const rec = records.get(o.ref.key) || null;
      const T = rec && rec.transform ? rec.transform : null;
      const quad = []; const xs = []; const ys = [];
      for (let i = 0; i < 8; i += 2) {
        const p = T ? at(T, o.geometry.quad[i], o.geometry.quad[i + 1]) : [o.geometry.quad[i], o.geometry.quad[i + 1]];
        quad.push(p[0], p[1]);
        const [vx, vy] = vp.convertToViewportPoint(p[0], p[1]);
        xs.push(box.left + vx * (box.width / vp.width));
        ys.push(box.top + vy * (box.height / vp.height));
      }
      return { key: o.ref.key, kind: o.kind, text: o.kind === 'text-run' ? o.text : null, quad, cx: (Math.min(...xs) + Math.max(...xs)) / 2, cy: (Math.min(...ys) + Math.max(...ys)) / 2 };
    });
  })()`);
  const reveal = async (n, keys) => {
    await q(`${V(DOC)}.goToPage(${n})`);
    await sleep(400);
    const list = (await objectsOn(n)).filter((o) => keys.includes(o.key));
    const cy = list.reduce((s, o) => s + o.cy, 0) / list.length;
    await q(`(() => { const v = ${V(DOC)}; const r = v.container.getBoundingClientRect(); v.container.scrollTop += (${cy} - r.top) - r.height / 2; })()`);
    await sleep(450);
    return (await objectsOn(n)).filter((o) => keys.includes(o.key));
  };
  const palette = async (label) => {
    await q(`${V(DOC)}.focus()`);
    await c.key('Ctrl+K');
    await waitFor(`document.activeElement?.closest?.('.palette')`, 3000);
    await c.type(label);
    await sleep(300);
    await c.key('Enter');
    await sleep(300);
  };
  const plan = () => q(`${V(DOC)}.annotations.plan.map((e) => ({ id: e.id, index: e.index, rotate: e.rotate }))`);
  const near = (a, b, tol) => a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) <= tol);

  area('moving objects');
  await q(`__vellum.app.activate(${V(DOC)})`);
  await rest();
  await q(`${V(DOC)}.setTool('edit')`);
  await sleep(500);
  const start = await objectsOn(2);
  const picture = start.find((o) => o.kind === 'image');
  const caption = start.find((o) => o.text === 'Picture two');
  check('page 2 has its picture and caption', Boolean(picture && caption));
  let [p, cap] = await reveal(2, [picture.key, caption.key]);
  if (p.kind !== 'image') [p, cap] = [cap, p];
  await c.mouse(p.cx, p.cy);
  await sleep(450);
  await c.mouse(cap.cx, cap.cy, { modifiers: SHIFT });
  await sleep(450);
  check('both are selected', await q(`${V(DOC)}.objectSelection.size`) === 2);
  const scale = await q(`${V(DOC)}.viewer.getPageView(1).viewport.scale`);
  await c.drag([p.cx, p.cy], [p.cx + 50, p.cy + 40], 10);
  await rest();
  const moved = await objectsOn(2);
  const movedPicture = moved.find((o) => o.key === picture.key).quad;
  const movedCaption = moved.find((o) => o.key === caption.key).quad;
  check('the group moved', near(movedPicture, picture.quad.map((v, i) => v + (i % 2 ? -40 / scale : 50 / scale)), 1),
    `${picture.quad.map(Math.round)} → ${movedPicture.map(Math.round)}`);
  check('two records, on the entry of page 2', await q(`(() => { const v = ${V(DOC)}; return v.annotations.edits.length === 2 && v.annotations.edits.every((e) => e.entry === v.shownPlan[1].id); })()`));

  area('page changes');
  await q(`${V(DOC)}.setTool('select')`);
  await q(`${V(DOC)}.goToPage(2)`);
  await sleep(500);
  const originalId = (await plan())[1].id;
  await palette('Duplicate page');
  await rest();
  let now = await plan();
  check('the page organiser duplicated page 2', now.length === 4 && now[1].id === originalId && now[2].index === 1, JSON.stringify(now));
  check('and the copy has records of its own', await q(`${V(DOC)}.annotations.edits.length`) === 4);
  const copyId = now[2].id;
  await q(`${V(DOC)}.goToPage(3)`);
  await sleep(500);
  await palette('Rotate page right');
  await rest();
  now = await plan();
  check('the copy is turned', now.find((e) => e.id === copyId)?.rotate === 90, JSON.stringify(now));
  await q(`(() => { const v = ${V(DOC)}; v.movePages([${JSON.stringify(copyId)}], 0); })()`);
  await rest();
  now = await plan();
  check('and moved to the front', now[0].id === copyId && now[2].id === originalId, JSON.stringify(now));
  await shot('page-changes');

  area('save and reopen');
  await q('__vellum.actions.save()');
  check('saved', await waitFor(`!${V(DOC)}.annotations.dirty`, 25000));
  await q(`__vellum.app.close(${V(DOC)})`);
  await waitFor(`!${V(DOC)}`);
  await q(`__vellum.actions.openRecent(${JSON.stringify(DOC)})`);
  await rest();
  check('the file has four pages', await q(`${V(DOC)}.pdf.numPages`) === 4);
  check('the turned copy is first, the original third', await q(`(async () => {
    const v = ${V(DOC)};
    return (await v.pdf.getPage(1)).rotate === 90 && (await v.pdf.getPage(3)).rotate === 0;
  })()`));
  for (const n of [1, 3]) {
    const objects = await objectsOn(n);
    check(`page ${n} holds the picture where the group put it`, objects.some((o) => o.kind === 'image' && near(o.quad, movedPicture, 1)),
      JSON.stringify(objects.filter((o) => o.kind === 'image').map((o) => o.quad.map(Math.round))));
    check(`page ${n} holds the caption where the group put it`, objects.some((o) => o.text === 'Picture two' && near(o.quad, movedCaption, 1.5)),
      JSON.stringify(objects.filter((o) => o.kind === 'text-run').map((o) => [o.text, o.quad.map(Math.round)])));
  }
  const untouched = await objectsOn(2);
  check('the page that was not changed is exactly as the file had it',
    untouched.some((o) => o.text === 'Picture one') && untouched.some((o) => o.kind === 'image' && near(o.quad, [72, 560, 252, 560, 252, 695, 72, 695], 0.5)),
    JSON.stringify(untouched.map((o) => [o.kind, o.text, o.quad.map(Math.round)])));
  check('no page errors were collected', (await q('__vellum.errors.length')) === 0, await q('JSON.stringify(__vellum.errors.slice(0, 3))'));
}
