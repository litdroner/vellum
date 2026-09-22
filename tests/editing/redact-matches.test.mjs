// Batch redaction from Find's own matches (editing/session.js findRedactableMatches,
// applyMatchRedactions): every verified occurrence of a query, in the page's own unedited text,
// redacted together as ONE undo step, through the same records and the same true-redaction engine
// "Redact selection" uses (objects/redaction.js) — nothing new there. Pinned here: several exact
// matches counted and redacted together; a match in text already edited this session is left alone
// and counted separately, never silently redacted; nothing is touched before applyMatchRedactions
// runs; the saved, reopened file proves the redacted words are gone and the rest is unmoved.
// Run: node --test "tests/editing/redact-matches.test.mjs"

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { loadPdfLib, openWithPdfjs, webModule, withSession } from './harness.mjs';
import { makeFixtures, FIXTURE_DIR } from './fixtures.mjs';

const { composeDocument } = await webModule('annotations/persist.js');

const files = await makeFixtures(FIXTURE_DIR);
const read = (name) => new Uint8Array(fs.readFileSync(files[name]));

/** Every page's text as pdf.js extracts it from the saved file. */
async function textOf(bytes) {
  const js = await openWithPdfjs(bytes);
  try {
    const pages = [];
    for (let n = 1; n <= js.doc.numPages; n++) {
      const { items } = await (await js.doc.getPage(n)).getTextContent();
      pages.push(items.map((i) => i.str).join(''));
    }
    return pages;
  } finally {
    await js.close();
  }
}

/** Every stream in the saved file, decoded as latin1: true redaction leaves no trace in any of them. */
async function streamTextOf(bytes) {
  const lib = await loadPdfLib();
  const doc = await lib.PDFDocument.load(bytes, { updateMetadata: false });
  let text = '';
  for (const [, obj] of doc.context.enumerateIndirectObjects()) {
    if (obj instanceof lib.PDFRawStream) text += Buffer.from(lib.decodePDFRawStream(obj).decode()).toString('latin1');
  }
  return text;
}

test('multiple exact matches: counted before anything changes, redacted as one undo step, gone once saved and reopened', async () => {
  const bytes = read('multipage');
  await withSession(bytes, async ({ plan, store, session, sources }) => {
    const { areas, matched, skipped, reasons } = await session.findRedactableMatches('five', { entireWord: true });
    assert.equal(matched, 5);
    assert.equal(skipped, 0);
    assert.deepEqual(reasons, []);
    assert.equal(areas.size, 5, 'one area per page');
    assert.equal(store.edits.length, 0, 'nothing is recorded until applyMatchRedactions runs');

    const before = await textOf(bytes);
    assert.ok(before.every((t) => /five/i.test(t)));

    const applied = await session.applyMatchRedactions(areas);
    assert.equal(applied, true);
    assert.equal(store.edits.length, 5, 'one redaction record per page');
    assert.ok(store.edits.every((e) => e.kind === 'redact'));

    store.undo();
    assert.equal(store.edits.length, 0, 'one undo takes every page’s redaction away together');
    assert.ok(!store.canUndo);
    store.redo();
    assert.equal(store.edits.length, 5);

    const saved = await composeDocument({ base: bytes, plan, edits: store.edits, sources });
    const after = await textOf(saved);
    assert.ok(after.every((t) => !/five/i.test(t)), JSON.stringify(after));
    assert.ok(after.every((t, i) => t.includes(`Page ${i + 1} of`)), 'the rest of each line keeps its place');
    const streamed = await streamTextOf(saved);
    assert.ok(!/five/i.test(streamed), 'no stream in the saved file still holds the word');
  });
});

test('a match in text already edited this session is refused, not silently redacted; the rest still is', async () => {
  const bytes = read('multipage');
  await withSession(bytes, async ({ plan, store, session, sources }) => {
    const { runs } = await session.page(1);
    const run = runs[0].run;
    await session.edit(1, run.key, 'Page one of five'); // retyped: page 1's original glyphs no longer prove a match

    const { areas, matched, skipped, reasons } = await session.findRedactableMatches('five', { entireWord: true });
    assert.equal(matched, 4, 'pages 2-5, whose text is unedited, are still verified');
    assert.equal(skipped, 1, 'the edited page’s match is left for “Redact selection” instead');
    assert.ok(reasons.some((r) => r.includes('already changed')), reasons.join(' '));
    assert.equal(areas.has(1), false, 'the edited page has no redaction area');

    await session.applyMatchRedactions(areas);
    assert.equal(store.edits.filter((e) => e.kind === 'redact').length, 4);

    const saved = await composeDocument({ base: bytes, plan, edits: store.edits, sources });
    const after = await textOf(saved);
    assert.ok(after[0].includes('five'), 'page 1 keeps its retyped text: it was skipped, not redacted');
    assert.ok(after.slice(1).every((t) => !/five/i.test(t)), JSON.stringify(after));
    const streamed = await streamTextOf(saved);
    assert.ok(!/Page 2 of five|Page 3 of five|Page 4 of five|Page 5 of five/i.test(streamed));
  });
});
