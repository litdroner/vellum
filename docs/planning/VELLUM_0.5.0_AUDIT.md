# Vellum 0.5.0 — object editing: audit, scope and Phase 0 record

Planning document. It records the architecture audit that preceded 0.5.0, the approved scope, and
what Phase 0 actually changed and measured. Kept up to date as each phase lands.

- Baseline: 0.4.0 released (`f0bc670`, tag `v0.4.0`), documentation checkpoint `ae1f36c`.
- Phase 0 (hardening and test infrastructure): done, see "Phase 0 record" below.
- Phase 1 (object model and the unified page writer): done, see "Phase 1 record" below.
- Phase 2 onwards: not started.

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

1. **An edit whose kind no handler claims is still dropped without a word** (`editing/page-writer.js`,
   `editing/objects/registry.js`). It has to become an explicit refusal — a change a person made must
   never vanish silently. `phase1-baseline.test.mjs` pins today's behaviour on purpose, so that fix
   arrives as a deliberate, readable diff rather than something that slips through.
2. **`text-block`** is in the object model's planned kinds but not built: only `text-run`, `image`,
   `path` and `form` exist. Paragraph grouping is a "should have" and is gated on its own tests.
3. **No end-to-end coverage of the object model yet**, for the reason given above.

## 8. Next

Phase 2 — selection: oriented bounding boxes, handles, z-aware hit-testing and same-page multi-select,
built on the objects and capabilities above. It begins only on approval.
