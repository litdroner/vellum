// Fill & Sign v1: in Edit mode, "Add signature…" opens the signature dialog (ui/signature.js). A typed
// and a drawn signature are placed on the page as pictures, one undo step each; one is moved, resized
// and turned; the file is saved, closed and reopened, and both signatures are read back from the page's
// own content where they were left. (Importing goes through the same Windows picture dialog as "Insert
// picture…", which the manipulation suite covers from insertPictureWith() on.)

export const files = { simple: 'simple' };

export async function run(t) {
  const { c, q, check, sleep, V, settled, waitFor, area } = t;
  const PATH = t.file('simple');
  const rest = async () => { await waitFor(settled(PATH), 25000); await sleep(400); };
  const records = () => q(`${V(PATH)}.annotations.edits.filter((e) => e.kind === 'inserted-image').map((e) => ({ id: e.id, transform: e.transform, format: e.picture.format }))`);
  const centreOf = (selector) => q(`(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2, r.width, r.height]; })()`);
  const button = (label) => q(`(() => { const b = [...document.querySelectorAll('.signature-dialog button')].find((x) => x.textContent === ${JSON.stringify(label)}); const r = b.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; })()`);
  const open = async () => {
    await q(`window.__signed = ${V(PATH)}.textEditor.addSignature(1).then((ok) => (window.__signedResult = ok)); window.__signedResult = undefined; true`);
    return waitFor(`Boolean(document.querySelector('.dialog-backdrop.open .signature-dialog'))`, 5000);
  };
  const place = async () => {
    const at = await button('Place signature');
    await c.mouse(at[0], at[1]);
    await waitFor('window.__signedResult !== undefined', 15000);
    await rest();
    return q('window.__signedResult');
  };

  area('signature');
  await q(`__vellum.app.activate(${V(PATH)})`);
  await rest();
  await q(`${V(PATH)}.setTool('edit')`);
  await sleep(500);

  check('the dialog opens', await open());
  await c.type('Ada Lovelace');
  await sleep(200);
  check('typing draws the name on the pad', await q(`(() => { const cv = document.querySelector('.signature-panel[data-panel="type"] canvas'); const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data; for (let i = 3; i < d.length; i += 4) if (d[i]) return true; return false; })()`));
  check('placing the typed signature succeeds', (await place()) === true, JSON.stringify(await q(`[...document.querySelectorAll('#toasts .toast')].map((x) => x.textContent)`)));
  let recs = await records();
  const typedKey = recs[0] ? `inserted:${recs[0].id}` : '';
  check('one picture record, a PNG, selected', recs.length === 1 && recs[0].format === 'png'
    && (await q(`${V(PATH)}.objectSelection.current?.keys[0]`)) === typedKey, JSON.stringify(recs));
  const w = Math.hypot(recs[0].transform[0], recs[0].transform[1]);
  check('it starts at signature size, not page size', w > 40 && w < 260, String(w));
  check('the dialog closed', !(await q(`Boolean(document.querySelector('.signature-dialog'))`)));
  const undoable = await q(`${V(PATH)}.annotations.canUndo`);
  await q(`${V(PATH)}.annotations.undo()`);
  await rest();
  check('one undo step removes it, and redo brings it back', undoable && (await records()).length === 0
    && (await q(`(${V(PATH)}.annotations.redo(), true)`)) && (await (async () => { await rest(); return (await records()).length === 1; })()));

  area('draw');
  check('the dialog opens again', await open());
  let at = await button('Draw');
  await c.mouse(at[0], at[1]);
  await sleep(200);
  const pad = await centreOf('.signature-panel[data-panel="draw"] canvas');
  await c.drag([pad[0] - pad[2] * 0.35, pad[1] + 10], [pad[0] - 40, pad[1] - 30], 10);
  await c.drag([pad[0] - 40, pad[1] - 30], [pad[0] + pad[2] * 0.3, pad[1] + 20], 10);
  check('placing the drawn signature succeeds', (await place()) === true);
  recs = await records();
  check('two signatures on the page', recs.length === 2, JSON.stringify(recs));

  area('move, resize, turn');
  const before = recs[0].transform;
  const cx = before[4] + (before[0] + before[2]) / 2;
  const cy = before[5] + (before[1] + before[3]) / 2;
  const k = 1.4 * Math.cos(Math.PI / 10);
  const s = 1.4 * Math.sin(Math.PI / 10);
  // About its centre: scaled ×1.4 and turned 18°, then moved 30 pt right and 60 pt down.
  const change = [k, s, -s, k, cx - k * cx + s * cy + 30, cy - s * cx - k * cy - 60];
  check('the typed signature is moved, resized and turned', await q(`${V(PATH)}.textEditing.transformObject(1, ${JSON.stringify(typedKey)}, ${JSON.stringify(change)})`));
  await rest();
  recs = await records();
  const left = Object.fromEntries(recs.map((r) => [r.id, r.transform]));
  check('still two records, the first turned', recs.length === 2 && Math.abs(recs[0].transform[1]) > 1, JSON.stringify(recs[0]));
  await t.shot('placed');

  area('save and reopen');
  await q('__vellum.actions.save()');
  check('saved', await waitFor(`!${V(PATH)}.annotations.dirty`, 25000));
  await q(`__vellum.app.close(${V(PATH)})`);
  await waitFor(`!${V(PATH)}`);
  await q(`__vellum.actions.openRecent(${JSON.stringify(PATH)})`);
  await rest();
  const drawn = await q(`(async () => (await ${V(PATH)}.textEditing.objects(1)).objects.filter((o) => o.kind === 'image').map((o) => o.record.ctm))()`);
  const near = (a, b) => a.every((v, i) => Math.abs(v - b[i]) < 0.01);
  check('reopened: both signatures are pictures in the page content, where they were left',
    drawn?.length === 2 && Object.values(left).every((tr) => drawn.some((d) => near(d, tr))), JSON.stringify({ drawn, left }));
  check('reopened clean', !(await q(`${V(PATH)}.annotations.dirty`)));
  await t.shot('reopened');

  check('no page errors were collected', (await q('__vellum.errors.length')) === 0, await q('JSON.stringify(__vellum.errors.slice(0, 3))'));
}
