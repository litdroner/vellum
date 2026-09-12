# Feature registry

What Vellum actually does, so nobody builds a second copy or fakes a missing one.
Status: **done** (shipped and tested), **partial**, **planned** (not started; no UI may pretend it exists).

## Reading

| Feature | Status | Where |
|---|---|---|
| Open: dialog, drag and drop, double-click / "Open with", recent files, tabs | done | app.js, ui/tabs.js, ui/dropzone.js |
| Continuous and single-page layout, remembered per file | done | document-view.js |
| Zoom: presets, fit width/page, Ctrl+wheel and pinch, animated; fitted zooms re-fit as the window or sidebar resizes | done | document-view.js |
| View rotation (not saved) | done | document-view.js |
| Page thumbnails, document outline (bookmarks) | done | ui/sidebar.js, ui/thumbnails.js |
| Search with highlighting, match case, whole words | done | ui/findbar.js |
| Password-protected PDFs (correct password only) | done | document-view.js |
| Damaged / missing / empty files explained | done | document-view.js |
| Page colours: normal, dark, sepia (display only) | done | css (page tone), themes |
| Print (with annotations) | done | print.js |

## Annotating

| Feature | Status | Where |
|---|---|---|
| Highlight, underline, sticky notes, freehand pen | done | annotations/ |
| Saved as standard PDF annotations, editable on reopen | done | annotations/persist.js |
| Encrypted PDFs: annotations kept alongside (sidecar) | done | MainWindow (annotations.*Sidecar) |
| Undo / redo (shared with page edits) | done | annotations/model.js |
| Strikethrough, shapes, stamps, text boxes, measure | planned | — |

## Editing

| Feature | Status | Where |
|---|---|---|
| Edit existing text, one line at a time: Edit tool (E), in place; Enter keeps, Esc cancels, Tab moves on | done | editing/, ui/text-editor.js |
| Written with the text's own font when it has every character; otherwise a matching standard font (said before applying) | done | editing/fonts.js, editing/edits.js |
| Only text pdf.js reads exactly the same way is offered; anything else says why (Type 3, symbol, vertical, forms, clipped, invisible, scans, soft masks, layers…) | done | editing/runs.js |
| Undo / redo shared with annotations and page edits; edits follow moved, duplicated and deleted pages | done | annotations/model.js, editing/edits.js |
| Saved into the page itself: only edited pages change; the replaced text is removed from the file | done | editing/page-writer.js, annotations/persist.js |
| Protected (encrypted) PDFs: text editing unavailable, with the reason | done | editing/session.js |
| Digitally signed PDFs: the first change is confirmed (saving invalidates the signature) | done | document-view.js, annotations/model.js, app.js |
| Tagged PDFs: says once that accessibility tags aren't updated for changed text | done | ui/text-editor.js |
| PDF/A: a change needing a substitute (non-embedded) font is refused, with the reason | done | editing/edits.js, editing/objects/text-run.js |
| Paragraph reflow, moving and resizing text, new characters outside Latin (WinAnsi) | planned | — |

## Pages

| Feature | Status | Where |
|---|---|---|
| Rotate, delete, duplicate, insert blank, drag to reorder | done | pages/, ui/thumbnails.js |
| Insert pages from another PDF (menu or drop) — i.e. merge | done | pages/actions.js |
| Extract pages to a new PDF, split into files | done | pages/actions.js |
| Deleted pages really removed on save; bookmarks kept | done | annotations/persist.js |

## App

| Feature | Status | Where |
|---|---|---|
| Custom title bar, single instance, file association, jump list | done | C# host |
| In-app updates from GitHub releases (verified by SHA-256); Vellum's only network feature, daily check can be switched off (WebView2's own traffic: WEBVIEW2_NETWORK_AUDIT.md) | done | Services/Updater.cs, ui/updates.js |
| Colour themes (7) in Light / Obsidian dark / System, custom accent | done | themes.js, app.css |
| Settings window (Appearance, Reading, Updates, Shortcuts, About) | done | ui/settings.js |
| Command palette (Ctrl+K): all commands + recent files | done | ui/palette.js |
| Home screen: greeting, Open card, recent documents with first-page covers | done | ui/start.js, recent-covers.js, RecentFiles.cs |
| View bar (page, zoom, fit, rotate, layout) floating over the document | done | ui/viewbar.js |
| Reduce motion, reduce transparency (performance) | done | themes.js |
| Two-page (spread) layout, full-screen reading | planned | — |

## Planned — must not be faked

- Editing images; reflowing whole paragraphs; moving or resizing text; writing scripts the
  document's fonts and the standard fonts don't have (e.g. Devanagari, CJK).
- Fill & sign: form filling, signatures (draw / type / upload, place, resize).
- Redaction (flatten-based; needs sign-off on rasterising).
- Password protection: add / change / remove (with the correct password).
- OCR, compare, compress, metadata editing, text/image extraction, batch processing.
- Autosave and crash recovery of unsaved edits.
- Vellum Intelligence (AI): local-first, behind the `AIProvider` abstraction (ARCHITECTURE_GUIDELINES.md).
  No AI UI until there is a real provider; no cloud provider, API keys or uploads.
- Starred files (kept on this computer).

## Out of scope while Vellum is local-first

Cloud processing, document uploads, cloud storage and shared files, online AI APIs, API keys and cloud
sign-in, telemetry, analytics, mandatory internet connections, third-party SaaS. See "Offline and
privacy" in ARCHITECTURE_GUIDELINES.md.
