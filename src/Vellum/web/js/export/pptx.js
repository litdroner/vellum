// Export Center — PDF to PowerPoint. Pure: it writes out what Vellum already reads and adds nothing.
//
// The source is the semantic document model (semantic/model.js) — the same one the Markdown and Word
// exports write from — and nothing else. One PDF page becomes one slide, in the document's own page
// order, and the page's text becomes real PowerPoint text boxes where the model's own boxes say where
// they sit. There is no second PDF parser here, no page rasterized into a slide, and no layout guessed:
// a slide is editable text on an empty slide, never a picture of the page with text on top.
//
// What is written, and only because it is already known:
//   slides      one per exported page, in page order, the deck's size the first page's own
//   text boxes  the model's blocks, one box each, placed and sized by the block's own box, its runs in
//               the model's order; a rotated page's boxes are placed and turned as the page is shown
//   bold, italic, size  the PDF's own font name for that run says bold or italic (export/docx.js
//               runStyle — the one place that reads a font name), and the run's own point size
//   tables      the tables Table extraction V1 is confident about (semantic/tables.js), as PowerPoint
//               tables of real cells, their columns as wide as the model's own boxes
//   links       a run a link annotation's own rectangle covers becomes a PowerPoint hyperlink
//
// What is not written, because the model cannot give it safely: images (the model holds an image's place
// and size but not its pixels, so no picture is invented, and the slide is never rasterized in its
// stead), colours, fonts, background art, vector drawings, columns, lists, headers and footers, form
// fields and annotations. A page whose text was not read (a protected PDF) says so instead of being
// filled in. This is a faithful editable deck, not a picture of the PDF, and it does not claim to be
// pixel-perfect.
//
// A deck has one slide size, which is the first exported page's. A page of a different size keeps its
// own placement, measured from its own page's edges, so its content may reach past the slide. A rotated
// page's tables are written as text boxes rather than turned tables, because a PowerPoint table cannot
// be turned.
//
//   documentPptx({ document, pages, tables }) -> Uint8Array   the .pptx bytes
//     document  { name, path, contentKey } as provenance's documentRef takes it
//     pages     the semantic pages to write, in order
//     tables    Map of page number -> the tables on it (semantic/tables.js pageTables().tables)

import { documentRef } from '../semantic/provenance.js';
import { blockTables } from '../semantic/tables.js';
import { XML_DECLARATION, xmlText, zipArchive } from './zip.js';
import { runStyle } from './docx.js';

const EMU = 12700;             // English metric units in a PDF point (1/72 inch)
const DEGREE = 60000;          // DrawingML's units in one degree
const LETTER = [612, 792];
const LINK_SLACK = 1;          // a link's rectangle is usually drawn a shade around its text
const BOX_SLACK = 2;           // points of room around a text box, so its own text is never clipped
const MIN_SIZE = 1;            // points: the smallest shape PowerPoint is given
const DEFAULT_TEXT = 11;       // points, when the model has no size for a run
const ROW_SLACK = 1.6;         // a table row is taller than the glyphs the model measured

const emu = (points) => Math.round(points * EMU);
const quarterTurns = (rotate) => ((Math.round((Number(rotate) || 0) / 90) % 4) + 4) % 4;

/** The page's own box, or US Letter when the model has none. */
const pageBox = (page) => (Array.isArray(page?.box) && page.box.length === 4 ? page.box : [0, 0, ...LETTER]);

/** The size of a page as it is shown, in points: its box, turned by its own rotation. */
export function shownSize(page) {
  const box = pageBox(page);
  const [w, h] = [box[2] - box[0], box[3] - box[1]];
  return quarterTurns(page?.rotate) % 2 ? { width: h, height: w } : { width: w, height: h };
}

/**
 * Where a box of the page belongs on its slide, as PowerPoint places a shape: the shape keeps its own
 * width and height and is turned about its centre, so one mapping covers every quarter turn.
 *   { x, y, cx, cy, rot }   points from the slide's top-left, and the turn in degrees clockwise
 */
export function placeBox(box, page) {
  const pb = pageBox(page);
  const [w, h] = [pb[2] - pb[0], pb[3] - pb[1]];
  const turns = quarterTurns(page?.rotate);
  const u = (box[0] + box[2]) / 2 - pb[0];   // from the page's left edge
  const v = (box[1] + box[3]) / 2 - pb[1];   // up from the page's bottom edge
  const centre = turns === 1 ? [v, u]
    : turns === 2 ? [w - u, v]
      : turns === 3 ? [h - v, w - u]
        : [u, h - v];
  const cx = Math.max(MIN_SIZE, box[2] - box[0]);
  const cy = Math.max(MIN_SIZE, box[3] - box[1]);
  return { x: centre[0] - cx / 2, y: centre[1] - cy / 2, cx, cy, rot: turns * 90 };
}

/** A placement as the xfrm every shape carries. */
function xfrm(at, { grow = 0 } = {}) {
  const cx = Math.max(MIN_SIZE, at.cx + grow * 2);
  const cy = Math.max(MIN_SIZE, at.cy + grow * 2);
  const rot = at.rot ? ` rot="${at.rot * DEGREE}"` : '';
  return `<a:xfrm${rot}><a:off x="${emu(at.x - grow)}" y="${emu(at.y - grow)}"/><a:ext cx="${emu(cx)}" cy="${emu(cy)}"/></a:xfrm>`;
}

const contains = (outer, inner) => Boolean(outer) && Boolean(inner)
  && inner[0] >= outer[0] - LINK_SLACK && inner[1] >= outer[1] - LINK_SLACK
  && inner[2] <= outer[2] + LINK_SLACK && inner[3] <= outer[3] + LINK_SLACK;

/** The link a run sits in, or null: the first whose own rectangle covers the run's box. */
const linkOf = (run, links) => links.find((link) => link.url && !link.internal && contains(link.box, run.box)) ?? null;

/** A run's point size in DrawingML's hundredths, from the model's own size and nothing else. */
const runSize = (size) => Math.round(Math.min(400, Math.max(1, Number(size) > 0 ? Number(size) : DEFAULT_TEXT)) * 100);

/** One run of text, with the little the model vouches for. */
function runXml(text, { bold = false, italic = false, size = DEFAULT_TEXT, linkId = null } = {}) {
  const props = `<a:rPr lang="en-US" sz="${runSize(size)}"${bold ? ' b="1"' : ''}${italic ? ' i="1"' : ''} dirty="0">`
    + `${linkId ? `<a:hlinkClick r:id="${linkId}"/>` : ''}</a:rPr>`;
  return `<a:r>${props}<a:t>${xmlText(text)}</a:t></a:r>`;
}

/** One text box: the shape PowerPoint edits as text. */
function textBoxXml(id, name, at, body, { grow = BOX_SLACK } = {}) {
  return `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${xmlText(name)}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>`
    + `<p:spPr>${xfrm(at, { grow })}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/></p:spPr>`
    + '<p:txBody><a:bodyPr wrap="square" lIns="0" tIns="0" rIns="0" bIns="0" anchor="t"><a:normAutofit/></a:bodyPr>'
    + `<a:lstStyle/>${body}</p:txBody></p:sp>`;
}

/**
 * A block's runs as PowerPoint runs, in the model's order, each hyperlinked where a link covers it.
 * The lines of a paragraph are joined by a space, as the Markdown and Word exports join them, so the
 * paragraph is one paragraph of text that PowerPoint wraps inside the block's own width.
 */
function blockParagraph(block, { runs, links, rels }) {
  const out = [];
  let previous = null;
  for (const id of block.runIds ?? []) {
    const run = runs.get(id);
    if (!run?.text) continue;
    const space = previous && !/\s$/.test(previous) && !/^\s/.test(run.text) ? ' ' : '';
    const link = rels ? linkOf(run, links) : null;
    out.push(runXml(space + run.text, {
      ...runStyle(run.font), size: run.size ?? DEFAULT_TEXT, linkId: link ? rels.for(link.url) : null,
    }));
    previous = run.text;
  }
  if (!out.length && block.text?.trim()) out.push(runXml(block.text.trim(), {}));
  return `<a:p>${out.join('')}</a:p>`;
}

/** The columns of a confident table, in points, from the model's own cell boxes. */
function columnWidths(table) {
  const widths = [];
  for (let c = 0; c < table.columnCount; c++) {
    const boxes = table.rows.map((row) => row[c]?.box).filter(Boolean);
    const span = boxes.length ? Math.max(...boxes.map((b) => b[2])) - Math.min(...boxes.map((b) => b[0])) : 0;
    widths.push(Math.max(MIN_SIZE, span));
  }
  return widths;
}

/** The rows of a confident table, in points, from the model's own cell boxes. */
function rowHeights(table, total) {
  const heights = table.rows.map((row) => {
    const boxes = row.map((cell) => cell?.box).filter(Boolean);
    return boxes.length ? Math.max(...boxes.map((b) => b[3] - b[1])) : 0;
  });
  const known = heights.filter((n) => n > 0);
  const fallback = known.length ? Math.max(...known) : total / Math.max(1, heights.length);
  return heights.map((n) => Math.max(MIN_SIZE, (n > 0 ? n : fallback) * ROW_SLACK));
}

/** One confident table as a PowerPoint table of real cells. Empty cells stay empty. */
function tableXml(id, table, at) {
  const widths = columnWidths(table);
  const heights = rowHeights(table, at.cy);
  const grid = widths.map((w) => `<a:gridCol w="${emu(w)}"/>`).join('');
  const rows = table.rows.map((row, r) => {
    const cells = row.map((cell) => {
      const text = cell?.text ? runXml(cell.text, {}) : '';
      return `<a:tc><a:txBody><a:bodyPr/><a:lstStyle/><a:p>${text}</a:p></a:txBody><a:tcPr/></a:tc>`;
    }).join('');
    return `<a:tr h="${emu(heights[r])}">${cells}</a:tr>`;
  }).join('');
  const cx = Math.max(at.cx, widths.reduce((n, w) => n + w, 0));
  const cy = Math.max(at.cy, heights.reduce((n, hgt) => n + hgt, 0));
  return `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="${id}" name="Table ${id}"/>`
    + '<p:cNvGraphicFramePr><a:graphicFrameLocks noGrp="1"/></p:cNvGraphicFramePr><p:nvPr/></p:nvGraphicFramePr>'
    + `<p:xfrm><a:off x="${emu(at.x)}" y="${emu(at.y)}"/><a:ext cx="${emu(cx)}" cy="${emu(cy)}"/></p:xfrm>`
    + '<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table">'
    + `<a:tbl><a:tblPr firstRow="1" bandRow="1"/><a:tblGrid>${grid}</a:tblGrid>${rows}</a:tbl>`
    + '</a:graphicData></a:graphic></p:graphicFrame>';
}

const UNREAD = 'Vellum doesn’t read the text of a protected PDF, so this page has none here.';

/** The shapes of one slide, in the page's reading order. Exported for the tests. */
export function pageShapes(page, { tables = [], rels = null } = {}) {
  const size = shownSize(page);
  if (page.contentRead === false) {
    const at = { x: 36, y: 36, cx: Math.max(MIN_SIZE, size.width - 72), cy: 24, rot: 0 };
    return textBoxXml(2, 'Page', at, `<a:p>${runXml(UNREAD, { italic: true })}</a:p>`, { grow: 0 });
  }
  const runs = new Map((page.runs ?? []).map((run) => [run.id, run]));
  const links = page.links ?? [];
  // A PowerPoint table cannot be turned, so a rotated page's tables stay text boxes, placed and turned
  // with everything else on the page rather than laid out wrongly as a table.
  const tableOfBlock = quarterTurns(page.rotate) ? new Map() : blockTables(page, tables);
  const done = new Set();
  const out = [];
  let id = 2;
  for (const block of page.blocks ?? []) {
    const table = tableOfBlock.get(block.id);
    if (table) {
      if (done.has(table.id)) continue;
      done.add(table.id);
      if (Array.isArray(table.box)) out.push(tableXml(id++, table, placeBox(table.box, page)));
      continue;
    }
    if (!block.text?.trim() || !Array.isArray(block.box)) continue;
    out.push(textBoxXml(id, `Text ${id}`, placeBox(block.box, page), blockParagraph(block, { runs, links, rels })));
    id++;
  }
  return out.join('');
}

const SPTREE_HEAD = '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>'
  + '<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>';

const NS = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" '
  + 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" '
  + 'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';

/** One slide: the page's shapes on an empty slide. */
function slideXml(page, { tables, rels }) {
  return `${XML_DECLARATION}<p:sld ${NS}><p:cSld><p:spTree>${SPTREE_HEAD}${pageShapes(page, { tables, rels })}`
    + '</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>';
}

const REL_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const relationship = (id, type, target, extra = '') => `<Relationship Id="${id}" Type="${REL_NS}/${type}" Target="${target}"${extra}/>`;
const relsPart = (body) => `${XML_DECLARATION}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${body}</Relationships>`;

/** The relationships one slide collects as it is written: its layout, then one per link URL. */
function slideRels() {
  const links = new Map();
  return {
    links,
    for(url) {
      if (!links.has(url)) links.set(url, `rId${links.size + 2}`);
      return links.get(url);
    },
    xml() {
      return relsPart(relationship('rId1', 'slideLayout', '../slideLayouts/slideLayout1.xml')
        + [...links].map(([url, id]) => relationship(id, 'hyperlink', xmlText(url), ' TargetMode="External"')).join(''));
    },
  };
}

// ---- the parts every deck carries, which say nothing about the PDF -------------------------------------

const ACCENTS = ['4472C4', 'ED7D31', 'A5A5A5', 'FFC000', '5B9BD5', '70AD47'];
const FILLS = '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>';
const THEME = `${XML_DECLARATION}<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Vellum">`
  + '<a:themeElements><a:clrScheme name="Vellum">'
  + '<a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1><a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1>'
  + '<a:dk2><a:srgbClr val="44546A"/></a:dk2><a:lt2><a:srgbClr val="E7E6E6"/></a:lt2>'
  + ACCENTS.map((c, i) => `<a:accent${i + 1}><a:srgbClr val="${c}"/></a:accent${i + 1}>`).join('')
  + '<a:hlink><a:srgbClr val="0563C1"/></a:hlink><a:folHlink><a:srgbClr val="954F72"/></a:folHlink></a:clrScheme>'
  + '<a:fontScheme name="Vellum">'
  + '<a:majorFont><a:latin typeface="Calibri Light"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont>'
  + '<a:minorFont><a:latin typeface="Calibri"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont></a:fontScheme>'
  + '<a:fmtScheme name="Vellum">'
  + `<a:fillStyleLst>${FILLS.repeat(3)}</a:fillStyleLst>`
  + `<a:lnStyleLst>${`<a:ln w="6350" cap="flat" cmpd="sng" algn="ctr">${FILLS}<a:prstDash val="solid"/></a:ln>`.repeat(3)}</a:lnStyleLst>`
  + `<a:effectStyleLst>${'<a:effectStyle><a:effectLst/></a:effectStyle>'.repeat(3)}</a:effectStyleLst>`
  + `<a:bgFillStyleLst>${FILLS.repeat(3)}</a:bgFillStyleLst>`
  + '</a:fmtScheme></a:themeElements></a:theme>';

const CLR_MAP = '<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" '
  + 'accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>';

const SLIDE_MASTER = `${XML_DECLARATION}<p:sldMaster ${NS}><p:cSld>`
  + '<p:bg><p:bgPr><a:solidFill><a:schemeClr val="lt1"/></a:solidFill><a:effectLst/></p:bgPr></p:bg>'
  + `<p:spTree>${SPTREE_HEAD}</p:spTree></p:cSld>${CLR_MAP}`
  + '<p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst></p:sldMaster>';

const SLIDE_LAYOUT = `${XML_DECLARATION}<p:sldLayout ${NS} type="blank" preserve="1">`
  + `<p:cSld name="Blank"><p:spTree>${SPTREE_HEAD}</p:spTree></p:cSld>`
  + '<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>';

const MASTER_RELS = relsPart(relationship('rId1', 'slideLayout', '../slideLayouts/slideLayout1.xml')
  + relationship('rId2', 'theme', '../theme/theme1.xml'));
const LAYOUT_RELS = relsPart(relationship('rId1', 'slideMaster', '../slideMasters/slideMaster1.xml'));
const ROOT_RELS = relsPart(relationship('rId1', 'officeDocument', 'ppt/presentation.xml')
  + '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>');

const PML = 'application/vnd.openxmlformats-officedocument.presentationml';

const contentTypes = (count) => `${XML_DECLARATION}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">`
  + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
  + '<Default Extension="xml" ContentType="application/xml"/>'
  + `<Override PartName="/ppt/presentation.xml" ContentType="${PML}.presentation.main+xml"/>`
  + `<Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="${PML}.slideMaster+xml"/>`
  + `<Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="${PML}.slideLayout+xml"/>`
  + Array.from({ length: count }, (_, i) => `<Override PartName="/ppt/slides/slide${i + 1}.xml" ContentType="${PML}.slide+xml"/>`).join('')
  + '<Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>'
  + '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>'
  + '</Types>';

/** Where this came from, in provenance's own terms, as the deck's own properties. */
function coreXml(ref, pages) {
  const numbers = pages.map((p) => p.number);
  const span = numbers.length ? `page${numbers.length === 1 ? '' : 's'} ${numbers[0]}${numbers.length > 1 ? `–${numbers.at(-1)}` : ''}` : 'no pages';
  const parts = [`Exported from ${ref.name || 'this document'} by Vellum — ${span}.`];
  if (ref.path) parts.push(ref.path);
  if (ref.contentKey) parts.push(`content ${ref.contentKey.slice(0, 12).toLowerCase()}… (the file as it was read)`);
  return `${XML_DECLARATION}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" `
    + 'xmlns:dc="http://purl.org/dc/elements/1.1/">'
    + `<dc:title>${xmlText(ref.name || 'Document')}</dc:title>`
    + `<dc:description>${xmlText(parts.join(' '))}</dc:description></cp:coreProperties>`;
}

/** The deck's own size, in points: the first exported page as it is shown, or US Letter. */
export function deckSize(pages) {
  const first = pages.find((p) => Array.isArray(p?.box)) ?? pages[0] ?? null;
  const size = first ? shownSize(first) : { width: LETTER[0], height: LETTER[1] };
  return { width: Math.max(MIN_SIZE, size.width), height: Math.max(MIN_SIZE, size.height) };
}

function presentationXml(pages, size) {
  const slides = pages.map((_, i) => `<p:sldId id="${256 + i}" r:id="rId${i + 2}"/>`).join('');
  return `${XML_DECLARATION}<p:presentation ${NS}>`
    + '<p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>'
    + `<p:sldIdLst>${slides}</p:sldIdLst>`
    + `<p:sldSz cx="${emu(size.width)}" cy="${emu(size.height)}"/>`
    + `<p:notesSz cx="${emu(size.height)}" cy="${emu(size.width)}"/></p:presentation>`;
}

const presentationRels = (count) => relsPart(relationship('rId1', 'slideMaster', 'slideMasters/slideMaster1.xml')
  + Array.from({ length: count }, (_, i) => relationship(`rId${i + 2}`, 'slide', `slides/slide${i + 1}.xml`)).join('')
  + relationship(`rId${count + 2}`, 'theme', 'theme/theme1.xml'));

/** The whole export as one PowerPoint deck. Deterministic: the same pages always give the same bytes. */
export async function documentPptx({ document = {}, pages = [], tables = null } = {}) {
  const ref = documentRef(document);
  const size = deckSize(pages);
  const parts = [
    { name: '[Content_Types].xml', data: contentTypes(pages.length) },
    { name: '_rels/.rels', data: ROOT_RELS },
    { name: 'docProps/core.xml', data: coreXml(ref, pages) },
    { name: 'ppt/presentation.xml', data: presentationXml(pages, size) },
    { name: 'ppt/_rels/presentation.xml.rels', data: presentationRels(pages.length) },
    { name: 'ppt/slideMasters/slideMaster1.xml', data: SLIDE_MASTER },
    { name: 'ppt/slideMasters/_rels/slideMaster1.xml.rels', data: MASTER_RELS },
    { name: 'ppt/slideLayouts/slideLayout1.xml', data: SLIDE_LAYOUT },
    { name: 'ppt/slideLayouts/_rels/slideLayout1.xml.rels', data: LAYOUT_RELS },
    { name: 'ppt/theme/theme1.xml', data: THEME },
  ];
  pages.forEach((page, i) => {
    const rels = slideRels();
    const xml = slideXml(page, { tables: tables?.get(page.number) ?? [], rels });
    parts.push({ name: `ppt/slides/slide${i + 1}.xml`, data: xml });
    parts.push({ name: `ppt/slides/_rels/slide${i + 1}.xml.rels`, data: rels.xml() });
  });
  return zipArchive(parts);
}
