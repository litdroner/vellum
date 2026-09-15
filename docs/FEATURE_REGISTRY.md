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

- **Current release: 0.5.0** (tag `v0.5.0`, 2026-09-15). Object editing: text editing from 0.4, and in
  Edit mode selecting, moving, scaling, turning, mirroring, stretching, nudging and deleting text and
  pictures, one or several; alignment, distribution, snapping, picture replacement and insertion,
  paragraph grouping, overlap warnings and single-style paragraph reflow
  (record: `docs/planning/VELLUM_0.5.0_AUDIT.md`). Rows still marked *done, unreleased* below from before
  that release shipped in it.
- **Current cycle: 0.6.** One feature at a time, on the owner's instruction (2026-09-15). Done on `main`,
  not released: copy, paste and duplicate objects; cross-page and cross-document moves and paste; retyping,
  reflowing and replacing pasted copies; rotating text and free rotation; new text in a standard PDF font
  (Editing). No version bump, push or release until the owner asks.

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
| Stretch a picture (non-proportional resize): drag an edge handle, along the picture's own width or height, from the opposite edge; never text, and one picture at a time | done, unreleased | editing/objects/transform.js (stretch), editing/objects/capabilities.js, ui/text-editor.js |
| Turn a picture a quarter turn ([ and ]) and mirror it in its own axes (Shift+H, Shift+V); since 0.6 text turns too (next rows) and freely from the rotate handle | done | ui/text-editor.js, editing/objects/image.js |
| Nudge with the arrow keys: one point, ten with Shift; a whole burst is one undo step | done | ui/text-editor.js, annotations/model.js |
| Delete a selected run or picture (Delete / Backspace); a picture's XObject is released when provably unused | done | editing/session.js, editing/objects/image.js |
| One object, one record, holding where it ends up: a second gesture replaces the first, and one gesture is one undo | done | editing/edits.js, editing/objects/image.js |
| Refused rather than risked: a clipped or degenerate picture, one inside a form, on a layer or under a soft mask; text is never mirrored, sheared or scaled non-uniformly (turning it is allowed since 0.6) | done | editing/objects/capabilities.js, editing/objects/image.js, editing/edits.js |
| Moved, scaled, turned and deleted objects — one or several — follow their pages through reorder, duplicate, rotate and delete, and through save and reopen; everything else in the file is kept (page boxes, annotations, links, form fields, outline, metadata, and images other pages still draw) | done | editing/edits.js (followEdits), annotations/persist.js; proved in tests/editing/object-pages.test.mjs and the page-changes suite |
| Line up and space evenly several selected objects (should-haves "alignment" and "distribution"): align left/right/top/bottom edges or centres, space evenly across or down, from an arrange bar over the selection or the command palette; edges as shown on screen whatever the rotation; one undo step, only when every object can be moved | done, unreleased | editing/objects/arrange.js, ui/text-editor.js, commands.js |
| Snapping while dragging (should-have): a dragged object or group snaps its edges or centre to another object's edges and centres, or the page's edges and centre, within 5 screen pixels, as the page is shown whatever the rotation; a thin guide line marks each line it is on while the hand is down; Alt held turns it off. Only the move changes (still a move, one record per object, one undo step) | done, unreleased | editing/objects/snap.js, ui/text-editor.js (#snappedMove) |
| Replace a picture (should-have "image replacement"): with one picture selected, "Replace picture…" on the bar over it or in the command palette opens a Windows file dialog; a PNG or JPEG takes the picture's place in exactly its frame (position, size, turn, mirror, shear, clip, drawing order), as the same object and one undo step. The image is embedded as a real XObject (a JPEG as it is, a PNG with its transparency as a soft mask); the old image resource is released only when nothing else on the page uses it. Refused with the reason: inline images, pictures that can't be moved, files that aren't a readable PNG or JPEG (or over 25 MB), PDF/A documents; tagged PDFs are told once that tags aren't updated | done, unreleased | editing/objects/image.js (readPicture, prepare, write), editing/session.js (replaceImage), ui/text-editor.js, MainWindow.xaml.cs (pictureDialog) |
| Insert a picture (should-have "image insertion"): in Edit mode, "Insert picture…" in the command palette or the page's context menu opens a Windows file dialog; a PNG or JPEG goes on that page as a new picture, centred and upright as the page is shown, at its natural size (96 pixels to the inch) but at most half the page, and is selected. It is an object like any picture: moved, resized, stretched, turned, mirrored, snapped, arranged, replaced and deleted, one undo step each, on blank and duplicated pages too, through save and reopen. Drawn after the page's own content under a new /XObject name, embedded once however many pages draw it; nothing already on the page changes. Refused with the reason: files that aren't a readable PNG or JPEG (or over 25 MB), pages whose content can't be rewritten, PDF/A documents; tagged PDFs are told once that the picture isn't added to the tags | done, unreleased | editing/objects/inserted-image.js, editing/objects/page-objects.js (insertedObject), editing/session.js (insertImage), ui/text-editor.js (insertPicture), app.js (context menu), MainWindow.xaml.cs (pictureDialog) |
| Paragraph grouping (should-have): in Edit mode, dragging a line that plainly belongs to a paragraph selects and moves the whole paragraph (then handles, keys, arrange and Delete act on it as on any selection, one undo step); a click still edits that one line, and a line selected on its own drags alone. Grouped only when every line can be moved, has the same font, size, colour, render mode and direction, starts at the same left edge at a spacing of 0.9–1.6 × the text size that doesn't drift, shares its row with no other text, doesn't start like a list item, and has nothing drawn between it and the next; an indented line leaves the lines around it ungrouped. Nothing new is written: each line is its own record, as before | done, unreleased | editing/objects/text-block.js, ui/text-editor.js (#paragraphOf) |
| Overlap warnings (should-have): while a drag or an arrow-key burst is moving objects, what they would newly cover (text or pictures, not what they already overlapped) is outlined in amber; the outline goes when the hand does, nothing is refused, and a drop that leaves an overlap is announced to screen readers | done, unreleased | editing/objects/overlap.js, ui/text-editor.js (#overlapsOf) |
| Several objects on one page: Shift- or Ctrl-click adds or removes one, a rectangle over bare paper selects what it wholly encloses (Shift or Ctrl adds), Ctrl+A selects the page's objects; a drag, the group's corner handles, the arrow keys, turn, mirror and Delete act on all of them as one undo step, and only when every one allows it (otherwise nothing changes, with the reason) | done, unreleased | editing/objects/selection.js, editing/objects/capabilities.js, editing/session.js, ui/text-editor.js |
| Single-style paragraph reflow (should-have, the narrow case): a whole paragraph selected in Edit mode that passes the reflow gate has one handle on its right edge; dragging it rewraps the paragraph's words, in order, into its own lines at that width — same baselines, left edge, font, size and colour, lines no longer needed emptied — one undo step, re-encoded only in the paragraph's own font (never a substitute). The handle is offered only when every line can be edited, is one style and one placement, on one left edge and even spacing, set left to right with the font's own widths (no kerning, tracking, justification or pen-move spaces) and with no hyphenated break. Refused with the reason when the hand lets go: a width narrower than a word, or one needing more lines than the paragraph has | done, unreleased | editing/objects/reflow.js, editing/session.js (reflowParagraph), ui/text-editor.js (#reflowable, #reflow) |
| Copy, paste and duplicate objects (0.6): in Edit mode, Ctrl+C copies the selected text and pictures as they are now (retyped, moved, replaced); Ctrl+V pastes them on the page in view, 10 pt right and down from where they were copied (a step further with each paste), selected, as one undo step; Ctrl+D duplicates the selection the same way; also in the command palette. A pasted copy is a new record (`text-copy`, `image-copy`) drawn after the page from the page's own glyphs, font, size, colour, ExtGStates and image resource, fingerprinted against the original content at every save, or another inserted picture for a picture from a file; copies move, scale, turn, delete, arrange and copy again, follow duplicated, reordered and rotated pages, and are ordinary content once saved. Refused with nothing stored: inline images; PDF/A for substitute fonts and new pictures. (Retyping, reflowing and replacing a pasted copy, and paste onto other pages and documents: the next rows.) | done, unreleased | editing/objects/copies.js, editing/session.js, ui/text-editor.js, commands.js; tests/editing/copy-paste.test.mjs, tests/e2e/suites/copy-paste.mjs |
| Cross-page moves and paste (0.6): selected text and pictures, one or several, pasted onto any page — or into another open document — land where they were on their page (or in the middle of a page they would miss altogether); Ctrl+X cuts (one undo step) so Ctrl+V on another page moves them; a move drag let go over another page puts them under the pointer there, as ONE undo step (session.moveObjectsToPage). A copy on another page keeps `from: { src, index }`, the page whose ORIGINAL content it draws; at every save the page writer reads that page before any page is rewritten (still in the plan, the opened file's own page, or a page of a PDF in the document's sources), checks the fingerprint, and adds the font, image XObject, ExtGStates and a named colour space or pattern to the destination page under fresh `VlCp…` names — the same objects, never re-encoded or rasterized. Survives save and reopen, undo/redo, and the origin page deleted, reordered or rotated and the destination duplicated. From another document, that document's PDF is kept once in this one's sources (as for inserted pages), with its already-verified page analysis. Refused with nothing stored or saved: a PDF/A destination for content from another document; an origin page missing, unreadable or changed; a resource the origin doesn't have; everything copy/paste already refuses | done, unreleased | editing/objects/copies.js (from, importer), editing/page-writer.js (readOrigins), editing/session.js (#pasted, moveObjectsToPage, #origin), ui/text-editor.js (cutSelected, #moveToPage), commands.js (edit.cutObjects); tests/editing/cross-page.test.mjs, tests/e2e/suites/copy-paste.mjs ("another page") |
| Editing pasted copies before saving (0.6): a pasted copy of text is retyped like its original — click it (or Enter with it selected) and type; the editor checks the text live — in the copied run's own font where it has every character, else a standard font of the same style, else refused with the reason; typed back to the original text it draws the file's own glyphs again, and emptied it goes, as deleting it does. A paragraph pasted together (lines pasted from one page; copies group into paragraphs only with other copies) is reflowed from its right-edge handle on the terms of any paragraph (objects/reflow.js), measured in the analysis of the page the lines were copied from. A pasted copy of a picture is replaced with a PNG or JPEG (Replace picture…) in its frame. Each is ONE undo step that changes the copy's one record — `text` and `encoding`, or `replacement` — keeping its id, fingerprint, `from` and placement, so the copy writer and the page writer draw it as before, on the same page, another page or from another document, through save and reopen; nothing is rasterized and no font is guessed. Refused with nothing stored: text neither the font nor a standard font can write, a substitute font in a PDF/A document, a new picture in a PDF/A document, pasted lines reflowed together with the page's own lines or with lines from another page, and everything reflow already refuses | done, unreleased | editing/session.js (#retypeCopy, #previewCopy, reflowParagraph, replaceImage), editing/objects/copies.js (copiedObject), ui/text-editor.js (copyItemOf, #paragraphOf, #reflowable); tests/editing/copy-edits.test.mjs, tests/e2e/suites/copy-paste.mjs |
| Rotating text and free rotation (0.6): selected text — one run, a paragraph, a pasted copy, or several objects with pictures among them — turns a quarter turn with [ and ] (each object about its own centre) or from the palette ("Turn objects left 90°" / "Turn objects right 90°"), and freely from the rotate handle standing off the selection's top edge (the whole selection about its centre; Shift keeps to 15° steps). Written as the move/scale transform already was — one absolute record per object, ONE undo step per gesture — and drawn by the existing text writer from the file's own glyphs under one `cm`: font, size, colour, colour space, ExtGStates/opacity and glyph codes untouched, nothing rasterized; saved and reopened it is ordinary editable text, turned. A stored text transform is always an exact similarity [p q −q p] (textPlacement), so repeated turns never add a skew. Turned text keeps its turn when retyped, moved, scaled, copied, pasted or cut to another page. Refused, with nothing stored: mirroring or stretching text (Shift+H/V stay pictures-only and are asked as a stretch), skews, and reflowing a turned paragraph (its width can't be measured along the page) | done, unreleased | editing/edits.js (textTransformRefusal, textPlacement), editing/objects/transform.js (similarityOf, rotateAbout), editing/objects/capabilities.js, editing/objects/copies.js (planCopy), ui/text-editor.js (#rotateHandle, rotateTo, turnSelected), commands.js; tests/editing/text-rotation.test.mjs, tests/e2e/suites/manipulation.mjs ("text turns") |
| New text (0.6, the first part of "new text boxes"): in Edit mode, "Add text" in the command palette or the page's context menu puts one line of text on that page — centred and upright as the page is shown, Helvetica 12 pt, black — selected, with the editor open on it and its words selected, so typing replaces them; Enter keeps it. It is then retyped (checked live), moved, scaled, turned, snapped, arranged, copied, pasted (also onto other pages and documents), cut and deleted like any text, one undo step each; emptied it goes. A record of its own (`inserted-text`: text, font, size, box, transform — a similarity), drawn after the page's content as real text (`BT … Tj ET`) in a standard PDF font under a new /Font name, encoded in that font's standard encoding; nothing on the page is touched, nothing rasterized; saved and reopened it is ordinary editable page text. Refused with the reason, nothing stored: characters the standard font doesn't have (never drawn in another font), PDF/A documents (the standard fonts aren't embedded), pages whose content can't be rewritten, mirrors and skews; a line of new text is never grouped into a paragraph or reflowed. Tagged PDFs are told once that new text isn't added to the tags. Not yet: several lines or wrapping in one box, choosing its font, size, style, colour, opacity or alignment (next row in the Roadmap) | done, unreleased | editing/objects/inserted-text.js, editing/objects/page-objects.js (insertedTextObject), editing/objects/registry.js, editing/objects/copies.js (snapshotOf), editing/session.js (insertText, #retypeNewText, #previewNewText), ui/text-editor.js (addText), commands.js (edit.addText), app.js (context menu); tests/editing/new-text.test.mjs, tests/e2e/suites/manipulation.mjs ("new text") |
| General paragraph reflow (more lines than a paragraph has, mixed styles, kerned or justified text, hyphenation, turned paragraphs), new characters outside Latin (WinAnsi) | planned | — |

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
| New text boxes, the rest (one line of new text is done, see Editing): several lines and wrapping in one box; formatting of new text — size, bold and italic (the standard font families' own styles), underline, alignment, text colour, opacity. Choosing fonts beyond the standard PDF fonts, and embedding them, is font selection (the next row) and needs its vendored font parser | next | §3.2 |
| Font selection: multiple selectable document fonts (the document's own, standard, bundled), compatibility checks (glyphs, embedding permission, PDF/A), embedding when used, no silent substitution; needs a vendored font parser (e.g. fontkit), not present | planned | §4.3 |
| Bundled selectable font: Liu — one optional document-editing font available alongside other selectable fonts; a normal entry in the font selector, nothing more. Prerequisites, none present: the font file and a licence permitting bundling, use and PDF embedding, both supplied by the owner; font selection itself | planned | §4.4 |
| Writing scripts the document's fonts and the standard fonts don't have (e.g. Devanagari, CJK) | planned | §3.2 |
| Image crop; Form XObject editing; inline image replacement; replacing a picture in a PDF/A document (needs a check of the image against the file's output intent); vector-shape editing | planned | §3.2 |
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
