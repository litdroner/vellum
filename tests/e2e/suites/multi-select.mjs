// Vellum 0.5.0: several objects on one page, selected and changed together, in the real app.
//
// Everything is reached the way a person reaches it: Edit mode, then Shift- and Ctrl-clicks, a
// rectangle dragged over bare paper, Ctrl+A, and then the same drags, corner handles and keys a
// single object takes. What comes back is read off the DOM, the edit store and — for the checks that
// matter — the saved file, re-read after the document is closed and opened again.
//
// As in the manipulation suite, distances are compared in the page's own user space; screen
// coordinates only tell the mouse where to press, and are read immediately before the press.

export const files = { images: 'images', objects: 'objects', paragraphs: 'paragraphs' };

const SHIFT = 8;
const CTRL = 2;

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
  const scaleOf = (path, n = 1) => q(`${V(path)}.viewer.getPageView(${n} - 1).viewport.scale`);

  /** Every selectable object on a page where it is NOW, in points and on screen (as in the manipulation suite). */
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
      const px = [quad[0], quad[2], quad[4], quad[6]];
      const py = [quad[1], quad[3], quad[5], quad[7]];
      const left = Math.min(...xs); const right = Math.max(...xs);
      const top = Math.min(...ys); const bottom = Math.max(...ys);
      out.push({
        key: o.ref.key, kind: o.kind, text: o.kind === 'text-run' ? o.text : null, caps: o.capabilities, gone, quad, transform: T,
        cxp: (px[0] + px[1] + px[2] + px[3]) / 4, cyp: (py[0] + py[1] + py[2] + py[3]) / 4,
        wp: Math.max(...px) - Math.min(...px), hp: Math.max(...py) - Math.min(...py),
        x1p: Math.min(...px), y1p: Math.min(...py), x2p: Math.max(...px), y2p: Math.max(...py),
        left, top, right, bottom, cx: (left + right) / 2, cy: (top + bottom) / 2,
      });
    }
    return out;
  })()`);
  const objectAt = async (path, n, key) => (await objectsOn(path, n)).find((o) => o.key === key) ?? null;

  /** A PDF point of a page, on screen now. */
  const clientOf = (path, n, x, y) => q(`(() => {
    const pv = ${V(path)}.viewer.getPageView(${n} - 1);
    const vp = pv.viewport;
    const box = pv.div.getBoundingClientRect();
    const [vx, vy] = vp.convertToViewportPoint(${x}, ${y});
    return [box.left + vx * (box.width / vp.width), box.top + vy * (box.height / vp.height)];
  })()`);

  /** Scrolls so the middle of these objects is in the middle of the view. */
  const revealAll = async (path, n, keys) => {
    const list = (await objectsOn(path, n)).filter((o) => keys.includes(o.key));
    if (!list.length) return;
    const cy = (Math.min(...list.map((o) => o.top)) + Math.max(...list.map((o) => o.bottom))) / 2;
    const cx = (Math.min(...list.map((o) => o.left)) + Math.max(...list.map((o) => o.right))) / 2;
    await q(`(() => {
      const v = ${V(path)};
      const view = v.container.getBoundingClientRect();
      v.container.scrollTop += (${cy} - view.top) - view.height / 2;
      v.container.scrollLeft += (${cx} - view.left) - view.width / 2;
    })()`);
    await sleep(450);
  };

  const selection = (path) => q(`(() => {
    const s = ${V(path)}.objectSelection.current;
    return s ? { page: s.page, keys: [...s.keys], fields: Object.keys(s).sort() } : null;
  })()`);
  const selectedKeys = async (path) => (await selection(path))?.keys ?? [];
  const sameSet = (a, b) => a.length === b.length && a.every((k) => b.includes(k));
  const editorOpen = (path) => q(`Boolean(${V(path)}.el.querySelector('.vl-text-editor'))`);
  const drawn = (path) => q(`(() => {
    const root = ${V(path)}.el;
    return {
      pictures: root.querySelectorAll('.vl-object-sel').length,
      lines: root.querySelectorAll('.vl-edit-run.focus').length,
      frame: root.querySelectorAll('.vl-object-group').length,
      handles: root.querySelectorAll('.vl-object-handle').length,
      marquee: root.querySelectorAll('.vl-object-marquee').length,
    };
  })()`);
  const records = (path) => q(`${V(path)}.annotations.edits.map((e) => ({
    kind: e.kind, key: e.kind === 'text' ? 'run:' + e.target.key : e.target.key, transform: e.transform || null,
    removed: Boolean(e.removed), mode: e.encoding ? e.encoding.mode : null,
  }))`);
  const undoDepth = async (path) => {
    const n = await q(`(() => { let n = 0; const v = ${V(path)}; while (v.annotations.canUndo) { v.annotations.undo(); n++; } for (let i = 0; i < n; i++) v.annotations.redo(); return n; })()`);
    await rest(path);
    return n;
  };
  const toast = (pattern) => waitFor(`[...document.querySelectorAll('#toasts .toast')].some((t) => ${pattern}.test(t.textContent))`, 3000);
  const clearToasts = () => q(`document.querySelectorAll('#toasts .toast').forEach((t) => t.remove())`);

  const moved = (before, after, dxp, dyp, tol = 1) => {
    if (!before || !after) return { ok: false, detail: 'object not found' };
    const dx = after.cxp - before.cxp;
    const dy = after.cyp - before.cyp;
    return { ok: Math.abs(dx - dxp) <= tol && Math.abs(dy - dyp) <= tol, detail: `${dx.toFixed(2)}, ${dy.toFixed(2)} pt (wanted ${dxp.toFixed(2)}, ${dyp.toFixed(2)})` };
  };

  // ---- 1. adding to the selection, and taking out of it ----------------------------------------------

  area('adding to a selection');
  const IMAGES = F('images');
  await activate(IMAGES);
  check('Edit mode', await editMode(IMAGES) === 'edit');
  let all = await objectsOn(IMAGES, 1);
  const pictures = all.filter((o) => o.kind === 'image');
  const lines = all.filter((o) => o.kind === 'text-run' && o.caps.move === true);
  check('the page has two pictures and two lines to work with', pictures.length === 2 && lines.length === 2,
    JSON.stringify(all.map((o) => o.key)));
  const caption = lines.find((o) => o.text === 'Caption under the picture');
  const [picA, picB] = pictures.sort((a, b) => a.x1p - b.x1p); // picA is the large one on the left
  await revealAll(IMAGES, 1, [picA.key, caption.key]);

  let a = await objectAt(IMAGES, 1, picA.key);
  await c.mouse(a.cx, a.cy);
  await sleep(450);
  check('a plain click selects one picture', sameSet(await selectedKeys(IMAGES), [picA.key]));
  let cap = await objectAt(IMAGES, 1, caption.key);
  await c.mouse(cap.cx, cap.cy, { modifiers: SHIFT });
  await sleep(450);
  let state = await selection(IMAGES);
  check('Shift+click adds a line to it', sameSet(state?.keys ?? [], [picA.key, caption.key]), JSON.stringify(state));
  check('the selection is still identity and nothing else', state?.fields.join(',') === 'keys,page');
  check('and no editor opens: the click chose, it didn’t type', (await editorOpen(IMAGES)) === false);
  let marks = await drawn(IMAGES);
  check('both are outlined, with one frame and four handles for the group',
    marks.pictures === 1 && marks.lines === 1 && marks.frame === 1 && marks.handles === 4, JSON.stringify(marks));
  await shot('group-selected');

  const b = await objectAt(IMAGES, 1, picB.key);
  await c.mouse(b.cx, b.cy, { modifiers: CTRL });
  await sleep(450);
  check('Ctrl+click adds another', sameSet(await selectedKeys(IMAGES), [picA.key, caption.key, picB.key]), JSON.stringify(await selectedKeys(IMAGES)));
  await c.mouse(b.cx, b.cy, { modifiers: CTRL });
  await sleep(450);
  check('and Ctrl+click on a selected object takes it out again', sameSet(await selectedKeys(IMAGES), [picA.key, caption.key]));
  await c.mouse(b.cx, b.cy, { modifiers: CTRL });
  await sleep(450);
  await c.mouse(b.cx, b.cy, { modifiers: CTRL });
  await sleep(450);
  check('the primary object is the last one chosen, so it stays the caption after an add and remove',
    (await selectedKeys(IMAGES)).at(-1) === caption.key, JSON.stringify(await selectedKeys(IMAGES)));
  const paper = await clientOf(IMAGES, 1, 320, 540); // bare paper between the pictures
  await c.mouse(paper[0], paper[1], { modifiers: SHIFT });
  await sleep(400);
  check('a Shift+click on bare paper leaves the selection alone', sameSet(await selectedKeys(IMAGES), [picA.key, caption.key]));

  // ---- 2. a drag moves the whole group -------------------------------------------------------------

  area('moving together');
  const scale = await scaleOf(IMAGES);
  const depth0 = await undoDepth(IMAGES);
  a = await objectAt(IMAGES, 1, picA.key);
  cap = await objectAt(IMAGES, 1, caption.key);
  await c.drag([a.cx, a.cy], [a.cx + 40, a.cy + 30], 10);
  await rest(IMAGES);
  let a2 = await objectAt(IMAGES, 1, picA.key);
  let cap2 = await objectAt(IMAGES, 1, caption.key);
  let fit = moved(a, a2, 40 / scale, -30 / scale);
  check('dragging the picture moves it', fit.ok, fit.detail);
  fit = moved(cap, cap2, 40 / scale, -30 / scale);
  check('and the line selected with it, by exactly as much', fit.ok, fit.detail);
  let store = await records(IMAGES);
  check('one record for each object', store.length === 2 && sameSet(store.map((r) => r.key), [picA.key, caption.key]), JSON.stringify(store));
  check('one gesture, one undo step', (await undoDepth(IMAGES)) === depth0 + 1);
  check('the group is still selected after the pages are rebuilt', sameSet(await selectedKeys(IMAGES), [picA.key, caption.key]));
  await q(`${V(IMAGES)}.annotations.undo()`);
  await rest(IMAGES);
  check('undo puts both back at once',
    moved(a, await objectAt(IMAGES, 1, picA.key), 0, 0, 0.1).ok && moved(cap, await objectAt(IMAGES, 1, caption.key), 0, 0, 0.1).ok);
  await q(`${V(IMAGES)}.annotations.redo()`);
  await rest(IMAGES);
  await shot('group-moved');

  // ---- 3. the group's corner handle scales every object about one corner -------------------------------

  area('scaling together');
  await revealAll(IMAGES, 1, [picA.key, caption.key]);
  a = await objectAt(IMAGES, 1, picA.key);
  cap = await objectAt(IMAGES, 1, caption.key);
  const frame = [Math.min(a.x1p, cap.x1p), Math.min(a.y1p, cap.y1p), Math.max(a.x2p, cap.x2p), Math.max(a.y2p, cap.y2p)];
  const corner = await clientOf(IMAGES, 1, frame[0], frame[1]); // bottom-left of the group
  const anchor = await clientOf(IMAGES, 1, frame[2], frame[3]); // top-right stays put
  await c.drag(corner, [anchor[0] + (corner[0] - anchor[0]) * 1.25, anchor[1] + (corner[1] - anchor[1]) * 1.25], 10);
  await rest(IMAGES);
  a2 = await objectAt(IMAGES, 1, picA.key);
  cap2 = await objectAt(IMAGES, 1, caption.key);
  const frame2 = [Math.min(a2.x1p, cap2.x1p), Math.min(a2.y1p, cap2.y1p), Math.max(a2.x2p, cap2.x2p), Math.max(a2.y2p, cap2.y2p)];
  check('the group’s far corner has not moved', Math.abs(frame2[2] - frame[2]) < 0.3 && Math.abs(frame2[3] - frame[3]) < 0.3,
    `${frame.map((v) => v.toFixed(1))} → ${frame2.map((v) => v.toFixed(1))}`);
  check('the picture grew by the drag', Math.abs(a2.wp / a.wp - 1.25) < 0.05, (a2.wp / a.wp).toFixed(3));
  check('and so did the line, by the same factor', Math.abs(cap2.wp / cap.wp - 1.25) < 0.05, (cap2.wp / cap.wp).toFixed(3));
  store = await records(IMAGES);
  check('still one record per object', store.length === 2, JSON.stringify(store));
  check('the line’s record is still a move and a uniform scale',
    ((r) => r && r[1] === 0 && r[2] === 0 && r[0] === r[3])(store.find((r) => r.key === caption.key)?.transform), JSON.stringify(store));

  // ---- 4. the keys act on every selected object -------------------------------------------------------------

  area('keys');
  a = await objectAt(IMAGES, 1, picA.key);
  cap = await objectAt(IMAGES, 1, caption.key);
  const depth1 = await undoDepth(IMAGES);
  await q(`${V(IMAGES)}.focus()`);
  for (let i = 0; i < 4; i++) {
    await c.key('ArrowRight');
    await sleep(60);
  }
  await sleep(1500);
  await rest(IMAGES);
  fit = moved(a, await objectAt(IMAGES, 1, picA.key), 4, 0, 0.2);
  check('four arrow keys move the picture four points', fit.ok, fit.detail);
  fit = moved(cap, await objectAt(IMAGES, 1, caption.key), 4, 0, 0.2);
  check('and the line with it', fit.ok, fit.detail);
  check('the burst is one undo step for the whole group', (await undoDepth(IMAGES)) === depth1 + 1);

  await clearToasts();
  const held = JSON.stringify(await records(IMAGES));
  await c.key(']');
  check('a turn is refused for a selection with text in it, and says why', await toast('/Not all of the selected objects can be turned/'));
  await sleep(600);
  check('and nothing was written', JSON.stringify(await records(IMAGES)) === held);

  // Tab still walks the editable text, starting from the text chosen last, and leaves a group behind.
  await c.key('Shift+Tab');
  await sleep(600);
  const walked = await selectedKeys(IMAGES);
  check('Shift+Tab from a group goes to the text before the last line chosen, alone',
    walked.length === 1 && walked[0] === lines.find((o) => o.key !== caption.key).key, JSON.stringify(walked));
  check('Enter then opens it, as it always did', await (async () => {
    await c.key('Enter');
    await sleep(600);
    const open = await editorOpen(IMAGES);
    await c.key('Escape');
    await sleep(400);
    return open;
  })());

  // ---- 5. Ctrl+A, and the selection rectangle ----------------------------------------------------------------

  area('Ctrl+A and the rectangle');
  await c.key('Escape');
  await sleep(350);
  check('Escape clears the whole selection', (await selection(IMAGES)) === null);
  check('and Edit mode stays on', await q(`${V(IMAGES)}.annotLayer.tool`) === 'edit');
  await c.key('Ctrl+A');
  await sleep(600);
  all = (await objectsOn(IMAGES, 1)).filter((o) => !o.gone);
  check('Ctrl+A selects every object on the page', sameSet(await selectedKeys(IMAGES), all.map((o) => o.key)),
    `${(await selectedKeys(IMAGES)).length} of ${all.length}`);
  check('and no text in the document was selected instead', await q('String(getSelection()).length === 0'));
  await c.key('Escape');
  await sleep(350);

  // A rectangle around picture B alone, from bare paper to bare paper.
  const margin = 12;
  await revealAll(IMAGES, 1, [picB.key]);
  const bNow = await objectAt(IMAGES, 1, picB.key);
  const from = await clientOf(IMAGES, 1, bNow.x1p - margin, bNow.y2p + margin);
  const to = await clientOf(IMAGES, 1, bNow.x2p + margin, bNow.y1p - margin);
  await c.drag(from, to, 12);
  await sleep(600);
  check('a rectangle over bare paper selects what it encloses, and only that', sameSet(await selectedKeys(IMAGES), [picB.key]),
    JSON.stringify(await selectedKeys(IMAGES)));
  check('the rectangle is gone when the mouse lets go', (await drawn(IMAGES)).marquee === 0);
  const other = (await objectsOn(IMAGES, 1)).find((o) => o.text === 'Text beside another picture');
  const from2 = await clientOf(IMAGES, 1, other.x1p - margin, other.y2p + margin);
  const to2 = await clientOf(IMAGES, 1, other.x2p + margin, other.y1p - margin);
  await c.drag(from2, to2, 12, { modifiers: SHIFT });
  await sleep(600);
  check('with Shift a rectangle adds to the selection', sameSet(await selectedKeys(IMAGES), [picB.key, other.key]),
    JSON.stringify(await selectedKeys(IMAGES)));
  const clickPaper = await clientOf(IMAGES, 1, bNow.x1p - 40, bNow.y1p - 40);
  await c.mouse(clickPaper[0], clickPaper[1]);
  await sleep(450);
  check('a plain click on bare paper clears it, as it always did', (await selection(IMAGES)) === null);
  await shot('rectangle');

  // ---- 6. deleting several objects ----------------------------------------------------------------------

  area('deleting together');
  const target = await objectAt(IMAGES, 1, picB.key);
  const targetText = await objectAt(IMAGES, 1, other.key);
  await c.drag(await clientOf(IMAGES, 1, Math.min(target.x1p, targetText.x1p) - margin, Math.max(target.y2p, targetText.y2p) + margin),
    await clientOf(IMAGES, 1, Math.max(target.x2p, targetText.x2p) + margin, Math.min(target.y1p, targetText.y1p) - margin), 12);
  await sleep(600);
  check('the picture and the line beside it are selected', sameSet(await selectedKeys(IMAGES), [picB.key, other.key]),
    JSON.stringify(await selectedKeys(IMAGES)));
  const depth2 = await undoDepth(IMAGES);
  await c.key('Delete');
  await rest(IMAGES);
  const both = (list) => list.filter((o) => [picB.key, other.key].includes(o.key));
  let now = both(await objectsOn(IMAGES, 1));
  check('Delete removes both', now.length === 2 && now.every((o) => o.gone), JSON.stringify(now.map((o) => [o.key, o.gone])));
  check('nothing is left selected', (await selection(IMAGES)) === null);
  check('as one undo step', (await undoDepth(IMAGES)) === depth2 + 1);
  await q(`${V(IMAGES)}.annotations.undo()`);
  await rest(IMAGES);
  now = both(await objectsOn(IMAGES, 1));
  check('and undo brings both back', now.length === 2 && now.every((o) => !o.gone), JSON.stringify(now.map((o) => [o.key, o.gone])));

  // ---- 7. the saved file ----------------------------------------------------------------------------------

  area('save and reopen');
  const savedA = (await objectAt(IMAGES, 1, picA.key)).quad;
  const savedCaption = (await objectAt(IMAGES, 1, caption.key)).quad;
  await q('__vellum.actions.save()');
  await waitFor(`!${V(IMAGES)}.annotations.dirty`, 25000);
  await q(`__vellum.app.close(${V(IMAGES)})`);
  await waitFor(`!${V(IMAGES)}`);
  await q(`__vellum.actions.openRecent(${JSON.stringify(IMAGES)})`);
  await rest(IMAGES);
  const near = (p, r, tol) => p.length === r.length && p.every((v, i) => Math.abs(v - r[i]) <= tol);
  const reopened = await objectsOn(IMAGES, 1);
  check('the reopened file holds no edit records: the changes are in its bytes', (await records(IMAGES)).length === 0);
  check('the picture is where the group put it', reopened.some((o) => o.kind === 'image' && near(o.quad, savedA, 1)),
    JSON.stringify(reopened.filter((o) => o.kind === 'image').map((o) => o.quad.map((v) => Math.round(v)))));
  const keptCaption = reopened.find((o) => o.kind === 'text-run' && near(o.quad, savedCaption, 1.5));
  check('and so is the line, still the same text', keptCaption?.text === caption.text,
    JSON.stringify(reopened.filter((o) => o.kind === 'text-run').map((o) => [o.text, o.quad.map((v) => Math.round(v))])));
  await shot('reopened');

  // ---- 8. lining up and spacing evenly: the arrange bar and the palette ----------------------------------------

  area('arrange');
  await editMode(IMAGES);
  await q(`${V(IMAGES)}.goToPage(1)`);
  await sleep(400);
  await q(`${V(IMAGES)}.focus()`);
  await c.key('Ctrl+A');
  await sleep(700);
  const bar = () => q(`(() => {
    const el = ${V(IMAGES)}.el.querySelector('.vl-arrange-bar');
    if (!el) return null;
    const buttons = [...el.querySelectorAll('button')].filter((b) => !b.hidden).map((b) => b.getAttribute('aria-label'));
    return { buttons };
  })()`);
  const press = async (label) => {
    const at = await q(`(() => {
      const b = [...${V(IMAGES)}.el.querySelectorAll('.vl-arrange-bar button')].find((x) => x.getAttribute('aria-label') === ${JSON.stringify(label)});
      if (!b) return null;
      const r = b.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    })()`);
    if (at) await c.mouse(at.x, at.y);
    return Boolean(at);
  };
  const live = async () => (await objectsOn(IMAGES, 1)).filter((o) => !o.gone);
  let shown = await bar();
  check('a selection of several objects gets the arrange bar, all eight actions', shown?.buttons.length === 8, JSON.stringify(shown));
  const arrangeDepth = await undoDepth(IMAGES);
  check('Align left edges, from the bar', await press('Align left edges'));
  await rest(IMAGES);
  let placed = await live();
  const lefts = placed.map((o) => o.x1p);
  check('every object’s left edge is now in one place', Math.max(...lefts) - Math.min(...lefts) < 0.2, lefts.map((v) => v.toFixed(2)).join(', '));
  check('one undo step for all of them', (await undoDepth(IMAGES)) === arrangeDepth + 1);
  check('and the selection and the bar are still there', (await selectedKeys(IMAGES)).length === placed.length && Boolean(await bar()));
  await q(`${V(IMAGES)}.annotations.undo()`);
  await rest(IMAGES);

  // From the command palette, which calls the same thing.
  await q(`${V(IMAGES)}.focus()`);
  await c.key('Ctrl+K');
  await waitFor(`document.activeElement?.closest?.('.palette')`, 3000);
  await c.type('Space evenly down');
  await sleep(300);
  await c.key('Enter');
  await sleep(500);
  await rest(IMAGES);
  placed = (await live()).sort((p, r) => r.y2p - p.y2p); // top of the page first
  const vgaps = placed.slice(1).map((o, i) => placed[i].y1p - o.y2p);
  check('Space evenly down, from the palette: every gap down the page is the same',
    Math.max(...vgaps) - Math.min(...vgaps) < 0.2, vgaps.map((v) => v.toFixed(2)).join(', '));

  // Two objects: lining up yes, spacing evenly no.
  await revealAll(IMAGES, 1, placed.slice(0, 2).map((o) => o.key));
  const two = (await live()).filter((o) => placed.slice(0, 2).some((p) => p.key === o.key));
  await c.mouse(two[0].cx, two[0].cy);
  await sleep(450);
  if (await editorOpen(IMAGES)) { // a click on a line opens it for typing; that is not what this is about
    await c.key('Escape');
    await sleep(400);
  }
  await c.mouse(two[1].cx, two[1].cy, { modifiers: SHIFT });
  await sleep(450);
  shown = await bar();
  check('with two objects the bar offers lining up only', shown?.buttons.length === 6, JSON.stringify(shown));

  // With the view turned, "top" is the top a person sees.
  await c.key('Ctrl+A');
  await sleep(500);
  await q(`${V(IMAGES)}.rotate(90)`);
  await sleep(900);
  await rest(IMAGES);
  check('Align top edges on a turned view', await press('Align top edges'));
  await rest(IMAGES);
  const tops = (await live()).map((o) => o.top);
  check('every object’s top is level on screen', Math.max(...tops) - Math.min(...tops) < 1.5, tops.map((v) => v.toFixed(1)).join(', '));
  await q(`${V(IMAGES)}.rotate(-90)`);
  await sleep(700);
  await c.key('Escape');
  await sleep(400);
  check('Escape clears the selection, and the bar goes with it', (await selection(IMAGES)) === null && !(await bar()));
  await shot('arranged');

  // ---- 9. one object that can't be changed holds the whole group back ------------------------------------------

  area('refusals');
  const OBJECTS = F('objects');
  await activate(OBJECTS);
  await editMode(OBJECTS);
  const objs = await objectsOn(OBJECTS, 1);
  const free = objs.find((o) => o.kind === 'image' && o.caps.move === true);
  const clipped = objs.find((o) => o.caps.move === 'clipped');
  check('the page has a movable picture and a clipped one', Boolean(free && clipped));
  await revealAll(OBJECTS, 1, [free.key, clipped.key]);
  const f1 = await objectAt(OBJECTS, 1, free.key);
  const k1 = await objectAt(OBJECTS, 1, clipped.key);
  await c.mouse(f1.cx, f1.cy);
  await sleep(450);
  await c.mouse(k1.cx, k1.cy, { modifiers: CTRL });
  await sleep(450);
  check('both are selected', sameSet(await selectedKeys(OBJECTS), [free.key, clipped.key]));
  check('no handles: not every object can be scaled', (await drawn(OBJECTS)).handles === 0, JSON.stringify(await drawn(OBJECTS)));
  const objHeld = JSON.stringify(await records(OBJECTS));
  await clearToasts();
  await c.drag([f1.cx, f1.cy], [f1.cx + 40, f1.cy + 25], 10);
  check('dragging the group says why it can’t move', await toast('/Not all of the selected objects can be moved/'));
  await sleep(700);
  await rest(OBJECTS);
  check('and nothing was written, not even for the picture that could have moved', JSON.stringify(await records(OBJECTS)) === objHeld);
  check('which has not moved', moved(f1, await objectAt(OBJECTS, 1, free.key), 0, 0, 0.1).ok);
  await clearToasts();
  await q(`${V(OBJECTS)}.focus()`);
  await c.key('Delete');
  check('Delete is refused for the group in the same words', await toast('/Not all of the selected objects can be deleted/'));
  await sleep(500);
  check('and deletes nothing', JSON.stringify(await records(OBJECTS)) === objHeld);

  // ---- 10. a page change clears a selection of several ----------------------------------------------------------

  area('page changes');
  await c.key('Ctrl+A');
  await sleep(500);
  check('Ctrl+A on the objects page', (await selectedKeys(OBJECTS)).length > 2);
  await q(`(() => { const v = ${V(OBJECTS)}; v.rotatePages([v.shownPlan[0].id], 90); })()`);
  await rest(OBJECTS);
  check('turning the page clears the selection rather than guessing where it went', (await selection(OBJECTS)) === null);

  // ---- 11. a paragraph moves as one block; one of its lines, clicked into, moves alone ---------------------------

  area('paragraphs');
  const PARA = F('paragraphs');
  await activate(PARA);
  await editMode(PARA);
  const TEXTS = ['The first line of a plain paragraph that', 'runs on to a second line, then a third', 'line, and ends on this fourth one, which', 'is shorter.'];
  let paraObjs = await objectsOn(PARA, 1);
  const paraKeys = TEXTS.map((s) => paraObjs.find((o) => o.text === s)?.key);
  const bulletKey = paraObjs.find((o) => o.text === '• Second bullet')?.key;
  check('the page has the paragraph and the list', paraKeys.every(Boolean) && Boolean(bulletKey));
  await revealAll(PARA, 1, [...paraKeys, bulletKey]);
  const beforePara = await Promise.all(paraKeys.map((k) => objectAt(PARA, 1, k)));
  const bulletBefore = await objectAt(PARA, 1, bulletKey);
  const second = beforePara[1];
  await c.drag([second.cx, second.cy], [second.cx + 60, second.cy + 20], 10);
  await sleep(700);
  await rest(PARA);
  check('dragging one line of the paragraph selects all four lines', sameSet(await selectedKeys(PARA), paraKeys), JSON.stringify(await selectedKeys(PARA)));
  const afterPara = await Promise.all(paraKeys.map((k) => objectAt(PARA, 1, k)));
  const dxp = afterPara[1].cxp - second.cxp;
  const dyp = afterPara[1].cyp - second.cyp;
  const each = beforePara.map((b, i) => moved(b, afterPara[i], dxp, dyp, 0.01));
  check('…and moves every line of it by the same amount', Math.abs(dxp) > 10 && each.every((m) => m.ok), each.map((m) => m.detail).join(' | '));
  check('…as one undo step', (await undoDepth(PARA)) === 1);
  check('the list under it did not move', moved(bulletBefore, await objectAt(PARA, 1, bulletKey), 0, 0, 0.01).ok);
  check('the paragraph’s bar appears for it once the hand lets go', Boolean(await q(`document.querySelector('.vl-arrange-bar:not([hidden])')`)));

  // A click (no drag) on a paragraph line opens the editor on that line alone; a drag from there moves only it.
  let third = await objectAt(PARA, 1, paraKeys[2]);
  await c.mouse(third.cx, third.cy);
  await sleep(600);
  check('a click on a paragraph line selects that line alone and opens the editor', sameSet(await selectedKeys(PARA), [paraKeys[2]]) && await editorOpen(PARA));
  await c.key('Escape'); // a drag inside the open editor selects its text; closed, the line stays selected
  await sleep(400);
  check('Escape closes the editor and keeps that line selected', sameSet(await selectedKeys(PARA), [paraKeys[2]]) && !(await editorOpen(PARA)));
  third = await objectAt(PARA, 1, paraKeys[2]);
  const firstBefore = await objectAt(PARA, 1, paraKeys[0]);
  await c.drag([third.cx + 5, third.cy], [third.cx + 5, third.cy + 40], 10);
  await sleep(700);
  await rest(PARA);
  const thirdAfter = await objectAt(PARA, 1, paraKeys[2]);
  check('dragging that line then moves it alone', Math.abs(thirdAfter.cyp - third.cyp) > 10 && moved(firstBefore, await objectAt(PARA, 1, paraKeys[0]), 0, 0, 0.01).ok,
    JSON.stringify({ third: [third.cyp, thirdAfter.cyp] }));
  const bullet = await objectAt(PARA, 1, bulletKey);
  await c.drag([bullet.cx, bullet.cy], [bullet.cx + 30, bullet.cy], 10);
  await sleep(700);
  await rest(PARA);
  check('a list line is never grouped: it moves alone', sameSet(await selectedKeys(PARA), [bulletKey]));

  // Overlap warnings: dragging a table cell onto the one under it outlines that cell while the hand moves.
  area('overlap warnings');
  paraObjs = await objectsOn(PARA, 1);
  const cellA1 = paraObjs.find((o) => o.text === 'Cell A1');
  const cellA2 = paraObjs.find((o) => o.text === 'Cell A2');
  await revealAll(PARA, 1, [cellA1.key, cellA2.key]);
  const [cell, onto] = [await objectAt(PARA, 1, cellA1.key), await objectAt(PARA, 1, cellA2.key)];
  const overlapOutlines = () => q(`${V(PARA)}.el.querySelectorAll('.vl-overlap').length`);
  check('no warning before anything moves', (await overlapOutlines()) === 0);
  const mouseEvent = (type, x, y) => c.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1 });
  await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: cell.cx, y: cell.cy });
  await mouseEvent('mousePressed', cell.cx, cell.cy);
  for (let i = 1; i <= 10; i++) await mouseEvent('mouseMoved', cell.cx + ((onto.cx - cell.cx) * i) / 10, cell.cy + ((onto.cy - cell.cy) * i) / 10);
  await sleep(300);
  check('dragging a cell over the one below outlines that one as overlapped', (await overlapOutlines()) === 1);
  await mouseEvent('mouseReleased', onto.cx, onto.cy);
  await sleep(300);
  check('the warning goes when the hand lets go, and the move is still made', (await overlapOutlines()) === 0
    && Math.abs((await objectAt(PARA, 1, cellA1.key)).cyp - cell.cyp) > 5);

  check('no page errors were collected', (await q('__vellum.errors.length')) === 0, await q('JSON.stringify(__vellum.errors.slice(0, 3))'));
}
