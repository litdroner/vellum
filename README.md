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
- **Move, scale, turn and delete objects** (in Edit mode): click a line of text or a picture to select
  it, drag it to move it, or drag a corner handle to scale it proportionally. Pictures can also be
  stretched from an edge handle, turned a quarter turn and mirrored; arrow keys nudge; Delete removes.
  Changes are written into the page itself and undo as one step per gesture. Anything Vellum can't
  change safely (a clipped picture, one inside a form or on a layer…) is refused with the reason; text
  isn't rotated or stretched.
- **Several objects at once**: Shift- or Ctrl-click to add or remove one, drag a rectangle over bare
  paper, or Ctrl+A for the page's objects; move, scale, turn, mirror, nudge and delete them together.
  Line them up or space them evenly from the bar over the selection. Dragging snaps to other objects and
  the page's edges and centre (hold Alt to turn it off), and what a move would newly cover is outlined.
- **Pictures from a file**: replace a selected picture with a PNG or JPEG in exactly its frame, or insert
  one as a new picture on a page (command palette, or the page's context menu).
- **Paragraphs**: dragging a line of a plain paragraph moves the whole paragraph; a simple one-style
  paragraph can be rewrapped to a new width from its right-edge handle, in its own lines and font.
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
| Selected object (Edit mode): nudge / nudge ×10 / delete | Arrow keys / Shift+arrow keys / Del |
| Edit mode: add to selection / select the page's objects / drag without snapping | Shift or Ctrl+click / Ctrl+A / hold Alt |
| Selected picture: turn left / right, mirror horizontally / vertically | [ / ], Shift+H / Shift+V |
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
tests/e2e/                 the app end to end over DevTools (node tests/e2e/run.mjs)
docs/                      vision, design system, architecture guidelines, feature registry, planning
```

User data lives in `%LOCALAPPDATA%\Vellum` (settings, recent files, protected-PDF annotations,
WebView2 profile) and is kept on uninstall.

## Known limitations
- Snap Layouts flyout on the maximize button isn't available (Win+Z and edge snapping work).
- Annotations on encrypted PDFs are kept by Vellum, not inside the file (see above), and their pages
  can't be rearranged.
- Page colours are a display setting only: printing and saved files are unchanged.
- Text editing changes one line at a time: no new text boxes or formatting (font, size, bold, colour)
  yet, and paragraph reflow only handles simple one-style paragraphs within their existing lines. Text
  can't be rotated or stretched, pictures can't be cropped, objects can't be moved to another page or
  copied, and several objects can be selected only on one page. New characters must exist in the
  document's font or in the standard Latin fonts; other scripts are refused with a message. Protected
  (encrypted) PDFs can't be edited, and saving any change to a digitally signed PDF invalidates its
  signature (Vellum warns about this).

## Where it's going

Everything below is **planned, not built** — none of it is in the app yet. The full direction is in
[docs/VELLUM_VISION.md](docs/VELLUM_VISION.md) and the status of each item in
[docs/FEATURE_REGISTRY.md](docs/FEATURE_REGISTRY.md).

- **Edit**: new text and formatting with a choice of fonts, rotating text, image crop, copy/paste and
  moves between pages, shapes, stamps.
- **Organise and convert**: page numbers, watermarks, metadata, compression; PDF to images and Office
  formats and back.
- **Protect and sign**: passwords and permissions, true redaction (content removed, not covered), form
  filling, signature pictures, and digital (certificate) signatures.
- **OCR** for scanned documents, run locally.
- **Automate and understand**: batch processing and workflows; optional AI that can run locally.

All of it runs on your computer. Not planned: cloud sync, cloud processing, uploads, telemetry.
