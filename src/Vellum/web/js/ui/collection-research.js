import { h } from '../dom.js';
import { icon } from '../icons.js';
import { researchCollection, SKIP_REASONS } from '../semantic/collection-research.js';
import { evidenceToTsv } from '../semantic/research.js';
import { copyText } from '../commands.js';
import { provenanceDetail, SOURCES } from '../semantic/provenance.js';
import { showDialog, toast } from './dialogs.js';
import { savedResearchRecord } from '../semantic/saved-research.js';
import { saveResearchDialog } from './saved-research.js';

// Research a collection: one question asked of every document in it (semantic/collection-research.js), the
// evidence ranked across the whole collection and quoted with the document it came from and its page.
//
// The documents are read one at a time from the host's read-only URLs and dropped again — none is opened in
// Vellum, none is changed, and nothing is kept after the dialog closes. Choosing a result resolves with it,
// so the caller can open that document at that page; closing the dialog stops a reading in progress.

const reasonText = (skip) => SKIP_REASONS[skip.reason] ?? skip.reason;

/**
 * Asks a question of `collection` ({ id, name }). Resolves with the chosen evidence
 * ({ path, name, number, box, text, provenance }), or null when nothing was chosen.
 * `onResult({ question, evidence })` is told what the last question found, so a caller can show the same
 * evidence elsewhere without asking again; it holds nothing this dialog didn't already have.
 */
export function researchCollectionDialog({ bridge, collection, onResult = null }) {
  const input = h('input', {
    class: 'field', type: 'search', spellcheck: 'false', autocomplete: 'off',
    placeholder: 'Ask a research question', 'aria-label': `Research question about ${collection.name}`,
  });
  const askBtn = h('button', { class: 'btn primary', type: 'button' }, 'Research');
  const exportBtn = h('button', { class: 'tb-btn small', title: 'Export evidence', 'aria-label': 'Export evidence', hidden: true, html: icon('copy', 15) });
  const saveBtn = h('button', { class: 'tb-btn small', title: 'Save this research', 'aria-label': 'Save this research', hidden: true, html: icon('save', 15) });
  const status = h('p', { class: 'cr-status', 'aria-live': 'polite' });
  const results = h('div', { class: 'cr-results', role: 'list', 'aria-label': 'Evidence' });
  const content = h('div', { class: 'cr-body' },
    h('div', { class: 'cr-ask' }, h('div', { class: 'find-field' }, h('span', { class: 'find-glyph', html: icon('search', 14) }), input), askBtn, exportBtn, saveBtn),
    status, results);

  let abort = null;
  let chosen = null;
  let finish = () => {};
  let found = null;
  let question = '';

  const choose = (item) => { chosen = item; finish('chosen'); };

  exportBtn.addEventListener('click', () => {
    if (!found?.sufficient) return toast('No evidence to export.', { timeout: 4000 });
    copyText(evidenceToTsv(question, found.evidence));
    toast(`Copied ${found.evidence.length} ${found.evidence.length === 1 ? 'passage' : 'passages'} of evidence`, { kind: 'success' });
  });

  // The result as it stands, kept under a name; nothing is recomputed now or when it is opened again.
  saveBtn.addEventListener('click', async () => {
    if (!found?.sufficient) return toast('No evidence to save.', { timeout: 4000 });
    await saveResearchDialog({
      bridge,
      record: savedResearchRecord({
        question,
        source: SOURCES.collection,
        collection: { id: collection.id, name: collection.name },
        summary: found.summary,
        sufficient: found.sufficient,
        evidence: found.evidence,
      }),
    });
  });

  const show = (result) => {
    found = result;
    onResult?.({ question, evidence: result.sufficient ? result.evidence : [] });
    exportBtn.hidden = saveBtn.hidden = !found.sufficient;
    results.replaceChildren(
      h('div', { class: 'structure-props-title research-heading', text: 'Summary · by Vellum, from the matches' }),
      h('p', { class: 'structure-hint research-summary', 'data-sufficient': String(found.sufficient), text: found.summary }));
    if (found.sufficient) {
      results.append(h('div', { class: 'structure-props-title research-heading', text: 'Evidence · quoted from the documents' }));
      for (const item of found.evidence) {
        results.append(h('button', {
          class: 'structure-row structure-item research-evidence cr-evidence', role: 'listitem', type: 'button',
          'data-path': item.path, 'data-page': String(item.number),
          // Where the passage came from, in full, on the row that quotes it.
          title: [`Open ${item.name} at page ${item.number}`, provenanceDetail(item.provenance)].filter(Boolean).join('\n'),
          onClick: () => choose(item),
        },
        h('span', { class: 'research-quote', text: `“${item.text}”` }),
        h('span', { class: 'research-source', text: `${item.name} · page ${item.number} · matches ${item.matched.map((t) => `“${t}”`).join(', ')}` })));
      }
    }
    if (found.skipped.length) {
      results.append(h('div', { class: 'structure-props-title research-heading', text: `Skipped · ${found.skipped.length} of ${found.skipped.length + found.searched}` }));
      for (const skip of found.skipped) {
        results.append(h('p', { class: 'cr-skipped', title: skip.path, text: `${skip.name} — ${reasonText(skip)}` }));
      }
    }
    status.textContent = found.sufficient
      ? `${found.evidence.length} ${found.evidence.length === 1 ? 'passage' : 'passages'} · ${found.searched} of ${found.documents ?? found.searched + found.skipped.length} documents read`
      : 'No evidence';
  };

  const ask = async () => {
    question = input.value.trim();
    abort?.abort();
    if (!question) { found = null; onResult?.({ question, evidence: [] }); exportBtn.hidden = saveBtn.hidden = true; results.replaceChildren(); status.textContent = ''; return; }
    const controller = new AbortController();
    abort = controller;
    askBtn.disabled = true;
    results.replaceChildren();
    status.textContent = 'Reading the collection…';
    try {
      const { documents } = await bridge.request('collections.documents', { id: collection.id });
      const asked = await researchCollection({
        documents,
        question,
        signal: controller.signal,
        onProgress: ({ index, total, name }) => { status.textContent = `Researching · reading ${name} (${index + 1} of ${total})…`; },
      });
      if (controller.signal.aborted) return;
      show({ ...asked, documents: documents.length });
    } catch (err) {
      if (!controller.signal.aborted) {
        results.replaceChildren();
        status.textContent = err.message;
      }
    } finally {
      if (abort === controller) { abort = null; askBtn.disabled = false; }
    }
  };

  askBtn.addEventListener('click', ask);
  input.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    e.stopPropagation();
    ask();
  });

  return showDialog({
    title: `Research “${collection.name}”`,
    message: 'Finds passages in the documents of this collection that hold the question’s key terms, quoted with the document and page they come from. The files are only read.',
    iconName: 'book-open',
    className: 'collection-research-dialog',
    content: [content],
    buttons: [{ id: 'close', label: 'Close' }],
    bind: (api) => { finish = api.finish; },
    onOpen: () => input,
  }).then(() => {
    abort?.abort();
    return chosen;
  });
}
