// Vellum 0.6: formatting text the PDF already draws (editing/objects/run-format.js, the text writer
// objects/text-run.js, session.formatText over page text).
//
// Pinned here: a run's size, colour, opacity and underline change with ONE record per run and ONE undo
// step per change; saved and reopened it is the same editable text — the same font object, the same glyph
// codes, nothing rasterized, the original not drawn as well — at the new size (a uniform scale about its
// baseline start), in the new DeviceRGB fill, through an opacity state of its own that keeps the original's
// other states, with an underline as wide as the glyphs drawn (Tc, Tw and Tz included); retyping keeps the
// format and a pasted copy carries it; a record that says nothing any more goes. Refused with nothing
// stored: a font, bold or italic; alignment or width; part of a line; colour or underline of outlined
// text; colour or opacity in a PDF/A file; a size out of range; mixing new text in; reflowing a formatted
// paragraph — and the writer refuses a format the planner would never have made.
// Run: node --test "tests/editing/*.test.mjs"

import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { analyzeFile, engine, loadPdfLib, webModule, withSession } from './harness.mjs';
import { makeFixtures, FIXTURE_DIR } from './fixtures.mjs';

const { runFormatOf, planRunFormat, runFormatRefusal } = await engine('objects/run-format.js');
const { composeDocument } = await webModule('annotations/persist.js');

let files;
before(async () => { files = await makeFixtures(FIXTURE_DIR); });
const read = (name) => new Uint8Array(fs.readFileSync(files[name]));

const depth = (store) => {
  let n = 0;
  while (store.canUndo) { store.undo(); n++; }
  for (let i = 0; i < n; i++) store.redo();
  return n;
};
const objectByText = async (session, page, text) => (await session.objects(page)).objects.find((o) => o.text === text);
const codesOf = (analysis, run) => run.glyphs.map(([s, g]) => analysis.shows[s].glyphs[g].code);

test('a run’s size, colour, opacity and underline: one step each, saved as the same editable text', async () => {
  const bytes = read('crosspage');
  await withSession(bytes, async ({ store, session, sources, plan }) => {
    const caption = await objectByText(session, 1, 'Plain caption');
    const key = caption.ref.key;
    assert.deepEqual({ ...runFormatOf(caption.record) }, { size: 12, color: '#000000', opacity: 1, underline: false, outlined: false });

    assert.equal(await session.formatText(1, [key], { size: 18 }), true);
    assert.equal(await session.formatText(1, [key], { color: '#CC0000' }), true);
    assert.equal(await session.formatText(1, [key], { opacity: 0.5 }), true);
    assert.equal(await session.formatText(1, [key], { underline: true }), true);
    assert.equal(await session.formatText(1, [key], { underline: true }), false, 'nothing changed: no step');
    assert.equal(store.edits.length, 1, 'one record for the run');
    assert.equal(depth(store), 4, 'one undo step per change');
    const [record] = store.edits;
    assert.deepEqual([record.kind, record.encoding.mode, record.text], ['text', 'original', 'Plain caption']);
    assert.deepEqual(record.format, { color: '#cc0000', opacity: 0.5, underline: true });
    assert.deepEqual(record.transform, [1.5, 0, 0, 1.5, -36, -220], 'a scale of 1.5 about the baseline start (72, 440)');
    const live = (await session.objects(1)).objects.find((o) => o.ref.key === key);
    assert.deepEqual({ ...runFormatOf(live.record, record) }, { size: 18, color: '#cc0000', opacity: 0.5, underline: true, outlined: false });

    const before = (await analyzeFile(bytes)).pages[0];
    const original = before.runs.find((r) => r.text === 'Plain caption');
    const saved = await composeDocument({ base: bytes, plan, edits: store.edits, sources });
    const after = (await analyzeFile(saved)).pages[0];
    const runs = after.runs.filter((r) => r.text === 'Plain caption');
    assert.equal(runs.length, 1, 'the original isn’t drawn as well');
    const [run] = runs;
    assert.ok(run.editable, 'still editable text after reopening');
    assert.ok(Math.abs(run.frame.size - 18) < 1e-3, `18 pt: ${run.frame.size}`);
    assert.deepEqual(run.origin.map((v) => Math.round(v * 1000) / 1000), original.origin, 'the baseline start stays put');
    assert.equal(run.font.key, original.font.key, 'the same font object');
    assert.deepEqual(codesOf(after, run), codesOf(before, original), 'the same glyph codes');
    assert.deepEqual([run.first.fill.color.op, run.first.fill.color.args], ['rg', [0.8, 0, 0]]);
    assert.equal(run.first.fill.space, null, 'a device colour');
    assert.equal(run.first.ca, 0.5);
    assert.equal(after.images.length, before.images.length, 'nothing rasterized');
    const rule = after.paths.find((p) => p.paint === 'fill' && p.box[1] < run.origin[1] && p.box[3] < run.origin[1] && p.box[3] > run.origin[1] - 18 * 0.2);
    assert.ok(rule, 'an underline under the baseline');
    assert.ok(Math.abs(rule.box[0] - run.origin[0]) < 1e-3 && Math.abs(rule.box[2] - run.end[0]) < 1e-2, `as wide as the glyphs: ${rule.box} vs ${run.origin}…${run.end}`);
    assert.ok(Math.abs((rule.box[3] - rule.box[1]) - 0.9) < 1e-3, 'a twentieth of an em thick');

    store.undo(); store.undo(); store.undo(); store.undo();
    assert.deepEqual(store.edits, [], 'undone to nothing');
  });
});

test('an opacity and a colour set back to the page’s own leave no record; the original’s colour space and states are kept otherwise', async () => {
  const bytes = read('crosspage');
  await withSession(bytes, async ({ store, session, sources, plan }) => {
    const tinted = await objectByText(session, 1, 'Tinted half text');
    const now = runFormatOf(tinted.record);
    assert.deepEqual([now.color, now.opacity], [null, 0.5], 'a calibrated colour isn’t shown as a device one');
    assert.equal(await session.formatText(1, [tinted.ref.key], { underline: true }), true);
    const saved = await composeDocument({ base: bytes, plan, edits: store.edits, sources });
    const run = (await analyzeFile(saved)).pages[0].runs.find((r) => r.text === 'Tinted half text');
    assert.equal(run.first.fill.space.args.length, 1, 'still its own colour space');
    assert.deepEqual(run.first.fill.color.args, [0.2, 0.4, 0.6]);
    assert.equal(run.first.ca, 0.5, 'and its own opacity');

    assert.equal(await session.formatText(1, [tinted.ref.key], { opacity: 0.8 }), true);
    assert.equal(await session.formatText(1, [tinted.ref.key], { opacity: 0.5, underline: false }), true);
    assert.deepEqual(store.edits, [], 'back to the page’s own: nothing to store');

    const caption = await objectByText(session, 1, 'Plain caption');
    assert.equal(await session.formatText(1, [caption.ref.key], { color: '#ff0000' }), true);
    assert.equal(await session.formatText(1, [caption.ref.key], { color: '#000000' }), true);
    assert.deepEqual(store.edits, []);
  });
});

test('several runs formatted as one step; retyped text keeps its format, measured in the widths it is drawn with', async () => {
  const bytes = read('constructs');
  await withSession(bytes, async ({ store, session, sources, plan }) => {
    const spaced = await objectByText(session, 1, 'Spaced and scaled words');
    const raised = await objectByText(session, 1, 'Raised');
    assert.equal(await session.formatText(1, [spaced.ref.key, raised.ref.key], { underline: true, size: 24 }), true);
    assert.equal(store.edits.length, 2);
    assert.equal(depth(store), 1, 'one undo step for both');

    let saved = await composeDocument({ base: bytes, plan, edits: store.edits, sources });
    let page = (await analyzeFile(saved)).pages[0];
    for (const text of ['Spaced and scaled words', 'Raised']) {
      const run = page.runs.find((r) => r.text === text);
      assert.ok(run?.editable && Math.abs(run.frame.size - 24) < 1e-2, `${text}: ${run?.frame.size}`);
      const rule = page.paths.find((p) => p.paint === 'fill' && Math.abs(p.box[0] - run.origin[0]) < 1e-2 && p.box[3] < run.origin[1] + 1e-6 && p.box[3] > run.origin[1] - 24 * 0.2 - (text === 'Raised' ? 0 : 0));
      assert.ok(rule && Math.abs(rule.box[2] - run.end[0]) < 2e-2, `${text}: the rule ends where the pen does (${rule?.box} vs ${run.end})`);
    }

    // Retyped in its own font: the record keeps its format, and the rule is as wide as the new text.
    assert.equal(await session.edit(1, spaced.record.key, 'Spaced words'), true);
    const retyped = store.edits.find((e) => e.target.key === spaced.record.key);
    assert.deepEqual([retyped.encoding.mode, retyped.format], ['font', { underline: true }]);
    assert.ok(retyped.transform, 'and its size');
    saved = await composeDocument({ base: bytes, plan, edits: store.edits, sources });
    page = (await analyzeFile(saved)).pages[0];
    const run = page.runs.find((r) => r.text === 'Spaced words');
    const rule = page.paths.find((p) => p.paint === 'fill' && Math.abs(p.box[0] - run.origin[0]) < 1e-2 && p.box[3] < run.origin[1]);
    assert.ok(rule && Math.abs(rule.box[2] - run.end[0]) < 2e-2, `${rule?.box} vs ${run.end}`);

    // Typed back to the file's own text, the format and the size stay: they aren't about the text.
    assert.equal(await session.edit(1, spaced.record.key, 'Spaced and scaled words'), true);
    const back = store.edits.find((e) => e.target.key === spaced.record.key);
    assert.deepEqual([back.encoding.mode, back.format], ['original', { underline: true }]);
  });
});

test('a pasted copy of formatted text carries its format, and is formatted on its own', async () => {
  const bytes = read('crosspage');
  await withSession(bytes, async ({ store, session, sources, plan }) => {
    const caption = await objectByText(session, 1, 'Plain caption');
    assert.equal(await session.formatText(1, [caption.ref.key], { color: '#0000ff' }), true);
    const [copyKey] = await session.pasteObjects(1, await session.copyObjects(1, [caption.ref.key]), [1, 0, 0, 1, 0, -60]);
    const copy = store.edits.find((e) => e.kind === 'text-copy');
    assert.deepEqual(copy.format, { color: '#0000ff' });
    assert.equal(await session.formatText(1, [copyKey], { underline: true, size: 6 }), true);
    const formatted = store.edits.find((e) => e.kind === 'text-copy');
    assert.deepEqual(formatted.format, { color: '#0000ff', underline: true });
    assert.equal(store.edits.find((e) => e.kind === 'text').format.underline, undefined, 'the original is untouched');

    const saved = await composeDocument({ base: bytes, plan, edits: store.edits, sources });
    const runs = (await analyzeFile(saved)).pages[0].runs.filter((r) => r.text === 'Plain caption');
    assert.equal(runs.length, 2);
    for (const run of runs) assert.deepEqual(run.first.fill.color.args, [0, 0, 1]);
    assert.ok(runs.some((r) => Math.abs(r.frame.size - 6) < 1e-2) && runs.some((r) => Math.abs(r.frame.size - 12) < 1e-2));
  });
});

test('refused with nothing stored: fonts, boxes, part of a line, outlines, PDF/A, bad sizes, new text, reflow', async () => {
  await withSession(read('constructs'), async ({ store, session }) => {
    const spaced = await objectByText(session, 1, 'Spaced and scaled words');
    const key = spaced.ref.key;
    const refused = async (keys, changes, reason, options) => {
      await assert.rejects(session.formatText(1, keys, changes, options), (err) => err.detail?.reason === reason, JSON.stringify(changes));
      assert.deepEqual(store.edits, [], `nothing stored for ${JSON.stringify(changes)}`);
    };
    await refused([key], { family: 'Times' }, 'font');
    await refused([key], { bold: true }, 'font');
    await refused([key], { italic: true }, 'font');
    await refused([key], { align: 'center' }, 'box');
    await refused([key], { width: 200 }, 'box');
    await refused([key], { color: '#ff0000' }, 'range', { range: [0, 6] });
    await refused([key], { size: 0.2 }, 'size');
    await refused([key], { size: 5000 }, 'size');
    await refused([key], { color: 'red' }, 'content');
    await refused([key], { opacity: 0 }, 'content');
    const outlined = await objectByText(session, 1, 'Outlined text');
    await refused([outlined.ref.key], { color: '#ff0000' }, 'outlined');
    await refused([outlined.ref.key], { underline: true }, 'outlined');
    await refused([key, outlined.ref.key], { underline: true }, 'outlined');
    assert.equal(await session.formatText(1, [outlined.ref.key], { opacity: 0.5 }), true, 'an outline’s opacity can change');
    store.undo();
    const skewed = (await session.objects(1)).objects.find((o) => o.text === 'Skewed text');
    await assert.rejects(session.formatText(1, [skewed.ref.key], { underline: true }), (err) => err.detail?.reason === 'skewed');

    const [newKey] = [await session.insertText(1, { basis: [1, 0, 0, -1, 0, 792], box: [0, 0, 612, 792] })];
    const before = store.edits.slice();
    await assert.rejects(session.formatText(1, [key, newKey], { underline: true }), (err) => err.kind === 'format');
    assert.deepEqual(store.edits, before);
  });

  await withSession(read('pdfa'), async ({ store, session }) => {
    const archived = await objectByText(session, 1, 'Archived text in an embedded font');
    for (const changes of [{ color: '#ff0000' }, { opacity: 0.5 }]) {
      await assert.rejects(session.formatText(1, [archived.ref.key], changes), (err) => err.kind === 'pdfa');
      assert.deepEqual(store.edits, []);
    }
    assert.equal(await session.formatText(1, [archived.ref.key], { underline: true, size: 20 }), true, 'an underline and a size are the file’s own font and colour');
  });

  await withSession(read('paragraphs'), async ({ store, session }) => {
    const { objects } = await session.objects(1);
    const lines = ['The first line of a plain paragraph that', 'runs on to a second line, then a third'].map((t) => objects.find((o) => o.text === t));
    assert.equal(await session.formatText(1, [lines[0].ref.key], { underline: true }), true);
    const kept = store.edits.slice();
    await assert.rejects(session.reflowParagraph(1, lines.map((o) => o.ref.key), 300), (err) => err.detail?.reason === 'formatted');
    assert.deepEqual(store.edits, kept);
  });
});

test('the writer refuses a format the planner would never make', async () => {
  const bytes = read('constructs');
  const lib = await loadPdfLib();
  const page = (await analyzeFile(bytes)).pages[0];
  const outlined = page.runs.find((r) => r.text === 'Outlined text');
  const spaced = page.runs.find((r) => r.text === 'Spaced and scaled words');
  assert.equal(runFormatRefusal(outlined, { color: '#ff0000' }), 'outlined');
  assert.equal(runFormatRefusal(spaced, { color: '#ff0000', font: 'Times-Roman' }), 'content');
  assert.equal(runFormatRefusal(spaced, { underline: false }), 'content', 'a record never holds a false underline');
  assert.equal(runFormatRefusal(spaced, { opacity: 0.5 }, { pdfa: true }), 'pdfa');
  assert.throws(() => planRunFormat({ run: spaced, changes: { size: 'big' } }), (err) => err.detail?.reason === 'size');
  const plan = [{ id: 'p1', src: 'base', index: 0 }];
  const target = (run) => ({ key: run.key, text: run.text, glyphs: run.glyphs });
  for (const [run, format] of [[outlined, { color: '#ff0000' }], [spaced, { color: '#ff0000', font: 'Times-Roman' }]]) {
    const edits = [{ id: 'e1', kind: 'text', entry: 'p1', target: target(run), text: run.text, encoding: { mode: 'original' }, format }];
    await assert.rejects(composeDocument({ base: bytes, plan, edits, sources: new Map() }), (err) => err.kind === 'content', JSON.stringify(format));
  }
  assert.ok(lib);
});
