# Vellum Tools: UX and information architecture spec

**Status:** Phase 1A (the foundation, no visible Tools UI) is implemented: the catalog data, the shared
search, requirements on commands, the export and Fill in form commands, and the test-runner time limits.
The Tools sheet (Phase 2) is not. Nothing here changes `VELLUM_VISION.md`.
**Corrected** on 2026-09-23 after `TOOLS_UX_ARCHITECTURE_REVIEW.md`: availability moved to commands, tool
ids are task slugs, no presets (one command per export format), relevance (`fits`) kept apart from
requirements, search ranked by band, Ctrl+T not used. The owner's decisions are recorded in §29.
**Written:** 2026-09-23, against `release/v0.25.0` (`fe083f5`), on branch `docs/tools-ux-spec`.
**Authorities:** `VELLUM_VISION.md` (direction), `DESIGN_SYSTEM.md` (visuals),
`ARCHITECTURE_GUIDELINES.md` (engineering), `FEATURE_REGISTRY.md` (status). Where this spec disagrees
with one of them, that document wins and the difference goes to §29.

---

## 1. Problem statement

Vellum 0.25 can do about fifty distinct document tasks, but where a task lives depends on when it was
built:

| Surface | What it holds today | Source |
|---|---|---|
| Toolbar | 6 modes (Select, Highlight, Underline, Note, Draw, Edit), colour, undo/redo, save, find, page colours, print, More | `ui/toolbar.js` |
| More menu | open, recents, save, save as, print, export, show in folder, history, close; insert/extract/split/merge/images-to-PDF/HTML-to-PDF; OCR ×2, structure, graph, health, compress, PDF/A, compare; palette, settings, updates, about | `app.js` `ui.toolbar.onMenu` |
| Document context menu | selection marks, text-box clipboard, annotation/field/link items, Add Text Box / Insert picture / Add signature (Edit mode only), page rotate/delete, navigation, zoom, rotate view, print, add form fields here | `app.js` `contextmenu` |
| Page thumbnails menus | rotate, crop, duplicate, copy, paste, insert blank, insert from file, merge, extract, split, page numbers, watermark, select all, delete | `pages/actions.js` (two `openMenu` calls) |
| Contextual bars | text selection, annotation, page bar, edit/format bar, arrange bar, "Replace picture…" | `ui/text-editor.js`, `annotations/` |
| Sidebar | Pages, Outline, Structure (appears once opened), with Research inside Structure | `ui/sidebar.js`, `ui/structure.js` |
| Find bar | find, replace, replace all, redact all | `ui/findbar.js` |
| Home | Open card, recent documents, collections (Research, Graph per collection), saved research | `ui/start.js` |
| Command palette | every command with a label, grouped by `group` | `ui/palette.js` |
| Settings | Appearance, Reading, OCR, History, Updates, Shortcuts, About | `ui/settings.js` |

The result:

- **Some tasks can only be found by already knowing where they are.** Page numbers and Watermark are in
  the thumbnails menu and the palette, not the More menu. Redaction is in the palette and the find bar.
  Signatures and form fields are in the palette and in the context menu, and the context menu only
  shows them in Edit mode. Research a collection exists only on Home.
- **The palette finds labels, not intents.** `match()` in `ui/palette.js` wants every query word to
  appear in the label. "combine" doesn't find *Merge PDFs…*, "excel" doesn't find *Export…*,
  "remove page" doesn't find *Delete page*, "pictures to pdf" doesn't find *Images to PDF…*.
- **Menus drift from commands.** The context menu and the thumbnails menus build their own items with
  their own labels ("Add Link" vs "Add link", "Delete page" vs "Delete pages", "Add Text Box" vs "Add text
  box") instead of calling `menuItem(id)`. That breaks the rule in ARCHITECTURE_GUIDELINES.md that
  every surface calls commands.
- **Availability is decided in three places:** the command's `doc` flag, hand-written `disabled:`
  expressions in the More menu (`canEditPages`, `encrypted`, `history.canUse`), and refusals inside
  the actions. The palette only knows about `doc`.

Tools is where a user finds everything Vellum can do, grouped by what they want to get done. It is
built from the existing command registry, and every other surface stays as it is.

## 2. UX goals

1. **Intent first.** Tools opens on the question "What do you want to do?" and answers with the tasks
   that fit, whatever surface they currently live on.
2. **Complete and honest.** Every real task has an entry, and nothing is listed that Vellum can't do.
   Planned features don't appear (Vision §2.3).
3. **Explains itself.** A tool that can't run right now says why and what to do instead
   ("Select a picture in Edit mode first"), and stays reachable by keyboard and screen reader.
4. **Doesn't replace the fast paths.** The toolbar, context menus, the palette and shortcuts stay
   exactly as fast as they are now. Tools is how people learn a task; the fast paths are how they
   repeat it.
5. **Calm.** A few categories, compact rows, restrained recommendations. It shouldn't look like a
   dashboard or a wall of cards.
6. **Cheap.** Tools costs nothing at startup and nothing on the document, and opening it and searching
   feel instant.
7. **Hard to scatter again.** A new feature's Tools entry is a few lines of data in one file, checked
   by tests (§15, §28).

## 3. Visual design direction

The two attached reference boards are **inspiration** in the sense of `VELLUM_VISUAL_REFERENCES.md`:
Vellum takes their material language and interaction quality, not their layout, text or features.
They agree with the identity already recorded ("paper + clay + clear glass in soft light").

**What we take:**

| From the references | Vellum's existing equivalent (reuse) |
|---|---|
| Creamy, misty off-white ground | `--bg`, `--bg-glow` (Mist, Light) |
| Frosted translucent panels | Floating glass: `--glass-float` + `--blur` + `--float-shadow` |
| Tactile clay icon tiles (teal glyph in a soft rounded tile) | Neutral clay `--clay` + `--clay-shadow`; the accent tile `--clay-accent` + `--accent-shadow` |
| Restrained teal/mint accent | `--accent`, `--accent-soft`, `--accent-line`, `--accent-ink` (they follow the theme and the custom accent) |
| Soft, long, low-contrast shadows | `--sh-1…3` inside `--glass-shadow` / `--float-shadow` |
| Lit top edge on glass | `inset 0 1px 0 var(--glass-edge)` (already in every glass recipe) |
| Large controlled radii | panels/dialogs 20 px (`--r-panel`), cards 16 px, buttons 10–11 px |
| Wide-tracked display type | Jost (`--font-display`) for titles, Segoe UI Variable for UI |
| Dark board: obsidian surfaces, smoked glass | The Obsidian dark variant of every theme |
| Command palette "What do you want to do?" | The palette already uses this exact placeholder |

**What we don't take:** a persistent left navigation rail on Home (Home/Recent/Starred/Shared/Cloud);
anything Shared or Cloud (out of scope while local-first); an AI assistant panel or AI suggestions (no AI
UI until a real `AIProvider` exists); Templates and Batch Process entries (planned, and they may not
appear before they exist); Material Intensity and Glass Effect sliders and a High Performance Mode
switch (see §19: Vellum has **Reduce transparency** and **Reduce motion**, and Tools uses those); fake
people, documents or account details.

**Quality bar:** hierarchy, alignment and type do the work; glass and clay are finishes on top. If a
screen only reads as premium because of blur, it isn't finished. Tools has to look deliberate with Reduce
transparency and Reduce motion both on (§19, §20).

## 4. Existing feature inventory

**Method:** read `commands.js` (the registry), every `openMenu` caller (`app.js`, `pages/actions.js`,
`ui/toolbar.js`, `ui/viewbar.js`, `ui/text-editor.js`), `ui/start.js`, `ui/sidebar.js`,
`ui/settings.js` and `FEATURE_REGISTRY.md`. Only shipped or *done, unreleased* features are listed.

**Key.** *Doc*: needs an open, ready document. *Write*: needs pages that can be rewritten
(`view.canEditPages`, false for encrypted files). *Sel*: needs a selection (kind given).
*Scope*: F = new files from files on disk, D = whole document, P = selected pages or the current page,
p = one page, S = selection. *Pal*: in the command palette. *Tools*: ✔ = gets a Tools entry;
– = stays on its fast path only (the reason is in the note).
Entry points: TB = toolbar, MM = More menu, CM = document context menu, TM = thumbnails menus,
SB = sidebar, FB = find bar, CB = contextual bar, H = Home, ST = Settings, Pal = palette.

### 4.1 Capabilities that become Tools (49)

| # | Tool name (proposed) | Command(s) | Entry points today | Doc | Write | Sel | Scope | Keys | Pal | Aliases (starting set) |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | Edit text | `edit.text` | TB (Edit), Pal | ✔ | ✔¹ | – | p | E | ✔ | change text, fix typo, modify text, edit pdf |
| 2 | Add text box | `edit.addText` | Pal, CM (Edit mode) | ✔ | ✔ | – | p | – | ✔ | new text, type on pdf, write on pdf, insert text |
| 3 | Insert picture | `edit.insertPicture` | Pal, CM (Edit mode) | ✔ | ✔ | – | p | – | ✔ | add image, add photo, add logo, png, jpg |
| 4 | Replace picture | `edit.replacePicture` | CB (one picture), Pal | ✔ | ✔ | one picture | S | – | ✔ | swap image, change photo, update logo |
| 5 | Find and replace | `find.replace` | FB, Pal | ✔ | ✔ | – | D | Ctrl+H | ✔ | replace text, substitute, change all |
| 6 | Add link | `links.add` (+ `links.addOverSelection`) | Pal, CM (text selected) | ✔ | ✔ | – | p | – | ✔ | hyperlink, url, web link, link to page |
| 7 | Add page numbers | `pages.numbers` | TM, Pal | ✔ | ✔ | – | P | – | ✔ | number pages, page numbering, footer numbers, roman numerals |
| 8 | Add watermark | `pages.watermark` | TM, Pal | ✔ | ✔ | – | P | – | ✔ | stamp text, draft, confidential, logo on every page |
| 9 | Highlight | `annot.highlight` | TB, CB, CM, Pal | ✔ | – | – | S | H | ✔ | mark text, highlighter, marker |
| 10 | Underline | `annot.underline` | TB, CB, CM, Pal | ✔ | – | – | S | U | ✔ | underline text, mark |
| 11 | Add sticky note | `annot.note` | TB, CM, Pal | ✔ | – | – | p | N | ✔ | comment, note, annotate, remark |
| 12 | Draw | `annot.ink` | TB, Pal | ✔ | – | – | p | D | ✔ | pen, freehand, sketch, scribble, ink |
| 13 | Compare documents | `tools.compare` | MM, Pal | – | – | – | F | – | ✔ | diff, differences, what changed, versions |
| 14 | Document history | `file.history` | MM, Pal | ✔² | – | – | D | – | ✔ | snapshots, versions, restore, earlier version |
| 15 | Organize pages | `pages.organise` | SB (Pages), Pal | ✔ | – | – | D | – | ✔ | page organizer, reorder, rearrange, move pages, thumbnails |
| 16 | Rotate pages | `pages.rotateRight` / `pages.rotateLeft` (variants) | TM, CM, Pal | ✔ | ✔ | – | P | – | ✔ | turn page, landscape, portrait, sideways |
| 17 | Delete pages | `pages.delete` | TM, CM, Pal | ✔ | ✔ | – | P | Del (thumbs) | ✔ | remove page, drop page, delete page |
| 18 | Duplicate pages | `pages.duplicate` | TM, Pal | ✔ | ✔ | – | P | Ctrl+D (thumbs) | ✔ | copy page, repeat page |
| 19 | Insert blank page | `pages.insertBlank` | TM, Pal | ✔ | ✔ | – | p | – | ✔ | empty page, add page, new page |
| 20 | Insert pages from file | `pages.insert` | MM, TM, drop, Pal | ✔ | ✔ | – | D | – | ✔ | add pages, append pdf, insert pdf |
| 21 | Extract pages | `pages.extract` | MM, TM, CB (page bar), Pal | ✔ | ✔ | – | P | – | ✔ | save pages as pdf, pull out pages, take pages |
| 22 | Split into files | `pages.split` | MM, TM, Pal | ✔ | ✔ | – | D | – | ✔ | split pdf, separate, divide, split by bookmarks, every n pages |
| 23 | Merge PDFs | `pages.merge` | MM, TM, Pal | – | – | – | F | – | ✔ | combine, join pdfs, put together, merge files |
| 24 | Crop pages | `pages.crop` | TM, Pal | ✔ | ✔ | – | P | – | ✔ | trim, cut margins, margins, page size |
| 25 | Bookmarks | `bookmarks.show` / `bookmarks.add` | SB (Outline), Pal | ✔ | ✔³ | – | D | – | ✔ | outline, table of contents, toc, chapters |
| 26 | Attachments | `tools.attachments` | Pal | ✔ | ✔³ | – | D | – | ✔ | embedded files, attached files, paperclip |
| 27 | PDF to Word | `export.word` | MM (Export), Pal | ✔ | – | – | P⁴ | – | ✔ | docx, word document, editable document |
| 28 | PDF to Excel | `export.excel` | MM (Export), Pal | ✔ | – | – | P⁴ | – | ✔ | xlsx, spreadsheet, tables to excel |
| 29 | PDF to PowerPoint | `export.powerpoint` | MM (Export), Pal | ✔ | – | – | P⁴ | – | ✔ | pptx, slides, presentation, deck |
| 30 | PDF to images | `export.images` | MM (Export), Pal | ✔ | – | – | P⁴ | – | ✔ | pdf to jpg, pdf to png, pictures, save page as image |
| 31 | PDF to Markdown | `export.markdown` | MM (Export), Pal | ✔ | – | – | P⁴ | – | ✔ | md, plain text, text export |
| 32 | Images to PDF | `pages.imagesToPdf` | MM, Pal | – | – | – | F | – | ✔ | pictures to pdf, photos to pdf, jpg to pdf, png to pdf |
| 33 | HTML to PDF | `pages.htmlToPdf` | MM, Pal | – | – | – | F | – | ✔ | web page to pdf, html file, save page as pdf |
| 34 | Fill in form | `forms.fill`⁵ | inline fields, Pal | ✔ | – | – | D | – | ✔ | fill form, complete form, fill out |
| 35 | Add signature | `edit.addSignature` | Pal, CM (Edit mode) | ✔ | ✔ | – | p | – | ✔ | sign, signature, autograph, e-sign |
| 36 | Add text field | `forms.addText` | Pal, CM | ✔ | ✔ | – | p | – | ✔ | form field, input box, fillable |
| 37 | Add checkbox | `forms.addCheckbox` | Pal, CM | ✔ | ✔ | – | p | – | ✔ | tick box, check box |
| 38 | Add radio buttons | `forms.addRadio` | Pal, CM | ✔ | ✔ | – | p | – | ✔ | option buttons, choice |
| 39 | Add dropdown | `forms.addDropdown` | Pal, CM | ✔ | ✔ | – | p | – | ✔ | select list, combo box, choices |
| 40 | Redact selection | `edit.redactSelection` | Pal | ✔ | ✔ | objects (Edit mode) | S | – | ✔ | black out, remove sensitive, censor, hide text |
| 41 | Redact search matches | `find.redactAll` | FB, Pal | ✔ | ✔ | – | D | – | ✔ | redact all, redact word everywhere |
| 42 | Compress PDF | `tools.compress` | MM, Pal | ✔ | ✔ | – | D | – | ✔ | shrink, smaller, reduce size, optimize, file size |
| 43 | Recognize text (OCR) | `tools.ocrPage` / `tools.ocrDocument` (variants) | MM, Pal | ✔ | ✔ | – | p / D | – | ✔ | ocr, scan, scanned, make searchable, text recognition |
| 44 | Convert to PDF/A | `tools.pdfa` | MM, Pal | ✔ | ✔ | – | D | – | ✔ | archive, archival, long-term, pdf/a-2b |
| 45 | PDF health | `tools.health` | MM, Pal | ✔ | – | – | D | – | ✔ | check pdf, diagnose, problems, what's wrong |
| 46 | Research this document | `tools.research` | SB (Structure), Pal | ✔ | – | – | D | – | ✔ | ask, question, evidence, find answers |
| 47 | Document structure | `tools.structure` | MM, Pal | ✔ | – | – | D | – | ✔ | headings, sections, semantic search, structure search |
| 48 | Document graph | `tools.graph` | MM, Pal | ✔ | – | – | D | – | ✔ | relationships, links between, knowledge graph |
| 49 | Copy tables | `tools.copyTables` | Pal | ✔ | – | – | p | – | ✔ | extract table, table to clipboard, tsv |

¹ Also needs `textEditing.unavailableReason` to be null (the toolbar already shows it on the Edit button).
² Needs `actions.history.canUse(view)`: a document open from disk, not a read-only snapshot.
³ Reading works in any document; adding, renaming and removing need a writable one. Tools opens the
viewer either way; the feature refuses what it can't do, as it does now.
⁴ One command per format (§29 Q6): each calls `actions.export.run(view, { format })`, which opens the
same Export dialog on that format (PDF to images starts on JPEG); the dialog still chooses the pages.
⁵ Filling works inline. `forms.fill` (§29 Q7) scrolls to and focuses the first empty field (text or
list), or the first field when each has a value, in Select mode, and changes nothing; with no field to
fill it says "This PDF has no form fields". It requires `formFields`.

### 4.2 Capabilities that stay off Tools (their fast path is the right home)

| Capability | Command(s) / surface | Why not in Tools | Found through |
|---|---|---|---|
| Open, recent files, reopen closed | `file.open`, `tab.reopen`, Home, MM | Starting point, not a task on a document | Home, TB, MM, Pal |
| Save, Save as, Close, Show in folder | `file.save`, `file.saveAs`, `file.close`, `file.showInFolder` | File lifecycle | TB, MM, Pal |
| Print | `file.print` | Already one click in the toolbar | TB, MM, CM, Pal; Tools search fallback |
| Export… (generic) | `file.export` | Each format is its own command and tool (`export.*`, the five *PDF to …* tools) | MM, Pal, Ctrl+Shift+E |
| Find in document, find next/previous | `find.*` | A reading control | TB, Ctrl+F; Tools empty-search action (§9.7) |
| Page navigation, go to page | `page.*` | Reading | View bar, keys |
| Zoom, fit, actual size | `zoom.*` | Reading | View bar, keys, CM |
| View rotation, layouts, two-page spread | `view.rotate*`, `view.continuous`, `view.single`, `view.spread` | Reading; not saved in the file | View bar, CM, Pal |
| Page colours | `view.pageTone` | Display preference | TB, ST, Pal |
| Sidebar, thumbnails | `sidebar.toggle` | Panel control | TB, F4 |
| Undo / redo, select all, copy text | `edit.undo`, `edit.redo`, `edit.selectAll`, `edit.copy` | Universal editing keys | Keys, TB, CM |
| Move, scale, stretch, turn, mirror, nudge, delete objects | `ui/text-editor.js` gestures | Direct manipulation of a selection | Edit mode, keys |
| Align and distribute | `arrange.*` | Needs 2+ selected objects | Arrange bar, Pal |
| Copy / cut / paste / duplicate objects | `edit.copyObjects` … | Clipboard | Keys, CM, Pal |
| Text formatting: size, bold, italic, underline, colour, opacity, alignment, font family | `edit.text*`, `edit.textFont*` (one command per font) | Acts on a selection; the format bar is the right home | Format bar, Pal |
| Paragraph reflow, snapping, overlap warnings | gestures | Behaviour of Edit mode, not a task | Edit mode |
| Delete annotation, edit note | `annot.delete`, CM | About the thing under the pointer | CM, keys |
| Edit an existing form field / link | CM only | About the thing under the pointer | CM; mentioned in the *Fill in form* and *Add link* descriptions |
| Copy / paste / move pages | `pages.copy`, `pages.paste`, `pages.moveUp/Down` | Thumbnail clipboard and keys | TM, keys (*Organize pages* covers the intent) |
| Semantic search | inside the Structure tab | Part of *Document structure* | SB |
| Export evidence, Save this research | inside Research | Follow-up actions on a result | Research panel |
| Collections: create, rename, add, research, graph | Home only (no commands) | Workspace management | H (§29 Q8) |
| Saved research list | Home only | Workspace | H |
| Tabs: next, previous | `tab.*` | Window navigation | Keys |
| Settings, theme, shortcuts, updates, default app, about | `app.*`, `view.theme` | App preferences | Title bar, MM, Pal |
| OCR language packs, history storage | Settings → OCR, History | Preferences / storage | ST |

**Totals:** 49 Tools entries, each backed by a command (48 before Phase 1A, plus *Fill in form* once
`forms.fill` existed), and 26 capability groups deliberately kept off Tools, which between them cover
every other command in the registry. **75 meaningful capabilities inventoried.**

### 4.3 Findings the inventory turned up

1. The context menu and the thumbnails menus bypass `commands.js` for most items (labels and casing
   drift, and those items are invisible to the palette's `keys` hints).
2. `palette.js` `GROUP_ORDER` left out `Tools`, `Forms`, `Bookmarks` and `Links` (`Arrange` was already
   there), so those groups sorted last and in no set order, and "Tools" could head two sections. Fixed
   in Phase 1A.
3. The word "tools" is already taken in the code: the toolbar's mode control has `aria-label: 'Tools'`,
   commands use `group: 'Tools'` and `tools.*` ids, `view.setTool()` means annotation mode, and
   **localStorage `vellum.tools` holds annotation colours** (`annotations/layer.js`). The new surface
   needs a separate code namespace (§17.1).
4. Commands that act "here" (Add Text Box at a click point, rotate *this* page) exist twice: as a
   command without arguments and as an inline closure in a menu. Commands have no argument channel
   (§29 Q4).
5. Some palette commands assume a mode. For example, `edit.addText` goes through `#insertionPage`, which
   expects Edit mode. A tool has to work from any state (§18.4). Phase 1 audits each one.

## 5. Final information architecture

### 5.1 Candidates evaluated

| Candidate | Verdict | Reason |
|---|---|---|
| Edit | **Keep** | Clear intent: change what the page says or shows. |
| Organize | **Keep** | Clear intent: pages and files. The biggest category (12), so it gets sections. |
| Convert | **Keep, with a strict rule** | **The file format changes** (PDF → other, other → PDF). Output that is still a PDF is not Convert. |
| Extract | **Drop as a category** | It overlaps Convert (PDF → Excel *is* extraction), Organize (Extract pages) and Research (Copy tables). A first-time user can't predict which one holds a task. "extract" becomes an alias. |
| Protect | **Keep** | Only 2 tools today, but a very clear intent, and passwords, permissions and metadata cleaning are planned (Vision §3.6). |
| Optimize | **Keep, under a clear rule** | **Still a PDF, made fitter for a purpose:** smaller, searchable, archival, checked. That puts PDF/A here, not in Convert. |
| Research | **Keep** | Vellum's differentiator: structure, research, graph, tables. More concrete for first-time users than the pillar name "Understand". |
| Automate | **Reserve, hidden** — now **shown** | Hidden while nothing existed: an empty category would fake a feature. It appeared with its first real tools, batch processing (Compress many PDFs, Convert many Office files to PDF); Workflows (Vellum Flow V1) joined it. |
| Review *(added)* | **Add** | Markup that doesn't change the page (highlight, underline, notes, drawing), plus Compare and History ("look at it, mark it, see what changed"). Annotating isn't editing, and first-time users keep the two apart. |
| Fill & Sign *(added)* | **Add** | A top-three PDF intent. It matches the Vision's SIGN pillar and common usage. |
| Read / View | **Don't add** | Zoom, layouts, page colours and navigation are controls, not tasks. They stay in the view bar and the palette; Tools search falls back to them (§9.7). |

### 5.2 Final taxonomy: 8 categories (plus Automate, shown since batch processing)

Order: most common intent first, and document-changing tasks before read-only ones.

```
EDIT          Change text and pictures, add to pages                       8
  Text and pictures   Edit text · Add text box · Insert picture · Replace picture ·
                      Find and replace · Add link
  Add to pages        Add page numbers · Add watermark

REVIEW        Mark up, compare and look back                                6
  Mark up             Highlight · Underline · Add sticky note · Draw
  Compare and history Compare documents · Document history

ORGANIZE      Pages, and combining or splitting files                      12
  Pages               Organize pages · Rotate pages · Delete pages · Duplicate pages ·
                      Insert blank page · Crop pages
  Combine and split   Merge PDFs · Insert pages from file · Extract pages · Split into files
  In this document    Bookmarks · Attachments

CONVERT       Turn a PDF into another format, or other files into a PDF     7
  From PDF            PDF to Word · PDF to Excel · PDF to PowerPoint · PDF to images ·
                      PDF to Markdown
  To PDF              Images to PDF · HTML to PDF

FILL & SIGN   Fill in forms, sign, create form fields                      5 (+1)
  Fill and sign       (Fill in form) · Add signature
  Create a form       Add text field · Add checkbox · Add radio buttons · Add dropdown

PROTECT       Remove sensitive content for good                             2
  Redact              Redact selection · Redact search matches

OPTIMIZE      Smaller, searchable, archive-ready, checked                   4
                      Compress PDF · Recognize text (OCR) · Convert to PDF/A · PDF health

RESEARCH      Understand a document and quote from it                       4
                      Research this document · Document structure · Document graph · Copy tables

AUTOMATE      Run the same steps on many files                              3
                      Compress many PDFs · Convert many Office files to PDF · Workflows
```

**Rules that keep it stable:**

- **One home per tool.** A tool is in exactly one category. Other places it might fit are covered by
  aliases and search. It is never listed twice.
- **Category size 2–14.** Above 8, the category gets named sections (like Organize). Above 14, the owner
  decides whether it splits (a test enforces the limit, §24).
- **Category names are verbs or plain nouns a first-time user would say**, one or two words. No brand
  words (no "Intelligence", no "Flow" as a category name).
- **Tests for the boundary cases:** *does the output leave PDF?* → Convert. *Is it still a PDF, improved
  for a purpose?* → Optimize. *Does it change what the page shows?* → Edit. *Does it add markup on top
  without changing the page?* → Review. *Does it remove information for good?* → Protect.

### 5.3 Relationship to the Vision's pillars (unchanged)

The Vision's eight pillars describe product scope; the Tools categories describe user intent. This spec
doesn't rename the pillars. Mapping: EDIT → Edit + Review (markup); ORGANIZE → Organize + Optimize
(compression, diagnostics, PDF/A); CONVERT → Convert; PROTECT → Protect; SIGN → Fill & Sign;
UNDERSTAND → Research + Review (compare) + Optimize (OCR); AUTOMATE → Automate (reserved); READ → not
a Tools category. Whether to align the names is §29 Q1.

## 6. Tools navigation architecture

### 6.1 Form: a sheet, not a new page and not a navigation rail

Tools opens as a **large modal sheet** of floating glass, centred over whatever is showing (Home or a
document). It is the same kind of surface as the palette and dialogs, only bigger.

Alternatives considered:

- *A full-screen Tools page beside Home.* Rejected. It hides the document the user is working on, it
  needs a second "back" model, and Vellum has no app-level navigation for it to live in.
- *A persistent left rail (as in the reference).* Rejected. It is a new navigation system, takes width
  from the PDF (Vision §2.5), and would duplicate the tab strip and Home.
- *A sidebar tab.* Rejected. The sidebar is 212 px wide and about the document's pages. Tools
  doesn't fit there.

### 6.2 Entry points

| Entry | Detail |
|---|---|
| Title bar **Tools** button | Always visible (Home and documents). Icon `layout-grid` + label "Tools"; icon-only on narrow windows. Sits left of the palette button. |
| Shortcut **Ctrl+Shift+A** (proposed) | Toggles Tools. Free in `commands.js`; before Phase 2, one check that WebView2 doesn’t reserve it (§29 Q3). **Ctrl+T is not used**: it sits beside Ctrl+Shift+T (Reopen closed document), and people expect Ctrl+T to open a new tab. |
| Palette command `app.tools` "All tools…" | So Ctrl+K users can get there. |
| More menu: **All tools…** | First item. The More menu keeps its current tool entries until the owner decides otherwise (§27 Phase 5). |
| Home **Tools** row | Quick tools that need no document, plus "All tools" (§8). |
| Direct deep link (internal) | `ui.tools.open({ category, query })`, for Home tiles and for future Settings/help links. |

### 6.3 Inside the sheet

```
+--------------------------------------------------------------------------------------------+
|  [search]  What do you want to do?                                     Ctrl+Shift+A  [x]    |
+-----------------------+--------------------------------------------------------------------+
|  Home                 |                                                                    |
|  Favorites        3   |   content region (landing, category, or search results)           |
|  Recent               |                                                                    |
|  -------------------  |                                                                    |
|  Edit             8   |                                                                    |
|  Review           6   |                                                                    |
|  Organize        12   |                                                                    |
|  Convert          7   |                                                                    |
|  Fill & Sign      5   |                                                                    |
|  Protect          2   |                                                                    |
|  Optimize         4   |                                                                    |
|  Research         4   |                                                                    |
+-----------------------+--------------------------------------------------------------------+
```

- **Rail** (200 px): Home (the landing), Favorites (only once there are any), Recent (only once there
  are any), then the categories. The counts are ink-3 and describe the whole catalog, not just what's
  available.
- **Content**: one of three views: *Landing*, *Category*, *Results*. Typing switches to Results.
  Clearing the field returns to the view that was showing before.
- **Size:** `min(980px, 100vw − 48px)` × `min(700px, 100vh − titlebar − 48px)`. Under 720 px wide, the
  rail collapses to a horizontal, scrollable row of category chips under the search field.
- **Running a tool** closes the sheet, restores focus, and runs the command on the next frame, as
  `CommandPalette.#run` already does.

## 7. Tools landing page

### 7.1 Landing, document open

```
+--------------------------------------------------------------------------------------------+
|  (q) What do you want to do?|                                          Ctrl+Shift+A  [x]    |
+-----------------------+--------------------------------------------------------------------+
| > Home                |  For "Lease agreement.pdf"                           Not now       |
|   Recent              |  +--------------------------+ +--------------------------+         |
|  -------------------  |  | [#] Fill in form         | | [~] Add signature        |         |
|   Edit             8  |  |     14 form fields       | |     14 form fields       |         |
|   Review           6  |  +--------------------------+ +--------------------------+         |
|   Organize        12  |                                                                    |
|   Convert          7  |  Recent                                                            |
|   Fill & Sign      5  |  [Compress PDF] [PDF to Word] [Merge PDFs] [Add page numbers]      |
|   Protect          2  |                                                                    |
|   Optimize         4  |  All tools                                                         |
|   Research         4  |  +--------------+ +--------------+ +--------------+ +--------------+|
|                       |  | [T] Edit     | | [*] Review   | | [#] Organize | | [<>] Convert ||
|                       |  | Change text  | | Mark up,     | | Pages, merge | | To and from  ||
|                       |  | and pictures | | compare      | | and split    | | other formats||
|                       |  +--------------+ +--------------+ +--------------+ +--------------+|
|                       |  +--------------+ +--------------+ +--------------+ +--------------+|
|                       |  | [~] Fill &   | | [!] Protect  | | [o] Optimize | | [?] Research ||
|                       |  |     Sign     | | Redact       | | Smaller,     | | Understand   ||
|                       |  +--------------+ +--------------+ +--------------+ +--------------+|
+-----------------------+--------------------------------------------------------------------+
```

- **For this document:** 0–3 recommendations (§11), each with a one-line reason. When there are none,
  the section isn't there (no placeholder).
- **Recent:** up to 6 chips, most recent first; hidden when empty. Favorites show here instead when the
  user has any: *Favorites* first, then *Recent*, 6 chips in total.
- **All tools:** 8 category tiles in a 4 × 2 grid (2 × 4 when narrow). Each tile is about 76 px tall:
  icon in a clay well, name, and a one-line description. These are the only card-like elements on the
  page.

### 7.2 Landing, no document (Home underneath)

```
+--------------------------------------------------------------------------------------------+
|  (q) What do you want to do?|                                          Ctrl+Shift+A  [x]    |
+-----------------------+--------------------------------------------------------------------+
| > Home                |  Start without a document                                          |
|   Recent              |  +--------------------+ +--------------------+ +--------------------+|
|  -------------------  |  | [+] Merge PDFs     | | [img] Images to PDF| | [<>] HTML to PDF   ||
|   Edit             8  |  | Combine files into | | JPG and PNG into   | | A saved web page   ||
|   ...                 |  | one new PDF        | | one PDF            | | into a PDF         ||
|                       |  +--------------------+ +--------------------+ +--------------------+|
|                       |  +--------------------+                                            |
|                       |  | [=] Compare        |                                            |
|                       |  | Two PDFs, side by  |                                            |
|                       |  +--------------------+                                            |
|                       |                                                                    |
|                       |  All tools                          Most tools work on an open PDF |
|                       |  (category tiles as above)                        [ Open a PDF ]   |
+-----------------------+--------------------------------------------------------------------+
```

### 7.3 Category view

```
+-----------------------+--------------------------------------------------------------------+
|   Home                |  Organize                                                          |
|  -------------------  |  Pages, and combining or splitting files                          |
|   Edit                |                                                                    |
|   Review              |  PAGES                                                             |
| > Organize       12   |  [#]  Organize pages        Reorder, rotate and delete in the   *  |
|   Convert             |                             page thumbnails                         |
|   ...                 |  [r]  Rotate pages          Pages 3-5                   Right  Left |
|                       |  [x]  Delete pages          Pages 3-5                        Del   |
|                       |  ...                                                               |
|                       |  COMBINE AND SPLIT                                                 |
|                       |  [+]  Merge PDFs            Combine several PDFs into one new file  |
|                       |  ...                                                               |
+-----------------------+--------------------------------------------------------------------+
```

A **tool row** is 52 px tall, left to right:

- a 32 px clay icon well with an 18 px Lucide glyph;
- the name (13 px, 600 weight, ink);
- one line underneath: the description (12 px, ink-3), **or the scope** when it helps
  ("Pages 3–5", "This page", "Whole document"), **or the reason** when the tool is unavailable;
- on the right: variant buttons (Right / Left for rotation, This page / Whole document for OCR), the
  shortcut as a `kbd`, and a favourite star that shows on hover and on focus, and always shows once
  starred.

Rows are not cards: they sit on the sheet, with hover `--hover`, a focus ring, and hairline separators
only between sections.

### 7.4 Unavailable tools

- They stay in the list, in place, so the catalog never jumps around. The name is ink-2, the icon well
  is flattened (no clay shadow), and the reason replaces the description in ink-3. The reason is
  readable text, never shown only by dimming.
- `aria-disabled="true"` rather than `disabled`, so the row stays focusable and the reason is read out.
  Activating it shows nothing new, and it runs nothing.
- **No document:** doc-only tools are grouped once per category under
  *"Open a PDF to use these"* with one **Open a PDF** button, instead of repeating the reason on every
  row.
- Reasons come from the requirement evaluator (§18), which reuses each feature's own wording where it
  has one (e.g. `textEditing.unavailableReason`).

### 7.5 Empty search

```
|  No tools match "password".                                                        |
|                                                                                    |
|  Find "password" in this document                                   Ctrl+F         |
|  Search commands for "password"                                     Ctrl+K         |
```

It never suggests features that don't exist, and never says "coming soon".

## 8. Home and Tools

Home stays a calm start screen: greeting, Open card, Recent documents, Collections, Saved research. It
gains **one row** under the Open card, and nothing more:

```
|  Good afternoon, Pankaj.                                                             |
|  Paper meets possibilities.                                                          |
|  +------------------------------------------------------------+                      |
|  |  (+)  Open a PDF                                   Ctrl+O   |                      |
|  +------------------------------------------------------------+                      |
| [Merge PDFs] [Images to PDF] [Compare documents] [HTML to PDF] All tools Ctrl+Shift+A|
|                                                                                      |
|  Recent documents ...                                                                |
```

- **What goes in the row:** tools whose command needs no document (no `doc`, no `requires`), which on
  Home are the only ones that can run. Recently used ones come first, then the defaults above. At most 4 chips, plus
  **All tools**.
- **What doesn't:** doc-only tools, categories, recommendations, favorites, and any second copy of the
  catalog.
- Chips are small clay buttons (34 px) with an icon and a label: the same weight as the collection
  actions, much lighter than the Open card.
- *Research a collection* and *Graph* stay on each collection, where they already are.

## 9. Search architecture

One deterministic, local search module (`web/js/catalog/search.js`), shared by Tools and the command
palette. No AI, no network, no embeddings, no dictionary stemmer, no index structure. A surface gives
items and fields (`{ get, weight, phrase }`); the engine doesn't know what a tool or a command is.

### 9.1 What is indexed

For each tool: `name` (weight 3, phrase), `aliases` (2.5, phrase), its category and section names (1),
`blurb` (0.5), and the label of each command it runs (1), so the words people already know from menus
still work. For the palette: each command's `label` (3, phrase), the aliases of the tool it runs (2.5,
phrase) and its `group` (1); recent files by name. Tools' "More commands" fallback (§9.7) searches the
palette's items.

### 9.2 Normalisation (the query and the index go through the same steps)

1. Lower-case; Unicode NFKD, then remove combining marks ("résumé" → "resume").
2. `pdf/a` becomes `pdfa`; `→` and `->` become ` to `; `&` becomes ` and `; apostrophes go ("what’s" →
   "whats"); every other character that isn't a letter or digit becomes a space; then a `2` standing
   alone between two words becomes `to` ("pdf 2 word").
3. Split on whitespace.
4. Stop words (`a an the my this of for please`) are removed unless the query is *only* stop words.
   **"to" and "into" are kept**, because they mark direction (§9.4).
5. Light, deterministic stemming of what is left: drop a final `s` from words of 4+ letters that don't
   end in `ss` ("pages" → "page", "pdfs" → "pdf"). That's all.

### 9.3 Matching tiers, per query word

| Tier | Rule | Points |
|---|---|---|
| Exact | the word equals a field word | 100 |
| Prefix | a field word starts with the word | 70 |
| Inner | the word appears inside a field word (word ≥ 3 letters) | 30 |
| Typo | Damerau–Levenshtein distance 1 to a field word (word ≥ 5 letters) | 20 |

Each query word is scored **once**, by its best match over all fields (points × the field's weight),
and the text score is the sum over the words. (Summing per field would count a tool twice when its name
and its command's label are the same words.) A word that is the first word of a name, label or alias
counts +10 points more, so "page" in the palette finds *Page numbers…* before *Export pages as images…*.

**Every query word must match** (AND, as the palette always did), **except the optional words** `to`,
`into` and any number. They never leave a result out, and count only for phrase and order (§9.4). So
"rotate 2 pages" (read as "rotate to pages") and "rotate page 3" both find Rotate pages. A query made
only of optional words is matched as it is.

### 9.4 Phrase and direction

- **Phrase:** the query equals a name, label or alias word for word (or does once optional words are
  left out of both). Bonus: 300 × that field's weight.
- **Ordered:** the query's words appear in that order, together, inside a name, label or alias.
  Bonus: 120 × the field's weight. That's what separates "pictures to pdf" (Images to PDF) from "pdf to
  pictures" (PDF to images), even though both use the same words.

### 9.5 Ranking

Results are sorted by, in order:

1. **Band**, the strength of the match as a whole: phrase > ordered > every word exact > every word at
   least a prefix > inner > typo (the weakest word decides);
2. **text score** (§9.3, plus the §9.4 bonus);
3. **context**, only where a surface allows it: in Tools, available now, favorite, recently used and
   recommended (in that order of weight). The palette gives none: it stays neutral and predictable;
4. the order the items were given in (catalog order for tools; group order for the palette).

So context only breaks ties that text leaves; it can never lift a result above a better text match.
The result is fully deterministic for a given catalog, query and context. **Palette invariant:** typing
any command's whole label puts that command first (tested over every command, §24).

### 9.6 Required results (these become golden tests, §24)

| Query | Top result |
|---|---|
| compress | Compress PDF |
| shrink / smaller | Compress PDF |
| combine | Merge PDFs |
| remove page | Delete pages |
| excel / xlsx | PDF to Excel |
| pictures to pdf | Images to PDF |
| pdf to jpg / pdf to pictures | PDF to images |
| word / docx | PDF to Word |
| ocr / scanned | Recognize text (OCR) |
| sign | Add signature |
| black out | Redact selection |
| reorder | Organize pages |
| rotate | Rotate pages (above *Rotate view*, which appears only in the fallback) |
| rotate 2 pages / rotate page 3 | Rotate pages |
| wtaermark (typo) | Add watermark |
| archive | Convert to PDF/A |
| page number | Add page numbers |
| extract | Extract pages first, then PDF to … and Copy tables |
| text | Edit text (the 41 *New text in …* font commands stay in the palette) |
| font | No tool: fonts are formatting, found in the palette |
| convert to word / pdf 2 word | PDF to Word |
| powerpoint | PDF to PowerPoint (the direction a PDF reader is asked for most; *PowerPoint to PDF* next) |
| word to pdf / docx to pdf | Word to PDF (and *pdf to word* stays PDF to Word: word order decides) |
| excel to pdf / xlsx 2 pdf | Excel to PDF |
| powerpoint to pdf / slides to pdf | PowerPoint to PDF |
| office | The three Office tools present on this PC, and nothing else |

### 9.7 Results view and fallback

- Tools come first (up to 12), then a quiet section **"More commands"** with up to 5 matching palette
  commands that aren't tools (e.g. "rotate" → *Rotate view clockwise*). Both run through the command
  registry.
- When nothing matches: the empty state (§7.5).
- Performance: about 50 tools × about 8 aliases. A full scan per keystroke is well under 1 ms, so there's
  no debounce and no index structure beyond pre-normalised token arrays built once.

### 9.8 Aliases are a contract

- Aliases describe **what the tool really does**. An alias may never suggest a feature that doesn't exist
  ("encrypt", "password", "bates", "translate", "ai" are forbidden until those features ship). A test
  holds the forbidden list (§24).
- Two tools may share an alias only when that is listed in the catalog's `SHARED_ALIASES` allow-list,
  which the test also checks. No alias may read the same as **another** command's label (that would
  break the palette invariant, §9.5).
- The palette gains the aliases of commands that are tools, joined per command (a tool's variants
  included). "combine" in Ctrl+K then finds *Merge PDFs…* too. The palette doesn't regroup by Tools
  category (§29 Q11).

## 10. Recent and favorites

| | Recent | Favorites |
|---|---|---|
| What | The last 8 **distinct** tools run from *any* surface that runs a tool's command: Tools, Home chips, the palette | Tools the user starred |
| Order | Most recent first | The order they were starred; reorderable later, not in V1 |
| Limit | 8 (6 shown on the landing) | 12 |
| Recorded | When the tool's command is invoked (commands don't report success; that is fine for "recent") | On star |
| Cleared | "Clear" link in the Recent view | Unstar |
| Shown | Landing chips, rail (only when non-empty), a search boost | Landing chips (ahead of Recent), rail (only when non-empty), a search boost |

**Storage:** `localStorage` key **`vellum.catalog`** = `{ v: 1, recent: [{ id, t }], favorites: [id] }`
(**not** `vellum.tools`, which annotation colours already use). It holds tool ids and timestamps only,
never file names or document data, and stays on the PC like the other appearance preferences. Unknown
ids (a tool that was removed) are dropped when read. Every read and write is wrapped in `try`, as
`toolPrefs` does now.

Recording from the palette means the recent list reflects real use. It needs one small hook: the palette
tells the catalog which command it ran, and the catalog records it if that command belongs to a tool.
Commands themselves don't change.

## 11. Context-aware recommendations

### 11.1 Principles

- **Only provable signals.** A recommendation stands on a fact Vellum already knows or can learn cheaply,
  in the words of the part that knows it. It never guesses a document "type" ("research-oriented" can't
  be proven; Research surfaces through Recent instead).
- **At most 3**, only on the document-open landing, each with a one-line reason. Never a badge, a
  pulse, a toast or a popup.
- **Dismissible:** "Not now" hides the strip for that document until the session ends.
- **Data, not scattered code:** every rule lives in one module (`catalog/recommend.js`), keyed by tool
  id. UI code never contains a recommendation rule.

### 11.2 Signals (cheapest first)

| Signal | Source (existing) | Cost |
|---|---|---|
| `formFields` (count) | `DocumentView#fields` via `readFields` at load (expose a count getter) | free |
| `attachments` (count) | `annotations.initAttachments` at load | free |
| `openDocuments` | `app.views.length` | free |
| `encrypted` | `view.encrypted` | free |
| `profile.signed / certified / tagged / pdfa` | `view.profile()` (already resolved at idle after the first render) | free once resolved; if not resolved yet, the strip updates when it is |
| `xfa` | `pdf.getMetadata().info.IsXFAPresent` (PDF health reads it already) | one small call, cached |
| `pageHasText` (current page) | `hasUsableText(page)` from `ocr/` on the **current page only** | one text-content read, cached per page per view |

Signals never read other pages, never run the editing analysis, and never block opening the sheet.

### 11.3 Rules (V1)

| Priority | Signal | Recommend | Reason shown |
|---|---|---|---|
| 1 | `pageHasText === false` | Recognize text (OCR) | "This page has no text layer. OCR makes it searchable." |
| 2 | `formFields > 0` and not encrypted | Fill in form, Add signature | "This PDF has {n} form fields." |
| 3 | `xfa` | PDF health | "This PDF contains an XFA form." |
| 4 | `profile.signed` | PDF health | "This PDF is digitally signed." |
| 5 | `openDocuments ≥ 2` | Compare documents | "{n} documents are open." |
| 6 | `attachments > 0` | Attachments | "{n} files are attached to this PDF." |

The top 3 distinct tools that are *available now* are shown. The prompt's "large/problematic document →
Compress, Repair" is **not** in V1: Repair doesn't exist, and file size isn't known without reading the
file again. If the host reports the size with the file later, a `size ≥ 20 MB → Compress PDF` rule can
be added as one line.

## 12. No-document experience

- Title bar **Tools** and **Ctrl+Shift+A** work.
- The landing shows *Start without a document* (Merge PDFs, Images to PDF, HTML to PDF, Compare
  documents), then Recent (if any), then All tools.
- Categories stay browsable: no-doc tools are listed normally, and doc-only tools sit under *"Open a PDF
  to use these"* with one **Open a PDF** button, which runs `file.open` (§7.4).
- Search works over everything. Doc-only results show the reason "Open a PDF first".

## 13. Document-open experience

- The landing shows *For "<file name>"* (recommendations), then Recent/Favorites, then All tools (§7.1).
- Scope hints are live. Page tools show "Page 4" or "Pages 3–5 (selected)". Selected pages come from
  `ui.sidebar.thumbs.targetIds()`, which the page commands already use.
- **Protected (encrypted) documents:** every tool that needs `writable` shows the reason already used
  elsewhere ("This PDF is protected…"). Reading tools (Research, Structure, Health, Compare,
  Export) stay available.
- **Loading / error documents:** treated as no document (`status !== 'ready'`). The landing says
  "“<name>” is still opening" or shows the document's own error, and doesn't offer doc tools.

## 14. Context-specific experience

When Tools opens with something selected, the landing gets one extra strip above Recent, **"For your
selection"**. It lists up to 4 available tools that *fit* what is selected, in catalog order:

| Selection | Tools shown (derived, not hard-coded) |
|---|---|
| Text selected (Select mode) | Highlight, Underline, Add link |
| One picture selected (Edit mode) | Replace picture, Redact selection |
| Objects selected (Edit mode) | Redact selection |
| Pages selected in thumbnails | Rotate pages, Delete pages, Extract pages, Crop pages |

It is computed from each tool's `fits` (relevance: `selection.text`, `selection.picture`,
`selection.objects`, `pages.selected`), never from requirements. Highlight, Underline and Add link run
without a selection, so a selection is not their requirement; it is what makes them relevant. `fits`
only suggests and never stops a tool running (§18.1). Nothing in the UI names a specific tool. The
contextual bars and the context menu stay the fast path for these; the strip just teaches that they
exist.

## 15. Feature placement rules

These rules apply to every future feature (see also §28).

1. **Every user action is a command** (existing rule, unchanged).
2. **Every task a user would name gets exactly one Tools entry**, in exactly one category, with at
   least 3 aliases and a one-line description. "Would name" means a request like "merge these PDFs" or
   "add page numbers". A gesture or a formatting attribute doesn't count.
3. **The toolbar** holds modes and the few document actions used several times a session. Adding a
   toolbar button needs the owner's approval, and a feature that needs no document never goes there.
4. **Context menus and contextual bars** hold only actions about what is under the pointer or selected.
   They reference commands through `menuItem(id)`; an inline closure is allowed only while a command
   can't take the argument it needs (§29 Q4), with a comment naming the command it stands in for.
5. **The More menu** holds the file lifecycle plus **All tools…**. Its tool entries are transitional
   (§27 Phase 5).
6. **The palette** lists every command, as now, and gains tool aliases.
7. **Settings** holds preferences and storage only, and never an action that changes a document.
8. **Workflows** (Export, Crop, Split, Merge, Compare, Health, History, Watermark, Page numbers) own
   their options. (Here "workflow" means a feature's own dialog; the saved, runnable *Workflows* of Vellum
   Flow are a different thing, specified in ARCHITECTURE_GUIDELINES.md, *Operations, batch processing and
   workflows*.) A tool opens the workflow and never re-implements a workflow option in Tools. A tool
   never carries run parameters: when one workflow serves several goals (Export → Word, Excel…), each
   goal is its own command, which opens the workflow on its choice (`export.word` →
   `actions.export.run(view, { format: 'word' })`).
9. **Home** holds starting points (open, recent, collections, saved research) plus the quick no-doc
   tools row. It never holds a second catalog.
10. **Planned features appear nowhere** until they work.

## 16. Capability / tool / command model

| Concept | Is it a separate thing? | Where it lives |
|---|---|---|
| **Command** | Yes (exists) | `commands.js`: id, `label`, `icon`, `group`, `keys`/`hint`, `global`, `when`, `doc`, `requires`, `presentIf`, `palette`, `run`. The only thing that runs, and it declares what it needs |
| **Action** | Yes (exists) | `actions.*` in `app.js` and each feature's `create…Actions`. The implementation, called only by commands |
| **Tool** | **Yes (new, data only)** | A catalog record: the user-facing *task* that points to a command. Never runs, never gates |
| **Capability** | No: a documentation word | Anything Vellum can do (the inventory, §4). A tool is a capability with a discovery entry. Not a code concept (`editing/objects/capabilities.js` already uses the word for object verbs) |
| **Category / section** | Yes (new, data) | Catalog constants |
| **Search metadata** | Part of the tool | `aliases`, `blurb` on the tool; labels and keys read from the command |
| **Shortcut** | No, it stays on the command | `command.keys`/`hint`, shown through `prettyKeys()`. A tool never repeats a key |
| **Requirement** (can it run now?) | Yes (new, a small vocabulary) | Named on the **command** (`doc`, `requires`); `web/js/requirements.js` evaluates them for every surface |
| **Presence** (is its provider on this PC?) | Yes | `presentIf` on the command; unmet hides it everywhere, the palette included. First used by Word, Excel and PowerPoint to PDF |
| **Relevance / fit** (does it suit what is on screen?) | Yes (new, data) | `fits` on the tool. Suggests only (§14); never gates |
| **Recommendation** | Yes (new, rules as data) | `catalog/recommend.js` (Phase 4) |
| **UI entry point** | No | Toolbar, menus, palette, Tools, Home: each calls commands |

There is still **one command system**. A tool can't run anything by itself: it names a command (and
the variant commands of the same goal), and the command registry does the rest.

```
 Tools sheet ─┐        ┌─ catalog/catalog.js   (tools, categories: data)       ┐ testable in Node,
 Home chips  ─┼─ uses ─┼─ catalog/search.js    (the one search engine)          │ import nothing from
 Palette     ─┘        ├─ catalog/recommend.js (relevance rules; Phase 4)       │ the app, no DOM
       │               └─ catalog/store.js     (recent/favorites; Phase 3)      ┘
       │                          │ names a command id
       │                          ▼
       └── availability ──► requirements.js ◄── commands.js ──► actions.* ──► features
                            (snapshot + availability)   (doc, requires, presentIf)
```

Automation (Batch, and workflows) binds to **operation ids** in an operation registry over the pure core
modules, never to tool ids or commands (§29 Q13).

## 17. Registry / metadata proposal

### 17.1 Location and naming

- Code namespace **`web/js/catalog/`**, storage key **`vellum.catalog`**. The *user-facing* name is
  **Tools**. The word "tool" already means annotation mode in the code (§4.3), and the namespace
  keeps the two apart.
- UI module: `web/js/ui/tools.js` (the sheet), loaded with a dynamic `import()` the first time it
  opens. CSS: a new section `/* ---- tools (ui/tools.js) ---- */` in `app.css`, using tokens only.

### 17.2 Record shape

```js
// web/js/catalog/catalog.js: data only. No DOM, no app state, no imports, no functions except pure helpers.
export const CATEGORIES = [
  { id: 'edit', name: 'Edit', icon: 'type', blurb: 'Change text and pictures, add to pages',
    sections: [{ id: 'content', name: 'Text and pictures' }, { id: 'marks', name: 'Add to pages' }] },
  // review, organize, convert, sign, protect, optimize (no sections), research (no sections)
  { id: 'automate', name: 'Automate', icon: 'sliders-horizontal', blurb: '…', sections: [], reserved: true },
];

export const TOOLS = [
  {
    id: 'merge-pdfs',                  // a task slug: never the category, never the command id, never reused
    name: 'Merge PDFs',                // sentence case; "to", never an arrow, in names
    blurb: 'Combine several PDFs into one new file',
    category: 'organize', section: 'combine',
    command: 'pages.merge',            // the command that runs it; availability is read from the command
    variants: null,                    // e.g. [{ label: 'This page', command: 'tools.ocrPage' },
                                       //        { label: 'Whole document', command: 'tools.ocrDocument' }]
    aliases: ['combine', 'join pdfs', 'put together', 'merge files'],
    fits: null,                        // relevance only, e.g. 'selection.text'; never gates (§14)
    scope: 'files',                    // files | document | pages | page | selection (display only)
    icon: null,                        // default: the command's icon
  },
];
export const SHARED_ALIASES = [/* [alias, [toolId, toolId]] allowed collisions */];
```

**Invariants (tested, `tests/catalog/`):** a record has exactly these fields (no `requires`, `presentIf`,
`preset` or run parameters); every `command` and `variants[].command` exists, has a label and is in the
palette; the first variant is the tool's command; **a command backs one tool at most**, so a command
maps back to its tool exactly (recording Recent, joining aliases). There is no `related` field until a
screen renders one. Tool ids are not Batch/Flow step ids (§29 Q13).

### 17.3 What does not go in the catalog

| Data | Stays in |
|---|---|
| Keys, the shortcut hint, the palette label | `commands.js` |
| How to run, what "selected pages" means | commands and actions |
| What a command needs (`doc`, `requires`, `presentIf`) | `commands.js` |
| How to evaluate a requirement, reason wording | `requirements.js` (reusing feature-owned text) |
| Recommendation rules | `catalog/recommend.js` |
| Recent / favorites | `catalog/store.js` |
| Visual layout, icons' rendering, motion | `ui/tools.js`, `app.css` |

## 18. Availability / context model

### 18.1 Availability belongs to commands; relevance to tools

Commands are what run, so commands say what they need, next to the `doc` flag they always had. Every
surface (the More menu, the palette, Tools, later the context menus) gets the same answer from one
evaluator, and none of them needs to know a feature's conditions.

- **`doc: true`** (unchanged): needs an open, ready document. The evaluator reads it as `document`,
  always tested first.
- **`requires: [names]`**: can't run *right now* without these. Shown with a reason (§7.4).
- **`presentIf: name`**: the provider isn't on this PC at all (an Office engine, a signing engine, a
  local AI model). The command is **hidden everywhere**, the palette included, per Vision §3.9: "with
  no provider, AI entry points simply don't appear". Presence names are their own small namespace
  (`engine.office.word` / `.excel` / `.powerpoint`, `engine.signing`, `engine.encryption`, `ai.local`),
  each resolved by the feature that owns the provider and read synchronously from the snapshot. The Office
  names are the only ones in use: `office/actions.js` reads them once from the host's `office.providers`.
- **`fits`** (on the tool, not the command): what on screen the tool *suits*. Relevance only: it feeds
  the selection strip and recommendations (§11, §14) and never gates anything.

### 18.2 Requirement vocabulary (V1)

| Name | Met when | Reason when unmet |
|---|---|---|
| `document` | `app.active?.status === 'ready'` | "Open a PDF first." |
| `writable` | `view.canEditPages` (ready and not encrypted) | "This PDF is protected (encrypted), so Vellum can’t rewrite it." (the compress/save wording) |
| `textEditing` | `!view.textEditing.unavailableReason` | that reason, verbatim |
| `history` | `actions.history.canUse(view)` | "This is a snapshot. Its history is in the document it was taken from." (History's own wording) |
| `formFields` | `view.hasFormFields`: a fillable, editable field of the PDF's own | "This PDF has no form fields." (`forms/fields.js` `NO_FORM_FIELDS`, also what `forms.fill` says) |
| `selection.text` | `view.getSelectedText()` is not empty | "Select text on the page first." |
| `selection.objects` | Edit mode and `objectSelection.size > 0` | "Select text or pictures in Edit mode first." |
| `selection.picture` | Edit mode and `textEditor.pictureSelected` (exactly one replaceable picture) | "Select a picture in Edit mode first." |

`web/js/requirements.js` exports `REQUIREMENTS` (name → `{ met(snap), reason }`), `snapshot(app, ui,
actions)`, which returns plain values read from existing getters (synchronous, microseconds, never
reading pages or the file), and `availability(command, snap)` → `{ present, available, reason, unmet }`,
where `unmet` names the first requirement that isn't met. Requirement names are flat and ANDed; when a
condition needs logic, the feature exports one predicate and the vocabulary gains one name. Anything that
must read the document stays the action's own refusal. The async signals (§11.2) are recommendation
inputs, not requirements.

### 18.3 One evaluator for every surface

Done in Phase 1A: the More menu's hand-written `disabled:` expressions (`ready`, `canEditPages`,
`encrypted`, `history.canUse`) now call `availability()`, with the same results in every state (a Node
test compares the two), and the palette leaves out commands through the same evaluator (not present,
or needing a document when none is open; as before, it doesn't hide unmet `requires`). Nothing needs a
separate agreement test.

### 18.4 Tools work from any state

A tool runs from Home, from Select mode, from a find bar that's open, and so on. A command that assumes
a mode must either **enter it** (e.g. switch to Edit mode) or **refuse with its reason**. It must never
do nothing without saying why. Before Tools can run them (Phase 2), audit `edit.addText`,
`edit.insertPicture`, `edit.addSignature`, `edit.redactSelection`, `edit.replacePicture` and
`forms.add*`. (Phase 1A gave the selection commands requirements with reasons; `forms.fill` enters Select
mode itself.)

## 19. Material / translucency integration

### 19.1 What exists (verified 2026-09-23)

| Control / token | Where | Effect |
|---|---|---|
| **Reduce transparency** (Settings → Appearance) | `themes.js` `setReducedTransparency`, `data-glass="off"` | `--glass` and `--glass-float` become `--surface`, `--blur: none`, dialog scrim blur off |
| **Reduce motion** (Settings → Appearance) | `themes.js` `setReducedMotion`, `data-motion="reduced"` | Every transition and animation duration becomes 0; `prefers-reduced-motion` does the same |
| Glass / floating glass / clay / paper | `app.css` derived tokens | §3 table |
| Light / Dark / System, 7 themes, custom accent | `themes.js` | All tokens derive from 9 seeds |

**Not present:** Material Intensity, a Glass Effect slider, High Performance Mode. They appear only in
the reference image. **Don't add them for Tools.** Reduce transparency is the "less glass, faster"
switch, and Reduce motion is the "no animation" switch. The owner confirmed these two stay the only
comfort controls (§29 Q10): two honest switches beat a vague slider.

### 19.2 The Tools sheet's recipe (existing tokens only)

| Element | Material | Tokens |
|---|---|---|
| Scrim | Plain scrim, **no blur** (as the palette's) | `color-mix(in srgb, var(--scrim) 70%, transparent)` |
| Sheet | Floating glass | `--glass-float`, `backdrop-filter: var(--blur)`, `--float-shadow`, radius `--r-panel` |
| Rail | Transparent on the sheet; a hairline on its right edge | `--hairline` |
| Rail item, selected | Selection triad | `--accent-soft` fill, `--accent-line` border, `--accent-ink` text |
| Category tile | Glass card on glass: a flat `--surface-hi` wash, 16 px radius, `--glass-shadow` | no new token |
| Icon well | Neutral clay | `--clay`, `--clay-shadow`, 10 px radius; glyph `--accent-ink` on tiles, `--ink-2` in rows |
| Recommendation card | Surface with a tint wash | `color-mix(in oklab, var(--tint) 35%, var(--surface))`, `--hairline` |
| Favourite star, on | Warm secondary | `--accent-2` |
| Primary buttons (Open a PDF) | Clay accent | `--clay-accent`, `--accent-shadow`, `--on-accent` |
| Section headings | Text | 11 px, uppercase, `letter-spacing: .08em`, `--ink-3` (the palette group style) |
| Category title | Display | Jost (`--font-display`) 22 px |

With **Reduce transparency**, the sheet becomes solid `--surface` automatically through the token.
Depth still comes from the hairline and `--float-shadow`, so it looks intentional rather than broken.
No extra rules are needed beyond what the tokens already do.

**Performance note:** the sheet is the largest `backdrop-filter` surface Vellum would have, and it sits
over the PDF canvas, which the palette and dialogs already do. It is allowed because the surface is
temporary (DESIGN_SYSTEM: blur only on floating or temporary surfaces). Phase 2 measures frame time on a
large document. If it's over budget, the sheet uses a 94% opaque `--glass-float` with `--blur` reduced
for this component only, recorded in DESIGN_SYSTEM.md first.

**Measured in Phase 2** (e2e `tools`, a 200-page document still repainting after a zoom, 1280 × 840 at
DPR 1): frame intervals while opening, changing category, typing and closing are the same with the blur
on and off (p95 10 ms on a 5 ms display refresh; no long animation frame caused by the sheet), so the blur
stays. Contrast, not performance, made the one change: in dark mode the sheet is 94 % opaque (§21).

### 19.3 Possible design-system additions (documented first, only if Phase 2 needs them)

- `--r-card: 16px` and `--r-well: 10px`, if the values repeat in several places (today they're literals).
- A `@media (forced-colors: active)` block for Tools (and ideally the palette and menus): borders on
  selected and focused items, `CanvasText` separators. Vellum has **no** forced-colors rules today (§22).

No new colours, materials or shadows.

## 20. Motion / transition integration

All durations come from existing tokens: `--fast` 150 ms, `--med` 220 ms, `--ease-out`. They are
animated with `transform` and `opacity` only.

| Moment | Motion |
|---|---|
| Open | Scrim `fade-in` (`--fast`); sheet `pop-in` (translateY 4 px, scale .97 → 1), `--med`, `--ease-out` |
| Close | Opacity to 0 over `--fast`, then removed (the palette removes at 200 ms; reuse that) |
| Rail selection | The selected pill **slides** (transform) to the new item, `--med` `--ease-out`. Knob-like, but not the spring (springs are only for knobs and the Open "+") |
| Category change | Outgoing content fades out (`--fast`); incoming uses `rise-in` shortened to 6 px, `--fast`. The rail doesn't move |
| Landing ↔ results | A single cross-fade the first time the query becomes non-empty, and back when it's cleared. **No animation per keystroke.** Rows appear instantly |
| Hover / press | Background `--hover` / `--press`, `--fast` |
| Recommendations arriving (async) | Their space is reserved, and they fade in with `--fast` opacity only. Nothing below moves |
| Star toggle | Fill change plus a 1.08 scale pulse (like `value-pulse`), `--fast`, once |

**Never:** bouncing, parallax, staggered cascades longer than `--med` in total, looping motion, animated
shadows, blur transitions, or anything that delays focus. Focus lands in the search field in the same
frame the sheet is inserted.

**Reduced motion:** the global rules already set every duration to 0. The code must **not wait for
`transitionend`**. It uses the same fixed timeouts as the palette, so nothing hangs when there's no
transition.

## 21. Light / Dark / System requirements

- Every colour comes from a token. The Obsidian dark variant is derived automatically; the rules below
  are the checks.
- **Contrast:** descriptions and reasons use `--ink-3` (at least 4.5:1 on surfaces by construction,
  as the comment in `app.css` says). Never `--ink-4` for text a user needs to read. *Measured in Phase 2:*
  over a white page (pages stay white in dark mode), `--glass-float`'s 86 % left them at 4.37–4.47:1 in
  Mist and Graphite dark, so in dark mode the sheet is 94 % opaque (DESIGN_SYSTEM.md, Materials): 4.56 to
  5.19:1, and more over the app's background.
- **Selection in dark mode:** `--accent-soft` alone can be too faint on smoked glass, so selected
  rail items also carry `--accent-line`. Focus always shows the 2 px `--accent-ink` outline.
- **Clay wells in dark mode:** `--clay` over `--glass-float` must stay distinguishable. The check is at
  least 1.3:1 luminance difference between well and sheet in every theme's dark variant, or the well
  gains its `--hairline` ring (already part of `--clay-shadow`).
- **Tint wash** on recommendation cards: ink on the wash must stay at least 4.5:1 in all 7 themes ×
  2 modes.
- **System mode:** Tools reads only tokens, so switching Windows' mode while the sheet is open
  re-colours it live with no code.
- **Custom accent:** hover, selection and focus follow it automatically. Test with a very light and a
  very dark accent.

## 22. Accessibility requirements

**Structure and semantics**

- The sheet: `role="dialog"`, `aria-modal="true"`, `aria-labelledby` the visually hidden heading
  "Tools". The rest of the app is `inert` while it's open. It sets `data-own-keys` so that global
  shortcuts (`installShortcuts`) don't fire behind it; Tools handles Esc and Ctrl+Shift+A itself.
- The rail: `role="tablist"`, `aria-orientation="vertical"`; the content is `role="tabpanel"`.
- Search: `type="search"`, labelled "Search tools". While there are results, it is a **combobox**
  driving a `listbox` with `aria-activedescendant`, the same pattern as the palette. Focus stays in the
  field and ↑/↓ move the active result.
- Tool rows in category views: a `role="list"` of rows. Each row has a main button (the tool), optional
  variant buttons, and a star button (`aria-pressed`, labelled "Add Merge PDFs to favorites").
- Unavailable rows: `aria-disabled="true"`, with the reason linked by `aria-describedby`.
- Shortcuts: shown as `kbd`, also exposed with `aria-keyshortcuts` on the main button.

**Keyboard**

| Where | Keys |
|---|---|
| Anywhere in the sheet | Esc: clears the search if it isn't empty, otherwise closes. Ctrl+Shift+A: closes. Printable characters outside the field go to the search field |
| Search field | ↓/↑: move through results. Enter: runs the active (or top) result. Tab: to the rail |
| Rail | ↑/↓/Home/End: move and activate (automatic activation; content is cheap). Tab: to the content |
| Content | ↑/↓/Home/End: roving focus across rows. →/←: between a row's buttons (tool, variants, star). Enter/Space: activate |

**Focus order:** search → rail → content (recommendations → selection strip → recent → tiles/rows).
**Focus restoration:** on close, `restoreFocus(previous)` (from `ui/focus.js`), whose fallback is the
active document.

**Screen readers:** a polite live region announces the result count, debounced by 300 ms ("7 tools
match “page”"; "No tools match “password”"). Recommendations are announced once when they arrive, only
if the sheet is still open, and never repeatedly.

**Reduced motion / transparency:** §19–20. **Contrast:** §21.
**Forced colors:** Tools adds a `@media (forced-colors: active)` block: selected and focused items get a
`Highlight` border, and separators use `CanvasText`. It must never rely on a background tint alone.
**Tooltips:** rows have visible text, so no tooltips. The icon-only title-bar button uses
`commandTitle()` (label + shortcut), as its neighbours do.
**Target sizes:** rows 52 px, star and variant buttons at least 28 × 28 px.

## 23. Performance requirements

| Budget | Target | How |
|---|---|---|
| App startup cost | No catalog or search code | `catalog/*` and `ui/tools.js` are never imported at startup (a Node test checks `app.js`'s imports). The palette imports `catalog/search.js` and `catalog/catalog.js` on its **first open**: the field is focused at once, and results render as soon as they load (an Enter typed before then runs the top result). Startup gains only `requirements.js`, a few hundred bytes the More menu and palette already need. The Home row (Phase 3) loads the catalog after the first paint |
| First open → first paint | ≤ 50 ms (warm), ≤ 120 ms (first open, including import) | About 50 rows, plain DOM via `h()`, no virtualization |
| Keystroke → results painted | ≤ 8 ms | Pre-normalised token arrays; a linear scan; render in `requestAnimationFrame` |
| Context snapshot | ≤ 1 ms | Existing getters only |
| Async signals | Never block; ≤ 1 page text read, cached | §11.2 |
| Large documents | No cost that grows with page count | No page iteration; the scope hints read the current selection only |
| Idle cost when closed | 0 | No listeners beyond the title-bar button. Recent/favorites are written only on use |
| WPF / WebView2 boundary | No new bridge calls | Tools is entirely web-side. Commands keep their own host calls |

## 24. Testing requirements

### 24.1 Node (no app): `node --test "tests/catalog/*.test.mjs"`

The catalog modules are pure, so these run like `tests/editing`.

| Test | Asserts |
|---|---|
| Registry integrity | Unique task-slug ids; every `command` and `variants[].command` exists, has a label and is in the palette; **a command backs one tool at most**; records carry only the discovery fields; every `category` and `section` exists; every non-reserved category has 2–14 tools; every tool has ≥ 3 aliases, a blurb of ≤ 80 characters, and a sentence-case name with no arrow |
| Commands | The registry builds with `createCommands({}, {}, {})`; every `requires` name is in the vocabulary; the five `export.*` commands open Export on their format; `forms.fill` requires `formFields` and only finds a field; Attachments… goes through `actions.attachments` |
| Layering | `commands.js` and `requirements.js` load no `ui/*` module and no `bridge.js`, however indirectly; `catalog/*` imports nothing outside `catalog/` and touches no DOM, storage or bridge; the palette imports the catalog only dynamically; startup (`app.js`) never imports it |
| Category integrity | Stable category order; `automate` reserved and hidden while it has no tools; no tool in two categories; sections contiguous |
| Aliases | Written plainly; no collisions outside `SHARED_ALIASES`; no alias, name or blurb from the forbidden list (features that don't exist); no alias reads the same as another command's label |
| Search golden table | Every row of §9.6: top result, plus "top 3 contains" for *extract*; the order rule ("pictures to pdf" vs "pdf to pictures"); optional direction words and numbers; each band; stop words |
| Ranking determinism | The same input gives the same order; context never moves a result across a band or above a better text score |
| Palette | Typing any command's whole label puts it first; the phrases the e2e suites type still find their command; aliases find intents ("combine" → *Merge PDFs…*) |
| Availability | Fixture states (none, opening, ready, protected, a snapshot, a form, Edit-mode selections) give the expected `{ present, available, reason, unmet }` per command; presence hides; an unknown name is an error |
| More menu | In every fixture state, the evaluator gives the same answers as the hand-written checks it replaced |
| Recommendations *(Phase 4)* | Signal fixtures produce ≤ 3 distinct available tools in priority order; none when there are no signals |
| Store *(Phase 3)* | Round trip; unknown ids dropped; broken JSON is treated as empty; the key is `vellum.catalog` and never touches `vellum.tools` |

`commands.js` used to import `ui/attachments.js` (and through it `bridge.js`), so it couldn't load in
Node. Phase 1A moved that call behind `actions.attachments.show(view)`, as every other feature is
reached; the layering test keeps it that way. No test stubs `window` to hide an import.

### 24.2 End to end: one suite, `tests/e2e/suites/tools.mjs`

It drives the real Debug build **without running any tool that opens a native dialog**. Before each
activation, the suite wraps the target command's `run` in the page with a spy (from the `stubOpenDialog`
pattern in `suites/merge.mjs`), so it checks *routing*, not the workflow. The workflows have their own
suites.

| Case | Checks |
|---|---|
| Open / close | Ctrl+Shift+A and the title-bar button open it; focus is in search; Esc closes; focus goes back to the previous element; Ctrl+Shift+A toggles |
| Search → run | Type "combine", Enter: `pages.merge` spy called once, sheet closed |
| Keyboard | ↓/↑ in results; Tab order search → rail → content; roving focus in rows; → reaches the star |
| Unavailable | Encrypted fixture: "Compress PDF" row has `aria-disabled` and the reason; Enter doesn't call the spy |
| No document | The landing shows the no-doc tools; doc-only tools grouped under "Open a PDF to use these" |
| Recommendations | A fixture with form fields shows "Fill in form"/"Add signature" with the count; "Not now" hides it for that document |
| Recent / favorites | Running a tool puts it in Recent; starring shows it in Favorites; both survive a reload; `vellum.tools` is unchanged |
| Reduced motion | With `data-motion="reduced"`, the sheet's computed `animation-duration` is `0s` and opening still completes |
| Reduce transparency | With `data-glass="off"`, the sheet's computed `backdrop-filter` is `none` and its background is the surface colour |
| Dark | Description text contrast ≥ 4.5:1 in Mist dark and Graphite dark (computed colours) |

Screenshots for visual review: the landing (doc / no doc), a category, results and the empty state, in
Mist light and Mist dark, plus reduced transparency. They're saved to the run folder and are not
assertions.

## 25. Test safety / failure containment

**A permanent Vellum development rule**, recorded here and copied into the Testing section of
`ARCHITECTURE_GUIDELINES.md` in Phase 1A. Quality is never traded away, and testing is never allowed
to loop, hang, or burn time.

1. Every operation that can block has a hard timeout: process start, DevTools connect, `waitFor`,
   window discovery, file I/O waits, and the whole suite.
2. No unbounded retry, polling, wait, process-wait, dialog-wait or window-discovery loop, ever.
3. Retries are bounded: **at most 1**, and only where a documented flake exists (see the e2e batch-flake
   notes).
4. If a test stops making progress, stop.
5. Don't re-run a failing test hoping it passes.
6. Don't start a second copy of a test because the first looks stuck.
7. Never wait indefinitely for a native dialog, window, process, WebView, browser, PowerShell script or
   file operation.
8. **On timeout:** terminate the test process **and its process tree** (`taskkill /PID … /T /F`, as
   `run.mjs` already does), capture compact diagnostics (last step, `__vellum.errors`, one screenshot if
   possible), report, and stop.
9. Prefer deterministic seams and stubs (the bridge stub for `openDialog` / `pictureDialog`, command
   spies) over GUI automation whenever the GUI isn't what's under test.
10. Native Windows dialogs are fail-fast infrastructure: a test that could open one must stub it or not
    run.
11. Never ask the user to click a dialog to unblock a test.
12. Never continue exploratory debugging automatically after a timeout.
13. No speculative multi-fix attempts: after one failed automated attempt, analyse before trying again.
14. If the test infrastructure itself is broken, report **TEST INFRASTRUCTURE BLOCKED** and stop.
15. Keep output compact: pass/fail lines, and details only for failures (`run.mjs` already trims to
    800 characters).
16. Run targeted suites (`node tests/e2e/run.mjs tools`), not the full regression, unless a release asks
    for it.
17. No synchronous blocking call (`spawnSync`, `execSync`) without a `timeout` and `killSignal`: a
    blocked event loop can't be interrupted by any deadline.

**Gaps found in the runner, fixed in Phase 1A:** `tools/cdp-client.mjs` `send()` never rejected (no
per-request timeout, no close handler), so `waitFor` was bounded only *between* evaluations, and
`connect()`'s `fetch` and WebSocket open had no limit; `tests/e2e/run.mjs` had **no suite-level
timeout**; and several synchronous child processes (`dotnet build`, `taskkill`, the Save-dialog helper
in `history-move`, four in `updates`) had no `timeout`, which no `Promise.race` can interrupt. Now:

- every DevTools request has a limit (60 s by default; `suite.requestTimeoutMs`, or one call's own
  `{ timeoutMs }`, for work that is meant to be long), and every pending request fails at once when the
  connection closes or errors, with a one-line message naming it;
- each suite has a deadline: 300 s by default (the slowest default suite, `manipulation`, took 136–164 s
  in earlier runs) or its own `timeoutMs` (the OCR suites, `performance` and `updates` export longer
  ones; the Tools suite will export 120 000 ms). Past it, the suite is reported with one line (its
  limit, the area it was in, the page's last five errors read with a 5 s limit), the late work of the
  timed-out suite is neither printed nor reported, and the existing `finally` stops the process tree.
  The timer is cleared on normal completion; `prepare` and `cleanup` are bounded too;
- every `spawnSync` the runner and those suites start has a `timeout` and `SIGKILL`;
- `selftest-timeout`, run only when named, never finishes on purpose and must be stopped at its
  deadline (and a never-answered request must fail at its own limit): proof the guardrail works.

## 26. Existing UI surfaces to preserve

These don't change as part of Tools, apart from the explicit, owner-approved steps in §27:

- The toolbar: the six-mode segmented control with its sliding knob, the colour button, undo/redo,
  save, search, page colours, print, More. Their shortcuts (V H U N D E, Ctrl+S/F/P…).
- The view bar, the find bar (replace, redact all), and the contextual bars (selection, annotation,
  page, format, arrange, Replace picture).
- The document context menu and both thumbnails menus: their items and sections. Phase 5 only moves them
  onto commands, with the same labels, order and behaviour.
- The command palette (Ctrl+K): all commands, recent files, grouping, and exact label hits (typing a
  whole label puts that command first, now a tested invariant). Phase 1A only moved its ranking onto the
  shared engine, added tool aliases and fixed `GROUP_ORDER`.
- Home: greeting, Open card, recent covers, collections with their Research/Graph actions, saved
  research, and the orb illustration.
- The sidebar tabs (Pages, Outline, Structure) and Research inside Structure.
- Settings sections and the two comfort toggles.
- Every existing workflow dialog (Export, Merge, Split, Crop, Page numbers, Watermark, Compare, Health,
  History, Attachments, Signature, OCR progress).

## 27. Migration strategy

Small phases, each tested and reported before the next (Vision §8). The existing surfaces keep working
at every step.

| Phase | Delivers | Visible change | Tests |
|---|---|---|---|
| **0** | This spec | none | – |
| **1A: Foundation** *(done)* | `catalog/catalog.js` (49 tools), `catalog/search.js`; `requirements.js` with `requires` on commands and the More menu on it; `actions.attachments.show`; five `export.*` commands over `actions.export.run(view, { format })`; `forms.fill`; the palette on the shared engine, loaded lazily, with aliases and the `GROUP_ORDER` fix; CDP request timeouts, suite deadlines, bounded child processes, `selftest-timeout`; the test-safety rule in ARCHITECTURE_GUIDELINES | The palette finds intents ("combine" → Merge PDFs…) and has "Export to Word…" and the like, and "Fill in form"; nothing else changes | Node catalog suite (§24.1); e2e `accessibility` and `regression` |
| **2: The Tools sheet** | The §18.4 mode audit; `ui/tools.js`, CSS section, title-bar button, Ctrl+Shift+A (after the WebView2 check), `app.tools` command, More → "All tools…" first; the mode control's accessible name becomes "Modes" (Q12); landing, categories, results, empty state, unavailable reasons, keyboard and screen-reader semantics; `window.__vellum.commands` for the suite's spies | Tools exists | e2e `tools` suite (`timeoutMs` 120 000); frame-time check of the sheet's blur on a large document |
| **3: Recent, favorites, Home row** | `store.js` wired; the Home quick-tools row | Home gains one row | Node store tests; e2e recent/favorites; e2e Home row |
| **4: Recommendations and the selection strip** | `recommend.js`, async signals, "For your selection" | Up to 3 quiet suggestions | Node recommend tests; e2e fixtures with form fields and a scanned page |
| **5: Consolidation** *(owner decision per item)* | Context menu and thumbnails menus call commands (needs the deferred argument channel, Q4: `run(e, args)`, never `run(args)`); the More menu only if the owner revisits Q5; command label casing unified | Menus look the same | Existing suites stay green; menu snapshot tests |
| **6+** | Each new feature arrives with its catalog entry (§28) | The feature appears in Tools | Its golden queries join §9.6 |

## 28. Future feature integration rules

**A new feature is added to Tools by:** (1) its command(s) in `commands.js`, declaring what they need
(`doc`, `requires`, `presentIf`); (2) one catalog record: a task-slug id, category, section, blurb, ≥ 3
truthful aliases, `fits` if a selection makes it relevant, `scope`; (3) at least one golden search
query in the Node suite; (4) its FEATURE_REGISTRY row. Nothing else changes: no UI file names the tool.
The Gate column below is always on the command.

| Future capability | Category / section | Gate (on the command) | Notes |
|---|---|---|---|
| Office → PDF (Word, Excel, PowerPoint) — **built** | Convert / To PDF | `presentIf: 'engine.office.word'` (`.excel`, `.powerpoint`) | One tool per source format (`word-to-pdf`, `excel-to-pdf`, `powerpoint-to-pdf`; commands `office.wordToPdf`…), sharing the alias *office to pdf*. The host's `office.providers` decides presence (ARCHITECTURE_GUIDELINES.md, *Office conversion providers*): present when an installed provider can convert the format; a provider that is only busy (PowerPoint open) leaves the tool shown, and running it says why before any dialog. With no provider, the tool isn't shown at all. Not on Home by default and not in the More menu (§29 Q5); Home shows them once run, as any tool |
| Additional conversion providers | Convert | provider presence | Providers never add their own tools: the *format* is the tool, and the provider is chosen inside the workflow |
| PDF → JPG/PNG as a standalone (no Export dialog) | Convert | – | Stays *PDF to images*; don't add a second tool |
| Repair | Optimize | `document` | Joins the *Large/problematic* recommendation rule when it exists |
| Passwords, permissions, metadata cleaning | Protect (new section "Security", and a "Privacy" section for metadata) | `writable`; password tools need the correct password | Protect grows from 2 to about 6, still within limits |
| Digital (certificate) signatures | Fill & Sign / new section "Digital signatures" | `presentIf: 'engine.signing'` | Picture signatures and certificate signatures stay separate tools, with names that say which |
| Batch processing V1 — **built** | **Automate** appears | the Office one: `presentIf: 'engine.office'` | One tool per operation (`batch-compress` → `batch.compress` → operation `pdf.compress`; `batch-office-to-pdf` → `batch.officeToPdf` → operation `office.toPdf`), sharing the alias *batch processing*. The dialog runs **operations** from `operations/registry.js` (stable ids, serialisable parameters, no UI), never tools or commands (ARCHITECTURE_GUIDELINES.md, *Operations, batch processing and workflows*). No `batch: true` flag on tools. A Batch Center listing every operation, with task history, is still planned |
| Vellum Flow (workflows) — **built** (V1) | Automate | – | One tool, `workflows` → `flow.open` (aliases *vellum flow*, *automation*, *pipeline*…; not "Flow" as a category name). A workflow step is an **operation id** plus its parameters, never a tool id or a command (§29 Q13); a saved workflow never becomes a tool or a command of its own. It composes the operations batch processing runs (`operations/registry.js`) and runs on many files *as* a batch (ARCHITECTURE_GUIDELINES.md, *Operations, batch processing and workflows*). The steps a person can add are the operations, filtered by what can follow and by this PC (`presentIf`), never the Tools catalog |
| Local AI (summaries, Q&A) | Research | `presentIf: 'ai.local'` | No AI tool appears without a real `AIProvider`. Aliases are allowed to say "ai" only once one exists |
| Structured extraction | Research (reading), Convert (file output) | per output | The same boundary rule: file format changes → Convert |
| Translation | Convert (the output is a new document) | `presentIf: 'ai.local'` or an engine | Not "Research" |
| Document intelligence | Research | `presentIf` | As AI |
| Full-screen reading, starred documents, templates | not Tools | – | Reading, Home and workspace |

## 29. Owner decisions (2026-09-23)

The questions this spec raised, as the owner answered them after the architecture review:

1. **Category names:** keep all eight (Edit, Review, Organize, Convert, Fill & Sign, Protect, Optimize,
   Research; Automate reserved and hidden). The Vision's pillar names stay separate (§5.3). Tool ids
   don't contain categories, so a later rename is a data edit.
2. **Form:** the modal **sheet** (§6.1).
3. **Shortcut:** **Ctrl+T is not used.** Ctrl+Shift+A is the proposed Tools shortcut, pending one check
   before Phase 2 that WebView2 doesn't reserve it. It is free in `commands.js`. *Checked in Phase 2:*
   WebView2's browser keys are off (`AreBrowserAcceleratorKeysEnabled = false`, `MainWindow.xaml.cs`) and
   the window binds no keys of its own, so Ctrl+Shift+A reaches the page. It is the Tools shortcut.
4. **Commands with arguments:** **deferred.** Tools needs none (each variant and export format is its
   own command). If the menus are consolidated later, the channel is `run(e, args)`, never
   `run(args)`: the first parameter is already the triggering event.
5. **More menu:** keep its current entries for now. Its availability now comes from the shared
   evaluator (§18.3), with no visible change; Phase 2 adds "All tools…" first.
6. **Export presets:** **five explicit Export commands** (`export.word`, `export.excel`,
   `export.powerpoint`, `export.images`, `export.markdown`), each calling
   `actions.export.run(view, { format })`, which opens the one Export dialog on that format. No preset
   in the catalog. Done in Phase 1A.
7. **Fill in form:** add `forms.fill` (requires `formFields`; scrolls to and focuses the first empty
   field; changes nothing). Done in Phase 1A.
8. **Collections:** stay Home-only for 1.0.
9. **Scanned-page signal:** deferred to Phase 4, with the conditions in the review (§14 there): async
   after first paint, current page only, cached, skipped for encrypted documents and on Home.
10. **Comfort controls:** only Reduce transparency and Reduce motion. No Material Intensity, Glass
    Effect or High Performance Mode.
11. **Palette groups:** don't regroup the palette by Tools category. The missing `GROUP_ORDER` entries
    were fixed in Phase 1A.
12. **Naming collision:** rename the toolbar mode control's accessible name to "Modes" in Phase 2, when
    Tools becomes visible.
13. **Operations vs commands:** future automation (Batch, Flow) uses **operation ids** from an operation
    registry over the pure cores, not Tool ids and not commands. The registry came with batch processing:
    `operations/registry.js`, specified in ARCHITECTURE_GUIDELINES.md, *Operations, batch processing and workflows*.
14. **Favorites storage:** localStorage `vellum.catalog`, not `vellum.tools` (annotation colours).

## 30. Recommended implementation phases

1. **Phase 1A: foundation** (no new UI; done). Catalog data for the 49 command-backed tools (the 48
   that had commands, plus Fill in form); the shared search; `requirements.js` and requirements on
   commands, with the More menu on the evaluator; `actions.attachments.show`; the five export commands
   and `forms.fill`; the palette on the shared engine, lazily, with aliases; CDP request timeouts, suite
   deadlines, bounded child processes and `selftest-timeout`; the test-safety rule in
   ARCHITECTURE_GUIDELINES.md. *Exit:* Node suite green (golden queries and the palette invariant
   included), e2e `regression` and `accessibility` green.
2. **Phase 2: the Tools sheet** (done). First the WebView2 check for Ctrl+Shift+A and the §18.4 mode audit.
   Title-bar entry, Ctrl+Shift+A, "Modes" as the mode control's name, landing, categories, results,
   empty and unavailable states, full keyboard and screen-reader model, reduced transparency and reduced
   motion, dark mode. *Exit:* e2e `tools` suite green; blur frame-time measured; screenshots reviewed in
   light, dark and reduced transparency (and forced colours and 560 × 400).
3. **Phase 3: recent, favorites, and the Home row** (done). Recent and Favorites inside the sheet arrived
   with Phase 2; Phase 3 made `catalog/store.js` the one store for Tools, Home and the palette (loaded after
   the first paint, from `app.js`), added the Home row (§8; its defaults are `HOME_TOOLS` in the catalog),
   recording from Home and the palette, and the store and e2e tests. *Exit:* Node `store` tests and the
   e2e `tools-home` and `tools` suites green.
4. **Phase 4: recommendations and the selection strip** (the scanned-page signal, Q9).
5. **Phase 5: consolidation**, each item only on the owner's decision (Q4, Q5).
6. **Then:** every new feature arrives with its catalog record (§28). Automate appears with the first
   batch or Flow tool.
