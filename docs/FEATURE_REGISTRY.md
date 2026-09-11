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
| In-app updates from GitHub releases (verified by SHA-256) | done | Services/Updater.cs, ui/updates.js |
| Colour themes (7) in Light / Obsidian dark / System, custom accent | done | themes.js, app.css |
| Settings window (Appearance, Reading, Updates, Shortcuts, About) | done | ui/settings.js |
| Command palette (Ctrl+K): all commands + recent files | done | ui/palette.js |
| Home screen: greeting, Open card, recent documents with first-page covers | done | ui/start.js, recent-covers.js, RecentFiles.cs |
| View bar (page, zoom, fit, rotate, layout) floating over the document | done | ui/viewbar.js |
| Reduce motion, reduce transparency (performance) | done | themes.js |
| Two-page (spread) layout, full-screen reading | planned | — |

## Planned — must not be faked

- Editing existing text or images inside the PDF (prototype first; clearly limited).
- Fill & sign: form filling, signatures (draw / type / upload, place, resize).
- Redaction (flatten-based; needs sign-off on rasterising).
- Password protection: add / change / remove (with the correct password).
- OCR, compare, compress, metadata editing, text/image extraction, batch processing.
- Autosave and crash recovery of unsaved edits.
- Vellum Intelligence (AI). No AI UI until there is a real, configured backend.
- Cloud, shared and starred files.
