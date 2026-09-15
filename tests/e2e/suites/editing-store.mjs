// Text edits through DocumentView.textEditing in the real app: the rebuild, undo/redo in the one
// history, save → close → reopen, and the rebuild on a large document. (The 0.4 Phase 2 checks, moved
// into the repository; the large document is the generated 200-page file.)

export const files = { simple: 'simple', large: 'large' };

export async function run(t) {
  const { q, check, sleep, V } = t;
  const simplePath = t.file('simple');
  const manualPath = t.file('large');
  const waitFor = async (expr, ms = 30000) => {
    if (!(await t.waitFor(expr, ms))) throw new Error(`timed out: ${expr}`);
    return true;
  };
  const settled = (name) => `(() => { const v = ${V(name)}; return v && v.status === 'ready' && !v.rebuilding; })()`;
  const lineAt = (name, y) => q(`(async () => {
    const v = ${V(name)};
    const t = await (await v.pdf.getPage(1)).getTextContent();
    // Non-empty items only: pdf.js leaves an empty marker where text was taken out.
    return t.items.find((i) => i.str.trim() && Math.round(i.transform[5]) === ${y})?.str ?? null;
  })()`);
  const runKey = (name, page, text) => q(`(async () => {
    const p = await ${V(name)}.textEditing.page(${page});
    const r = p.runs.find((x) => x.text === ${JSON.stringify(text)});
    return r ? { key: r.run.key, editable: r.run.editable, reasons: [...r.run.reasons] } : null;
  })()`);
  const edit = (name, page, key, text) => q(`${V(name)}.textEditing.edit(${page}, ${JSON.stringify(key)}, ${JSON.stringify(text)})`);

  // ---- simple: A → B → C, undo/redo, save, close, reopen --------------------------------------------
  await waitFor(settled(simplePath));
  await q(`__vellum.app.activate(${V(simplePath)})`);
  const run = await runKey(simplePath, 1, 'Hello, world');
  check('the first line is found and editable', run?.editable === true, JSON.stringify(run));

  await edit(simplePath, 1, run.key, 'Hello, Vellum');
  await waitFor(settled(simplePath));
  check('A → B shows on the page', (await lineAt(simplePath, 700)) === 'Hello, Vellum');
  await edit(simplePath, 1, run.key, 'Goodbye, Vellum');
  await waitFor(settled(simplePath));
  check('B → C shows on the page', (await lineAt(simplePath, 700)) === 'Goodbye, Vellum');
  const history = [];
  for (const step of ['undo', 'undo', 'redo', 'redo']) {
    await q(`${V(simplePath)}.annotations.${step}()`);
    await sleep(50);
    await waitFor(settled(simplePath));
    history.push(await lineAt(simplePath, 700));
  }
  check('undo → B, undo → A, redo → B, redo → C', JSON.stringify(history) === JSON.stringify(['Hello, Vellum', 'Hello, world', 'Hello, Vellum', 'Goodbye, Vellum']), JSON.stringify(history));
  check('the tab shows unsaved changes', await q(`${V(simplePath)}.annotations.dirty && Boolean(document.querySelector('.tab.active.dirty'))`));
  // Thumbnails are drawn again after each rebuild, in their own time: wait for one rather than
  // catching the moment between the old canvas going and the new one arriving.
  const thumbs = await waitFor(`Boolean(document.querySelector('.thumbs .thumb canvas'))`, 8000);
  check('thumbnails still render', thumbs);

  await q('__vellum.actions.save()');
  await waitFor(`!${V(simplePath)}.annotations.dirty`, 20000);
  check('saved (no unsaved changes left)', true);
  await q(`__vellum.app.close(${V(simplePath)})`);
  await waitFor(`!${V(simplePath)}`);
  await q(`__vellum.actions.openRecent(${JSON.stringify(simplePath)})`);
  await waitFor(settled(simplePath));
  check('reopened: the saved text is on the page', (await lineAt(simplePath, 700)) === 'Goodbye, Vellum');
  const again = await runKey(simplePath, 1, 'Goodbye, Vellum');
  check('reopened: the saved text is editable again', again?.editable === true, JSON.stringify(again));
  check('reopened: nothing to undo (a fresh history)', await q(`!${V(simplePath)}.annotations.canUndo`));

  // ---- large document (200 pages): rebuild timing, then discard -------------------------------------
  await waitFor(settled(manualPath), 60000);
  await q(`__vellum.app.activate(${V(manualPath)})`);
  await q(`${V(manualPath)}.goToPage(50)`);
  await sleep(800);
  const target = await q(`(async () => {
    const p = await ${V(manualPath)}.textEditing.page(50);
    const r = p.runs.find((x) => x.run.editable && x.text.length > 12);
    return r ? { key: r.run.key, text: r.text } : null;
  })()`);
  check('the large document has editable text on page 50', Boolean(target), target?.text);
  const timing = await q(`(async () => {
    const v = ${V(manualPath)};
    const started = performance.now();
    const swapped = new Promise((resolve) => v.addEventListener('documentchange', resolve, { once: true }));
    await v.textEditing.edit(50, ${JSON.stringify(target?.key ?? '')}, ${JSON.stringify(`${target?.text ?? ''} (edited)`)});
    await swapped;
    const composed = performance.now() - started;
    await new Promise((resolve) => { const done = () => (v.rebuilding ? requestAnimationFrame(done) : resolve()); done(); });
    // pdf.js restores the page once the new document's pages are laid out (pagesinit).
    const until = performance.now() + 3000;
    while (v.state.pageNumber !== 50 && performance.now() < until) await new Promise((r) => setTimeout(r, 50));
    return { composedAndSwapped: Math.round(composed), total: Math.round(performance.now() - started), page: v.state.pageNumber };
  })()`);
  check('the view stays on page 50 after the edit', timing.page === 50, JSON.stringify(timing));
  const shows = await q(`(async () => { const t = await (await ${V(manualPath)}.pdf.getPage(50)).getTextContent(); return t.items.some((i) => i.str.includes('(edited)')); })()`);
  check('the edit shows on page 50', shows);
  await q(`${V(manualPath)}.annotations.undo()`);
  await sleep(50);
  await waitFor(settled(manualPath), 60000);
  await q(`__vellum.app.close(${V(manualPath)})`); // discard: no save prompt when closed directly

  // ---- clean up: no runtime errors; test files leave the recent list (Vellum's own remove) ------
  const errors = await q('__vellum.errors');
  check('no runtime errors', errors.length === 0, JSON.stringify(errors).slice(0, 300));
  await q(`(async () => {
    for (const path of ${JSON.stringify([simplePath, manualPath])}) await __vellum.ui.start.bridge.request('recent.remove', { path });
    __vellum.ui.start.refresh();
  })()`);
  console.log(`  timing (200-page document, one edit): ${JSON.stringify(timing)}`);
}
