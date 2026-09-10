import { bridge } from './bridge.js';
import { loadPdfjs } from './pdfjs.js';
import { h, truncate, debounce } from './dom.js';
import { DocumentView } from './document-view.js';
import { createCommands, copySelection, copyText } from './commands.js';
import { installShortcuts } from './shortcuts.js';
import { Toolbar } from './ui/toolbar.js';
import { Sidebar } from './ui/sidebar.js';
import { FindBar } from './ui/findbar.js';
import { StartScreen } from './ui/start.js';
import { TitleBar } from './ui/titlebar.js';
import { TabStrip } from './ui/tabs.js';
import { installDropZone } from './ui/dropzone.js';
import { openMenu } from './ui/menu.js';
import { promptPassword, showDialog, toast } from './ui/dialogs.js';
import { printDocument } from './print.js';
import { showAbout } from './ui/about.js';
import { createPageActions } from './pages/actions.js';
import { Updates } from './ui/updates.js';

// Diagnostics hook read by tools/cdp.mjs during development.
window.__vellum = { errors: [] };
window.addEventListener('error', (e) => window.__vellum.errors.push(String(e.message)));
window.addEventListener('unhandledrejection', (e) => window.__vellum.errors.push(String(e.reason?.stack ?? e.reason)));

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
    view.onRequestClose = () => this.requestClose(view);
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
    view.addEventListener('zoomed', () => { if (view === this.active) zoomHud.show(view.state.scale); });
    view.addEventListener('notice', (e) => toast(e.detail.message, { timeout: 6500 }));
    this.views.push(view);
    this.#emit('viewschange');
    this.activate(view);
    await view.load({ askPassword: promptPassword });
    if (view.status === 'ready') bridge.send('recent.opened', { path: view.file.path });
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

  /** Closes a tab, asking about unsaved annotations first. Resolves false if the user cancels. */
  async requestClose(view) {
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
    this.closed.push(view.file.path);
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
  if (view.status !== 'ready') return;
  const s = view.state;
  bridge.send('recent.update', { path: view.file.path, page: s.pageNumber, scaleValue: String(s.scaleValue ?? ''), viewMode: s.viewMode });
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

/** Saves a document's annotations into its file (or a new file for Save As). Resolves true on success. */
async function saveView(view, { saveAs = false } = {}) {
  if (view.status !== 'ready') return false;
  if (!saveAs && !view.annotations.dirty) return true;
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
  if (target.path.toLowerCase() !== view.file.path.toLowerCase()) {
    view.retarget(target);
    bridge.send('recent.opened', { path: target.path });
  }
  toast(view.encrypted ? `Annotations saved in Vellum for “${target.name}”` : `Saved “${target.name}”`, { kind: 'success' });
  return true;
}

/** Brief "125%" readout while zooming. */
const zoomHud = {
  el: h('div', { class: 'zoom-hud ui', 'aria-hidden': 'true' }),
  timer: 0,
  show(scale) {
    this.el.textContent = `${Math.round(scale * 100)}%`;
    this.el.classList.add('visible');
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.el.classList.remove('visible'), 850);
  },
};

const stage = document.getElementById('stage');
const app = new App(stage);

async function openAll(files) {
  for (const file of files) await app.open(file);
}

const currentTheme = () => (document.documentElement.dataset.theme === 'light' ? 'light' : 'dark');

/** Switches theme with a brief colour cross-fade, remembers it, and tells the host (window frame colours). */
function applyTheme(theme, { animate = false } = {}) {
  const root = document.documentElement;
  if (animate) {
    root.classList.add('theme-switching');
    setTimeout(() => root.classList.remove('theme-switching'), 350);
  }
  root.dataset.theme = theme;
  try { localStorage.setItem('vellum.theme', theme); } catch { /* storage unavailable */ }
  bridge.send('window.setTheme', { theme });
  ui.titlebar?.syncTheme();
}

// Page tone: how pages themselves are coloured (separate from the app theme). Pure CSS filters,
// so switching is instant and nothing is re-rendered.
const PAGE_TONES = { normal: 'Normal pages', dark: 'Dark pages', sepia: 'Sepia pages' };
const currentPageTone = () => (PAGE_TONES[document.documentElement.dataset.pageTone] ? document.documentElement.dataset.pageTone : 'normal');

function setPageTone(tone) {
  document.documentElement.dataset.pageTone = tone;
  try { localStorage.setItem('vellum.pageTone', tone); } catch { /* storage unavailable */ }
  ui.toolbar?.update();
}

const actions = {
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
  toggleTheme() {
    applyTheme(currentTheme() === 'light' ? 'dark' : 'light', { animate: true });
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

const ui = {};
const commands = createCommands(app, ui, actions);
ui.titlebar = new TitleBar(document.getElementById('titlebar'), app, { bridge, commands });
ui.tabs = new TabStrip(ui.titlebar.tabHost, app, { onNew: () => actions.openDialog(), onClose: (view) => app.requestClose(view) });
ui.toolbar = new Toolbar(document.getElementById('toolbar'), app, commands);
ui.toolbar.pageTones = PAGE_TONES;
ui.toolbar.onPageTone = setPageTone;
ui.sidebar = new Sidebar(document.getElementById('sidebar'), app, actions.pages);
ui.findbar = new FindBar(stage, app);
ui.start = new StartScreen(stage, { bridge, onOpenDialog: () => actions.openDialog(), onOpenRecent: (p) => actions.openRecent(p) });
ui.updates = new Updates({ bridge, titlebar: ui.titlebar, prepareToQuit, openFiles: () => app.views.map((v) => v.file.path) });
stage.append(zoomHud.el);
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

// Window title (taskbar) follows the active document; a dot marks unsaved annotations.
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
  return { label: c.label, icon: iconName, shortcut: c.hint ?? c.keys?.[0], action: () => c.run(), ...extra };
};

// "More" menu in the toolbar.
ui.toolbar.onMenu = async (anchor) => {
  let entries = [];
  try { ({ entries } = await bridge.request('recent.list')); } catch { /* ignore */ }
  const openPaths = new Set(app.views.map((v) => v.file.path.toLowerCase()));
  const recent = entries.filter((e) => e.exists && !openPaths.has(e.path.toLowerCase())).slice(0, 6);
  const ready = app.active?.status === 'ready';
  openMenu([
    menuItem('file.open', 'folder-open'),
    ...(recent.length ? ['-', ...recent.map((e) => ({ label: e.path.slice(e.path.lastIndexOf('\\') + 1), icon: 'clock', action: () => actions.openRecent(e.path) }))] : []),
    '-',
    menuItem('file.save', 'save', { disabled: !ready || !app.active.annotations.dirty }),
    menuItem('file.saveAs', 'save-all', { disabled: !ready }),
    menuItem('file.print', 'printer', { disabled: !ready }),
    menuItem('file.showInFolder', 'folder-open', { disabled: !app.active }),
    menuItem('file.close', 'x', { disabled: !app.active }),
    '-',
    menuItem('pages.insert', 'files', { disabled: !app.active?.canEditPages }),
    menuItem('pages.extract', 'file-output', { disabled: !app.active?.canEditPages }),
    menuItem('pages.split', 'scissors', { disabled: !app.active?.canEditPages }),
    '-',
    currentTheme() === 'light'
      ? menuItem('view.theme', 'moon', { label: 'Dark theme' })
      : menuItem('view.theme', 'sun', { label: 'Light theme' }),
    menuItem('app.setDefault', 'file-text'),
    menuItem('app.checkUpdates', 'refresh-cw'),
    menuItem('app.about', 'info'),
  ], { anchor, align: 'end' });
};

// Right-click menu over the document.
document.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  const view = app.active;
  if (!view || view.status !== 'ready' || !stage.contains(e.target) || e.target.closest('.findbar, .vl-pop, .vl-note-editor')) return;
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
      { label: 'Copy', icon: 'copy', shortcut: 'Ctrl+C', action: copySelection },
      { label: `Search for “${truncate(selected, 28)}”`, icon: 'search', action: () => ui.findbar.open(selected) },
      '-');
  }
  if (hit) {
    layer.select(hit.id, { popover: false });
    if (hit.type === 'note') items.push({ label: 'Edit note', icon: 'sticky-note', action: () => layer.editNote(hit.id) });
    items.push({ label: 'Delete annotation', icon: 'trash-2', shortcut: 'Del', action: () => layer.deleteSelected() }, '-');
  } else if (!selected && onPage) {
    items.push({ label: 'Add note here', icon: 'sticky-note', action: () => layer.addNoteAt(e.clientX, e.clientY) }, '-');
  }
  if (link && /^(https?|mailto):/i.test(link.href)) {
    items.push({ label: 'Open link', icon: 'external-link', action: () => window.open(link.href, '_blank') });
    items.push({ label: 'Copy link address', icon: 'copy', action: () => copyText(link.href) }, '-');
  }
  const s = view.state;
  if (s.canUndo || s.canRedo) {
    items.push(menuItem('edit.undo', 'undo-2', { disabled: !s.canUndo }), menuItem('edit.redo', 'redo-2', { disabled: !s.canRedo }), '-');
  }
  const pageEl = e.target.closest('.page');
  const pageId = pageEl && view.shownPlan?.[Number(pageEl.dataset.pageNumber) - 1]?.id;
  if (pageId && s.canEditPages) {
    items.push(
      { label: 'Rotate page right', icon: 'rotate-cw', action: () => actions.pages.rotate(view, [pageId], 90) },
      { label: 'Rotate page left', icon: 'rotate-ccw', action: () => actions.pages.rotate(view, [pageId], -90) },
      { label: 'Delete page', icon: 'trash-2', action: () => actions.pages.remove(view, [pageId]) },
      '-');
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
    '-',
    menuItem('edit.selectAll', 'text-select'),
    menuItem('find.open', 'search'),
    menuItem('file.print', 'printer'),
  );
  openMenu(items, { x: e.clientX, y: e.clientY });
});

try {
  const { files, theme, user, version, updatedFrom } = await bridge.request('ready');
  session.user = user ?? '';
  session.version = version ?? '';
  // localStorage is the page's source of truth; fall back to the host's copy if it was cleared.
  let stored = null;
  try { stored = localStorage.getItem('vellum.theme'); } catch { /* storage unavailable */ }
  applyTheme(stored ? currentTheme() : (theme === 'light' ? 'light' : 'dark'));
  if (updatedFrom) ui.updates.announce(version);
  if (files.length) await openAll(files);
  else ui.start.refresh();
  // The daily update check waits until startup has settled.
  setTimeout(() => ui.updates.checkQuietly(), 6000);
} catch (err) {
  window.__vellum.errors.push(String(err?.stack ?? err));
}

window.__vellum.app = app;
window.__vellum.actions = actions;
