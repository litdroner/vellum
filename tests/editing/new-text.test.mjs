// Vellum 0.6: new text put on a page in Edit mode (editing/objects/inserted-text.js, editing/session.js
// insertText, the page-objects.js insertedTextObject model).
//
// New text is a record of its own, drawn after the page in a standard PDF font under a new /Font name.
// Pinned here: the record and its refusals (characters the font doesn't have, a font that isn't a Latin
// standard font, mirrors and skews); one undo step each to add, retype, move, turn, copy and delete it; the
// saved file reads back as ordinary editable page text in that font, with the page's own text untouched and
// nothing rasterized; PDF/A documents refuse it; and a line of new text is never reflowed.
// Run: node --test "tests/editing/*.test.mjs"

import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { analyzeFile, engine, loadPdfLib, webModule, withSession } from './harness.mjs';
import { makeFixtures, FIXTURE_DIR } from './fixtures.mjs';

const { planNewText, defaultTextPlacement, write, precheck, FONTS } = await engine('objects/inserted-text.js');
const { EditError } = await engine('edits.js');
const { quarterTurn } = await engine('objects/transform.js');
const { quadCentre, transformQuad } = await engine('objects/geometry.js');
const { composeDocument } = await webModule('annotations/persist.js');

let files;
before(async () => { files = await makeFixtures(FIXTURE_DIR); });
const read = (name) => new Uint8Array(fs.readFileSync(files[name]));

/** How a Letter page is shown unrotated: user space to display axes, y down. */
const UPRIGHT = [1, 0, 0, -1, 0, 0];
const LETTER = [0, 0, 612, 792];
const near = (a, b, tol = 1e-3) => a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) <= tol);
const depth = (store) => {
  let n = 0;
  while (store.canUndo) { store.undo(); n++; }
  for (let i = 0; i < n; i++) store.redo();
  return n;
};

test('a new-text record: its text, a standard font, its extent and a placement; refusals in plain words', async () => {
  const lib = await loadPdfLib();
  const record = planNewText({ lib, text: 'Hello\tthere', transform: [1, 0, 0, 1, 72, 700], entry: 'e1' });
  assert.deepEqual(Object.keys(record).sort(), ['align', 'box', 'color', 'entry', 'font', 'id', 'kind', 'opacity', 'size', 'text', 'transform', 'underline', 'width']);
  assert.deepEqual([record.kind, record.text, record.font, record.size], ['inserted-text', 'Hello there', 'Helvetica', 12]);
  const helvetica = lib.StandardFontEmbedder.for('Helvetica');
  const advance = [...'Hello there'].reduce((sum, ch) => sum + helvetica.font.getWidthOfGlyph(helvetica.encodeTextAsGlyphs(ch)[0].name), 0) * 12 / 1000;
  assert.ok(Math.abs(record.box[2] - advance) < 1e-3, `advance ${record.box[2]} vs ${advance}`);
  assert.ok(record.box[1] < 0 && record.box[3] > 0, 'descent below the baseline, ascent above');
  assert.ok(FONTS.every((f) => !/Symbol|Zapf/.test(f)));

  const refused = (args, kind) => assert.throws(() => planNewText({ lib, transform: [1, 0, 0, 1, 0, 0], entry: 'e1', ...args }),
    (e) => e instanceof EditError && e.kind === kind, JSON.stringify(args));
  refused({ text: '   ' }, 'content');
  refused({ text: 'Namaste नमस्ते' }, 'characters');
  refused({ text: 'Hi', font: 'Symbol' }, 'not-editable');
  refused({ text: 'Hi', size: 0 }, 'content');
  refused({ text: 'Hi', transform: [-1, 0, 0, 1, 0, 0] }, 'not-editable');
  refused({ text: 'Hi', transform: [1, 0, 0.3, 1, 0, 0] }, 'not-editable');
  assert.equal(planNewText({ lib, text: 'Café – €5', transform: [1, 0, 0, 1, 0, 0], entry: 'e1' }).text, 'Café – €5', 'WinAnsi characters are written');

  // Centred and upright as shown, on an unrotated page and on one shown turned a quarter.
  const centred = defaultTextPlacement({ box: record.box, page: LETTER, basis: UPRIGHT });
  assert.deepEqual(centred.slice(0, 4), [1, 0, 0, 1]);
  assert.ok(near([centred[4] + record.box[2] / 2, centred[5] + (record.box[1] + record.box[3]) / 2], [306, 396]));
  const turned = defaultTextPlacement({ box: record.box, page: LETTER, basis: [0, 1, 1, 0, 0, 0] });
  assert.ok(turned[0] === turned[3] && turned[1] === -turned[2] && Math.abs(turned[1]) === 1, `${turned}`);
});

test('new text placed at a point (right-click): its shown top-left there, upright at every turn, kept on a cropped page', async () => {
  const lib = await loadPdfLib();
  const { box } = planNewText({ lib, text: 'New text', transform: [1, 0, 0, 1, 0, 0], entry: 'e1' });
  const boxQuad = [box[0], box[1], box[2], box[1], box[2], box[3], box[0], box[3]];
  const point = (basis, [x, y]) => transformQuad([x, y, x, y, x, y, x, y], basis).slice(0, 2);
  // The box's corners as shown (display axes, y down): its top-left, and whether it reads left to right.
  const shown = (transform, basis) => {
    const quad = transformQuad(transformQuad(boxQuad, transform), basis);
    const xs = [quad[0], quad[2], quad[4], quad[6]];
    const ys = [quad[1], quad[3], quad[5], quad[7]];
    return { topLeft: [Math.min(...xs), Math.min(...ys)], rightwards: quad[2] - quad[0] > 0 && Math.abs(quad[3] - quad[1]) < 1e-6 };
  };
  const turns = { 0: UPRIGHT, 90: [0, 1, 1, 0, 0, 0], 180: [-1, 0, 0, 1, 0, 0], 270: [0, -1, -1, 0, 0, 0] };
  for (const [turn, basis] of Object.entries(turns)) {
    const placed = defaultTextPlacement({ box, page: LETTER, basis, at: [200, 300] });
    const centred = defaultTextPlacement({ box, page: LETTER, basis });
    const { topLeft, rightwards } = shown(placed, basis);
    assert.ok(near(topLeft, point(basis, [200, 300])), `${turn}°: top-left ${topLeft} vs clicked ${point(basis, [200, 300])}`);
    assert.ok(rightwards, `${turn}°: reads left to right as shown`);
    assert.deepEqual(placed.slice(0, 4), centred.slice(0, 4), `${turn}°: the same size and turn as centred new text`);
  }
  // A crop box that doesn't start at the origin: a point inside it is kept; one by its far corner is moved
  // back so the whole box stays on the page.
  const crop = [50, 100, 562, 700];
  for (const [turn, basis] of Object.entries(turns)) {
    const inside = defaultTextPlacement({ box, page: crop, basis, at: [300, 400] });
    assert.ok(near(shown(inside, basis).topLeft, point(basis, [300, 400])), `${turn}°: inside the crop box it is where clicked`);
    for (const at of [[558, 104], [52, 698], [558, 698], [52, 104]]) {
      const q = transformQuad(boxQuad, defaultTextPlacement({ box, page: crop, basis, at }));
      const on = [0, 2, 4, 6].every((i) => q[i] >= crop[0] - 1e-3 && q[i] <= crop[2] + 1e-3 && q[i + 1] >= crop[1] - 1e-3 && q[i + 1] <= crop[3] + 1e-3);
      assert.ok(on, `${turn}° at ${at}: kept on the page: ${q}`);
    }
  }
});

test('the writer draws new text in its standard font after the page, and PDF/A refuses it', async () => {
  const lib = await loadPdfLib();
  const doc = await lib.PDFDocument.create();
  const page = doc.addPage([612, 792]);
  const records = [
    planNewText({ lib, text: 'One', transform: [1, 0, 0, 1, 72, 700], entry: 'e' }),
    planNewText({ lib, text: 'Two', font: 'Times-Roman', size: 20, transform: [0, 1, -1, 0, 300, 300], entry: 'e' }),
  ];
  const { patches, append } = write({ lib, doc, page, index: 0, records });
  assert.deepEqual(patches, []);
  assert.match(append[0], /^q\n1 0 0 1 72 700 cm\nBT\n\/VlF1 12 Tf\n0 g\n0 Tc 0 Tw 100 Tz 0 Ts 0 Tr\n1 0 0 1 0 0 Tm\n<4f6e65> Tj\nET\nQ$/);
  assert.match(append[1], /\/VlF2 20 Tf/);
  assert.throws(() => write({ lib, doc, page, index: 0, records: [{ ...records[0], transform: [-1, 0, 0, 1, 0, 0] }] }), EditError, 'a mirror never reaches the file');
  assert.throws(() => write({ lib, doc, page, index: 0, records: [{ ...records[0], text: 'नमस्ते' }] }), EditError, 'nor a character the font lacks');
  const pdfa = await lib.PDFDocument.load(read('pdfa'), { updateMetadata: false });
  assert.throws(() => precheck({ lib, doc: pdfa, records }), (e) => e.kind === 'pdfa');
});

test('new text in a session: added, retyped, turned and copied, one undo step each; saved as editable page text', async () => {
  const bytes = read('simple');
  await withSession(bytes, async ({ store, session, sources, plan }) => {
    const key = await session.insertText(1, { basis: UPRIGHT, box: LETTER });
    assert.match(key, /^text:/);
    assert.equal(store.edits.length, 1);
    let object = (await session.objects(1)).objects.find((o) => o.ref.key === key);
    assert.equal(object.text, 'New text');
    for (const verb of ['move', 'scale', 'rotate', 'delete', 'copy', 'editText']) assert.equal(object.capabilities[verb], true, verb);
    assert.notEqual(object.capabilities.stretch, true);
    assert.notEqual(object.capabilities.replace, true);

    assert.deepEqual(await session.preview(1, key, 'Added by Vellum'), { ok: true, mode: 'new', font: 'Helvetica', missing: [] });
    assert.equal((await session.preview(1, key, 'नमस्ते')).ok, false);
    assert.equal((await session.preview(1, key, '')).mode, 'none');
    assert.equal(await session.edit(1, key, 'Added by Vellum'), true);
    assert.equal(await session.edit(1, key, 'Added by Vellum'), false, 'the same text again changes nothing');
    await assert.rejects(session.edit(1, key, 'नमस्ते'), (e) => e.kind === 'characters');
    assert.deepEqual([store.edits.length, store.edits[0].text], [1, 'Added by Vellum']);

    object = (await session.objects(1)).objects.find((o) => o.ref.key === key);
    const centre = quadCentre(transformQuad(object.geometry.quad, store.edits[0].transform));
    assert.equal(await session.transformObjects(1, [{ key, delta: quarterTurn(centre, 1) }], { verb: 'rotate' }), true);
    assert.equal(store.edits.length, 1, 'still its one record');

    const [copy] = await session.pasteObjects(1, await session.copyObjects(1, [key]), [1, 0, 0, 1, 0, -40]);
    assert.match(copy, /^text:/);
    assert.equal(store.edits.length, 2);
    assert.equal(store.edits[1].text, 'Added by Vellum');
    await assert.rejects(session.reflowParagraph(1, [key, copy], 100), (e) => e.kind === 'reflow');
    assert.equal(depth(store), 4, 'add, retype, turn, paste');

    const saved = await composeDocument({ base: bytes, plan, edits: store.edits, sources });
    const before = (await analyzeFile(bytes)).pages[0];
    const after = (await analyzeFile(saved)).pages[0];
    const added = after.runs.filter((r) => r.text === 'Added by Vellum');
    assert.equal(added.length, 2, after.runs.map((r) => r.text).join(' | '));
    for (const run of added) {
      assert.equal(run.font.name, 'Helvetica');
      assert.ok(Math.abs(run.frame.size - 12) < 1e-3);
      assert.ok(near(run.frame.dir, [0, 1]), `turned: ${run.frame.dir}`);
      assert.ok(run.editable, [...run.reasons].join(', '));
    }
    for (const run of before.runs) assert.ok(after.runs.some((r) => r.text === run.text && near(r.origin, run.origin)), `kept: ${run.text}`);
    assert.equal(after.images.length, before.images.length, 'nothing rasterized');

    // Emptied, it goes; deleted, it goes; undo brings each back.
    assert.equal(await session.edit(1, copy, ''), true);
    assert.equal(store.edits.length, 1);
    await session.removeObjects(1, [key]);
    assert.deepEqual(store.edits, []);
    store.undo();
    store.undo();
    assert.equal(store.edits.length, 2);
  });
});

test('PDF/A documents are refused new text, with nothing stored', async () => {
  await withSession(read('pdfa'), async ({ store, session }) => {
    await assert.rejects(session.insertText(1, { basis: UPRIGHT, box: LETTER }), (e) => e.kind === 'pdfa');
    assert.deepEqual(store.edits, []);
  });
});
