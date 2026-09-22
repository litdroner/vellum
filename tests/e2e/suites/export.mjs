// Export Center V1 in the real app: the Export command opens the dialog from the More menu; an export to the
// document's own folder writes real files through the host (MainWindow.Export.cs, /export/{token}) — JPEG and
// PNG one per page, Markdown one file, and an Excel workbook of the tables Vellum is confident about — with
// the names the plan gives; a second export of the same pages
// keeps both instead of overwriting when asked; and the PDF itself is byte for byte unchanged throughout.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const files = { structure: 'structure' };

export async function run(t) {
  const { c, q, check, shot, settled, waitFor, area, V } = t;
  const DOC = t.file('structure');
  const folder = path.dirname(DOC);
  const base = path.basename(DOC, '.pdf');
  const hash = () => crypto.createHash('sha256').update(fs.readFileSync(DOC)).digest('hex');
  const original = hash();
  const J = (v) => JSON.stringify(v);
  const exportTo = (formatId, pages, overwrite = null) =>
    q(`__vellum.actions.export.exportTo({ view: ${V(DOC)}, formatId: ${J(formatId)}, pages: ${J(pages)}, folder: ${J(folder)}, overwrite: ${J(overwrite)} })`
      + `.then((r) => r && ({ ok: r.ok, cancelled: r.cancelled, written: r.written.map((w) => w.name), failed: r.failed.map((f) => f.error) }))`);
  const read = (name) => fs.readFileSync(path.join(folder, name));
  const clickAt = async (expr) => {
    const [x, y] = await q(`(() => { const r = (${expr}).getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()`);
    await c.mouse(x, y);
  };

  await waitFor(settled(DOC), 25000);
  const errorsBefore = await q(`__vellum.errors?.length ?? 0`);

  area('the dialog');
  await clickAt(`__vellum.ui.toolbar.menuBtn`);
  const entry = `[...document.querySelectorAll('.menu-item')].find((b) => b.querySelector('.menu-label')?.textContent === 'Export…')`;
  check('the More menu offers Export…', await waitFor(`Boolean(${entry})`, 3000));
  await clickAt(entry);
  check('the Export dialog opens', await waitFor(`Boolean(document.querySelector('.export-dialog'))`, 3000));
  const formats = await q(`[...document.querySelectorAll('.export-dialog input[name="export-format"]')].map((i) => i.value).join(',')`);
  check('with the formats the Export Center offers', formats === 'jpg,png,markdown,excel', formats);
  check('and the document’s own folder to start with', await q(`document.querySelector('.export-folder-path').textContent === ${J(folder)}`));
  const note = await q(`document.querySelector('.export-dialog .dialog-note').textContent`);
  check('the note names the files it will create', note.includes(`${base} (page 001).jpg`), note);
  await shot('export-dialog');
  await clickAt(`[...document.querySelectorAll('.export-dialog .dialog-actions .btn')].find((b) => b.textContent === 'Cancel')`);
  check('Cancel writes nothing', await waitFor(`!document.querySelector('.export-dialog')`, 3000)
    && !fs.existsSync(path.join(folder, `${base} (page 001).jpg`)));

  area('images');
  const jpg = await exportTo('jpg', [1, 2]);
  check('JPEG export writes one file per page', jpg?.ok === true && jpg.written.length === 2, JSON.stringify(jpg));
  check('named after the document and the page', jpg?.written.join(', ') === `${base} (page 001).jpg, ${base} (page 002).jpg`, jpg?.written.join(', '));
  const jpgBytes = read(`${base} (page 001).jpg`);
  check('and they are real JPEGs', jpgBytes[0] === 0xff && jpgBytes[1] === 0xd8 && jpgBytes.length > 4000, `${jpgBytes.length} bytes`);

  const png = await exportTo('png', [2]);
  check('PNG export writes the page chosen, and only it', png?.ok === true && png.written.join(', ') === `${base} (page 002).png`, JSON.stringify(png));
  const pngBytes = read(`${base} (page 002).png`);
  check('and it is a real PNG', pngBytes.subarray(1, 4).toString('latin1') === 'PNG' && pngBytes.length > 4000, `${pngBytes.length} bytes`);
  check('no image was written for a page that wasn’t chosen', !fs.existsSync(path.join(folder, `${base} (page 001).png`)));

  area('markdown');
  const md = await exportTo('markdown', [1, 2]);
  check('Markdown export writes one file', md?.ok === true && md.written.join(', ') === `${base}.md`, JSON.stringify(md));
  const text = read(`${base}.md`).toString('utf8');
  check('with a heading per page', /\n## Page 1\n/.test(text) && /\n## Page 2\n/.test(text), text.slice(0, 120));
  check('the document’s text', text.includes('Structure report') && text.includes('A figure on page two'));
  check('and where it came from', text.includes(path.basename(DOC)) && text.includes(DOC.replace(/\\/g, '\\\\')), text.slice(-260));

  area('excel');
  // This document has no table Table extraction is confident about, so there is nothing to put in a
  // workbook: the export says so and writes no file rather than an empty spreadsheet.
  const xlsx = await exportTo('excel', [1, 2]);
  check('an Excel export of a document with no confident table writes nothing', xlsx?.ok === false && xlsx.written.length === 0, JSON.stringify(xlsx));
  check('and says why', /confidently find a table/.test(xlsx?.failed.join(' ') ?? ''), JSON.stringify(xlsx?.failed));
  check('no .xlsx was left behind', !fs.existsSync(path.join(folder, `${base}.xlsx`)));

  area('overwriting');
  const again = await exportTo('markdown', [1, 2], 'keepBoth');
  check('keeping both writes a second file, not over the first', again?.ok === true && again.written.join(', ') === `${base} (2).md`, JSON.stringify(again));
  const replaced = await exportTo('markdown', [1], 'replace');
  check('replacing writes over the first', replaced?.ok === true && replaced.written.join(', ') === `${base}.md`, JSON.stringify(replaced));
  check('and the replaced file holds only the page exported this time', !read(`${base}.md`).toString('utf8').includes('## Page 2'));

  area('the source document');
  check('the document is not marked changed', await q(`!${V(DOC)}.annotations.dirty`));
  check('the PDF is byte for byte unchanged', hash() === original);
  const errors = await q(`JSON.stringify(__vellum.errors?.slice(${errorsBefore}) ?? [])`);
  check('no errors', errors === '[]', errors);
}
