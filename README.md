# Vellum

A calm, fast PDF reader for Windows. WPF shell, WebView2 surface, pdf.js rendering.

Developed by **Pankaj Manhas** · Homelabs. Made in India.

## Download and install

Download **Vellum-Setup.exe** from the [latest release](https://github.com/litdroner/vellum/releases/latest)
and run it. It installs for your user only (no admin prompt) into `%LOCALAPPDATA%\Programs\Vellum`, adds
a Start-menu entry and, if you tick the option, registers Vellum as a PDF app. Windows then asks you to
confirm the default once in **Settings → Apps → Default apps → Vellum** (no app can make itself the
default silently). Needs the Microsoft Edge WebView2 Runtime, which Windows 10/11 normally already has.

The installer isn't code-signed yet, so SmartScreen may show "Windows protected your PC": choose
**More info → Run anyway**.

### Updates
Vellum checks GitHub for a new version once a day (switch this off in **About**), and
**⋯ → Check for updates…** checks right away. Updating downloads the new installer, verifies it against
the SHA-256 GitHub publishes for it, installs it and reopens the documents you had open.

## What it does

- Open by double-click, drag-and-drop, Ctrl+O, recent files (reopens where you left off); tabs.
- Continuous or single-page view; zoom (fit width, fit page, %, Ctrl+scroll); rotation.
- Page thumbnails and the PDF's own outline; search with highlighting; text selection and copy.
- Highlight, underline, sticky notes, freehand drawing — saved into the PDF as standard annotations
  (other readers show them too) and reopened as editable. Undo/redo.
- **Page organiser** (the Pages sidebar): rotate, delete, duplicate, insert blank pages, drag
  thumbnails to reorder (Ctrl/Shift+click to select several), insert pages from another PDF (or drop
  a PDF onto the thumbnails), extract pages to a new file, split into several files. Page edits and
  annotations share one undo history, and annotations move with their pages. Deleted pages are
  removed from the saved file, not just hidden.
- **Edit text** (E): click a line of text in the PDF and change it in place. Vellum writes it with the
  document's own font when that font has every character, otherwise with a matching standard font (and
  says so first). Only edited pages change, the old text is really removed from the file, and edits
  undo, redo and save like everything else. Text Vellum can't change safely (scans, picture fonts,
  symbol fonts, protected PDFs…) says why instead.
- **Page colours**: normal, dark or sepia pages (Ctrl+Shift+D), independent of the app theme.
- **Appearance**: seven colour themes (Mist, Ocean, Sage, Blush, Sand, Lavender, Graphite), each in
  Light and an Obsidian dark mode or following Windows, plus your own accent colour. Reduce motion and
  reduce transparency for comfort. PDF pages stay true to the file.
- **Home**: a greeting, a large Open card and your recent documents with a picture of their first page.
- **Command palette** (Ctrl+K) for every action and recent file; **Settings** (Ctrl+,) in one place.
- Print, password-protected and damaged files handled with clear messages.

### Protected (encrypted) PDFs
Many PDFs are encrypted even when they open without a password. Vellum can't rewrite those, so it
keeps their annotations alongside the file in `%LOCALAPPDATA%\Vellum\annotations` (matched by the
file's contents). They come back whenever you open that PDF in Vellum; other apps won't see them.

## Shortcuts

| | |
|---|---|
| Open / Save / Save as | Ctrl+O / Ctrl+S / Ctrl+Shift+S |
| Close tab / reopen closed | Ctrl+W / Ctrl+Shift+T |
| Next / previous tab | Ctrl+Tab / Ctrl+Shift+Tab |
| Find / next / previous | Ctrl+F / F3 / Shift+F3 |
| Zoom in / out | Ctrl+= / Ctrl+- (or Ctrl+scroll) |
| Fit page / actual size / fit width | Ctrl+0 / Ctrl+1 / Ctrl+2 |
| Go to page / first / last | Ctrl+G / Home / End |
| Rotate the view (not saved) | Ctrl+Shift+= / Ctrl+Shift+- |
| Page colours: normal → dark → sepia | Ctrl+Shift+D |
| Delete selected pages (in the Pages sidebar) | Del |
| Sidebar | F4 |
| Tools: select, highlight, underline, note, draw | V, H, U, N, D (H/U mark selected text directly) |
| Edit text: keep / cancel / next / previous | E, then Enter / Esc / Tab / Shift+Tab |
| Delete annotation / undo / redo | Del / Ctrl+Z / Ctrl+Y |
| Print | Ctrl+P |
| Command palette / Settings | Ctrl+K / Ctrl+, |
| Light / dark mode | Ctrl+Shift+L |

## Build from source

Requires the .NET 10 SDK and Node (only for dev tools).

```powershell
tools\run.ps1 -Files some.pdf        # build (Debug) and run
tools\run.ps1 -Debug                 # also exposes DevTools on port 9222
node tools\cdp.mjs eval "document.title"   # poke the running app
tools\publish.ps1                    # self-contained Release build + installer (Inno Setup 6)
tools\release.ps1 -NotesFile n.md    # publish the installer as a GitHub release (in-app updates find it)
```

## How it's put together

```
src/Vellum/
  App.xaml.cs              startup, single-instance hand-off, --register-association
  MainWindow.xaml(.cs)     borderless window + WebView2; bridge handlers (files, recents, window, save-as)
  Hosting/
    AppResourceServer.cs   serves the UI and PDFs from https://app.vellum; atomic saves
    BridgeHost.cs          JSON request/reply channel between C# and JS
  Services/                recent files, settings, file association, single instance, window effects
  web/                     the UI (plain ES modules, no build step)
    js/app.js              tabs/app state, commands wiring, save + close flows
    js/document-view.js    one pdf.js viewer per document
    js/annotations/        model (undo/redo), geometry, SVG layer, pdf-lib persistence, print painting
    js/editing/            text editing engine: reads page content, checks it against pdf.js, writes edits
    js/ui/                 title bar, tabs, toolbar, sidebar, find bar, menus, dialogs, start screen
    js/themes.js           colour themes and appearance (seed colours; CSS derives the rest)
    css/app.css            the design system (tokens, glass / clay / paper materials)
    vendor/                pdf.js 6.3, pdf-lib 1.17, Jost font — all local, nothing loaded from the network
installer/Vellum.iss       Inno Setup script
tools/                     run, publish, release, icon, DevTools helpers
tests/editing/             text-editing engine tests (node --test "tests/editing/*.test.mjs")
docs/                      design system, architecture guidelines, feature registry
```

User data lives in `%LOCALAPPDATA%\Vellum` (settings, recent files, protected-PDF annotations,
WebView2 profile) and is kept on uninstall.

## Known limitations
- Snap Layouts flyout on the maximize button isn't available (Win+Z and edge snapping work).
- Annotations on encrypted PDFs are kept by Vellum, not inside the file (see above), and their pages
  can't be rearranged.
- Page colours are a display setting only: printing and saved files are unchanged.
- Text editing changes one line at a time (no paragraph reflow, moving or resizing yet). New
  characters must exist in the document's font or in the standard Latin fonts; other scripts are
  refused with a message. Protected (encrypted) PDFs can't be edited, and saving any change to a
  digitally signed PDF invalidates its signature (Vellum warns about this).
- Planned next: form filling, then redaction. Not planned: OCR, e-signatures, cloud sync.
