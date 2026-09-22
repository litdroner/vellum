// Keeping a text edit rebuilds the whole document, and pdf.js empties every page when it takes the new
// one. The page on screen must not blink: until it renders again it is shown as it was (document-view.js
// #holdPages), and the editor stays over it until then (text-editor.js #commit). Every animation frame
// through the rebuild is sampled for Enter, Done and a click away.

export const files = { 'flicker-simple': 'simple' };

export async function run(t) {
  const { c, q, check, sleep, shot, V, settled, waitFor } = t;
  const DOC = t.file('flicker-simple');
  const v = V(DOC);
  const editorOpen = `Boolean(document.querySelector('.vl-text-editor'))`;
  const editorGone = `!document.querySelector('.vl-text-editor')`;

  await waitFor(`Boolean(${v})`, 30000);
  await q(`__vellum.app.activate(${v})`);
  await waitFor(settled(DOC), 30000);
  await sleep(400);
  await c.key('E');
  await waitFor(`${v}.annotLayer.tool === 'edit'`, 3000);
  await waitFor(`document.querySelectorAll('.vl-decor polygon.vl-edit-run').length >= 3`);

  const runAt = (text) => q(`(async () => {
    const v = ${v};
    const p = await v.textEditing.page(1);
    const item = p.runs.find((r) => r.text === ${JSON.stringify(text)});
    if (!item) return null;
    const pv = v.viewer.getPageView(0);
    const vp = pv.viewport;
    const box = pv.div.getBoundingClientRect();
    let x = 0; let y = 0;
    for (let i = 0; i < 8; i += 2) {
      const [vx, vy] = vp.convertToViewportPoint(item.run.quad[i], item.run.quad[i + 1]);
      x += box.left + (vx * box.width) / vp.width;
      y += box.top + (vy * box.height) / vp.height;
    }
    return { x: x / 4, y: y / 4 };
  })()`);

  // Each frame: is page 1 showing pixels (its own rendering, or the held picture of it), is the
  // editor there, and where is the view scrolled.
  const record = () => q(`(() => {
    window.__flicker = [];
    window.__flickerStop = false;
    const loop = () => {
      const v = ${v};
      const pv = v.viewer.getPageView(0);
      const canvas = pv?.div.querySelector('.canvasWrapper canvas');
      const own = pv?.renderingState === 3 && canvas?.width > 0 && canvas.isConnected;
      const held = document.querySelector('.vl-held-page');
      __flicker.push({ own, held: Boolean(held), editor: Boolean(document.querySelector('.vl-text-editor')), rebuilding: v.rebuilding, top: Math.round(v.container.scrollTop) });
      if (!__flickerStop && __flicker.length < 900) requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  })()`);
  const frames = async () => {
    await q(`window.__flickerStop = true`);
    await sleep(100);
    return q(`window.__flicker`);
  };

  const keep = async (label, from, to, how) => {
    t.area(label);
    const at = await runAt(from);
    check('the text is found', Boolean(at), from);
    if (!at) return;
    await c.mouse(at.x, at.y);
    check('the editor opens', await waitFor(editorOpen, 4000));
    await q(`(() => { const i = document.querySelector('.vl-text-input'); i.select(); })()`);
    await c.type(to);
    await sleep(300);
    // Start from a page at rest: rendered, at its final scroll position.
    await waitFor(`${v}.viewer.getPageView(0)?.renderingState === 3 && !${v}.rebuilding`, 5000);
    await sleep(300);
    await record();
    await how();
    const done = await waitFor(`${editorGone} && ${settled(DOC)} && !document.querySelector('.vl-held-pages')`, 10000);
    await sleep(150);
    const f = await frames();
    check('the change is kept and the editor closes', done);
    const rebuilt = f.some((x) => x.rebuilding);
    check('the document was rebuilt', rebuilt, `${f.length} frames`);
    const blank = f.filter((x) => !x.own && !x.held);
    check('the page was held as it was while it re-rendered', f.some((x) => x.held && !x.own));
    check('page 1 shows pixels in every frame', blank.length === 0, `${blank.length} blank of ${f.length}`);
    const firstOwn = f.findIndex((x, i) => i > f.findIndex((y) => y.rebuilding) && x.own && !x.rebuilding);
    const closedEarly = f.slice(0, Math.max(0, firstOwn)).some((x) => !x.editor);
    check('the editor stays until the page has rendered again', rebuilt && firstOwn > 0 && !closedEarly, `first rendered frame ${firstOwn}`);
    const tops = new Set(f.map((x) => x.top));
    check('the view doesn’t scroll', tops.size === 1, [...tops].join(','));
    check('the held picture is gone afterwards', await q(`!document.querySelector('.vl-held-pages')`));
    check('the page reads the new text', (await runAt(to)) !== null);
    await shot(label.replace(/\W+/g, '-'));
  };

  await keep('Enter', 'Hello, world', 'Hello, steady', () => c.key('Enter'));
  await keep('Done', 'Hello, steady', 'Hello, calm', async () => {
    const r = await q(`(() => { const b = [...document.querySelectorAll('button')].find((b) => b.textContent === 'Done'); const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
    await c.mouse(r.x, r.y);
  });
  await keep('Click away', 'Hello, calm', 'Hello, still', async () => {
    const r = await q(`(() => { const r = ${v}.container.getBoundingClientRect(); return { x: r.left + 12, y: r.top + r.height / 2 }; })()`);
    await c.mouse(r.x, r.y);
  });

  t.area(null);
  check('no errors were collected', (await q(`__vellum.errors.length`)) === 0, JSON.stringify(await q(`__vellum.errors.slice(-3)`)));
}
