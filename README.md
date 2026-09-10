# Vellum

A calm, fast PDF reader for Windows. WPF shell, WebView2 surface, pdf.js rendering.

Developed by **Pankaj Manhas** · Homelabs. Made in India.

## Install

Run `dist\Vellum-Setup.exe` (built by `tools\publish.ps1`). It installs for your user only (no admin
prompt) into `%LOCALAPPDATA%\Programs\Vellum`, adds a Start-menu entry and, if you tick the option,
registers Vellum as a PDF app. Windows then asks you to confirm the default once in
**Settings → Apps → Default apps → Vellum** (no app can make itself the default silently).
Needs the Microsoft Edge WebView2 Runtime, which Windows 10/11 normally already has.

## What it does

- Open by double-click, drag-and-drop, Ctrl+O, recent files (reopens where you left off); tabs.
- Continuous or single-page view; zoom (fit width, fit page, %, Ctrl+scroll); rotation.
- Page thumbnails and the PDF's own outline; search with highlighting; text selection and copy.
- Highlight, underline, sticky notes, freehand drawing — saved into the PDF as standard annotations
  (other readers show them too) and reopened as editable. Undo/redo.
- Print, dark/light theme, password-protected and damaged files handled with clear messages.

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
| Rotate | Ctrl+Shift+= / Ctrl+Shift+- |
| Sidebar | F4 |
| Tools: select, highlight, underline, note, draw | V, H, U, N, D (H/U mark selected text directly) |
| Delete annotation / undo / redo | Del / Ctrl+Z / Ctrl+Y |
| Print | Ctrl+P |
| Theme | Ctrl+Shift+L |

## Build from source

Requires the .NET 10 SDK and Node (only for dev tools).

```powershell
tools\run.ps1 -Files some.pdf        # build (Debug) and run
tools\run.ps1 -Debug                 # also exposes DevTools on port 9222
node tools\cdp.mjs eval "document.title"   # poke the running app
tools\publish.ps1                    # self-contained Release build + installer (Inno Setup 6)
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
    js/ui/                 title bar, tabs, toolbar, sidebar, find bar, menus, dialogs, start screen
    css/app.css            the visual system (tokens, raised/pocket materials)
    vendor/                pdf.js 6.3, pdf-lib 1.17, Jost font — all local, nothing loaded from the network
installer/Vellum.iss       Inno Setup script
tools/                     run, publish, icon, DevTools helpers
```

User data lives in `%LOCALAPPDATA%\Vellum` (settings, recent files, protected-PDF annotations,
WebView2 profile) and is kept on uninstall.

## Known limitations (v1)
- Snap Layouts flyout on the maximize button isn't available (Win+Z and edge snapping work).
- Annotations on encrypted PDFs are kept by Vellum, not inside the file (see above).
- Out of scope for v1: OCR, form filling, e-signatures, cloud sync.
