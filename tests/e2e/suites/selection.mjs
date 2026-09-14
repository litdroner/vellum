// Vellum 0.5.0 Phase 2: object selection in the real app.
//
// Selection is reached the way a person reaches it — Edit mode, then a click on the page. There is
// no tool of its own and nothing is driven through internals that a person couldn't work: the app
// is asked where an object is, the mouse is moved there, and what comes back is read off the DOM.
//
// The checks that matter most are the geometric ones. A selection outline is drawn in PDF user
// space through the page overlay, so if anything subtracted a crop origin twice, turned a page by
// hand, or measured on screen instead of in points, the outline lands somewhere other than the
// object. Every transform the viewer has is put through that test: zoom, viewer rotation, a page
// with its own /Rotate, and a crop box that doesn't start at the origin.
//
// Z-order is not exercised here: no fixture draws two selectable objects over each other, and the
// engine suite covers it directly (tests/editing/object-geometry.test.mjs).

export const files = {
  objects: 'objects', cropbox: 'cropbox', rotated: 'mixed-sizes', simple: 'simple',
};

export async function run(t) {
  const { c, q, check, sleep, shot, V, settled, waitFor, area } = t;
  const F = (name) => t.file(name);

  const activate = async (path) => {
    await q(`__vellum.app.activate(${V(path)})`);
    await waitFor(settled(path), 20000);
    await q(`${V(path)}.focus()`);
    await sleep(400);
  };
  const editMode = async (path) => {
    await q(`${V(path)}.setTool('edit')`);
    await sleep(500);
    return q(`${V(path)}.annotLayer.tool`);
  };

  /** Every selectable object on a page, with where it currently is on screen. */
  const objectsOn = (path, n) => q(`(async () => {
    const v = ${V(path)};
    const { objects } = await v.textEditing.objects(${n});
    const pv = v.viewer.getPageView(${n} - 1);
    if (!pv) return [];
    const vp = pv.viewport;
    const box = pv.div.getBoundingClientRect();
    return objects.map((o) => {
      const xs = []; const ys = [];
      for (let i = 0; i < 8; i += 2) {
        const [vx, vy] = vp.convertToViewportPoint(o.geometry.quad[i], o.geometry.quad[i + 1]);
        xs.push(box.left + vx * (box.width / vp.width));
        ys.push(box.top + vy * (box.height / vp.height));
      }
      const left = Math.min(...xs); const right = Math.max(...xs);
      const top = Math.min(...ys); const bottom = Math.max(...ys);
      return {
        key: o.ref.key, kind: o.kind, text: o.kind === 'text-run' ? o.text : null, editable: o.editable ?? null,
        left, top, right, bottom, cx: (left + right) / 2, cy: (top + bottom) / 2,
      };
    });
  })()`);

  /**
   * Scrolls an object into the middle of the view, then reports where it ended up — and whether it
   * is somewhere the mouse can actually reach. Both axes matter: a document with one wide page
   * scrolls sideways too, and an object on a narrower page can sit well outside the window.
   */
  const reveal = async (path, n, key) => {
    await q(`${V(path)}.goToPage(${n})`);
    await sleep(350);
    const moved = await q(`(async () => {
      const v = ${V(path)};
      const { objects } = await v.textEditing.objects(${n});
      const o = objects.find((x) => x.ref.key === ${JSON.stringify(key)});
      if (!o) return false;
      const pv = v.viewer.getPageView(${n} - 1);
      const vp = pv.viewport;
      const box = pv.div.getBoundingClientRect();
      const view = v.container.getBoundingClientRect();
      let sx = 0; let sy = 0;
      for (let i = 0; i < 8; i += 2) {
        const [vx, vy] = vp.convertToViewportPoint(o.geometry.quad[i], o.geometry.quad[i + 1]);
        sx += box.left + vx * (box.width / vp.width);
        sy += box.top + vy * (box.height / vp.height);
      }
      v.container.scrollTop += ((sy / 4) - view.top) - view.height / 2;
      v.container.scrollLeft += ((sx / 4) - view.left) - view.width / 2;
      return true;
    })()`);
    await sleep(450);
    if (!moved) return null;
    const list = await objectsOn(path, n);
    const found = list.find((o) => o.key === key);
    if (!found) return null;
    const view = await q(`(() => { const r = ${V(path)}.container.getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom }; })()`);
    found.visible = found.cx > view.left && found.cx < view.right && found.cy > view.top && found.cy < view.bottom;
    return found;
  };

  /** The selection as identity; `key` is the one selected object, when exactly one is. */
  const selection = (path) => q(`(() => {
    const s = ${V(path)}.objectSelection.current;
    return s ? {
      page: s.page, key: s.keys.length === 1 ? s.keys[0] : null, keys: [...s.keys],
      fields: Object.keys(s).sort(), frozen: Object.isFrozen(s) && Object.isFrozen(s.keys), json: JSON.stringify(s),
    } : null;
  })()`);

  /**
   * Where the selection outline actually is on screen, whatever drew it. Scoped to the document
   * being asked about: several are open here, and a view that isn't on screen keeps its own
   * outlines in the DOM.
   */
  const outline = (path) => q(`(() => {
    const root = ${V(path)}.el;
    const el = root.querySelector('.vl-object-sel') || root.querySelector('.vl-edit-run.focus');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, cls: el.getAttribute('class') };
  })()`);

  /** Does the drawn outline sit on the object, to within a pixel or two of stroke? */
  const outlineFits = (box, o) => {
    if (!box || !o) return { ok: false, detail: box ? 'no object' : 'no outline drawn' };
    const dx = Math.abs((box.left + box.right) / 2 - o.cx);
    const dy = Math.abs((box.top + box.bottom) / 2 - o.cy);
    const dw = Math.abs((box.right - box.left) - (o.right - o.left));
    const dh = Math.abs((box.bottom - box.top) - (o.bottom - o.top));
    const ok = dx <= 2.5 && dy <= 2.5 && dw <= 6 && dh <= 6;
    return { ok, detail: `centre off by ${dx.toFixed(1)}, ${dy.toFixed(1)}; size off by ${dw.toFixed(1)}, ${dh.toFixed(1)}` };
  };

  const clickObject = async (o) => {
    await c.mouse(o.cx, o.cy);
    await sleep(400);
  };
  const editorOpen = (path) => q(`Boolean(${V(path)}.el.querySelector('.vl-text-editor'))`);

  /**
   * Closes the inline editor if one is open, and only then. Clicking editable text opens it, and
   * while it is open it covers the text — so the outline underneath is deliberately not drawn.
   * Escape with no editor open would clear the selection instead, which is a different test.
   */
  const closeEditor = async (path) => {
    if (!(await editorOpen(path))) return;
    await c.key('Escape');
    await sleep(400);
  };

  /** A point on the page, visible right now, that no selectable object covers. */
  const emptyPaper = (path, n) => q(`(async () => {
    const v = ${V(path)};
    const { objects } = await v.textEditing.objects(${n});
    const pv = v.viewer.getPageView(${n} - 1);
    const vp = pv.viewport;
    const box = pv.div.getBoundingClientRect();
    const view = v.container.getBoundingClientRect();
    const boxes = objects.map((o) => {
      const xs = []; const ys = [];
      for (let i = 0; i < 8; i += 2) {
        const [vx, vy] = vp.convertToViewportPoint(o.geometry.quad[i], o.geometry.quad[i + 1]);
        xs.push(box.left + vx * (box.width / vp.width));
        ys.push(box.top + vy * (box.height / vp.height));
      }
      return [Math.min(...xs) - 4, Math.min(...ys) - 4, Math.max(...xs) + 4, Math.max(...ys) + 4];
    });
    // Only where the page and the visible part of the scroll container overlap.
    const left = Math.max(box.left, view.left) + 8;
    const right = Math.min(box.right, view.right) - 8;
    const top = Math.max(box.top, view.top) + 8;
    const bottom = Math.min(box.bottom, view.bottom) - 8;
    for (let gx = 0; gx <= 20; gx++) {
      for (let gy = 0; gy <= 20; gy++) {
        const x = left + ((right - left) * gx) / 20;
        const y = top + ((bottom - top) * gy) / 20;
        if (boxes.some((b) => x >= b[0] && x <= b[2] && y >= b[1] && y <= b[3])) continue;
        return { x, y };
      }
    }
    return null;
  })()`);

  // ---- selecting ------------------------------------------------------------------------------

  area('selecting');
  await activate(F('objects'));
  check('Edit mode is the way in — no new tool', await editMode(F('objects')) === 'edit');

  const all = await objectsOn(F('objects'), 1);
  const images = all.filter((o) => o.kind === 'image');
  const texts = all.filter((o) => o.kind === 'text-run');
  check('the page offers images and text to select', images.length > 0 && texts.length > 0, `${images.length} images, ${texts.length} runs`);
  check('paths and forms are not offered', all.every((o) => o.kind === 'image' || o.kind === 'text-run'));

  const image = await reveal(F('objects'), 1, images[0].key);
  await clickObject(image);
  let state = await selection(F('objects'));
  check('clicking an image selects it', state?.key === image.key, state?.key);
  check('the selection is identity and nothing else', state && state.fields.join(',') === 'keys,page', state?.json);
  check('and it is frozen, so nothing can be hung off it', state?.frozen === true);
  check('no editor opens for an image', (await editorOpen(F('objects'))) === false);
  let box = await outline(F('objects'));
  check('an outline is drawn for it', Boolean(box), box?.cls);
  let fit = outlineFits(box, image);
  check('the outline sits on the image', fit.ok, fit.detail);
  await shot('image-selected');

  const editable = texts.find((o) => o.editable);
  const run = await reveal(F('objects'), 1, editable.key);
  await clickObject(run);
  state = await selection(F('objects'));
  check('clicking text selects the run', state?.key === editable.key, state?.key);
  check('and opens the editor, as it always did', await editorOpen(F('objects')));
  await c.key('Escape');
  await sleep(300);
  check('Escape closes the editor and keeps the selection', (await editorOpen(F('objects'))) === false && (await selection(F('objects')))?.key === editable.key);

  // Empty paper: nothing there to select.
  const paper = await emptyPaper(F('objects'), 1);
  check('the page has visible empty paper to click', Boolean(paper), JSON.stringify(paper));
  await c.mouse(paper.x, paper.y);
  await sleep(400);
  check('clicking empty paper clears the selection', (await selection(F('objects'))) === null);

  // ---- geometry, through every transform the viewer has ---------------------------------------

  area('geometry');
  const fitsNow = async (path, n, key, label) => {
    const list = await objectsOn(path, n);
    const o = list.find((x) => x.key === key);
    const drawn = await outline(path);
    const result = outlineFits(drawn, o);
    check(label, result.ok, result.detail);
  };

  const target = await reveal(F('objects'), 1, images[0].key);
  await clickObject(target);
  check('selected again for the geometry checks', (await selection(F('objects')))?.key === images[0].key);

  for (const zoom of [2, 0.5, 1.25]) {
    await q(`${V(F('objects'))}.zoomTo(${zoom})`);
    await sleep(600);
    await fitsNow(F('objects'), 1, images[0].key, `the outline follows the object at ${zoom}× zoom`);
  }
  await q(`${V(F('objects'))}.zoomTo(1)`);
  await sleep(500);

  for (const turn of [90, 90, 90, 90]) {
    await q(`${V(F('objects'))}.rotate(${turn})`);
    await sleep(700);
    const at = await q(`${V(F('objects'))}.viewer.pagesRotation`);
    await fitsNow(F('objects'), 1, images[0].key, `the outline follows the object with the view turned to ${at}°`);
  }

  await q(`__vellum.ui.sidebar.toggle()`);
  await sleep(700);
  await fitsNow(F('objects'), 1, images[0].key, 'the outline follows the object when the sidebar changes the layout');
  await q(`__vellum.ui.sidebar.toggle()`);
  await sleep(700);
  await shot('geometry-objects');

  // A crop box that doesn't start at the origin: anything that subtracts it twice shows up here.
  area('crop and page rotation');
  await activate(F('cropbox'));
  check('Edit mode on the cropped document', await editMode(F('cropbox')) === 'edit');
  const cropped = await objectsOn(F('cropbox'), 1);
  check('the cropped page offers something to select', cropped.length > 0, `${cropped.length} objects`);
  const croppedTarget = await reveal(F('cropbox'), 1, cropped[0].key);
  await clickObject(croppedTarget);
  const croppedState = await selection(F('cropbox'));
  check('an object on a cropped page can be selected', croppedState?.key === cropped[0].key, croppedState?.key ?? 'nothing selected');
  await closeEditor(F('cropbox'));
  await fitsNow(F('cropbox'), 1, cropped[0].key, 'the outline sits on it despite the offset crop box');
  await q(`${V(F('cropbox'))}.zoomTo(1.75)`);
  await sleep(700);
  await fitsNow(F('cropbox'), 1, cropped[0].key, 'and still does when the cropped page is zoomed');
  await shot('cropbox-selected');

  // A page with its own /Rotate, which the viewport carries rather than the selection.
  await closeEditor(F('cropbox'));
  await activate(F('rotated'));
  check('Edit mode on the mixed-size document', await editMode(F('rotated')) === 'edit');
  const rotatedPage = await q(`(async () => {
    const v = ${V(F('rotated'))};
    for (let n = 1; n <= v.pdf.numPages; n++) {
      const page = await v.pdf.getPage(n);
      if (page.rotate % 360 !== 0) return n;
    }
    return 0;
  })()`);
  check('the document has a page with its own /Rotate', rotatedPage > 0, `page ${rotatedPage}`);
  const onRotated = await objectsOn(F('rotated'), rotatedPage);
  check('that page offers something to select', onRotated.length > 0, `${onRotated.length} objects`);
  const rotatedTarget = await reveal(F('rotated'), rotatedPage, onRotated[0].key);
  check('the object on the /Rotate page is on screen to be clicked', rotatedTarget?.visible === true, JSON.stringify(rotatedTarget));
  await clickObject(rotatedTarget);
  const rotatedState = await selection(F('rotated'));
  check('an object on a /Rotate page can be selected', rotatedState?.key === onRotated[0].key,
    `${rotatedState?.key ?? 'nothing selected'} (wanted ${onRotated[0].key})`);
  await closeEditor(F('rotated'));
  await fitsNow(F('rotated'), rotatedPage, onRotated[0].key, 'the outline sits on it on a page the file itself turns');
  await shot('rotated-page-selected');

  // ---- keyboard --------------------------------------------------------------------------------

  area('keyboard');
  await closeEditor(F('rotated'));
  await activate(F('simple'));
  check('Edit mode on a plain document', await editMode(F('simple')) === 'edit');
  await q(`${V(F('simple'))}.focus()`);
  await sleep(200);

  await c.key('Tab');
  await sleep(500);
  const first = await selection(F('simple'));
  check('Tab selects the first editable text', first?.key?.startsWith('run:') === true, first?.key);
  await c.key('Tab');
  await sleep(500);
  const second = await selection(F('simple'));
  check('Tab moves on to the next', second?.key !== first?.key, `${first?.key} → ${second?.key}`);
  await c.key('Shift+Tab');
  await sleep(500);
  check('Shift+Tab comes back', (await selection(F('simple')))?.key === first?.key);

  check('an outline marks the selected text', Boolean(await outline(F('simple'))));
  await c.key('Enter');
  await sleep(600);
  check('Enter opens the editor on the selected text', await editorOpen(F('simple')));
  await c.key('Escape');
  await sleep(400);
  check('Escape leaves the editor', (await editorOpen(F('simple'))) === false);

  check('the selection is still there after the editor closes', (await selection(F('simple'))) !== null);
  await c.key('Escape');
  await sleep(350);
  check('Escape clears the selection', (await selection(F('simple'))) === null);
  check('and Edit mode is still on', await q(`${V(F('simple'))}.annotLayer.tool`) === 'edit');
  await c.key('Escape');
  await sleep(350);
  check('a further Escape leaves Edit mode, as it always did', await q(`${V(F('simple'))}.annotLayer.tool`) === 'select');

  // ---- rebuilds ---------------------------------------------------------------------------------

  area('rebuilds');
  await activate(F('objects'));
  await editMode(F('objects'));
  const again = (await objectsOn(F('objects'), 1)).filter((o) => o.kind === 'image');
  const kept = await reveal(F('objects'), 1, again[0].key);
  await clickObject(kept);
  check('an image is selected before the page is rewritten', (await selection(F('objects')))?.key === again[0].key);

  // A content rebuild: the pages are rewritten, and the two fields find the object again.
  const changed = await q(`(async () => {
    const v = ${V(F('objects'))};
    const p = await v.textEditing.page(1);
    const item = p.runs.find((r) => r.run.editable);
    if (!item) return null;
    await v.textEditing.edit(1, item.run.key, item.text + ' (changed)');
    return item.run.key;
  })()`);
  check('a text edit rebuilds the document', Boolean(changed), changed);
  await waitFor(settled(F('objects')), 20000);
  await sleep(1200);
  const survived = await selection(F('objects'));
  check('the selection is re-resolved after the rebuild', survived?.key === again[0].key, survived?.key);
  await fitsNow(F('objects'), 1, again[0].key, 'and its outline is drawn from the new analysis');

  // A page-plan change: two fields cannot tell a moved page from where it was, so it is dropped.
  await q(`(() => { const v = ${V(F('objects'))}; v.rotatePages([v.shownPlan[0].id], 90); })()`);
  await waitFor(settled(F('objects')), 20000);
  await sleep(1200);
  check('a page change clears the selection rather than guessing', (await selection(F('objects'))) === null);
  await shot('after-rebuild');

  check('no page errors were collected', (await q(`__vellum.errors.length`)) === 0, await q(`JSON.stringify(__vellum.errors.slice(0, 3))`));
}
