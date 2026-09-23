// Compress PDF in the real app: the More menu opens the dialog with the two optimization levels and the
// document's own folder; compressing writes a real smaller file through the host (MainWindow.Export.cs,
// /export/{token}); the result says what each step did; and the PDF itself is byte for byte unchanged.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const files = { structure: 'structure' };

export async function run(t) {
  const { c, q, check, shot, settled, waitFor, area } = t;
  const DOC = t.file('structure');
  const folder = path.dirname(DOC);
  const base = path.basename(DOC, '.pdf');
  const output = path.join(folder, `${base} (compressed).pdf`);
  const hash = () => crypto.createHash('sha256').update(fs.readFileSync(DOC)).digest('hex');
  const original = hash();
  const J = (v) => JSON.stringify(v);
  const clickAt = async (expr) => {
    const [x, y] = await q(`(() => { const r = (${expr}).getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()`);
    await c.mouse(x, y);
  };
  const button = (label) => `[...document.querySelectorAll('.optimize-dialog .dialog-actions .btn')].find((b) => b.textContent === ${J(label)})`;

  await waitFor(settled(DOC), 25000);
  const errorsBefore = await q(`__vellum.errors?.length ?? 0`);

  area('the dialog');
  await clickAt(`__vellum.ui.toolbar.menuBtn`);
  const entry = `[...document.querySelectorAll('.menu-item')].find((b) => b.querySelector('.menu-label')?.textContent === 'Compress PDF…')`;
  check('the More menu offers Compress PDF…', await waitFor(`Boolean(${entry})`, 3000));
  await clickAt(entry);
  check('the dialog opens', await waitFor(`Boolean(document.querySelector('.optimize-dialog'))`, 5000));
  const levels = await q(`[...document.querySelectorAll('.optimize-dialog input[name="compress-level"]')].map((i) => i.value).join(',')`);
  check('with the two levels Vellum has', levels === 'safe,smaller', levels);
  check('“Smaller file” chosen to start with', await q(`document.querySelector('.optimize-dialog input[name="compress-level"]:checked').value === 'smaller'`));
  check('and the document’s own folder', await q(`document.querySelector('.optimize-dialog .export-folder-path').textContent === ${J(folder)}`));
  check('the name the copy will have', await q(`document.querySelector('.optimize-filename strong').textContent === ${J(`${base} (compressed).pdf`)}`));
  await shot('compress-dialog');

  area('cancel');
  await clickAt(button('Cancel'));
  check('Cancel writes nothing', await waitFor(`!document.querySelector('.optimize-dialog')`, 3000) && !fs.existsSync(output));

  area('compressing');
  await clickAt(`__vellum.ui.toolbar.menuBtn`);
  await waitFor(`Boolean(${entry})`, 3000);
  await clickAt(entry);
  await waitFor(`Boolean(document.querySelector('.optimize-dialog'))`, 5000);
  await clickAt(button('Compress'));
  check('the result is shown', await waitFor(`/Compressed/.test(document.querySelector('.optimize-dialog .dialog-title')?.textContent ?? '')`, 30000));
  const message = await q(`document.querySelector('.optimize-dialog .dialog-message').textContent`);
  check('with the sizes before and after', /→/.test(message) || /already as small/.test(message), message);
  const steps = await q(`[...document.querySelectorAll('.optimize-steps li')].map((l) => l.textContent.trim()).join(' | ')`);
  check('and what each step did', steps.includes('Unused objects removed') && steps.includes('Streams compressed'), steps);
  await shot('compress-result');
  await clickAt(button('Close'));

  area('the file it wrote');
  check('the copy is on disk', fs.existsSync(output));
  const written = fs.readFileSync(output);
  check('it is a PDF', written.subarray(0, 5).toString('latin1') === '%PDF-', written.subarray(0, 8).toString('latin1'));
  check('and it is smaller than the document', written.length < fs.statSync(DOC).size, `${written.length} vs ${fs.statSync(DOC).size}`);
  const pages = await q(`(async () => { const t = __vellum.app.active.pdfjsLib.getDocument({ data: Uint8Array.fromBase64(${J(written.toString('base64'))}) }); const d = await t.promise; const n = d.numPages; await t.destroy(); return n; })()`);
  check('it reopens with the same pages', pages === await q(`__vellum.app.active.pdf.numPages`), String(pages));

  area('read-only');
  check('the document is not marked changed', await q(`!__vellum.app.active.annotations.dirty`));
  check('the file is byte for byte unchanged', hash() === original);
  const errors = await q(`JSON.stringify(__vellum.errors?.slice(${errorsBefore}) ?? [])`);
  check('no errors', errors === '[]', errors);
}
