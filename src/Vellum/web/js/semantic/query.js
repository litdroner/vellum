// Semantic search: a short query over the semantic document model (semantic/model.js) — text, or objects
// of one kind — matched page by page. Deterministic and local: plain string matching on what the model
// already holds, nothing inferred, nothing indexed ahead. Pure.
//
// A query is, in this order and each part optional:
//   [all] [editable | non-editable] [text | images | form fields | annotations | links] [containing | exactly] [words]
//
//   transformer                      text containing "transformer"
//   all images                       every image
//   all form fields / all links      every field / every link
//   editable text containing method  text runs Vellum can edit that contain "method"
//   links containing example.com     links whose destination contains it
//   exactly Figure 1: a picture      text (or a field, note or link) whose whole text is that
//   "all images"                     quoted: the words themselves, as text
//
// Matching ignores case and treats any run of white space (a line break in a paragraph too) as one space.
// Text is matched per block (a paragraph, or a line of its own); with an editable filter, per text run,
// since editability is a run's. A field matches on its name and value, an annotation on its contents, a
// link on its URL; asked for by kind, an annotation on its subtype too and a link on the page it goes to ("page 2"). Images have no text: words never match one.

// A kind word ends the query or is followed by a space: "links" and "links to…" are kinds, "linksys" is a word.
const TYPES = [
  [/^(text|paragraphs?)(\s+|$)/i, 'text'],
  [/^(images?|pictures?)(\s+|$)/i, 'image'],
  [/^(form\s+fields?|fields?)(\s+|$)/i, 'field'],
  [/^(annotations?|comments?)(\s+|$)/i, 'annotation'],
  [/^(links?)(\s+|$)/i, 'link'],
];
const EDITABLE = /^(editable|non-?editable|not\s+editable|uneditable)(\s+|$)/i;
const HOW = /^(containing|contains|matching|with|exactly|equals|equal\s+to)(\s+|$)/i;

const norm = (s) => String(s ?? '').replace(/\s+/g, ' ').trim().toLowerCase();

/** A query string as { type: null | 'text' | 'image' | 'field' | 'annotation' | 'link', editable: null | boolean, match: 'contains' | 'exact', text }. */
export function parseQuery(input) {
  const query = { type: null, editable: null, match: 'contains', text: '' };
  let rest = String(input ?? '').trim();
  const unquote = (s) => { const m = /^"([^"]*)"?$/.exec(s); return norm(m ? m[1] : s); };
  if (/^"/.test(rest)) return { ...query, text: unquote(rest) };
  const eat = (re) => {
    const m = re.exec(rest);
    if (m) rest = rest.slice(m[0].length).trimStart();
    return m;
  };
  // "all" only leads a kind or a filter; otherwise it is one of the words searched for.
  const after = rest.replace(/^all\s+/i, '');
  if (after !== rest && (EDITABLE.test(after) || TYPES.some(([re]) => re.test(after)))) rest = after;
  const editable = eat(EDITABLE);
  if (editable) query.editable = !/^(non|not|un)/i.test(editable[1]);
  for (const [re, type] of TYPES) if (eat(re)) { query.type = type; break; }
  if (query.editable !== null) query.type ??= 'text';
  // containing / exactly: after a kind or filter, or leading a query of words.
  const how = eat(query.type ? HOW : /^(containing|exactly)\s+/i);
  if (how && /^(exactly|equals|equal)/i.test(how[1])) query.match = 'exact';
  query.text = unquote(rest);
  return query;
}

/** True when the query asks for nothing: no kind, no filter, no words. */
export function isEmptyQuery(query) {
  return !query.type && query.editable === null && !query.text;
}

/** True when the query can only match fields, annotations or links: a page's text and images needn't be read. */
export function needsContent(query) {
  return query.type === null || query.type === 'text' || query.type === 'image';
}

function textMatches(query, ...values) {
  if (!query.text) return true;
  const list = values.filter((v) => v != null && v !== '').map(norm);
  return query.match === 'exact' ? list.some((v) => v === query.text) : list.some((v) => v.includes(query.text));
}

const clip = (text, max = 70) => {
  const line = String(text ?? '').replace(/\s+/g, ' ').trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};

/**
 * A page's matches in the order the Structure panel lists them (text in reading order, then images, fields,
 * annotations and links): [{ id, kind, number, label, item }], kind as the inspector names it (block, run,
 * image, field, annotation, link).
 */
export function matchPage(page, query) {
  if (isEmptyQuery(query)) return [];
  const results = [];
  const add = (kind, item, label) => results.push({ id: item.id, kind, number: page.number, label, item });
  const wants = (type) => query.type === null || query.type === type;

  if (wants('text')) {
    const runs = new Map(page.runs.map((r) => [r.id, r]));
    for (const blockId of page.readingOrder) {
      const block = page.blocks.find((b) => b.id === blockId);
      if (!block) continue;
      const blockRuns = block.runIds.map((id) => runs.get(id)).filter(Boolean);
      if (query.editable !== null) {
        for (const run of blockRuns) if (run.editable === query.editable && textMatches(query, run.text)) add('run', run, clip(run.text) || 'Text');
      } else if (textMatches(query, block.text)) {
        if (block.kind === 'line' && blockRuns[0]) add('run', blockRuns[0], clip(blockRuns[0].text) || 'Text');
        else add('block', block, clip(block.text) || 'Paragraph');
      }
    }
  }
  if (query.editable !== null) return results;
  if (wants('image') && !query.text) {
    page.images.forEach((image, i) => add('image', image, image.pixels ? `Image ${i + 1} · ${image.pixels[0]}×${image.pixels[1]}` : `Image ${i + 1}`));
  }
  if (wants('field')) {
    for (const field of page.fields) {
      const value = Array.isArray(field.value) ? field.value.join(', ') : field.value;
      if (textMatches(query, field.name, value)) add('field', field, `${field.name || 'Unnamed'} · ${field.type}`);
    }
  }
  if (wants('annotation')) {
    for (const a of page.annotations) if (textMatches(query, a.contents, query.type && a.subtype)) add('annotation', a, a.contents ? `${a.subtype} · ${clip(a.contents, 40)}` : a.subtype);
  }
  if (wants('link')) {
    for (const link of page.links) {
      const to = query.type && link.page ? `page ${link.page}` : null;
      if (textMatches(query, link.url, to)) add('link', link, link.url ? clip(link.url, 50) : link.page ? `Link to page ${link.page}` : 'Link');
    }
  }
  return results;
}

/** What a query looks for, in a few words: "Editable text containing “method”". */
export function describeQuery(query) {
  const kinds = { text: 'Text', image: 'Images', field: 'Form fields', annotation: 'Annotations', link: 'Links' };
  let what = query.type ? kinds[query.type] : 'Anything';
  if (query.editable === true) what = `Editable ${what.toLowerCase()}`;
  if (query.editable === false) what = `Non-editable ${what.toLowerCase()}`;
  if (!query.text) return what;
  return `${what} ${query.match === 'exact' ? 'exactly' : 'containing'} “${query.text}”`;
}
