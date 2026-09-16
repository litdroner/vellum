// Vellum 0.6: one new text box formatted a word at a time (editing/objects/text-format.js spans,
// editing/objects/inserted-text.js planFormat with a range, editing/session.js formatText).
//
// Pinned here: a box holds where it reads differently as spans over its text, always in a normal form (a
// box that reads alike all through has none at all); a range is formatted in its own face, size, underline,
// colour and opacity while alignment and width stay the box's; lines of mixed sizes are laid out and
// wrapped piece by piece; retyping carries the formatting of what stayed and gives what was typed the
// format around it; the writer draws each piece as real text, setting the face, colour and state again
// only where they change, and underlines piece by piece; a character the chosen face hasn't got is
// refused with nothing changed; and saved, each piece is ordinary editable page text in its own font.
// Run: node --test "tests/editing/*.test.mjs"

import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { analyzeFile, engine, loadPdfLib, webModule, withSession } from './harness.mjs';
import { makeFixtures, FIXTURE_DIR } from './fixtures.mjs';

const { planNewText, planFormat, write } = await engine('objects/inserted-text.js');
const {
  applyChanges, formatRuns, layoutText, normalizeRuns, remapSpans, runRanges, standardFace, standardFaces, LINE_SPACING,
} = await engine('objects/text-format.js');
const { EditError } = await engine('edits.js');
const { composeDocument } = await webModule('annotations/persist.js');

let files;
before(async () => { files = await makeFixtures(FIXTURE_DIR); });
const read = (name) => new Uint8Array(fs.readFileSync(files[name]));

const UPRIGHT = [1, 0, 0, -1, 0, 0];
const LETTER = [0, 0, 612, 792];
const near = (a, b, tol = 1e-3) => Math.abs(a - b) <= tol;
const depth = (store) => {
  let n = 0;
  while (store.canUndo) { store.undo(); n++; }
  for (let i = 0; i < n; i++) store.redo();
  return n;
};

test('spans: the runs of a box, clamped when they don’t add up, and kept in a normal form', async () => {
  const lib = await loadPdfLib();
  const base = { font: 'Helvetica', size: 12, underline: false, align: 'left', color: '#000000', opacity: 1, width: null };

  const { runs } = formatRuns('Hello world', base, [{ n: 6 }, { n: 5, font: 'Times-Bold', color: '#ff0000' }]);
  assert.deepEqual(runs.map((r) => r.n), [6, 5]);
  assert.deepEqual(runRanges(runs).map((r) => [r.start, r.end, r.format.font]), [[0, 6, 'Helvetica'], [6, 11, 'Times-Bold']]);
  assert.equal(runs[1].format.align, 'left', 'a span never changes what belongs to the box');

  // Spans that don't cover the text are clamped rather than lost: a record from anywhere still reads.
  assert.deepEqual(formatRuns('Hello world', base, [{ n: 2, underline: true }]).runs.map((r) => r.n), [2, 9]);
  assert.deepEqual(formatRuns('Hello', base, [{ n: 99, underline: true }]).runs.map((r) => r.n), [5]);
  assert.deepEqual(formatRuns('Hello', base, null).runs.map((r) => r.n), [5], 'no spans: one run, the box’s own format');
  assert.equal(formatRuns('Hi', base, [{ n: 1, font: 'Arial' }]).bad, 'font', 'a span is checked like any format');
  assert.equal(formatRuns('Hi', base, [{ n: 1, align: 'right' }]).bad, 'spans', 'alignment is the box’s, never a span’s');
  assert.equal(formatRuns('Hi', base, [{ n: 1, size: 0 }]).bad, 'size');

  // Adjacent runs that read alike are one; the box's own format is what most of its characters read in.
  const same = normalizeRuns([{ n: 2, format: base }, { n: 3, format: { ...base } }]);
  assert.equal(same.spans, null, 'a box that reads alike all through has no spans');
  const mixed = normalizeRuns([{ n: 2, format: base }, { n: 3, format: { ...base, size: 20 } }, { n: 1, format: { ...base, size: 20 } }]);
  assert.deepEqual(mixed.spans, [{ n: 2, size: 12 }, { n: 4 }], 'the runs joined, what most of it reads in hoisted');
  assert.deepEqual([mixed.format.font, mixed.format.size], ['Helvetica', 20]);
  assert.ok(planNewText({ lib, text: 'Hello', transform: [1, 0, 0, 1, 0, 0], entry: 'e', spans: [{ n: 5 }] }).spans === undefined,
    'a record only holds spans when it needs them');
});

test('layout: pieces measured in their own face and size, the line spacing of the largest on the line', async () => {
  const lib = await loadPdfLib();
  const faces = standardFaces(lib);
  const helv = standardFace(lib, 'Helvetica');
  const times = standardFace(lib, 'Times-Bold');
  const text = 'Hello world';
  const spans = [{ n: 6 }, { n: 5, font: 'Times-Bold', size: 24 }];

  const laid = layoutText(faces, { text, size: 12, spans });
  assert.equal(laid.lines.length, 1);
  const [line] = laid.lines;
  assert.deepEqual(line.pieces.map((p) => p.text), ['Hello ', 'world']);
  assert.ok(near(line.pieces[0].advance, helv.advance('Hello ') * 12), 'the first piece in its own face and size');
  assert.ok(near(line.pieces[1].x, helv.advance('Hello ') * 12), 'the next piece starts where the one before ends');
  assert.ok(near(line.pieces[1].advance, times.advance('world') * 24));
  assert.ok(near(line.advance, helv.advance('Hello ') * 12 + times.advance('world') * 24), 'the line is its pieces added up');
  assert.ok(near(laid.box[3], times.ascent * 24), 'the box reaches the tallest ascent of its first line');
  assert.ok(near(laid.box[1], times.descent * 24), 'and the deepest descent of its last');

  // A line of mixed sizes sits one line spacing of its LARGEST size below the line above.
  const two = layoutText(faces, { text: 'a\nbc', size: 12, spans: [{ n: 2 }, { n: 2, size: 30 }] });
  assert.equal(two.lines[0].y, 0);
  assert.ok(near(two.lines[1].y, -LINE_SPACING * 30));

  // Wrapping measures each character in its own face and size, so bigger words take the room they need.
  const width = helv.advance('alpha beta') * 10 + 1;
  const small = layoutText(faces, { text: 'alpha beta gamma', size: 10, width });
  const big = layoutText(faces, { text: 'alpha beta gamma', size: 10, width, spans: [{ n: 6 }, { n: 10, size: 14 }] });
  assert.deepEqual(small.lines.map((l) => l.text), ['alpha beta', 'gamma']);
  assert.deepEqual(big.lines.map((l) => l.text), ['alpha', 'beta', 'gamma'], 'the bigger words no longer share a line');
  assert.deepEqual(big.lines[1].pieces.map((p) => p.format.size), [14]);

  // Alignment is the box's: a right-aligned line of mixed pieces still ends at the box's edge.
  const right = layoutText(faces, { text, size: 12, spans, align: 'right', width: 400 });
  assert.ok(near(right.lines[0].x + right.lines[0].advance, 400));
});

test('formatting a range: that stretch alone, with the box’s own alignment and width kept', async () => {
  const lib = await loadPdfLib();
  const base = { lib, text: 'Hello world', transform: [1, 0, 0, 1, 72, 700], entry: 'e' };
  const record = planNewText(base);
  assert.equal(record.spans, undefined);

  const part = planFormat({ lib, record, changes: { bold: true, color: '#ff0000' }, range: [6, 11] });
  assert.deepEqual(part.spans, [{ n: 6 }, { n: 5, font: 'Helvetica-Bold', color: '#ff0000' }]);
  assert.equal(part.font, 'Helvetica', 'the box’s own format is what it opens in');
  assert.equal(part.id, record.id, 'the same record, formatted');
  assert.ok(part.box[2] > record.box[2], 'the bold word is wider, so the box is');

  // Another family over a stretch that is already bold keeps that stretch's bold, and leaves the rest.
  const family = planFormat({ lib, record: part, changes: { family: 'Times' }, range: [6, 11] });
  assert.deepEqual(family.spans, [{ n: 6 }, { n: 5, font: 'Times-Bold', color: '#ff0000' }]);
  // Over the whole box, each stretch changes family in its own style.
  const all = planFormat({ lib, record: part, changes: { family: 'Courier' } });
  assert.deepEqual(all.spans, [{ n: 6 }, { n: 5, font: 'Courier-Bold', color: '#ff0000' }]);
  assert.equal(all.font, 'Courier');

  // Alignment and width belong to the box, however small the range.
  const boxed = planFormat({ lib, record: part, changes: { align: 'center', width: 200 }, range: [0, 1] });
  assert.deepEqual([boxed.align, boxed.width], ['center', 200]);
  assert.deepEqual(boxed.spans, part.spans, 'and nothing about the pieces changed');

  // Formatting a stretch back to what the box reads leaves a box with no spans at all.
  const plain = planFormat({ lib, record: part, changes: { bold: false, color: '#000000' }, range: [6, 11] });
  assert.equal(plain.spans, undefined);
  assert.deepEqual([plain.font, plain.color], [record.font, record.color]);

  // A character the chosen face hasn't got is refused for the stretch it was asked for, not substituted.
  const euro = planNewText({ ...base, text: 'Total €5' });
  assert.throws(() => planFormat({ lib, record: euro, changes: { size: 5000 }, range: [0, 5] }), (e) => e instanceof EditError && e.kind === 'content');
  assert.throws(() => planFormat({ lib, record, changes: { family: 'Garamond' }, range: [0, 5] }),
    (e) => e instanceof EditError && /can write new text in/.test(e.message));

  // The box's top-left corner stays put when a bigger size in the middle of it grows the box.
  const bigger = planFormat({ lib, record, changes: { size: 36 }, range: [0, 5] });
  const topLeft = (r) => [r.transform[4] + r.box[0], r.transform[5] + r.box[3]];
  assert.ok(topLeft(bigger).every((v, i) => near(v, topLeft(record)[i])));
});

test('retyping a formatted box: what stayed keeps its format, what was typed takes the format around it', async () => {
  const lib = await loadPdfLib();
  const spans = [{ n: 6 }, { n: 5, font: 'Helvetica-Bold' }];
  assert.deepEqual(remapSpans('Hello world', 'Hello worlds', spans), [{ n: 6 }, { n: 6, font: 'Helvetica-Bold' }],
    'typed inside the bold word, still bold');
  assert.deepEqual(remapSpans('Hello world', 'Hi world', spans), [{ n: 3 }, { n: 5, font: 'Helvetica-Bold' }]);
  assert.deepEqual(remapSpans('Hello world', 'Oh, Hello world', spans), [{ n: 10 }, { n: 5, font: 'Helvetica-Bold' }],
    'typed at the very start, it takes the format of what follows');
  assert.deepEqual(remapSpans('Hello world', 'Hello ', spans), [{ n: 6 }], 'the bold word deleted, the bold goes with it');
  assert.equal(remapSpans('Hello', 'Hello', null), null);

  const record = planNewText({ lib, text: 'Hello world', transform: [1, 0, 0, 1, 0, 0], entry: 'e', spans });
  const retyped = planNewText({ lib, ...record, text: 'Hello worlds', spans: remapSpans(record.text, 'Hello worlds', record.spans) });
  assert.deepEqual(retyped.spans, [{ n: 6 }, { n: 6, font: 'Helvetica-Bold' }]);

  // Typed and formatted in one step, as the open editor does it.
  const both = planFormat({ lib, record, changes: { underline: true }, range: [0, 5], text: 'Hello world!' });
  assert.equal(both.text, 'Hello world!');
  assert.deepEqual(both.spans, [{ n: 5, underline: true }, { n: 1 }, { n: 6, font: 'Helvetica-Bold' }]);
});

test('the writer draws each piece as real text, changing face, colour and state only where they do', async () => {
  const lib = await loadPdfLib();
  const doc = await lib.PDFDocument.create();
  const page = doc.addPage([612, 792]);
  const record = planNewText({
    lib,
    text: 'Hello world',
    transform: [1, 0, 0, 1, 72, 700],
    entry: 'e',
    spans: [{ n: 6 }, { n: 5, font: 'Times-Bold', size: 24, color: '#ff0000', opacity: 0.5, underline: true }],
  });
  const { patches, append } = write({ lib, doc, page, index: 0, records: [record] });
  assert.deepEqual(patches, []);
  const out = append[0];
  assert.match(out, /^q\n1 0 0 1 72 700 cm\nBT\n\/VlF1 12 Tf\n0 g\n0 Tc 0 Tw 100 Tz 0 Ts 0 Tr\n1 0 0 1 0 0 Tm\n/, 'it opens in its first piece’s format');
  assert.equal((out.match(/ Tm$/gm) ?? []).length, 1, 'one line, so one text position');
  assert.equal((out.match(/ Tj$/gm) ?? []).length, 2, 'a piece each');
  assert.match(out, /\/VlGS1 gs\n\/VlF2 24 Tf\n1 0 0 rg\n<[0-9a-f]+> Tj\nET/, 'the second piece sets what changed, in the text object');
  assert.equal((out.match(/ re f$/gm) ?? []).length, 1, 'only the underlined piece has a rule');
  assert.ok(!/^0 g$/m.test(out.split('ET')[1]), 'the rule is drawn in the piece’s own colour, already set');
  assert.equal((out.match(/Tf$/gm) ?? []).length, 2, 'the face is set again only where it changes');

  // Every piece is checked against its own face, and a record that doesn't say how all of it reads is refused.
  assert.throws(() => write({ lib, doc, page, index: 0, records: [{ ...record, spans: [{ n: 2 }] }] }), EditError, 'spans that don’t add up never reach the file');
  assert.throws(() => write({ lib, doc, page, index: 0, records: [{ ...record, spans: [{ n: 6 }, { n: 5, font: 'Arial' }] }] }), EditError);

  // A box that reads alike all through is written exactly as it always was.
  const plain = planNewText({ lib, text: 'One', transform: [1, 0, 0, 1, 72, 700], entry: 'e' });
  assert.match(write({ lib, doc, page, index: 0, records: [plain] }).append[0],
    /^q\n1 0 0 1 72 700 cm\nBT\n\/VlF\d 12 Tf\n0 g\n0 Tc 0 Tw 100 Tz 0 Ts 0 Tr\n1 0 0 1 0 0 Tm\n<4f6e65> Tj\nET\nQ$/);
});

test('a formatted word in a session: one undo step, kept through moving, copying and undo; saved as its own editable text', async () => {
  const bytes = read('crosspage');
  await withSession(bytes, async ({ store, session, sources, plan }) => {
    const key = await session.insertText(1, { basis: UPRIGHT, box: LETTER });
    assert.equal(await session.edit(1, key, 'Quarterly notes for the board'), true);
    assert.equal(await session.formatText(1, [key], { width: 200 }), true, 'the box wraps at a width');

    // "Quarterly" alone: its own face, size and colour; the rest of the box untouched.
    assert.equal(await session.formatText(1, [key], { family: 'Times', bold: true, size: 20, color: '#1f9e6b' }, { range: [0, 9] }), true);
    assert.equal(await session.formatText(1, [key], { family: 'Times', bold: true, size: 20, color: '#1f9e6b' }, { range: [0, 9] }), false,
      'the same format again changes nothing');
    const record = { ...store.edits[0] };
    assert.equal(store.edits.length, 1, 'still its one record');
    assert.deepEqual(record.spans, [{ n: 9, font: 'Times-Bold', size: 20, color: '#1f9e6b' }, { n: 20 }]);
    assert.deepEqual([record.font, record.size, record.color, record.width], ['Helvetica', 12, '#000000', 200]);
    assert.equal(depth(store), 4, 'add, retype, width, format');

    // The object model says how each stretch reads, for the editor and the format bar.
    const object = (await session.objects(1)).objects.find((o) => o.ref.key === key);
    assert.deepEqual(object.record.spans.map((s) => [s.start, s.end, s.format.family, s.format.bold]), [[0, 9, 'Times', true], [9, 29, 'Helvetica', false]]);
    assert.equal(object.record.format.family, 'Helvetica', 'the box’s own format is still the box’s');

    // Part of a box is formatted one box at a time.
    await assert.rejects(session.formatText(1, [key, key], { bold: true }, { range: [0, 2] }), (e) => e.kind === 'format');

    // Retyped in the editor, the formatted word keeps its format.
    assert.equal(await session.edit(1, key, 'Quarterly notes for the whole board'), true);
    assert.deepEqual(store.edits[0].spans[0], { n: 9, font: 'Times-Bold', size: 20, color: '#1f9e6b' });
    // Typed down to the formatted word alone, the box reads in that word's font, which is what it would be.
    assert.deepEqual(await session.preview(1, key, 'Quarterly'), { ok: true, mode: 'new', font: 'Times-Bold', missing: [] });

    // Typed and formatted in one step, as the open editor does it: still one record, one more undo step.
    const steps = depth(store);
    assert.equal(await session.formatText(1, [key], { underline: true }, { range: [10, 15], text: 'Quarterly notes for the whole board!' }), true);
    assert.equal(depth(store), steps + 1);
    assert.equal(store.edits[0].text, 'Quarterly notes for the whole board!');
    assert.deepEqual(store.edits[0].spans.map((s) => s.n), [9, 1, 5, 21]);

    // Moved, copied onto another page and pasted into another document, the pieces go with it.
    const spans = JSON.stringify(store.edits[0].spans);
    assert.equal(await session.transformObjects(1, [{ key, delta: [1, 0, 0, 1, 10, -30] }]), true);
    assert.equal(JSON.stringify(store.edits[0].spans), spans, 'moving keeps the formatting');
    const clip = await session.copyObjects(1, [key]);
    await session.pasteObjects(2, clip);
    assert.equal(JSON.stringify(store.edits.find((e) => e.id !== store.edits[0].id).spans), spans, 'pasted with it');
    await withSession(read('simple'), async ({ store: other, session: into }) => {
      await into.pasteObjects(1, clip);
      assert.equal(JSON.stringify(other.edits[0].spans), spans, 'into another document with it');
    });

    // Saved: the formatted word is ordinary page text in its own font, size and colour — nothing rasterized.
    const saved = await composeDocument({ base: bytes, plan, edits: store.edits, sources });
    const before = await analyzeFile(bytes);
    const after = await analyzeFile(saved);
    const word = after.pages[0].runs.find((r) => r.text.includes('Quarterly'));
    assert.ok(word, 'the formatted word is on the page');
    assert.equal(word.font.name, 'Times-Bold');
    assert.ok(near(word.frame.size, 20));
    assert.deepEqual(word.first.fill.color.args.map((v) => Math.round(v * 255)), [0x1f, 0x9e, 0x6b]);
    assert.ok(word.editable, [...word.reasons].join(', '));
    const rest = after.pages[0].runs.find((r) => r.font?.name === 'Helvetica' && /notes/.test(r.text));
    assert.ok(rest, 'the rest of the box is its own text in its own font');
    assert.ok(near(rest.frame.size, 12));
    assert.equal(after.pages[0].images.length, before.pages[0].images.length, 'nothing rasterized');

    // Reopened, each piece is text Vellum edits like any other.
    await withSession(saved, async ({ store: reopened, session: again }) => {
      const { runs } = await again.page(1);
      const item = runs.find((r) => r.run.text === word.text);
      assert.ok(item, 'the piece is a run of the reopened page');
      assert.equal(await again.edit(1, item.run.key, 'Annual'), true);
      assert.equal(reopened.edits.length, 1);
    });

    // Undone step by step, the box reads as it did before it was typed over and formatted.
    store.undo(); // the paste onto page 2
    store.undo(); // the move
    store.undo(); // the text and the underline, which were one step
    const back = store.edits.find((e) => e.id === record.id);
    assert.equal(back.text, 'Quarterly notes for the whole board');
    assert.deepEqual(back.spans.map((s) => s.n), [9, 26], 'and the word formatted before that is still formatted');
  });
});

test('applyChanges: a range of a box, and the box’s own fields, without a document', async () => {
  const base = { font: 'Helvetica', size: 12, underline: false, align: 'left', color: '#000000', opacity: 1, width: null };
  const one = applyChanges('abcdef', base, null, { underline: true }, [2, 4]);
  assert.deepEqual(one.spans, [{ n: 2 }, { n: 2, underline: true }, { n: 2 }]);
  assert.equal(one.format.underline, false, 'the box itself still reads as it did');

  const grown = applyChanges('abcdef', base, one.spans, { underline: true }, [0, 6]);
  assert.equal(grown.spans, null, 'underlined all through, the box simply reads underlined');
  assert.equal(grown.format.underline, true);

  const out = applyChanges('abcdef', base, null, { size: 20 }, [4, 99]);
  assert.deepEqual(out.spans, [{ n: 4 }, { n: 2, size: 20 }], 'a range past the end stops at the end');
  assert.equal(applyChanges('abcdef', base, null, { family: 'Nope' }, [0, 2]).bad, 'font');
  assert.equal(applyChanges('abcdef', base, null, { size: 0 }, [0, 2]).bad, 'size');
});
