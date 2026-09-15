// Vellum 0.5.0 Phase 3, Step 0: characterization baselines taken BEFORE anything can be moved,
// scaled, rotated, flipped or deleted. Nothing here tests a new feature. Every assertion records
// what the engine does today, so that the steps which follow have to prove what they changed:
//
//   Step 2  makes images writable     → §4 pins what the image handler may rely on
//   Step 3  transforms text           → §3 pins what an untransformed record still writes
//   Step 4  turns capabilities true   → §2 is the table that changes, cell by cell
//   Steps 5–6 add the interaction     → §1, §5 and §6 are the invariants it must not break
//
// A failure here means behaviour moved. If the move was intended, the expected value below is what
// gets updated, deliberately and in review — never the assertion.
// Run: node --test "tests/editing/*.test.mjs"

import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { analyzeFile, engine, loadPdfLib, webModule } from './harness.mjs';
import { makeFixtures, FIXTURE_DIR } from './fixtures.mjs';

const { openSource } = await engine('source.js');
const { planTextEdit } = await engine('edits.js');
const { multiply, invert, apply } = await engine('matrix.js');
const { objectsOf, objectByKey } = await engine('objects/page-objects.js');
const { capabilitiesFor, VERBS } = await engine('objects/capabilities.js');
const { selectableObjects } = await engine('objects/selection.js');
const { hitTest } = await engine('objects/geometry.js');
const { REASONS } = await engine('runs.js');
const { composeDocument } = await webModule('annotations/persist.js');
const { identityPlan, rotateEntries } = await webModule('pages/plan.js');

let files;
const cache = new Map();
before(async () => { files = await makeFixtures(FIXTURE_DIR); });
const read = (name) => new Uint8Array(fs.readFileSync(files[name]));

async function analyzed(name) {
  if (!cache.has(name)) cache.set(name, await analyzeFile(read(name)));
  return cache.get(name);
}

/** A document as the app would hold it: original bytes, verified analyses, an identity plan. */
async function open(bytes) {
  const result = await analyzeFile(bytes);
  return { bytes, result, plan: identityPlan(result.source.pageCount) };
}

function planEdit(d, page, fromText, toText) {
  const run = d.result.pages[page].runs.find((r) => r.text === fromText);
  assert.ok(run, `no run ${JSON.stringify(fromText)} on page ${page + 1}`);
  return planTextEdit({ run, text: toText, entry: d.plan[page].id, glyphs: d.result.source.glyphs });
}

const compose = (d, edits = [], extra = {}) => composeDocument({ base: d.bytes, plan: d.plan, edits, ...extra });

const round = (list, places = 4) => list.map((v) => Math.round(v * 10 ** places) / 10 ** places);
const bytesOf = (bytes, [start, end]) => Buffer.from(bytes.subarray(start, end)).toString('latin1');
const det = ([a, b, c, d]) => a * d - b * c;
const near = (a, b, tol = 1e-9) => Math.abs(a - b) <= tol;

/** One page's decoded content stream, as the writer leaves it. */
async function contentOf(bytes, pageIndex) {
  const lib = await loadPdfLib();
  const doc = await lib.PDFDocument.load(bytes, { updateMetadata: false });
  const source = await openSource(lib, bytes);
  return Buffer.from(source.contentBytes(doc.getPages()[pageIndex].node)).toString('latin1');
}

/** Every image drawn on a page, as the object model names it. */
const imageObjects = (analysis) => objectsOf(analysis).filter((o) => o.kind === 'image');

/** The middle of an object's axis-aligned box, for hit tests. */
const centreOf = (o) => [(o.geometry.box[0] + o.geometry.box[2]) / 2, (o.geometry.box[1] + o.geometry.box[3]) / 2];

// ---- 1. identity is computed from the ORIGINAL bytes, and only that makes it stable -------------
// Phase 3 keeps one record per object and resolves it by { page, key } on every draw and every
// compose. That is only sound because both sides read the ORIGINAL page: composing prepends `q` to
// the stream, which shifts every operator index by one. These tests pin both halves — the shift
// really happens, and it cannot reach the model — so a later step can never quietly start resolving
// a selection against composed output.

test('composing shifts every operator index by one, so identity read from composed output would move', async () => {
  const d = await open(read('images'));
  const before = imageObjects(d.result.pages[0]).map((o) => o.ref.opIndex);
  const saved = await compose(d, [planEdit(d, 0, 'Caption under the picture', 'Caption after the edit')]);
  const after = imageObjects((await analyzeFile(saved)).pages[0]).map((o) => o.ref.opIndex);
  assert.equal(before.length, 2, 'the fixture draws two images');
  assert.deepEqual(after, before.map((i) => i + 1), `every index is one higher: ${before} → ${after}`);
  assert.equal((await contentOf(saved, 0)).startsWith('q\n'), true, 'because the writer prepends one q');
});

test('the same key names the same draw before and after an edit, when read from the original', async () => {
  const d = await open(read('images'));
  const describe = (analysis) => imageObjects(analysis).map((o) => ({ key: o.ref.key, ctm: round(o.record.ctm), order: [...o.order] }));
  const first = describe(d.result.pages[0]);
  await compose(d, [planEdit(d, 0, 'Caption under the picture', 'Caption after the edit')]);
  // A fresh analysis of the same original bytes — what session.#analysis() works from all along.
  assert.deepEqual(describe((await analyzeFile(d.bytes)).pages[0]), first, 'having records changes nothing about the original page');
  assert.deepEqual(first.map((o) => o.ctm), [[200, 0, 0, 150, 72, 500], [100, 0, 0, 100, 400, 600]]);
});

test('an image survives a save and is still the same shape of object in the saved file', async () => {
  const d = await open(read('images'));
  const [image] = imageObjects((await analyzeFile(await compose(d, []))).pages[0]);
  assert.deepEqual(round(image.record.ctm), [200, 0, 0, 150, 72, 500], 'a save does not move it');
  assert.equal(image.record.stream, 'page', 'and does not push it inside a form');
  assert.equal(image.record.inline, false);
  assert.equal(image.record.name, 'Im1');
  assert.ok(Math.abs(det(image.record.ctm)) > 1, 'its CTM is still invertible');
});

test('an edited page composed twice from the same base is byte-identical, records and all', async () => {
  const d = await open(read('images'));
  const edit = planEdit(d, 0, 'Caption under the picture', 'Caption after the edit');
  const once = await compose(d, [edit]);
  const twice = await compose(d, [edit]);
  assert.deepEqual(Buffer.from(twice), Buffer.from(once), 'saving twice writes the same file');
});

// ---- 2. the verb matrix as it stands ------------------------------------------------------------
// Step 4 turned cells true, and this section is the record of exactly which. It was written at Step
// 0 with every cell refused; the expected values below were updated once, here, when the writers
// behind them existed. A `true` in this table is a promise the writer has already agreed to keep.

const MATRIX_FIXTURES = ['images', 'objects', 'constructs', 'cropbox', 'transparency', 'tagged', 'pdfa', 'scanned', 'overlap'];

/** The cells Step 4 turned true, and the only ones any fixture may report as true. */
const WRITABLE = new Set(['text-run.move', 'text-run.scale', 'text-run.editText', 'text-run.delete',
  'image.move', 'image.scale', 'image.stretch', 'image.rotate', 'image.delete']);

test('capability matrix: a verb is true only where a writer exists for that kind', async () => {
  const seen = new Map(); // `${kind}.${verb}` → the answers seen across every fixture
  for (const name of MATRIX_FIXTURES) {
    for (const analysis of (await analyzed(name)).pages) {
      for (const object of objectsOf(analysis)) {
        for (const verb of VERBS) {
          const answer = object.capabilities[verb];
          assert.ok(answer === true || Object.hasOwn(REASONS, answer), `${name} ${object.ref.key} ${verb} → ${answer}`);
          const cell = `${object.kind}.${verb}`;
          if (answer === true) assert.ok(WRITABLE.has(cell), `${name} ${object.ref.key}: ${cell} has no writer`);
          seen.set(cell, (seen.get(cell) ?? new Set()).add(answer));
        }
      }
    }
  }
  // Text is never rotated or stretched, an image is never text-edited, and a path or a form is never anything.
  for (const cell of ['text-run.rotate', 'text-run.stretch', 'image.editText',
    ...['path', 'form'].flatMap((k) => VERBS.map((v) => `${k}.${v}`))]) {
    const answers = [...(seen.get(cell) ?? [])];
    assert.ok(answers.length, `no object was examined for ${cell}`);
    assert.equal(answers.includes(true), false, `${cell} must not be writable: ${answers.join(', ')}`);
  }
  // Every writable cell is really exercised by the fixtures, so this is not passing by finding none.
  for (const cell of WRITABLE) {
    assert.ok([...(seen.get(cell) ?? [])].includes(true), `${cell} is never true in any fixture`);
  }
  // And the non-text kinds still only ever refuse in structural words, plus the image gate's two.
  const ALLOWED = ['unsupported', 'unreadable', 'structure', 'form', 'layer', 'soft-mask', 'clipped', 'degenerate'];
  for (const kind of ['image', 'path', 'form']) {
    for (const verb of VERBS) {
      for (const answer of seen.get(`${kind}.${verb}`) ?? []) {
        assert.ok(answer === true || ALLOWED.includes(answer), `${kind}.${verb} answered ${answer}`);
      }
    }
  }
});

test('capability matrix: the refusals Phase 3 must keep, named exactly, on the objects fixture', async () => {
  const images = imageObjects((await analyzed('objects')).pages[0]);
  assert.equal(images.length, 12, 'the fixture draws twelve images');
  const move = (i) => images[i].capabilities.move;
  // Indexes follow the fixture's own comments: 0 plain, 3 own soft mask, 4 clipped, 8 hidden layer,
  // 9 the image's own /OC, 10 inline, 11 inside a form.
  assert.equal(move(0), true, 'a plain image: nothing structural is wrong with it');
  assert.equal(move(3), true, 'an image with its OWN /SMask travels with its mask, so it is not refused');
  assert.equal(move(4), 'clipped', 'a clip that does not already contain it would crop it differently');
  assert.equal(move(8), 'layer', 'on a switched-off layer');
  assert.equal(move(9), 'layer', 'the image’s own /OC');
  assert.equal(move(10), true, 'an inline image is wrapped without its data being touched');
  assert.equal(move(11), 'form', 'drawn by a Form XObject');
  // The whole verb row moves together for an image, because one `cm` patch writes any of them.
  for (const i of [0, 3, 4, 8, 9, 10, 11]) {
    assert.deepEqual(['scale', 'stretch', 'rotate', 'delete'].map((v) => images[i].capabilities[v]),
      [move(i), move(i), move(i), move(i)], `image ${i}: the five verbs disagree`);
    assert.notEqual(images[i].capabilities.editText, true, `image ${i} claims text`);
  }
});

test('capability matrix: an unbalanced page refuses structurally, and PDF/A text moves', async () => {
  const strayQ = (await analyzed('constructs')).pages.find((p) => p.unbalanced);
  assert.ok(strayQ, 'the constructs fixture has a page with a stray Q');
  for (const object of objectsOf(strayQ)) {
    for (const verb of VERBS) assert.equal(object.capabilities[verb], 'structure', `${object.ref.key} ${verb}`);
  }
  const [run] = objectsOf((await analyzed('pdfa')).pages[0]).filter((o) => o.kind === 'text-run');
  assert.equal(run.capabilities.editText, true, 'PDF/A text in an embedded font is editable');
  assert.equal(run.capabilities.move, true, 'and movable: mode `original` redraws its own glyphs, embedding nothing');
  assert.equal(run.capabilities.rotate, 'unsupported', 'a rotation would need the glyphs laid out again');
});

// ---- 3. the untransformed text writer, on the cases Phase 3 will extend -------------------------
// phase1-baseline.test.mjs already freezes seven golden content streams for records without a
// transform, and those stay the contract (decision 8). These add the cases Phase 3 touches and
// Phase 1 did not: a rotated run, whose `cm` and `Tm` Step 3 must leave alone when there is no
// transform, and the proof that no record carries a transform today.

test('writer baseline: a rotated run redraws with its own CTM and text matrix, untransformed', async () => {
  const d = await open(read('constructs'));
  const content = await contentOf(await compose(d, [planEdit(d, 0, 'Rotated text', 'Turned text')]), 0);
  assert.match(content, /^1 0 0 1 0 0 cm$/m, 'the CTM is replayed as the identity it was');
  assert.match(content, /^0 1 -1 0 540 300 Tm$/m, 'the rotation lives in the text matrix, and is kept');
  assert.match(content, /^BT \/H 12 Tf 0 1 -1 0 540 300 Tm \[-\d+(\.\d+)?\] TJ ET$/m, 'the original glyphs are neutralised in place');
});

test('a text record today has no transform, and its fields are exactly the documented ones', async () => {
  const d = await open(read('simple'));
  const record = planEdit(d, 0, 'Hello, world', 'Hello, Vellum');
  assert.deepEqual(Object.keys(record).sort(), ['encoding', 'entry', 'id', 'kind', 'target', 'text']);
  assert.equal(Object.hasOwn(record, 'transform'), false, 'Step 3 adds this field; nothing writes it yet');
  assert.deepEqual(Object.keys(record.target).sort(), ['glyphs', 'key', 'text']);
  assert.equal(record.kind, 'text');
  assert.deepEqual(Object.keys(record.encoding).sort(), ['items', 'mode']);
  assert.equal(record.encoding.mode, 'font');
});

test('removing a run’s text is already the whole of delete-text: neutralise, draw nothing', async () => {
  const d = await open(read('simple'));
  const record = planEdit(d, 0, 'Third line.', '   ');
  assert.deepEqual(record.encoding, { mode: 'none' }, 'blank text is the removal mode');
  const content = await contentOf(await compose(d, [record]), 0);
  assert.equal(content.includes('(Third line.)'), false, 'the glyphs are gone from the page');
  assert.match(content, /^BT \/F1 12 Tf 72 640 Td \[-\d+(\.\d+)?\] TJ ET$/m, 'replaced by their exact advance');
  assert.equal(content.trimEnd().endsWith('Q'), true, 'and nothing is appended after the page');
});

// ---- 4. the image facts the Step 2 handler may rely on -----------------------------------------
// objects.test.mjs already pins CTMs, byte ranges, clips, layers and tags for the objects fixture.
// These pin the inputs to Phase 3's own gates, which nothing tests yet: the determinant, whether a
// clip really contains the image, how many draws share one resource name, and the conjugation.

test('every drawn image has an invertible CTM, or is exactly the degenerate case to refuse', async () => {
  for (const name of ['images', 'objects', 'overlap', 'scanned']) {
    for (const analysis of (await analyzed(name)).pages) {
      for (const image of imageObjects(analysis)) {
        const d = det(image.record.ctm);
        assert.ok(Number.isFinite(d), `${name} ${image.ref.key}: determinant is not finite`);
        assert.ok(Math.abs(d) > 1e-6, `${name} ${image.ref.key}: |det| = ${d}, which Step 4 would refuse as degenerate`);
        assert.ok(invert(image.record.ctm), `${name} ${image.ref.key}: CTM cannot be inverted`);
      }
    }
  }
});

test('the conjugation Step 2 will emit is exact for every real fixture CTM', async () => {
  // An image's unit square maps by C. Phase 3 wants it to map by C then T, and inserts `L cm`
  // before the operator, which makes the CTM multiply(L, C). So L = C·T·C⁻¹ — computed with today's
  // matrix.js and nothing else, which is why matrix.js needs no change.
  const transforms = [
    [1, 0, 0, 1, 25, -40], // move
    [1.5, 0, 0, 1.5, 0, 0], // scale about the origin
    [0, 1, -1, 0, 0, 0], // quarter turn
    [-1, 0, 0, 1, 0, 0], // reflection
    [1, 0, 0.3, 1, 5, 5], // a shear, to prove nothing here assumes orthogonality
  ];
  let checked = 0;
  for (const name of ['images', 'objects', 'overlap']) {
    for (const analysis of (await analyzed(name)).pages) {
      for (const image of imageObjects(analysis)) {
        const C = image.record.ctm;
        const inverse = invert(C);
        for (const T of transforms) {
          const L = multiply(multiply(C, T), inverse);
          const got = multiply(L, C);
          const want = multiply(C, T);
          for (let i = 0; i < 6; i++) {
            assert.ok(near(got[i], want[i], 1e-6), `${name} ${image.ref.key} T=${T}: element ${i}, ${got[i]} ≠ ${want[i]}`);
          }
          // And the corners land where transforming the object's own quad directly puts them.
          for (const [x, y] of [[0, 0], [1, 0], [1, 1], [0, 1]]) {
            const viaPatch = apply(got, x, y);
            const viaQuad = apply(T, ...apply(C, x, y));
            assert.ok(near(viaPatch[0], viaQuad[0], 1e-6) && near(viaPatch[1], viaQuad[1], 1e-6), `${name} ${image.ref.key}: corner ${x},${y}`);
          }
          checked++;
        }
      }
    }
  }
  assert.ok(checked >= 75, `only ${checked} conjugations were checked`);
});

test('a clip is recorded per image, and says which ones Step 4 must refuse as clipped', async () => {
  const images = imageObjects((await analyzed('objects')).pages[0]);
  const contains = (clipBox, [x1, y1, x2, y2]) => clipBox[0] <= x1 + 0.5 && clipBox[1] <= y1 + 0.5 && clipBox[2] >= x2 - 0.5 && clipBox[3] >= y2 - 0.5;
  const cut = images.filter((o) => o.record.clip && !contains(o.record.clip.box, o.record.box));
  // The fixture cuts exactly one image with a rectangle clip (its comment: "4 clipped"); the one
  // inside the form is clipped to the form's BBox, which does contain it.
  assert.deepEqual(cut.map((o) => images.indexOf(o)), [4], `clipped images: ${cut.map((o) => o.ref.key).join(', ')}`);
  assert.deepEqual(round(cut[0].record.clip.box), [200, 540, 260, 600]);
  assert.equal(images[0].record.clip, null, 'a plain image has no clip at all, so there is nothing to refuse');
  assert.ok(images[11].record.clip, 'an image inside a form is clipped to the form’s bounding box');
  assert.equal(contains(images[11].record.clip.box, images[11].record.box), true, 'and that clip contains it');
});

test('one resource name can serve many draws, which is why deletion must count them', async () => {
  for (const [name, expected] of [['images', { Im1: 2 }], ['overlap', { Im1: 4 }]]) {
    const counts = {};
    for (const image of imageObjects((await analyzed(name)).pages[0])) {
      if (image.record.inline) continue;
      counts[image.record.name] = (counts[image.record.name] ?? 0) + 1;
    }
    assert.deepEqual(counts, expected, `${name}: draws per resource name`);
  }
  // Every draw of one name shares one XObject, and each is still a separate object with its own key.
  const drawn = imageObjects((await analyzed('overlap')).pages[0]).filter((o) => o.record.name === 'Im1');
  assert.equal(new Set(drawn.map((o) => String(o.record.key))).size, 1, 'one resource');
  assert.equal(new Set(drawn.map((o) => o.ref.key)).size, 4, 'four objects');
});

test('a page’s resources are found, so Step 2 can tell its own from inherited before touching them', async () => {
  const lib = await loadPdfLib();
  for (const name of ['images', 'overlap', 'objects']) {
    const page = (await lib.PDFDocument.load(read(name), { updateMetadata: false })).getPages()[0];
    assert.ok(page.node.get(lib.PDFName.of('Resources')), `${name}: the fixture pages carry their own /Resources`);
    assert.ok(page.node.Resources(), `${name}: and the inherited lookup finds one`);
  }
});

test('an inline image is one operator whose range is the whole BI … EI block', async () => {
  const page = (await analyzed('objects')).pages[0];
  const inline = imageObjects(page).find((o) => o.record.inline);
  assert.ok(inline, 'the objects fixture draws an inline image');
  const block = bytesOf(page.bytes, inline.record.range);
  assert.ok(block.startsWith('BI') && block.endsWith('EI'), `deleting it means removing exactly this: ${JSON.stringify(block)}`);
  assert.equal(inline.record.name, null, 'it has no resource name to remove');
  assert.equal(inline.record.key, null);
});

// ---- 5. z-order through a real PDF, on the new overlap fixture ---------------------------------
// Phase 2 tested z-order over constructed quads and noted that no fixture drew two selectable
// objects over each other. This one does, so hit-testing is now exercised against real analysis
// output as well — which is what a manipulation gesture will start from.

test('the overlap fixture really overlaps: three pairs, each a genuine contest', async () => {
  const objects = selectableObjects((await analyzed('overlap')).pages[0]);
  assert.deepEqual(objects.map((o) => o.ref.key),
    ['image:page#2', 'run:0:0', 'run:1:0', 'image:page#16', 'image:page#20', 'image:page#24'],
    'four image draws and two runs, in drawing order');
  assert.deepEqual(objects.filter((o) => o.kind === 'text-run').map((o) => o.text), ['Over the picture', 'Under the picture']);
  // The overlaps are real: each pair's boxes intersect.
  const overlaps = (a, b) => a.geometry.box[0] < b.geometry.box[2] && b.geometry.box[0] < a.geometry.box[2]
    && a.geometry.box[1] < b.geometry.box[3] && b.geometry.box[1] < a.geometry.box[3];
  assert.equal(overlaps(objects[0], objects[1]), true, 'image under text');
  assert.equal(overlaps(objects[2], objects[3]), true, 'text under image');
  assert.equal(overlaps(objects[4], objects[5]), true, 'image under image');
  // The second image covers the run beneath it completely, so the run cannot be reached at all.
  const [tx1, ty1, tx2, ty2] = objects[2].geometry.box;
  const [ix1, iy1, ix2, iy2] = objects[3].geometry.box;
  assert.ok(ix1 <= tx1 && iy1 <= ty1 && ix2 >= tx2 && iy2 >= ty2, 'the image covers the text under it');
});

test('the topmost object wins on a real page, whichever kind it is', async () => {
  const objects = selectableObjects((await analyzed('overlap')).pages[0]);
  const pick = (x, y) => hitTest(objects, [x, y], 0);
  const [firstImage, overText, underText, secondImage, left, right] = objects;

  assert.equal(pick(...centreOf(overText)).ref.key, overText.ref.key, 'text drawn over an image wins');
  assert.equal(pick(172, 650).ref.key, firstImage.ref.key, 'the same image where no text covers it');
  assert.equal(pick(...centreOf(underText)).ref.key, secondImage.ref.key, 'an image drawn over text wins');
  assert.notEqual(pick(...centreOf(underText)).ref.key, underText.ref.key, 'the text underneath cannot be reached through it');
  // Two draws of one resource, overlapping in x 147–222: the later one wins where they share.
  assert.equal(pick(160, 350).ref.key, right.ref.key, 'the later of two draws of one image');
  assert.equal(pick(80, 350).ref.key, left.ref.key, 'the earlier one where only it is');
  assert.equal(pick(280, 350).ref.key, right.ref.key, 'and the later one where only it is');
  assert.notEqual(left.ref.key, right.ref.key, 'identity is the draw, not the resource');
});

test('everything the contest can pick on the overlap page is movable, so the winner matters', async () => {
  // Hit-testing is what a manipulation gesture starts from, so what it picks must be actionable.
  for (const object of selectableObjects((await analyzed('overlap')).pages[0])) {
    assert.equal(object.capabilities.move, true, `${object.ref.key} move`);
    assert.equal(object.capabilities.delete, true, `${object.ref.key} delete`);
    assert.equal(object.capabilities.rotate, object.kind === 'image' ? true : 'unsupported', `${object.ref.key} rotate`);
  }
});

// ---- 6. page operations and user space ---------------------------------------------------------
// Phase 3 promises an object survives page reorder, duplicate and rotate. That rests on Vellum's
// page rotation being a page-dictionary change and not a content change, so a transform in user
// space needs no adjustment for it. Pinned here before anything depends on it.

test('rotating a page through the plan leaves its content stream and its images exactly as they were', async () => {
  const d = await open(read('images'));
  const before = await contentOf(d.bytes, 0);
  const rotated = await composeDocument({ base: d.bytes, plan: rotateEntries(d.plan, new Set([d.plan[0].id]), 90), edits: [] });
  assert.equal(await contentOf(rotated, 0), before, 'the bytes of the page are untouched');

  const images = imageObjects((await analyzeFile(rotated)).pages[0]);
  assert.deepEqual(images.map((o) => o.ref.key), imageObjects(d.result.pages[0]).map((o) => o.ref.key), 'identity is unchanged');
  assert.deepEqual(images.map((o) => o.ref.key), ['image:page#2', 'image:page#11'], 'the operator indexes the original has');
  assert.deepEqual(round(images[0].record.ctm), [200, 0, 0, 150, 72, 500], 'and so is its place in user space');

  const lib = await loadPdfLib();
  const doc = await lib.PDFDocument.load(rotated, { updateMetadata: false });
  assert.equal(doc.getPages()[0].getRotation().angle, 90, 'the rotation is on the page, where it belongs');
});

test('a crop box that does not start at the origin does not shift anything in user space', async () => {
  const analysis = (await analyzed('cropbox')).pages[0];
  assert.deepEqual(round(analysis.box), [100, 100, 500, 692], 'the fixture’s crop box');
  const run = objectsOf(analysis).find((o) => o.text === 'Inside an offset crop box');
  assert.ok(run, 'the run is found');
  assert.deepEqual(round(run.record.origin), [120, 600], 'it sits at its user-space origin, uncorrected');
  assert.equal(objectByKey(analysis, run.ref.key)?.ref.key, run.ref.key, 'and is found again by its key');
});

test('every page of every fixture can be asked for its objects, and answers consistently', async () => {
  for (const name of MATRIX_FIXTURES) {
    for (const analysis of (await analyzed(name)).pages) {
      for (const object of objectsOf(analysis)) {
        assert.equal(Object.isFrozen(object), true, `${name} ${object.ref.key} is frozen`);
        assert.deepEqual(Object.keys(object.capabilities), VERBS, `${name} ${object.ref.key}`);
        assert.deepEqual(capabilitiesFor(analysis, object.kind, object.record, object.ref), object.capabilities,
          `${name} ${object.ref.key}: capabilities are worked out the same way twice`);
      }
    }
  }
});
