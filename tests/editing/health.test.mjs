// PDF Health V1 (health/health.js): the findings are the engine's own signals, read back — the document
// profile, pdf.js's document info and the session's verified page analysis — and nothing else.
// Run: node --test "tests/editing/health.test.mjs"

import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { engine, loadPdfLib, openWithPdfjs, webModule, withSession } from './harness.mjs';
import { makeFixtures, FIXTURE_DIR } from './fixtures.mjs';

const { checkDocument, documentFindings, mergeFindings, pageFindings } = await webModule('health/health.js');
const { REASONS, FORM_BLOCKERS, PAGE_KINDS } = await engine('runs.js');
const { inspectDocument } = await engine('source.js');

let files;
const read = (name) => new Uint8Array(fs.readFileSync(files[name]));
before(async () => { files = await makeFixtures(FIXTURE_DIR); });

/** checkDocument over a document the way the app has it open: a session, its pdf.js document and profile. */
async function check(bytes) {
  return withSession(bytes, async ({ session }) => {
    const js = await openWithPdfjs(bytes);
    try {
      const view = { encrypted: false, pdf: js.doc, textEditing: session, profile: async () => inspectDocument(await loadPdfLib(), bytes) };
      return await checkDocument(view);
    } finally {
      await js.close();
    }
  });
}

/** A one-page PDF with the given content stream, and anything else `extra` adds to it. */
async function onePage(content, extra = () => {}) {
  const lib = await loadPdfLib();
  const doc = await lib.PDFDocument.create({ updateMetadata: false });
  const page = doc.addPage([300, 300]);
  const font = doc.embedStandardFont(lib.StandardFonts.Helvetica).ref;
  page.node.set(lib.PDFName.of('Contents'), doc.context.register(doc.context.flateStream(content)));
  page.node.set(lib.PDFName.of('Resources'), doc.context.obj({ Font: { F1: font } }));
  extra(doc, lib);
  return doc.save({ useObjectStreams: false });
}

const ids = (report) => report.findings.map((f) => f.id);

test('an ordinary PDF: every page checked, nothing found', async () => {
  const report = await check(read('multipage'));
  assert.equal(report.complete, true);
  assert.equal(report.pagesChecked, report.pageCount);
  assert.ok(report.pageCount > 1);
  assert.deepEqual(report.findings, []);
});

test('a protected PDF: refused as a whole, its pages not read', async () => {
  const bytes = read('encrypted-structure');
  const js = await openWithPdfjs(bytes, { password: 'secret' });
  try {
    const textEditing = { objects: () => assert.fail('a protected PDF has no page analysis') };
    const view = { encrypted: true, pdf: js.doc, textEditing, profile: async () => inspectDocument(await loadPdfLib(), bytes) };
    const report = await checkDocument(view);
    assert.equal(report.complete, false);
    assert.equal(report.pagesChecked, 0);
    assert.deepEqual(ids(report), ['protected']);
    const [f] = report.findings;
    assert.equal(f.severity, 'refused');
    assert.equal(f.category, 'protection');
    assert.deepEqual(f.pages, []);
    assert.ok(f.details.some((d) => /Standard/.test(d)), 'names the security handler pdf.js reports');
  } finally {
    await js.close();
  }
});

test('an XFA form: reported from pdf.js’s own IsXFAPresent, alongside the AcroForm it falls back to', async () => {
  const bytes = await onePage('BT /F1 12 Tf 20 250 Td (Form) Tj ET', (doc, lib) => {
    const xfa = doc.context.register(doc.context.flateStream('<xdp:xdp xmlns:xdp="http://ns.adobe.com/xdp/"></xdp:xdp>'));
    doc.catalog.set(lib.PDFName.of('AcroForm'), doc.context.obj({ Fields: [], XFA: xfa }));
  });
  const report = await check(bytes);
  assert.deepEqual(ids(report), ['xfa']);
  assert.equal(report.findings[0].severity, 'limited');
  assert.equal(report.findings[0].category, 'forms');
});

test('Form XObject text: the refusal in the engine’s words, with each form’s blockers', async () => {
  const report = await check(read('form-xobjects'));
  const form = report.findings.find((f) => f.id === 'text:form');
  assert.ok(form, 'text drawn inside forms is reported');
  assert.equal(form.severity, 'limited');
  assert.equal(form.category, 'form-xobject');
  assert.equal(form.message, REASONS.form);
  assert.deepEqual(form.pages, [1]);
  assert.ok(form.count > 0);
  const blockers = new Set(Object.values(FORM_BLOCKERS));
  assert.ok(form.details.some((d) => blockers.has(d)), 'names what stands in the way inside a form');
  // Every text finding is a reason the engine already gives, never a new one.
  for (const f of report.findings.filter((x) => x.id.startsWith('text:'))) assert.equal(f.message, REASONS[f.id.slice(5)]);
});

test('an unbalanced page: refused for its structure, as the writer refuses it', async () => {
  const report = await check(await onePage('Q BT /F1 12 Tf 20 250 Td (Hello) Tj ET'));
  const f = report.findings.find((x) => x.id === 'page:structure');
  assert.ok(f, ids(report).join(', '));
  assert.equal(f.severity, 'refused');
  assert.equal(f.message, REASONS.structure);
  assert.deepEqual(f.pages, [1]);
  assert.equal(report.findings[0].severity, 'refused', 'refusals come first');
});

test('document facts come from the profile as read, and nothing is inferred', async () => {
  assert.deepEqual(documentFindings({}), []);
  assert.deepEqual(documentFindings({ profile: { signed: false, certified: false, tagged: false, pdfa: null }, info: { IsXFAPresent: false } }), []);
  const tagged = await inspectDocument(await loadPdfLib(), read('tagged'));
  assert.deepEqual(documentFindings({ profile: tagged }).map((f) => [f.id, f.severity]), [['tagged', 'info']]);
  const pdfa = await inspectDocument(await loadPdfLib(), read('pdfa'));
  assert.ok(documentFindings({ profile: pdfa }).some((f) => f.id === 'pdfa' && /PDF\/A-\d/.test(f.message)));
  const signed = documentFindings({ profile: { signed: true, certified: true } });
  assert.deepEqual(signed.map((f) => [f.id, f.severity, f.details.length]), [['signed', 'limited', 1]]);
});

test('page findings: an unreadable page is only what the analysis says; findings merge across pages', () => {
  const unreadable = { summary: { kind: 'unreadable' }, tainted: true, issues: [{ kind: 'unreadable', message: 'bad stream' }], runs: [], forms: [] };
  const [f] = pageFindings(3, unreadable);
  assert.deepEqual([f.id, f.severity, f.message, f.details], ['page:unreadable', 'refused', PAGE_KINDS.unreadable, ['bad stream']]);
  assert.deepEqual(pageFindings(1, null), []);
  const run = (reasons) => ({ editable: false, reasons: new Set(reasons) });
  const page = (n) => pageFindings(n, { summary: { kind: 'text' }, runs: [run(['type3', 'unverified']), run(['blank']), { editable: true, reasons: new Set() }], forms: [] });
  const merged = mergeFindings([...page(4), ...page(2), f]);
  assert.deepEqual(merged.map((x) => [x.id, x.pages, x.count]), [['page:unreadable', [3], null], ['text:type3', [2, 4], 2]]);
});
