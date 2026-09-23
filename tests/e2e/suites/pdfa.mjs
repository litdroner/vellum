// PDF/A in the real app: the More menu opens the dialog with the page choices and the document's own
// folder; converting writes a real PDF/A-2b file through the host (MainWindow.Export.cs,
// /export/{token}); a document that can't conform is refused with the reason and writes nothing; and
// the PDF itself is byte for byte unchanged.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// 'families' embeds its fonts, which PDF/A needs; 'multipage' uses Helvetica, which is never embedded.
export const files = { families: 'families', multipage: 'multipage' };

export async function run(t) {
  const { c, q, check, shot, settled, waitFor, sleep, area, V } = t;
  const DOC = t.file('families');
  const PLAIN = t.file('multipage');
  const folder = path.dirname(DOC);
  const output = path.join(folder, `${path.basename(DOC, '.pdf')} (PDF-A).pdf`);
  const hash = () => crypto.createHash('sha256').update(fs.readFileSync(DOC)).digest('hex');
  const original = hash();
  const J = (v) => JSON.stringify(v);
  const clickAt = async (expr) => {
    const [x, y] = await q(`(() => { const r = (${expr}).getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()`);
    await c.mouse(x, y);
  };
  const entry = `[...document.querySelectorAll('.menu-item')].find((b) => b.querySelector('.menu-label')?.textContent === 'Convert to PDF/A…')`;
  const button = (label) => `[...document.querySelectorAll('.optimize-dialog .dialog-actions .btn')].find((b) => b.textContent === ${J(label)})`;
  const openDialog = async () => {
    await clickAt(`__vellum.ui.toolbar.menuBtn`);
    await waitFor(`Boolean(${entry})`, 3000);
    await clickAt(entry);
    return waitFor(`Boolean(document.querySelector('.optimize-dialog'))`, 5000);
  };

  await waitFor(settled(DOC), 25000);
  await q(`__vellum.app.activate(${V(DOC)})`);
  await sleep(400);
  const errorsBefore = await q(`__vellum.errors?.length ?? 0`);

  area('the dialog');
  check('the More menu offers Convert to PDF/A…', await openDialog());
  check('the profile is named, not just “PDF/A”', await q(`document.querySelector('.optimize-dialog .dialog-message').textContent.includes('PDF/A-2b')`),
    await q(`document.querySelector('.optimize-dialog .dialog-message').textContent`));
  const pages = await q(`[...document.querySelectorAll('.optimize-dialog input[name="pdfa-pages"]')].map((i) => i.value).join(',')`);
  check('with the page choices the Export dialog uses', pages === 'all,current,range', pages);
  check('and the document’s own folder', await q(`document.querySelector('.optimize-dialog .export-folder-path').textContent === ${J(folder)}`));
  await shot('pdfa-dialog');
  await clickAt(button('Cancel'));
  check('Cancel writes nothing', await waitFor(`!document.querySelector('.optimize-dialog')`, 3000) && !fs.existsSync(output));

  area('converting');
  await openDialog();
  await clickAt(button('Convert'));
  check('the result is shown', await waitFor(`/Converted to PDF\\/A-2b/.test(document.querySelector('.optimize-dialog .dialog-title')?.textContent ?? '')`, 60000));
  const steps = await q(`[...document.querySelectorAll('.optimize-steps li')].map((l) => l.textContent.trim()).join(' | ')`);
  check('the output intent and the metadata are listed', /output intent/.test(steps) && /XMP metadata claiming PDF\/A-2b/.test(steps), steps);
  const note = await q(`document.querySelector('.optimize-dialog .dialog-note').textContent`);
  check('and what was checked, with what it is not', /Checked:/.test(note) && /not the whole of the standard/.test(note), note);
  await shot('pdfa-result');
  await clickAt(button('Close'));

  area('the file it wrote');
  check('the copy is on disk', fs.existsSync(output));
  const written = fs.readFileSync(output);
  check('it is a PDF', written.subarray(0, 5).toString('latin1') === '%PDF-', written.subarray(0, 8).toString('latin1'));
  const verdict = await q(`(async () => {`
    + ` const lib = await import('./js/annotations/persist.js').then((m) => m.loadPdfLib());`
    + ` const { validatePdfa } = await import('./js/optimize/pdfa-validate.js');`
    + ` const r = await validatePdfa(lib, Uint8Array.fromBase64(${J(written.toString('base64'))}));`
    + ` return JSON.stringify({ ok: r.ok, failures: r.failures, claim: r.claim }); })()`);
  const parsed = JSON.parse(verdict);
  check('and it passes Vellum’s PDF/A-2b check as written on disk', parsed.ok === true, verdict);
  check('claiming PDF/A-2B', parsed.claim?.part === 2 && parsed.claim?.conformance === 'B', verdict);

  area('a document that can’t conform');
  await waitFor(settled(PLAIN), 25000);
  await q(`__vellum.app.activate(${V(PLAIN)})`);
  await sleep(400);
  await openDialog();
  await clickAt(button('Convert'));
  check('it is refused, not written with a claim it can’t keep',
    await waitFor(`/Couldn’t convert to PDF\\/A-2b/.test(document.querySelector('.optimize-dialog .dialog-title')?.textContent ?? '')`, 60000));
  const reasons = await q(`[...document.querySelectorAll('.optimize-reasons li')].map((l) => l.textContent).join(' | ')`);
  check('and says which font is not embedded', /Helvetica/.test(reasons) && /not embedded/.test(reasons), reasons);
  await shot('pdfa-refused');
  await clickAt(button('Close'));
  check('nothing was written for it', !fs.existsSync(path.join(folder, `${path.basename(PLAIN, '.pdf')} (PDF-A).pdf`)));

  area('read-only');
  check('the file is byte for byte unchanged', hash() === original);
  const errors = await q(`JSON.stringify(__vellum.errors?.slice(${errorsBefore}) ?? [])`);
  check('no errors', errors === '[]', errors);
}
