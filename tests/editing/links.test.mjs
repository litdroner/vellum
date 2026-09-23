// Link editing V1: links created in Vellum, and the file's own links changed or removed, are written
// by composeDocument as standard /Link annotations and read back by pdf.js.
// Run: node --test tests/editing/links.test.mjs

import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { loadPdfLib, openWithPdfjs, webModule } from './harness.mjs';
import { makeFixtures, FIXTURE_DIR } from './fixtures.mjs';

const { composeDocument } = await webModule('annotations/persist.js');
const { existingLinkItem, hasDestination, linkLabel, linkUrl } = await webModule('links/links.js');
const { bounds, hitTest } = await webModule('annotations/geometry.js');
const { linkTargets } = await webModule('semantic/model.js');

let bytes;
before(async () => { bytes = new Uint8Array(fs.readFileSync((await makeFixtures(FIXTURE_DIR)).structure)); });

const link = (id, page, rect, extra) => ({ id, type: 'link', page, rect, url: null, target: null, ...extra });

/** Every /Link of a page as pdf.js reads it: its address, the page it goes to, and its rectangle. */
async function linksOf(saved, number = 1) {
  const js = await openWithPdfjs(saved);
  const page = await js.doc.getPage(number);
  const all = (await page.getAnnotations()).filter((a) => a.subtype === 'Link');
  const targets = await linkTargets(js.doc, all);
  const out = all.map((a) => ({
    url: a.url ?? a.unsafeUrl ?? null,
    target: targets.get(a.id) ?? null,
    rect: a.rect.map((v) => Math.round(v)),
    id: a.id,
  }));
  js.close();
  return out;
}

test('the fixture opens with the two links it was built with, and the source is untouched', async () => {
  const before = Buffer.from(bytes);
  const first = await linksOf(bytes, 1);
  assert.equal(first.length, 1);
  assert.equal(first[0].url, 'https://example.com/structure');
  const second = await linksOf(bytes, 2);
  assert.equal(second.length, 1);
  assert.equal(second[0].target, 1, 'the named destination resolves to page 1');
  assert.ok(before.equals(Buffer.from(bytes)), 'reading never changes the opened bytes');
});

test('a created URL link is saved as a real /Link and reopens with its address', async () => {
  const saved = await composeDocument({ base: bytes, annotations: [link('l1', 1, [72, 540, 240, 560], { url: 'https://example.com/new' })] });
  const links = await linksOf(saved);
  assert.equal(links.length, 2);
  const made = links.find((l) => l.url === 'https://example.com/new');
  assert.ok(made, 'the new link is there');
  assert.deepEqual(made.rect, [72, 540, 240, 560], 'written where it was drawn');
  assert.ok(links.some((l) => l.url === 'https://example.com/structure'), 'the file’s own link is still there');
});

test('a created internal link goes to the page it names', async () => {
  const saved = await composeDocument({ base: bytes, annotations: [link('l2', 1, [72, 500, 240, 520], { target: 2 })] });
  const made = (await linksOf(saved)).find((l) => l.target === 2);
  assert.ok(made, 'the link resolves to page 2');
  assert.equal(made.url, null, 'an internal link has no address');
});

test('one of the file’s own links is given a new address, moved, and reopens changed', async () => {
  const js = await openWithPdfjs(bytes);
  const data = (await (await js.doc.getPage(1)).getAnnotations()).find((a) => a.subtype === 'Link');
  js.close();
  const item = existingLinkItem(data, 1);
  assert.equal(item.url, 'https://example.com/structure');
  assert.deepEqual(item.existing.rect, [72, 615, 200, 632]);

  const changed = { ...item, id: 'e1', url: 'https://example.com/moved', rect: [80, 600, 300, 620] };
  const saved = await composeDocument({ base: bytes, annotations: [changed] });
  const links = await linksOf(saved);
  assert.equal(links.length, 1, 'changed, not duplicated');
  assert.equal(links[0].url, 'https://example.com/moved');
  assert.deepEqual(links[0].rect, [80, 600, 300, 620]);
});

test('one of the file’s own links is redirected to a page of the document', async () => {
  const js = await openWithPdfjs(bytes);
  const data = (await (await js.doc.getPage(1)).getAnnotations()).find((a) => a.subtype === 'Link');
  js.close();
  const changed = { ...existingLinkItem(data, 1), id: 'e2', url: null, target: 2 };
  const links = await linksOf(await composeDocument({ base: bytes, annotations: [changed] }));
  assert.equal(links.length, 1);
  assert.equal(links[0].url, null, 'the URI action is gone');
  assert.equal(links[0].target, 2);
});

test('one of the file’s own links is deleted; the rest of the page is left alone', async () => {
  const js = await openWithPdfjs(bytes);
  const data = (await (await js.doc.getPage(1)).getAnnotations()).find((a) => a.subtype === 'Link');
  js.close();
  const saved = await composeDocument({ base: bytes, annotations: [{ ...existingLinkItem(data, 1), id: 'e3', deleted: true }] });
  assert.deepEqual(await linksOf(saved), [], 'the link is gone');

  const after = await openWithPdfjs(saved);
  const page = await after.doc.getPage(1);
  const text = (await page.getTextContent()).items.map((i) => i.str).join('');
  const kinds = (await page.getAnnotations()).map((a) => a.subtype).sort();
  const fields = [...(await after.doc.getFieldObjects()).keys()];
  after.close();
  assert.ok(text.includes('Structure report'), 'the page’s text is untouched');
  assert.deepEqual(kinds, ['Text', 'Widget'], 'the note and the form field stay');
  assert.ok(fields.includes('reader.name'), 'the form is untouched');
});

test('a link survives save and reopen, and saving twice from the same file adds it once', async () => {
  const made = link('l3', 1, [72, 460, 240, 480], { url: 'https://example.com/again' });
  await composeDocument({ base: bytes, annotations: [made] });
  const once = await composeDocument({ base: bytes, annotations: [made] });
  assert.equal((await linksOf(once)).filter((l) => l.url === 'https://example.com/again').length, 1);
  // Reopening the saved file and saving it again keeps the link exactly once more.
  const twice = await composeDocument({ base: once, annotations: [] });
  assert.equal((await linksOf(twice)).filter((l) => l.url === 'https://example.com/again').length, 1);
});

test('a link follows its page when the pages are rearranged', async () => {
  const { PDFDocument } = await loadPdfLib();
  const count = (await PDFDocument.load(bytes)).getPageCount();
  assert.equal(count, 2);
  // Page 2 first: a link placed on the plan's page 1 lands on what was page 2.
  const plan = [{ id: 'b', src: 'base', index: 1, rotate: 0 }, { id: 'a', src: 'base', index: 0, rotate: 0 }];
  const saved = await composeDocument({ base: bytes, plan, annotations: [link('l4', 1, [72, 400, 240, 420], { target: 2 })] });
  const links = await linksOf(saved, 1);
  assert.ok(links.some((l) => l.target === 2), 'the internal link points at the plan’s page 2');
});

test('an address Vellum won’t open is refused, and no such link is written', async () => {
  for (const bad of ['javascript:alert(1)', 'file:///C:/Windows', 'data:text/html,<b>', '', '   ', 'vbscript:x']) {
    assert.equal(linkUrl(bad), null, `${bad} is refused`);
  }
  assert.equal(linkUrl('https://example.com/x'), 'https://example.com/x');
  assert.equal(linkUrl('example.com/x'), 'https://example.com/x', 'a bare host is taken as https');
  assert.equal(linkUrl('ada@example.com'), 'mailto:ada@example.com', 'a bare address is taken as mail');
  assert.equal(linkUrl('mailto:ada@example.com'), 'mailto:ada@example.com');

  const saved = await composeDocument({ base: bytes, annotations: [
    link('bad1', 1, [72, 300, 200, 320], { url: 'javascript:alert(1)' }),
    link('bad2', 1, [72, 260, 200, 280]), // placed, never given a destination
    link('bad3', 1, [72, 220, 200, 240], { target: 99 }), // no such page
  ] });
  assert.equal((await linksOf(saved)).length, 1, 'only the file’s own link is in the saved copy');
});

test('changing a link with no destination left is refused with a readable reason', async () => {
  const js = await openWithPdfjs(bytes);
  const data = (await (await js.doc.getPage(1)).getAnnotations()).find((a) => a.subtype === 'Link');
  js.close();
  const empty = { ...existingLinkItem(data, 1), id: 'e4', url: null, target: null };
  await assert.rejects(composeDocument({ base: bytes, annotations: [empty] }), /no destination/);
});

test('destinations, labels, bounds and hit testing for links', () => {
  assert.equal(hasDestination(link('a', 1, [0, 0, 1, 1], { url: 'https://example.com' })), true);
  assert.equal(hasDestination(link('b', 1, [0, 0, 1, 1], { target: 3 }), 2), false, 'past the last page');
  assert.equal(hasDestination(link('c', 1, [0, 0, 1, 1], { target: 2 }), 2), true);
  assert.equal(hasDestination(link('d', 1, [0, 0, 1, 1])), false);
  assert.equal(linkLabel(link('e', 1, [0, 0, 1, 1], { target: 4 })), 'Page 4');
  assert.equal(linkLabel(link('f', 1, [0, 0, 1, 1])), 'No destination');

  const one = link('g', 1, [10, 20, 110, 40], { url: 'https://example.com' });
  assert.deepEqual(bounds(one), [10, 20, 110, 40]);
  assert.equal(hitTest([one], [60, 30], 1)?.id, 'g');
  assert.equal(hitTest([one], [200, 30], 1), null);
  assert.equal(hitTest([{ ...one, deleted: true }], [60, 30], 1), null, 'a deleted link is not hit');
});
