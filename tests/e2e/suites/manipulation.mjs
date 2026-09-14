// Vellum 0.5.0 Phase 3: moving, scaling, turning, flipping and deleting objects in the real app.
//
// Everything is reached the way a person reaches it — Edit mode, then the mouse and the keyboard on
// the page. Nothing is driven through an internal that a person could not work: the app is asked
// where an object is, the pointer is dragged there, and what comes back is read off the DOM, the
// edit store, and — the check that actually matters — the page as pdf.js re-reads it after a save.
//
// Distances are compared in the page's OWN user space, not on screen. A rebuild re-renders every
// page and the scroll position can settle a little differently, so "the object is 60 pixels further
// right than it was a second ago" is not a fact about the object. Points are: the file is written in
// them, the record is stored in them, and they do not move when the view does. Screen coordinates
// are used for one thing only — telling the mouse where to press — and are always read immediately
// before the gesture that uses them.

export const files = {
  images: 'images', simple: 'simple', overlap: 'overlap', objects: 'objects',
};

export async function run(t) {
  const { c, q, check, sleep, shot, V, settled, waitFor, area } = t;
  const F = (name) => t.file(name);

  const rest = async (path, ms = 25000) => {
    await waitFor(settled(path), ms);
    await sleep(400);
  };
  const activate = async (path) => {
    await q(`__vellum.app.activate(${V(path)})`);
    await rest(path);
    await q(`${V(path)}.focus()`);
    await sleep(300);
  };
  const editMode = async (path) => {
    await q(`${V(path)}.setTool('edit')`);
    await sleep(500);
    return q(`${V(path)}.annotLayer.tool`);
  };
  const zoom = (path, n = 1) => q(`${V(path)}.viewer.getPageView(${n} - 1).viewport.scale`);

  /**
   * Every selectable object on a page, where it is NOW: its own quad with the transform its edit
   * record holds applied, in points, and the same thing converted to the screen. The arithmetic is
   * the suite's own rather than the app's, so a mistake in the app's version shows up here as a
   * disagreement instead of being repeated.
   */
  const objectsOn = (path, n) => q(`(async () => {
    const v = ${V(path)};
    const { objects, records } = await v.textEditing.objects(${n});
    const pv = v.viewer.getPageView(${n} - 1);
    if (!pv) return [];
    const vp = pv.viewport;
    const box = pv.div.getBoundingClientRect();
    const at = (m, x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
    const out = [];
    for (const o of objects) {
      const rec = records.get(o.ref.key) || null;
      const gone = Boolean(rec && (rec.removed || (rec.encoding && rec.encoding.mode === 'none')));
      const T = rec && rec.transform ? rec.transform : null;
      const xs = []; const ys = []; const quad = [];
      for (let i = 0; i < 8; i += 2) {
        const p = T ? at(T, o.geometry.quad[i], o.geometry.quad[i + 1]) : [o.geometry.quad[i], o.geometry.quad[i + 1]];
        quad.push(p[0], p[1]);
        const [vx, vy] = vp.convertToViewportPoint(p[0], p[1]);
        xs.push(box.left + vx * (box.width / vp.width));
        ys.push(box.top + vy * (box.height / vp.height));
      }
      const left = Math.min(...xs); const right = Math.max(...xs);
      const top = Math.min(...ys); const bottom = Math.max(...ys);
      const px = [quad[0], quad[2], quad[4], quad[6]];
      const py = [quad[1], quad[3], quad[5], quad[7]];
      out.push({
        key: o.ref.key, kind: o.kind, text: o.kind === 'text-run' ? o.text : null,
        caps: o.capabilities, gone, quad, transform: T,
        // In points: the centre, the extent, and the axis-aligned corners.
        cxp: (px[0] + px[1] + px[2] + px[3]) / 4, cyp: (py[0] + py[1] + py[2] + py[3]) / 4,
        wp: Math.max(...px) - Math.min(...px), hp: Math.max(...py) - Math.min(...py),
        x1p: Math.min(...px), y1p: Math.min(...py), x2p: Math.max(...px), y2p: Math.max(...py),
        // On screen, for the pointer only.
        left, top, right, bottom, cx: (left + right) / 2, cy: (top + bottom) / 2,
      });
    }
    return out;
  })()`);

  const objectAt = async (path, n, key) => (await objectsOn(path, n)).find((o) => o.key === key) ?? null;

  /** Scrolls an object into the middle of the view and reports where it ended up, and whether it is reachable. */
  const reveal = async (path, n, key) => {
    await q(`${V(path)}.goToPage(${n})`);
    await sleep(300);
    const found = await objectAt(path, n, key);
    if (!found) return null;
    await q(`(() => {
      const v = ${V(path)};
      const view = v.container.getBoundingClientRect();
      v.container.scrollTop += (${found.cy} - view.top) - view.height / 2;
      v.container.scrollLeft += (${found.cx} - view.left) - view.width / 2;
    })()`);
    await sleep(450);
    const now = await objectAt(path, n, key);
    if (!now) return null;
    const view = await q(`(() => { const r = ${V(path)}.container.getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom }; })()`);
    now.visible = now.cx > view.left + 4 && now.cx < view.right - 4 && now.cy > view.top + 4 && now.cy < view.bottom - 4;
    return now;
  };

  /** The selection as identity; `key` is the one selected object, when exactly one is. */
  const selection = (path) => q(`(() => {
    const s = ${V(path)}.objectSelection.current;
    return s ? { page: s.page, key: s.keys.length === 1 ? s.keys[0] : null, keys: [...s.keys], fields: Object.keys(s).sort() } : null;
  })()`);
  const editorOpen = (path) => q(`Boolean(${V(path)}.el.querySelector('.vl-text-editor'))`);
  const handles = (path) => q(`${V(path)}.el.querySelectorAll('.vl-object-handle').length`);
  const records = (path) => q(`${V(path)}.annotations.edits.map((e) => ({
    kind: e.kind, key: e.target.key, transform: e.transform || null,
    removed: Boolean(e.removed), mode: e.encoding ? e.encoding.mode : null,
  }))`);
  const recordFor = async (path, key) => (await records(path)).find((r) => r.key === key || `run:${r.key}` === key) ?? null;
  /**
   * How many undo steps there are, counted by rewinding and replaying the whole history. That
   * rebuilds the pages several times over, so it settles afterwards: what follows is usually a
   * gesture, and a gesture is measured against pages that have finished arriving.
   */
  const undoDepth = async (path) => {
    const n = await q(`(() => { let n = 0; const v = ${V(path)}; while (v.annotations.canUndo) { v.annotations.undo(); n++; } for (let i = 0; i < n; i++) v.annotations.redo(); return n; })()`);
    await rest(path);
    return n;
  };

  const closeEditor = async (path) => {
    if (!(await editorOpen(path))) return;
    await c.key('Escape');
    await sleep(400);
  };

  /** Selects an object with a plain click, closing the editor a text click opens. */
  const selectObject = async (path, n, key) => {
    const o = await reveal(path, n, key);
    if (!o?.visible) return o;
    await c.mouse(o.cx, o.cy);
    await sleep(450);
    await closeEditor(path);
    return o;
  };

  /** Drags an object by a screen offset, from wherever it is right now. Returns before and after. */
  const dragBy = async (path, n, key, dx, dy) => {
    const before = await reveal(path, n, key);
    if (!before?.visible) return { before, after: null };
    await c.drag([before.cx, before.cy], [before.cx + dx, before.cy + dy], 10);
    await rest(path);
    return { before, after: await objectAt(path, n, key) };
  };

  /** Did the object move by this many POINTS? (Screen y points down, page y points up.) */
  const movedBy = (before, after, dxp, dyp, tol = 1) => {
    if (!before || !after) return { ok: false, detail: 'the object was not found' };
    const dx = after.cxp - before.cxp;
    const dy = after.cyp - before.cyp;
    return {
      ok: Math.abs(dx - dxp) <= tol && Math.abs(dy - dyp) <= tol,
      detail: `moved ${dx.toFixed(2)}, ${dy.toFixed(2)} pt (wanted ${dxp.toFixed(2)}, ${dyp.toFixed(2)})`,
    };
  };

  // ---- 1 & 2. selecting either kind, and what each is allowed ------------------------------------

  area('selecting');
  await activate(F('images'));
  check('Edit mode is still the way in', await editMode(F('images')) === 'edit');

  const all = await objectsOn(F('images'), 1);
  const image0 = all.find((o) => o.kind === 'image');
  const text0 = all.find((o) => o.kind === 'text-run' && o.caps.editText === true);
  check('the page offers a picture and editable text', Boolean(image0 && text0),
    `${all.filter((o) => o.kind === 'image').length} images, ${all.filter((o) => o.kind === 'text-run').length} runs`);
  check('the picture may be moved, scaled, turned and deleted',
    image0.caps.move === true && image0.caps.scale === true && image0.caps.rotate === true && image0.caps.delete === true,
    JSON.stringify(image0.caps));
  check('and is never text-editable', image0.caps.editText !== true, String(image0.caps.editText));
  check('the text may be moved, scaled and deleted, but never turned',
    text0.caps.move === true && text0.caps.scale === true && text0.caps.delete === true && text0.caps.rotate !== true,
    JSON.stringify(text0.caps));

  await selectObject(F('images'), 1, image0.key);
  check('clicking a picture selects it', (await selection(F('images')))?.key === image0.key);
  check('the selection is identity and nothing else', (await selection(F('images')))?.fields.join(',') === 'keys,page');
  check('no editor opens for a picture', (await editorOpen(F('images'))) === false);
  check('four corner handles are offered, and no more', (await handles(F('images'))) === 4);

  await selectObject(F('images'), 1, text0.key);
  check('clicking editable text selects the run', (await selection(F('images')))?.key === text0.key);
  check('and handles are offered for it too, because text scales', (await handles(F('images'))) === 4);
  await shot('selected');

  // ---- 3. dragging text --------------------------------------------------------------------------

  area('dragging text');
  let scale = await zoom(F('images'));
  let move = await dragBy(F('images'), 1, text0.key, 60, -45);
  let fit = movedBy(move.before, move.after, 60 / scale, 45 / scale);
  check('the text ends up where it was dragged', fit.ok, fit.detail);
  check('a drag opens no editor: it was a drag, not a click', (await editorOpen(F('images'))) === false);
  let store = await records(F('images'));
  check('it wrote exactly one record, for that run', store.length === 1 && store[0].kind === 'text', JSON.stringify(store));
  check('the record is the file’s own glyphs, redrawn elsewhere', store[0].mode === 'original', store[0].mode);
  check('with an absolute transform on it, in points',
    Array.isArray(store[0].transform) && Math.abs(store[0].transform[4] - 60 / scale) < 1 && Math.abs(store[0].transform[5] - 45 / scale) < 1,
    JSON.stringify(store[0].transform));
  check('one drag is one undo step', (await undoDepth(F('images'))) === 1);

  const firstMove = store[0].transform;
  move = await dragBy(F('images'), 1, text0.key, -25, 15);
  fit = movedBy(move.before, move.after, -25 / scale, -15 / scale);
  check('a second drag moves it on from where it now is', fit.ok, fit.detail);
  store = await records(F('images'));
  check('and replaces the record rather than adding one', store.length === 1, JSON.stringify(store));
  check('the transform is absolute: the two drags are one placement, not two',
    Math.abs(store[0].transform[4] - (firstMove[4] - 25 / scale)) < 1
    && Math.abs(store[0].transform[5] - (firstMove[5] - 15 / scale)) < 1,
    `${JSON.stringify(firstMove)} → ${JSON.stringify(store[0].transform)}`);
  check('and is still one undo step per drag', (await undoDepth(F('images'))) === 2);
  await shot('text-dragged');

  // ---- 4. dragging a picture ----------------------------------------------------------------------

  area('dragging a picture');
  await selectObject(F('images'), 1, image0.key);
  move = await dragBy(F('images'), 1, image0.key, 35, 50);
  fit = movedBy(move.before, move.after, 35 / scale, -50 / scale);
  check('the picture ends up where it was dragged', fit.ok, fit.detail);
  check('its size is unchanged by a move',
    Math.abs(move.after.wp - move.before.wp) < 0.5 && Math.abs(move.after.hp - move.before.hp) < 0.5,
    `${move.before.wp.toFixed(1)}×${move.before.hp.toFixed(1)} → ${move.after.wp.toFixed(1)}×${move.after.hp.toFixed(1)}`);
  store = await records(F('images'));
  check('there are now two records: one per object, never one per gesture', store.length === 2, JSON.stringify(store));
  check('the picture’s record is an image record with a transform',
    store.some((r) => r.kind === 'image' && r.key === image0.key && Array.isArray(r.transform)), JSON.stringify(store));
  await shot('image-dragged');

  // ---- 7, 8. undo and redo, in the one history -----------------------------------------------------

  area('undo and redo');
  const where = async () => (await objectAt(F('images'), 1, image0.key)).cxp;
  const dragged = await where();
  await q(`${V(F('images'))}.annotations.undo()`);
  await rest(F('images'));
  check('undo takes the picture back', Math.abs((await where()) - move.before.cxp) < 0.5,
    `${(await where()).toFixed(1)} vs ${move.before.cxp.toFixed(1)} pt`);
  check('and takes its record with it', (await records(F('images'))).length === 1);
  await q(`${V(F('images'))}.annotations.redo()`);
  await rest(F('images'));
  check('redo puts it back where the drag left it', Math.abs((await where()) - dragged) < 0.5);
  check('undo and redo are the one history the whole app shares',
    await q(`${V(F('images'))}.annotations.canUndo && !${V(F('images'))}.annotations.canRedo`));

  // ---- 9. save, close, reopen: the file itself ------------------------------------------------------

  area('save and reload');
  const savedImage = (await objectAt(F('images'), 1, image0.key)).quad;
  const savedText = (await objectAt(F('images'), 1, text0.key)).quad;
  await q('__vellum.actions.save()');
  await waitFor(`!${V(F('images'))}.annotations.dirty`, 25000);
  await q(`__vellum.app.close(${V(F('images'))})`);
  await waitFor(`!${V(F('images'))}`);
  await q(`__vellum.actions.openRecent(${JSON.stringify(F('images'))})`);
  await rest(F('images'));
  check('the reopened document has a fresh history', await q(`!${V(F('images'))}.annotations.canUndo`));
  check('and no edit records: the change is in the bytes now', (await records(F('images'))).length === 0);
  // The saved file is a new original, so its objects are found afresh — by where they are drawn.
  const near = (a, b, tol) => a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) <= tol);
  const reopened = await objectsOn(F('images'), 1);
  const keptImage = reopened.filter((o) => o.kind === 'image').find((o) => near(o.quad, savedImage, 1));
  check('the picture is where it was dragged to, in the saved file', Boolean(keptImage),
    JSON.stringify(reopened.filter((o) => o.kind === 'image').map((o) => o.quad.map((v) => Math.round(v)))));
  const keptText = reopened.filter((o) => o.kind === 'text-run').find((o) => near(o.quad, savedText, 1.5));
  check('and so is the text', Boolean(keptText),
    JSON.stringify(reopened.filter((o) => o.kind === 'text-run').map((o) => [o.text, o.quad.map((v) => Math.round(v))])));
  check('the moved text is still the same text', keptText?.text === text0.text, `${keptText?.text} vs ${text0.text}`);
  check('and both can be moved again from where they now are',
    keptText?.caps.move === true && keptImage?.caps.move === true);
  await shot('reopened');

  // ---- 5, 6. deleting either kind -------------------------------------------------------------------

  area('deleting');
  await editMode(F('images'));
  const doomedText = (await objectsOn(F('images'), 1)).find((o) => o.kind === 'text-run' && o.caps.delete === true);
  await selectObject(F('images'), 1, doomedText.key);
  check('the text to delete is selected', (await selection(F('images')))?.key === doomedText.key);
  await c.key('Delete');
  await rest(F('images'));
  let now = await objectsOn(F('images'), 1);
  check('Delete removes the selected text', !now.some((o) => o.key === doomedText.key && !o.gone),
    JSON.stringify(now.filter((o) => o.kind === 'text-run').map((o) => o.text)));
  check('nothing is left selected: it isn’t there to select', (await selection(F('images'))) === null);
  check('and it left one record, in the removal mode', (await recordFor(F('images'), doomedText.key))?.mode === 'none');

  const doomedImage = (await objectsOn(F('images'), 1)).find((o) => o.kind === 'image');
  await selectObject(F('images'), 1, doomedImage.key);
  await c.key('Delete');
  await rest(F('images'));
  now = await objectsOn(F('images'), 1);
  check('Delete removes the selected picture', !now.some((o) => o.key === doomedImage.key && !o.gone));
  check('with a record that says so', (await recordFor(F('images'), doomedImage.key))?.removed === true);
  await q(`${V(F('images'))}.annotations.undo()`);
  await rest(F('images'));
  check('undo brings the picture back', (await objectsOn(F('images'), 1)).some((o) => o.key === doomedImage.key && !o.gone));
  await shot('deleted');

  // ---- 12. keyboard: nudging, and one burst is one undo ----------------------------------------------

  area('keyboard');
  await activate(F('simple'));
  check('Edit mode on a plain document', await editMode(F('simple')) === 'edit');
  const line = (await objectsOn(F('simple'), 1)).find((o) => o.caps.move === true);
  const start = await selectObject(F('simple'), 1, line.key);
  check('a run is on screen and selected to nudge', (await selection(F('simple')))?.key === line.key,
    `visible: ${start?.visible}`);
  const depthBefore = await undoDepth(F('simple'));
  for (let i = 0; i < 5; i++) {
    await c.key('ArrowRight');
    await sleep(60);
  }
  await sleep(1500); // longer than the burst's own idle, so it is certainly written
  await rest(F('simple'));
  let nudged = await objectAt(F('simple'), 1, line.key);
  fit = movedBy(start, nudged, 5, 0, 0.2);
  check('five arrow keys move the run exactly five points to the right', fit.ok, fit.detail);
  check('and the arrows nudged rather than turning the page',
    await q(`${V(F('simple'))}.state.pageNumber`) === 1);
  check('a burst of arrow keys is ONE undo step', (await undoDepth(F('simple'))) === depthBefore + 1,
    `${await undoDepth(F('simple'))} steps, was ${depthBefore}`);
  await q(`${V(F('simple'))}.annotations.undo()`);
  await rest(F('simple'));
  check('and undoing it puts the run back where the burst started',
    Math.abs((await objectAt(F('simple'), 1, line.key)).cxp - start.cxp) < 0.2);
  await q(`${V(F('simple'))}.annotations.redo()`);
  await rest(F('simple'));

  const beforeShift = await objectAt(F('simple'), 1, line.key);
  await c.key('Shift+ArrowDown');
  await sleep(1500);
  await rest(F('simple'));
  nudged = await objectAt(F('simple'), 1, line.key);
  fit = movedBy(beforeShift, nudged, 0, -10, 0.2);
  check('Shift and an arrow moves ten points, downwards on screen', fit.ok, fit.detail);
  await shot('nudged');

  // ---- scale, turn and flip ------------------------------------------------------------------------

  area('scale, turn and flip');
  await activate(F('objects'));
  await editMode(F('objects'));
  const movable = (await objectsOn(F('objects'), 1)).filter((o) => o.kind === 'image' && o.caps.scale === true);
  check('the objects fixture offers a picture that can be scaled', movable.length > 0, `${movable.length} of them`);
  const key = movable[0].key;
  const target = await selectObject(F('objects'), 1, key);
  check('it is selected, with handles', (await handles(F('objects'))) === 4);
  // Pull the bottom-left corner away from the top-right one, which must not move.
  const anchor = [target.right, target.top];
  const corner = [target.left, target.bottom];
  await c.drag(corner, [anchor[0] + (corner[0] - anchor[0]) * 1.5, anchor[1] + (corner[1] - anchor[1]) * 1.5], 10);
  await rest(F('objects'));
  const scaled = await objectAt(F('objects'), 1, key);
  check('a corner drag scales the picture by the distance the corner moved',
    Math.abs(scaled.wp / target.wp - 1.5) < 0.1 && Math.abs(scaled.hp / target.hp - 1.5) < 0.1,
    `${(scaled.wp / target.wp).toFixed(3)}× by ${(scaled.hp / target.hp).toFixed(3)}×`);
  check('and the opposite corner stays exactly where it was, to a fifth of a point',
    Math.abs(scaled.x2p - target.x2p) < 0.2 && Math.abs(scaled.y2p - target.y2p) < 0.2,
    `${target.x2p.toFixed(2)}, ${target.y2p.toFixed(2)} → ${scaled.x2p.toFixed(2)}, ${scaled.y2p.toFixed(2)} pt`);
  check('scaling is uniform: the shape is unchanged',
    Math.abs((scaled.wp / scaled.hp) - (target.wp / target.hp)) < 0.02);
  check('one corner drag is one undo step', (await undoDepth(F('objects'))) === 1);

  const square = await objectAt(F('objects'), 1, key);
  await c.key(']');
  await sleep(1000);
  await rest(F('objects'));
  const turned = await objectAt(F('objects'), 1, key);
  check('a quarter turn swaps what the picture measures across the page',
    Math.abs(turned.wp - square.hp) < 0.3 && Math.abs(turned.hp - square.wp) < 0.3,
    `${square.wp.toFixed(1)}×${square.hp.toFixed(1)} → ${turned.wp.toFixed(1)}×${turned.hp.toFixed(1)} pt`);
  check('and turns it about its own centre',
    Math.abs(turned.cxp - square.cxp) < 0.3 && Math.abs(turned.cyp - square.cyp) < 0.3);
  check('a turn is one record, still, and still one undo step',
    (await records(F('objects'))).filter((r) => r.key === key).length === 1 && (await undoDepth(F('objects'))) === 2);
  await c.key('[');
  await sleep(1000);
  await rest(F('objects'));
  let back = await objectAt(F('objects'), 1, key);
  check('turning the other way puts it back',
    Math.abs(back.wp - square.wp) < 0.3 && Math.abs(back.hp - square.hp) < 0.3,
    `${back.wp.toFixed(1)}×${back.hp.toFixed(1)} vs ${square.wp.toFixed(1)}×${square.hp.toFixed(1)} pt`);

  await c.key('Shift+H');
  await sleep(1000);
  await rest(F('objects'));
  const flipped = await objectAt(F('objects'), 1, key);
  check('a horizontal flip leaves the picture exactly where it is on the page',
    Math.abs(flipped.wp - back.wp) < 0.2 && Math.abs(flipped.hp - back.hp) < 0.2
    && Math.abs(flipped.cxp - back.cxp) < 0.2 && Math.abs(flipped.cyp - back.cyp) < 0.2,
    `${back.wp.toFixed(1)}×${back.hp.toFixed(1)} at ${back.cxp.toFixed(1)} → ${flipped.wp.toFixed(1)}×${flipped.hp.toFixed(1)} at ${flipped.cxp.toFixed(1)}`);
  check('and it really changed the placement: the transform is a reflection',
    (await recordFor(F('objects'), key))?.transform?.length === 6
    && ((r) => r[0] * r[3] - r[1] * r[2] < 0)((await recordFor(F('objects'), key)).transform),
    JSON.stringify((await recordFor(F('objects'), key))?.transform));
  await c.key('Shift+V');
  await sleep(1000);
  await rest(F('objects'));
  check('a vertical flip on top of it is a half turn: the handedness comes back',
    ((r) => r[0] * r[3] - r[1] * r[2] > 0)((await recordFor(F('objects'), key)).transform),
    JSON.stringify((await recordFor(F('objects'), key))?.transform));
  await shot('scaled-turned-flipped');

  // The whole sequence survives a save: the file, not the record, is what has to be right.
  await q('__vellum.actions.save()');
  await waitFor(`!${V(F('objects'))}.annotations.dirty`, 25000);
  const afterSave = await objectAt(F('objects'), 1, key);
  await q(`__vellum.app.close(${V(F('objects'))})`);
  await waitFor(`!${V(F('objects'))}`);
  await q(`__vellum.actions.openRecent(${JSON.stringify(F('objects'))})`);
  await rest(F('objects'));
  const savedBack = (await objectsOn(F('objects'), 1)).filter((o) => o.kind === 'image')
    .find((o) => near(o.quad, afterSave.quad, 1));
  check('scaled, turned and flipped: the saved file has the picture exactly there', Boolean(savedBack),
    `wanted ${afterSave.quad.map((v) => Math.round(v))}`);

  // ---- 10. refusals: nothing is offered that cannot be honoured --------------------------------------

  area('refusals');
  await editMode(F('objects'));
  const objects = await objectsOn(F('objects'), 1);
  const refused = objects.filter((o) => o.caps.move !== true);
  check('the fixture really has refused objects to test with', refused.length > 0, `${refused.length} of ${objects.length}`);
  for (const o of refused) {
    check(`${o.key} refuses in the one reason vocabulary`,
      typeof o.caps.move === 'string' && o.caps.move === o.caps.delete, JSON.stringify(o.caps));
  }
  const clipped = objects.find((o) => o.caps.move === 'clipped');
  check('a clipped picture is refused as clipped', Boolean(clipped), JSON.stringify(objects.map((o) => o.caps.move)));
  if (clipped) {
    const held = JSON.stringify(await records(F('objects')));
    const at = await selectObject(F('objects'), 1, clipped.key);
    check('no handles are drawn on something that cannot be scaled', (await handles(F('objects'))) === 0);
    await c.drag([at.cx, at.cy], [at.cx + 40, at.cy + 40], 10);
    await sleep(900);
    await rest(F('objects'));
    check('dragging it writes nothing at all', JSON.stringify(await records(F('objects'))) === held);
    const still = await objectAt(F('objects'), 1, clipped.key);
    check('and it has not moved', Math.abs(still.cxp - at.cxp) < 0.1 && Math.abs(still.cyp - at.cyp) < 0.1);
  }
  const someText = objects.find((o) => o.kind === 'text-run' && o.caps.move === true);
  if (someText) {
    await selectObject(F('objects'), 1, someText.key);
    const held = JSON.stringify(await records(F('objects')));
    await c.key(']');
    await sleep(900);
    check('text refuses a quarter turn rather than writing one it cannot',
      JSON.stringify(await records(F('objects'))) === held);
  }

  // ---- 11. z-order: a gesture acts on the object a click would pick ------------------------------------

  area('z-order');
  await activate(F('overlap'));
  await editMode(F('overlap'));
  const stack = await objectsOn(F('overlap'), 1);
  check('the overlap page draws four picture draws and two runs',
    stack.filter((o) => o.kind === 'image').length === 4 && stack.filter((o) => o.kind === 'text-run').length === 2,
    JSON.stringify(stack.map((o) => o.key)));
  const under = stack.find((o) => o.text === 'Under the picture');
  const over = stack.find((o) => o.text === 'Over the picture');
  const covering = stack.filter((o) => o.kind === 'image')
    .find((o) => o.x1p <= under.x1p && o.x2p >= under.x2p && o.y1p <= under.y1p && o.y2p >= under.y2p);
  check('one picture completely covers a run', Boolean(covering), covering?.key);
  const spot = await reveal(F('overlap'), 1, under.key);
  await c.mouse(spot.cx, spot.cy);
  await sleep(450);
  check('clicking the covered text selects the picture on top, not the text',
    (await selection(F('overlap')))?.key === covering.key, (await selection(F('overlap')))?.key);
  const stackHeld = await records(F('overlap'));
  await c.drag([spot.cx, spot.cy], [spot.cx + 30, spot.cy], 10);
  await rest(F('overlap'));
  const stackNow = await records(F('overlap'));
  check('and the drag moved that picture, not the text underneath',
    stackNow.length === stackHeld.length + 1 && stackNow.at(-1).key === covering.key, JSON.stringify(stackNow));
  const textStill = await objectAt(F('overlap'), 1, under.key);
  check('the text underneath did not move',
    Math.abs(textStill.cxp - under.cxp) < 0.1 && !textStill.transform,
    `${under.cxp.toFixed(2)} → ${textStill.cxp.toFixed(2)} pt`);
  const top = await reveal(F('overlap'), 1, over.key);
  await c.mouse(top.cx, top.cy);
  await sleep(450);
  check('and text drawn over a picture is what a click there picks',
    (await selection(F('overlap')))?.key === over.key, (await selection(F('overlap')))?.key);
  await closeEditor(F('overlap'));
  await shot('z-order');

  check('no page errors were collected', (await q('__vellum.errors.length')) === 0,
    await q('JSON.stringify(__vellum.errors.slice(0, 3))'));
}
