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
  images: 'images', simple: 'simple', overlap: 'overlap', objects: 'objects', faces: 'faces',
};

/** Modifier bits for the DevTools client (tools/cdp-client.mjs). */
const ALT = 1;
const SHIFT = 8;

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
  /** Corner handles only: they scale. Edge handles stretch, and are counted by edgeHandles. */
  const handles = (path) => q(`${V(path)}.el.querySelectorAll('.vl-object-handle:not(.edge)').length`);
  const edgeHandles = (path) => q(`${V(path)}.el.querySelectorAll('.vl-object-handle.edge').length`);
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

  /**
   * Drags an object by a screen offset, from wherever it is right now. Returns before and after. Alt
   * is held, which turns snapping off: these checks are about a move following the hand exactly, and
   * a line that happens to end within a few pixels of another would otherwise, rightly, snap to it.
   * Snapping itself is checked in its own area.
   */
  const dragBy = async (path, n, key, dx, dy) => {
    const before = await reveal(path, n, key);
    if (!before?.visible) return { before, after: null };
    await c.drag([before.cx, before.cy], [before.cx + dx, before.cy + dy], 10, { modifiers: ALT });
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
  check('the text may be moved, scaled, turned and deleted, but never stretched',
    text0.caps.move === true && text0.caps.scale === true && text0.caps.delete === true && text0.caps.rotate === true && text0.caps.stretch !== true,
    JSON.stringify(text0.caps));

  await selectObject(F('images'), 1, image0.key);
  check('clicking a picture selects it', (await selection(F('images')))?.key === image0.key);
  check('the selection is identity and nothing else', (await selection(F('images')))?.fields.join(',') === 'keys,page');
  check('no editor opens for a picture', (await editorOpen(F('images'))) === false);
  check('four corner handles are offered', (await handles(F('images'))) === 4);
  check('and four edge handles, because a picture can be stretched', (await edgeHandles(F('images'))) === 4);

  await selectObject(F('images'), 1, text0.key);
  check('clicking editable text selects the run', (await selection(F('images')))?.key === text0.key);
  check('and corner handles are offered for it too, because text scales', (await handles(F('images'))) === 4);
  check('but no edge handles: text is never stretched', (await edgeHandles(F('images'))) === 0);
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
  check('it is selected, with corner handles', (await handles(F('objects'))) === 4);
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

  // ---- stretch: an edge handle, along the picture's own axis ------------------------------------------

  area('stretch');
  // Counted first: counting rewinds and replays the history, and every step of that rebuilds the
  // pages, which can leave the view scrolled a little differently from where a handle was just read.
  const stretchDepth = await undoDepth(F('objects'));
  const unstretched = await reveal(F('objects'), 1, key);
  check('the turned, flipped picture still has four edge handles', (await edgeHandles(F('objects'))) === 4);
  // Whichever of its own edges is on the right of the screen now: drag that one further right.
  const rightEdge = await q(`(() => {
    const els = [...${V(F('objects'))}.el.querySelectorAll('.vl-object-handle.edge')];
    const boxes = els.map((el) => { const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
    return boxes.sort((a, b) => b.x - a.x)[0] ?? null;
  })()`);
  check('an edge handle is on the right of the picture', Boolean(rightEdge) && Math.abs(rightEdge.x - unstretched.right) < 3,
    JSON.stringify({ rightEdge, right: unstretched.right }));
  const zoomNow = await zoom(F('objects'));
  await c.drag([rightEdge.x, rightEdge.y], [rightEdge.x + 40, rightEdge.y], 10);
  await rest(F('objects'));
  const stretched = await objectAt(F('objects'), 1, key);
  check('dragging it widens the picture by exactly the drag',
    Math.abs((stretched.wp - unstretched.wp) - 40 / zoomNow) < 0.5, `${unstretched.wp.toFixed(1)} → ${stretched.wp.toFixed(1)} pt (wanted +${(40 / zoomNow).toFixed(1)})`);
  check('its height is unchanged: a stretch is not a scale', Math.abs(stretched.hp - unstretched.hp) < 0.3,
    `${unstretched.hp.toFixed(2)} → ${stretched.hp.toFixed(2)} pt`);
  check('and its left edge stays exactly where it was', Math.abs(stretched.x1p - unstretched.x1p) < 0.3 && Math.abs(stretched.y1p - unstretched.y1p) < 0.3,
    `${unstretched.x1p.toFixed(2)}, ${unstretched.y1p.toFixed(2)} → ${stretched.x1p.toFixed(2)}, ${stretched.y1p.toFixed(2)}`);
  check('still one record for the picture, and one undo step for the stretch',
    (await records(F('objects'))).filter((r) => r.key === key).length === 1 && (await undoDepth(F('objects'))) === stretchDepth + 1);
  await shot('stretched');

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
  check('scaled, turned, flipped and stretched: the saved file has the picture exactly there', Boolean(savedBack),
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

  // ---- text turns (0.6): [ and ], the command, the rotate handle, save and reopen; never a flip ----------

  area('text turns');
  const someText = objects.find((o) => o.kind === 'text-run' && o.caps.move === true);
  check('editable text may be turned', someText?.caps.rotate === true, JSON.stringify(someText?.caps));
  if (someText) {
    const tKey = someText.key;
    const turnDepth = await undoDepth(F('objects'));
    const upright = await reveal(F('objects'), 1, tKey);
    await q(`${V(F('objects'))}.objectSelection.set(1, [${JSON.stringify(tKey)}])`);
    await q(`${V(F('objects'))}.focus()`);
    await sleep(500);
    await c.key(']');
    await sleep(1000);
    await rest(F('objects'));
    // objectSelection.set() draws nothing by itself; the turn has redrawn the page with its handles.
    check('selected text has a rotate handle', await waitFor(`${V(F('objects'))}.el.querySelectorAll('.vl-object-rotate').length === 1`, 4000));
    const quarter = await objectAt(F('objects'), 1, tKey);
    check('] turns the text a quarter turn about its own centre',
      Math.abs(quarter.wp - upright.hp) < 0.3 && Math.abs(quarter.hp - upright.wp) < 0.3
      && Math.abs(quarter.cxp - upright.cxp) < 0.3 && Math.abs(quarter.cyp - upright.cyp) < 0.3,
      `${upright.wp.toFixed(1)}×${upright.hp.toFixed(1)} → ${quarter.wp.toFixed(1)}×${quarter.hp.toFixed(1)} pt`);
    check('one record, one undo step',
      (await records(F('objects'))).filter((r) => `run:${r.key}` === tKey).length === 1 && (await undoDepth(F('objects'))) === turnDepth + 1);
    await q(`${V(F('objects'))}.textEditor.turnSelected(-1)`);
    await sleep(1000);
    await rest(F('objects'));
    const unturned = await objectAt(F('objects'), 1, tKey);
    check('the Turn left command turns it back', Math.abs(unturned.wp - upright.wp) < 0.3 && Math.abs(unturned.hp - upright.hp) < 0.3);

    const heldText = JSON.stringify(await records(F('objects')));
    await c.key('Shift+H');
    await sleep(900);
    check('text is never flipped: nothing written', JSON.stringify(await records(F('objects'))) === heldText);

    // The rotate handle, dragged about 50° clockwise with Shift held: 45°, in the 15° steps.
    const at = await reveal(F('objects'), 1, tKey);
    const grip = await q(`(() => { const r = ${V(F('objects'))}.el.querySelector('.vl-object-rotate')?.getBoundingClientRect(); return r ? [r.left + r.width / 2, r.top + r.height / 2] : null; })()`);
    check('the rotate handle is on screen', Boolean(grip));
    if (grip) {
      const a = (50 * Math.PI) / 180;
      const [vx, vy] = [grip[0] - at.cx, grip[1] - at.cy];
      await c.drag(grip, [at.cx + vx * Math.cos(a) - vy * Math.sin(a), at.cy + vx * Math.sin(a) + vy * Math.cos(a)], 12, { modifiers: SHIFT });
      await sleep(900);
      await rest(F('objects'));
      const r = (await recordFor(F('objects'), tKey))?.transform;
      const angle = r ? (Math.atan2(r[1], r[0]) * 180) / Math.PI : NaN;
      check('the handle turns the text 45° clockwise, exactly a turn', Math.abs(angle + 45) < 0.05 && r[0] === r[3] && r[1] === -r[2], JSON.stringify(r));
      const turnedText = await objectAt(F('objects'), 1, tKey);
      check('about its own centre', Math.abs(turnedText.cxp - at.cxp) < 0.5 && Math.abs(turnedText.cyp - at.cyp) < 0.5);
      await shot('text-turned');

      await q('__vellum.actions.save()');
      await waitFor(`!${V(F('objects'))}.annotations.dirty`, 25000);
      await q(`__vellum.app.close(${V(F('objects'))})`);
      await waitFor(`!${V(F('objects'))}`);
      await q(`__vellum.actions.openRecent(${JSON.stringify(F('objects'))})`);
      await rest(F('objects'));
      const kept = (await objectsOn(F('objects'), 1)).find((o) => o.kind === 'text-run' && o.text === someText.text);
      const slope = kept ? (Math.atan2(kept.quad[3] - kept.quad[1], kept.quad[2] - kept.quad[0]) * 180) / Math.PI : NaN;
      check('saved and reopened: the same text, still turned 45°, and editable', Math.abs(slope + 45) < 0.5 && kept.caps.editText === true,
        `${kept?.text} at ${slope}`);
    }
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

  // ---- 12. snapping while dragging -------------------------------------------------------------------
  // Measured on screen, where snapping is decided: a line vertical on screen is the one snapped to,
  // whatever the rotation. Every number compared comes from one reading of the page, taken after the
  // drag has settled, so a scroll that settles differently can't enter into it.

  area('snapping');
  const SIMPLE = F('simple');
  await activate(SIMPLE);
  await editMode(SIMPLE);
  await q(`${V(SIMPLE)}.objectSelection.clear()`);
  const guides = () => q(`${V(SIMPLE)}.el.querySelectorAll('.vl-snap-guide').length`);
  const pageBox = (n = 1) => q(`(() => { const r = ${V(SIMPLE)}.viewer.getPageView(${n} - 1).div.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom }; })()`);
  const across = (b) => [b.left, (b.left + b.right) / 2, b.right];
  /**
   * Where to take a box so its left edge ends `gap` pixels right of some other object's vertical line
   * (or the page's), with no other line near its own three: then that one line is the only thing it
   * can snap to, across. The nearest such place, as { owner, index, line } — whose line it is, so it
   * can be read again after the drag — or null when the page has none.
   */
  const spotBeside = (box, others, page, gap) => {
    const lines = [...others.map((o) => ({ owner: o.key, b: o })), { owner: 'page', b: page }]
      .flatMap(({ owner, b }) => across(b).map((line, index) => ({ owner, index, line })));
    const w = box.right - box.left;
    const fits = lines.filter(({ line }) => {
      const mine = [line + gap, line + gap + w / 2, line + gap + w];
      return lines.every((l) => Math.abs(l.line - line) < 0.01 || mine.every((v) => Math.abs(v - l.line) > 6))
        && mine[0] > page.left && mine[2] < page.right
        && Math.abs(line + gap - box.left) >= 20; // a real drag, well past the click threshold
    });
    fits.sort((a, b) => Math.abs(a.line + gap - box.left) - Math.abs(b.line + gap - box.left));
    return fits[0] ?? null;
  };
  /** A drag held part-way, so what is drawn while the hand is still down can be read. */
  const holdDrag = async (from, to, { modifiers = 0, name = null } = {}) => {
    await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: from[0], y: from[1], modifiers });
    await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: from[0], y: from[1], button: 'left', clickCount: 1, modifiers });
    for (let i = 1; i <= 10; i++) {
      const x = from[0] + ((to[0] - from[0]) * i) / 10;
      const y = from[1] + ((to[1] - from[1]) * i) / 10;
      await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'left', buttons: 1, modifiers });
      await sleep(16);
    }
    await sleep(150);
    const during = await guides();
    if (name) await shot(name);
    await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: to[0], y: to[1], button: 'left', clickCount: 1, modifiers });
    await sleep(150);
    return { during, after: await guides() };
  };
  /** Drags the objects `keys` (the first is pressed) so their left edge goes `gap` px right of a lone line. */
  const snapDrag = async (keys, gap, options) => {
    const first = await reveal(SIMPLE, 1, keys[0]);
    const all = await objectsOn(SIMPLE, 1);
    const moving = all.filter((o) => keys.includes(o.key));
    const box = { left: Math.min(...moving.map((o) => o.left)), right: Math.max(...moving.map((o) => o.right)) };
    const others = all.filter((o) => !keys.includes(o.key) && !o.gone && (o.kind === 'image' || o.text?.trim()));
    const page = await pageBox();
    const spot = spotBeside(box, others, page, gap);
    if (!spot) return { spot };
    const dx = spot.line + gap - box.left;
    const seen = await holdDrag([first.cx, first.cy], [first.cx + dx, first.cy], options);
    await rest(SIMPLE);
    return { spot, dx, seen, before: moving };
  };
  /** Where a set of objects' left edge is now, and the line it went beside, from one reading. */
  const leftNow = async (keys, { spot }) => {
    const all = await objectsOn(SIMPLE, 1);
    const left = Math.min(...all.filter((o) => keys.includes(o.key)).map((o) => o.left));
    if (!spot) return { left, line: null };
    const owner = spot.owner === 'page' ? await pageBox() : all.find((o) => o.key === spot.owner);
    return { left, line: across(owner)[spot.index] };
  };
  const onLine = (at) => at.line !== null && Math.abs(at.left - at.line) < 0.05;
  const said = (at) => `left ${at.left.toFixed(3)} vs line ${at.line?.toFixed(3)}`;

  const texts = (await objectsOn(SIMPLE, 1)).filter((o) => o.kind === 'text-run' && o.caps.move === true && o.text?.trim());
  check('the page has lines to drag and snap to', texts.length >= 3, texts.length);
  const mover = texts.at(-1);
  const depthSnap = await undoDepth(SIMPLE);

  // With Alt: the move is exactly the hand's, even 2 px from a line.
  let snapped = await snapDrag([mover.key], 2, { modifiers: ALT });
  check('there is a place 2 px beside a line with nothing else near', Boolean(snapped.spot));
  check('with Alt held no guide is drawn', snapped.seen?.during === 0, JSON.stringify(snapped.seen));
  let rec = await recordFor(SIMPLE, mover.key);
  const exact = snapped.dx / (await zoom(SIMPLE));
  check('with Alt held the move is exactly the hand’s',
    rec && Math.abs(rec.transform[4] - (snapped.before[0].transform?.[4] ?? 0) - exact) < 0.3, `${rec?.transform} for ${exact.toFixed(2)} pt`);
  await q(`${V(SIMPLE)}.annotations.undo()`);
  await rest(SIMPLE);

  // Without Alt: the same drag lands exactly on the line, with a guide while the hand is down.
  snapped = await snapDrag([mover.key], 2, { name: 'snap-guide' });
  let at =await leftNow([mover.key], snapped);
  check('a drag that ends 2 px beside another object’s line lands exactly on it', onLine(at), `${said(at)} (${snapped.spot?.owner})`);
  check('a guide line is drawn while it is snapped', snapped.seen?.during > 0, JSON.stringify(snapped.seen));
  check('and goes when the hand lets go', snapped.seen?.after === 0, JSON.stringify(snapped.seen));
  rec = await recordFor(SIMPLE, mover.key);
  check('a snapped drag is still a plain move, one record and one undo step',
    rec && rec.transform[0] === 1 && rec.transform[1] === 0 && rec.transform[2] === 0 && rec.transform[3] === 1
    && (await undoDepth(SIMPLE)) === depthSnap + 1, JSON.stringify(rec));

  // Several objects: the group's box is what snaps.
  const partner = texts.at(-2);
  const p = await reveal(SIMPLE, 1, partner.key);
  await c.mouse(p.cx, p.cy);
  await sleep(450);
  await closeEditor(SIMPLE);
  const m = await objectAt(SIMPLE, 1, mover.key);
  await c.mouse(m.cx, m.cy, { modifiers: SHIFT });
  await sleep(450);
  check('two lines are selected to drag together', (await selection(SIMPLE))?.keys.length === 2);
  const group = [mover.key, partner.key];
  snapped = await snapDrag(group, -3);
  at = await leftNow(group, snapped);
  check('a group dragged 3 px short of a line lands with its left edge exactly on it', onLine(at), `${said(at)} (${snapped.spot?.owner})`);

  // With the view turned, the line snapped to is still the one vertical on screen.
  await q(`${V(SIMPLE)}.rotate(90)`);
  await sleep(900);
  await rest(SIMPLE);
  await q(`${V(SIMPLE)}.objectSelection.clear()`);
  snapped = await snapDrag([mover.key], 2);
  at = await leftNow([mover.key], snapped);
  check('on a turned view it lands exactly on the line as it is shown',
    onLine(at) && snapped.seen?.during > 0, `${said(at)} (${snapped.spot?.owner}), guides ${JSON.stringify(snapped.seen)}`);
  await q(`${V(SIMPLE)}.rotate(-90)`);
  await sleep(700);
  await rest(SIMPLE);
  await shot('snapped');

  // ---- replacing a picture's image from a file ------------------------------------------------------
  // The host's file dialog is a native window the DevTools client can't work, so the file comes in
  // where the dialog hands it over: TextEditor.replacePictureWith(), the rest of replacePicture().

  area('replace picture');
  const OBJ = F('objects');
  await activate(OBJ);
  await editMode(OBJ);
  await q(`${V(OBJ)}.objectSelection.clear()`);
  const replaceable = (await objectsOn(OBJ, 1)).filter((o) => o.kind === 'image' && !o.gone && o.caps.replace === true)
    .sort((a, b) => b.wp * b.hp - a.wp * a.hp)[0];
  check('the objects page has a picture that can be replaced', Boolean(replaceable));
  const picked = await selectObject(OBJ, 1, replaceable.key);
  check('clicking it selects it', (await selection(OBJ))?.key === replaceable.key, JSON.stringify(await selection(OBJ)));
  const barButtons = () => q(`[...(${V(OBJ)}.el.querySelector('.vl-arrange-bar')?.querySelectorAll('button') ?? [])].filter((b) => !b.hidden).map((b) => b.getAttribute('aria-label'))`);
  check('one selected picture gets the bar with only “Replace picture…”', JSON.stringify(await barButtons()) === '["Replace picture…"]', JSON.stringify(await barButtons()));
  /** The colour pdf.js painted at the middle of an object, read off the page canvas. */
  const paintedAt = (o) => q(`(() => {
    const pv = ${V(OBJ)}.viewer.getPageView(0);
    const canvas = pv.canvas ?? pv.div.querySelector('canvas');
    const r = canvas.getBoundingClientRect();
    const x = Math.round((${o.cx} - r.left) * canvas.width / r.width);
    const y = Math.round((${o.cy} - r.top) * canvas.height / r.height);
    return [...canvas.getContext('2d').getImageData(x, y, 1, 1).data.slice(0, 3)];
  })()`);
  const magenta = (rgb) => rgb[0] > 200 && rgb[1] < 60 && rgb[2] > 200;
  const replaceWith = (bytesExpr, name) => q(`(async () => {
    const bytes = await (${bytesExpr});
    return ${V(OBJ)}.textEditor.replacePictureWith({ name: ${JSON.stringify(name)}, bytes });
  })()`);
  const MAGENTA_PNG = `(async () => {
    const canvas = new OffscreenCanvas(40, 20);
    const g = canvas.getContext('2d');
    g.fillStyle = '#ff00ff';
    g.fillRect(0, 0, 40, 20);
    return new Uint8Array(await (await canvas.convertToBlob({ type: 'image/png' })).arrayBuffer());
  })()`;
  const replaceRecord = () => q(`(() => {
    const e = ${V(OBJ)}.annotations.edits.find((r) => r.target.key === ${JSON.stringify(replaceable.key)});
    return e ? { replacement: e.replacement ?? null, transform: e.transform ?? null, count: ${V(OBJ)}.annotations.edits.filter((r) => r.target.key === e.target.key).length } : null;
  })()`);

  check('before: the picture isn’t magenta', !magenta(await paintedAt(picked)), JSON.stringify(await paintedAt(picked)));
  const replaceDepth = await undoDepth(OBJ);
  check('replacing it with a PNG succeeds', (await replaceWith(MAGENTA_PNG, 'magenta.png')) === true);
  await rest(OBJ);
  let replacedNow = await objectAt(OBJ, 1, replaceable.key);
  const replacedRecord = await replaceRecord();
  check('one record, holding the replacement: a 40 × 20 PNG', replacedRecord?.count === 1 && replacedRecord.replacement?.format === 'png'
    && replacedRecord.replacement.width === 40 && replacedRecord.replacement.height === 20, JSON.stringify(replacedRecord));
  check('the picture’s frame is exactly what it was', near(replacedNow.quad, replaceable.quad, 0.01),
    `${replaceable.quad.map((v) => v.toFixed(2))} → ${replacedNow.quad.map((v) => v.toFixed(2))}`);
  check('the page now shows the new image there', magenta(await paintedAt(replacedNow)), JSON.stringify(await paintedAt(replacedNow)));
  check('it is still selected, with the bar', (await selection(OBJ))?.key === replaceable.key && (await barButtons()).length === 1);
  check('one undo step', (await undoDepth(OBJ)) === replaceDepth + 1);
  await shot('picture-replaced');

  await q(`${V(OBJ)}.annotations.undo()`);
  await rest(OBJ);
  check('undo brings the old image back', !magenta(await paintedAt(await objectAt(OBJ, 1, replaceable.key))) && !(await replaceRecord())?.replacement);
  await q(`${V(OBJ)}.annotations.redo()`);
  await rest(OBJ);
  check('redo replaces it again', magenta(await paintedAt(await objectAt(OBJ, 1, replaceable.key))) && Boolean((await replaceRecord())?.replacement));

  // What isn't a usable picture changes nothing.
  const GIF = 'Promise.resolve(new Uint8Array([71, 73, 70, 56, 57, 97, 1, 0, 1, 0, 0, 0, 0, 59]))';
  check('a GIF is refused and nothing changes', (await replaceWith(GIF, 'x.gif')) === false && (await undoDepth(OBJ)) === replaceDepth + 1);
  const inline = (await objectsOn(OBJ, 1)).find((o) => o.kind === 'image' && !o.gone && o.caps.replace === 'unsupported');
  check('an inline image says it can’t be replaced', Boolean(inline));
  if (inline) {
    await selectObject(OBJ, 1, inline.key);
    check('clicking the inline image selects it', (await selection(OBJ))?.key === inline.key, JSON.stringify(await selection(OBJ)));
    check('and it gets no replace button', (await barButtons()).length === 0, JSON.stringify(await barButtons()));
    check('and a replacement is refused, changing nothing',
      (await replaceWith(MAGENTA_PNG, 'magenta.png')) === false && (await undoDepth(OBJ)) === replaceDepth + 1);
  }
  await q(`${V(OBJ)}.focus()`);
  await c.key('Ctrl+K');
  await waitFor(`document.activeElement?.closest?.('.palette')`, 3000);
  await c.type('Replace picture');
  await sleep(300);
  check('the command palette offers “Replace picture…”', await q(`[...document.querySelectorAll('.palette [role="option"], .palette li')].some((el) => el.textContent.includes('Replace picture'))`));
  await c.key('Escape');
  await sleep(300);

  // The file itself: saved, closed, reopened.
  await q('__vellum.actions.save()');
  await waitFor(`!${V(OBJ)}.annotations.dirty`, 25000);
  replacedNow = await objectAt(OBJ, 1, replaceable.key);
  await q(`__vellum.app.close(${V(OBJ)})`);
  await waitFor(`!${V(OBJ)}`);
  await q(`__vellum.actions.openRecent(${JSON.stringify(OBJ)})`);
  await rest(OBJ);
  const reread = await q(`(async () => {
    const { objects } = await ${V(OBJ)}.textEditing.objects(1);
    return objects.filter((o) => o.kind === 'image').map((o) => ({ quad: o.geometry.quad, w: o.record.info?.width ?? null, h: o.record.info?.height ?? null, replace: o.capabilities.replace }));
  })()`);
  const savedPicture = reread.find((o) => near(o.quad, replacedNow.quad, 0.05));
  check('the saved file draws the 40 × 20 image in exactly that frame', savedPicture?.w === 40 && savedPicture?.h === 20,
    JSON.stringify(reread.map((o) => [o.w, o.h, o.quad.map((v) => Math.round(v))])));
  check('and it can be replaced again', savedPicture?.replace === true);
  const reopenedPicture = (await objectsOn(OBJ, 1)).find((o) => o.kind === 'image' && near(o.quad, replacedNow.quad, 0.05));
  check('pdf.js paints the new image from the saved file', Boolean(reopenedPicture) && magenta(await paintedAt(await reveal(OBJ, 1, reopenedPicture.key))));

  // ---- inserting a picture from a file ------------------------------------------------------------
  // As with replacing, the file comes in where the dialog hands it over: insertPictureWith().

  area('insert picture');
  await activate(OBJ);
  check('Edit mode', (await editMode(OBJ)) === 'edit');
  await q(`${V(OBJ)}.objectSelection.clear()`);
  const insertWith = (bytesExpr, name) => q(`(async () => {
    const bytes = await (${bytesExpr});
    return ${V(OBJ)}.textEditor.insertPictureWith({ name: ${JSON.stringify(name)}, bytes }, 1);
  })()`);
  const insertDepth = await undoDepth(OBJ);
  const countBefore = (await objectsOn(OBJ, 1)).length;
  const insertStarted = Date.now();
  const inserted = await insertWith(MAGENTA_PNG, 'magenta.png');
  check('inserting a PNG succeeds', inserted === true, JSON.stringify({ inserted, ms: Date.now() - insertStarted, toasts: await q(`[...document.querySelectorAll('#toasts .toast')].map((t) => t.textContent)`) }));
  await rest(OBJ);
  const newKey = (await selection(OBJ))?.key ?? '';
  check('the new picture is selected', newKey.startsWith('inserted:'), JSON.stringify(await selection(OBJ)));
  let fresh = await objectAt(OBJ, 1, newKey);
  check('one more object on the page, a picture that can be moved, turned, replaced and deleted',
    (await objectsOn(OBJ, 1)).length === countBefore + 1 && fresh?.kind === 'image'
    && ['move', 'scale', 'rotate', 'replace', 'delete'].every((v) => fresh.caps[v] === true), JSON.stringify(fresh?.caps));
  const view1 = await q(`${V(OBJ)}.viewer.getPageView(0).pdfPage.view`);
  check('centred on the page, upright, at its natural size (40 × 20 pixels is 30 × 15 pt)',
    near([fresh.wp, fresh.hp, fresh.cxp, fresh.cyp], [30, 15, (view1[0] + view1[2]) / 2, (view1[1] + view1[3]) / 2], 0.01)
    && fresh.transform[0] > 0 && fresh.transform[3] > 0, JSON.stringify(fresh.transform));
  check('the page shows it there', magenta(await paintedAt(await reveal(OBJ, 1, newKey))));
  check('one undo step', (await undoDepth(OBJ)) === insertDepth + 1);
  await shot('picture-inserted');

  scale = await zoom(OBJ);
  await selectObject(OBJ, 1, newKey);
  check('clicking it selects it, over what the page draws beneath', (await selection(OBJ))?.key === newKey, JSON.stringify(await selection(OBJ)));
  move = await dragBy(OBJ, 1, newKey, 50, 40);
  fit = movedBy(move.before, move.after, 50 / scale, -40 / scale);
  check('dragging it moves it', fit.ok, fit.detail);
  const insertedRecords = () => q(`${V(OBJ)}.annotations.edits.filter((e) => e.kind === 'inserted-image').length`);
  check('still one record, and one more undo step', (await insertedRecords()) === 1 && (await undoDepth(OBJ)) === insertDepth + 2);
  const draggedTo = await objectAt(OBJ, 1, newKey);

  await q(`${V(OBJ)}.annotations.undo()`);
  await rest(OBJ);
  check('undo puts it back in the middle', near([(await objectAt(OBJ, 1, newKey))?.cxp ?? 0], [fresh.cxp], 0.01));
  await q(`${V(OBJ)}.annotations.undo()`);
  await rest(OBJ);
  check('undo again takes the picture away', !(await objectAt(OBJ, 1, newKey)) && (await insertedRecords()) === 0 && !(await selection(OBJ)));
  await q(`${V(OBJ)}.annotations.redo()`);
  await q(`${V(OBJ)}.annotations.redo()`);
  await rest(OBJ);
  check('redo brings it back where it was dragged', near([(await objectAt(OBJ, 1, newKey))?.cxp ?? 0], [draggedTo.cxp], 0.01));

  await selectObject(OBJ, 1, newKey);
  await c.key('Delete');
  await rest(OBJ);
  check('Delete removes it', !(await objectAt(OBJ, 1, newKey)) && (await insertedRecords()) === 0);
  await q(`${V(OBJ)}.annotations.undo()`);
  await rest(OBJ);
  check('and undo restores it', Boolean(await objectAt(OBJ, 1, newKey)));

  const depthNow = await undoDepth(OBJ);
  check('a GIF is refused and nothing is added', (await insertWith(GIF, 'x.gif')) === false && (await undoDepth(OBJ)) === depthNow);
  await q(`${V(OBJ)}.focus()`);
  await c.key('Ctrl+K');
  await waitFor(`document.activeElement?.closest?.('.palette')`, 3000);
  await c.type('Insert picture');
  await sleep(300);
  check('the command palette offers “Insert picture…”', await q(`[...document.querySelectorAll('.palette [role="option"], .palette li')].some((el) => el.textContent.includes('Insert picture'))`));
  await c.key('Escape');
  await sleep(300);

  const placed = await objectAt(OBJ, 1, newKey);
  await q('__vellum.actions.save()');
  await waitFor(`!${V(OBJ)}.annotations.dirty`, 25000);
  await q(`__vellum.app.close(${V(OBJ)})`);
  await waitFor(`!${V(OBJ)}`);
  await q(`__vellum.actions.openRecent(${JSON.stringify(OBJ)})`);
  await rest(OBJ);
  const insertedSaved = (await q(`(async () => {
    const { objects } = await ${V(OBJ)}.textEditing.objects(1);
    return objects.filter((o) => o.kind === 'image').map((o) => ({ key: o.ref.key, quad: o.geometry.quad, w: o.record.info?.width ?? null, h: o.record.info?.height ?? null, move: o.capabilities.move }));
  })()`)).find((o) => near(o.quad, placed.quad, 0.05));
  check('the saved file draws the 40 × 20 picture where it was left, as a picture of the page',
    insertedSaved?.w === 40 && insertedSaved?.h === 20 && insertedSaved.key.startsWith('image:') && insertedSaved.move === true, JSON.stringify(insertedSaved));
  check('pdf.js paints it from the saved file', Boolean(insertedSaved) && magenta(await paintedAt(await reveal(OBJ, 1, insertedSaved.key))));

  // ---- new text (0.6): Add text, type over it, turn it, save and reopen ------------------------------------

  area('new text');
  await editMode(OBJ);
  await q(`${V(OBJ)}.objectSelection.clear()`);
  const newTexts = () => q(`${V(OBJ)}.annotations.edits.filter((e) => e.kind === 'inserted-text').map((e) => ({ text: e.text, font: e.font, transform: e.transform }))`);
  const textDepth = await undoDepth(OBJ);
  check('Add text succeeds', (await q(`${V(OBJ)}.textEditor.addText(1)`)) === true, await q(`[...document.querySelectorAll('#toasts .toast')].map((t) => t.textContent).join(' | ')`));
  check('the editor opens on it with its words selected',
    await waitFor(`(() => { const i = document.querySelector('.vl-text-input'); return i && i.value === 'New text' && i.selectionStart === 0 && i.selectionEnd === 8; })()`, 6000));
  check('it is selected, as new text', ((await selection(OBJ))?.key ?? '').startsWith('text:'), JSON.stringify(await selection(OBJ)));
  const textKey = (await selection(OBJ))?.key;
  await c.type('Hello new text');
  check('the editor’s own bar says which font it is written in', await waitFor(`document.querySelector('.vl-edit-bar .vl-text-font')?.textContent === 'Helvetica'`, 3000));
  await c.key('Enter');
  await rest(OBJ);
  check('typing over it and Enter keeps the text: one record, two undo steps',
    JSON.stringify((await newTexts()).map((t) => [t.text, t.font])) === JSON.stringify([['Hello new text', 'Helvetica']]) && (await undoDepth(OBJ)) === textDepth + 2,
    JSON.stringify(await newTexts()));
  const drawnText = async () => q(`(async () => (await (await ${V(OBJ)}.pdf.getPage(1)).getTextContent()).items.some((i) => i.str === 'Hello new text'))()`);
  check('the page draws it as real text', await drawnText());

  // Several lines in one box, formatting from the bar and the palette's action, and a width to wrap to.
  const newRecord = () => q(`(${V(OBJ)}.annotations.edits.find((e) => e.kind === 'inserted-text') ?? null)`);
  await q(`${V(OBJ)}.objectSelection.set(1, [${JSON.stringify(textKey)}])`);
  await q(`${V(OBJ)}.focus()`);
  await c.key('Enter');
  check('Enter on selected new text opens a box of lines', await waitFor(`document.querySelector('textarea.vl-text-input')?.value === 'Hello new text'`, 4000));
  await c.key('End');
  await c.key('Shift+Enter');
  await sleep(200);
  check('Shift+Enter doesn’t keep the text: the editor stays open', Boolean(await q(`document.querySelector('textarea.vl-text-input')`)));
  await c.type('\nsecond line');
  await c.key('Enter');
  await rest(OBJ);
  check('a second line typed: still one record, holding both lines', (await newTexts()).length === 1 && (await newRecord())?.text === 'Hello new text\nsecond line', JSON.stringify(await newRecord()));
  check('the page draws both lines as real text',
    await q(`(async () => { const s = (await (await ${V(OBJ)}.pdf.getPage(1)).getTextContent()).items.map((i) => i.str); return s.includes('Hello new text') && s.includes('second line'); })()`));
  await q(`${V(OBJ)}.objectSelection.set(1, [${JSON.stringify(textKey)}])`);
  const formatBar = `document.querySelector('.vl-arrange-bar [data-format="bold"]')`;
  check('selected new text shows the format bar', await waitFor(`${formatBar} && !${formatBar}.hidden && ${formatBar}.offsetWidth > 0`, 4000));
  const formatDepth = await undoDepth(OBJ);
  const boldAt = await q(`(() => { const r = ${formatBar}.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; })()`);
  await c.mouse(boldAt[0], boldAt[1]);
  await rest(OBJ);
  check('Bold in the bar: the family’s bold face, pressed, one undo step',
    (await newRecord())?.font === 'Helvetica-Bold' && (await undoDepth(OBJ)) === formatDepth + 1 && (await waitFor(`${formatBar}?.getAttribute('aria-pressed') === 'true'`, 3000)), JSON.stringify(await newRecord()));
  for (const what of [`'larger'`, `'underline'`, `'center'`, `{ color: '#2f6fd6' }`, `{ opacity: 0.5 }`]) {
    await q(`${V(OBJ)}.textEditor.formatSelected(${what})`);
    await rest(OBJ);
  }
  const styledNew = await newRecord();
  check('size, underline, alignment, colour and opacity: one undo step each',
    styledNew?.size === 14 && styledNew.underline === true && styledNew.align === 'center' && styledNew.color === '#2f6fd6' && styledNew.opacity === 0.5 && (await undoDepth(OBJ)) === formatDepth + 6,
    JSON.stringify(styledNew));
  check('formatting page text is refused with a reason', await (async () => {
    const pageKey = await q(`${V(OBJ)}.el.querySelector('.page') && (async () => (await ${V(OBJ)}.textEditing.objects(1)).objects.find((o) => o.kind === 'text-run' && !o.ref.newText)?.ref.key)()`);
    if (!pageKey) return true;
    await q(`${V(OBJ)}.objectSelection.set(1, [${JSON.stringify(pageKey)}])`);
    const done = await q(`${V(OBJ)}.textEditor.formatSelected('bold')`);
    await q(`${V(OBJ)}.objectSelection.set(1, [${JSON.stringify(textKey)}])`);
    return done === false;
  })());
  await sleep(400);
  const wrapGrip = await q(`(() => { const h = ${V(OBJ)}.el.querySelector('.vl-object-handle.reflow'); if (!h) return null; const r = h.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; })()`);
  check('new text has one wrap handle on its right edge', Boolean(wrapGrip));
  if (wrapGrip) {
    const wideBefore = styledNew.box[2];
    await c.drag(wrapGrip, [wrapGrip[0] - 25, wrapGrip[1]], 10);
    await rest(OBJ);
    const wrappedNew = await newRecord();
    check('dragging it sets a narrower width the lines wrap to, one undo step',
      wrappedNew?.width !== null && wrappedNew.width < wideBefore && (await undoDepth(OBJ)) === formatDepth + 7, JSON.stringify(wrappedNew));
  }
  // Font selection (0.6): another standard family from the bar's font menu, the family's own bold face kept.
  await q(`${V(OBJ)}.objectSelection.set(1, [${JSON.stringify(textKey)}])`);
  const fontButton = `document.querySelector('.vl-arrange-bar .vl-text-font')`;
  check('the bar says which font the text is in', await waitFor(`${fontButton} && !${fontButton}.hidden && ${fontButton}.textContent === 'Helvetica'`, 4000),
    await q(`${fontButton}?.textContent ?? 'no font button'`));
  const fontDepth = await undoDepth(OBJ);
  const centreOf = async (selector) => q(`(() => { const el = ${selector}; if (!el) return null; const r = el.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; })()`);
  const fontAt = await centreOf(fontButton);
  await c.mouse(fontAt[0], fontAt[1]);
  check('it opens a menu of the fonts new text can be written in',
    await waitFor(`[...document.querySelectorAll('.menu.font-menu .menu-label')].map((e) => e.textContent).join(',').startsWith('Helvetica,Times,Courier,')`, 3000),
    await q(`[...document.querySelectorAll('.menu .menu-label')].map((e) => e.textContent).join(',')`));
  check('the bundled library is listed too, in groups, and the long list scrolls',
    await q(`(() => { const m = document.querySelector('.menu.font-menu'); const labels = [...m.querySelectorAll('.menu-label')].map((e) => e.textContent); return ['Inter', 'Merriweather', 'JetBrains Mono', 'Atkinson Hyperlegible Next', 'Noto Sans'].every((n) => labels.includes(n)) && m.querySelectorAll('.menu-sep').length >= 5 && m.scrollHeight > m.clientHeight && m.getBoundingClientRect().bottom <= innerHeight; })()`),
    await q(`document.querySelector('.menu.font-menu')?.querySelectorAll('.menu-item').length`));
  const timesAt = await centreOf(`[...document.querySelectorAll('.menu.font-menu .menu-item')].find((b) => b.textContent.includes('Times'))`);
  await c.mouse(timesAt[0], timesAt[1]);
  await rest(OBJ);
  check('choosing Times writes it in that family’s own bold face, one undo step',
    (await newRecord())?.font === 'Times-Bold' && (await undoDepth(OBJ)) === fontDepth + 1 && (await waitFor(`${fontButton}.textContent === 'Times'`, 3000)),
    JSON.stringify(await newRecord()));
  const shownFamily = `(async () => { const p = await ${V(OBJ)}.pdf.getPage(1); const tc = await p.getTextContent(); const it = tc.items.find((i) => i.str.includes('Hello')); return it ? tc.styles[it.fontName]?.fontFamily : null; })()`;
  check('the page is drawn again in that font', await waitFor(`${shownFamily}.then((f) => f === 'serif')`, 8000), await q(shownFamily));
  await q(`${V(OBJ)}.textEditor.formatSelected({ family: 'Helvetica' })`);
  await rest(OBJ);
  check('back to Helvetica, the bold face and the rest of the format kept',
    (await newRecord())?.font === 'Helvetica-Bold' && (await newRecord())?.align === 'center' && (await undoDepth(OBJ)) === fontDepth + 2, JSON.stringify(await newRecord()));
  check('and the page with it', await waitFor(`${shownFamily}.then((f) => f === 'sans-serif')`, 8000), await q(shownFamily));
  check('a font Vellum doesn’t have is refused, with nothing changed',
    (await q(`${V(OBJ)}.textEditor.formatSelected({ family: 'Garamond' })`)) === false && (await newRecord())?.font === 'Helvetica-Bold' && (await undoDepth(OBJ)) === fontDepth + 2);
  // A bundled family (web/fonts/document), chosen from the menu and read over the app's resource server then.
  const pickFont = async (name) => {
    const at = await centreOf(fontButton);
    await c.mouse(at[0], at[1]);
    await waitFor(`[...document.querySelectorAll('.menu.font-menu .menu-label')].some((e) => e.textContent === ${JSON.stringify(name)})`, 3000);
    const item = `[...document.querySelectorAll('.menu.font-menu .menu-item')].find((b) => b.querySelector('.menu-label')?.textContent === ${JSON.stringify(name)})`;
    await q(`${item}.scrollIntoView({ block: 'center' })`);
    await sleep(150);
    const itemAt = await centreOf(item);
    await c.mouse(itemAt[0], itemAt[1]);
    await rest(OBJ);
  };
  await pickFont('DM Serif Display');
  check('a bundled family without a bold face isn’t chosen for bold text: refused, nothing changed',
    (await newRecord())?.font === 'Helvetica-Bold' && (await undoDepth(OBJ)) === fontDepth + 2
      && await waitFor(`[...document.querySelectorAll('#toasts .toast')].some((t) => t.textContent.includes('style asked for'))`, 3000),
    await q(`[...document.querySelectorAll('#toasts .toast')].map((t) => t.textContent).join(' | ')`));
  await pickFont('Inter');
  check('a bundled family: its own bold face, read when chosen, one undo step',
    (await waitFor(`${V(OBJ)}.annotations.edits.find((e) => e.kind === 'inserted-text')?.font === 'bundled:inter/bold'`, 8000)) && (await undoDepth(OBJ)) === fontDepth + 3 && (await waitFor(`${fontButton}.textContent === 'Inter'`, 3000)),
    JSON.stringify(await newRecord()));
  await q(`${V(OBJ)}.textEditor.formatSelected({ family: 'Helvetica' })`);
  await rest(OBJ);
  check('and back to Helvetica', (await newRecord())?.font === 'Helvetica-Bold' && (await undoDepth(OBJ)) === fontDepth + 4, JSON.stringify(await newRecord()));

  // Mixed formatting (0.6): a word of the box formatted from the open editor, with what was typed, in one step.
  const mixedDepth = await undoDepth(OBJ); // counted while the editor is shut: counting rebuilds the pages, which closes it
  await q(`${V(OBJ)}.objectSelection.set(1, [${JSON.stringify(textKey)}])`);
  await q(`${V(OBJ)}.focus()`);
  await c.key('Enter');
  const box = `document.querySelector('textarea.vl-text-input')`;
  check('the open editor carries the format controls on its own bar',
    await waitFor(`${box}?.value === 'Hello new text\\nsecond line' && Boolean(document.querySelector('.vl-edit-bar [data-format="bold"]'))`, 4000));
  await q(`(() => { const i = ${box}; i.focus(); i.setSelectionRange(i.value.length, i.value.length); })()`);
  await c.type('!');
  await q(`${box}.setSelectionRange(6, 9)`);
  const coloured = await q(`${V(OBJ)}.textEditor.formatSelected({ color: '#d62f2f' })`);
  await rest(OBJ);
  const mixed = await newRecord();
  const spanColours = (mixed?.spans ?? []).map((s) => [s.n, s.color ?? null]);
  check('the selected word takes the colour, the rest keeps its own, the typing kept: one record',
    coloured === true && mixed?.text === 'Hello new text\nsecond line!' && mixed.color === '#2f6fd6'
      && JSON.stringify(spanColours) === JSON.stringify([[6, null], [3, '#d62f2f'], [18, null]]),
    JSON.stringify(mixed));
  check('the editor stays open on it, the word still selected and drawn in its pieces',
    await waitFor(`${box}?.selectionStart === 6 && ${box}.selectionEnd === 9 && Boolean(document.querySelector('.vl-text-editor.mixed .vl-text-mirror span'))`, 4000));
  await c.key('Enter');
  await rest(OBJ);
  check('Enter keeps it as it is: typing and formatting were one undo step', !(await q(box)) && (await newRecord())?.spans?.length === 3 && (await undoDepth(OBJ)) === mixedDepth + 1);
  await q(`${V(OBJ)}.annotations.undo()`);
  await rest(OBJ);
  check('undo: one format and one text again', !(await newRecord())?.spans && (await newRecord())?.text === 'Hello new text\nsecond line', JSON.stringify(await newRecord()));
  await q(`${V(OBJ)}.annotations.redo()`);
  await rest(OBJ);
  check('redo: the word coloured again, and the page draws it as real text',
    (await newRecord())?.spans?.length === 3
      && await q(`(async () => (await (await ${V(OBJ)}.pdf.getPage(1)).getTextContent()).items.map((i) => i.str).join('').includes('new'))()`));

  await q(`${V(OBJ)}.objectSelection.set(1, [${JSON.stringify(textKey)}])`);
  await q(`${V(OBJ)}.focus()`);
  await c.key(']');
  await sleep(900);
  await rest(OBJ);
  const turnedNew = (await newTexts())[0]?.transform;
  check('] turns it a quarter turn, still one record', (await newTexts()).length === 1 && Math.abs(turnedNew?.[1]) === 1 && turnedNew[1] === -turnedNew[2], JSON.stringify(turnedNew));
  await q(`${V(OBJ)}.focus()`);
  await c.key('Ctrl+K');
  await waitFor(`document.activeElement?.closest?.('.palette')`, 3000);
  await c.type('Add text');
  await sleep(300);
  check('the command palette offers “Add text”', await q(`[...document.querySelectorAll('.palette [role="option"], .palette li')].some((el) => el.textContent.includes('Add text'))`));
  await q(`(() => { const i = document.activeElement; i.value = ''; i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await c.type('New text in Merriweather');
  await sleep(300);
  check('and the bundled fonts, as the font menu does', await q(`[...document.querySelectorAll('.palette [role="option"], .palette li')].some((el) => el.textContent.includes('New text in Merriweather'))`));
  await c.key('Escape');
  await sleep(300);

  await q('__vellum.actions.save()');
  await waitFor(`!${V(OBJ)}.annotations.dirty`, 25000);
  await q(`__vellum.app.close(${V(OBJ)})`);
  await waitFor(`!${V(OBJ)}`);
  await q(`__vellum.actions.openRecent(${JSON.stringify(OBJ)})`);
  await rest(OBJ);
  const savedRun = await q(`(async () => {
    const { runs } = await ${V(OBJ)}.textEditing.page(1);
    const lines = runs.filter((r) => r.run.font?.name === 'Helvetica-Bold');
    const item = lines.find((r) => r.run.text.includes('second'));
    return item ? { lines: lines.length, font: item.run.font?.name, size: item.run.frame.size, dir: item.run.frame.dir, editable: item.run.editable, fill: item.run.first?.fill?.color?.args } : null;
  })()`);
  check('saved and reopened: lines of editable page text in Helvetica Bold 14, blue, still turned',
    savedRun?.font === 'Helvetica-Bold' && savedRun.lines >= 2 && Math.abs(savedRun.size - 14) < 0.01 && Math.abs(Math.abs(savedRun.dir[1]) - 1) < 1e-3 && savedRun.editable === true
      && JSON.stringify(savedRun.fill?.map((v) => Math.round(v * 255))) === JSON.stringify([0x2f, 0x6f, 0xd6]), JSON.stringify(savedRun));

  // New text in a bundled font, saved: the face embedded as a subset, reopened as editable text in it.
  await editMode(OBJ);
  await q(`${V(OBJ)}.objectSelection.clear()`);
  check('Add text again, for a bundled font', (await q(`${V(OBJ)}.textEditor.addText(1)`)) === true);
  await waitFor(`document.querySelector('.vl-text-input')?.value === 'New text'`, 6000);
  await c.type('Bundled Lora');
  await c.key('Enter');
  await rest(OBJ);
  const loraKey = (await selection(OBJ))?.key;
  await q(`${V(OBJ)}.objectSelection.set(1, [${JSON.stringify(loraKey)}])`);
  await q(`${V(OBJ)}.textEditor.formatSelected({ family: 'bundled:lora' })`);
  await rest(OBJ);
  await q(`${V(OBJ)}.textEditor.formatSelected('italic')`);
  await rest(OBJ);
  const loraRecord = () => q(`(${V(OBJ)}.annotations.edits.find((e) => e.kind === 'inserted-text' && e.text === 'Bundled Lora') ?? null)`);
  check('written in Lora’s own italic face', (await loraRecord())?.font === 'bundled:lora/italic', JSON.stringify(await loraRecord()));
  await q('__vellum.actions.save()');
  await waitFor(`!${V(OBJ)}.annotations.dirty`, 25000);
  await q(`__vellum.app.close(${V(OBJ)})`);
  await waitFor(`!${V(OBJ)}`);
  await q(`__vellum.actions.openRecent(${JSON.stringify(OBJ)})`);
  await rest(OBJ);
  const loraRun = await q(`(async () => {
    const { runs } = await ${V(OBJ)}.textEditing.page(1);
    const item = runs.find((r) => r.run.text === 'Bundled Lora');
    return item ? { font: item.run.font?.name, embedded: item.run.font?.embedded, editable: item.run.editable } : null;
  })()`);
  check('saved and reopened: editable page text in an embedded subset of Lora Italic',
    /^Lora-Italic-\d+$/.test(loraRun?.font ?? '') && loraRun.embedded === true && loraRun.editable === true, JSON.stringify(loraRun));

  // ---- formatting the page's own text (0.6): size, underline, colour, opacity; font refused ---------------

  area('page text format');
  const PLAIN = F('simple');
  await activate(PLAIN);
  await editMode(PLAIN);
  const third = (await objectsOn(PLAIN, 1)).find((o) => o.kind === 'text-run' && o.text === 'Third line.');
  check('a line of page text to format', Boolean(third));
  if (third) {
    await selectObject(PLAIN, 1, third.key);
    await rest(PLAIN);
    check('no floating format bar stands over a selected line of page text',
      !(await q(`(() => { const el = document.querySelector('.vl-arrange-bar [data-format="bold"]'); return Boolean(el && !el.hidden && el.offsetWidth > 0); })()`)));
    await q(`${V(PLAIN)}.focus()`);
    await c.key('Ctrl+K');
    await waitFor(`document.activeElement?.closest?.('.palette')`, 3000);
    await c.type('Text colour');
    await sleep(300);
    check('the command palette offers “Text colour…”', await q(`[...document.querySelectorAll('.palette [role="option"], .palette li')].some((el) => el.textContent.includes('Text colour'))`));
    await c.key('Escape');
    await sleep(300);
    check('Text colour… opens the colour menu beside the selection', (await q(`${V(PLAIN)}.textEditor.textColourMenu()`)) === true
      && await waitFor(`Boolean(document.querySelector('.menu.palette-menu'))`, 2000));
    await c.key('Escape');
    await sleep(300);
    const formatDepth = await undoDepth(PLAIN);
    for (const what of [`'larger'`, `'underline'`, `{ color: '#d62f2f' }`, `{ opacity: 0.5 }`]) {
      check(`formatSelected(${what}) changes it`, (await q(`${V(PLAIN)}.textEditor.formatSelected(${what})`)) === true);
      await rest(PLAIN);
    }
    const formatted = () => q(`(() => { const e = ${V(PLAIN)}.annotations.edits.find((r) => r.kind === 'text' && \`run:\${r.target.key}\` === ${JSON.stringify(third.key)}); return e ? { format: e.format, transform: e.transform, mode: e.encoding.mode } : null; })()`);
    const held = JSON.stringify(await formatted());
    const heldRecord = JSON.parse(held);
    check('one record: its format, and 14 pt as a uniform scale of its own glyphs',
      heldRecord?.mode === 'original' && heldRecord.format?.color === '#d62f2f' && heldRecord.format.opacity === 0.5 && heldRecord.format.underline === true
        && Object.keys(heldRecord.format).length === 3 && heldRecord.transform?.[0] === 1.1667 && heldRecord.transform[3] === 1.1667 && heldRecord.transform[1] === 0 && heldRecord.transform[2] === 0, held);
    check('four undo steps', (await undoDepth(PLAIN)) === formatDepth + 4);
    check('bold is refused for page text, nothing changed',
      (await q(`${V(PLAIN)}.textEditor.formatSelected('bold')`)) === false && JSON.stringify(await formatted()) === held);

    await q('__vellum.actions.save()');
    await waitFor(`!${V(PLAIN)}.annotations.dirty`, 25000);
    await q(`__vellum.app.close(${V(PLAIN)})`);
    await waitFor(`!${V(PLAIN)}`);
    await q(`__vellum.actions.openRecent(${JSON.stringify(PLAIN)})`);
    await rest(PLAIN);
    const reopened = await q(`(async () => {
      const { runs } = await ${V(PLAIN)}.textEditing.page(1);
      const item = runs.find((r) => r.run.text === 'Third line.');
      return item ? { size: item.run.frame.size, font: item.run.font?.name, editable: item.run.editable, fill: item.run.first.fill.color?.args, ca: item.run.first.ca, count: runs.filter((r) => r.run.text === 'Third line.').length } : null;
    })()`);
    check('saved and reopened: the same editable Helvetica text, 14 pt, red, half opaque, drawn once',
      reopened?.editable === true && reopened.font === 'Helvetica' && Math.abs(reopened.size - 14) < 0.01 && reopened.ca === 0.5 && reopened.count === 1
        && JSON.stringify(reopened.fill?.map((v) => Math.round(v * 255))) === JSON.stringify([0xd6, 0x2f, 0x2f]), JSON.stringify(reopened));
  }

  // ---- the page's own text in another face of its font the PDF has (0.6): bold, refused where it won't fit ----

  area('page text face');
  const FACES = F('faces');
  await activate(FACES);
  await editMode(FACES);
  const faceLines = (await objectsOn(FACES, 1)).filter((o) => o.kind === 'text-run' && o.text === 'Plain sentence here');
  check('three lines of Liberation Sans regular to set in bold', faceLines.length === 3, String(faceLines.length));
  if (faceLines.length === 3) {
    const faceRecord = () => q(`(() => { const e = ${V(FACES)}.annotations.edits.find((r) => r.kind === 'text'); return e ? { face: e.face?.font ?? null, bold: e.face?.bold, mode: e.encoding.mode, n: ${V(FACES)}.annotations.edits.length } : null; })()`);
    // The line with a picture just after it, and the one at the page's edge: a wider face is refused.
    const reasons = [];
    let refusedBoth = true;
    for (const line of faceLines.slice(1)) {
      await selectObject(FACES, 1, line.key);
      await rest(FACES);
      refusedBoth &&= (await q(`${V(FACES)}.textEditor.formatSelected('bold')`)) === false;
      reasons.push(await q(`${V(FACES)}.textEditing.formatText(1, [${JSON.stringify(line.key)}], { bold: true }).then(() => 'changed', (e) => e.detail?.reason ?? e.message)`));
    }
    check('bold is refused where the wider line would cover a picture or leave the page, nothing changed',
      refusedBoth && JSON.stringify(reasons) === JSON.stringify(['overlap', 'bounds']) && (await faceRecord()) === null, JSON.stringify(reasons));

    await selectObject(FACES, 1, faceLines[0].key);
    await rest(FACES);
    await q(`${V(FACES)}.focus()`);
    await c.key('Ctrl+K');
    await waitFor(`document.activeElement?.closest?.('.palette')`, 3000);
    await c.type('Bold text');
    await sleep(300);
    check('the command palette offers “Bold text”', await q(`[...document.querySelectorAll('.palette [role="option"], .palette li')].some((el) => el.textContent.includes('Bold text'))`));
    await c.key('Escape');
    await sleep(300);
    const faceDepth = await undoDepth(FACES);
    check('formatSelected(\'bold\') sets the line in the PDF’s own bold face', (await q(`${V(FACES)}.textEditor.formatSelected('bold')`)) === true);
    await rest(FACES);
    const held = await faceRecord();
    check('one record in the file’s own glyphs, naming a font object of the file, one undo step',
      held?.n === 1 && held.mode === 'original' && held.bold === true && /^doc:\d+-\d+$/.test(held.face ?? '') && (await undoDepth(FACES)) === faceDepth + 1, JSON.stringify(held));

    await q('__vellum.actions.save()');
    await waitFor(`!${V(FACES)}.annotations.dirty`, 25000);
    await q(`__vellum.app.close(${V(FACES)})`);
    await waitFor(`!${V(FACES)}`);
    await q(`__vellum.actions.openRecent(${JSON.stringify(FACES)})`);
    await rest(FACES);
    const reopened = await q(`(async () => {
      const { runs } = await ${V(FACES)}.textEditing.page(1);
      const items = runs.filter((r) => r.run.text === 'Plain sentence here');
      return items.map((r) => ({ font: r.run.font?.name, editable: r.run.editable, x: Math.round(r.run.origin[0] * 1000) / 1000, y: Math.round(r.run.origin[1] * 1000) / 1000 }));
    })()`);
    check('saved and reopened: the same editable text from the same start, in LiberationSans-Bold, drawn once',
      reopened?.length === 3 && reopened.filter((r) => r.font === 'LiberationSans-Bold').length === 1
        && reopened.some((r) => r.font === 'LiberationSans-Bold' && r.editable === true && r.x === 72 && r.y === 720), JSON.stringify(reopened));
  }

  check('no page errors were collected', (await q('__vellum.errors.length')) === 0,
    await q('JSON.stringify(__vellum.errors.slice(0, 3))'));
}
