// What Tools lists, as data: every task a person would come looking for by name, grouped by what they
// want to get done (docs/TOOLS_UX_SPEC.md). Discovery only. A tool runs nothing and gates nothing: it
// names the command that runs it (commands.js), and whether that command can run now is the command's
// own business (requirements.js). This module imports nothing from the app.
//
// A tool:
//   id        a task slug, stable forever: kept in favourites and recent. Never the category (categories
//             get renamed), never the command id, never reused
//   name      sentence case, "to" rather than an arrow
//   blurb     one line, 80 characters at most
//   category, section   where it is listed (section null in a category without sections)
//   command   the command that runs it; variants: the choices of one goal, each its own command
//             ({ label, command }, the first being `command`), or null
//   aliases   other words people use for the task, only ever for what it really does (see SHARED_ALIASES)
//   fits      relevance only: what on screen it suits (a requirement name, or 'pages.selected'). It
//             suggests; it never stops anything running
//   scope     what it acts on, for display: files | document | pages | page | selection
//   icon      null: the command's icon
// A command backs one tool at most.

export const CATEGORIES = Object.freeze([
  { id: 'edit', name: 'Edit', icon: 'type', blurb: 'Change text and pictures, add to pages',
    sections: [{ id: 'content', name: 'Text and pictures' }, { id: 'marks', name: 'Add to pages' }] },
  { id: 'review', name: 'Review', icon: 'highlighter', blurb: 'Mark up, compare and look back',
    sections: [{ id: 'markup', name: 'Mark up' }, { id: 'compare', name: 'Compare and history' }] },
  { id: 'organize', name: 'Organize', icon: 'layout-grid', blurb: 'Pages, and combining or splitting files',
    sections: [{ id: 'pages', name: 'Pages' }, { id: 'combine', name: 'Combine and split' }, { id: 'document', name: 'In this document' }] },
  { id: 'convert', name: 'Convert', icon: 'file-output', blurb: 'Turn a PDF into another format, or other files into a PDF',
    sections: [{ id: 'from', name: 'From PDF' }, { id: 'to', name: 'To PDF' }] },
  { id: 'sign', name: 'Fill & Sign', icon: 'pen-line', blurb: 'Fill in forms, sign, create form fields',
    sections: [{ id: 'fill', name: 'Fill and sign' }, { id: 'create', name: 'Create a form' }] },
  { id: 'protect', name: 'Protect', icon: 'eraser', blurb: 'Remove sensitive content for good',
    sections: [{ id: 'redact', name: 'Redact' }] },
  { id: 'optimize', name: 'Optimize', icon: 'minimize-2', blurb: 'Smaller, searchable, archive-ready, checked', sections: [] },
  { id: 'research', name: 'Research', icon: 'book-open', blurb: 'Understand a document and quote from it', sections: [] },
  // Hidden until Batch Center or Vellum Flow exists: an empty category would promise a feature.
  { id: 'automate', name: 'Automate', icon: 'sliders-horizontal', blurb: 'Run the same steps on many files', sections: [], reserved: true },
].map((category) => Object.freeze({ reserved: false, ...category })));

const tool = (fields) => Object.freeze({ variants: null, fits: null, icon: null, ...fields });

export const TOOLS = Object.freeze([
  // Edit
  tool({ id: 'edit-text', name: 'Edit text', blurb: 'Change the words already on a page', category: 'edit', section: 'content',
    command: 'edit.text', scope: 'page', aliases: ['text', 'change text', 'fix typo', 'modify text', 'edit pdf'] }),
  tool({ id: 'add-text-box', name: 'Add text box', blurb: 'Type new text anywhere on a page', category: 'edit', section: 'content',
    command: 'edit.addText', scope: 'page', aliases: ['new text', 'type on pdf', 'write on pdf', 'insert text'] }),
  tool({ id: 'insert-picture', name: 'Insert picture', blurb: 'Place a PNG or JPEG picture on a page', category: 'edit', section: 'content',
    command: 'edit.insertPicture', scope: 'page', aliases: ['add image', 'add photo', 'add logo', 'insert image', 'png', 'jpg'] }),
  tool({ id: 'replace-picture', name: 'Replace picture', blurb: 'Swap a picture on the page for another', category: 'edit', section: 'content',
    command: 'edit.replacePicture', scope: 'selection', fits: 'selection.picture', aliases: ['swap image', 'change photo', 'update logo', 'replace image'] }),
  tool({ id: 'find-and-replace', name: 'Find and replace', blurb: 'Change a word or phrase everywhere it appears', category: 'edit', section: 'content',
    command: 'find.replace', scope: 'document', aliases: ['replace text', 'substitute', 'change all', 'search and replace'] }),
  tool({ id: 'add-link', name: 'Add link', blurb: 'Link part of a page to a website or another page', category: 'edit', section: 'content',
    command: 'links.add', scope: 'page', fits: 'selection.text', aliases: ['hyperlink', 'url', 'web link', 'link to page'] }),
  tool({ id: 'add-page-numbers', name: 'Add page numbers', blurb: 'Number the pages in the header or footer', category: 'edit', section: 'marks',
    command: 'pages.numbers', scope: 'pages', aliases: ['page numbers', 'number pages', 'page numbering', 'footer numbers', 'roman numerals'] }),
  tool({ id: 'add-watermark', name: 'Add watermark', blurb: 'Put text or a picture across the pages', category: 'edit', section: 'marks',
    command: 'pages.watermark', scope: 'pages', aliases: ['stamp text', 'draft', 'confidential', 'logo on every page'] }),

  // Review
  tool({ id: 'highlight', name: 'Highlight', blurb: 'Mark text in colour', category: 'review', section: 'markup',
    command: 'annot.highlight', scope: 'selection', fits: 'selection.text', aliases: ['mark text', 'highlighter', 'marker', 'highlight text'] }),
  tool({ id: 'underline', name: 'Underline', blurb: 'Draw a line under text', category: 'review', section: 'markup',
    command: 'annot.underline', scope: 'selection', fits: 'selection.text', aliases: ['underline words', 'line under text', 'underscore'] }),
  tool({ id: 'sticky-note', name: 'Add sticky note', blurb: 'Leave a comment on a spot of the page', category: 'review', section: 'markup',
    command: 'annot.note', scope: 'page', aliases: ['comment', 'note', 'annotate', 'remark'] }),
  tool({ id: 'draw', name: 'Draw', blurb: 'Draw freehand on the page', category: 'review', section: 'markup',
    command: 'annot.ink', scope: 'page', aliases: ['pen', 'freehand', 'sketch', 'scribble', 'ink'] }),
  tool({ id: 'compare-documents', name: 'Compare documents', blurb: 'See what changed between two PDFs', category: 'review', section: 'compare',
    command: 'tools.compare', scope: 'files', aliases: ['diff', 'differences', 'what changed', 'compare versions'] }),
  tool({ id: 'document-history', name: 'Document history', blurb: 'Snapshots of this PDF, to compare or restore', category: 'review', section: 'compare',
    command: 'file.history', scope: 'document', aliases: ['snapshots', 'restore', 'earlier version', 'version history'] }),

  // Organize
  tool({ id: 'organize-pages', name: 'Organize pages', blurb: 'Reorder, rotate and delete in the page thumbnails', category: 'organize', section: 'pages',
    command: 'pages.organise', scope: 'document', aliases: ['reorder', 'rearrange', 'move pages', 'page organizer', 'thumbnails'] }),
  tool({ id: 'rotate-pages', name: 'Rotate pages', blurb: 'Turn pages a quarter turn, saved in the file', category: 'organize', section: 'pages',
    command: 'pages.rotateRight', scope: 'pages', fits: 'pages.selected', aliases: ['turn page', 'landscape', 'portrait', 'sideways'],
    variants: [{ label: 'Right', command: 'pages.rotateRight' }, { label: 'Left', command: 'pages.rotateLeft' }] }),
  tool({ id: 'delete-pages', name: 'Delete pages', blurb: 'Take pages out of the document', category: 'organize', section: 'pages',
    command: 'pages.delete', scope: 'pages', fits: 'pages.selected', aliases: ['remove page', 'drop page', 'take out pages'] }),
  tool({ id: 'duplicate-pages', name: 'Duplicate pages', blurb: 'Repeat pages right after themselves', category: 'organize', section: 'pages',
    command: 'pages.duplicate', scope: 'pages', aliases: ['repeat page', 'clone page', 'page twice'] }),
  tool({ id: 'insert-blank-page', name: 'Insert blank page', blurb: 'Add an empty page after this one', category: 'organize', section: 'pages',
    command: 'pages.insertBlank', scope: 'page', aliases: ['empty page', 'add page', 'new page'] }),
  tool({ id: 'crop-pages', name: 'Crop pages', blurb: 'Trim the margins of pages', category: 'organize', section: 'pages',
    command: 'pages.crop', scope: 'pages', fits: 'pages.selected', aliases: ['trim', 'cut margins', 'margins', 'page size'] }),
  tool({ id: 'merge-pdfs', name: 'Merge PDFs', blurb: 'Combine several PDFs into one new file', category: 'organize', section: 'combine',
    command: 'pages.merge', scope: 'files', aliases: ['combine', 'join pdfs', 'put together', 'merge files'] }),
  tool({ id: 'insert-pages', name: 'Insert pages from file', blurb: 'Add the pages of another PDF to this one', category: 'organize', section: 'combine',
    command: 'pages.insert', scope: 'document', aliases: ['append pdf', 'insert pdf', 'add pages from a pdf'] }),
  tool({ id: 'extract-pages', name: 'Extract pages', blurb: 'Save chosen pages as a new PDF', category: 'organize', section: 'combine',
    command: 'pages.extract', scope: 'pages', fits: 'pages.selected', aliases: ['extract', 'save pages as pdf', 'pull out pages', 'take pages'] }),
  tool({ id: 'split-pdf', name: 'Split into files', blurb: 'Break a PDF into several smaller ones', category: 'organize', section: 'combine',
    command: 'pages.split', scope: 'document', aliases: ['split pdf', 'separate', 'divide', 'split by bookmarks', 'every n pages'] }),
  tool({ id: 'bookmarks', name: 'Bookmarks', blurb: 'The outline: chapters and headings to jump to', category: 'organize', section: 'document',
    command: 'bookmarks.show', scope: 'document', aliases: ['outline', 'table of contents', 'toc', 'chapters'],
    variants: [{ label: 'Show', command: 'bookmarks.show' }, { label: 'Add for this page', command: 'bookmarks.add' }] }),
  tool({ id: 'attachments', name: 'Attachments', blurb: 'Files embedded in this PDF', category: 'organize', section: 'document',
    command: 'tools.attachments', scope: 'document', aliases: ['embedded files', 'attached files', 'paperclip'] }),

  // Convert
  tool({ id: 'pdf-to-word', name: 'PDF to Word', blurb: 'An editable Word document (.docx)', category: 'convert', section: 'from',
    command: 'export.word', scope: 'pages', aliases: ['word', 'docx', 'word document', 'editable document', 'convert to word'] }),
  tool({ id: 'pdf-to-excel', name: 'PDF to Excel', blurb: 'The tables as an Excel workbook (.xlsx)', category: 'convert', section: 'from',
    command: 'export.excel', scope: 'pages', aliases: ['excel', 'xlsx', 'spreadsheet', 'tables to excel', 'extract tables to excel'] }),
  tool({ id: 'pdf-to-powerpoint', name: 'PDF to PowerPoint', blurb: 'A PowerPoint deck, one slide per page (.pptx)', category: 'convert', section: 'from',
    command: 'export.powerpoint', scope: 'pages', aliases: ['powerpoint', 'pptx', 'slides', 'presentation', 'deck'] }),
  tool({ id: 'pdf-to-images', name: 'PDF to images', blurb: 'Each page as a JPEG or PNG picture', category: 'convert', section: 'from',
    command: 'export.images', scope: 'pages', aliases: ['pdf to jpg', 'pdf to png', 'pdf to pictures', 'pictures', 'save page as image'] }),
  tool({ id: 'pdf-to-markdown', name: 'PDF to Markdown', blurb: 'The text and tables as Markdown (.md)', category: 'convert', section: 'from',
    command: 'export.markdown', scope: 'pages', aliases: ['md', 'plain text', 'text export'] }),
  tool({ id: 'images-to-pdf', name: 'Images to PDF', blurb: 'JPEG and PNG pictures into one PDF', category: 'convert', section: 'to',
    command: 'pages.imagesToPdf', scope: 'files', aliases: ['pictures to pdf', 'photos to pdf', 'jpg to pdf', 'png to pdf'] }),
  tool({ id: 'html-to-pdf', name: 'HTML to PDF', blurb: 'A web page saved on this PC, as a PDF', category: 'convert', section: 'to',
    command: 'pages.htmlToPdf', scope: 'files', aliases: ['web page to pdf', 'html file', 'webpage', 'website to pdf'] }),
  tool({ id: 'word-to-pdf', name: 'Word to PDF', blurb: 'A Word document (.docx, .doc) as a PDF, converted on this PC', category: 'convert', section: 'to',
    command: 'office.wordToPdf', scope: 'files', aliases: ['docx to pdf', 'doc to pdf', 'word document to pdf', 'office to pdf'] }),
  tool({ id: 'excel-to-pdf', name: 'Excel to PDF', blurb: 'An Excel workbook (.xlsx, .xls) as a PDF, converted on this PC', category: 'convert', section: 'to',
    command: 'office.excelToPdf', scope: 'files', aliases: ['xlsx to pdf', 'xls to pdf', 'spreadsheet to pdf', 'workbook to pdf', 'office to pdf'] }),
  tool({ id: 'powerpoint-to-pdf', name: 'PowerPoint to PDF', blurb: 'A PowerPoint presentation (.pptx, .ppt) as a PDF, converted on this PC', category: 'convert', section: 'to',
    command: 'office.powerpointToPdf', scope: 'files', aliases: ['pptx to pdf', 'ppt to pdf', 'slides to pdf', 'presentation to pdf', 'office to pdf'] }),

  // Fill & Sign
  tool({ id: 'fill-form', name: 'Fill in form', blurb: 'Go to the next form field to fill', category: 'sign', section: 'fill',
    command: 'forms.fill', scope: 'document', aliases: ['fill form', 'complete form', 'fill out', 'fill in fields'] }),
  tool({ id: 'add-signature', name: 'Add signature', blurb: 'Put your signature on a page', category: 'sign', section: 'fill',
    command: 'edit.addSignature', scope: 'page', aliases: ['sign', 'signature', 'autograph', 'sign pdf'] }),
  tool({ id: 'add-text-field', name: 'Add text field', blurb: 'A box people can type into', category: 'sign', section: 'create',
    command: 'forms.addText', scope: 'page', aliases: ['form field', 'input box', 'fillable', 'text input'] }),
  tool({ id: 'add-checkbox', name: 'Add checkbox', blurb: 'A box people can tick', category: 'sign', section: 'create',
    command: 'forms.addCheckbox', scope: 'page', aliases: ['tick box', 'check box', 'checkmark'] }),
  tool({ id: 'add-radio-buttons', name: 'Add radio buttons', blurb: 'A set of options where one is picked', category: 'sign', section: 'create',
    command: 'forms.addRadio', scope: 'page', aliases: ['option buttons', 'pick one', 'multiple choice'] }),
  tool({ id: 'add-dropdown', name: 'Add dropdown', blurb: 'A list people choose one entry from', category: 'sign', section: 'create',
    command: 'forms.addDropdown', scope: 'page', aliases: ['select list', 'combo box', 'choices', 'drop down'] }),

  // Protect
  tool({ id: 'redact-selection', name: 'Redact selection', blurb: 'Black out selected text or pictures for good', category: 'protect', section: 'redact',
    command: 'edit.redactSelection', scope: 'selection', fits: 'selection.objects', aliases: ['black out', 'remove sensitive', 'censor', 'hide text'] }),
  tool({ id: 'redact-search-matches', name: 'Redact search matches', blurb: 'Black out every match of a search', category: 'protect', section: 'redact',
    command: 'find.redactAll', scope: 'document', aliases: ['redact all', 'redact word everywhere', 'censor every match'] }),

  // Optimize
  tool({ id: 'compress-pdf', name: 'Compress PDF', blurb: 'Make the file smaller', category: 'optimize', section: null,
    command: 'tools.compress', scope: 'document', aliases: ['shrink', 'smaller', 'reduce size', 'optimize', 'file size'] }),
  tool({ id: 'recognize-text', name: 'Recognize text (OCR)', blurb: 'Make scanned pages searchable and selectable', category: 'optimize', section: null,
    command: 'tools.ocrPage', scope: 'page', aliases: ['ocr', 'scan', 'scanned', 'make searchable', 'text recognition'],
    variants: [{ label: 'This page', command: 'tools.ocrPage' }, { label: 'Whole document', command: 'tools.ocrDocument' }] }),
  tool({ id: 'convert-to-pdfa', name: 'Convert to PDF/A', blurb: 'An archival copy (PDF/A-2b)', category: 'optimize', section: null,
    command: 'tools.pdfa', scope: 'document', aliases: ['archive', 'archival', 'long-term', 'pdf/a-2b'] }),
  tool({ id: 'pdf-health', name: 'PDF health', blurb: 'Check the file for problems', category: 'optimize', section: null,
    command: 'tools.health', scope: 'document', aliases: ['check pdf', 'diagnose', 'problems', 'what’s wrong'] }),

  // Research
  tool({ id: 'research-document', name: 'Research this document', blurb: 'Ask a question and get quoted evidence', category: 'research', section: null,
    command: 'tools.research', scope: 'document', aliases: ['ask', 'question', 'evidence', 'find answers'] }),
  tool({ id: 'document-structure', name: 'Document structure', blurb: 'Headings and sections, and search by kind', category: 'research', section: null,
    command: 'tools.structure', scope: 'document', aliases: ['headings', 'sections', 'semantic search', 'structure search'] }),
  tool({ id: 'document-graph', name: 'Document graph', blurb: 'How the parts of a document refer to each other', category: 'research', section: null,
    command: 'tools.graph', scope: 'document', aliases: ['relationships', 'links between', 'knowledge graph'] }),
  tool({ id: 'copy-tables', name: 'Copy tables', blurb: 'The tables on this page, ready to paste', category: 'research', section: null,
    command: 'tools.copyTables', scope: 'page', aliases: ['extract table', 'table to clipboard', 'tsv'] }),
]);

/** The Home row's tools when none has been run yet, in order (docs/TOOLS_UX_SPEC.md §8): tool ids. */
export const HOME_TOOLS = Object.freeze(['merge-pdfs', 'images-to-pdf', 'compare-documents', 'html-to-pdf']);

/** Aliases two tools may share: [alias, [toolId, toolId]]. Everything else is one tool's own. */
export const SHARED_ALIASES = Object.freeze([
  ['office to pdf', ['word-to-pdf', 'excel-to-pdf', 'powerpoint-to-pdf']],
]);

/** Every command a tool runs: its own, then its variants'. */
export const toolCommands = (t) => [...new Set([t.command, ...(t.variants ?? []).map((v) => v.command)])];

/** Command id → the aliases of the tool it runs, so the palette finds commands by those words too. */
export function aliasesByCommand(tools = TOOLS) {
  const map = new Map();
  for (const t of tools) for (const id of toolCommands(t)) map.set(id, t.aliases);
  return map;
}

// What search (catalog/search.js) reads, and how much each counts. A tool is found by its name, its
// aliases, where it is listed, its blurb, and its command's label (the words menus already use).
const CATEGORY = new Map(CATEGORIES.map((c) => [c.id, c]));
const placeOf = (t) => {
  const category = CATEGORY.get(t.category);
  return [category?.name, category?.sections.find((s) => s.id === t.section)?.name].filter(Boolean);
};

/** Search fields for tools; `commands` is the command registry, read for labels only. */
export const toolFields = (commands) => [
  { get: (t) => t.name, weight: 3, phrase: true },
  { get: (t) => t.aliases, weight: 2.5, phrase: true },
  { get: placeOf, weight: 1 },
  { get: (t) => t.blurb, weight: 0.5 },
  { get: (t) => toolCommands(t).map((id) => commands[id]?.label).filter(Boolean), weight: 1 },
];

/** Search fields for the palette's items ({ label, aliases, group }): commands and recent files. */
export const COMMAND_FIELDS = Object.freeze([
  { get: (item) => item.label, weight: 3, phrase: true },
  { get: (item) => item.aliases, weight: 2.5, phrase: true },
  { get: (item) => item.group, weight: 1 },
]);
