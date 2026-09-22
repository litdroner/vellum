import { h } from '../dom.js';
import { provenanceDetail } from '../semantic/provenance.js';
import { readSavedResearch, savedResearchPaths, savedResearchSubject, suggestedName, withAvailability, MAX_NAME_LENGTH } from '../semantic/saved-research.js';
import { showDialog, toast } from './dialogs.js';

// Saving and reopening one research result (semantic/saved-research.js). Save takes the result the caller is
// already showing, asks for a name and hands it to the host (Services/SavedResearch.cs) as it stands. Open
// shows the same result back: the summary and the evidence exactly as they were found, read-only — nothing is
// searched again, no document is read and no PDF is changed. A document that is gone is listed as not found
// and its passage can't be opened; the passage itself is still quoted, because that is what was saved.

const subjectLine = (record) => (record.collection?.name
  ? `Collection · ${record.collection.name}`
  : `Document · ${savedResearchSubject(record)}`);

/**
 * Asks for a name and keeps `record` (a savedResearchRecord). Resolves with what the host saved, or null when
 * cancelled or refused. Nothing is recomputed: the record is written as the caller made it.
 */
export async function saveResearchDialog({ bridge, record }) {
  if (!record || !record.evidence.length) {
    toast('There is no evidence to save yet.', { timeout: 4000 });
    return null;
  }
  const input = h('input', {
    class: 'field', type: 'text', maxlength: String(MAX_NAME_LENGTH), spellcheck: 'false', autocomplete: 'off',
    placeholder: 'Name this research', 'aria-label': 'Name for this saved research',
  });
  input.value = suggestedName(record);
  const choice = await showDialog({
    title: 'Save this research',
    message: `${record.evidence.length} ${record.evidence.length === 1 ? 'passage' : 'passages'} and where each came from are kept on this PC, as they were found. Opening it later shows the same evidence — the research isn’t run again.`,
    iconName: 'save',
    content: [input],
    buttons: [{ id: 'cancel', label: 'Cancel' }, { id: 'save', label: 'Save', primary: true }],
    onOpen: () => { requestAnimationFrame(() => input.select()); return input; },
  });
  const name = input.value.trim();
  if (choice !== 'save' || !name) return null;
  try {
    const saved = await bridge.request('research.save', { name, paths: savedResearchPaths(record), result: record });
    toast(`Saved “${saved.name}”`, { kind: 'success' });
    return saved;
  } catch (err) {
    toast(err.message, { kind: 'error' });
    return null;
  }
}

/**
 * Shows one saved result back: `item` is what `research.list` gave ({ id, name, createdAt, result, documents }).
 * `onOpenEvidence({ path, number, box })` opens a passage's document at its page; the dialog closes first.
 * Resolves when the dialog closes. Read-only throughout — nothing here asks the question again.
 */
export function showSavedResearch({ item, onOpenEvidence = () => {} }) {
  const record = readSavedResearch(item?.result);
  let finish = () => {};
  const body = h('div', { class: 'cr-body saved-research-body' });

  if (!record) {
    body.append(h('p', { class: 'structure-hint', text: 'This saved research can’t be read. It was written by a newer version of Vellum, or the file it is kept in was damaged — nothing has been changed or run again.' }));
  } else {
    const shown = withAvailability(record, item.documents ?? []);
    body.append(
      h('p', { class: 'saved-research-question', text: `“${record.question}”` }),
      h('p', { class: 'saved-research-subject', text: `${subjectLine(record)} · saved ${new Date(item.createdAt ?? record.savedAt).toLocaleString()}` }),
      h('div', { class: 'structure-props-title research-heading', text: 'Summary · by Vellum, from the matches as they were found' }),
      h('p', { class: 'structure-hint research-summary', 'data-sufficient': String(record.sufficient), text: record.summary }));

    if (shown.evidence.length) {
      body.append(h('div', { class: 'structure-props-title research-heading', text: 'Evidence · quoted as it was saved' }));
      const list = h('div', { class: 'cr-results', role: 'list', 'aria-label': 'Saved evidence' });
      for (const passage of shown.evidence) {
        const where = `${passage.name ?? 'Document'} · page ${passage.page}${passage.missing ? ' · not found' : ''}`;
        list.append(h(passage.missing ? 'div' : 'button', {
          class: `structure-row structure-item research-evidence cr-evidence${passage.missing ? ' kg-inert' : ''}`,
          role: 'listitem',
          'data-missing': String(passage.missing),
          ...(passage.missing ? {} : { type: 'button', onClick: () => { finish('close'); onOpenEvidence({ path: passage.path, number: passage.page, box: passage.box ?? null }); } }),
          title: [passage.missing ? 'That document is no longer where it was' : `Open ${passage.name} at page ${passage.page}`, provenanceDetail(passage.provenance)].filter(Boolean).join('\n'),
        },
        h('span', { class: 'research-quote', text: `“${passage.text}”` }),
        h('span', { class: 'research-source', text: passage.matched.length ? `${where} · matches ${passage.matched.map((t) => `“${t}”`).join(', ')}` : where })));
      }
      body.append(list);
    }
    if (shown.missing) {
      body.append(h('p', { class: 'kg-note', text: `${shown.missing} ${shown.missing === 1 ? 'passage names a document' : 'passages name documents'} that isn’t where it was. The evidence stays as it was saved; it just can’t be opened.` }));
    }
  }

  return showDialog({
    title: `Saved research “${item?.name ?? ''}”`,
    message: 'The result as it was found. Nothing is searched again and no document is read or changed.',
    iconName: 'book-open',
    className: 'collection-research-dialog saved-research-dialog',
    content: [body],
    buttons: [{ id: 'close', label: 'Close', primary: true }],
    bind: (api) => { finish = api.finish; },
  });
}

/** Asks before deleting one saved result. Resolves true when it was deleted. */
export async function deleteSavedResearch({ bridge, item }) {
  const choice = await showDialog({
    title: `Delete “${item.name}”?`,
    message: 'This saved research is removed. Nothing else is touched — the documents it quotes stay where they are.',
    iconName: 'trash-2',
    buttons: [{ id: 'cancel', label: 'Cancel', primary: true }, { id: 'delete', label: 'Delete saved research' }],
  });
  if (choice !== 'delete') return false;
  try {
    await bridge.request('research.delete', { id: item.id });
    return true;
  } catch (err) {
    toast(err.message, { kind: 'error' });
    return false;
  }
}

/** The one-line note under a saved result's name in the list: what it was asked of, and how much it found. */
export function savedResearchMeta(item) {
  const record = readSavedResearch(item.result);
  if (!record) return 'Can’t be read';
  const missing = (item.documents ?? []).filter((d) => !d.exists).length;
  const count = record.evidence.length;
  return [
    subjectLine(record),
    `${count} ${count === 1 ? 'passage' : 'passages'}`,
    missing ? `${missing} not found` : null,
  ].filter(Boolean).join(' · ');
}
