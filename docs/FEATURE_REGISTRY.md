# Feature registry

What exists, what is being built, what is next, what is planned, what is research, and what must never
be built — so nobody builds a second copy or fakes a missing one. The long-term direction is
`docs/VELLUM_VISION.md`. A feature that moves to a later release changes here only — it never leaves the
Vision.

| Status | Meaning |
|---|---|
| **done** | shipped and tested |
| **done, unreleased** | implemented and tested on `main`, not yet in a release |
| **in progress** | being implemented in the approved current phase |
| **next** | approved for the current phase or the one after it, not started |
| **planned** | in the Vision, not started; no UI may pretend it exists |
| **research** | in the Vision, but needs an engine, method or owner decision before it can be planned |
| **out of scope** | excluded while Vellum is local-first; only the owner can change that |
| **do not build** | never |

## Now

- **Current release: 0.4.1** (GitHub, 2026-09-12). Text editing from 0.4.0, plus the first part of the
  0.5.0 object-editing plan: in Edit mode, select a text run or a picture; move and uniformly scale both;
  quarter-turn and mirror pictures; nudge; delete. These rows are marked done below.
- **Current phase: 0.5.0 object editing, not complete.** Plan and phase records:
  `docs/planning/VELLUM_0.5.0_AUDIT.md`. Phases 0–3 are done, same-page multi-select included; it is on
  `main` and not yet in a release (marked *done, unreleased* below). What remains for 0.5.0 is the
  first two Roadmap rows. On 2026-09-15 the owner asked for the remaining 0.5.0 work to go ahead in
  order, within the audit's scope and its "Never" list, without a separate approval for each step.

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
| Select an object in Edit mode: a text run or a picture, outlined where it is; identity only ({ page, key }) | done | editing/objects/selection.js, ui/text-editor.js |
| What may be done to an object, verb by verb, in the one reason vocabulary; a verb is true only where a writer exists | done | editing/objects/capabilities.js |
| Move and uniformly scale text and pictures: drag the object, or drag a corner handle | done | ui/text-editor.js, editing/objects/transform.js |
| Turn a picture a quarter turn ([ and ]) and mirror it in its own axes (Shift+H, Shift+V) | done | ui/text-editor.js, editing/objects/image.js |
| Nudge with the arrow keys: one point, ten with Shift; a whole burst is one undo step | done | ui/text-editor.js, annotations/model.js |
| Delete a selected run or picture (Delete / Backspace); a picture's XObject is released when provably unused | done | editing/session.js, editing/objects/image.js |
| One object, one record, holding where it ends up: a second gesture replaces the first, and one gesture is one undo | done | editing/edits.js, editing/objects/image.js |
| Refused rather than risked: a clipped or degenerate picture, one inside a form, on a layer or under a soft mask; text is never rotated, mirrored, sheared or scaled non-uniformly | done | editing/objects/capabilities.js, editing/objects/image.js, editing/edits.js |
| Several objects on one page: Shift- or Ctrl-click adds or removes one, a rectangle over bare paper selects what it wholly encloses (Shift or Ctrl adds), Ctrl+A selects the page's objects; a drag, the group's corner handles, the arrow keys, turn, mirror and Delete act on all of them as one undo step, and only when every one allows it (otherwise nothing changes, with the reason) | done, unreleased | editing/objects/selection.js, editing/objects/capabilities.js, editing/session.js, ui/text-editor.js |
| Rotating text, non-proportional picture resize, paragraph reflow, new characters outside Latin (WinAnsi) | planned | — |

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

## Roadmap — must not be faked

Everything not built yet. Order within a status is not a schedule. The Vision section names the
intended behaviour and its rules.

| Feature | Status | Vision |
|---|---|---|
| 0.5.0 must-haves left to prove: moved, scaled, turned and deleted objects (one or several) surviving page reorder, duplicate and rotate; PDF integrity after manipulation; unsupported-object messaging | next | §3.2 |
| 0.5.0 should-haves, each only if its strict tests pass (otherwise they move to a later release): paragraph grouping, alignment, distribution, snapping, image replacement, image insertion, overlap warnings, single-style paragraph reflow (last, gated) | planned | §3.2 |
| Rotating text, non-proportional picture resize, free rotation, cross-page moves, copy/paste | planned | §3.2 |
| New text boxes; rich-text formatting: font selection, size, bold, italic, underline, alignment, colour, opacity | planned | §3.2 |
| Font selection: multiple selectable document fonts (the document's own, standard, bundled), compatibility checks (glyphs, embedding permission, PDF/A), embedding when used, no silent substitution; needs a vendored font parser (e.g. fontkit), not present | planned | §4.3 |
| Bundled selectable font: Liu — one optional document-editing font available alongside other selectable fonts; a normal entry in the font selector, nothing more. Prerequisites, none present: the font file and a licence permitting bundling, use and PDF embedding, both supplied by the owner; font selection itself | planned | §4.4 |
| Writing scripts the document's fonts and the standard fonts don't have (e.g. Devanagari, CJK) | planned | §3.2 |
| Image crop; Form XObject editing; inline image replacement; vector-shape editing | planned | §3.2 |
| Shapes, lines, arrows, freehand as page content; stamps and reusable custom stamps | planned | §3.2 |
| Tag-preserving edits; PDF/A font embedding; keeping edited text on its layer | planned | §2.2, §10 |
| Annotations: strikethrough, shapes, stamps, text boxes, measure (also listed under Annotating); moving annotations and links with content | planned | §3.3 |
| Two-page (spread) layout, full-screen reading (also listed under App) | planned | §3.1 |
| Fill & sign: form filling (text fields, checkboxes, radio buttons, dropdowns), signatures (type / draw / upload, place, resize) | planned — earlier stated order: after 0.5.0, before redaction | §3.7 |
| Form detection, form creation, form flattening as an explicit user-requested output | planned | §3.7 |
| Digital (certificate) signatures, separate from signature pictures: signing with a certificate, validity display (needs a local signing/certificate engine chosen) | planned | §3.7 |
| True redaction: sensitive content really removed from the saved PDF; a covering box is not redaction; no silent page rasterising (method to be designed and approved) | research | §3.6 |
| Password protection: add / change / remove (with the correct password); permissions (print, copy, edit) | planned | §3.6 |
| Compress; metadata editing; metadata privacy cleaning; text/image extraction | planned | §3.4 |
| Crop pages, page numbers, watermarks | planned | §3.4 |
| Merge several files at once; mixed-format merge | planned / research (mixed formats need §3.5 engines) | §3.4 |
| PDF diagnostics, repair, PDF/A validation | research | §3.4 |
| PDF → JPG / PNG | planned | §3.5 |
| PDF ↔ Word / Excel / PowerPoint; PDF → PDF/A (needs a local conversion engine) | research | §3.5 |
| OCR: searchable text layer, language selection, progress, per-page failure handling, local only (needs a vendored engine and language data chosen) | planned | §3.8 |
| Compare documents | planned | §3.9 |
| Vellum Intelligence (AI): local-first, behind `AIProvider` (ARCHITECTURE_GUIDELINES.md). No AI UI until there is a real provider; no cloud provider, API keys or uploads. Summarise, ask, find, explain, translate, extract data, PDF → Markdown, Smart Split, study notes, AI difference summaries | research | §3.9 |
| Vellum Flow: reusable local workflows composing existing operations | planned | §3.10 |
| Batch processing: conversion, OCR, compression, watermarking, metadata cleaning, protection, export | planned | §3.10 |
| Autosave and crash recovery of unsaved edits | planned | §3.11 |
| Starred files (kept on this computer); task history; Batch Center; Workflow Center | planned | §3.10, §3.11 |
| Templates; extensions (need a definition and a security model) | research | §3.11 |

## Out of scope while Vellum is local-first

Cloud processing, document uploads, cloud storage, sync and shared files, online AI APIs, API keys and
cloud sign-in, telemetry, analytics, mandatory internet connections, third-party SaaS. See "Offline and
privacy" in ARCHITECTURE_GUIDELINES.md.

## Do not build

Password cracking or recovery; encryption, permission or signature bypass; HTML-overlay, rasterised or
guessed editing; whole-page reconstruction as an editing shortcut; silent font substitution; modifying
embedded font programs; a covering box presented as redaction; fake features; changes to
WebView2's security setup (SmartScreen, unsupported switches, Windows settings). See Vision §2.2 and §11.
