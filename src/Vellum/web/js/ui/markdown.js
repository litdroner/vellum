import { h } from '../dom.js';

// A small, safe subset of Markdown for release notes: headings, paragraphs, bullet and numbered lists,
// **bold**, *italic*, `code` and [links](https://…). Built from DOM nodes, never innerHTML, so the
// notes can't inject markup into the app. Links open in the browser.

const INLINE = /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\([^)\s]+\)|\*[^*\s][^*]*\*)/g;

function inline(text) {
  const out = [];
  let last = 0;
  for (const match of text.matchAll(INLINE)) {
    if (match.index > last) out.push(text.slice(last, match.index));
    const token = match[0];
    if (token.startsWith('**')) {
      out.push(h('strong', {}, ...inline(token.slice(2, -2))));
    } else if (token.startsWith('`')) {
      out.push(h('code', { text: token.slice(1, -1) }));
    } else if (token.startsWith('[')) {
      const [, label, href] = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(token);
      out.push(/^https:\/\//i.test(href)
        ? h('a', { href, onClick: (e) => { e.preventDefault(); window.open(href, '_blank'); } }, ...inline(label))
        : label);
    } else {
      out.push(h('em', {}, ...inline(token.slice(1, -1))));
    }
    last = match.index + token.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function renderMarkdown(source) {
  const root = h('div', { class: 'md' });
  let paragraph = [];
  let list = null;
  const flush = () => {
    if (paragraph.length) root.append(h('p', {}, ...inline(paragraph.join(' '))));
    paragraph = [];
  };

  for (const raw of String(source ?? '').replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.trim();
    const heading = /^(#{1,6})\s+(.+)$/.exec(line);
    const item = /^(?:[-*+]|(\d+)[.)])\s+(.+)$/.exec(line);
    if (!line || /^([-*_])\1{2,}$/.test(line)) {
      flush();
      list = null;
    } else if (heading) {
      flush();
      list = null;
      root.append(h(heading[1].length <= 2 ? 'h3' : 'h4', {}, ...inline(heading[2])));
    } else if (item) {
      flush();
      const tag = item[1] ? 'ol' : 'ul';
      if (list?.tagName.toLowerCase() !== tag) {
        list = h(tag);
        root.append(list);
      }
      list.append(h('li', {}, ...inline(item[2])));
    } else if (list && /^\s{2,}/.test(raw)) {
      list.lastElementChild?.append(' ', ...inline(line)); // a wrapped list item
    } else {
      list = null;
      paragraph.push(line);
    }
  }
  flush();
  return root;
}
