# Vellum vision

The long-term product constitution for Vellum: what it is meant to become, and the decisions that do not
change with the release schedule. Chat context is lost between sessions; this file is not. When a
requirement matters beyond the current conversation, it is written here.

First written 2026-09-15, from an audit of every document in the repository and the product direction
the owner (Pankaj Manhas) gave on that date; reconciled the same day with the owner's decisions (§14).
Before this, no vision document existed: the direction was spread across the registry's "Planned" list,
the 0.5.0 planning document, the design system and chat.

## 0. How to use this document

### Four different questions

| Question | Answered by | Changes when |
|---|---|---|
| What is Vellum ultimately meant to become? | **this document** | the product direction changes (rare, owner's decision, logged in §14) |
| What is implemented today (current release)? | `docs/FEATURE_REGISTRY.md` | a feature ships |
| What are we implementing right now (current phase)? | `docs/FEATURE_REGISTRY.md` ("Now") and the phase's planning document in `docs/planning/` | a phase starts or ends |
| What comes later, in what order? | `docs/FEATURE_REGISTRY.md` ("Roadmap") | priorities change |

**Deferred is not removed.** Moving a feature from 0.5 to 0.6, 0.9 or 1.0 is a registry change. It
never deletes or weakens anything here. A capability leaves this document only by an explicit owner
decision, recorded in the decision log (§14) with its reason.

**Nothing here is a claim that it exists.** This document describes intent. Only features marked
*done* in the registry exist, and only real functionality gets UI (§2.3).

### Documentation hierarchy

```
CLAUDE.md                            short mandatory engineering rules; read first every session
  ↓
docs/VELLUM_VISION.md                long-term product direction and durable decisions (this file)
  ↓
docs/DESIGN_SYSTEM.md                visual implementation authority: themes, materials, tokens, components, motion
docs/ARCHITECTURE_GUIDELINES.md      engineering constraints: layers, boundaries, offline and privacy, testing
docs/FEATURE_REGISTRY.md             what exists, is being built, is next, planned, research, never to be built
docs/VELLUM_VISUAL_REFERENCES.md     the visual assets and references: in the repository, and external ones
docs/planning/*                      detailed implementation and audit plans, phase records
docs/WEBVIEW2_NETWORK_AUDIT.md       measured runtime network behaviour of Vellum and WebView2
```

Each document is the authority inside its own role (the design system on visuals, the architecture
guidelines on engineering, the registry on status, planning documents on phase detail). This file points
to them and does not copy them. A disagreement between documents is fixed, not left; one that touches a
decision here goes to the owner (§13).

## 1. What Vellum is

A premium, local-first PDF workspace for Windows: a calm, fast reader that grows into a full editor,
organiser, converter, protection and signing tool, automation runner and (optionally) an assistant that
helps understand documents — every document feature running on the user's own computer.

- Shipped Windows desktop app: WPF (.NET 10) hosting WebView2; UI in plain ES modules, no build step;
  pdf.js reads and renders, pdf-lib writes. GitHub: `litdroner/vellum`.
- Developed by **Pankaj Manhas, Homelabs**. Made in India. That credit stays in About and in the exe and
  installer metadata.
- Vellum is deliberately engineered, not merely feature-heavy. A smaller set of features that are
  correct beats a larger set that damages PDFs or pretends.

## 2. Principles that don't change with the schedule

### 2.1 Local-first and private

- Vellum processes documents locally and does not upload document data.
- Every PDF feature — today's and every future one in this document — runs locally and works with the
  network off.
- Vellum's own network code is limited to the GitHub updater.
- The Microsoft WebView2 runtime makes its own Microsoft connections (SmartScreen, configuration,
  component updates and others). It stays as it is: SmartScreen on, no unsupported switches, no Windows
  settings changed. WebView2 is never modified for the convenience of a feature.
- Never claim zero network traffic from the running application, that GitHub is the only traffic of the
  whole runtime, or that WebView2 is offline. Evidence: `docs/WEBVIEW2_NETWORK_AUDIT.md`. User-facing
  wording: "Offline and privacy" in `docs/ARCHITECTURE_GUIDELINES.md`.
- No cloud or document-upload architecture unless the owner explicitly approves it later: no cloud
  processing, document uploads, cloud document storage, sync, telemetry, analytics, online AI APIs, API
  keys, cloud sign-in, mandatory internet, third-party SaaS.
- A future feature that genuinely needs the internet is opt-in, behind a setting the user controls, says
  plainly what leaves the device, never carries PDF processing, and leaves everything else working.

### 2.2 PDF integrity

Vellum manipulates **real PDFs**: changes are written into the file's own structures (content streams,
resources, annotations, form fields, metadata), and a saved file opens correctly in other readers.

**Editing never guesses.** Content is offered for change only when Vellum's reading of it is verified
(for text: glyph for glyph against pdf.js); anything else is refused with a reason. See
`ARCHITECTURE_GUIDELINES.md`.

Never:

- HTML-overlay "editing" that only looks like a change
- rasterising a page (or the whole PDF) in order to edit it
- whole-page reconstruction as an editing shortcut
- guessed glyph mappings
- silent font substitution (a substitute font is said before it is applied, and refused where it is
  prohibited, e.g. a non-embedded substitute in PDF/A)
- modifying embedded font programs
- encryption, password, permission or signature bypass; password cracking
- flattening forms in order to edit them
- claiming support for a PDF structure Vellum doesn't handle

Always:

- change only what the user changed; untouched pages, objects and structures stay as they were
- verify an edit against the original content when the document is written; refuse the save rather than
  write something uncertain
- identify unsupported PDF structures honestly, with a reason the user can understand
- warn before a change with a real consequence (a signature invalidated, tags not updated)

Detail: the "Never" list in `docs/planning/VELLUM_0.5.0_AUDIT.md`.

### 2.3 Honest functionality

- No fake features: AI, cloud, OCR, signatures, conversions, redaction or anything else get UI only when
  they really work.
- No unsupported claims: Vellum never says a PDF, structure or result is supported, preserved, secure or
  exact unless it is.
- A capability that can't be done safely on a given document says why instead of half-doing it.
- An unsupported state is designed (a clear message, the reason, what the user can do), not an error.

### 2.4 Engineering philosophy

**Easy to add. Easy to remove. Hard to break.**

Priorities, in this order when they conflict: correctness and PDF integrity → security → graceful
failure and clear unsupported states → offline operation → performance → accessibility →
maintainability, modularity and testability → feature count.

### 2.5 The PDF is the focus

The document is the content and stays visually dominant; the UI is a light frame around it (see §9 and
the performance rules in `DESIGN_SYSTEM.md`).

## 3. Product scope

### 3.0 Pillars

Vellum's long-term direction is eight pillars. The subsections below give the intended capabilities of
each; status and order live in the registry.

| Pillar | Covers | Section |
|---|---|---|
| **READ** | reading, navigation, search, page appearance, print | §3.1 |
| **EDIT** | text, formatting, fonts, images, objects, graphics, stamps, annotations | §3.2, §3.3 |
| **ORGANIZE** | pages, merge and split, crop, page numbers, watermarks, metadata, compression, extraction, diagnostics, repair, PDF/A validation | §3.4 |
| **CONVERT** | images, Office formats, PDF/A output, Markdown | §3.5 |
| **PROTECT** | passwords, permissions, true redaction | §3.6 |
| **SIGN** | forms, Fill & Sign, signature pictures, digital certificate signatures | §3.7 |
| **AUTOMATE** | Vellum Flow, batch processing, Batch Center, Workflow Center, task history | §3.10 |
| **UNDERSTAND** | OCR, compare, Vellum Intelligence (AI through `AIProvider`) | §3.8, §3.9 |

The workspace (§3.11) is the home all eight pillars live in.

### 3.1 Read

- PDF reader with tabs, recent documents and reopening where the user left off
- zoom (presets, fit width/page, Ctrl+wheel, pinch), view rotation
- page layouts: continuous, single page, two-page spread, full-screen reading
- thumbnails, document outline (bookmarks)
- search with highlighting, match case, whole words
- large-document performance: hundreds of pages stay responsive (budgets in the planning documents)
- page appearance: normal, dark and sepia page colours, display only — the file is never changed by it
- print, with annotations
- password-protected PDFs opened with the correct password; damaged, missing and empty files explained

### 3.2 Edit

Editing real PDF content in place, under §2.2.

**Text**

- edit existing text; add new text (new text boxes)
- advanced text editing: move, resize, rotate text; paragraph and block editing; paragraph reflow where
  it is safe (single-style first, gated on its tests)
- text formatting: font selection from multiple selectable fonts (§4.3; the bundled selectable font Liu
  is one of them, §4.4), font size, bold, italic,
  underline, alignment, text colour, opacity
- scripts beyond Latin where a font really has the glyphs (e.g. Devanagari, CJK)

**Images**

- insert, replace, move, resize (proportional and free), crop, rotate, flip, delete
- replacement uses real PDF image resources, preserves transparency (soft masks) where possible and
  preserves z-order
- never rasterise a page or the PDF to edit an image

**Objects and graphics**

- selection with handles, keyboard nudging, multi-select, alignment, distribution, snapping, overlap
  warnings
- shapes, lines, arrows, freehand drawing as page content
- stamps, including reusable custom stamps kept on this computer
- copy and paste, cross-page moves, free rotation

### 3.3 Annotate

- highlight, underline, strikethrough, sticky notes, pen / freehand
- future expansion: shapes, stamps, text boxes (callouts), measurement, and moving annotations and links
  together with the content they belong to
- saved as standard PDF annotations that other readers show and Vellum reopens as editable
- encrypted PDFs that can't be rewritten keep annotations alongside the file, never by bypassing protection

### 3.4 Organize

- reorder, rotate, delete, duplicate, insert blank pages, insert pages from another file
- extract pages, split a PDF
- merge PDFs; multi-file merge; mixed-format merge (images and office documents combined into one PDF,
  depends on §3.5 conversions)
- crop pages
- page numbers, watermarks
- metadata editing; metadata privacy cleaning (remove author, software, XMP history and similar)
- compression
- extraction of text and images
- PDF diagnostics (what's inside a file, what's wrong with it), repair of damaged files
- PDF/A validation

### 3.5 Convert

All conversion runs locally, with vendored engines; nothing is sent anywhere.

- PDF → JPG, PDF → PNG
- PDF → Word, PDF → Excel, PDF → PowerPoint
- Word → PDF, Excel → PDF, PowerPoint → PDF
- PDF → PDF/A
- PDF → Markdown (see also §3.9)

A conversion that can't be faithful says what was lost; it doesn't pretend to be exact.

### 3.6 Protect

- open password-protected PDFs with the correct password
- create, change and remove a password (removal only with the correct password)
- permissions: printing, copying and editing restrictions
- true redaction (below)

**Never**: password cracking, password recovery, encryption bypass, permission bypass.

#### Editing, covering, redaction and flattening are four different things

| Operation | What it does to the file | What it must never be mistaken for |
|---|---|---|
| **Ordinary editing** (§3.2) | changes, moves or deletes specific verified content; everything else untouched | redaction: deleted text may still exist elsewhere (other pages, metadata, bookmarks, form values) |
| **Visual covering / annotation** (a box, highlight or shape over content) | adds something drawn on top; the content underneath is still in the file, selectable and extractable | redaction — a black rectangle is **not** redaction and is never labelled as one |
| **True redaction** | the sensitive content is removed from the resulting PDF: text, image data and vector content in the marked area, and the same information where it is repeated (metadata, bookmarks, annotations, form values, hidden layers); then marked so the removal is visible | a covering: the result is verified by re-reading the saved file, and the area yields nothing |
| **User-requested output flattening** (forms, annotations, layers into page content) | an explicit output operation the user chooses, producing a new file or a clearly announced change | an editing shortcut: Vellum never flattens or rasterises in order to make something editable or redactable |

Redaction rules:

- **Status: research and architecture work.** Nothing is built until the method is designed and approved.
- It builds on the verified object model and page writer; content is removed, not hidden.
- Whole pages are never silently rasterised as a shortcut, and the "never rasterise merely to edit"
  principle (§2.2) is not weakened for it. If some content can't be removed safely, Vellum says so and
  doesn't claim the page is redacted.
- A redaction that can't be completed is reported as incomplete, never as done.

### 3.7 Sign

- Fill & Sign: fill text fields, checkboxes, radio buttons, dropdowns
- form detection, form creation
- form flattening, only as an explicit output operation the user requests (§3.6 table)
- signature pictures: typed, drawn and imported signature images; placement and resizing
- **digital (certificate) signatures, a separate capability**: signing with a certificate, and showing
  whether existing signatures are valid
- **a signature picture is not a cryptographic signature**: the UI and wording never blur the two
- signed PDFs: changes that invalidate a signature are confirmed first; signatures are never bypassed or
  forged

### 3.8 OCR

- OCR scanned PDFs, adding a searchable (invisible) text layer under the page image
- OCR language selection, with language data bundled or installed locally
- visible progress, cancellable
- local processing only
- failure handled per page with a clear reason; a partial result is labelled as partial

### 3.9 Understand: compare and Vellum Intelligence

**Compare** documents and show their differences (not AI; works without it).

**Vellum Intelligence** is optional AI, never required for anything else:

- summarise a PDF; ask questions about it; find information
- explain selected text; translate a document or selection
- extract structured data and export it
- PDF → Markdown
- Smart Split (split by detected document boundaries)
- study notes
- AI-assisted difference summaries on top of Compare

Rules:

- basic PDF functionality never depends on AI
- provider-based architecture: `AIProvider` → `LocalAIProvider` (models on the user's hardware) and
  `CloudAIProvider` (interface only; not implemented, no API keys, no cloud sign-in). See "Vellum
  Intelligence (future)" in `ARCHITECTURE_GUIDELINES.md`
- local AI must be possible; any cloud provider is a separate future opt-in decision under §2.1
- no AI UI until a real provider exists; with no provider, AI entry points simply don't appear

### 3.10 Automate: Vellum Flow and batch processing

A local workflow system that composes Vellum's own operations into reusable pipelines. Examples:

```
PDF    → OCR → remove metadata → compress → watermark → protect → save
Folder → convert → OCR → rename → export
```

- reusable, saved workflows (Workflow Center)
- batch processing (Batch Center): conversion, OCR, compression, watermarking, metadata cleaning,
  protection, export
- task history of what ran, on which files, with what result
- each step is an existing command/operation, not a second implementation
- runs locally, shows progress, reports per-file results, never overwrites originals without the user
  choosing to

### 3.11 Workspace

- a premium document workspace (home, tabs, multi-document work)
- recent documents, starred documents (kept on this computer)
- templates
- extensions
- task history, Batch Center, Workflow Center (§3.10)
- Vellum Intelligence (§3.9)
- multi-document workflows
- autosave and crash recovery of unsaved edits
- future workspace functionality follows the same rules: local, honest, in the existing design system

Cloud, sync and shared storage are out of scope while Vellum is local-first, unless the owner explicitly
approves otherwise (§2.1).

## 4. Fonts and typography

Two separate worlds: the fonts Vellum's **interface** is drawn in (§4.1, set by the design system) and
the fonts a user can put **into a document** (§4.2–4.4). Nothing in the second changes the first.

### 4.1 UI typography (exists; unchanged by anything below)

Segoe UI Variable for the interface; Jost (vendored, `web/fonts`, OFL) for display text and the VELLUM
wordmark. Details in `DESIGN_SYSTEM.md`, which remains the authority. Document fonts, including every
bundled selectable font, are never used for the UI, the wordmark or branding.

### 4.2 Fonts for PDF text editing today (exist)

The document's own font when it has every character; otherwise a matching standard font, said before
applying; refused in PDF/A where the substitute wouldn't be embedded. Standard font data is pdf.js's
vendored set (`web/vendor/pdfjs/standard_fonts`).

### 4.3 Font selection (planned)

A document-font system for new and edited text, built once and shared by editing, new text boxes, form
filling, stamps and signatures:

- **multiple selectable fonts**: the document's own fonts, the standard PDF fonts, and fonts bundled with
  Vellum; each shown the same way in one font selector
- **compatibility checking** before a font is offered or applied: glyph coverage for the text being
  written, embedding permission in the font's licence flags, and document constraints (PDF/A, tagged,
  signed)
- **embedding and portability**: a font that isn't already in the document is embedded (subset) when
  used, where applicable, so the file renders the same everywhere
- **no silent substitution**: where a substitute is allowed it is said before it is applied; where the
  editing architecture prohibits it (e.g. a non-embedded substitute in PDF/A) the change is refused with
  a reason
- missing characters in the chosen font are refused with a reason, never drawn in another font
- all fonts are local and vendored; nothing is downloaded at runtime
- infrastructure prerequisite for embedding any bundled font: a font parser for pdf-lib's custom-font
  embedding, vendored locally like the other libraries — `@pdf-lib/fontkit` (`web/vendor/fontkit`),
  added with font selection for bundled fonts

### 4.4 Bundled selectable font: Liu (requirement)

Liu is one optional document-editing font available alongside other selectable fonts. It is a
deliberate, long-term requirement of the owner (§14), not a placeholder, and it stays in this document
even while its asset is unavailable. The display name is exactly **Liu**; no other spelling or variant
is used anywhere.

What it is: one entry among the selectable document fonts of §4.3, and nothing more.

What it is not: the default font, the UI font, a branding or display font, Vellum's application-wide
typography, part of the design system's typefaces, a replacement for Jost, or a special system font.

The experience, when font selection exists: a user opens the font selector, sees **Liu** among the
available fonts, and can select it like any other. Specifically:

- a normal selectable option, listed and previewed like every other font, following all of §4.3
  (compatibility checks, embedding when used where applicable, no silent substitution)
- no special icon, heart, symbol, badge, highlight, attribution, message or explanation; its name appears
  nowhere in the UI except as its entry in the font selector
- not announced in product copy, release notes or the README
- the owner's reason for the name is private and is not recorded in public documentation

Character: when supplied, it should be a genuinely cute, friendly, charming typeface that suits its name
and is usable for real text (not a logo-only face).

**Prerequisites before implementation** (none may be fabricated; 1 and 2 don't exist yet, 3 does):

1. The actual font file (TTF or OTF), supplied by the owner.
2. A licence that permits bundling and redistribution with Vellum, use in the application, and embedding
   in PDFs where technically applicable.
3. The font-selection system of §4.3, including its vendored font parser.

Until they exist: no font file, licence text, font metadata or embedding capability is added or described
as present. No font is chosen merely because it is called Liu, no arbitrary font is downloaded and
renamed, and no other font stands in for it.

## 5. Visual identity

Detail and tokens live in `DESIGN_SYSTEM.md`, the visual implementation authority; this is the identity
every future feature must fit.

**Paper + clay + clear glass + warm paper, in a premium desktop workspace.**

The UI feels premium, calm, fast, professional, modern, desktop-native, paper-inspired, and minimal but not
empty.

- Materials: **paper** (pages, thumbnails, covers), **clay** (primary buttons, brand tile, theme tiles),
  **glass** (panels) and **floating glass** (menus, dialogs, bars; the only surfaces with blur).
- **Themes: exactly seven base colour themes** — **Mist** (default, the flagship), **Sage**, **Ocean**,
  **Blush**, **Sand**, **Lavender**, **Graphite**.
- **Every base theme has two variants: Light and Dark.** Each theme's Dark variant uses the **Obsidian**
  visual treatment: designed, not inverted — obsidian surfaces, smoked glass, warm ivory text, restrained
  accents. "Obsidian Dark" names that dark treatment; **it is not an eighth base theme.** Changing that
  would be a new product decision, logged in §14 and implemented in `themes.js` first.
- Appearance setting: **Light**, **Dark** or **System** (follows Windows), applied to the chosen base
  theme, plus an optional **custom accent** that replaces the theme's accent.
- Branding: the VELLUM wordmark in Jost (uppercase, wide tracking); the app icon, a sheet of cream clay
  paper with its corner peeled back in a glass well inside a clay tile, following the theme accent
  (`appIconSvg` in `web/js/brand.js`); Lucide icons at 1.6 px stroke.
- PDF pages stay faithful to the file (white) unless the user picks dark or sepia page colours.
- Comfort and performance: Reduce motion, Reduce transparency; no blur or filters over the PDF; themes
  never re-render pages.

**No new visual language.** Future features (Flow, Intelligence, Batch Center, forms, OCR…) use the
existing tokens, materials and components. A feature that seems to need a new style is a design-system
change first, made in `DESIGN_SYSTEM.md`, not a one-off.

The design direction was also shaped by reference images shared in conversation that are not stored in
the repository. They remain part of the direction, but only as external references; what exists in the
repository, and what doesn't, is in `docs/VELLUM_VISUAL_REFERENCES.md`.

## 6. Assets

- Keep images, icons, fonts and other assets local, packaged with the app, at portable relative paths.
- No external image URLs, internet-hosted assets or remote CDNs, at runtime or in the UI.
- Never silently substitute a missing asset (or font); a missing asset is a bug to report.
- Never fabricate an asset, licence or reference; record what is missing instead.
- Assets and references that shape the product are recorded in `VELLUM_VISUAL_REFERENCES.md`.

## 7. Security boundaries

- Protected PDFs open only with the correct password. No cracking, bypass or recovery, ever.
- Permissions and signatures are respected, never bypassed; changes that affect them are disclosed.
- The page can't navigate out of the app; links open in the user's browser.
- The host bridge is an allow-list of validated handlers; only the host touches the file system.
- Updates are verified (SHA-256) before installing.

## 8. Architecture for acceleration

Development should get faster by building infrastructure once and reusing it — not by giant prompts,
giant commits, skipped tests, rewrites of working systems, many features at once, or weaker PDF
correctness.

Reusable foundations (existing ones are extended, never duplicated):

- **commands** — one registry for every user action (`commands.js`)
- **document state and persistence** — one store and undo history per document; `composeDocument` the
  only writer of PDF bytes
- **object model** — `PageObject` with kinds and verb-by-verb capabilities (text runs, images; later
  paths, widgets, stamps, text blocks)
- **selection** — one selection model, one hit test
- **capability detection** — one reason vocabulary for what can't be done and why
- **shared test fixtures and PDF validation** — generated fixtures, independent re-reading of saved files
- **performance budgets** — measured per phase in the planning documents
- **automated regression tests** — the Node engine suite and the end-to-end suites
- **future shared pieces**: an operation pipeline that Flow and batch processing compose (§3.10); a font
  registry serving editing, the selector and embedding (§4); a content-removal writer shared by deletion
  and redaction (§3.6); the `AIProvider` interface (§3.9)

Think several releases ahead when designing; implement only the approved current phase. Phases are
small, tested and reported before the next begins.

## 9. Performance and UI weight

- The PDF stays the visual focus; the UI stays light.
- No blur or filters over PDF canvases; blur only on small floating surfaces.
- Animate transform and opacity; no continuous animated shadows.
- Large documents stay responsive; heavy work (OCR, conversion, batch) runs off the UI thread with progress.

## 10. Accessibility

- Keyboard access to every command (the command palette covers all of them).
- Reduced motion and reduced transparency respected.
- Contrast: text on accent colours stays readable (~4:1 or better in light mode).
- Tagged PDFs: Vellum says when an edit doesn't update accessibility tags; tag-preserving edits are the
  goal.

## 11. Out of scope and do not build

**Out of scope while Vellum is local-first** (could only change by an explicit owner decision): cloud
processing, document uploads, cloud storage and sync, shared cloud files, online AI APIs, API keys, cloud
sign-in, telemetry, analytics, mandatory internet, third-party SaaS.

**Do not build, ever**: password cracking or recovery; encryption, permission or signature bypass; fake
features; HTML-overlay, rasterised or guessed editing; whole-page reconstruction as an editing shortcut;
silent font substitution; a covering labelled as redaction; modifications of the WebView2 security setup
(SmartScreen, unsupported switches, Windows settings).

## 12. Release history (context only)

| Version | Theme |
|---|---|
| (initial) | first reader, 2026-09-10 (no GitHub release) |
| 0.2.0 | page organiser, page colours; in-app updates followed |
| 0.3.0 | redesign, colour themes, settings, command palette |
| 0.4.0 | real PDF text editing, one line at a time |
| 0.4.1 | the first part of the 0.5.0 object-editing plan: select, move, uniformly scale and delete text runs and pictures; quarter-turn and mirror pictures; nudge |

0.5.0 (object editing) is not complete; what remains is in `FEATURE_REGISTRY.md` and
`docs/planning/VELLUM_0.5.0_AUDIT.md`.

## 13. Open decisions

Recorded so they are not decided silently. Each needs the owner.

1. **Liu font file and licence** (§4.4): to be supplied by the owner before Liu is added to font selection.
2. **Redaction method** (§3.6): the requirement is settled (true removal, no covering, no silent
   rasterising); the technical design is research and needs approval before it is built.
3. **Local engines** for Office conversions (§3.5), OCR (§3.8), digital certificate signatures (§3.7) and
   local AI models (§3.9): each needs a vendored, offline, licence-compatible engine chosen before its
   feature starts.
4. **Extensions and templates** (§3.11): what they are, and the security model for extensions (no network,
   no document exfiltration), before anything is built.

## 14. Decision log

| Date | Decision |
|---|---|
| 2026-09-12 | Offline-first: every PDF feature local; no cloud, telemetry or online AI (commit `ae1f36c`) |
| 2026-09-12 | WebView2 kept as is (SmartScreen on, no switches); privacy wording set after the network audit |
| 2026-09-12 | 0.5.0 = object editing; its scope, deferrals and "Never" list (`planning/VELLUM_0.5.0_AUDIT.md`) |
| 2026-09-15 | This vision document created as the durable product memory; deferral never removes a requirement |
| 2026-09-15 | Full scope recorded under eight pillars: READ, EDIT, ORGANIZE, CONVERT, PROTECT, SIGN, AUTOMATE, UNDERSTAND (§3) |
| 2026-09-15 | Bundled selectable font: **Liu** — one optional document-editing font among the selectable fonts; not a default, UI or branding font; no special UI, attribution or announcement; asset and licence to be supplied (§4.4). A different name recorded earlier the same day was wrong and has been removed everywhere. |
| 2026-09-15 | Font selection is a general system of multiple selectable fonts with compatibility checks, embedding and no silent substitution (§4.3); UI typography (Jost, Segoe UI Variable) unchanged |
| 2026-09-15 | Redaction means true removal of content; a covering is not redaction; no silent rasterising; status research (§3.6) |
| 2026-09-15 | Themes: seven base themes, each with Light and an Obsidian-treated Dark variant; Obsidian Dark is not an eighth theme (§5) |
| 2026-09-15 | OCR and digital certificate signatures are planned capabilities, not out of scope (README corrected) |
