// Merge Documents V1 in the real app: the command palette opens the merge list with no document of
// its own, the list shows every chosen PDF with its page count in the order it will be merged, the
// order can be changed, a file can be dropped and more added, and a protected PDF is refused by name
// before it ever reaches the list. The merge itself — the pages, their order, their size and rotation,
// and the files being left alone — is proved over the bytes in tests/editing/merge.test.mjs.
//
// The Windows file dialog can't be driven from here, so for one call the bridge hands back files the
// way the host would. They are this run's own copies, already open in the app, so their bytes are
// read through the host exactly as they would be after a real Open dialog. The protected copy is the
// fixture that opens without asking for a password, so the app starts with no dialog in the way; it is
// still encrypted, so the merge still refuses it.

export const files = { simple: 'simple', multipage: 'multipage', mixed: 'mixed-sizes', locked: 'encrypted-open' };

export async function run(t) {
  const { c, q, check, sleep, shot, V, settled, waitFor, area } = t;
  const DOC = t.file('simple');

  const rest = async (ms = 25000) => {
    await waitFor(settled(DOC), ms);
    await sleep(400);
  };

  /** Hands back the descriptors of documents already open in the app, in the order named. */
  const stubOpenDialog = (paths) => q(`(async () => {
    const { bridge } = await import(new URL('js/bridge.js', location.href).href);
    const request = bridge.request;
    const wanted = ${JSON.stringify(paths.map((p) => p.toLowerCase()))};
    bridge.request = (type, payload) => {
      if (type !== 'openDialog') return request.call(bridge, type, payload);
      bridge.request = request;
      const files = wanted.map((p) => __vellum.app.views.find((v) => v.file.path.toLowerCase() === p)?.file).filter(Boolean);
      return Promise.resolve({ files });
    };
    return true;
  })()`);

  const openMergeDialog = async (paths) => {
    await stubOpenDialog(paths);
    await q(`${V(DOC)}.focus()`);
    await c.key('Ctrl+K');
    await waitFor(`document.activeElement?.closest?.('.palette')`, 3000);
    await c.type('Merge PDFs');
    await sleep(300);
    await c.key('Enter');
    await waitFor(`document.querySelector('.merge-dialog')`, 8000);
    await sleep(300);
  };

  const rows = () => q(`JSON.stringify([...document.querySelectorAll('.merge-item')].map((el) => [
    el.querySelector('.merge-order').textContent, el.querySelector('.merge-name').textContent, el.querySelector('.merge-pages').textContent]))`);
  const note = () => q(`document.querySelector('.merge-dialog .dialog-note').textContent`);
  const rowButton = (i, label) => q(`document.querySelectorAll('.merge-item')[${i}].querySelector('[aria-label="${label}"]')`);
  const clickRow = async (i, label) => {
    await q(`document.querySelectorAll('.merge-item')[${i}].querySelector('[aria-label="${label}"]').click()`);
    await sleep(250);
  };

  await q(`__vellum.app.activate(${V(DOC)})`);
  await rest();

  area('the merge list');
  await openMergeDialog([t.file('simple'), t.file('multipage')]);
  check('the merge dialog opens from the command palette', await q(`Boolean(document.querySelector('.merge-dialog'))`));
  check('every chosen PDF is listed in order, with its page count', await rows()
    === JSON.stringify([['1', 'simple.pdf', '1 page'], ['2', 'multipage.pdf', '5 pages']]), await rows());
  check('the merged page count is shown', /2 documents · 6 pages/.test(await note()), await note());
  check('the first file can’t move up and the last can’t move down',
    (await q(`document.querySelectorAll('.merge-item')[0].querySelector('[aria-label="Move up"]').disabled`))
    && (await q(`document.querySelectorAll('.merge-item')[1].querySelector('[aria-label="Move down"]').disabled`)));
  check('with only two files neither can be removed',
    await q(`[...document.querySelectorAll('.merge-item [aria-label="Remove from the list"]')].every((b) => b.disabled)`));
  await shot('merge-dialog');

  area('ordering');
  await clickRow(1, 'Move up');
  check('moving a file up reorders the list', await rows()
    === JSON.stringify([['1', 'multipage.pdf', '5 pages'], ['2', 'simple.pdf', '1 page']]), await rows());
  await clickRow(0, 'Move down');
  check('moving it back restores the original order', await rows()
    === JSON.stringify([['1', 'simple.pdf', '1 page'], ['2', 'multipage.pdf', '5 pages']]), await rows());

  area('adding and removing');
  await stubOpenDialog([t.file('mixed')]);
  await q(`document.querySelector('.merge-add .btn').click()`);
  await waitFor(`document.querySelectorAll('.merge-item').length === 3`, 8000);
  await sleep(250);
  check('a file added goes to the end of the list', await rows()
    === JSON.stringify([['1', 'simple.pdf', '1 page'], ['2', 'multipage.pdf', '5 pages'], ['3', 'mixed.pdf', '4 pages']]), await rows());
  check('the total follows', /3 documents · 10 pages/.test(await note()), await note());
  check('with three files they can be removed again', Boolean(await rowButton(0, 'Remove from the list'))
    && !(await q(`document.querySelectorAll('.merge-item')[0].querySelector('[aria-label="Remove from the list"]').disabled`)));
  await clickRow(1, 'Remove from the list');
  check('removing a file renumbers the rest', await rows()
    === JSON.stringify([['1', 'simple.pdf', '1 page'], ['2', 'mixed.pdf', '4 pages']]), await rows());
  check('the total follows a removal', /2 documents · 5 pages/.test(await note()), await note());

  area('refusals');
  await stubOpenDialog([t.file('locked')]);
  await q(`document.querySelector('.merge-add .btn').click()`);
  await waitFor(`[...document.querySelectorAll('.toast')].some((el) => /can.t be merged/.test(el.textContent))`, 8000);
  const refusal = await q(`[...document.querySelectorAll('.toast')].map((el) => el.textContent).join(' | ')`);
  check('a protected PDF is refused by name and never joins the list',
    /locked\.pdf/.test(refusal) && /protected \(encrypted\)/.test(refusal)
    && (await q(`document.querySelectorAll('.merge-item').length`)) === 2, refusal);
  await shot('merge-refusal');

  area('cancelling');
  await c.key('Escape');
  await waitFor(`!document.querySelector('.merge-dialog')`, 5000);
  check('Escape closes the merge list and nothing was written', !(await q(`Boolean(document.querySelector('.merge-dialog'))`)));
  check('the documents that were listed are untouched and still open',
    await q(`__vellum.app.views.every((v) => !v.annotations.dirty)`));
  check('the app reported no errors', (await q(`JSON.stringify(__vellum.errors)`)) === '[]', await q(`JSON.stringify(__vellum.errors)`));
}
