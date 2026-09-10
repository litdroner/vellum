// Every user action lives here once. The toolbar, keyboard shortcuts and menus all call these,
// so a shortcut and its button can never drift apart.
//   keys:   shortcuts (see shortcuts.js for the naming)
//   hint:   how the shortcut is displayed, when it differs from keys[0]
//   global: still fires while typing in a text field
//   when:   optional extra condition, checked before the shortcut is consumed

export function createCommands(app, ui, actions) {
  const doc = () => (app.active?.status === 'ready' ? app.active : null);
  const single = () => doc()?.viewMode === 'single';
  // Pressing H or U with text selected marks it straight away; otherwise it picks the tool.
  const markOrTool = (type) => () => {
    const view = doc();
    if (!view) return;
    if (!view.getSelectedText() || !view.annotLayer.markSelection(type)) view.setTool(type);
  };

  return {
    'file.open': { label: 'Open…', keys: ['Ctrl+O'], global: true, run: () => actions.openDialog() },
    'file.save': { label: 'Save annotations', keys: ['Ctrl+S'], global: true, run: () => actions.save() },
    'file.saveAs': { label: 'Save as…', keys: ['Ctrl+Shift+S'], global: true, run: () => actions.saveAs() },
    'file.print': { label: 'Print…', keys: ['Ctrl+P'], global: true, run: () => actions.print() },
    'file.close': { label: 'Close document', keys: ['Ctrl+W', 'Ctrl+F4'], global: true, run: () => actions.close() },
    'file.showInFolder': { label: 'Show in folder', run: () => actions.showInFolder() },
    'app.setDefault': { label: 'Make Vellum the default PDF app…', run: () => actions.setDefault() },
    'app.about': { label: 'About Vellum', run: () => actions.about() },

    'tab.next': { label: 'Next tab', keys: ['Ctrl+Tab', 'Ctrl+PageDown'], global: true, run: () => app.cycle(1) },
    'tab.prev': { label: 'Previous tab', keys: ['Ctrl+Shift+Tab', 'Ctrl+PageUp'], global: true, run: () => app.cycle(-1) },
    'tab.reopen': { label: 'Reopen closed document', keys: ['Ctrl+Shift+T'], global: true, run: () => actions.reopenClosed() },

    'zoom.in': { label: 'Zoom in', keys: ['Ctrl+='], hint: 'Ctrl++', global: true, run: () => doc()?.zoomIn() },
    'zoom.out': { label: 'Zoom out', keys: ['Ctrl+-'], global: true, run: () => doc()?.zoomOut() },
    'zoom.fitWidth': { label: 'Fit width', keys: ['Ctrl+2'], global: true, run: () => doc()?.zoomTo('page-width') },
    'zoom.fitPage': { label: 'Fit page', keys: ['Ctrl+0'], global: true, run: () => doc()?.zoomTo('page-fit') },
    'zoom.actual': { label: 'Actual size', keys: ['Ctrl+1'], global: true, run: () => doc()?.zoomTo('page-actual') },

    'page.next': { label: 'Next page', keys: ['PageDown', 'ArrowRight'], when: (e) => single() || e.key === 'ArrowRight', run: () => doc()?.nextPage() },
    'page.prev': { label: 'Previous page', keys: ['PageUp', 'ArrowLeft'], when: (e) => single() || e.key === 'ArrowLeft', run: () => doc()?.prevPage() },
    'page.first': { label: 'First page', keys: ['Home', 'Ctrl+Home'], run: () => doc()?.firstPage() },
    'page.last': { label: 'Last page', keys: ['End', 'Ctrl+End'], run: () => doc()?.lastPage() },
    'page.goto': { label: 'Go to page…', keys: ['Ctrl+G'], global: true, run: () => ui.toolbar.focusPageInput() },

    'view.rotateCw': { label: 'Rotate clockwise', keys: ['Ctrl+Shift+='], hint: 'Ctrl+Shift++', global: true, run: () => doc()?.rotate(90) },
    'view.rotateCcw': { label: 'Rotate counter-clockwise', keys: ['Ctrl+Shift+-'], global: true, run: () => doc()?.rotate(-90) },
    'view.continuous': { label: 'Continuous scroll', run: () => doc()?.setViewMode('continuous') },
    'view.single': { label: 'Single page', run: () => doc()?.setViewMode('single') },
    'sidebar.toggle': { label: 'Toggle sidebar', keys: ['F4', 'Ctrl+B'], global: true, run: () => ui.sidebar.toggle() },
    'view.theme': { label: 'Switch theme', keys: ['Ctrl+Shift+L'], global: true, run: () => actions.toggleTheme() },

    'find.open': { label: 'Find', keys: ['Ctrl+F'], global: true, run: () => ui.findbar.open(doc()?.getSelectedText()) },
    'find.next': { label: 'Find next', keys: ['F3'], global: true, run: () => ui.findbar.step(false) },
    'find.prev': { label: 'Find previous', keys: ['Shift+F3'], global: true, run: () => ui.findbar.step(true) },

    'annot.select': { label: 'Select text', keys: ['V'], run: () => doc()?.setTool('select') },
    'annot.highlight': { label: 'Highlight', keys: ['H'], run: markOrTool('highlight') },
    'annot.underline': { label: 'Underline', keys: ['U'], run: markOrTool('underline') },
    'annot.note': { label: 'Sticky note', keys: ['N'], run: () => doc()?.setTool('note') },
    'annot.ink': { label: 'Draw', keys: ['D'], run: () => doc()?.setTool('ink') },
    'annot.delete': {
      label: 'Delete annotation', keys: ['Delete', 'Backspace'],
      when: () => Boolean(doc()?.annotLayer.selectedId), run: () => doc()?.annotLayer.deleteSelected(),
    },

    'edit.undo': { label: 'Undo', keys: ['Ctrl+Z'], run: () => doc()?.annotations.undo() },
    'edit.redo': { label: 'Redo', keys: ['Ctrl+Y', 'Ctrl+Shift+Z'], run: () => doc()?.annotations.redo() },
    'edit.copy': { label: 'Copy', hint: 'Ctrl+C', run: () => copySelection() },
    'edit.selectAll': { label: 'Select all text', hint: 'Ctrl+A', run: () => doc()?.selectAllText() },
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
