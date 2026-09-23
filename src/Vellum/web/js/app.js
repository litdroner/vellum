import { bridge } from './bridge.js';
import { loadPdfjs } from './pdfjs.js';
import { truncate, debounce } from './dom.js';
import { DocumentView } from './document-view.js';
import { createCommands, copySelection, copyText } from './commands.js';
import { installShortcuts } from './shortcuts.js';
import { Toolbar } from './ui/toolbar.js';
import { ViewBar } from './ui/viewbar.js';
import { Sidebar } from './ui/sidebar.js';
import { FindBar } from './ui/findbar.js';
import { StartScreen } from './ui/start.js';
import { TitleBar } from './ui/titlebar.js';
import { TabStrip } from './ui/tabs.js';
import { installDropZone } from './ui/dropzone.js';
import { openMenu } from './ui/menu.js';
import { FIELD_KINDS } from './forms/fields.js';
import { linkLabel } from './links/links.js';
import { promptPassword, showDialog, toast } from './ui/dialogs.js';
import { printDocument } from './print.js';
import { showAbout } from './ui/about.js';
import { showSettings } from './ui/settings.js';
import { CommandPalette } from './ui/palette.js';
import { setFocusFallback } from './ui/focus.js';
import { markPageBoxWhenReady } from './ui/page-mark.js';
import { showKnowledgeGraph } from './ui/knowledge-graph.js';
import { TextEditor } from './ui/text-editor.js';
import { toPdfPoint } from './page-space.js';
import { readSessionPage } from './semantic/model.js';
import { pageTables, tableToTsv } from './semantic/tables.js';
import { createPageActions } from './pages/actions.js';
import { createOcrActions } from './ocr/actions.js';
import { createCompareActions } from './compare/actions.js';
import { createHealthActions } from './health/actions.js';
import { createHistoryActions } from './history/actions.js';
import { createExportActions } from './export/actions.js';
import { createOptimizeActions } from './optimize/actions.js';
import { Updates } from './ui/updates.js';
import { captureCover } from './recent-covers.js';
import { loadAppearance, applyAppearance, switchAppearance, onSystemModeChange, originOf, toHex } from './themes.js';

// The composition root: creates the app and wires the features together. Features live in their own
// modules; everything a user can do is a command (commands.js).

// Diagnostics hook read by tools/cdp.mjs during development.
window.__vellum = { errors: [] };
window.addEventListener('error', (e) => window.__vellum.errors.push(String(e.message)));
window.addEventListener('unhandledrejection', (e) => window.__vellum.errors.push(String(e.reason?.stack ?? e.reason)));

// Appearance first, so the seeds on screen always match this version's theme definitions.
let appearance = loadAppearance();
applyAppearance(appearance);

const libs = await loadPdfjs();
const session = { user: '', version: '' };

/**
 * The open documents (tabs) and which one is active. UI modules listen for:
 *   'viewschange'  — a tab was opened, closed or moved
 *   'activechange' — a different tab became active (or none)
 *   'viewchange'   — the active document's state changed (page, zoom, search, annotations…)
 *   'tabchange'    — any document's state changed (status, unsaved changes…)
 *   'viewready'    — a document finished loading
 */
class App extends EventTarget {
  views = [];
  active = null;
  /** Paths of recently closed documents, for Ctrl+Shift+T. */
  closed = [];

  constructor(stage) {
    super();
    this.stage = stage;
  }

  async open(file) {
    const existing = this.views.find((v) => v.file.path.toLowerCase() === file.path.toLowerCase());
    if (existing) {
      this.activate(existing);
      return existing;
    }
    const view = new DocumentView(file, libs, { author: session.user });
    view.mount(this.stage);
    view.textEditor = new TextEditor(view, { notify: (message) => toast(message, { timeout: 6500 }) });
    view.onRequestClose = () => this.requestClose(view);
    view.onConfirmSignedChanges = () => confirmSignedChanges(view);
    const savePosition = debounce(() => rememberPosition(view), 800);
    view.addEventListener('change', () => {
      if (view === this.active) this.#emit('viewchange');
      this.#emit('tabchange');
      if (view.status === 'ready') savePosition();
    });
    view.addEventListener('ready', () => {
      this.#emit('viewready');
      if (view === this.active) view.focus();
    });
    view.addEventListener('zoomed', () => { if (view === this.active) ui.viewbar.pulseZoom(); });
    view.addEventListener('notice', (e) => toast(e.detail.message, { timeout: 6500 }));
    this.views.push(view);
    this.#emit('viewschange');
    this.activate(view);
    await view.load({ askPassword: promptPassword });
    // A history snapshot (read-only) is not a recent file.
    if (view.status === 'ready' && !view.file.readOnly) {
      bridge.send('recent.opened', { path: view.file.path });
      rememberCover(view);
    }
    return view;
  }

  activate(view) {
    if (view === this.active && view) return;
    for (const v of this.views) (v === view ? v.show() : v.hide());
    this.active = view;
    this.stage.classList.toggle('empty', !view);
    document.getElementById('app').classList.toggle('no-doc', !view);
    this.#emit('activechange');
  }

  cycle(delta) {
    if (this.views.length < 2) return;
    const i = this.views.indexOf(this.active);
    this.activate(this.views[(i + delta + this.views.length) % this.views.length]);
  }

  move(view, index) {
    const i = this.views.indexOf(view);
    if (i < 0 || i === index) return;
    this.views.splice(i, 1);
    this.views.splice(index, 0, view);
    this.#emit('viewschange');
  }

  /** Closes a tab, asking about unsaved changes first. Resolves false if the user cancels. */
  async requestClose(view) {
    await view.textEditor?.commitPending(); // text still being typed counts as a change
    if (view.annotations.dirty) {
      this.activate(view);
      const choice = await askToSave([view]);
      if (choice === 'cancel') return false;
      if (choice === 'save' && !(await saveView(view))) return false;
    }
    this.close(view);
    return true;
  }

  close(view) {
    const index = this.views.indexOf(view);
    if (index < 0) return;
    rememberPosition(view);
    if (!view.file.readOnly) this.closed.push(view.file.path);
    if (this.closed.length > 20) this.closed.shift();
    this.views.splice(index, 1);
    try {
      view.destroy();
    } finally {
      // Whatever happens during teardown, never leave a closed document marked as active.
      if (this.active === view) {
        this.active = null;
        this.activate(this.views[Math.min(index, this.views.length - 1)] ?? null);
      }
      this.#emit('viewschange');
    }
  }

  #emit(type) {
    this.dispatchEvent(new Event(type));
  }
}

/** Tells the host where you are in a file, so it reopens there next time. */
function rememberPosition(view) {
  if (view.status !== 'ready' || view.file.readOnly) return;
  const s = view.state;
  bridge.send('recent.update', { path: view.file.path, page: s.pageNumber, scaleValue: String(s.scaleValue ?? ''), viewMode: s.viewMode, spread: s.spread });
}

/** A picture of the first page for the home screen, taken once the document has settled. */
function rememberCover(view) {
  view.firstRender.then(() => setTimeout(async () => {
    if (view.status !== 'ready' || !view.pdf) return;
    try {
      const image = await captureCover(view.pdf);
      bridge.send('recent.cover', { path: view.file.path, image, pages: view.pdf.numPages });
    } catch { /* the home screen shows an icon instead */ }
  }, 1200));
}

/** Before the first change to a digitally signed PDF. Resolves true to go ahead. */
async function confirmSignedChanges(view) {
  app.activate(view);
  const choice = await showDialog({
    title: 'This PDF is digitally signed',
    message: `If you change “${view.file.name}” and save it, its digital signature will no longer be valid: signature checks will show that the document was changed after it was signed. Nothing in the file changes until you save.`,
    iconName: 'triangle-alert',
    // The safe choice is the default (Enter).
    buttons: [{ id: 'change', label: 'Make changes anyway' }, { id: 'cancel', label: 'Cancel', primary: true }],
  });
  return choice === 'change';
}

async function askToSave(views) {
  const one = views.length === 1;
  const choice = await showDialog({
    title: one ? `Save changes to “${views[0].file.name}”?` : `Save changes to ${views.length} documents?`,
    message: one ? 'Your annotations and page changes will be lost if you don’t save them.' : `${views.map((v) => v.file.name).join(', ')} have unsaved changes.`,
    iconName: 'save',
    buttons: [{ id: 'discard', label: 'Don’t save' }, { id: 'cancel', label: 'Cancel' }, { id: 'save', label: one ? 'Save' : 'Save all', primary: true }],
  });
  return choice ?? 'cancel';
}

/** Saves a document's annotations and page changes into its file (or a new file for Save As). Resolves true on success. */
async function saveView(view, { saveAs = false } = {}) {
  if (view.status !== 'ready') return false;
  // Keep text that's still being typed; if it can't be kept, the editor says why and nothing is saved.
  if (view.textEditor && !(await view.textEditor.commitPending())) return false;
  if (!saveAs && !view.annotations.dirty) return true;
  // A history snapshot never changes: saving it means keeping a copy somewhere else.
  if (view.file.readOnly) saveAs = true;
  if (view.encrypted && saveAs) {
    await showDialog({
      title: 'Save As isn’t available for this PDF',
      message: 'It’s protected (encrypted), so Vellum can’t write a new copy of it. Use Save instead: your annotations are kept alongside the original, in Vellum.',
      iconName: 'lock',
    });
    return false;
  }
  let target = view.file;
  if (saveAs) {
    const { file } = await bridge.request('saveAsDialog', { path: view.file.path, name: view.file.name });
    if (!file) return false;
    target = file;
  }
  try {
    await view.saveTo(target);
  } catch (err) {
    await showDialog({ title: 'Couldn’t save', message: err.message, iconName: 'triangle-alert' });
    return false;
  }
  let historyNote = null;
  if (target.path.toLowerCase() !== view.file.path.toLowerCase()) {
    // The document's history follows it to the new file; a snapshot opened read-only has none of its own.
    if (!view.file.readOnly) {
      try {
        const { conflict } = await bridge.request('history.move', { path: view.file.path, to: target.path });
        if (conflict) historyNote = `“${target.name}” already has history of its own, so this document’s history stayed with “${view.file.name}”. Nothing was merged.`;
      } catch (err) {
        historyNote = `The document’s history couldn’t move with it and stayed with “${view.file.name}”: ${err.message}`;
      }
    }
    view.retarget(target);
    bridge.send('recent.opened', { path: target.path });
  }
  toast(view.encrypted ? `Annotations saved in Vellum for “${target.name}”` : `Saved “${target.name}”`, { kind: 'success' });
  if (historyNote) toast(historyNote, { timeout: 8000 });
  return true;
}

const stage = document.getElementById('stage');
const app = new App(stage);
const ui = {};

async function openAll(files) {
  for (const file of files) await app.open(file);
}

// ---- appearance ----------------------------------------------------------------------------

/** Shows an appearance, remembers it, and tells the host (window frame colour, Chromium's own controls). */
function setAppearance(patch = {}, { origin } = {}) {
  appearance = { ...appearance, ...patch };
  const applied = (mode) => {
    const background = toHex(getComputedStyle(document.documentElement).getPropertyValue('--bg').trim() || '#edf1f0');
    bridge.send('window.setTheme', { theme: mode, system: appearance.mode === 'system', background });
    ui.titlebar?.syncTheme();
    document.dispatchEvent(new Event('appearancechange'));
  };
  if (origin) switchAppearance(appearance, { origin, onApplied: applied });
  else applied(applyAppearance(appearance));
}
onSystemModeChange(() => {
  if (appearance.mode === 'system') setAppearance({}, { origin: originOf(ui.titlebar?.themeBtn) });
});

// Page tone: how pages themselves are coloured (separate from the app theme). Pure CSS filters,
// so switching is instant and nothing is re-rendered.
const PAGE_TONES = { normal: 'Normal pages', dark: 'Dark pages', sepia: 'Sepia pages' };
const currentPageTone = () => (PAGE_TONES[document.documentElement.dataset.pageTone] ? document.documentElement.dataset.pageTone : 'normal');

function setPageTone(tone) {
  document.documentElement.dataset.pageTone = tone;
  try { localStorage.setItem('vellum.pageTone', tone); } catch { /* storage unavailable */ }
  ui.toolbar?.update();
}

// ---- actions -------------------------------------------------------------------------------

const actions = {
  // The text tables on the current page (semantic/tables.js), copied as tab-separated text to paste into a
  // spreadsheet. Only tables found on strong evidence; otherwise it says none was confidently detected.
  async copyPageTables(view) {
    const number = view.state.pageNumber;
    if (view.encrypted) return toast('The text of a protected PDF isn’t read, so its tables can’t be copied.');
    try {
      const { tables } = pageTables(await readSessionPage(view.textEditing, view.pdf, number));
      if (!tables.length) return toast(`No table was confidently detected on page ${number}.`, { timeout: 4000 });
      copyText(tables.map(tableToTsv).join('\n\n'));
      const what = tables.length === 1 ? `a table (${tables[0].rowCount} rows × ${tables[0].columnCount} columns)` : `${tables.length} tables`;
      toast(`Copied ${what} from page ${number}`, { kind: 'success' });
    } catch (err) {
      toast(err.message, { kind: 'error' });
    }
  },
  cyclePageTone() {
    const order = Object.keys(PAGE_TONES);
    const next = order[(order.indexOf(currentPageTone()) + 1) % order.length];
    setPageTone(next);
    toast(PAGE_TONES[next], { timeout: 1600 });
  },
  async openDialog() {
    try {
      const { files } = await bridge.request('openDialog');
      await openAll(files);
    } catch (err) {
      toast(err.message, { kind: 'error' });
    }
  },
  async openRecent(path) {
    try {
      const { file } = await bridge.request('openPath', { path });
      await app.open(file);
    } catch (err) {
      toast(err.message, { kind: 'error' });
      ui.start.refresh();
    }
  },
  /** A piece of Collection research evidence: its document opens (as a recent one does) at its page, with its box marked. */
  async openEvidence({ path, number, box }) {
    try {
      const { file } = await bridge.request('openPath', { path });
      const view = await app.open(file);
      if (view?.status !== 'ready') return;
      view.goToPage(number);
      // The page has to be laid out before its box can be outlined.
      await markPageBoxWhenReady(view, number, box);
    } catch (err) {
      toast(err.message, { kind: 'error' });
      ui.start.refresh();
    }
  },
  /**
   * The document graph of the open document (ui/knowledge-graph.js): the collections that list this file and
   * the evidence the Structure panel's research has already quoted from it. Derived here and thrown away —
   * nothing is stored, nothing is read from disk, and the document isn't changed.
   */
  async showDocumentGraph() {
    const view = app.active;
    if (view?.status !== 'ready') return;
    let collections = [];
    try { ({ collections } = await bridge.request('collections.list')); } catch { /* no host (dev) */ }
    const research = ui.sidebar.structure?.research ?? null;
    const path = view.file.path;
    await showKnowledgeGraph({
      focus: { kind: 'document', path, name: view.file.name },
      document: { path, name: view.file.name, pages: view.pdf?.numPages ?? null, contentKey: view.docKey ?? null },
      collections,
      evidence: research?.sufficient ? research.evidence.map((e) => ({ ...e, path })) : [],
      onOpen: (node) => (node.number
        ? actions.openEvidence({ path: node.path, number: node.number, box: node.box ?? null })
        : actions.openRecent(node.path)),
    });
  },
  async openDropped(files) {
    const pdfs = files.filter((f) => f.type === 'application/pdf' || /\.pdf$/i.test(f.name));
    const skipped = files.length - pdfs.length;
    if (skipped) toast(skipped === 1 ? `“${files.find((f) => !pdfs.includes(f)).name}” isn’t a PDF` : `${skipped} files skipped — only PDFs can be opened`, { kind: 'error' });
    if (!pdfs.length) return;
    try {
      const { files: described } = await bridge.request('openDropped', {}, pdfs);
      await openAll(described);
    } catch (err) {
      toast(err.message, { kind: 'error' });
    }
  },
  save() {
    if (app.active) saveView(app.active);
  },
  saveAs() {
    if (app.active) saveView(app.active, { saveAs: true });
  },
  print() {
    if (app.active?.status === 'ready') printDocument(app.active, libs.pdfjsLib);
  },
  close() {
    if (app.active) app.requestClose(app.active);
  },
  reopenClosed() {
    const path = app.closed.pop();
    if (path) actions.openRecent(path);
  },
  showInFolder() {
    if (app.active) bridge.request('showInFolder', { path: app.active.file.path });
  },
  /** Light ↔ dark. From a click the new colours grow out of the pointer; from a key, out of the button. */
  toggleTheme(e) {
    const dark = document.documentElement.dataset.theme === 'dark';
    const origin = e?.clientX ? [e.clientX, e.clientY] : originOf(ui.titlebar.themeBtn);
    setAppearance({ mode: dark ? 'light' : 'dark' }, { origin });
  },
  palette() {
    ui.palette.open();
  },
  settings(section) {
    showSettings(settingsContext, typeof section === 'string' ? section : undefined);
  },
  about() {
    showAbout({ version: session.version, updates: ui.updates });
  },
  checkForUpdates() {
    ui.updates.checkNow();
  },
  async setDefault() {
    const choice = await showDialog({
      title: 'Make Vellum your PDF app',
      message: 'Vellum will register itself as a PDF handler for your account. Windows then asks you to confirm in Settings: pick Vellum next to “.pdf”.',
      iconName: 'file-text',
      buttons: [{ id: 'cancel', label: 'Cancel' }, { id: 'ok', label: 'Open Settings', primary: true }],
    });
    if (choice !== 'ok') return;
    try {
      await bridge.request('assoc.register');
    } catch (err) {
      toast(err.message, { kind: 'error' });
    }
  },
};

actions.pages = createPageActions({ onOpenFile: (file) => app.open(file) });
actions.ocr = createOcrActions({ openSettings: (section) => actions.settings(section) });
actions.compare = createCompareActions({ app, pdfjsLib: libs.pdfjsLib });
actions.health = createHealthActions({ app });
actions.export = createExportActions({ pdfjsLib: libs.pdfjsLib });
actions.optimize = createOptimizeActions();
actions.history = createHistoryActions({ app, compare: actions.compare, save: (view) => saveView(view) });

const commands = createCommands(app, ui, actions);

const settingsContext = {
  appearance: () => appearance,
  setAppearance,
  pageTone: currentPageTone,
  setPageTone,
  history: () => actions.history,
  updates: () => ui.updates,
  version: () => session.version,
  commands: () => commands,
  setDefault: () => actions.setDefault(),
};

// ---- UI --------------------------------------------------------------------------------------

setFocusFallback(() => app.active?.focus());
ui.titlebar = new TitleBar(document.getElementById('titlebar'), app, { bridge, commands });
ui.tabs = new TabStrip(ui.titlebar.tabHost, app, { onNew: () => app.activate(null), onClose: (view) => app.requestClose(view) });
ui.toolbar = new Toolbar(document.getElementById('toolbar'), app, commands);
ui.toolbar.pageTones = PAGE_TONES;
ui.toolbar.onPageTone = setPageTone;
ui.sidebar = new Sidebar(document.getElementById('sidebar'), app, actions.pages);
ui.findbar = new FindBar(stage, app);
ui.viewbar = new ViewBar(stage, app, commands);
ui.start = new StartScreen(stage, {
  bridge,
  onOpenDialog: () => actions.openDialog(),
  onOpenRecent: (p) => actions.openRecent(p),
  onOpenEvidence: (e) => actions.openEvidence(e),
});
ui.updates = new Updates({ bridge, titlebar: ui.titlebar, prepareToQuit, openFiles: () => app.views.map((v) => v.file.path) });
ui.palette = new CommandPalette({ app, commands, bridge, onOpenRecent: (p) => actions.openRecent(p) });
installShortcuts(commands);

// Files dropped on the page thumbnails are inserted there; anywhere else they open as tabs.
const isPdf = (f) => f.type === 'application/pdf' || /\.pdf$/i.test(f.name);
installDropZone({
  onFiles: (files) => actions.openDropped(files),
  zones: [{
    accepts: (e) => Boolean(e.target?.closest?.('.thumbs') && app.active?.canEditPages && ui.sidebar.thumbs),
    over: (e) => ui.sidebar.thumbs?.showCaret(ui.sidebar.thumbs.insertionIndex(e.clientY)),
    leave: () => ui.sidebar.thumbs?.hideCaret(),
    async drop(files, e) {
      const view = app.active;
      const index = ui.sidebar.thumbs.insertionIndex(e.clientY);
      const pdfs = files.filter(isPdf);
      if (!pdfs.length) {
        toast('Only PDF files can be inserted', { kind: 'error' });
        return;
      }
      try {
        const { files: described } = await bridge.request('openDropped', {}, pdfs);
        await actions.pages.insertFiles(view, described, index);
      } catch (err) {
        toast(err.message, { kind: 'error' });
      }
    },
  }],
});

bridge.on('open-files', ({ files }) => openAll(files));

// Window title (taskbar) follows the active document; a dot marks unsaved changes.
let lastTitle = '';
const updateTitle = () => {
  const view = app.active;
  const title = view ? `${view.file.name}${view.annotations.dirty ? ' •' : ''} — Vellum` : 'Vellum';
  if (title === lastTitle) return;
  lastTitle = title;
  bridge.send('window.setTitle', { title });
};
app.addEventListener('activechange', () => {
  if (!app.active) ui.start.refresh();
  updateTitle();
});
app.addEventListener('viewchange', updateTitle);

/** Before quitting (closing the window, or restarting to update): offer to save unsaved changes. False if cancelled. */
async function prepareToQuit() {
  for (const view of app.views) await view.textEditor?.commitPending();
  const dirty = app.views.filter((v) => v.annotations.dirty);
  if (dirty.length) {
    if (dirty.length === 1) app.activate(dirty[0]);
    const choice = await askToSave(dirty);
    if (choice === 'cancel') return false;
    if (choice === 'save') {
      for (const view of dirty) {
        app.activate(view);
        if (!(await saveView(view))) return false;
      }
    }
  }
  for (const view of app.views) rememberPosition(view);
  return true;
}

let closing = false;
bridge.on('close-requested', async () => {
  if (closing) return;
  closing = true;
  try {
    if (await prepareToQuit()) bridge.send('window.closeConfirmed');
  } finally {
    closing = false;
  }
});

const menuItem = (id, iconName, extra = {}) => {
  const c = commands[id];
  return { label: c.label, icon: iconName ?? c.icon, shortcut: c.hint ?? c.keys?.[0], action: () => c.run(), ...extra };
};

// "More" menu in the toolbar.
ui.toolbar.onMenu = async (anchor) => {
  let entries = [];
  try { ({ entries } = await bridge.request('recent.list')); } catch { /* ignore */ }
  const openPaths = new Set(app.views.map((v) => v.file.path.toLowerCase()));
  const recent = entries.filter((e) => e.exists && !openPaths.has(e.path.toLowerCase())).slice(0, 6);
  const ready = app.active?.status === 'ready';
  openMenu([
    menuItem('file.open'),
    ...(recent.length ? ['-', ...recent.map((e) => ({ label: e.path.slice(e.path.lastIndexOf('\\') + 1), icon: 'clock', action: () => actions.openRecent(e.path) }))] : []),
    '-',
    menuItem('file.save', null, { disabled: !ready || !app.active.annotations.dirty }),
    menuItem('file.saveAs', null, { disabled: !ready }),
    menuItem('file.print', null, { disabled: !ready }),
    menuItem('file.export', null, { disabled: !ready }),
    menuItem('file.showInFolder', null, { disabled: !app.active }),
    menuItem('file.history', null, { disabled: !actions.history.canUse(app.active) }),
    menuItem('file.close', null, { disabled: !app.active }),
    '-',
    menuItem('pages.insert', null, { disabled: !app.active?.canEditPages }),
    menuItem('pages.extract', null, { disabled: !app.active?.canEditPages }),
    menuItem('pages.split', null, { disabled: !app.active?.canEditPages }),
    menuItem('pages.merge'),
    '-',
    menuItem('tools.ocrPage', null, { disabled: !app.active?.canEditPages }),
    menuItem('tools.ocrDocument', null, { disabled: !app.active?.canEditPages }),
    menuItem('tools.structure', null, { disabled: !ready }),
    menuItem('tools.graph', null, { disabled: !ready }),
    menuItem('tools.health', null, { disabled: !ready }),
    menuItem('tools.compress', null, { disabled: !ready || Boolean(app.active?.encrypted) }),
    menuItem('tools.pdfa', null, { disabled: !ready || Boolean(app.active?.encrypted) }),
    menuItem('tools.compare'),
    '-',
    menuItem('app.palette'),
    menuItem('app.settings'),
    menuItem('app.checkUpdates'),
    menuItem('app.about'),
  ], { anchor, align: 'end' });
};

// Right-click menu over the document.
document.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  const view = app.active;
  if (!view || view.status !== 'ready' || !stage.contains(e.target) || e.target.closest('.findbar, .viewbar, .vl-pop, .vl-note-editor, .vl-text-editor')) return;
  const layer = view.annotLayer;
  const selected = view.getSelectedText();
  const hit = selected ? null : layer.hitAt(e.clientX, e.clientY);
  const link = e.target.closest('.annotationLayer a[href]');
  const onPage = Boolean(e.target.closest('.page'));
  const items = [];
  if (selected) {
    items.push(
      { label: 'Highlight', icon: 'highlighter', shortcut: 'H', action: () => layer.markSelection('highlight') },
      { label: 'Underline', icon: 'underline', shortcut: 'U', action: () => layer.markSelection('underline') },
      { label: 'Add Link', icon: 'link', action: () => layer.addLinkOverSelection() },
      { label: 'Copy', icon: 'copy', shortcut: 'Ctrl+C', action: copySelection },
      { label: `Search for “${truncate(selected, 28)}”`, icon: 'search', action: () => ui.findbar.open(selected) },
      '-');
  }
  // A Text Box (new text, written into the page) selected in Edit mode is named as one, first.
  const boxes = view.textEditor?.active ? view.objectSelection?.current?.keys ?? [] : [];
  if (boxes.length && boxes.every((key) => key.startsWith('text:'))) {
    const one = boxes.length === 1;
    items.push(
      { heading: one ? 'Text Box' : 'Text Boxes' },
      { label: one ? 'Copy Text Box' : 'Copy Text Boxes', icon: 'copy', shortcut: 'Ctrl+C', action: () => view.textEditor.copySelected() },
      { label: one ? 'Cut Text Box' : 'Cut Text Boxes', icon: 'scissors', shortcut: 'Ctrl+X', action: () => view.textEditor.cutSelected() },
      { label: one ? 'Duplicate Text Box' : 'Duplicate Text Boxes', icon: 'copy-plus', shortcut: 'Ctrl+D', action: () => view.textEditor.duplicateSelected() },
      '-',
    );
  }
  if (hit) {
    layer.select(hit.id, { popover: false });
    if (hit.type === 'note') items.push({ label: 'Edit note', icon: 'sticky-note', action: () => layer.editNote(hit.id) });
    // A form field is named as one, so it is never taken for text on the page (a Text Box).
    if (hit.type === 'field') items.push({ heading: `Form Field · ${FIELD_KINDS[hit.kind]?.label ?? 'Field'}` });
    if (hit.type === 'link') items.push({ heading: `Link · ${linkLabel(hit)}` });
    const what = hit.type === 'field' ? 'Delete Form Field' : hit.type === 'link' ? 'Delete Link' : 'Delete annotation';
    items.push({ label: what, icon: 'trash-2', shortcut: 'Del', action: () => layer.deleteSelected() }, '-');
  }
  // One of the file's own form fields: moved, resized, renamed… like a created one (forms/fields.js).
  const ownField = !hit && !selected && layer.existingFieldAt(e.target);
  if (ownField) {
    items.push({ heading: 'Form Field' },
      { label: 'Edit Form Field', icon: 'text-cursor-input', action: () => layer.editExistingField(ownField) }, '-');
  }
  // One of the file's own links: given a new address or page, moved, resized or removed (links/links.js).
  const ownLink = !hit && !selected && layer.existingLinkAt(e.target);
  if (ownLink) {
    items.push({ heading: 'Link' },
      { label: 'Edit Link', icon: 'link', action: () => layer.editExistingLink(ownLink) }, '-');
  }
  // Sections, most common first: Page Content (editing what is on the page), Page Tools, then Form Fields
  // last and apart, so a Form Text Field is never taken for a Text Box.
  const pageNumber = Number(e.target.closest('.page')?.dataset.pageNumber) || null;
  const addHere = !hit && !selected && onPage;
  items.push({ heading: 'Page Content' });
  if (pageNumber && view.textEditor?.active) {
    // The text box starts where the page was right-clicked, read now: the page may scroll or zoom before the choice.
    const clickedPage = view.viewer.getPageView(pageNumber - 1);
    const clickedAt = clickedPage ? toPdfPoint(clickedPage, e.clientX, e.clientY) : null;
    items.push(
      { label: 'Add Text Box', icon: 'type', action: () => view.textEditor.addText(pageNumber, clickedAt) },
      { label: 'Insert picture…', icon: 'image-plus', action: () => view.textEditor.insertPicture(pageNumber) },
      { label: 'Add signature…', icon: 'pen-line', action: () => view.textEditor.addSignature(pageNumber) },
    );
  }
  if (addHere) items.push({ label: 'Add note here', icon: 'sticky-note', action: () => layer.addNoteAt(e.clientX, e.clientY) });
  items.push(menuItem('edit.selectAll', 'text-select'), menuItem('find.open', 'search'), '-');
  if (link && /^(https?|mailto):/i.test(link.href)) {
    items.push({ label: 'Open link', icon: 'external-link', action: () => window.open(link.href, '_blank') });
    items.push({ label: 'Copy link address', icon: 'copy', action: () => copyText(link.href) }, '-');
  }
  const s = view.state;
  if (s.canUndo || s.canRedo) {
    items.push(menuItem('edit.undo', 'undo-2', { disabled: !s.canUndo }), menuItem('edit.redo', 'redo-2', { disabled: !s.canRedo }), '-');
  }
  items.push({ heading: 'Page Tools' });
  const pageEl = e.target.closest('.page');
  const pageId = pageEl && view.shownPlan?.[Number(pageEl.dataset.pageNumber) - 1]?.id;
  if (pageId && s.canEditPages) {
    items.push(
      { label: 'Rotate page right', icon: 'rotate-cw', action: () => actions.pages.rotate(view, [pageId], 90) },
      { label: 'Rotate page left', icon: 'rotate-ccw', action: () => actions.pages.rotate(view, [pageId], -90) },
      { label: 'Delete page', icon: 'trash-2', action: () => actions.pages.remove(view, [pageId]) },
    );
  }
  items.push(
    menuItem('page.prev', 'chevron-up', { disabled: s.pageNumber <= 1, shortcut: null }),
    menuItem('page.next', 'chevron-down', { disabled: s.pageNumber >= s.pagesCount, shortcut: null }),
    '-',
    menuItem('zoom.in', 'zoom-in'),
    menuItem('zoom.out', 'zoom-out'),
    menuItem('zoom.fitWidth', 'move-horizontal'),
    menuItem('zoom.fitPage', 'maximize'),
    '-',
    menuItem('view.rotateCw', 'rotate-cw'),
    menuItem('view.rotateCcw', 'rotate-ccw'),
    menuItem('file.print', 'printer'),
  );
  if (addHere && view.canEditPages) {
    // Form fields (AcroForm): a Text Field is a box to fill in, not text written on the page.
    items.push(
      '-',
      { heading: 'Form Fields' },
      { label: 'Add Text Field here', icon: 'text-cursor-input', action: () => layer.addFieldAt(e.clientX, e.clientY, 'text') },
      { label: 'Add Checkbox here', icon: 'check', action: () => layer.addFieldAt(e.clientX, e.clientY, 'checkbox') },
      { label: 'Add Radio Button here', icon: 'list-checks', action: () => layer.addFieldAt(e.clientX, e.clientY, 'radio') },
      { label: 'Add Dropdown here', icon: 'chevron-down', action: () => layer.addFieldAt(e.clientX, e.clientY, 'dropdown') },
    );
  }
  openMenu(items, { x: e.clientX, y: e.clientY });
});

try {
  const { files, user, name, version, updatedFrom, updateFailed } = await bridge.request('ready');
  session.user = user ?? '';
  session.version = version ?? '';
  setAppearance(); // tells the host the saved appearance (window frame, Chromium controls)
  ui.start.setName(name ?? '');
  if (updatedFrom) ui.updates.announce(version);
  if (files.length) await openAll(files);
  else ui.start.refresh();
  if (updateFailed) ui.updates.failed(updateFailed, version);
  // The daily update check waits until startup has settled.
  setTimeout(() => ui.updates.checkQuietly(), 6000);
} catch (err) {
  window.__vellum.errors.push(String(err?.stack ?? err));
}

window.__vellum.app = app;
window.__vellum.actions = actions;
window.__vellum.ui = ui;
window.__vellum.setAppearance = setAppearance;
