// Vellum 0.6: copying, pasting and duplicating objects in Edit mode, in the real app.
//
// Reached the way a person reaches it: clicks to select, then Ctrl+C, Ctrl+V, Ctrl+D, Delete and
// Ctrl+Z. What comes back is read off the edit store, the selection and — for what matters — the saved
// file, re-read after the document is closed and opened again. Distances are in the page's user space.

export const files = { images: 'images', crosspage: 'crosspage' };

const SHIFT = 8;

export async function run(t) {
  const { c, q, check, sleep, shot, V, settled, waitFor, area } = t;
  const IMAGES = t.file('images');
  const rest = async (ms = 25000) => {
    await waitFor(settled(IMAGES), ms);
    await sleep(500);
  };

  /** The page's objects where they are now: key, kind, text, centre in points and on screen. */
  const objects = () => q(`(async () => {
    const v = ${V(IMAGES)};
    const { objects, records } = await v.textEditing.objects(1);
    const pv = v.viewer.getPageView(0);
    const vp = pv.viewport;
    const box = pv.div.getBoundingClientRect();
    const at = (m, x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
    return objects.map((o) => {
      const rec = records.get(o.ref.key) || null;
      const T = rec && rec.transform ? rec.transform : null;
      const pts = [0, 2, 4, 6].map((i) => (T ? at(T, o.geometry.quad[i], o.geometry.quad[i + 1]) : [o.geometry.quad[i], o.geometry.quad[i + 1]]));
      const cxp = pts.reduce((s, p) => s + p[0], 0) / 4;
      const cyp = pts.reduce((s, p) => s + p[1], 0) / 4;
      const [vx, vy] = vp.convertToViewportPoint(cxp, cyp);
      const gone = Boolean(rec && (rec.removed || (rec.encoding && rec.encoding.mode === 'none')));
      return { key: o.ref.key, kind: o.kind, text: o.kind === 'text-run' ? o.text : null, gone, cxp, cyp,
        cx: box.left + vx * (box.width / vp.width), cy: box.top + vy * (box.height / vp.height) };
    });
  })()`);
  const kinds = () => q(`${V(IMAGES)}.annotations.edits.map((e) => e.kind)`);
  const selected = async () => (await q(`(() => { const s = ${V(IMAGES)}.objectSelection.current; return s ? [...s.keys] : []; })()`));
  const sameSet = (a, b) => a.length === b.length && a.every((k) => b.includes(k));
  const offsetBy = (from, to, dx, dy) => Boolean(from && to) && Math.abs(to.cxp - from.cxp - dx) < 0.6 && Math.abs(to.cyp - from.cyp - dy) < 0.6;
  const editorOpen = () => q(`Boolean(${V(IMAGES)}.el.querySelector('.vl-text-editor'))`);

  area('copy and paste');
  await q(`__vellum.app.activate(${V(IMAGES)})`);
  await rest();
  await q(`${V(IMAGES)}.setTool('edit')`);
  await sleep(600);
  check('Edit mode', (await q(`${V(IMAGES)}.annotLayer.tool`)) === 'edit');
  let all = await objects();
  const picture = all.filter((o) => o.kind === 'image').sort((a, b) => a.cxp - b.cxp)[0];
  const caption = all.find((o) => o.text === 'Caption under the picture');
  check('a picture and its caption to work with', Boolean(picture && caption), JSON.stringify(all.map((o) => o.key)));
  await c.mouse(picture.cx, picture.cy);
  await sleep(450);
  await c.mouse(caption.cx, caption.cy, { modifiers: SHIFT });
  await sleep(450);
  check('both selected', sameSet(await selected(), [picture.key, caption.key]), JSON.stringify(await selected()));

  await c.key('Ctrl+C');
  await sleep(400);
  check('Ctrl+C changes nothing in the document', (await kinds()).length === 0);
  await c.key('Ctrl+V');
  await rest();
  await sleep(600);
  check('Ctrl+V adds a copy of each, as records of their own', sameSet(await kinds(), ['text-copy', 'image-copy']), JSON.stringify(await kinds()));
  let copies = (await objects()).filter((o) => o.key.startsWith('copy:'));
  const firstPaste = copies.map((o) => o.key);
  check('and the pasted objects are what is selected', sameSet(await selected(), firstPaste), JSON.stringify(await selected()));
  const pictureCopy = copies.find((o) => o.kind === 'image');
  const captionCopy = copies.find((o) => o.kind === 'text-run');
  check('the picture’s copy is 10 pt right and down', offsetBy(picture, pictureCopy, 10, -10), JSON.stringify([picture, pictureCopy]));
  check('the caption’s copy too, with the same text', offsetBy(caption, captionCopy, 10, -10) && captionCopy?.text === caption.text);
  await shot('pasted');

  await c.key('Ctrl+V');
  await rest();
  await sleep(600);
  copies = (await objects()).filter((o) => o.key.startsWith('copy:') && !firstPaste.includes(o.key));
  check('a second paste lands a step further', copies.length === 2 && offsetBy(picture, copies.find((o) => o.kind === 'image'), 20, -20),
    JSON.stringify(copies));
  await c.key('Ctrl+Z');
  await rest();
  check('one undo takes the whole paste away', (await kinds()).length === 2, JSON.stringify(await kinds()));

  area('deleting and duplicating');
  const pictureCopyNow = (await objects()).find((o) => o.key === pictureCopy.key);
  await q(`${V(IMAGES)}.objectSelection.set(1, [${JSON.stringify(pictureCopy.key)}])`);
  await sleep(300);
  await c.mouse(pictureCopyNow.cx + 30, pictureCopyNow.cy);
  await sleep(450);
  check('clicking the pasted picture selects it', sameSet(await selected(), [pictureCopy.key]), JSON.stringify(await selected()));
  await c.key('Delete');
  await rest();
  check('Delete takes the copy away and nothing else', JSON.stringify(await kinds()) === JSON.stringify(['text-copy']), JSON.stringify(await kinds()));

  const pic = (await objects()).find((o) => o.key === picture.key);
  await c.mouse(pic.cx, pic.cy);
  await sleep(450);
  await c.key('Ctrl+D');
  await rest();
  await sleep(600);
  const duplicate = (await objects()).find((o) => o.kind === 'image' && o.key.startsWith('copy:'));
  check('Ctrl+D duplicates the picture a step along', offsetBy(picture, duplicate, 10, -10), JSON.stringify(duplicate));
  check('and selects the duplicate', sameSet(await selected(), [duplicate?.key]), JSON.stringify(await selected()));

  const textCopy = (await objects()).find((o) => o.key === captionCopy.key);
  await c.key('Escape');
  await sleep(300);
  await c.mouse(textCopy.cx, textCopy.cy);
  await sleep(600);
  check('clicking pasted text selects it and opens no editor', sameSet(await selected(), [captionCopy.key]) && !(await editorOpen()),
    JSON.stringify(await selected()));

  area('save and reopen');
  await c.key('Escape');
  await q('__vellum.actions.save()');
  await waitFor(`!${V(IMAGES)}.annotations.dirty`, 25000);
  await q(`__vellum.app.close(${V(IMAGES)})`);
  await waitFor(`!${V(IMAGES)}`);
  await q(`__vellum.actions.openRecent(${JSON.stringify(IMAGES)})`);
  await rest();
  await q(`${V(IMAGES)}.setTool('edit')`);
  await sleep(600);
  all = await objects();
  const captions = all.filter((o) => o.text === caption.text);
  check('the saved file has the caption twice', captions.length === 2, JSON.stringify(all.map((o) => [o.kind, o.text])));
  check('ten points apart', captions.length === 2 && Math.abs(Math.abs(captions[1].cxp - captions[0].cxp) - 10) < 0.6);
  const pictures = all.filter((o) => o.kind === 'image');
  check('and three pictures: two of its own and the duplicate', pictures.length === 3, JSON.stringify(pictures));
  check('the duplicate is where it was put', pictures.some((o) => offsetBy(picture, o, 10, -10)));
  await shot('reopened');

  // ---- onto another page: Ctrl+X then Ctrl+V, and a drag let go over the other page ----------------
  area('another page');
  const CROSS = t.file('crosspage');
  const restCross = async () => {
    await waitFor(settled(CROSS), 25000);
    await sleep(500);
  };
  /** Page n's objects of the cross-page file where they are now, in points and on screen. */
  const crossObjects = (n) => q(`(async () => {
    const v = ${V(CROSS)};
    const { objects, records } = await v.textEditing.objects(${n});
    const pv = v.viewer.getPageView(${n - 1});
    const vp = pv.viewport;
    const box = pv.div.getBoundingClientRect();
    const at = (m, x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
    return objects.map((o) => {
      const rec = records.get(o.ref.key) || null;
      const T = rec && rec.transform ? rec.transform : null;
      const pts = [0, 2, 4, 6].map((i) => (T ? at(T, o.geometry.quad[i], o.geometry.quad[i + 1]) : [o.geometry.quad[i], o.geometry.quad[i + 1]]));
      const cxp = pts.reduce((s, p) => s + p[0], 0) / 4;
      const cyp = pts.reduce((s, p) => s + p[1], 0) / 4;
      const [vx, vy] = vp.convertToViewportPoint(cxp, cyp);
      const gone = Boolean(rec && (rec.removed || (rec.encoding && rec.encoding.mode === 'none')));
      return { key: o.ref.key, kind: o.kind, text: o.kind === 'text-run' ? o.text : null, width: o.record.info ? o.record.info.width : null, gone, cxp, cyp,
        cx: box.left + vx * (box.width / vp.width), cy: box.top + vy * (box.height / vp.height) };
    });
  })()`);
  const crossKinds = () => q(`${V(CROSS)}.annotations.edits.map((e) => e.kind).sort()`);
  const crossSelected = () => q(`(() => { const s = ${V(CROSS)}.objectSelection.current; return s ? [s.page, ...s.keys] : []; })()`);

  await q(`__vellum.app.activate(${V(CROSS)})`);
  await restCross();
  await q(`${V(CROSS)}.setTool('edit')`);
  await q(`${V(CROSS)}.viewer.currentScale = 0.3`);
  await sleep(800);
  await q(`${V(CROSS)}.viewer.currentPageNumber = 1`);
  await sleep(800);
  const plain = (await crossObjects(1)).find((o) => o.text === 'Plain caption');
  check('text on page 1 to cut', Boolean(plain));
  // Selected without a click, which would open the text editor (and Ctrl+X would cut its text).
  await q(`${V(CROSS)}.objectSelection.set(1, [${JSON.stringify(plain.key)}])`);
  await sleep(300);
  await c.key('Ctrl+X');
  await restCross();
  check('Ctrl+X takes it off page 1', JSON.stringify(await crossKinds()) === JSON.stringify(['text']), JSON.stringify(await crossKinds()));
  await q(`${V(CROSS)}.viewer.currentPageNumber = 2`);
  await sleep(600);
  await c.key('Ctrl+V');
  await restCross();
  await sleep(600);
  const pastedTwo = (await crossObjects(2)).find((o) => o.key.startsWith('copy:'));
  check('Ctrl+V puts it on page 2, where it was on page 1', pastedTwo?.text === 'Plain caption' && Math.abs(pastedTwo.cxp - plain.cxp) < 0.6 && Math.abs(pastedTwo.cyp - plain.cyp) < 0.6,
    JSON.stringify([plain, pastedTwo]));
  check('and selects it there', JSON.stringify(await crossSelected()) === JSON.stringify([2, pastedTwo?.key]), JSON.stringify(await crossSelected()));
  await c.key('Ctrl+Z');
  await restCross();
  await c.key('Ctrl+Z');
  await restCross();
  check('two undos put the text back on page 1', (await crossKinds()).length === 0, JSON.stringify(await crossKinds()));

  await c.key('Escape');
  await q(`${V(CROSS)}.viewer.currentPageNumber = 1`);
  await sleep(800);
  const tinted = (await crossObjects(1)).find((o) => o.kind === 'image');
  const dropAt = await q(`(() => { const r = ${V(CROSS)}.viewer.getPageView(1).div.getBoundingClientRect(); return { x: r.left + r.width * 0.4, y: r.top + r.height * 0.3, bottom: window.innerHeight }; })()`);
  check('page 2 is on screen to drop onto', dropAt.y > 0 && dropAt.y < dropAt.bottom, JSON.stringify(dropAt));
  await c.mouse(tinted.cx, tinted.cy);
  await sleep(450);
  await c.drag([tinted.cx, tinted.cy], [dropAt.x, dropAt.y], 12, { modifiers: 1 });
  await restCross();
  await sleep(600);
  check('a drag let go over page 2 moves the picture there, as one change', JSON.stringify(await crossKinds()) === JSON.stringify(['image', 'image-copy']), JSON.stringify(await crossKinds()));
  const dropped = (await crossObjects(2)).find((o) => o.key.startsWith('copy:'));
  const grabbedAt = await q(`(() => { const pv = ${V(CROSS)}.viewer.getPageView(1); const r = pv.div.getBoundingClientRect(); const vp = pv.viewport;
    return vp.convertToPdfPoint((${dropAt.x} - r.left) * vp.width / r.width, (${dropAt.y} - r.top) * vp.height / r.height); })()`);
  check('under the pointer, at its own size', dropped?.width === 32 && Math.abs(dropped.cxp - grabbedAt[0]) < 3 && Math.abs(dropped.cyp - grabbedAt[1]) < 3,
    JSON.stringify([dropped, grabbedAt]));
  check('and selected on page 2', JSON.stringify(await crossSelected()) === JSON.stringify([2, dropped?.key]), JSON.stringify(await crossSelected()));
  check('page 1 no longer shows it', (await crossObjects(1)).filter((o) => o.kind === 'image' && !o.gone).length === 0);

  await c.key('Escape');
  await q('__vellum.actions.save()');
  await waitFor(`!${V(CROSS)}.annotations.dirty`, 25000);
  await q(`__vellum.app.close(${V(CROSS)})`);
  await waitFor(`!${V(CROSS)}`);
  await q(`__vellum.actions.openRecent(${JSON.stringify(CROSS)})`);
  await restCross();
  await q(`${V(CROSS)}.setTool('edit')`);
  await sleep(600);
  const savedOne = await crossObjects(1);
  const savedTwo = await crossObjects(2);
  check('saved: page 1 has no picture', savedOne.filter((o) => o.kind === 'image').length === 0, JSON.stringify(savedOne.map((o) => o.kind)));
  check('and page 2 draws its own and the moved one', JSON.stringify(savedTwo.filter((o) => o.kind === 'image').map((o) => o.width)) === JSON.stringify([8, 32]),
    JSON.stringify(savedTwo.map((o) => [o.kind, o.width])));
  await shot('moved-to-page-2');
  check('no page errors were collected', (await q('__vellum.errors.length')) === 0, await q('JSON.stringify(__vellum.errors.slice(0, 3))'));
}
