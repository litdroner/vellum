import { h } from '../dom.js';
import { showDialog, toast } from '../ui/dialogs.js';
import { createRecognizer, hasUsableText } from './engine.js';
import { ENGLISH, ocrReadiness, selectedLanguage } from './languages.js';
import { languagePacks } from './language-packs.js';

// OCR as the UI offers it (Tools in the "More" menu and the palette): the current page or the whole
// document, in the language chosen in Settings → OCR (English unless another pack is chosen). Pages that already have a text layer are left alone. The recognised text is
// one content edit per page (editing/objects/ocr-text.js), all of them one undo step, and nothing
// changes on disk until the document is saved.

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/**
 * The language to read in, or null when the user chose not to go on. A chosen pack that isn't downloaded
 * (or failed its check) is explained, with the choice of English instead or opening Settings → OCR.
 */
async function chooseLanguage(openSettings) {
  let language = ENGLISH;
  let check = { ready: true };
  try {
    language = selectedLanguage(await languagePacks.list());
    check = await languagePacks.prepare(language.code);
  } catch {
    return ENGLISH; // the host couldn't answer: English always works
  }
  const readiness = ocrReadiness(language, check);
  if (readiness.ready) return language;
  const choice = await showDialog({
    title: readiness.title,
    message: readiness.message,
    iconName: 'text-select',
    buttons: [{ id: 'cancel', label: 'Cancel' }, { id: 'eng', label: 'Use English' }, { id: 'settings', label: 'Open OCR settings', primary: true }],
  });
  if (choice === 'eng') return ENGLISH;
  if (choice === 'settings') openSettings?.('ocr');
  return null;
}

export function createOcrActions({ openSettings = null } = {}) {
  let running = false;

  return {
    /** scope: 'page' (the current page) or 'document'. */
    async run(view, scope) {
      if (!view?.canEditPages) {
        toast(view?.encrypted ? 'This PDF is protected, so text can’t be added to it.' : 'The document is still opening.', { kind: 'error' });
        return;
      }
      if (running || view.rebuilding) {
        toast(running ? 'OCR is already running.' : 'The pages are still being updated. Try again in a moment.');
        return;
      }
      if (!(await view.confirmChanges())) return;
      const language = await chooseLanguage(openSettings);
      if (!language || running) return;

      const pdf = view.pdf;
      const plan = view.shownPlan;
      const numbers = scope === 'page' ? [view.state.pageNumber] : plan.map((_, i) => i + 1);
      running = true;

      const fill = h('div', { class: 'progress-fill' });
      const note = h('p', { class: 'dialog-note', text: 'Starting the OCR engine…' });
      let close = null;
      let cancelled = false;
      const dialog = showDialog({
        title: scope === 'page' ? 'Recognising text on this page' : 'Recognising text in the document',
        message: `Vellum is reading the scanned pages in ${language.name}, on this computer. The pages themselves stay exactly as they are.`,
        iconName: 'text-select',
        className: 'ocr-dialog',
        content: [h('div', { class: 'progress update-progress' }, fill), note],
        buttons: [{ id: 'cancel', label: 'Cancel' }],
        bind: ({ finish }) => { close = finish; },
      }).then(() => { cancelled = true; });

      let done = 0;
      const show = (fraction) => { fill.style.width = `${Math.round(((done + fraction) / numbers.length) * 100)}%`; };
      let recognizer = null;
      const records = [];
      let skipped = 0;
      let empty = 0;
      let failed = 0;
      try {
        recognizer = await createRecognizer({ language: language.code, onProgress: show });
        for (const n of numbers) {
          if (cancelled) break;
          note.textContent = numbers.length === 1 ? 'Reading the page…' : `Reading page ${n} of ${plan.length}…`;
          show(0);
          try {
            const page = await pdf.getPage(n);
            if (await hasUsableText(page)) skipped++;
            else {
              const record = await recognizer.recognize(page, plan[n - 1].id);
              if (record) records.push(record);
              else empty++;
            }
          } catch {
            failed++;
          }
          done++;
        }
      } catch (err) {
        close?.('error');
        await dialog;
        running = false;
        showDialog({ title: 'OCR couldn’t start', message: err?.message ?? String(err), iconName: 'triangle-alert' });
        return;
      } finally {
        recognizer?.terminate().catch(() => {});
      }
      const wasCancelled = cancelled;
      close?.('done');
      await dialog;
      running = false;

      if (wasCancelled) {
        toast('OCR cancelled. Nothing was changed.');
        return;
      }
      if (records.length && view.pdf === pdf) {
        view.annotations.applyEdits(records.map((r) => [null, r]));
      }
      const parts = [];
      if (records.length) parts.push(`Added searchable text to ${plural(records.length, 'page')}. Save to keep it.`);
      if (skipped) parts.push(scope === 'page' ? 'This page already has text.' : `${plural(skipped, 'page')} already had text.`);
      if (empty) parts.push(scope === 'page' ? 'No text was found on this page.' : `No text was found on ${plural(empty, 'page')}.`);
      if (failed) parts.push(`${plural(failed, 'page')} couldn’t be read.`);
      toast(parts.join(' '), {
        kind: failed && !records.length ? 'error' : records.length ? 'success' : 'info',
        timeout: 6000,
        action: records.length ? { label: 'Undo', run: () => view.annotations.undo() } : null,
      });
    },
  };
}
