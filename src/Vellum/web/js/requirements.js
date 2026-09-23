// Whether a command can run now, decided in one place for every surface that offers it: the More menu,
// the command palette, and Tools. A command says what it needs (commands.js):
//   doc: true           it needs an open, ready document: the requirement `document`, always tested first
//   requires: [names]   more requirements, all of which must be met (REQUIREMENTS below)
//   presentIf: name     a provider this PC must have (an engine, a local AI model); without one the
//                       command is hidden everywhere instead of shown as unavailable. The feature that
//                       owns the provider says what is there (office/actions.js: engine.office.word…).
// A requirement is a name, a synchronous test of a snapshot of the app's state, and the sentence that says
// why it isn't met. It reads getters that exist, once: never the pages, never the file. Anything that needs
// the document's contents stays the action's own refusal. When a condition needs logic, the feature
// exports it (as history's canUse, or the text editor's pictureSelected) and this list gains one name.
// Whether a command *fits* what is on screen (a selection it would act on) is relevance, which only
// suggests: that belongs to Tools' discovery data, never here.

import { NO_FORM_FIELDS } from './forms/fields.js';

export const REQUIREMENTS = Object.freeze({
  document: { met: (s) => s.document, reason: 'Open a PDF first.' },
  writable: { met: (s) => s.writable, reason: 'This PDF is protected (encrypted), so Vellum can’t rewrite it.' },
  textEditing: { met: (s) => !s.textEditingReason, reason: (s) => s.textEditingReason },
  history: { met: (s) => s.history, reason: 'This is a snapshot. Its history is in the document it was taken from.' },
  formFields: { met: (s) => s.formFields, reason: NO_FORM_FIELDS },
  'selection.text': { met: (s) => s.selectedText, reason: 'Select text on the page first.' },
  'selection.objects': { met: (s) => s.selectedObjects, reason: 'Select text or pictures in Edit mode first.' },
  'selection.picture': { met: (s) => s.selectedPicture, reason: 'Select a picture in Edit mode first.' },
});

/** The requirements `command` declares, in the order they are tested: the document first. */
export const requirementsOf = (command) => (command.doc ? ['document', ...(command.requires ?? [])] : [...(command.requires ?? [])]);

/**
 * The state requirements are tested against, as plain values: read from existing getters when a surface
 * asks (a menu or the palette opening), synchronously and in microseconds.
 */
export function snapshot(app, ui, actions) {
  const view = app.active?.status === 'ready' ? app.active : null;
  const editing = view?.annotLayer?.tool === 'edit';
  return {
    document: Boolean(view),
    writable: Boolean(view?.canEditPages),
    textEditingReason: view ? view.textEditing.unavailableReason : 'The document isn’t ready yet.',
    history: Boolean(view && actions.history.canUse(view)),
    formFields: Boolean(view?.hasFormFields),
    selectedText: Boolean(view?.getSelectedText()),
    selectedObjects: Boolean(editing && view.objectSelection.size > 0),
    selectedPicture: Boolean(editing && view.textEditor?.pictureSelected),
    // Providers on this PC by name (engine.office.word, engine.signing, ai.local…), each true once it is
    // known to be there, as the features that own them report it.
    presence: Object.freeze({ ...actions.office?.presence() }),
  };
}

/**
 * Can `command` run now, given `snap`? { present, available, reason, unmet }. Not present: hidden
 * everywhere. Present but not available: `unmet` is the first requirement that isn't met, and `reason`
 * says why in words a person can act on.
 */
export function availability(command, snap) {
  const present = !command.presentIf || snap.presence[command.presentIf] === true;
  if (!present) return { present, available: false, reason: null, unmet: null };
  for (const name of requirementsOf(command)) {
    const requirement = REQUIREMENTS[name];
    if (!requirement) throw new Error(`Unknown requirement “${name}”`);
    if (!requirement.met(snap)) {
      const { reason } = requirement;
      return { present, available: false, reason: typeof reason === 'function' ? reason(snap) : reason, unmet: name };
    }
  }
  return { present, available: true, reason: null, unmet: null };
}
