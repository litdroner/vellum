// Every user action lives here once. The toolbars, menus, keyboard shortcuts and the command palette
// all call these, so a shortcut and its button can never drift apart. To add a feature, register its
// actions here; to remove one, delete them and every surface follows.
//   label:  what menus and the palette show
//   group:  palette section; icon: palette / menu icon
//   keys:   shortcuts (see shortcuts.js for the naming); hint: how the shortcut is shown, if not keys[0]
//   global: still fires while typing in a text field
//   when:   optional extra condition, checked before the shortcut is consumed
//   doc:    needs an open document (hidden from the palette otherwise)
//   palette: false keeps it out of the palette

import { FAMILY_NAMES } from './editing/objects/text-format.js';
import { BUNDLED_FONTS } from './editing/objects/bundled-fonts.js';

export function createCommands(app, ui, actions) {
  const doc = () => (app.active?.status === 'ready' ? app.active : null);
  const single = () => doc()?.viewMode === 'single';
  // Pressing H or U with text selected marks it straight away; otherwise it picks the tool.
  const markOrTool = (type) => () => {
    const view = doc();
    if (!view) return;
    if (!view.getSelectedText() || !view.annotLayer.markSelection(type)) view.setTool(type);
  };
  // Page commands act on the pages selected in the sidebar, or on the current page.
  const inThumbs = (e) => Boolean(e?.target?.closest?.('.thumbs'));
  const onPages = (fn) => () => {
    const view = doc();
    if (!view) return;
    const ids = ui.sidebar.thumbs?.targetIds() ?? [view.shownPlan[view.state.pageNumber - 1]?.id].filter(Boolean);
    fn(view, ids);
  };
  const pages = actions.pages;
  // Lining up and spacing the objects selected in Edit mode: the same method the arrange bar calls,
  // which says what to do when there is nothing (or not enough) selected.
  const arrange = (kind) => doc()?.textEditor?.arrange(kind);

  // An object is selected in Edit mode: the arrow keys nudge it, so they don't also turn the page.
  // Nothing else changes — with nothing selected, and in every other tool, they page as they always did.
  const nudging = () => {
    const v = doc();
    return Boolean(v && v.annotLayer?.tool === 'edit' && v.objectSelection?.current);
  };
  // The same test gives Ctrl+C and Ctrl+D to the selected objects; otherwise Ctrl+C copies text as it
  // always did. Ctrl+V pastes objects only in Edit mode, once some have been copied there.
  const objectsSelected = nudging;

  return {
    'file.open': { group: 'File', icon: 'folder-open', label: 'Open…', keys: ['Ctrl+O'], global: true, run: () => actions.openDialog() },
    'file.save': { group: 'File', icon: 'save', doc: true, label: 'Save changes', keys: ['Ctrl+S'], global: true, run: () => actions.save() },
    'file.saveAs': { group: 'File', icon: 'save-all', doc: true, label: 'Save as…', keys: ['Ctrl+Shift+S'], global: true, run: () => actions.saveAs() },
    'file.print': { group: 'File', icon: 'printer', doc: true, label: 'Print…', keys: ['Ctrl+P'], global: true, run: () => actions.print() },
    'file.close': { group: 'File', icon: 'x', doc: true, label: 'Close document', keys: ['Ctrl+W', 'Ctrl+F4'], global: true, run: () => actions.close() },
    'file.showInFolder': { group: 'File', icon: 'folder-open', doc: true, label: 'Show in folder', run: () => actions.showInFolder() },

    'tab.next': { group: 'Tabs', icon: 'chevron-right', label: 'Next tab', keys: ['Ctrl+Tab', 'Ctrl+PageDown'], global: true, run: () => app.cycle(1) },
    'tab.prev': { group: 'Tabs', icon: 'chevron-left', label: 'Previous tab', keys: ['Ctrl+Shift+Tab', 'Ctrl+PageUp'], global: true, run: () => app.cycle(-1) },
    'tab.reopen': { group: 'Tabs', icon: 'rotate-ccw', label: 'Reopen closed document', keys: ['Ctrl+Shift+T'], global: true, run: () => actions.reopenClosed() },

    'zoom.in': { group: 'View', icon: 'zoom-in', doc: true, label: 'Zoom in', keys: ['Ctrl+='], hint: 'Ctrl++', global: true, run: () => doc()?.zoomIn() },
    'zoom.out': { group: 'View', icon: 'zoom-out', doc: true, label: 'Zoom out', keys: ['Ctrl+-'], global: true, run: () => doc()?.zoomOut() },
    'zoom.fitWidth': { group: 'View', icon: 'move-horizontal', doc: true, label: 'Fit width', keys: ['Ctrl+2'], global: true, run: () => doc()?.zoomTo('page-width') },
    'zoom.fitPage': { group: 'View', icon: 'maximize', doc: true, label: 'Fit page', keys: ['Ctrl+0'], global: true, run: () => doc()?.zoomTo('page-fit') },
    'zoom.actual': { group: 'View', icon: 'square', doc: true, label: 'Actual size', keys: ['Ctrl+1'], global: true, run: () => doc()?.zoomTo('page-actual') },
    // Rotating the view is temporary; rotating pages (below) changes the file when saved.
    'view.rotateCw': { group: 'View', icon: 'rotate-cw', doc: true, label: 'Rotate view clockwise', keys: ['Ctrl+Shift+='], hint: 'Ctrl+Shift++', global: true, run: () => doc()?.rotate(90) },
    'view.rotateCcw': { group: 'View', icon: 'rotate-ccw', doc: true, label: 'Rotate view counter-clockwise', keys: ['Ctrl+Shift+-'], global: true, run: () => doc()?.rotate(-90) },
    'view.continuous': { group: 'View', icon: 'gallery-vertical-end', doc: true, label: 'Continuous scroll', run: () => doc()?.setViewMode('continuous') },
    'view.single': { group: 'View', icon: 'file', doc: true, label: 'Single page', run: () => doc()?.setViewMode('single') },
    'view.pageTone': { group: 'View', icon: 'contrast', label: 'Page colours: normal, dark, sepia', keys: ['Ctrl+Shift+D'], global: true, run: () => actions.cyclePageTone() },
    'sidebar.toggle': { group: 'View', icon: 'panel-left', doc: true, label: 'Toggle sidebar', keys: ['F4', 'Ctrl+B'], global: true, run: () => ui.sidebar.toggle() },

    'page.next': { group: 'Page', icon: 'chevron-right', doc: true, label: 'Next page', keys: ['PageDown', 'ArrowRight'], when: (e) => !nudging() && (single() || e.key === 'ArrowRight'), run: () => doc()?.nextPage() },
    'page.prev': { group: 'Page', icon: 'chevron-left', doc: true, label: 'Previous page', keys: ['PageUp', 'ArrowLeft'], when: (e) => !nudging() && (single() || e.key === 'ArrowLeft'), run: () => doc()?.prevPage() },
    'page.first': { group: 'Page', icon: 'arrow-up-to-line', doc: true, label: 'First page', keys: ['Home', 'Ctrl+Home'], run: () => doc()?.firstPage() },
    'page.last': { group: 'Page', icon: 'arrow-down-to-line', doc: true, label: 'Last page', keys: ['End', 'Ctrl+End'], run: () => doc()?.lastPage() },
    'page.goto': { group: 'Page', icon: 'arrow-right', doc: true, label: 'Go to page…', keys: ['Ctrl+G'], global: true, run: () => ui.viewbar.focusPageInput() },

    'pages.rotateRight': { group: 'Pages', icon: 'rotate-cw', doc: true, label: 'Rotate page right', run: onPages((view, ids) => pages.rotate(view, ids, 90)) },
    'pages.rotateLeft': { group: 'Pages', icon: 'rotate-ccw', doc: true, label: 'Rotate page left', run: onPages((view, ids) => pages.rotate(view, ids, -90)) },
    'pages.delete': { group: 'Pages', icon: 'trash-2', doc: true, label: 'Delete page', keys: ['Delete'], when: inThumbs, run: onPages((view, ids) => pages.remove(view, ids)) },
    'pages.duplicate': { group: 'Pages', icon: 'copy-plus', doc: true, label: 'Duplicate page', keys: ['Ctrl+D'], when: inThumbs, run: onPages((view, ids) => pages.duplicate(view, ids)) },
    'pages.copy': { group: 'Pages', icon: 'copy', doc: true, label: 'Copy pages', keys: ['Ctrl+C'], when: inThumbs, run: onPages((view, ids) => pages.copy(view, ids)) },
    'pages.paste': {
      group: 'Pages', icon: 'files', doc: true, label: 'Paste pages after', keys: ['Ctrl+V'], when: (e) => pages.canPaste && inThumbs(e),
      run: onPages((view, ids) => pages.paste(view, Math.max(0, ...ids.map((id) => view.annotations.plan.findIndex((p) => p.id === id) + 1)))),
    },
    'pages.moveUp': { group: 'Pages', icon: 'chevron-up', doc: true, label: 'Move page up', keys: ['Alt+ArrowUp'], when: inThumbs, run: onPages((view, ids) => pages.moveBy(view, ids, -1)) },
    'pages.moveDown': { group: 'Pages', icon: 'chevron-down', doc: true, label: 'Move page down', keys: ['Alt+ArrowDown'], when: inThumbs, run: onPages((view, ids) => pages.moveBy(view, ids, 1)) },
    'pages.insertBlank': { group: 'Pages', icon: 'file-plus', doc: true, label: 'Insert blank page', run: () => doc() && pages.insertBlank(doc(), doc().state.pageNumber) },
    'pages.insert': { group: 'Pages', icon: 'files', doc: true, label: 'Insert pages from file…', run: () => doc() && pages.insertFromFile(doc(), doc().state.pageNumber) },
    'pages.crop': { group: 'Pages', icon: 'minimize-2', doc: true, label: 'Crop pages…', run: onPages((view, ids) => pages.crop(view, ids)) },
    'pages.numbers': { group: 'Pages', icon: 'file-text', doc: true, label: 'Page numbers…', run: onPages((view, ids) => pages.pageNumbers(view, ids)) },
    'pages.watermark': { group: 'Pages', icon: 'blend', doc: true, label: 'Watermark…', run: onPages((view, ids) => pages.watermark(view, ids)) },
    'pages.extract': { group: 'Pages', icon: 'file-output', doc: true, label: 'Extract pages…', run: onPages((view, ids) => pages.extract(view, ids)) },
    'pages.split': { group: 'Pages', icon: 'scissors', doc: true, label: 'Split into files…', run: () => doc() && pages.split(doc(), ui.sidebar.thumbs?.selectedIds ?? []) },
    'pages.organise': { group: 'Pages', icon: 'layout-grid', doc: true, label: 'Show page organiser', run: () => ui.sidebar.showPages() },

    'find.open': { group: 'Search', icon: 'search', doc: true, label: 'Find in document', keys: ['Ctrl+F'], global: true, run: () => ui.findbar.open(doc()?.getSelectedText()) },
    'find.next': { group: 'Search', icon: 'chevron-down', doc: true, label: 'Find next', keys: ['F3'], global: true, run: () => ui.findbar.step(false) },
    'find.prev': { group: 'Search', icon: 'chevron-up', doc: true, label: 'Find previous', keys: ['Shift+F3'], global: true, run: () => ui.findbar.step(true) },

    'tools.ocrPage': { group: 'Tools', icon: 'text-select', doc: true, label: 'OCR current page (English)', run: () => actions.ocr.run(doc(), 'page') },
    'tools.ocrDocument': { group: 'Tools', icon: 'text-select', doc: true, label: 'OCR entire document (English)', run: () => actions.ocr.run(doc(), 'document') },

    'annot.select': { group: 'Annotate', icon: 'mouse-pointer-2', doc: true, label: 'Select text', keys: ['V'], run: () => doc()?.setTool('select') },
    'annot.highlight': { group: 'Annotate', icon: 'highlighter', doc: true, label: 'Highlight', keys: ['H'], run: markOrTool('highlight') },
    'annot.underline': { group: 'Annotate', icon: 'underline', doc: true, label: 'Underline', keys: ['U'], run: markOrTool('underline') },
    'annot.note': { group: 'Annotate', icon: 'sticky-note', doc: true, label: 'Sticky note', keys: ['N'], run: () => doc()?.setTool('note') },
    'annot.ink': { group: 'Annotate', icon: 'pen-line', doc: true, label: 'Draw', keys: ['D'], run: () => doc()?.setTool('ink') },
    'annot.delete': {
      group: 'Annotate', icon: 'trash-2', doc: true, palette: false, label: 'Delete annotation', keys: ['Delete', 'Backspace'],
      when: (e) => !inThumbs(e) && Boolean(doc()?.annotLayer.selectedId), run: () => doc()?.annotLayer.deleteSelected(),
    },

    'edit.text': { group: 'Edit', icon: 'type', doc: true, label: 'Edit text', keys: ['E'], run: () => doc()?.setTool('edit') },

    'arrange.alignLeft': { group: 'Arrange', icon: 'align-start-vertical', doc: true, label: 'Align left edges', run: () => arrange('left') },
    'arrange.alignCenter': { group: 'Arrange', icon: 'align-center-vertical', doc: true, label: 'Align centres', run: () => arrange('center') },
    'arrange.alignRight': { group: 'Arrange', icon: 'align-end-vertical', doc: true, label: 'Align right edges', run: () => arrange('right') },
    'arrange.alignTop': { group: 'Arrange', icon: 'align-start-horizontal', doc: true, label: 'Align top edges', run: () => arrange('top') },
    'arrange.alignMiddle': { group: 'Arrange', icon: 'align-center-horizontal', doc: true, label: 'Align middles', run: () => arrange('middle') },
    'arrange.alignBottom': { group: 'Arrange', icon: 'align-end-horizontal', doc: true, label: 'Align bottom edges', run: () => arrange('bottom') },
    'arrange.spaceAcross': { group: 'Arrange', icon: 'align-horizontal-space-between', doc: true, label: 'Space evenly across', run: () => arrange('horizontal') },
    'arrange.spaceDown': { group: 'Arrange', icon: 'align-vertical-space-between', doc: true, label: 'Space evenly down', run: () => arrange('vertical') },
    'edit.addText': { group: 'Edit', icon: 'type', doc: true, label: 'Add text', run: () => doc()?.textEditor?.addText() },
    'edit.textBold': { group: 'Edit', icon: 'bold', doc: true, label: 'Bold text', run: () => doc()?.textEditor?.formatSelected('bold') },
    'edit.textItalic': { group: 'Edit', icon: 'italic', doc: true, label: 'Italic text', run: () => doc()?.textEditor?.formatSelected('italic') },
    'edit.textUnderline': { group: 'Edit', icon: 'underline', doc: true, label: 'Underline text', run: () => doc()?.textEditor?.formatSelected('underline') },
    // One command per font new text can be written in — the standard families (editing/objects/text-format.js)
    // and the bundled ones (editing/objects/bundled-fonts.js) — so the palette offers the fonts the format
    // bar's font menu does, but for the document's own, which depend on the file open.
    ...Object.fromEntries(FAMILY_NAMES.map((family) => [`edit.textFont${family}`, {
      group: 'Edit', icon: 'type', doc: true, label: `New text in ${family}`, run: () => doc()?.textEditor?.formatSelected({ family }),
    }])),
    ...Object.fromEntries(BUNDLED_FONTS.map(({ id, name }) => [`edit.textFont.${id}`, {
      group: 'Edit', icon: 'type', doc: true, label: `New text in ${name}`, run: () => doc()?.textEditor?.formatSelected({ family: `bundled:${id}` }),
    }])),
    'edit.textLarger': { group: 'Edit', icon: 'plus', doc: true, label: 'Larger text', run: () => doc()?.textEditor?.formatSelected('larger') },
    'edit.textSmaller': { group: 'Edit', icon: 'minus', doc: true, label: 'Smaller text', run: () => doc()?.textEditor?.formatSelected('smaller') },
    'edit.textColour': { group: 'Edit', icon: 'palette', doc: true, label: 'Text colour…', run: () => doc()?.textEditor?.textColourMenu() },
    'edit.textOpacity': { group: 'Edit', icon: 'blend', doc: true, label: 'Text opacity…', run: () => doc()?.textEditor?.textOpacityMenu() },
    'edit.textAlignLeft': { group: 'Edit', icon: 'text-align-start', doc: true, label: 'Align new text left', run: () => doc()?.textEditor?.formatSelected('left') },
    'edit.textAlignCenter': { group: 'Edit', icon: 'text-align-center', doc: true, label: 'Centre new text', run: () => doc()?.textEditor?.formatSelected('center') },
    'edit.textAlignRight': { group: 'Edit', icon: 'text-align-end', doc: true, label: 'Align new text right', run: () => doc()?.textEditor?.formatSelected('right') },
    'edit.insertPicture': { group: 'Edit', icon: 'image-plus', doc: true, label: 'Insert picture…', run: () => doc()?.textEditor?.insertPicture() },
    'edit.addSignature': { group: 'Edit', icon: 'pen-line', doc: true, label: 'Add signature…', run: () => doc()?.textEditor?.addSignature() },
    'edit.redactSelection': { group: 'Edit', icon: 'square', doc: true, label: 'Redact selection', run: () => doc()?.textEditor?.redactSelected() },
    'edit.replacePicture': { group: 'Edit', icon: 'image', doc: true, label: 'Replace picture…', run: () => doc()?.textEditor?.replacePicture() },
    'edit.undo': { group: 'Edit', icon: 'undo-2', doc: true, label: 'Undo', keys: ['Ctrl+Z'], run: () => doc()?.annotations.undo() },
    'edit.redo': { group: 'Edit', icon: 'redo-2', doc: true, label: 'Redo', keys: ['Ctrl+Y', 'Ctrl+Shift+Z'], run: () => doc()?.annotations.redo() },
    'edit.copy': { group: 'Edit', icon: 'copy', doc: true, palette: false, label: 'Copy', hint: 'Ctrl+C', run: () => copySelection() },
    'edit.copyObjects': { group: 'Edit', icon: 'copy', doc: true, label: 'Copy objects', keys: ['Ctrl+C'], when: objectsSelected, run: () => doc()?.textEditor?.copySelected() },
    'edit.cutObjects': { group: 'Edit', icon: 'scissors', doc: true, label: 'Cut objects', keys: ['Ctrl+X'], when: objectsSelected, run: () => doc()?.textEditor?.cutSelected() },
    'edit.pasteObjects': { group: 'Edit', icon: 'files', doc: true, label: 'Paste objects', keys: ['Ctrl+V'], when: () => Boolean(doc()?.textEditor?.canPaste), run: () => doc()?.textEditor?.paste() },
    // [ and ] are Edit mode's own keys (ui/text-editor.js), so these only show them as a hint.
    'edit.turnObjectsLeft': { group: 'Edit', icon: 'rotate-ccw', doc: true, label: 'Turn objects left 90°', hint: '[', run: () => doc()?.textEditor?.turnSelected(-1) },
    'edit.turnObjectsRight': { group: 'Edit', icon: 'rotate-cw', doc: true, label: 'Turn objects right 90°', hint: ']', run: () => doc()?.textEditor?.turnSelected(1) },
    'edit.duplicateObjects': { group: 'Edit', icon: 'copy-plus', doc: true, label: 'Duplicate objects', keys: ['Ctrl+D'], when: objectsSelected, run: () => doc()?.textEditor?.duplicateSelected() },
    'edit.selectAll': { group: 'Edit', icon: 'text-select', doc: true, label: 'Select all text', hint: 'Ctrl+A', run: () => doc()?.selectAllText() },

    'app.palette': { group: 'App', icon: 'zap', palette: false, label: 'Command palette', keys: ['Ctrl+K'], global: true, run: () => actions.palette() },
    'app.settings': { group: 'App', icon: 'settings', label: 'Settings…', keys: ['Ctrl+,'], global: true, run: () => actions.settings() },
    'view.theme': { group: 'App', icon: 'moon', label: 'Switch light / dark', keys: ['Ctrl+Shift+L'], global: true, run: (e) => actions.toggleTheme(e) },
    'app.shortcuts': { group: 'App', icon: 'keyboard', label: 'Keyboard shortcuts', run: () => actions.settings('shortcuts') },
    'app.checkUpdates': { group: 'App', icon: 'refresh-cw', label: 'Check for updates…', run: () => actions.checkForUpdates() },
    'app.setDefault': { group: 'App', icon: 'file-text', label: 'Make Vellum the default PDF app…', run: () => actions.setDefault() },
    'app.about': { group: 'App', icon: 'info', label: 'About Vellum', run: () => actions.about() },
  };
}

export function copySelection() {
  // execCommand lets pdf.js clean up the copied text (it normalises ligatures and spacing).
  if (!document.execCommand('copy')) navigator.clipboard?.writeText(getSelection().toString());
}

export function copyText(text) {
  navigator.clipboard?.writeText(text).catch(() => {
    const area = Object.assign(document.createElement('textarea'), { value: text });
    document.body.append(area);
    area.select();
    document.execCommand('copy');
    area.remove();
  });
}
