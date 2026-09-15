# Vellum 0.5.0 — object editing: audit, scope and Phase 0 record

Planning document. It records the architecture audit that preceded 0.5.0, the approved scope, and
what Phase 0 actually changed and measured. Kept up to date as each phase lands.

- Baseline: 0.4.0 released (`f0bc670`, tag `v0.4.0`), documentation checkpoint `ae1f36c`.
- Phase 0 (hardening and test infrastructure): done, see "Phase 0 record" below.
- Phase 1 (object model and the unified page writer): done, see "Phase 1 record" below.
- Phase 2 (selection): done, see "Phase 2 record" below.
- Phase 3 (manipulation): done **except same-page multi-select**, and released in **0.4.1** (2026-09-12).
  See "Status after 0.4.1" below.
- Same-page multi-select: done on `main`, not yet released (2026-09-15). See "Multi-select record".
- Survival through page changes, file integrity and refusal messaging: proved (2026-09-15). See "Page
  changes and file integrity record".
- Non-proportional picture resize (stretch): done on `main`, not yet released (2026-09-15). See
  "Picture stretch record". Every must-have is now done.
- Should-haves alignment and distribution: done on `main`, not yet released. See "Alignment and
  distribution record".
- Should-haves snapping, image replacement and image insertion: done on `main`, not yet released. See
  §15, §16 and §17.
- Should-haves paragraph grouping and overlap warnings: done on `main`, not yet released. See §18.
- Should-have single-style paragraph reflow: done on `main`, not yet released. See §19.
- **Every 0.5.0 feature is built.** Not yet done: the one broad regression pass and the release QA
  (end of §19).

Status corrected 2026-09-15: until then this header said "Phase 3 onwards: not started", written before
Phase 3 landed. Sections 2–8 are left as written at the time.

## 1. Approved direction

**Vellum 0.5.0 = object editing.** Move, scale and delete existing text; move, resize, rotate, flip
and delete existing images. Selection with handles, keyboard control and same-page multi-select.
Everything written into real PDF content, in the one undo history, surviving page changes, save and
reload. Anything that can't be done safely says why.

### Scope

**Must have**: hardening of the 0.4 engine; an object model with capabilities; one unified page
writer; selection, oriented bounding boxes, handles, z-aware hit-testing; move / proportional scale
/ delete for text runs; move / resize / rotate 90° / flip / delete for images; keyboard nudging;
same-page multi-select; undo/redo integration; persistence through save and reload; survival through
page reorder, duplicate and rotate; PDF integrity tests; unsupported-object messaging.

**Should have, only if it passes strict tests**: paragraph grouping; alignment; distribution;
snapping; image replacement; image insertion; overlap warnings; single-style paragraph reflow (the
last, gated — it ships only if its tests pass).

**Deferred to 0.6+**: rich-text formatting, font and colour changes, free rotation handles,
cross-page moves, copy/paste, new text boxes, Form XObject editing, vector-shape editing, inline
image replacement, moving annotations and links with content, tag-preserving edits, PDF/A font
embedding, OCR, redaction, forms, signatures, AI, cloud processing.

**Never**: HTML-overlay editing, rasterised editing, guessed glyph mappings, silent font
substitution, modifying embedded font programs, encrypted-PDF or signature or permission bypass,
whole-page reconstruction, flattening forms in order to edit them, unsupported WebView2 switches,
cloud document processing.

### Architecture the later phases build on

```
PageObject   read-only, derived from the ORIGINAL page content
  ref { entry, kind, key } · kind: text-run | text-block | image (later: path, widget, stamp…)
  geometry { quad, box, frame } · order (drawing position, for z) 
  capabilities { select, move, scale, rotate, editText, reflow, replace, delete } = true | reason

ObjectEdit   plain JSON in the existing store, one undo history, keyed by plan-entry id
  { id, kind, entry, target (verified fingerprint), transform?, content? }
```

Planned modules: `editing/objects/registry.js` with `text-run.js`, `text-block.js`, `image.js`
handlers, and `editing/page-writer.js` as the one writer `composeDocument` calls. **Phase 0 did not
create these**; it only recorded the data they will need.

### Invariants (unchanged)

pdf.js reads and renders; pdf-lib writes; `composeDocument` is the only persistence entry point; one
undo/redo history per document; existing text editing, annotations, page organisation, search,
save/reload, rotation, encrypted-PDF restrictions, signed-PDF handling, themes and the design system
all keep working.

## 2. Phase 0 record (hardening and test infrastructure)

Seven commits on `main`, in order:

| Commit | What |
|---|---|
| `59608c2` | Refuse text drawn through a soft mask |
| `6b76683` | Record images, shapes, forms, tags and layers in page analysis (read-only) |
| `c248b8b` | Recognise signed, tagged and PDF/A documents; refuse PDF/A-breaking fallback fonts |
| `3bd50a5` | Confirm before the first change to a digitally signed PDF |
| `0e5589a` | Thumbnails follow every change to an edit record |
| `4fc17be` | End-to-end suites in the repository |
| *(this commit)* | Feature registry and this planning document |

### What each audit finding became

1. **Soft-mask transparency.** The interpreter now tracks ExtGState transparency (fill and stroke
   opacity, blend mode, soft mask) as graphics state. Edited text is redrawn from a clean state,
   where a soft mask would land somewhere else, so text under one is refused with a reason. Opacity
   and blend modes are replayed exactly and stay editable.
2. **Tagged PDFs.** The document profile detects `/MarkInfo /Marked` or a `/StructTreeRoot`, and runs
   record whether they are tagged content (an MCID). The first time tagged text is opened for
   editing, Vellum says it does not update accessibility tags. It never claims they are preserved.
3. **PDF/A.** The profile reads the XMP `pdfaid` claim (element or attribute form). In such a file a
   change that would need a substitute standard font — which is not embedded — is refused with a
   reason, both when planning the edit and again in the writer, so no record can slip through.
4. **Signed PDFs.** Detection keeps the `SignaturesExist` flag and adds signature values found in the
   file. Every change now passes a guard in the edit store: the first change to a signed PDF waits
   for a confirmation that saving invalidates the signature; Cancel drops it. The text editor asks
   when Edit mode is entered; page changes ask before they are made; Extract and Split, which write
   new files, do not ask. A quick byte scan skips parsing for files that surely have no signature,
   and likely ones are checked in idle time so the first change doesn't wait.
5. **Thumbnail invalidation.** `editSignature` hashed only an id and text, so a change that kept the
   text (a move, a different font) would have left a stale thumbnail. It now hashes the whole record.
6. **End-to-end harness.** `node tests/e2e/run.mjs` runs the suites from the repository against the
   real Debug build. It stops if Vellum is open and gives the app a throwaway data folder
   (`VELLUM_DATA_DIR`, Debug builds only), so personal settings and recent files are never touched.
7. **Interpreter object data (read-only).** Every image draw now records its operator index and byte
   range, transformation matrix and unit-square corners, clip, transparency, layer and tag context,
   Form XObject context, and image details (size, colour space, stencil mask, own soft mask).
   Painted paths and shadings record their bounds; form XObjects record where and with what matrix
   they are drawn. **No image or shape editing was added.**
8. **Performance** re-measured in the app (below).

### New during Phase 0

- **Text on a layer (optional content) is now refused.** Edited text is appended outside its layer,
  so it would stay visible when the layer is switched off. This makes some previously editable text
  unavailable, with a plain reason. It is the "never guess" rule applied to layers.
- **Two stray control characters** (a NUL and a SOH) were found inside the old thumbnail-hash line in
  `editing/edits.js`, shipped in 0.4.0. They only ever fed that hash; they are gone. A scan of the
  web code, tests and tools found no others.

## 3. Test results

**Node engine suite** — `node --test "tests/editing/*.test.mjs"`: **62 tests, 60 pass, 2 skipped, 0
fail.** The 2 skipped need personal PDFs (`VELLUM_TEST_PDFS`) and are skipped by design. 13 tests are
new in Phase 0 (`hardening.test.mjs`, `objects.test.mjs`, one unit test).

**End-to-end suites** — `node tests/e2e/run.mjs`, against the real app:

| Suite | Checks | Result |
|---|---|---|
| `text-editor` | 43 | pass (0 click retries) |
| `regression` (annotations 17, search 14, rotation 17) | 48 | pass |
| `editing-store` | 14 | pass |
| `phase0` (new) | 30 | pass |
| `performance` (on request) | 6 | pass |

New fixtures: `transparency`, `objects`, `cropbox` (non-zero crop origin), `cmaps` (embedded
one-byte CMap and a predefined CJK CMap), `tagged`, `pdfa`, `signed`, `signed-noflags`. With the
existing ones the suites now cover: normal text, embedded and subset fonts, Type 3, CMaps, soft-mask
transparency, tagged, PDF/A, signed, encrypted, clipped, invisible, skewed and mirrored text, form
XObjects, images, inline images, optional content, annotations, links, outlines, rotated pages,
non-zero crop-box origins, mixed page sizes and landscape pages.

## 4. Performance

Measured, not tuned. Nothing was optimised in Phase 0.

**In the app** (`performance` suite; a real 173-page, 3.5 MB document, and the generated 200-page
file through `editing-store`):

| Step | 173-page real document | 200-page generated |
|---|---|---|
| Open for editing (pdf-lib) | 17 ms | — |
| Per page: analysis / pdf.js read / cross-check | 4.8 / 6.9 / 1.0 ms | — |
| Slowest single page (analysis) | 15.8 ms | — |
| Runs found editable | 6,795 of 7,555 (90%) | — |
| Compose the document (no edits) | 152 ms | — |
| Rebuild after one edit: compose + swap | 276–290 ms | 245 ms |
| …until the page is drawn again | 415–457 ms | 288 ms |
| Save (compose with clean-up + write) | 264 ms | — |
| Close and reopen until the first page is drawn | 719 ms | — |

**Node baseline** (200 generated pages, no app): analysis 4.2 ms, pdf.js 4.9 ms, cross-check 0.7 ms
per page; compose 296–306 ms; save 304–312 ms; pdf.js reopen plus one page 6–9 ms.

**Against the 0.5.0 targets**: a page's first analysis ≈ 13 ms (target ≤ 100 ms); commit and
re-render 415–457 ms on 173 pages (target ≤ 1.5 s at 200 pages, ≤ 0.5 s at 50); save 264 ms, about
1.06× composing the same document with its edits (target ≤ 1.2×). Live-preview and hit-test targets
belong to later phases, which add the interaction.

## 5. PDF integrity and safety

- Every edit is still checked against the original content when the document is built; a mismatch
  refuses the whole save rather than writing something uncertain.
- Only edited pages are rewritten. The engine tests confirm unrelated pages, page boxes, rotation,
  annotations, links, outlines, form fields, images and metadata are untouched, and that replaced
  text is really gone from the file.
- Encrypted PDFs are still refused for editing; their annotations still live alongside the file.
- Signed PDFs are now confirmed before the first change instead of only being mentioned.
- Tagged and PDF/A files are recognised and handled as described above.

## 6. Remaining and deferred

- **Tag-preserving edits** (keeping the structure tree pointing at changed text): deferred; Vellum
  warns instead.
- **PDF/A with an embedded substitute font**: deferred; such changes are refused.
- **Layers**: keeping edited text on its layer is deferred; such text is refused.
- **Certification signatures** (`/Perms /DocMDP`) are detected but not treated differently from other
  signatures yet.
- The `performance` suite needs a real document supplied by hand (`VELLUM_PERF_PDF`); no personal
  file is stored in the repository.

## 7. Phase 1 record (the object model and the unified page writer)

Four steps, each proved against the one before it. Nothing in the app behaves differently: no UI, no
new edit kind, no change to the edit store, and the same bytes out of `composeDocument`.

| Step | What | How it was proved |
|---|---|---|
| 0 | Characterization tests, taken before anything moved | 25 tests pinning composed content streams, which text is editable and why, object identity and z-order |
| 1 | `editing/apply.js` split into `editing/page-writer.js` (finds edited pages, splices, assembles), `editing/objects/text-run.js` (everything about writing text) and `editing/objects/registry.js` (which handler writes which kind) | all 25 baselines unchanged, old writer versus new |
| 2 | `editing/objects/page-objects.js`: one read-only view of everything drawn on a page — text runs, images, painted paths, form XObjects | identity, drawing order and text editability all pass through from the analysis unchanged |
| 3 | `editing/objects/capabilities.js`: what may be done to an object, verb by verb | `editText` answers exactly what `run.editable` answers, in the same words the editor already shows |

### Decisions worth keeping

- **Identity.** A text object is `run:<run.key>`; everything else is `<kind>:<stream>#<opIndex>`. Where
  an object is drawn cannot name a text run — one `TJ` operator can hold several columns, which read
  as separate runs — and a resource key cannot name anything, since one image is drawn many times and
  an inline image has no key at all.
- **Z-order is a path**, not a number: `[57, 2]` is the 3rd operator inside the form that the page's
  58th operator draws. A bare operator index sorts nested objects as though they were at the front of
  the page.
- **Objects are built on demand**, never inside `analyzePage()` and never while a document is composed.
  A test walks the import graph from `annotations/persist.js` and `editing/page-writer.js` and fails if
  either can reach the object model or capabilities, so the cost cannot drift onto every save.
- **One reason vocabulary.** A capability is `true` or a key of `REASONS` in `editing/runs.js`; there is
  no second table. Phase 1 added exactly one key, `unsupported`, for a verb that has no writer yet.
  Today `true` appears in exactly one cell of the whole model: a text run's `editText`. Refusals name
  the specific reason when there is one — `form`, `layer`, `soft-mask`, and page-wide `structure` or
  `unreadable` — rather than a vaguer one.

### Test results

**Node engine suite** — `node --test "tests/editing/*.test.mjs"`: **113 tests, 111 pass, 2 skipped, 0
fail** (Phase 0 left it at 62). The 2 skipped need personal PDFs (`VELLUM_TEST_PDFS`), by design. 51
tests are new in Phase 1: `phase1-baseline.test.mjs` (25), `page-objects.test.mjs` (15),
`capabilities.test.mjs` (11).

**End-to-end**: not re-run for Steps 2 and 3, deliberately. `page-objects.js` and `capabilities.js`
are referenced only by their own tests — nothing in the running app reaches them yet, so there is
nothing for the app-level suites to observe. They run again when Phase 2 wires selection to the model.

### Remaining Phase 1 work

**Closed: an edit whose kind no handler claims is no longer dropped without a word.**
`editing/page-writer.js` now raises `EditError('unsupported', …, { kind })` for a kind that
`editing/objects/registry.js` doesn't claim, before any page is touched — so nothing partial is
written and a change a person made can never vanish silently. The kind is checked before the plan
entry, so an unknown kind is refused even when no page would have matched it. `handlerFor()` still
returns `null`; the writer, not the registry, decides what an unclaimed kind means. The Phase 1
characterization test that pinned the old silent drop now asserts the refusal instead (same test
count: 113 tests, 111 pass, 2 skipped). Nothing in the app emits such a kind today, so no app-level
behaviour changed and the end-to-end suites are unaffected.

Still open:

1. **`text-block`** is in the object model's planned kinds but not built: only `text-run`, `image`,
   `path` and `form` exist. Paragraph grouping is a "should have" and is gated on its own tests.
2. **No end-to-end coverage of the object model yet**, for the reason given above.

## 8. Phase 2 record (selection)

Selection of existing objects on the page, built on the Phase 1 model. Nothing is moved, scaled,
rotated or deleted: this phase only makes it possible to say *which* object a later phase acts on.

### Where it lives

There is no selection tool, command, toolbar button or mode. Edit mode — the existing "Edit text"
tool, which already owns the pointer, the keyboard and the outlines on a page — is the way in, and
`ui/text-editor.js` gained the interaction. A second layer with its own pointer handling would have
been a separate mode in all but name, and would have needed `decorate()` split into channels to stop
the two fighting over one page overlay; instead the selection outline joins the shapes that module
already draws.

`#focus` (where Tab had got to) is **gone**, replaced by the selection: Edit mode now has one idea of
what is chosen rather than two.

| Module | What |
|---|---|
| `editing/objects/geometry.js` | containment, hit-testing and handle points, in PDF user space. No DOM, no pdf.js. |
| `editing/objects/selection.js` | the selection state, and what may be selected at all. No DOM, no pdf.js. |
| `page-space.js` | the one conversion between a rendered page and PDF user space |
| `editing/session.js` | `objects(n)`, beside `page(n)`, on the same verified analysis |

### Decisions worth keeping

- **A selection is identity and nothing else**: `{ page, key }`, frozen. No quad, box, frame,
  coordinate, analysis or object instance. Geometry is resolved from the current analysis on every
  draw. This is what makes a rebuild safe: afterwards those two fields either find the object again
  or find nothing, and there is no third case where they find something stale. A content rebuild
  re-resolves; a page-plan change clears the selection outright, because a page number and a key
  cannot tell a reordered page from where it used to be.
- **One hit test, in the object's own basis.** A quad is a parallelogram `ll, lr, ur, ul`; with
  `u = lr − ll` and `v = ul − ll`, one 2×2 solve says where a point falls inside it. That is exact
  for turned, mirrored and sheared quads, where an axis-aligned box would accept a wide margin of
  wrong page around a rotated object. Tolerance is real distance, measured perpendicular to the
  opposite edge, not parametric slack.
- **This replaced `runContains()` in the text editor, and corrected it.** The old test projected
  with dot products, which inverts the quad only when the run's `dir` and `up` are at right angles.
  For skewed text they are not (the `constructs` fixture has such a run), and the old test rejected
  points genuinely on the run — its own corners among them. Both behaviours are pinned by tests:
  agreement on every upright run in seven fixtures, and the deliberate disagreement on skewed text
  and on zero-area runs, which can no longer be clicked at all.
- **Z-order decides, size only breaks ties.** Objects arrive in drawing order, so the search runs
  backwards and the topmost wins whatever its size. Objects can tie — one `TJ` operator holding two
  columns gives two runs the same order path — and equal-order objects are adjacent after the sort,
  so the search stops at the first different order and lets the smaller of the tied objects win,
  which is how Edit mode already picked the inner of two nested pieces of text.
- **Only what can be seen and pointed at is selectable**: text runs and images. A painted path or a
  form XObject has no oriented outline, only a bounding box, and hit-testing a diagonal hairline by
  its box would select it across half the page. Content on a switched-off layer is excluded (pdf.js
  does not draw it), and so is the invisible text layer of a scanned page, text used as a clipping
  shape, and white space — all read from the reasons `classify()` already recorded, with no new
  vocabulary.
- **Selectable is not editable.** Text Vellum refuses to change can still be selected, and still
  explains itself when clicked; the capabilities say, verb by verb, what may be done to it.
- **Handle geometry is computed and tested; no handle is drawn.** `handlePoints()` returns the eight
  points in the object's own frame, correct under rotation, mirroring and shear. A handle promises a
  drag and no verb can honour one — move, scale and rotate all still answer `unsupported` — so
  drawing one would be a picture of a feature. A test asserts that nothing outside `geometry.js`
  calls it, and fails when that stops being true.
- **Zoom, rotation, crop and layout need no code of their own.** The outline is drawn through the
  existing page overlay, whose group transform is the page viewport's, so pdf.js places it. The
  end-to-end suite measures the drawn outline against the object's quad and finds it exact (0.0 px)
  at three zoom levels, at all four viewer rotations, on a page the file itself rotates, on a page
  whose crop box does not start at the origin, and across a sidebar toggle.
- **Edit mode still answers the question it was opened for.** Selecting the picture on a scanned page
  is not an answer to "what text can I change here", so a page with no editable text still says so
  after the image is selected.

### Test results

**Node engine suite** — `node --test "tests/editing/*.test.mjs"`: **145 tests, 143 pass, 2 skipped, 0
fail** (Phase 1 left it at 113). The 2 skipped need personal PDFs (`VELLUM_TEST_PDFS`), by design. 32
tests are new: `object-geometry.test.mjs` (16), `selection.test.mjs` (16). `capabilities.test.mjs`
extends its import-graph guard, so the compose path still cannot reach the selection model, object
geometry, `page-space.js` or any UI module.

**End-to-end** — a new `selection` suite (**51 checks, all passing**), in the default set. It drives
Edit mode with the real mouse and keyboard, and includes the geometric checks above.

Z-order is not exercised end to end: no fixture draws two selectable objects over each other, and the
engine suite covers it directly. The fixtures were left alone rather than changed to suit a test.

### A pre-existing flake, confirmed not to be Phase 2's

`text-editor` and `regression` both pass in full on this branch (43/43 and 48/48), but neither passes
every time — and neither does the unchanged baseline. The initial scroll position after several
documents open is not deterministic (`scrollTop` 28 or 197 on the same machine, same build), and when
it lands at 197 the line a suite wants to click is behind the toolbar, so the click misses and the
checks that follow it fail. Measured over three runs each, with the Phase 2 changes stashed and
restored:

| Suite | Baseline | With Phase 2 |
|---|---|---|
| `text-editor` | 43/43, 41/43, 41/43 | 43/43, 3/6, 41/43 |
| `regression` | 32/36, 48/48, 48/48 | 48/48, 29/36, 29/36 |

The failing signatures are identical on both sides, down to the click coordinates. It is left alone,
as the thumbnail timing flake is: a suite that clicks a run without first making sure it is inside
the visible container is the thing to fix, and that is not Phase 2's to change.

### What Phase 2 deliberately did not do

No move, scale, rotate, delete, replace, insert, multi-select, marquee, alignment, snapping or new
text boxes. No change to the PDF writing path. Tab and Shift+Tab keep the itinerary they had — the
editable text — so an image is selected with the mouse and has no keyboard action yet.

**Known limitation**: paths are not selectable, so an image lying under an opaque filled rectangle can
still be clicked through to. Making a path selectable needs a real outline for it, not a bounding box.

## 9. Next (as written after Phase 2)

Phase 3 — manipulation: move, proportional scale and delete for text runs; move, resize, rotate 90°,
flip and delete for images; keyboard nudging; same-page multi-select. Handles get their behaviour,
and the handle geometry above gets its first caller. It begins only on approval.

## 10. Status after 0.4.1

Phase 3 was approved and landed in four commits, then released as **0.4.1** (the version number, not
0.5.0, because 0.5.0 is the whole plan and it isn't finished):

| Commit | What |
|---|---|
| `0f562f5` | Foundation: object transforms (`editing/objects/transform.js`), the image handler (`editing/objects/image.js`), transformable text runs, baseline tests |
| `4f6b456` | Capabilities answer yes where a writer exists; `transformObject()` / `removeObject()` in the session; an arrow-key burst coalesces into one undo step |
| `a4652c3` | The interaction in Edit mode (drag, corner handles, keys) and the `manipulation` end-to-end suite, through save and reopen |
| `99fd902` | Registry and design-system notes |
| `ad0bd40` | Version 0.4.1 |

### Existing in 0.4.x

- **0.4.0**: editing existing text in place, one line at a time, with the hardening of Phase 0.
- **0.4.1**: in Edit mode, select a text run or a picture; move both (drag, or arrow-key nudge by 1 pt,
  10 pt with Shift); scale both uniformly from a corner handle; turn a picture a quarter turn ([ and ])
  and mirror it (Shift+H, Shift+V); delete either (a picture's XObject is released when provably
  unused). One record per object holding its absolute transform, one gesture one undo, written into the
  page by the unified writer, surviving save and reload. Refused with a reason: clipped or degenerate
  pictures, pictures in a form, on a layer or under a soft mask; text is never rotated, mirrored,
  sheared or scaled non-uniformly.

The architectural findings and invariants in sections 1–8 stand unchanged.

### Remaining for 0.5.0

Must have, not built:

- **same-page multi-select** (with its effect on move, scale, delete and undo)

To verify before 0.5.0 is called complete (on the must-have list; this document has no record yet of
tests proving them for moved, scaled, turned or deleted objects): survival through page reorder,
duplicate and rotate; PDF integrity after manipulation; unsupported-object messaging — each also with
multi-select once it exists. Save and reopen are proved by the `manipulation` suite.

Should have, only if each passes strict tests (otherwise deferred, not faked): paragraph grouping
(`text-block`, still unbuilt), alignment, distribution, snapping, image replacement, image insertion,
overlap warnings, single-style paragraph reflow (last, gated).

Also still open from Phase 3's own list: **free (non-proportional) picture resize** — "move / resize"
shipped as proportional scaling only.

Deferred to 0.6+ (unchanged, see §1): rich-text formatting, font and colour changes (font selection,
`docs/VELLUM_VISION.md` §4.3, with the bundled selectable font Liu as one option, §4.4), free rotation handles, cross-page moves, copy/paste, new
text boxes, Form XObject editing, vector-shape editing, inline image replacement, moving annotations and
links with content, tag-preserving edits, PDF/A font embedding, OCR, redaction, forms, signatures, AI
(cloud processing stays out of scope). Deferral here never removes anything from the Vision.

Nothing in this list begins without approval. *(2026-09-15: the owner asked for the remaining 0.5.0
work to go ahead in order — plan, implement, test, review, commit — within this scope and the "Never"
list, stopping only for a real product or architecture decision, a PDF-integrity or security risk, or
a contradiction in the documents.)*

## 11. Multi-select record

Same-page multi-select, the last Phase 3 must-have, built in the Edit mode that exists. No new tool,
mode, command or palette entry, and no change to how any one object is written.

### What a person can do

In Edit mode, Shift- or Ctrl-click adds an object to the selection or takes it out; dragging over bare
paper draws a rectangle that selects what it wholly encloses (with Shift or Ctrl, adds it); Ctrl+A
selects every object on the page. A drag on any selected object moves them all; the corner handles sit
on one frame around the group and scale every object about the same far corner; the arrow keys nudge
them all (a burst is one undo step); [ and ] turn and Shift+H / Shift+V mirror each picture about its
own centre and axes; Delete removes them all. Escape clears the selection; a plain click on one member
selects it alone; Tab walks the editable text from the line chosen last, and Enter opens a line only
when exactly one is selected.

### Where it lives

| Module | What changed |
|---|---|
| `editing/objects/selection.js` | identity is `{ page, keys }`: one page, keys in the order chosen (the last is the *primary*); `set`, `add`, `toggle`, `retain`; `resolve()` returns the objects still there |
| `annotations/model.js` | `applyEdits()`: several records as one undo step; a burst folds **by record id** |
| `editing/session.js` | `transformObjects()` and `removeObjects()`; the one-object methods are one-element calls of these |
| `editing/objects/capabilities.js` | `sharedCapability()`: a verb for a selection only when every object allows it; `refusalMessage()`: one sentence for a refusal, one object or several |
| `editing/objects/geometry.js` | `unionBox()`, `boxQuad()`, `quadWithin()` |
| `ui/text-editor.js` | the interaction: modifier clicks, the rectangle, group drags, the group frame, keys over the selection |

### Decisions worth keeping

- **A selection is still identity and nothing else**, now `{ page, keys }`, frozen. It spans one page
  because a gesture on several objects is one change to one page's content; choosing on another page
  starts over there. The Phase 2 tests follow the new shape; what they pin — no quad, no coordinate, no
  object in the state — is unchanged.
- **All or nothing.** The session finds, asks and plans every object before anything is stored, then
  stores all the records together as one undo step. One refusal, or one object that has gone, changes
  nothing at all. The interaction offers a gesture only when `sharedCapability()` says every object
  allows it, and the engine checks again regardless.
- **One reason vocabulary, still.** A refusal for a selection is the first refusing object's own reason,
  after "Not all of the selected objects can be moved." (or resized, turned, deleted), so it is plain
  that the whole gesture was held back and not just one object.
- **A group scales about the far corner of the box around it**, uniformly: each object gets the same
  `scaleAbout(anchor, f)`, so text stays a move and a uniform scale, which is all text may be.
- **Pictures turn and mirror each about their own centre and axes** when several are selected: a
  selection is several objects, not one shape. A selection with text in it is not turned at all.
- **The rectangle takes what it wholly encloses**, not what it touches, so a large picture behind the
  text being gathered is not swept in with it. It is drawn with what it will take outlined as it goes.
- **A deleted object cannot be acted on.** The analysis is of the original page and still lists what a
  deletion removed; the session now refuses to move or delete such an object (moving a deleted picture
  would have put it back), and the selection drops it after a rebuild.
- **A drag that can't be honoured says why**, once, when the hand moves, instead of silently doing
  nothing. This applies to one object too, and matches what the keys already did.
- **Ctrl+A in Edit mode selects the page's objects**, handled in Edit mode like the other object keys
  (Phase 3's precedent), not as a command.

### Found and fixed on the way

- **Undo could duplicate records or throw after an arrow-key burst** (shipped in 0.4.1). A burst folded
  its steps by position. A nudge that brings a moved object back to where the file has it removes its
  record, and the next nudge in the same burst makes a new record with a new id; folded by position,
  undo then stored the old record under the new id, and undo/redo left two records for one object — a
  document the writer refuses to compose. A burst that made a record and removed it again folded to
  `{ before: null, after: null }`, and undoing that threw. The fold is now by record id, and a burst
  that ends where it began leaves no undo step. Both cases have tests that fail on the old store.
- **Background tabs opened scrolled past the top of page 1**, which was the "pre-existing flake" in
  §8: the regression and text-editor suites clicked lines the stray scroll had put under the tool bar.
  Fixed in the viewer (`cf15398`); both suites also scroll a line into view before clicking it.
- **Parallel engine test files could read a fixture half-written**: every file regenerates the
  fixtures into one folder. Fixtures are now written only when their bytes change (generation is
  deterministic), and then atomically.

### Test results

**Node engine suite** — `node --test "tests/editing/*.test.mjs"`: **284 tests, 282 pass, 2 skipped, 0
fail** (259 before). 25 tests are new in `multi-select.test.mjs`: the selection model, the store's
folding (including the two bugs above), shared capabilities and refusal wording, group geometry, and
the session driving real fixtures through `composeDocument` and re-reading the saved files.

**End-to-end** — a new `multi-select` suite (**56 checks**) in the default set, driven with real
modifier clicks, drags and keys, through save, close and reopen. The whole default set in one batch:
**323 of 323 checks in 7 suites** — text-editor 43, regression 48, editing-store 14, phase0 30,
selection 51, manipulation 81, multi-select 56. (Before this work the same batch gave 251 of 255, the
four failures being the scroll flake fixed in `cf15398`.)

### Remaining for 0.5.0

Must-haves still to prove with tests, each also for several objects: survival of moved, scaled, turned
and deleted objects through page reorder, duplicate and rotate; PDF integrity after manipulation;
unsupported-object messaging. Then the should-haves, each only if its strict tests pass: paragraph
grouping, alignment, distribution, snapping, image replacement, image insertion, overlap warnings,
single-style paragraph reflow (last, gated). Free (non-proportional) picture resize is still open.

The README describes the released app, so it gains multi-select when a release includes it.

## 12. Page changes and file integrity record

The three must-haves §10 said had no proof — survival through the page organiser, PDF integrity after
manipulation, and unsupported-object messaging — are now proved, for one object and for several. No
app code changed: the path (`followEdits` in the edit store, `composeDocument`, the page writer) was
already the one text edits take. What was missing was evidence, and one kind of document to find it on.

### A fixture for the case that could go wrong

`gallery`: three pages, each with a picture and its caption, every page drawing the one image resource
it **inherits from the page tree** — no page has resources of its own. That is the case where deleting
a picture could reach past its page: `releaseResources` must clone what the page inherits before
changing it, and a duplicated page must carry its own copy.

### What is proved

`tests/editing/object-pages.test.mjs` (9 tests), each re-reading the saved file from scratch and
passing one shared integrity check — pdf-lib loads it, pdf.js draws every page without an error, and
every image a page draws by name is in the resources that page really resolves:

| Case | Result |
|---|---|
| Reorder | a moved picture and caption go with their page; the pages around it are byte-identical |
| Duplicate | the copy gets records of its own (new ids); a later deletion on the copy alone leaves the original's picture drawn (draws per page `[1, 0, 1, 1]`); undo puts it back |
| Rotate | the page gains `/Rotate`; the objects stay exactly where they were put, in user space |
| Delete a page | its records go with it; undo brings the page and its records back together |
| A group through copy + move + turn | both copies hold both objects, the text still a move and a uniform scale |
| Inherited resources | deleting page 1's picture empties page 1's own XObjects only (`[[], ['Im1'], ['Im1']]`); pages 2 and 3 still draw it; deleting all three leaves every caption |
| The rest of the file | page boxes, annotations (subtypes and rects), the link, form fields, the outline and the title are identical after moving one line and deleting another |
| Reopened | every manipulated object is found again, selectable, movable, and the moved text still verifies against pdf.js |
| Messaging | on 14 fixtures, every refusal of every verb on every object is a key with a sentence in `REASONS`, for one object and for several; the fixtures reach `clipped`, `form`, `layer`, `soft-mask`, `type3` and `unsupported` |

End to end, a new `page-changes` suite (**17 checks**) does it the way a person does: Shift-click a
picture and its caption, drag them, duplicate the page and turn the copy from the command palette,
move the copy to the front, save, close and reopen — both copies hold both objects where they were put,
and the untouched page is exactly as the file had it.

### Remaining for 0.5.0 (after §12)

- **Must-have: non-proportional picture resize.** "Move / resize" shipped as a uniform scale; edge
  handles that stretch a picture along its own axes are still to build (never offered for text, which
  cannot be written that way). The registry listed it as planned as well; it is now the one open
  must-have there too.
- **Should-haves**, each only if its strict tests pass (otherwise deferred, not faked): paragraph
  grouping, alignment, distribution, snapping, image replacement, image insertion, overlap warnings,
  single-style paragraph reflow (last, gated).

## 13. Picture stretch record (non-proportional resize)

The last open must-have: images were to "move, resize, rotate 90°, flip and delete", and 0.4.1 shipped
"resize" as a uniform scale only. A single selected picture now also has handles on its four edge
midpoints; dragging one stretches the picture along its own width or height, from the opposite edge.

### Decisions worth keeping

- **A verb of its own: `stretch`.** `scale` stays uniform. The two have different answers for text —
  a moved, scaled line is its own glyphs redrawn, but a stretched one would need them laid out again —
  so they are separate verbs rather than one verb with a kind check in the interaction. `stretch` is
  true exactly where `move` is for a picture (one `cm` patch writes any affine transform) and never for
  text. The capability model now answers six verbs; the tests that pin the verb set were updated in
  the same change.
- **In the picture's own axes.** `stretch(basis, axis, factor, fixedAt)` in `transform.js` is
  B⁻¹ · S · B, like `flip()`: a turned, mirrored or sheared picture stretches along its own width or
  height, not along the page's. The basis is read from the quad the picture is drawn with at that
  moment (`quadBasis()` in `geometry.js`) — a picture's quad *is* its unit square in user space — so
  nothing about its placement is remembered between gestures.
- **The factor comes from the picture's own unit square**: the pointer is taken into it through B⁻¹,
  and how far along the axis it is, from the fixed edge, is the factor — kept to the same limits as a
  corner drag (0.05× to 20×). Dragging past the fixed edge is not a stretch but a mirror, which Shift+H
  and Shift+V already do properly, so it stops at the limit instead.
- **One picture at a time.** A group stretched along the page's axes would shear any turned picture in
  it, and text cannot be stretched at all, so a group keeps its four corner handles only.
- **The Phase 2 guard evolved, not removed.** The geometry test that forbade edge handles now requires
  every use of the edge midpoints to sit right behind the `#stretchable` gate, which asks for exactly
  one object and its own `stretch` capability.

### Test results

**Node engine suite**: **300 tests, 298 pass, 2 skipped, 0 fail**. New in `picture-stretch.test.mjs`
(7): the builder on upright, turned, mirrored and sheared placements (fixed edge exact, the other axis
unchanged), what is refused (zero, negative and non-finite factors, a non-axis, a non-edge, a collapsed
basis), `quadBasis` against every picture's CTM on the objects fixture, the capability on six fixtures,
the session (a picture stretched as one record and one undo step; text refused, alone and in a group),
and the saved file (an upright and a turned picture exactly where the stretch put them, and still
movable and stretchable).

**End-to-end**: the `manipulation` suite now checks that a picture offers four edge handles and text
none, and stretches the scaled, turned and flipped picture from whichever of its edges is on the right
of the screen: it widens by exactly the drag, its height and left edge do not move, it is one record
and one undo step, and the saved file has it there. The whole default set in one batch gave 346 of
348: text-editor 43, regression 48, selection 51, manipulation 89, multi-select 56, page-changes 17 all
passed; phase0 missed one check that passes alone (30/30), and editing-store's "thumbnails still
render" was caught between a thumbnail going and its redraw arriving — it now waits for the redraw
(14/14), as the suites' own rule says.

### Remaining for 0.5.0 (after §13)

Every must-have is done. The should-haves remain, each only if its strict tests pass (otherwise it
moves to a later release): paragraph grouping, alignment, distribution, snapping, image replacement,
image insertion, overlap warnings, single-style paragraph reflow (last, gated).

## 14. Alignment and distribution record (should-haves)

With several objects selected in Edit mode, an **arrange bar** floats above the selection's frame:
align left edges, centres, right edges; top edges, middles, bottom edges; space evenly across and down
(the last two from three objects up). The same eight actions are commands in a new palette group,
*Arrange* (`arrange.*` in `commands.js`); both surfaces call `TextEditor.arrange(kind)`.

### Decisions worth keeping

- **Pure arithmetic, in display axes.** `editing/objects/arrange.js` (`alignMoves`, `distributeMoves`)
  takes boxes and returns moves, nothing else. Boxes are measured as the page is *shown*
  (`displayBasis(pageView)` in `page-space.js`: the viewport's turn and flip without zoom or offset),
  so "left" is the left on screen whatever the page's /Rotate or the view's rotation; moves go back
  to user space through the inverse, exact because pages turn only in quarter turns.
- **Only moves.** An arrangement never scales or turns anything, so it is offered exactly when every
  selected object can be moved (`sharedCapability(objects, 'move')`), and it is written by
  `transformObjects` like a drag: one record per object, one undo step, all or nothing.
- **Align to the box around the selection; space between the outermost.** Spacing evenly keeps the
  first and last objects (by centre) exactly still — the last one's move is set to exactly zero, not
  left to rounding — and makes every gap equal (or every overlap, when they overlap).
- **The bar never takes focus** (its buttons swallow mousedown), hides during a drag, while text is
  typed and below two objects, and hides its spacing buttons below three rather than disabling them.
- **Icons**: eight Lucide icons added through `tools/build-icons.mjs`. lucide-static 1.44.0 is in the
  local npm cache (`npm install lucide-static --offline` into a scratch folder); regenerating with it
  reproduced the existing `icons.js` byte for byte before the new names were added.

### Test results

**Node**: 307 tests, 305 pass, 2 skipped, 0 fail. New `arrange.test.mjs` (7): every alignment exact
and one-directional, zero moves for what is already aligned, even spacing with the outermost still,
equal overlaps and stable ties, what is refused, "left" on a turned page, and a right-edge alignment
through the session into the saved file. **End-to-end**: `multi-select` gains an *arrange* area (10
checks, 66/66): the bar and its eight buttons, align left edges (one undo step), space evenly down from
the palette, six buttons for two objects, align top edges with the view turned 90° (level on screen),
Escape removes the bar. The whole default set in one batch: **358 of 358 checks in 8 suites**
(text-editor 43, regression 48, editing-store 14, phase0 30, selection 51, manipulation 89,
multi-select 66, page-changes 17).

### Remaining for 0.5.0 (after §14) — and the next step

Should-haves left, each only if its strict tests pass: **snapping**, image replacement, image
insertion, paragraph grouping, overlap warnings, single-style paragraph reflow (last, gated).

**Recommended next step: snapping while dragging** in Edit mode — while one object or a group is
dragged, its edges and centre snap to other objects' edges and centres and to the page's edges and
centre, within a few screen pixels, with thin guide lines drawn in the page overlay; Alt held while
dragging turns it off. It only changes the delta a move drag writes (still a move, same capability),
so it builds on `#onDragMove` and `displayBasis` without touching the writer. Image replacement
(a host file dialog, pdf-lib image embedding, a new resource per replaced draw) is the larger step
after it.

## 15. Snapping record (should-have)

While one object or a group is dragged in Edit mode, its left edge, centre or right edge — and its
top edge, middle or bottom edge — snaps to the same lines of any other object on the page, or of the
page itself, when one is within 5 screen pixels. A thin guide line marks each line it is then on, for
as long as the hand is down. Alt held while dragging moves it exactly with the pointer.

### Decisions worth keeping

- **Pure arithmetic, in display axes, like arrange.js.** `editing/objects/snap.js` (`snapMove`) takes
  the dragged box as it would be without snapping, the target boxes and a tolerance, and returns the
  extra move (`dx`, `dy`, each zero or within the tolerance) and the guides. The nearest line wins,
  per axis, independently; guides are every line the snapped box is then exactly on, spanning it and
  every target on that line.
- **Only the move changes.** `#snappedMove` in `ui/text-editor.js` is the one change to `#onDragMove`:
  the pointer's user-space delta is taken into display axes with `displayBasis(pageView)`, snapped,
  and taken back through its inverse (exact, quarter turns only) into the same `translate` a drag
  always wrote. Nothing new is written: still one record per object, one undo step, the `move`
  capability, `transformObjects`. Corner scaling, stretching, nudging and arranging do not snap.
- **Worked out once per drag.** The targets (every live object not being dragged, except blank and
  invisible text, plus the page's view box) and the dragged box are measured on the first move and
  kept on the drag (`drag.snap`); each pointer move is then only `snapMove` over those boxes. The
  guides are SVG lines in the decoration overlay drawn by the same `#draw` as the outline, so a snap
  re-renders nothing.
- **Screen-space tolerance.** 5 px through `tolerancePoints()`, so it feels the same at every zoom.
- **Alt is read from the pointer event** (`e.altKey`). Pressing or releasing Alt without moving takes
  effect on the next pointer move.

### Found on the way

- The existing `manipulation` checks drag objects by exact screen distances; the second text drag
  ended within 5 px of another line and — correctly — snapped (−1.7 pt), failing two of them. They are
  about a drag
  following the hand, so the suite's `dragBy` now holds Alt, which is exactly what a person does for
  an unsnapped move; snapping itself has its own area.

### Test results

**Node**: `node --test "tests/editing/*.test.mjs"`: **312 tests, 310 pass, 2 skipped, 0 fail**. New
`snap.test.mjs` (5): an edge within the tolerance lands exactly on the other edge, with one guide
spanning both, and nothing beyond it; centres and opposite edges, the nearest line wins, each axis on
its own, never more than the tolerance; the page's edges and centre with a full-length guide; what
gives no snap at all; and on a turned page, the snap is to the line as shown, the result is still
nothing but a translate, and the guide comes back vertical on screen.

**End-to-end**: `manipulation` gains a *snapping* area (11 checks, 100/100 in the suite), measured on
screen: with Alt, no guide and the move is exactly the hand's; without, a drag ending 2 px beside
another object's line lands exactly on it (to 0.05 px), a guide is drawn while the hand is down and
goes when it lets go, and the record is a plain move and one undo step; a group of two lines dragged
3 px short of a line lands on it; and with the view turned 90° a drag lands exactly on the line as
shown, with a guide. The whole default set in one batch: **369 of 369 checks in 8 suites**
(text-editor 43, regression 48, editing-store 14, phase0 30, selection 51, manipulation 100,
multi-select 66, page-changes 17).

**A real Alt key** (not the DevTools modifier bit the suites send): on the Debug build with a throwaway
data folder, Alt tapped on the keyboard (Win32 `keybd_event`) with Vellum in front, then an arrow key,
still nudged the selected line, twice in a row, and the page kept the focus — so the WPF host does
not take the keyboard when Alt is pressed and released.

### Remaining for 0.5.0 (after §15) — and the next step

Should-haves left, each only if its strict tests pass: **image replacement**, image insertion,
paragraph grouping, overlap warnings, single-style paragraph reflow (last, gated).

**Recommended next step: image replacement** — replace a selected picture's image with one from a
local file, keeping its placement (host file dialog, pdf-lib image embedding, a new XObject resource
for the replaced draw, the old one released only when provably unused, as delete already does).

## 16. Image replacement record (should-have)

With one picture selected in Edit mode, **Replace picture…** — the only button on the bar over it, or
a command in the palette (`edit.replacePicture`) — opens a Windows file dialog for a PNG or JPEG. The
picture's image becomes that one, in exactly the frame it had, as the same object and one undo step.

### Decisions worth keeping

- **The draw is kept; only its name changes.** Every image is drawn into its unit square, so the
  writer swaps the operator `/Im1 Do` for `/VlImgN Do` (inside the existing `q … cm … Q` when the
  picture has also been moved) and adds the new name to the page's `/XObject` resources. The CTM,
  clip, marked content, ExtGState and place in the drawing order all stay, so position, size, turn,
  mirror and shear are preserved by construction. The new image fills the frame; it is not letterboxed.
- **One record per picture.** An image record gains `replacement: { source, format, width, height }`.
  A move keeps it (`#plan` in `session.js`), a replaced picture moved back where it started keeps its
  record, a second replacement replaces the first, a delete drops it, and undo/redo are the store's.
- **The bytes live in the document's `sources` map**, the one pages inserted from other PDFs already
  keep their bytes in, and which `composeDocument` already receives. Undo, redo, duplicated pages
  (`followEdits` copies the record) and Save As reach them with no new plumbing.
- **The old resource is released on the deletion rule**: `releaseResources` became `updateResources`,
  counting replaced draws as gone. A name still drawn elsewhere on the page stays, a page that draws a
  form keeps every name, the page's resources are cloned first (inherited resources never change other
  pages), and garbage collection removes the image bytes only when nothing in the file reaches them.
  A new name is never one the page's dictionary already had.
- **Embedding is asynchronous in pdf-lib**, so the page writer gained one hook beside `precheck`: an
  async `prepare` per kind, run before any page is touched, whose result is handed to that kind's
  `write`. `applyObjectEdits` is now async; `composeDocument` awaits it.
- **Embedded once per file, copied per compose.** Measured: embedding a PNG costs 180 ms (1200×900)
  to 730 ms (2400×1800), and every change rebuilds the document. `readPicture` embeds into a scratch
  document once per chosen file (kept in a WeakMap keyed by the bytes), and `prepare` copies the
  finished streams, soft mask included, with pdf-lib's `PDFObjectCopier`: 3–9 ms per compose for the
  2400×1800 PNG. A JPEG is embedded as it is (`DCTDecode`, byte for byte).
- **Refused, with a reason, before anything is stored**: a file that isn't a PNG or JPEG pdf-lib can
  really embed (checked by embedding it, so a damaged file can't fail every later save); an inline
  image (`replaceRefusal` → `unsupported`; inline replacement stays deferred, §1); anything
  `imageRefusal` already refuses (form, layer, ExtGState soft mask, clip, degenerate); a PDF/A document
  (the standard constrains an image's colour space and transparency against the output intent, which
  Vellum doesn't check; refused in the session and again in the writer's `precheck`). Text never
  answers `replace` true. A tagged PDF is told once that its tags (such as a picture's description)
  aren't updated.
- **The host reads the file and returns its bytes** (`pictureDialog`, base64, at most 25 MB) instead of
  registering it with the resource server, which would also make it writable by the page.
- **The capability model answers seven verbs**: `replace` joined, true for a picture exactly when
  `move` is and the picture isn't inline. The tests that pin the verb set changed with it.

### Test results

**Node**: `node --test "tests/editing/*.test.mjs"`: **321 tests, 319 pass, 2 skipped, 0 fail**. New
`picture-replace.test.mjs` (9): a replaced picture keeps its frame and drawing order and the file holds
the new JPEG byte for byte, the other draw of the shared resource untouched; replacing every draw
releases `Im1` and no 32-pixel image is left in the file; a page drawing a form keeps `Im1`, and a PNG
with transparency gets its own `/SMask`; a moved, turned and mirrored picture lands exactly where it
was and can be replaced again after a save; pages inheriting one resource: only the replaced page (and
its duplicate, sharing one embedded object) change; the capability against `replaceRefusal`, inline
refused, text never; GIF, cut-off PNG, a PNG header claiming 20000 × 20000 pixels (refused before decoding: at most 40
megapixels), empty and non-byte input refused; the session: one record
through move and replace, kept when moved back, one undo step, redo, refusals store nothing, delete
after replace; PDF/A refused by the session and the writer, and a missing source refuses the save.

**End-to-end**: `manipulation` gains a *replace picture* area (21 checks): a clicked picture gets the
bar with only "Replace picture…"; a 40 × 20 PNG made in the page replaces it through
`TextEditor.replacePictureWith` (the rest of what the dialog starts); one record with the replacement,
the frame unchanged to 0.01 pt, pdf.js paints magenta at its centre, still selected, one undo step;
undo brings the old image back and redo the new; a GIF changes nothing; a clicked inline image gets no
button and is refused; the palette offers the command; saved, closed and reopened, the file draws the
40 × 20 image in exactly that frame, replaceable again, painted by pdf.js.
The whole default set in one batch: **390 of 390 checks in 8 suites** (text-editor 43, regression 48,
editing-store 14, phase0 30, selection 51, manipulation 121, multi-select 66, page-changes 17); the
multiple-selection arrange bar still shows its eight actions, with the replace button hidden. After the
last small changes (the PNG pixel limit, message wording) manipulation was run again alone: 121/121.

**The native dialog, by hand** (Debug build, scratch data folder, a copy of the `images` fixture): the
command opens a Windows dialog titled "Replace picture with" whose file type reads "Pictures
(*.png;*.jpg;*.jpeg)"; closing it resolves `replacePicture()` false with no edit and nothing dirty.
Choosing a file inside the dialog could not be automated from this environment (UI Automation and
window messages didn't reach its file-name box, and Windows wouldn't bring it to the front); the JS side
of that answer was checked instead by answering `pictureDialog` with a real 60 × 30 PNG in base64,
which `replacePicture()` decoded and applied (`png`, 60 × 30). Picking a file in the real dialog
remains to be tried by a person.

### Remaining for 0.5.0 (after §16) — and the next step

Should-haves left, each only if its strict tests pass: **image insertion**, paragraph grouping, overlap
warnings, single-style paragraph reflow (last, gated).

**Recommended next step: image insertion** — place a PNG or JPEG from a file on a page in Edit mode as
a new picture. It can reuse `readPicture`, the scratch-document embedding, `prepare` and
`updateResources`' naming from replacement; what is new is a record that draws something not in the
original content (appended after the page, like moved text), its identity and selection, and a default
size and place.

## 17. Image insertion record (should-have)

In Edit mode, **Insert picture…** — a command in the palette (`edit.insertPicture`) or an item in the
page's context menu — opens a Windows file dialog titled "Insert picture" (`pictureDialog` with
`purpose: 'insert'`). The PNG or JPEG goes on that page (the right-clicked page, else the selection's,
else the page in view) as a new picture, and is selected.

### Decisions worth keeping

- **A new record kind, `inserted-image`, with its own handler** (`editing/objects/inserted-image.js`,
  registered in `registry.js`): `{ id, kind, entry, picture: { source, format, width, height },
  transform }`. There is nothing in the original content to fingerprint, so the record is the object:
  `transform` maps the image's unit square into the original page's user space and is the whole
  placement. Its identity is `inserted:<record id>`.
- **To the object model it is a picture like any other.** `page-objects.js insertedObject` builds an
  `image` object with an identity CTM and the unit square as its quad, so `#liveOf`'s "quad × record
  transform" puts it where it is, and selection, hit-testing, drag, corner and edge handles, turn,
  mirror, snapping, arrange, multi-select and Delete needed no change. Capabilities come from
  `capabilitiesFor` (page-wide refusals only). Its order is `[MAX_SAFE_INTEGER, i]`: drawn, and hit,
  over everything the page draws. `session.objects()` appends these, blank pages included.
- **Moving never drops it.** `#plan` returns a new transform on the same record (there is no "back where
  it started"); deleting applies `[record, null]`; replacing it swaps `picture` and keeps the transform.
- **Written after the page's content**, in the unified writer's `append`: `q <transform> cm /VlImgN Do Q`,
  under a name from `updateResources` (now exported, called with nothing dropped). `embedPictures`
  (factored out of `image.js prepare`) embeds once per source and is shared by both handlers, so a
  duplicated page draws the same image object. PDF/A is refused in the session and again in `precheck`.
- **The compose path still doesn't reach the object model**: `insertedObject` lives in page-objects.js,
  not in the handler (capabilities.test.mjs walks the import graph).
- **Default place**: centred on the crop box, upright as the page is shown (`displayBasis`, so a
  `/Rotate` page or a turned view still shows it upright), 0.75 pt per pixel, at most half the shown page
  width and height, never enlarged (`defaultPlacement`).
- **Found on the way**: `session.page()` mapped every record on the page by `target.key`; an inserted
  record has no target, so reading the page threw and Edit mode dropped the selection. It now maps text
  records only (the only ones it uses). `#reconcile` now keeps what the live objects hold instead of
  re-resolving against the original analysis, which can't know an inserted picture. The UI selects the
  new picture only once the rebuilt page lists it.
- A tagged PDF is told once that the new picture isn't added to its tags.

### Test results

**Node**: `node --test "tests/editing/*.test.mjs"`: **326 tests, 324 pass, 2 skipped, 0 fail**. New
`picture-insert.test.mjs` (5): the default placement (fitted, natural size, upright on a `/Rotate 90`
page as pdf.js shows it, centred; no basis or no pixels → none); the file draws it last in exactly its
frame, appended in its own `q … Q`, the page's own pictures untouched, the JPEG byte for byte, a second
picture named `VlImg2`; blank and duplicated pages draw it from one embedded object; the session: one
record, selectable last with move/scale/stretch/rotate/replace/delete, the page's text still readable,
moved and moved back keeps it, replaced in place, saved exactly there, deleted, undo/redo; refusals
(not an image, a cut-off PNG, not bytes, a missing page, PDF/A in the session and the writer, a missing
source at save, a placement with no area). `image-edits.test.mjs` now expects three writable kinds.

**End-to-end**: `manipulation` gains an *insert picture* area (19 checks): a 40 × 20 PNG made in the page,
through `TextEditor.insertPictureWith` (what the dialog starts), is selected, one more object with every
picture verb, centred at 30 × 15 pt, painted by pdf.js, one undo step; clicked it is selected over what
is beneath; dragged it moves by the hand, still one record; undo puts it back, undo again removes it and
the selection, redo twice brings it back where it was dragged; Delete removes it and undo restores it; a
GIF adds nothing; the palette offers the command; saved, closed and reopened, the file draws the 40 × 20
image where it was left, as an ordinary movable picture, painted by pdf.js. The default batch in one run:
**409 of 409 checks in 8 suites** (text-editor 43, regression 48, editing-store 14, phase0 30, selection
51, manipulation 140, multi-select 66, page-changes 17); manipulation again after the last change
(the tagged-PDF notice): 140/140.

The native dialog itself (its title and filter) was not driven from this environment, for the reasons in
§16; the context-menu item was not clicked by the suite.

### Remaining for 0.5.0 (after §17) — and the next step

Should-haves left, each only if its strict tests pass: **paragraph grouping**, overlap warnings,
single-style paragraph reflow (last, gated).

**Recommended next step: paragraph grouping** (`text-block`): group compatible runs into one movable
object where the structure is unambiguous (same font, size, colour and orientation; consistent line
spacing and left edge; no columns, tables or lists), refusing everything else. Overlap warnings are small
and can follow in the same session; reflow depends on grouping.

## 18. Paragraph grouping and overlap warnings record (should-haves)

Also in this session, two small UI fixes: the Edit toolbar's tools size to their labels with equal
padding (they were equal-width slots, so the gaps varied), with the sliding knob measured from the
pressed tool; and the tab strip's + shows the home screen (it opened the file dialog), leaving every tab
open. The `regression` suite gains a *chrome* area (4 checks).

### What a person gets

In Edit mode, dragging a line of a plain paragraph moves the whole paragraph; the paragraph is then the
selection, so handles, arrow keys, arrange and Delete act on it as one. A click still opens the editor on
that line alone, and a line selected on its own (clicked, then Escape) drags by itself. While anything is
being dragged or nudged, what it would newly cover is outlined in amber, until the hand lets go.

### Decisions worth keeping

- **A block is identity, not a new object kind.** `text-block.js textBlocks(objects)` returns
  `[{ key: 'block:<first key>', keys }]`, the lines' own run keys from the top down. Everything else is
  multi-select: one record per line, one undo step, the text writer unchanged. No `text-block` kind was
  added to `page-objects.js`, the capabilities or the registry of writers, so nothing reaches a file that
  couldn't before.
- **Worked out from the live objects** (where lines are now, a moved line compared where it went), in
  each line's own reading frame from its quad, with the page's painted paths passed in so a rule keeps
  two lines apart. Kept with `#liveOf`'s cache, so any edit recomputes it.
- **Refuse, don't guess.** Grouped only when every line is movable and editable, not skewed or mirrored,
  same font, size (1%), fill, stroke, render mode, spacing operators, graphics states, form and
  direction; same left edge (0.1 × size); step 0.9–1.6 × size and within 0.05 × size of the block's
  first step; no other text overlapping its row by more than half; no list marker (bullet, dash, `1.`,
  `a)`, roman numerals); nothing drawn between the middles of two consecutive lines except something
  behind the whole of that band. A line at paragraph spacing starting at another edge (an indent) leaves
  both sides ungrouped rather than leaving one line behind. Mixed-style paragraphs are not grouped.
- **Selected on the move, not the press**, so a click that edits a line never flashes the paragraph's
  arrange bar. The pressed line is the selection's primary key.
- **Overlap warnings** (`overlap.js`): a separating-axis depth for two oriented quads, and
  `newOverlaps(moving, others, tolerance)` reporting only what the moving objects cover at their target
  and did not at their start. Shown only while `#drag.moved` or a nudge burst is pending; blank and
  invisible text is ignored; the tolerance is the larger of 2 screen pixels and a quarter of the smallest
  moving object's height, so lines whose boxes just touch don't warn. A drop that leaves an overlap says
  so through the live region. Nothing is refused.

### Test results

**Node**: `node --test "tests/editing/*.test.mjs"`: 329 tests, 327 pass, 2 skipped, 0 fail (before the
two overlap tests were added; `overlap.test.mjs` 2/2 on its own). New fixture `paragraphs` (one page: a
paragraph under a heading, bullets, a numbered list, columns, a table, size and colour changes, drifting
spacing, a rule between two lines, an indented first line). `text-block.test.mjs` (3): exactly the
paragraph and the evenly spaced pair are grouped, and the rule is what separates its two lines; a line
pulled sideways leaves the paragraph, a paragraph moved whole stays one, moved onto the list's rows it
doesn't; through the session a paragraph move is four records, one undo step, and the saved file has
every line 200 across and 30 down, still grouped. `overlap.test.mjs` (2): exact depths, turned quads,
touching is 0, only new overlaps, never the moving objects, the tolerance.

**End-to-end** (focused, not the full batch): `multi-select` 79/79 with new *paragraphs* (10) and
*overlap warnings* (4) areas: dragging the second line selects and moves all four by exactly the same
amount, one undo step, the list untouched; a click selects that line alone with the editor open; after
Escape it drags alone; a bullet line drags alone; a table cell dragged onto the one below outlines exactly
that cell while the button is down, and nothing once released, with the move made. `manipulation`
140/140 and `selection` 51/51 with grouping in place; `regression` 52/52 with the UI fixes.

### Remaining for 0.5.0 (after §18) — and the next step

Should-have left, only if its strict tests pass: **single-style paragraph reflow** (last, gated). Then the
one broad regression pass and the release QA.

**Recommended next step: single-style paragraph reflow**, built on a `text-block` — rewrapping a grouped
paragraph's text to a new width in its own single font and size — only in the narrow case the audit
allows, refused otherwise.

## 19. Single-style paragraph reflow record (the last should-have)

### What a person gets

In Edit mode, a whole paragraph selected (Shift-clicks, a rectangle, or a drag of one of its lines) that
can be reflowed shows one extra handle, on the middle of its right edge. Dragging it shows the new width
as a dashed box from the paragraph's left edge; letting go rewraps the words into the paragraph's own
lines at that width. A single line, a part of a paragraph, text set at an angle, or a paragraph that fails
the gate below gets no handle.

### The narrow case, and why it is narrow

- **The paragraph's own lines, nothing else.** Words are refilled greedily into the existing lines, top
  first; each keeps its baseline, left edge, font, size, colour, spacing operators and placement; lines no
  longer needed are emptied (`encoding: none`). A width that would need more lines than the paragraph
  has is refused: making a new line would need a record with no run to fingerprint, which the edit model
  (edits.js) does not have, and inventing one is out of scope.
- **No new record kind, writer or font path.** Every line stays its one `text` record, planned by
  `planTextEdit` in the run's own font (`encoding: font`); a result needing a substitute is refused (the
  "Never" list forbids silent substitution). A line whose new text is the file's own again goes back to
  its own glyphs (or its placement record), as retyping does. The writer re-checks each record against the
  original run as always, and PDF/A, signed, tagged and encrypted documents take the paths text edits take.
- **The gate** (`reflow.js`, checked again for every plan, independently of grouping): at least two lines,
  every one editable; none already in a substitute font or removed; one style (font, size, Tc, Tw, Tz, Ts,
  Tr, fill, stroke, graphics states, form, clip, text and CTM scale); one placement (the same record
  transform, or none); one left edge (0.1 × size) and an even spacing of 0.9–1.6 × size (grouping's own
  bounds, now exported); **laid out with the font's own widths** — every glyph starts where the previous
  one ends (0.02 × size) on the same baseline, and each line's width as measured from the font equals its
  width in the file (0.02 × size + 0.2%), so kerning, tracking, justification or pen-move word gaps are
  refused; no line but the last ending in a hyphen; the font able to write every word in its own glyphs,
  with no gap substituted for a space it can't draw. Measurement follows the PDF text model exactly
  (`(w0·Tfs + Tc + Tw·[code 32])·Th`, in the text matrix and CTM).
- **The width is measured as shown** and divided by the paragraph's shared uniform scale, so a paragraph
  scaled as one reflows as it looks.
- **The handle is behind the engine's own gate** (`#reflowable` calls `reflowRefusal`), cached with the
  page's live objects; `object-geometry.test.mjs` now pins that the right-edge handle is only drawn and
  grabbed behind that gate, as the stretch handles are behind theirs. Only a width can be refused after the
  hand lets go, with the reason in a notice.
- **Known limit**: lines emptied by a reflow are gone from the page, so the paragraph can then be
  reflowed only into the lines it still shows (undo restores them).

### Test results

**Node**: 335 tests, 333 pass, 2 skipped, 0 fail. The `paragraphs` fixture gains a second page (a kerned
paragraph, words spaced by pen moves, a hyphenated break). `reflow.test.mjs` (4): wider and narrower
widths refill every word in order, lines given in any order; refusals for a word-narrow width, too many
lines, one line, kerning, pen-move spaces, a hyphen, lines far apart, two colours; through the session a
reflow is four records (font / none), one undo step, and the saved file — verified against pdf.js — has
each new line on its original line's baseline and left edge, in its font, within the width, every word in
order, and every other run on the page unchanged; a paragraph scaled ×2 reflows at twice the width with its
placement kept; an emptied line is gone and a separately nudged line refuses. `object-geometry.test.mjs`
extended for the reflow handle's gate.

**End-to-end** (focused): `multi-select` 90/90 with a new *reflow* area (11): no handle for one line; one
for the whole paragraph; the width preview while held; on release four records (font or emptied), one undo
step, every word in order, drawn by pdf.js; the reflowed paragraph selected again keeps its handle; a width
narrower than a word is refused with the reason and changes nothing; a kerned paragraph gets no handle; no
page errors. After the change, `manipulation` and `selection` run together: 139/140 and 34/51 (the
selection failures all followed its first image click); `selection` alone: 51/51. `manipulation` alone
failed once more on *insert picture → inserting a PNG succeeds* (the picture was inserted and selected, but
the call's result didn't come back as `true`), then passed 140/140 twice, the check now recording the
returned value, the time and the notices. Not reproduced, and the insert path doesn't reach reflow code;
left for the broad regression pass to watch.

### Remaining for 0.5.0 (after §19)

Every 0.5.0 feature is built. **Next: the one broad regression pass** — the full default end-to-end batch
and the Node tests, fixing what it finds — **then the release QA session**. No push, release or version
bump has been made.
