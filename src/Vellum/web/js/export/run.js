// Export Center V1 — running a plan. One loop for every format: produce a file's bytes, write them through
// the host, report progress, stop when asked, and say plainly what was written and what was not.
//
// It reads nothing and writes nothing itself: `produce` makes one file's bytes (export/images.js,
// export/markdown.js) and `write` hands them to the host (the /export/{token} route, which writes
// atomically). The document being exported is never opened for writing and never changed.
//
//   runExport({ plan, targets, produce, write, onProgress, signal }) -> result
//   result  { format, total, written, failed, cancelled, ok }
//   written [{ name, path, page, bytes }]      failed [{ name, path, page, error }]
//
// Cancellation is checked before each file and again before it is written, so stopping never leaves a
// half-written file: a file is either written whole or not at all. A file that fails does not stop the
// rest — the result names every one that could not be written, and `ok` is true only when all of them were.

const aborted = (signal) => Boolean(signal?.aborted);

export async function runExport({ plan, targets, produce, write, onProgress = null, signal = null }) {
  const files = plan.files;
  if (!Array.isArray(targets) || targets.length !== files.length) {
    throw new Error('The files to export and the places to write them don’t match.');
  }
  const written = [];
  const failed = [];
  let cancelled = false;

  for (let i = 0; i < files.length; i++) {
    if (aborted(signal)) { cancelled = true; break; }
    const file = files[i];
    const target = targets[i];
    const page = file.pages.length === 1 ? file.pages[0] : null;
    onProgress?.({ index: i, total: files.length, name: target.name ?? file.name, page });
    try {
      const data = await produce(file, { index: i, signal, plan });
      if (aborted(signal)) { cancelled = true; break; }
      const size = await write(target, data);
      written.push(Object.freeze({ name: target.name ?? file.name, path: target.path ?? null, page, bytes: size ?? null }));
    } catch (err) {
      if (aborted(signal)) { cancelled = true; break; }
      failed.push(Object.freeze({ name: target.name ?? file.name, path: target.path ?? null, page, error: err?.message || 'The file couldn’t be written.' }));
    }
  }
  onProgress?.({ index: files.length, total: files.length, name: null, page: null });

  return Object.freeze({
    format: plan.format.id,
    total: files.length,
    written: Object.freeze(written),
    failed: Object.freeze(failed),
    cancelled,
    ok: !cancelled && failed.length === 0 && written.length === files.length,
  });
}
