// In-app performance on one document — the generated 200-page file, or a real one named by
// VELLUM_PERF_PDF (copied first, never changed). Measured in the running app:
//   - opening the file for editing (pdf-lib), then for every page: analysis, pdf.js reading and the
//     cross-check (the same work as the Node baseline in tests/editing)
//   - composing the document (the rebuild's first step), with and without an edit
//   - the full rebuild after an edit: compose + pdf.js reload + the page drawn again (three pages)
//   - saving; closing and reopening until the first page is drawn
// The numbers are recorded, not judged (see docs/planning/VELLUM_0.5.0_AUDIT.md).
import fs from 'node:fs';
import path from 'node:path';

export const files = { perf: 'large' };
export const external = { perf: 'VELLUM_PERF_PDF' };
// Opening and analysing a large document can take minutes, in one request as in the whole suite.
export const timeoutMs = 900000;
export const requestTimeoutMs = 600000;

export async function run(t) {
  const { q, check, V, settled } = t;
  const FILE = t.file('perf');
  const round = (v) => Math.round(v * 10) / 10;
  if (!(await t.waitFor(settled(FILE), 180000))) throw new Error('the document didn’t open');
  await q(`__vellum.app.activate(${V(FILE)})`);
  await q(`${V(FILE)}.profile().catch(() => null)`); // known before the first change (no confirmation wait in the timings)
  await t.sleep(1500);
  const result = { file: path.basename(process.env.VELLUM_PERF_PDF || 'generated large.pdf') };

  result.analysis = await q(`(async () => {
    const v = ${V(FILE)};
    const { openSource } = await import('/js/editing/source.js');
    const { analyzePage, verifyPage } = await import('/js/editing/runs.js');
    const { loadPdfLib } = await import('/js/annotations/persist.js');
    const lib = await loadPdfLib();
    const bytes = await v.baseBytes();
    let t0 = performance.now();
    const source = await openSource(lib, bytes);
    const open = performance.now() - t0;
    let analyze = 0; let pdfjs = 0; let verify = 0; let runs = 0; let editable = 0; let slowest = 0;
    for (let i = 0; i < source.pageCount; i++) {
      t0 = performance.now();
      const a = analyzePage(source.page(i));
      const one = performance.now() - t0;
      analyze += one;
      slowest = Math.max(slowest, one);
      t0 = performance.now();
      const page = await v.pdf.getPage(i + 1);
      const [operatorList, textContent] = await Promise.all([
        page.getOperatorList({ annotationMode: v.pdfjsLib.AnnotationMode.DISABLE }), page.getTextContent(),
      ]);
      pdfjs += performance.now() - t0;
      t0 = performance.now();
      verifyPage(a, { operatorList, textContent, OPS: v.pdfjsLib.OPS });
      verify += performance.now() - t0;
      runs += a.runs.length;
      editable += a.runs.filter((r) => r.editable).length;
    }
    return { bytes: bytes.length, pages: source.pageCount, openMs: open, analyzeMs: analyze, pdfjsMs: pdfjs, verifyMs: verify, slowestPageAnalyzeMs: slowest, runs, editable };
  })()`);
  const a = result.analysis;
  check('analysis, pdf.js reading and the cross-check measured on every page', a?.pages > 0,
    a && `${a.pages} pages: open ${round(a.openMs)} ms; per page analyze ${round(a.analyzeMs / a.pages)} ms, pdf.js ${round(a.pdfjsMs / a.pages)} ms, verify ${round(a.verifyMs / a.pages)} ms; ${a.editable}/${a.runs} runs editable`);

  // Three pages spread through the document, each with a line to edit.
  const pages = [...new Set([0.25, 0.5, 0.75].map((f) => Math.max(1, Math.round(a.pages * f))))];
  const targets = [];
  for (const n of pages) {
    const found = await q(`(async () => {
      const p = await ${V(FILE)}.textEditing.page(${n});
      const r = p.runs.find((x) => x.run.editable && x.text.length > 8);
      return r ? { n: ${n}, key: r.run.key, text: r.text } : null;
    })()`);
    if (found) targets.push(found);
  }
  check('editable lines found for the rebuild measurements', targets.length > 0, JSON.stringify(targets.map((x) => x.n)));

  result.compose = await q(`(async () => {
    const v = ${V(FILE)};
    const { composeDocument } = await import('/js/annotations/persist.js');
    const base = await v.baseBytes();
    let t0 = performance.now();
    await composeDocument({ base, plan: v.annotations.plan, sources: v.sources, edits: [], clean: false });
    const plain = performance.now() - t0;
    return { plainMs: plain };
  })()`);

  result.rebuilds = [];
  for (const target of targets) {
    result.rebuilds.push(await q(`(async () => {
      const v = ${V(FILE)};
      v.goToPage(${target.n});
      await new Promise((r) => setTimeout(r, 800));
      const until = (f) => new Promise((resolve) => { const tick = () => (f() ? resolve() : requestAnimationFrame(tick)); tick(); });
      const t0 = performance.now();
      const swapped = new Promise((resolve) => v.addEventListener('documentchange', resolve, { once: true }));
      await v.textEditing.edit(${target.n}, ${JSON.stringify(target.key)}, ${JSON.stringify(`${target.text} (edited)`)});
      await swapped;
      const swappedMs = performance.now() - t0;
      await until(() => !v.rebuilding);
      await until(() => v.viewer.getPageView(${target.n} - 1)?.renderingState === 3);
      return { page: ${target.n}, composeAndSwapMs: swappedMs, redrawnMs: performance.now() - t0 };
    })()`));
  }
  check('rebuild after an edit measured (compose + reload + page drawn)', result.rebuilds.length > 0,
    result.rebuilds.map((r) => `p${r.page}: ${round(r.composeAndSwapMs)} / ${round(r.redrawnMs)} ms`).join('; '));

  result.composeWithEdits = await q(`(async () => {
    const v = ${V(FILE)};
    const { composeDocument } = await import('/js/annotations/persist.js');
    const base = await v.baseBytes();
    const t0 = performance.now();
    await composeDocument({ base, plan: v.annotations.plan, sources: v.sources, edits: v.annotations.edits, clean: false });
    return { ms: performance.now() - t0, edits: v.annotations.edits.length };
  })()`);

  result.save = await q(`(async () => {
    const v = ${V(FILE)};
    const t0 = performance.now();
    await v.saveTo(v.file);
    return { ms: performance.now() - t0 };
  })()`);
  check('saving measured', result.save?.ms > 0, `${round(result.save?.ms)} ms (compose with clean-up + write)`);

  result.reopen = await q(`(async () => {
    const path = ${JSON.stringify(FILE)};
    __vellum.app.close(${V(FILE)});
    await new Promise((r) => setTimeout(r, 800));
    const t0 = performance.now();
    await __vellum.actions.openRecent(path);
    const v = ${V(FILE)};
    const ready = performance.now() - t0;
    await v.firstRender;
    return { readyMs: ready, firstPageDrawnMs: performance.now() - t0 };
  })()`);
  check('closing and reopening measured (until the first page is drawn)', result.reopen?.firstPageDrawnMs > 0,
    `ready ${round(result.reopen?.readyMs)} ms, first page drawn ${round(result.reopen?.firstPageDrawnMs)} ms`);

  const errors = await q('__vellum.errors');
  check('no runtime errors', errors.length === 0, JSON.stringify(errors).slice(0, 300));
  fs.writeFileSync(path.join(t.dir, 'performance.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
}
