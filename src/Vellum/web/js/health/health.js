// PDF Health: a read-only report of the conditions in a document that Vellum can prove, before anything
// is edited. It is an adapter and decides nothing new: every finding is a signal another part of Vellum
// already produces, in the words that part already uses —
//
//   the document profile   DocumentView.profile() (editing/source.js inspectDocument): signed, certified,
//                          tagged, PDF/A claimed
//   pdf.js document info   pdf.getMetadata().info: EncryptFilterName (protected) and IsXFAPresent (an XFA
//                          form, which Vellum doesn't read: pdf.js runs with enableXfa off)
//   the page analysis      the editing session's own verified analysis of each page (editing/runs.js):
//                          the page summary (unreadable, scanned), `tainted`, `unbalanced`, each run's
//                          refusal reasons (REASONS) and each Form XObject's blockers (FORM_BLOCKERS)
//
// No score, no guess and no repair: a page is reported unreadable only when the analysis says so, and a
// document that raises nothing is reported as that — nothing found — not as proven sound.
//
//   finding  { id, severity, category, message, source, pages, count, details }
//     severity  'refused'  Vellum won't change this (the page, or the whole document)
//               'limited'  some of it can't be changed, or a change has a consequence to know first
//               'info'     a fact about the file worth knowing before editing; nothing is refused
//     pages     the 1-based pages it was found on; empty for the document as a whole
//     count     for text, how many pieces of text it applies to on those pages (else null)
//     details   further sentences, e.g. what stands in the way inside a Form XObject

import { PAGE_KINDS, REASONS, explainForm } from '../editing/runs.js';

export const SEVERITIES = Object.freeze(['refused', 'limited', 'info']);

const ENCRYPTED = 'This PDF is protected (encrypted). Vellum opens it with the right password but can’t rewrite it: its text, pictures and pages can’t be changed, and annotations are kept in Vellum beside the original.';
const ENCRYPTED_PAGES = 'Page content isn’t read in a protected PDF, so the pages themselves weren’t checked.';
const XFA = 'This PDF contains an XFA form. Vellum doesn’t read XFA: it shows and fills only the file’s ordinary (AcroForm) fields, so parts of the form may be missing or behave differently here.';
const SIGNED = 'This PDF is digitally signed. Saving any change to it makes the signature invalid.';
const CERTIFIED = 'It is certified: the author’s signature says which changes are allowed.';
const TAGGED = 'This PDF is tagged for accessibility. Vellum doesn’t update those tags when it changes or adds content, so screen readers may not read changes correctly.';
const pdfaText = ({ part, conformance }) => `This PDF says it conforms to PDF/A-${part}${conformance ?? ''}. Vellum doesn’t check that claim, and a saved change may not keep to it.`;

/** Run reasons already reported for the page as a whole, or not about the file at all. */
const NOT_TEXT_FINDINGS = new Set(['unverified', 'blank', 'unreadable', 'structure']);
/** Run reasons that describe the text rather than refuse a change that would matter. */
const INFO_REASONS = new Set(['invisible']);

const finding = (id, severity, category, message, source, extra = {}) =>
  ({ id, severity, category, message, source, pages: [], count: null, details: [], ...extra });

/**
 * What the file as a whole shows. Pure.
 *   encrypted  the document is protected (DocumentView.encrypted, from pdf.js's EncryptFilterName)
 *   profile    DocumentView.profile(), or null when it couldn't be read
 *   info       pdf.js's getMetadata().info, or null
 */
export function documentFindings({ encrypted = false, profile = null, info = null } = {}) {
  const list = [];
  if (encrypted) {
    list.push(finding('protected', 'refused', 'protection', ENCRYPTED, 'pdf.js document info',
      { details: [ENCRYPTED_PAGES, ...(info?.EncryptFilterName ? [`Security handler: ${info.EncryptFilterName}.`] : [])] }));
  }
  if (info?.IsXFAPresent) list.push(finding('xfa', 'limited', 'forms', XFA, 'pdf.js document info'));
  if (profile?.signed || profile?.certified) {
    list.push(finding('signed', 'limited', 'signature', SIGNED, 'document profile', { details: profile.certified ? [CERTIFIED] : [] }));
  }
  if (profile?.tagged) list.push(finding('tagged', 'info', 'accessibility', TAGGED, 'document profile'));
  if (profile?.pdfa) list.push(finding('pdfa', 'info', 'standards', pdfaText(profile.pdfa), 'document profile'));
  return list;
}

/**
 * What one page's analysis (editing/runs.js analyzePage, verified by the session) shows. Pure.
 * `number` is the page's 1-based place in the document as it is shown.
 */
export function pageFindings(number, analysis) {
  if (!analysis) return [];
  const list = [];
  const on = { pages: [number] };
  const kind = analysis.summary?.kind;
  const read = (analysis.issues ?? []).filter((i) => i.kind === 'unreadable' && i.message).map((i) => i.message);
  if (kind === 'unreadable') {
    list.push(finding('page:unreadable', 'refused', 'content', PAGE_KINDS.unreadable, 'page analysis', { ...on, details: read }));
  } else if (analysis.tainted) {
    list.push(finding('page:tainted', 'refused', 'content', REASONS.unreadable, 'page analysis', { ...on, details: read }));
  }
  if (analysis.unbalanced) list.push(finding('page:structure', 'refused', 'structure', REASONS.structure, 'page analysis', on));
  if (kind === 'scanned' || kind === 'scanned-ocr') list.push(finding(`page:${kind}`, 'info', 'content', PAGE_KINDS[kind], 'page analysis', on));

  // Text Vellum won't edit, by reason: the reason each run's own tooltip gives, counted.
  const counts = new Map();
  for (const run of analysis.runs ?? []) {
    if (run.editable) continue;
    for (const reason of run.reasons ?? []) {
      if (NOT_TEXT_FINDINGS.has(reason) || !REASONS[reason]) continue;
      if (reason === 'invisible' && kind === 'scanned-ocr') continue; // the page's own finding already says so
      counts.set(reason, (counts.get(reason) ?? 0) + 1);
    }
  }
  for (const [reason, count] of counts) {
    // Text a Form XObject draws: why each such form can't be written into, in the analysis's own words.
    const details = reason === 'form' ? formDetails(analysis) : [];
    list.push(finding(`text:${reason}`, INFO_REASONS.has(reason) ? 'info' : 'limited', reason === 'form' ? 'form-xobject' : 'text',
      REASONS[reason], reason === 'form' ? 'Form XObject analysis' : 'text analysis', { ...on, count, details }));
  }
  return list;
}

/** The blockers of every Form XObject on the page that holds text and can't be written into. */
function formDetails(analysis) {
  const out = new Set();
  for (const form of analysis.forms ?? []) {
    if (!form.verification || form.verification.state === 'empty' || form.verification.candidate) continue;
    for (const sentence of explainForm(form)) out.add(sentence);
  }
  return [...out];
}

/**
 * Findings of the same kind, from several pages, as one: pages listed in order, counts added and
 * details kept once each. Sorted by severity, then in the order they were first found.
 */
export function mergeFindings(list) {
  const byId = new Map();
  for (const f of list) {
    const seen = byId.get(f.id);
    if (!seen) {
      byId.set(f.id, { ...f, pages: [...f.pages], details: [...f.details] });
      continue;
    }
    for (const p of f.pages) if (!seen.pages.includes(p)) seen.pages.push(p);
    if (f.count != null) seen.count = (seen.count ?? 0) + f.count;
    for (const d of f.details) if (!seen.details.includes(d)) seen.details.push(d);
  }
  const merged = [...byId.values()];
  for (const f of merged) f.pages.sort((a, b) => a - b);
  const rank = (f) => SEVERITIES.indexOf(f.severity);
  return merged.map((f, i) => [f, i]).sort(([a, i], [b, j]) => rank(a) - rank(b) || i - j).map(([f]) => Object.freeze(f));
}

/**
 * Checks the document open in `view` (a DocumentView): the file, then each page as shown, through the
 * editing session's analysis (the editor's own, done once per page and kept). Read-only.
 *   onPage(number, count)  called before each page is read
 *   signal                 an AbortSignal: a stopped check returns what it found so far, complete: false
 * Returns { findings, pageCount, pagesChecked, complete }.
 */
export async function checkDocument(view, { onPage = null, signal = null } = {}) {
  const info = await view.pdf.getMetadata().then((m) => m.info, () => null);
  const profile = await view.profile().catch(() => null);
  const found = documentFindings({ encrypted: view.encrypted, profile, info });
  const pageCount = view.pdf.numPages;
  let pagesChecked = 0;
  if (!view.encrypted) {
    for (let number = 1; number <= pageCount; number++) {
      if (signal?.aborted) return { findings: mergeFindings(found), pageCount, pagesChecked, complete: false };
      onPage?.(number, pageCount);
      try {
        const { analysis } = await view.textEditing.objects(number);
        found.push(...pageFindings(number, analysis));
      } catch (err) {
        // The engine's own refusal to read the page (the file's structure, not its drawing), as it says it.
        found.push(finding('page:failed', 'refused', 'content', PAGE_KINDS.unreadable, 'page analysis',
          { pages: [number], details: [String(err?.message ?? err)] }));
      }
      pagesChecked++;
    }
  }
  return { findings: mergeFindings(found), pageCount, pagesChecked, complete: !view.encrypted };
}
