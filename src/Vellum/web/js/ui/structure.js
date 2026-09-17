import { h, reducedMotion } from '../dom.js';
import { icon } from '../icons.js';
import { readSessionPage } from '../semantic/model.js';
import { countsLabel, pageCounts, pageRows, properties } from '../semantic/inspector.js';

// The Structure tab of the sidebar: the semantic document model (semantic/model.js) of the document, page
// by page — text blocks and their runs, images, form fields, annotations and links — with the properties of
// the one selected. Read-only: selecting an object goes to its page and marks its box for a moment, and
// nothing in the document, the model or Edit mode's selection changes. A page is read when it is opened
// (through the editing session's analysis, which is the editor's own and done once per page).

const MARK_MS = 2400;

export class StructurePanel {
  #pages = new Map(); // page number → Promise of its model
  #selected = null; // { row, number, el }
  #mark = null;

  constructor(view) {
    this.view = view;
    this.el = h('div', { class: 'structure' });
    this.tree = h('div', { class: 'structure-tree', role: 'tree', 'aria-label': 'Document structure' });
    this.props = h('div', { class: 'structure-props', 'aria-live': 'polite' });
    this.summary = h('div', { class: 'structure-summary' });
    this.#build();
  }

  #build() {
    const reason = this.view.textEditing.unavailableReason;
    if (reason) {
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
    this.el.replaceChildren(this.summary, this.tree, this.props);
    this.#toggle(this.view.state.pageNumber, true);
  }

  /** Opens the page shown now, when the tab comes up. */
  shown() {
    const number = this.view.state.pageNumber;
    const node = this.tree.querySelector(`[data-page="${number}"]`);
    if (node && !node.classList.contains('open')) this.#toggle(number, true);
  }

  destroy() {
    this.#clearMark();
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
    if (!this.#pages.has(number)) this.#pages.set(number, readSessionPage(this.view.textEditing, this.view.pdf, number));
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
    try {
      page = await this.#read(number);
    } catch (err) {
      this.#pages.delete(number);
      children.replaceChildren(h('p', { class: 'structure-hint', text: err.message }));
      return;
    }
    node.dataset.read = '';
    node.querySelector('.structure-count').textContent = String(pageCounts(page).total);
    node.querySelector('.structure-page-row').title = countsLabel(page);
    const groups = pageRows(page);
    children.replaceChildren(...(groups.length ? groups.map((g) => this.#group(g, number)) : [h('p', { class: 'structure-hint', text: 'Nothing found on this page.' })]));
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
    const pageView = this.view.viewer.getPageView(number - 1);
    const rect = item.box ?? quadBox(item.quad);
    if (!pageView?.div || !rect) return;
    const vp = pageView.viewport;
    const [ax, ay] = vp.convertToViewportPoint(rect[0], rect[1]);
    const [bx, by] = vp.convertToViewportPoint(rect[2], rect[3]);
    const pad = 2;
    const mark = h('div', {
      class: 'structure-mark', 'aria-hidden': 'true',
      style: {
        left: `${((Math.min(ax, bx) - pad) / vp.width) * 100}%`,
        top: `${((Math.min(ay, by) - pad) / vp.height) * 100}%`,
        width: `${((Math.abs(bx - ax) + pad * 2) / vp.width) * 100}%`,
        height: `${((Math.abs(by - ay) + pad * 2) / vp.height) * 100}%`,
      },
    });
    pageView.div.append(mark);
    requestAnimationFrame(() => mark.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: reducedMotion() ? 'auto' : 'smooth' }));
    this.#mark = { el: mark, timer: setTimeout(() => this.#clearMark(), MARK_MS) };
  }

  #clearMark() {
    if (!this.#mark) return;
    clearTimeout(this.#mark.timer);
    this.#mark.el.remove();
    this.#mark = null;
  }
}

const KIND_NAMES = { block: 'Paragraph', run: 'Text run', image: 'Image', field: 'Form field', annotation: 'Annotation', link: 'Link' };
const kindName = (kind) => KIND_NAMES[kind] ?? 'Object';

function quadBox(quad) {
  if (!quad || quad.length < 8) return null;
  const xs = [quad[0], quad[2], quad[4], quad[6]];
  const ys = [quad[1], quad[3], quad[5], quad[7]];
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}
