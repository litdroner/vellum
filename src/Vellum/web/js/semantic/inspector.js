// What the Structure panel shows of the semantic document model (semantic/model.js): each page's objects
// as rows, how many there are, and the properties of one. Pure, and read-only like the model: nothing here
// changes a page or an object, and every value shown is one the model already has.

const pt = (n) => `${Math.round(n * 10) / 10}`;
const clip = (text, max = 60) => {
  const line = String(text ?? '').replace(/\s+/g, ' ').trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};

export const GROUPS = Object.freeze([
  { key: 'text', label: 'Text', icon: 'type' },
  { key: 'images', label: 'Images', icon: 'image' },
  { key: 'fields', label: 'Form fields', icon: 'text-cursor-input' },
  { key: 'annotations', label: 'Annotations', icon: 'sticky-note' },
  { key: 'links', label: 'Links', icon: 'external-link' },
]);

/** How many of each kind of object a page has: { blocks, runs, images, fields, annotations, links, total }. */
export function pageCounts(page) {
  const counts = {
    blocks: page.blocks.length,
    runs: page.runs.length,
    images: page.images.length,
    fields: page.fields.length,
    annotations: page.annotations.length,
    links: page.links.length,
  };
  counts.total = counts.blocks + counts.images + counts.fields + counts.annotations + counts.links;
  return counts;
}

/** A page's counts in a few words: "3 text blocks · 1 image", or "Nothing found". */
export function countsLabel(page) {
  const c = pageCounts(page);
  const parts = [
    [c.blocks, 'text block', 'text blocks'],
    [c.images, 'image', 'images'],
    [c.fields, 'field', 'fields'],
    [c.annotations, 'annotation', 'annotations'],
    [c.links, 'link', 'links'],
  ].filter(([n]) => n > 0).map(([n, one, many]) => `${n} ${n === 1 ? one : many}`);
  return parts.length ? parts.join(' · ') : 'Nothing found';
}

/**
 * A page's rows, grouped as GROUPS: { key, label, icon, rows }, empty groups left out. A row is
 * { id, kind, label, item, children? }: a paragraph's children are its runs; a one-line block is its run.
 */
export function pageRows(page) {
  const runs = new Map(page.runs.map((r) => [r.id, r]));
  const text = page.readingOrder.map((blockId) => page.blocks.find((b) => b.id === blockId)).filter(Boolean).map((block) => {
    if (block.kind === 'line') {
      const run = runs.get(block.runIds[0]);
      return { id: run.id, kind: 'run', label: clip(run.text) || 'Text', item: run };
    }
    return {
      id: block.id, kind: 'block', label: clip(block.text) || 'Paragraph', item: block,
      children: block.runIds.map((id) => runs.get(id)).filter(Boolean).map((run) => ({ id: run.id, kind: 'run', label: clip(run.text) || 'Text', item: run })),
    };
  });
  const rows = {
    text,
    images: page.images.map((image, i) => ({ id: image.id, kind: 'image', label: image.pixels ? `Image ${i + 1} · ${image.pixels[0]}×${image.pixels[1]}` : `Image ${i + 1}`, item: image })),
    fields: page.fields.map((field) => ({ id: field.id, kind: 'field', label: `${field.name || 'Unnamed'} · ${field.type}`, item: field })),
    annotations: page.annotations.map((a) => ({ id: a.id, kind: 'annotation', label: a.contents ? `${a.subtype} · ${clip(a.contents, 40)}` : a.subtype, item: a })),
    links: page.links.map((link) => ({ id: link.id, kind: 'link', label: link.url ? clip(link.url, 50) : link.internal ? 'Link within the document' : 'Link', item: link })),
  };
  return GROUPS.map((g) => ({ ...g, rows: rows[g.key] })).filter((g) => g.rows.length);
}

const yesNo = (v) => (v ? 'Yes' : 'No');
const boxSize = (box) => (box ? `${pt(box[2] - box[0])} × ${pt(box[3] - box[1])} pt` : 'Not known');
const boxAt = (box) => (box ? `${pt(box[0])}, ${pt(box[1])}` : 'Not known');

/** One object's properties as [label, value] pairs, every value a string. */
export function properties(kind, item) {
  const common = [['Size on page', boxSize(item.box)], ['Position', boxAt(item.box)], ['ID', item.id]];
  switch (kind) {
    case 'block':
      return [['Kind', item.kind === 'paragraph' ? 'Paragraph' : 'Line'], ['Lines', String(item.lines)], ['Text', item.text], ...common];
    case 'run':
      return [
        ['Text', item.text],
        ['Font', item.font ?? 'Not known'],
        ['Font size', item.size != null ? `${pt(item.size)} pt` : 'Not known'],
        ['Editable', yesNo(item.editable)],
        ['Invisible', yesNo(item.invisible)],
        ...common,
      ];
    case 'image':
      return [
        ['Pixels', item.pixels ? `${item.pixels[0]} × ${item.pixels[1]}` : 'Not known'],
        ['Type', item.inserted ? 'Added in Vellum' : item.inline ? 'Inline image' : 'Image object'],
        ...common,
      ];
    case 'field':
      return [
        ['Name', item.name || 'Unnamed'],
        ['Type', item.type],
        ['Value', item.value == null || item.value === '' ? 'Empty' : Array.isArray(item.value) ? item.value.join(', ') : String(item.value)],
        ['Read-only', yesNo(item.readOnly)],
        ...common,
      ];
    case 'annotation':
      return [['Subtype', item.subtype], ['Contents', item.contents ?? 'None'], ...common];
    case 'link':
      return [['Subtype', 'Link'], ['Destination', item.url ?? (item.internal ? 'A place in this document' : 'Not known')], ...common];
    default:
      return common;
  }
}
