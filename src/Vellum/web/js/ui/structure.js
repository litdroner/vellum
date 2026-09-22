import { debounce, h } from '../dom.js';
import { icon } from '../icons.js';
import { itemBox, markPageBox } from './page-mark.js';
import { readPdfPage, readSessionPage } from '../semantic/model.js';
import { countsLabel, pageCounts, pageNote, pageRows, properties } from '../semantic/inspector.js';
import { describeQuery, isEmptyQuery, matchPage, needsContent, parseQuery } from '../semantic/query.js';
import { evidenceToTsv, pageCandidates, rankEvidence, researchTerms } from '../semantic/research.js';
import { copyText } from '../commands.js';
import { toast } from './dialogs.js';
import { documentRef, provenanceDetail, SOURCES } from '../semantic/provenance.js';
import { savedResearchRecord } from '../semantic/saved-research.js';
import { saveResearchDialog } from './saved-research.js';
import { bridge } from '../bridge.js';

// The Structure tab of the sidebar: the semantic document model (semantic/model.js) of the document, page
// by page — text blocks and their runs, images, form fields, annotations and links — with the properties of
// the one selected. Read-only: selecting an object goes to its page and marks its box for a moment, and
// nothing in the document, the model or Edit mode's selection changes. A page is read when it is opened
// (through the editing session's analysis, which is the editor's own and done once per page). A protected
// PDF has no editing session, so its pages are read from pdf.js alone: fields, annotations and links, no
// text or images. A change made in Vellum reads the pages it touched again.
//
// Search (semantic/query.js) looks through the same models: text, or objects of a kind, matched word for
// word — no index, nothing inferred, not the viewer's Find. Pages are read one after another as the search
// reaches them, each read once and kept for the tree too; a query only for fields, annotations or links
// reads what pdf.js has of a page, not its content. A new query stops the one before it. Results take the
// tree's place; Previous and Next (Enter, Shift+Enter) select them in turn, as selecting in the tree does.
//
// Research (semantic/research.js) takes the same field for a question: every page is read, the question's
// key terms are searched for as text, and the passages holding enough of them are listed as evidence —
// quoted, with their page — under one line of summary that is Vellum's, not the document's. Selecting a
// passage selects it as a search result does. No passage holding enough of the terms: it says so. Each piece
// of evidence carries its provenance (semantic/provenance.js) — the document it came from, its page, its box
// and the model's IDs — shown on the row and exposed by `research` for a later feature to use. Save keeps the
// research shown now on this PC (ui/saved-research.js): opening it again from the home screen shows the same
// evidence without reading the document or asking the question a second time.

const MARK_MS = 2400;
const MAX_RESULTS = 1000;

export class StructurePanel {
  #pages = new Map(); // page number → Promise of its model
  #selected = null; // { row, number, el }
  #mark = null;
  #readEdits = new Map(); // page number → the content edits on it when it was read
  #replan = false; // the page list changed: every page is read again
  #abort = new AbortController();
  #search = { id: 0, query: null, results: [], index: -1, reading: false };
  #options = { caseSensitive: false, entireWord: false }; // Match case, Whole words
  #research = false; // the field asks a research question instead of searching

  constructor(view) {
    this.view = view;
    // Content and page changes rebuild the document, and documentChanged() follows. Annotations and form
    // values kept in Vellum aren't read from the file, so they change nothing here.
    view.annotations.addEventListener('change', (e) => { if (e.detail.plan) this.#replan = true; }, { signal: this.#abort.signal });
    this.el = h('div', { class: 'structure' });
    this.tree = h('div', { class: 'structure-tree', role: 'tree', 'aria-label': 'Document structure' });
    this.props = h('div', { class: 'structure-props', 'aria-live': 'polite' });
    this.summary = h('div', { class: 'structure-summary' });
    this.searchInput = h('input', {
      class: 'find-input structure-search-input', type: 'search', spellcheck: 'false',
      placeholder: 'Search structure', 'aria-label': 'Search the document structure',
      title: 'Words, or a kind: all images, all form fields, all links, editable text containing …',
    });
    const run = debounce(() => this.search(this.searchInput.value), 200);
    this.searchInput.addEventListener('input', run, { signal: this.#abort.signal });
    this.searchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        this.#searchNow().then(() => this.step(e.shiftKey ? -1 : 1));
      } else if (e.key === 'Escape' && this.searchInput.value) {
        e.preventDefault();
        e.stopPropagation();
        this.searchInput.value = '';
        this.search('');
      }
    }, { signal: this.#abort.signal });
    const option = (name, title, glyph) => {
      const button = h('button', {
        class: 'tb-btn small', title, 'aria-label': title, 'aria-pressed': 'false', html: icon(glyph, 15),
        onClick: () => {
          this.#options[name] = !this.#options[name];
          button.setAttribute('aria-pressed', String(this.#options[name]));
          if (this.searchInput.value.trim()) this.search(this.searchInput.value);
        },
      });
      return button;
    };
    this.caseBtn = option('caseSensitive', 'Match case', 'case-sensitive');
    this.wordBtn = option('entireWord', 'Whole words', 'whole-word');
    this.prevBtn = h('button', { class: 'tb-btn small', title: 'Previous result (Shift+Enter)', 'aria-label': 'Previous result', html: icon('chevron-up', 15), onClick: () => this.step(-1) });
    this.nextBtn = h('button', { class: 'tb-btn small', title: 'Next result (Enter)', 'aria-label': 'Next result', html: icon('chevron-down', 15), onClick: () => this.step(1) });
    this.researchBtn = h('button', {
      class: 'tb-btn small', title: 'Research: find evidence for a question', 'aria-label': 'Research', 'aria-pressed': 'false',
      html: icon('book-open', 15), onClick: () => { this.setResearch(!this.#research); this.searchInput.focus(); },
    });
    this.exportBtn = h('button', {
      class: 'tb-btn small', title: 'Export evidence', 'aria-label': 'Export evidence', hidden: true,
      html: icon('copy', 15), onClick: () => this.#exportEvidence(),
    });
    this.saveResearchBtn = h('button', {
      class: 'tb-btn small', title: 'Save this research', 'aria-label': 'Save this research', hidden: true,
      html: icon('save', 15), onClick: () => this.#saveResearch(),
    });
    this.searchBar = h('div', { class: 'structure-search', role: 'search' },
      h('div', { class: 'find-field' }, h('span', { class: 'find-glyph', html: icon('search', 14) }), this.searchInput),
      this.researchBtn, this.exportBtn, this.saveResearchBtn, this.caseBtn, this.wordBtn, this.prevBtn, this.nextBtn);
    this.searchStatus = h('div', { class: 'structure-summary structure-search-status', 'aria-live': 'polite', hidden: true });
    this.results = h('div', { class: 'structure-tree structure-results', role: 'list', 'aria-label': 'Search results', hidden: true });
    this.#updateSteps();
    this.#build();
  }

  #build() {
    const reason = this.view.textEditing.unavailableReason;
    if (reason && !this.view.encrypted) {
      this.el.replaceChildren(h('div', { class: 'panel-empty' },
        h('span', { html: icon('file-text', 22) }),
        h('strong', { text: 'No structure' }),
        h('span', { text: reason })));
      return;
    }
    const count = this.view.pdf.numPages;
    const pages = [];
    for (let number = 1; number <= count; number++) pages.push(this.#pageNode(number));
    this.tree.replaceChildren(...pages);
    this.#summarize();
    this.props.replaceChildren(h('p', { class: 'structure-hint', text: 'Select an object to see its properties.' }));
    this.el.replaceChildren(this.searchBar, this.searchStatus, this.summary, this.tree, this.results, this.props);
    this.#toggle(this.view.state.pageNumber, true);
    if (this.#search.query || this.#search.research) this.search(this.searchInput.value);
  }

  /** Opens the page shown now, when the tab comes up. */
  shown() {
    const number = this.view.state.pageNumber;
    const node = this.tree.querySelector(`[data-page="${number}"]`);
    if (node && !node.classList.contains('open')) this.#toggle(number, true);
  }

  destroy() {
    this.#search.id++;
    this.#abort.abort();
    this.#clearMark();
  }

  /** The document was rebuilt after a change made in Vellum: reads again the pages it touched, or every page when the page list changed. */
  documentChanged() {
    if (this.#replan || this.tree.querySelectorAll('.structure-page').length !== this.view.pdf.numPages) {
      const open = [...this.tree.querySelectorAll('.structure-page.open')].map((n) => Number(n.dataset.page));
      this.#replan = false;
      this.#pages.clear();
      this.#readEdits.clear();
      this.#unselect();
      this.#build();
      for (const n of open) if (n <= this.view.pdf.numPages) this.#toggle(n, true);
      return;
    }
    const stale = [...this.#readEdits].filter(([number, edits]) => {
      const now = this.#editsOn(number);
      return now.length !== edits.length || now.some((e, i) => e !== edits[i]);
    });
    for (const [number] of stale) this.#reread(number);
    this.#summarize();
    if (stale.length && (this.#search.query || this.#search.research)) this.search(this.searchInput.value);
  }

  /** The content edits (text, pictures, redactions…) on a page as shown now. */
  #editsOn(number) {
    const entry = this.view.shownPlan?.[number - 1];
    return entry ? this.view.annotations.edits.filter((e) => e.entry === entry.id) : [];
  }

  /** Reads a changed page again: at once when it is open, else when it is next opened. */
  #reread(number) {
    this.#pages.delete(number);
    this.#readEdits.delete(number);
    const node = this.tree.querySelector(`[data-page="${number}"]`);
    if (!node) return;
    delete node.dataset.read;
    if (this.#selected?.number === number) this.#unselect();
    if (node.classList.contains('open')) this.#toggle(number, true);
  }

  #unselect() {
    this.#selected = null;
    this.#clearMark();
    this.props.replaceChildren(h('p', { class: 'structure-hint', text: 'Select an object to see its properties.' }));
  }

  #summarize() {
    const count = this.view.pdf.numPages;
    const read = [...this.tree.querySelectorAll('.structure-page[data-read]')].length;
    this.summary.textContent = `${count} ${count === 1 ? 'page' : 'pages'}${read < count ? ` · ${read} read` : ''}`;
  }

  #pageNode(number) {
    const node = h('div', { class: 'structure-page', role: 'treeitem', 'aria-expanded': 'false', 'data-page': String(number) });
    const head = h('button', { class: 'structure-row structure-page-row', onClick: () => this.#toggle(number) },
      h('span', { class: 'structure-caret', html: icon('chevron-right', 14) }),
      h('span', { class: 'structure-label', text: `Page ${number}` }),
      h('span', { class: 'structure-count' }));
    node.append(head, h('div', { class: 'structure-children', role: 'group' }));
    return node;
  }

  #read(number) {
    if (!this.#pages.has(number)) {
      this.#readEdits.set(number, this.#editsOn(number));
      this.#pages.set(number, this.view.encrypted ? readPdfPage(this.view.pdf, number) : readSessionPage(this.view.textEditing, this.view.pdf, number));
    }
    return this.#pages.get(number);
  }

  async #toggle(number, open) {
    const node = this.tree.querySelector(`[data-page="${number}"]`);
    if (!node) return;
    open ??= !node.classList.contains('open');
    node.classList.toggle('open', open);
    node.setAttribute('aria-expanded', String(open));
    if (!open || node.dataset.read !== undefined) return;
    const children = node.querySelector('.structure-children');
    children.replaceChildren(h('p', { class: 'structure-hint', text: 'Reading page…' }));
    let page;
    const reading = this.#read(number);
    try {
      page = await reading;
    } catch (err) {
      if (this.#pages.get(number) === reading) this.#pages.delete(number);
      children.replaceChildren(h('p', { class: 'structure-hint', text: err.message }));
      return;
    }
    if (this.#pages.get(number) !== reading) return; // read again meanwhile: that read fills the page
    node.dataset.read = '';
    node.querySelector('.structure-count').textContent = String(pageCounts(page).total);
    node.querySelector('.structure-page-row').title = countsLabel(page);
    const groups = pageRows(page);
    const note = pageNote(page);
    children.replaceChildren(
      ...(note ? [h('p', { class: 'structure-hint structure-note', text: note })] : []),
      ...(groups.length ? groups.map((g) => this.#group(g, number)) : [h('p', { class: 'structure-hint', text: 'Nothing found on this page.' })]));
    this.#summarize();
  }

  #group(group, number) {
    const node = h('div', { class: 'structure-group open', 'data-group': group.key });
    const head = h('button', { class: 'structure-row structure-group-row', onClick: () => node.classList.toggle('open') },
      h('span', { class: 'structure-caret', html: icon('chevron-right', 14) }),
      h('span', { class: 'structure-icon', html: icon(group.icon, 14) }),
      h('span', { class: 'structure-label', text: group.label }),
      h('span', { class: 'structure-count', text: String(group.rows.length) }));
    node.append(head, h('div', { class: 'structure-children' }, ...group.rows.map((row) => this.#row(row, number, 0))));
    return node;
  }

  #row(row, number, depth) {
    const el = h('button', {
      class: 'structure-row structure-item', role: 'treeitem', 'data-id': row.id, 'data-kind': row.kind, title: row.label,
      style: { paddingInlineStart: `${22 + depth * 14}px` },
      onClick: () => this.select(row, number, el),
    }, h('span', { class: 'structure-label', text: row.label }));
    if (!row.children?.length) return el;
    return h('div', { class: 'structure-block' }, el, ...row.children.map((child) => this.#row(child, number, depth + 1)));
  }

  /** Searches the document's structure (semantic/query.js), page after page; an empty query shows the tree again. */
  async search(text) {
    if (this.#research) return this.#runResearch(text);
    const query = parseQuery(text, this.#options);
    const id = this.#search.id + 1;
    const empty = isEmptyQuery(query);
    this.#search = { id, text: String(text ?? ''), query: empty ? null : query, results: [], index: -1, reading: !empty };
    this.tree.hidden = !empty;
    this.summary.hidden = !empty;
    this.results.hidden = empty;
    this.searchStatus.hidden = empty;
    this.results.replaceChildren();
    this.#updateSteps();
    if (empty) return;
    const count = this.view.pdf.numPages;
    const content = needsContent(query) || this.view.encrypted;
    let capped = false;
    for (let number = 1; number <= count && !capped; number++) {
      const found = this.#search.results.length;
      this.searchStatus.textContent = `${describeQuery(query)} · ${found ? `${found} found · ` : ''}reading page ${number} of ${count}…`;
      let page = null;
      try {
        page = content || this.#pages.has(number) ? await this.#read(number) : await readPdfPage(this.view.pdf, number);
      } catch {
        // a page that can't be read has no results
      }
      if (id !== this.#search.id) return; // a newer query took over
      for (const result of page ? matchPage(page, query) : []) {
        if (this.#search.results.length >= MAX_RESULTS) { capped = true; break; }
        this.#addResult(result);
      }
      this.#updateSteps();
      await new Promise((resolve) => setTimeout(resolve)); // input and painting between pages
      if (id !== this.#search.id) return;
    }
    this.#search.reading = false;
    const n = this.#search.results.length;
    if (!n) this.results.replaceChildren(h('p', { class: 'structure-hint', text: 'Nothing found.' }));
    this.#updateSteps(capped);
  }

  /** Research on or off: the field asks a question (semantic/research.js) or searches, and what it holds is run again. */
  setResearch(on) {
    this.#research = Boolean(on);
    this.researchBtn.setAttribute('aria-pressed', String(this.#research));
    this.caseBtn.hidden = this.wordBtn.hidden = this.#research;
    this.exportBtn.hidden = this.saveResearchBtn.hidden = !this.#research;
    this.searchInput.placeholder = this.#research ? 'Ask a research question' : 'Search structure';
    this.searchInput.setAttribute('aria-label', this.#research ? 'Research question' : 'Search the document structure');
    this.search(this.searchInput.value);
  }

  /**
   * The document evidence is quoted from, as provenance references it: its name and path, and the content key
   * the host gave when its bytes were read (view.docKey). Editing and saving the file give it another key, so
   * this is the file as it was opened — Vellum keeps no identity beyond that and none is invented here.
   */
  #documentRef() {
    return documentRef({ name: this.view.file?.name, path: this.view.file?.path, contentKey: this.view.docKey ?? null });
  }

  /** Evidence for a question: every page's text read, passages ranked by the key terms they hold; nothing guessed. */
  async #runResearch(text) {
    const terms = researchTerms(text);
    const id = this.#search.id + 1;
    const empty = !String(text ?? '').trim();
    this.#search = { id, text: String(text ?? ''), query: null, research: !empty, results: [], index: -1, reading: !empty };
    this.tree.hidden = this.summary.hidden = !empty;
    this.results.hidden = this.searchStatus.hidden = empty;
    this.results.replaceChildren();
    this.exportBtn.disabled = this.saveResearchBtn.disabled = true;
    this.#updateSteps();
    if (empty) return;
    const count = this.view.pdf.numPages;
    const candidates = [];
    if (this.view.encrypted) {
      this.searchStatus.textContent = 'Research';
    } else if (terms.length) {
      for (let number = 1; number <= count; number++) {
        this.searchStatus.textContent = `Researching · reading page ${number} of ${count}…`;
        let page = null;
        try {
          page = await this.#read(number);
        } catch {
          // a page that can't be read gives no evidence
        }
        if (id !== this.#search.id) return; // a newer question took over
        if (page) candidates.push(...pageCandidates(page, terms));
        await new Promise((resolve) => setTimeout(resolve)); // input and painting between pages
        if (id !== this.#search.id) return;
      }
    }
    const found = rankEvidence(terms, candidates, { document: this.#documentRef(), source: SOURCES.document });
    const summary = this.view.encrypted ? 'Not enough evidence: the text of a protected PDF isn’t read, so it can’t be researched.' : found.summary;
    this.#search.reading = false;
    this.results.append(
      h('div', { class: 'structure-props-title research-heading', text: 'Summary · by Vellum, from the matches' }),
      h('p', { class: 'structure-hint research-summary', 'data-sufficient': String(found.sufficient), text: summary }));
    if (found.sufficient) {
      this.results.append(h('div', { class: 'structure-props-title research-heading', text: 'Evidence · quoted from the document' }));
      for (const item of found.evidence) this.#addEvidence(item);
    }
    this.searchStatus.textContent = found.sufficient ? `Research · ${found.evidence.length} ${found.evidence.length === 1 ? 'passage' : 'passages'}` : 'Research · no evidence';
    this.exportBtn.disabled = this.saveResearchBtn.disabled = !found.sufficient;
    this.#updateSteps();
  }

  /** Keeps the research shown now (semantic/saved-research.js). The result is written as it stands; nothing is run again. */
  async #saveResearch() {
    const research = this.research;
    if (!research?.sufficient) return toast('No evidence to save.', { timeout: 4000 });
    await saveResearchDialog({
      bridge,
      record: savedResearchRecord({
        question: this.#search.text,
        source: research.source,
        document: research.document,
        summary: research.summary,
        sufficient: research.sufficient,
        evidence: research.evidence,
      }),
    });
  }

  /** Copies the evidence shown now as tab-separated text: question, page, quote, matched terms, kind — one row each, in the shown order. */
  #exportEvidence() {
    const evidence = this.#search.results.map(({ result }) => result);
    if (!evidence.length) return toast('No evidence to export.', { timeout: 4000 });
    copyText(evidenceToTsv(this.#search.text, evidence, this.view.file.name));
    toast(`Copied ${evidence.length} ${evidence.length === 1 ? 'passage' : 'passages'} of evidence`, { kind: 'success' });
  }

  #addEvidence(item) {
    const index = this.#search.results.length;
    const el = h('button', {
      class: 'structure-row structure-item research-evidence', role: 'listitem', 'data-id': item.id, 'data-kind': item.kind, 'data-page': String(item.number),
      // Where the passage came from, in full, on the row it came from: the file, its page and the object's ID.
      title: provenanceDetail(item.provenance),
      onClick: () => this.#selectResult(index),
    },
    h('span', { class: 'research-quote', text: `“${item.text}”` }),
    h('span', { class: 'research-source', text: `Page ${item.number} · ${kindName(item.kind)} · matches ${item.matched.map((t) => `“${t}”`).join(', ')}` }));
    this.#search.results.push({ result: item, el });
    this.results.append(el);
  }

  /**
   * The research shown: { source, document, summary, sufficient, evidence: [{ id, kind, page, text, matched, box,
   * provenance }] }, for tests and later features. Every value is JSON-safe, so what a feature exports is what
   * it reads here; `provenance` is semantic/provenance.js's record of where the passage came from.
   */
  get research() {
    if (!this.#search.research || this.#search.reading) return null;
    const summary = this.results.querySelector('.research-summary');
    return {
      source: SOURCES.document,
      document: this.#documentRef(),
      summary: summary?.textContent ?? '',
      sufficient: summary?.dataset.sufficient === 'true',
      evidence: this.#search.results.map(({ result }) => ({
        id: result.id, kind: result.kind, page: result.number, text: result.text, matched: result.matched, box: result.box ?? null, provenance: result.provenance ?? null,
      })),
    };
  }

  /** Selects the next (1) or previous (-1) search result, wrapping around. */
  step(delta) {
    const { results, index } = this.#search;
    if (!results.length) return;
    this.#selectResult(index < 0 ? (delta > 0 ? 0 : results.length - 1) : (index + delta + results.length) % results.length);
  }

  /** Starts the typed query at once when it isn't the one searched: Enter doesn't wait for the pause in typing. */
  async #searchNow() {
    if (this.searchInput.value === this.#search.text) return;
    this.search(this.searchInput.value);
    // The first result is enough to step to; the rest follow.
    while (this.#search.reading && !this.#search.results.length) await new Promise((resolve) => setTimeout(resolve, 30));
  }

  #addResult(result) {
    const index = this.#search.results.length;
    const el = h('button', {
      class: 'structure-row structure-item structure-result', role: 'listitem', 'data-id': result.id, 'data-kind': result.kind, title: result.label,
      onClick: () => this.#selectResult(index),
    },
    h('span', { class: 'structure-kind', text: kindName(result.kind) }),
    h('span', { class: 'structure-label', text: result.label }),
    h('span', { class: 'structure-count', text: `p. ${result.number}` }));
    this.#search.results.push({ result, el });
    this.results.append(el);
  }

  #selectResult(index) {
    const entry = this.#search.results[index];
    if (!entry) return;
    this.#search.index = index;
    this.select(entry.result, entry.result.number, entry.el);
    entry.el.scrollIntoView({ block: 'nearest' });
    this.#updateSteps();
  }

  /** Previous and Next, and the status line: what is searched, how far, and which result is selected. */
  #updateSteps(capped = false) {
    const { results, index, query, reading } = this.#search;
    this.prevBtn.disabled = this.nextBtn.disabled = !results.length;
    if (!query || reading) return;
    const n = results.length;
    const total = capped ? `first ${MAX_RESULTS} results` : n === 1 ? '1 result' : `${n || 'No'} results`;
    this.searchStatus.textContent = `${describeQuery(query)} · ${index >= 0 ? `${index + 1} of ${n}` : total}`;
  }

  /** Selects an object: its properties below, its page shown, its box marked on the page for a moment. */
  select(row, number, el = this.tree.querySelector(`[data-id="${CSS.escape(row.id)}"]`)) {
    this.#selected?.el?.removeAttribute('aria-selected');
    el?.setAttribute('aria-selected', 'true');
    this.#selected = { row, number, el };
    this.props.replaceChildren(
      h('div', { class: 'structure-props-title', text: kindName(row.kind) }),
      h('dl', {}, ...properties(row.kind, row.item).flatMap(([label, value]) => [h('dt', { text: label }), h('dd', { text: value })])));
    this.view.goToPage(number);
    this.#markBox(number, row.item);
  }

  /** A brief outline over the object's box, in the page element so it follows zoom; the page stays the same. */
  #markBox(number, item) {
    this.#clearMark();
    this.#mark = markPageBox(this.view, number, itemBox(item), { ms: MARK_MS });
  }

  #clearMark() {
    this.#mark?.clear();
    this.#mark = null;
  }
}

const KIND_NAMES = { block: 'Paragraph', run: 'Text run', image: 'Image', field: 'Form field', annotation: 'Annotation', link: 'Link' };
const kindName = (kind) => KIND_NAMES[kind] ?? 'Object';
