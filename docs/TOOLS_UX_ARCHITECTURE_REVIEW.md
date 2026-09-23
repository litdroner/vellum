# Vellum Tools: architecture review of the UX spec

**Status:** review only. Nothing is implemented. No production code, test code or other document was
changed, and `TOOLS_UX_SPEC.md` was not edited: its discrepancies are reported here (§4.2).
**Reviewed:** `docs/TOOLS_UX_SPEC.md` (uncommitted, branch `docs/tools-ux-spec`, base `fe083f5` =
release 0.25.0), on 2026-09-23.
**Method:** I read the spec in full, then the code it builds on: `commands.js`, `shortcuts.js`,
`app.js` (actions, More menu, context menu, `menuItem`), `pages/actions.js` (thumbnail menus),
`ui/palette.js`, `ui/toolbar.js`, `ui/titlebar.js`, `ui/focus.js`, `ui/dialogs.js`, `themes.js`, the
material and motion rules in `app.css`, `document-view.js` (availability getters), `export/actions.js`,
`tests/e2e/run.mjs`, `tests/e2e/lib.mjs`, `tools/cdp-client.mjs`, `tests/editing/harness.mjs`,
VELLUM_VISION §3.9, §3.10, §8 and §13, and ARCHITECTURE_GUIDELINES. I ran two Node import probes,
each with a 20 s hard limit. I did not launch the app, run an e2e suite or run a regression.

---

## 1. Executive summary

**The direction is right, so keep it.** Tools as a discovery layer over the existing command
registry is the right model for Vellum 1.0. So are a lazily loaded modal sheet, a data-only catalog,
deterministic local search, honest unavailable states, no AI and no new materials. The spec doesn't
replace a fast path, doesn't add a second execution system, and fits the design system as it is.

**The data model has four things in the wrong layer, and a few claims don't survive the code.**
Fixing them means editing the spec's data model, not redesigning it. They are cheap now and expensive
after Phase 1:

1. **Availability belongs to commands, not tools.** `requires` and `presentIf` describe whether
   something can *run*, and commands are what run. The palette, More menu, toolbar and context menus
   need the same answers (the spec's own §18.3 goal). Vision §3.9 also says AI entry points must not
   appear without a provider, and the palette is an entry point. On the catalog, `presentIf` can't
   hide a palette command. On the command, it hides it everywhere.
2. **Tool ids must not contain the category.** `organize.merge` and `convert.word` tie a persisted
   identifier (recent, favorites, and perhaps later a Flow step) to the most volatile part of the
   design, the taxonomy, which §29 Q1 still leaves open. Use task slugs (`merge-pdfs`).
3. **`preset` leaves the catalog.** A preset is a run argument, so the catalog would become a second
   argument channel to commands. Vellum's own idiom is one command per variant (`ocrPage` and
   `ocrDocument`, `rotateLeft` and `rotateRight`, one command per font). Five `export.*` commands over
   `actions.export.run(view, { format })` keep Tools a pure pointer, give the palette "Export to
   Word…", and keep one command behind each tool.
4. **"Requirement" and "relevance" are different things.** §14 says the "For your selection" strip is
   derived from each tool's `requires`, but §4.1 gives Highlight, Underline and Add link no selection
   requirement, and they rightly have none: they work without one. Requirements gate running.
   Relevance only suggests, and it belongs with recommendations.

**Two infrastructure findings block safe testing:**

5. **`commands.js` can't be imported in Node.** A probe gave `ReferenceError: window is not defined`
   through `ui/attachments.js` → `bridge.js:3`. It is also the registry's only direct import of a UI
   module. Every other feature goes through `actions.*`. Moving it behind `actions.attachments.show`
   fixes the layering and the test at once.
6. **The e2e client has no request timeout.** In `tools/cdp-client.mjs`, `send()` never rejects: it
   has no per-request timeout and no close handler. So `waitFor` is bounded only *between*
   evaluations, which contradicts spec §25. A suite-level `Promise.race` is a necessary backstop, but
   the root fix is in `send()`. A flat 180 s suite default would also kill suites that have single
   waits of 120–180 s (`performance`, three OCR suites). Seven synchronous child processes have no
   `timeout`, one of which fills the real Save dialog (`history-move.mjs:72`), and no race can
   interrupt those.

**Smaller must-fix items:** the search ranking can't meet its own invariant as specified (§9); the
shortcut should not be Ctrl+T (§22 Q3); the "More-menu agreement" Node test can't be written as
specified (§18); and the zero-startup-cost budget conflicts with the palette aliases and the Home row
(§11).

**Can a Tool id become a Batch/Flow step id?** It wouldn't couple automation to *commands* (tool ids
and command ids are already separate). It would couple saved workflows to the *discovery taxonomy*,
the layer that changes most. Flow and Batch steps should use **operation ids**, owned by a future
operation registry over the pure core modules that already exist (`mergeDocuments`,
`compressDocument`, `runExport`…). A tool may point to an operation. Automation never reads
`tool.command`. That affects the catalog now in three small ways only (§17).

**Verdict: GO for Phase 1 once the must-change list (§28) is folded into the spec. Phase 2 (the
visible sheet) waits for the owner's answers to Q2, Q3, Q6 and Q12 and for the runner fix to land.**

## 2. Current architecture under review

### 2.1 What the code actually has

```
Surfaces    toolbar · title bar · More menu · document context menu · thumbnail menus · palette · keys · Home
   │         most call command.run(); the context and thumbnail menus call actions directly with arguments
   ▼
Commands    commands.js: id → { label, icon, group, keys, hint, global, when, doc, palette, run(e) }
   │         run() resolves "the current context": active view, selected pages, current page
   ▼
Actions     actions.* and create…Actions(): UI workflows with explicit parameters (view, ids, index)
   │         pickers, dialogs, confirmations ("this PDF is signed…"), toasts, undo
   ▼
Cores       pure modules, Node-tested, no DOM: pages/merge.js mergeDocuments, optimize/compress.js
            compressDocument, export/run.js runExport, pages/images-to-pdf.js, ocr/engine.js,
            annotations/persist.js composeDocument (the only writer of PDF bytes)
```

Facts the architecture depends on:

- **`run` already takes an argument: the triggering event.** `shortcuts.js:55` calls `command.run(e)`.
  `ui/titlebar.js:33` passes the click event to `view.theme`, and `actions.toggleTheme(e)`
  (`app.js:405`) reads `e.clientX`. Any future argument channel must not take the first parameter
  (§22, Q4).
- **Actions are already parameterised.** `actions.pages.rotate(view, ids, deg)`,
  `insertBlank(view, index)`, `split(view, selectedIds)`, and `actions.export.exportTo({ view, formatId,
  pages, folder })` (`export/actions.js:139`), a dialog-free entry point the `export` e2e suite already
  uses. The context and thumbnail menus don't need command arguments to avoid duplicating logic. They
  duplicate only *labels*.
- **Availability is decided in three places,** as the spec says: `doc` on commands (the palette's
  only filter, `palette.js:122`), hand-written `disabled:` expressions in the More menu
  (`app.js:570–591`), and refusals inside actions (for example `pages/actions.js:55–59`).
- **`view.canEditPages` is `status === 'ready' && !encrypted`** (`document-view.js:173`), so
  `writable` already implies `document`.
- **There is no central command dispatcher.** Each surface calls `c.run()` itself. That is fine, and
  this review doesn't recommend adding one (§26).

### 2.2 What the spec adds

```
Tools sheet ─┐        ┌─ catalog/catalog.js   (tools, categories: data)
Home chips  ─┼─ uses ─┼─ catalog/search.js    (pure)
Palette     ─┘        ├─ catalog/context.js   (requirements: snapshot + evaluate)
                      ├─ catalog/recommend.js (rules)
                      └─ catalog/store.js     (recent/favorites, localStorage)
                                 │ names a command id (+ preset, + variants)
                                 ▼
                          commands.js ─► actions.* ─► features
```

The execution path is right: a tool names a command, and the registry runs it. The problems are
about *what the catalog also owns*: availability, run parameters and a category-shaped identity
(§6, §7).

## 3. What the UX spec gets right

Keep all of the following exactly as proposed:

- **One execution system.** Tools never runs anything itself. §16 says so, and the diagram enforces it.
- **Tools is discovery, not replacement.** The toolbar, context menus, contextual bars, palette and
  shortcuts stay the fast paths (§2 goal 4, §26).
- **The inventory is honest.** 75 capabilities, 49 tools, 26 deliberately left off, each exclusion
  with a reason. No planned feature appears. Automate stays hidden until something real exists.
- **The code namespace is separate from "tool".** The spec found that `setTool()`, `group: 'Tools'`,
  `tools.*` ids and the localStorage key `vellum.tools` (`annotations/layer.js:40–48`) already use
  the word.
- **The catalog is lazy.** Nothing loads until first use, it runs on plain DOM through `h()`, needs
  no virtualisation (about 50 rows) and has no index structure beyond pre-normalised tokens.
- **Search is deterministic and local,** with a golden-query table and an alias contract that
  includes a forbidden list for features that don't exist.
- **Unavailable rows are honest:** `aria-disabled` rather than `disabled`, the reason as readable
  text, and rows that never jump around.
- **It reuses the design system.** `--glass-float`, `--blur`, clay, the accent triad and the motion
  tokens all exist and behave as the spec says (§12). No Material Intensity, Glass Effect or High
  Performance Mode. None exists in the code (§19.1 verified).
- **Recommendations stay restrained:** only facts, at most 3, dismissible, never blocking, no AI.
- **The sheet runs a tool on the next frame after focus is handed back,** as `CommandPalette.#run`
  does (`palette.js:203–209`).
- **The test-safety rule,** and finding that `run.mjs` has no suite-level timeout.

## 4. Architectural risks

### 4.1 Risks, ranked

| # | Risk | Evidence | Severity |
|---|---|---|---|
| R1 | Availability on the tool can't reach the palette or menus, and a second evaluator appears beside `doc` | spec §17.2, §18.3; `palette.js:122` | **Must change** |
| R2 | Tool ids contain the category, so a rename or move breaks favorites, recent and any future step id | spec §17.2 `organize.merge` | **Must change** |
| R3 | `preset` turns the catalog into an argument channel; five tools share one command (`file.export`), so mapping a command to its tool (recent recording, alias joining) becomes ambiguous | spec §17.2, §4.1 #27–31 | **Must change** |
| R4 | Requirement and relevance are merged, so the §14 selection strip contradicts §4.1 | spec §14 vs §4.1 Sel column | **Must change** |
| R5 | Registry integrity can't be tested in Node | probe: `ReferenceError: window is not defined` | **Must change** (Phase 1 task) |
| R6 | E2E requests have no timeout, so `waitFor` is not really bounded | `cdp-client.mjs:38–48`, `lib.mjs:14–21` | **Must change** (before the Tools suite) |
| R7 | Additive context boosts can overturn text tiers, breaking the spec's own §24 invariant | spec §9.3, §9.5 | **Must change** |
| R8 | ` 2 ` → ` to ` plus the AND rule: "rotate 2 pages" finds nothing | spec §9.2 step 2, §9.3 | Must change |
| R9 | Ctrl+T sits beside Ctrl+Shift+T (Reopen closed document, `commands.js:60`), the browser pair where Ctrl+T means "new tab" | `commands.js:60`, `ui/tabs.js` New tab | Must change (Phase 2) |
| R10 | Zero startup cost conflicts with the palette aliases (a static import) and the Home row | spec §23 vs §9.8, §8 | Restate the budget |
| R11 | Opening the sheet may clear the page's text selection (focus moves into the search field) | spec §14; `palette.js:100` pattern | **Verify** in Phase 2 |
| R12 | Making the app `inert` is a new modal pattern; `restoreFocus` refuses elements inside `[inert]` | `focus.js:11`; dialogs use a Tab trap | Verify and share |
| R13 | The sheet can open over a modal dialog (dialogs don't set `data-own-keys`) | `shortcuts.js:46`; `dialogs.js` | Gate it |
| R14 | Minimum window is 560 × 400 (`MainWindow.xaml:5`); the sheet would be about 512 × 310 | spec §6.3 sizing | Verify |
| R15 | The blur surface is the largest in the app and is re-filtered every frame of the open animation | `app.css:107`, `2029–2039` | Measure (§12) |
| R16 | "Catalog" also names an uncommitted Intelligence prototype's model list (`intelligence/catalog.json`, main worktree, WIP) | file listing only | Naming note |
| R17 | Recommendation signals could grow into a rules engine | spec §11 | Guard (§14) |

### 4.2 Factual corrections to the spec (reported, not edited)

| Spec | Says | Code says |
|---|---|---|
| §4.3 item 2 | `GROUP_ORDER` leaves out Tools, Forms, Bookmarks, Links **and Arrange** | `palette.js:10` includes `Arrange`. Only Tools, Forms, Bookmarks and Links are missing |
| §25 | "`connect` (60 s) and `waitFor` are bounded" | `waitFor` checks its deadline only between evaluations, and each evaluation can wait forever (`cdp-client.mjs:38–42`). `connect`'s `fetch` and WebSocket open have no timeout either |
| §24.1 | Risk: `commands.js` "may not be able to import" in Node | Confirmed: it can't (probe, `bridge.js:3`). The other two imports (`text-format.js`, `bundled-fonts.js`) import cleanly |
| §24.1 | A Node test of "More-menu agreement" | The More menu's `disabled:` logic is a closure inside `app.js` (`560–599`), which imports `bridge.js`. Node can't reach it (§18) |
| §24.2 | Spy on "the target command's `run`" | `window.__vellum` exposes `app`, `actions`, `ui`, `errors`, `setAppearance` (`app.js:732–735`), not `commands`. It is reachable only through `ui.palette.commands` |
| §14 | The selection strip "is computed from each tool's `requires`" | §4.1 gives Highlight, Underline and Add link no selection requirement, so the table in §14 can't be derived from that data (R4) |
| §9.5 | "the context terms never add up to a text tier" | They can reach +66. A blurb match (weight 0.5) separates exact from prefix by only 15 points, and a name match separates inner from typo by 30 (R7) |
| §23 | App startup cost 0 | The palette is constructed at startup (`app.js:478`). If it imports aliases statically, the catalog loads at startup too (R10) |
| §22 | "The rest of the app is `inert`" is described as reuse | No surface does this today. Dialogs use `aria-modal` plus a Tab trap (`dialogs.js:16`, `46–50`), and the palette uses neither |
| §16 | Capability "is the same thing as a tool" | §4 counts 75 capabilities and 49 tools, and `editing/objects/capabilities.js` already uses "capabilities" for per-object verbs (§6) |

## 5. Existing infrastructure to reuse

| Need | Reuse | Where |
|---|---|---|
| Execution | The command registry, `c.run()` | `commands.js` |
| Menu items from commands | `menuItem(id, icon, extra)` | `app.js:554–557` |
| Keys shown in UI | `prettyKeys`, `commandTitle` | `dom.js:73`, `79` |
| Overlay mount point | `#overlay-root`, a sibling of `#app` (so `#app.inert` is clean) | `index.html:34`, `43` |
| Blocking global shortcuts under a surface | `[data-own-keys]` | `shortcuts.js:46`, used by `compare-view.js:85` |
| Focus handback | `restoreFocus`, `setFocusFallback` | `ui/focus.js` |
| Combobox, listbox and active descendant | The palette's pattern | `palette.js:80–90`, `181–190` |
| Close without `transitionend` | The palette's fixed 200 ms removal | `palette.js:114` |
| Materials | `--glass-float`, `--blur`, `--float-shadow`, clay, the accent triad | `app.css:51–140` |
| Comfort switches | `data-glass="off"`, `data-motion="reduced"` (both apply before first paint) | `themes.js:154–163`, `theme-boot.js:20–21`, `app.css:137–140`, `2330–2337` |
| Safe localStorage | The `toolPrefs` try/catch pattern | `annotations/layer.js:40–48` |
| Page scope | `ui.sidebar.thumbs.targetIds()` via `onPages` | `commands.js:29–32` |
| Availability getters | `view.canEditPages`, `view.encrypted`, `actions.history.canUse`, `view.textEditing.unavailableReason`, `view.profile()` | `document-view.js:173`, `189` |
| Scanned-page signal | `hasUsableText(pdfPage)` | `ocr/engine.js:24` |
| Parameterised Export | `exportTo({ view, formatId, pages, folder })` | `export/actions.js:139` |
| Headless operations for later | `mergeDocuments`, `compressDocument`, `runExport`, images to PDF, `composeDocument` | `pages/`, `optimize/`, `export/`, `annotations/persist.js` |
| Node test loader | `webModule(file)` | `tests/editing/harness.mjs:46` |
| Dialog stubs in e2e | `stubOpenDialog` | `tests/e2e/suites/merge.mjs:25` |
| Bounded native helpers | `spawnSync` with `timeout` and `SIGKILL` | `tests/e2e/native-dialog.mjs:34–37`, `window.mjs:116–120` |
| Frame measurement | The performance suite's rAF pattern | `tests/e2e/suites/performance.mjs:89` |
| One reason vocabulary | Vision §8 "capability detection"; `REASONS` for the editing engine | `VELLUM_VISION.md` §8, `editing/runs.js:26` |

## 6. Capability / Tool / Command model

### 6.1 Definitions to hold everyone to

| Concept | What it is | Owner | Runs? | Gates? |
|---|---|---|---|---|
| **Command** | A named entry point a person can invoke, with presentation (`label`, `icon`, `group`, `keys`) and availability (`doc`, and in future `requires` and `presentIf`). `run(e)` resolves the current UI context and calls an action | `commands.js` | Yes, the only thing that does | Yes |
| **Action** | A feature's UI workflow with explicit parameters: pickers, dialogs, confirmations, toasts, undo. Not headless | the feature (`create…Actions`) | Called by commands (and today by some menus) | Refuses with a reason as a last line of defence |
| **Operation** *(future; the cores exist)* | A headless transform with serialisable parameters: bytes or a document in, bytes or a report out. No DOM, dialogs or active view | the feature's core module; a registry later | Called by actions, and later by Batch and Flow | Declares its inputs |
| **Tool** | Discovery metadata for one user goal: id, name, blurb, aliases, category and section, command (plus variants), and later an optional operation link | `catalog/catalog.js` | **Never** | **Never** (it reads its command's availability) |
| **Requirement** | A named, synchronous, O(1) predicate over app state, with a reason sentence | `web/js/requirements.js` (§8) | – | Yes |
| **Presence** | Whether an engine or provider exists on this PC (Office engine, signing engine, `AIProvider`). Unmet means hidden everywhere | the provider; named on commands | – | Hides |
| **Relevance** | Why a tool fits *now* (a selection, form fields, a scanned page). Suggestion only | `catalog/recommend.js` | – | Never |
| **Capability** | **A documentation word only:** an inventory row. Not a code concept | docs | – | – |

### 6.2 Answers

- **Should Capability stay equivalent to Tool?** No. The spec's own inventory has more capabilities
  than tools, and the code already uses "capabilities" for editing verbs
  (`editing/objects/capabilities.js`). Keep "capability" out of the code. In docs it means "anything
  Vellum can do", and a tool is a capability that has a discovery entry.
- **Should Tool be only metadata?** Yes, and after R1–R3 it truly is.
- **Should Command stay the sole execution mechanism?** For everything interactive, yes. For
  automation, the operation layer beneath it (§17). Both already exist in outline. Nothing new
  executes.
- **Should Action stay implementation only?** Yes, as a UI workflow layer. Don't let Tools, Home or
  the catalog call `actions.*` directly. The context and thumbnail menus do today. That is Phase 5's
  job, not a pattern to copy.
- **Does search metadata belong to the Tool?** Aliases and blurb, yes. They are discovery words. The
  command's `label` stays canonical and is read, never copied.
- **Does availability belong in a requirement system?** Yes, attached to commands (§8).
- **Does recommendation belong in a separate rules module?** Yes, and that module also owns selection
  relevance (§14).

### 6.3 Overlaps that will confuse future engineers

1. **"Tools"** means the new surface, the toolbar mode group (`aria-label: 'Tools'`,
   `toolbar.js:50`), the palette group `Tools`, the `tools.*` command ids and annotation modes
   (`setTool`). The spec handles the code side. The accessible-name collision starts in Phase 2, not
   Phase 5 (Q12).
2. **"Capability"**, as above.
3. **"Action"** means `actions.*` (workflows), the menu item property `action:` (a callback) and the
   toast `action: { label, run }`. It is established usage. Don't add a fourth meaning.
4. **"Catalog"** means `web/js/catalog/` (tools) and, in the uncommitted Intelligence prototype on
   main, `intelligence/catalog.json` (models). Whichever lands second should name itself for what it
   holds. For Tools, keep `catalog/` and export `TOOLS` and `CATEGORIES`, which is unambiguous in code.

## 7. Catalog architecture

### 7.1 Module by module

| Module (spec) | Responsibility clear? | Separate? | UI state? | Verdict |
|---|---|---|---|---|
| `catalog/catalog.js` | Yes: data | Yes | No | **Keep.** Remove `requires`, `presentIf` and `preset`. Defer `related` (no screen in the spec renders it). Keep `scope` as a display-only hint |
| `catalog/search.js` | Yes: normalise, index, rank | Yes | No | **Keep, and make it generic** (items plus field weights), because the palette uses it too (§9) |
| `catalog/context.js` | Two jobs: snapshot app state and evaluate requirements | – | **Yes** (sidebar, selection, the active view) | **Move out** to `web/js/requirements.js`, next to `commands.js`. It serves every surface, reads live state, and isn't discovery |
| `catalog/recommend.js` | Yes: relevance rules | Yes | No, if signals are passed in | **Keep** (Phase 4). It also owns selection relevance. Pure over a signals object |
| `catalog/store.js` | Yes: recent and favorites | Yes | No (localStorage only) | **Keep** (Phase 3). About 40 lines, but three callers (Tools, palette, Home) and the only module touching storage |

That gives four catalog modules plus one app-level module. Only `catalog.js` and `search.js` are
needed in Phase 1. It isn't too granular: each module has one reason to change and a different
Node-test profile.

**Second-framework risk: low, if three rules hold.** (1) `catalog/*` imports nothing from `ui/*`, no
`bridge.js`, no DOM and not `commands.js`. The command registry is passed in as data. (2) No catalog
module holds a function that decides execution. (3) `recommend.js` stays a priority-ordered list,
never a scoring engine.

### 7.2 Recommended record shape

```js
// web/js/catalog/catalog.js: data only.
export const TOOLS = [
  {
    id: 'merge-pdfs',             // task slug: never the category, never the command id; never reused
    name: 'Merge PDFs',
    blurb: 'Combine several PDFs into one new file',
    category: 'organize', section: 'combine',
    command: 'pages.merge',       // the command that runs it; availability is read from it
    variants: null,               // e.g. [{ label: 'Right', command: 'pages.rotateRight' }, …]
    aliases: ['combine', 'join pdfs', 'put together', 'merge files'],
    fits: null,                   // relevance only, e.g. 'selection.text'; never gates (§14)
    scope: 'files',               // display hint only; nothing executes on it
    icon: null,                   // default: the command's icon
  },
];
```

**Invariants (tested):** every `command` and `variants[].command` exists. **A command backs at most
one tool,** so recording, alias joining and future operation links are unambiguous. Every tool's
command has a `label`. No tool's command has `palette: false` unless the owner allows it.

## 8. Availability / context architecture

### 8.1 Where it lives

Put availability on the command, next to the `doc` flag it generalises:

```js
'tools.compress': { group: 'Tools', icon: 'minimize-2', doc: true, requires: ['writable'], label: 'Compress PDF…', run: … },
'ai.summarize':   { …, doc: true, presentIf: 'ai.local', … },   // future
```

`doc: true` keeps its meaning, and the evaluator reads it as `document`. Nothing changes for
existing surfaces until they choose to read `requires`.

`web/js/requirements.js` (app-level, pure except for one function):

- `REQUIREMENTS`: name → `{ met(snap), reason }`, where the reason is feature wording, referenced
  rather than copied where the feature exports it.
- `snapshot(app, ui, actions)`: the **only** function touching live state. Synchronous, reading
  getters only, never iterating pages.
- `availability(command, snap)` → `{ present, available, reason }`.

The palette, More menu, Tools and later the context menus all call `availability()`. That is what
makes §18.3's "one evaluator for every surface" achievable. With the catalog owning requirements, it
could only ever cover tool-backed commands.

### 8.2 Will the vocabulary scale?

Yes, if it stays **flat names with implicit AND**, and three rules stop it becoming a conditional
language:

1. **A predicate must be synchronous and O(1),** reading getters that exist. Anything that has to read
   the document (text, structure, font checks) is the action's refusal, not a requirement.
2. **Logic lives in the feature, and the vocabulary only names it.** `history` →
   `actions.history.canUse(view)` is the model. If a tool ever seems to need OR or NOT, the feature
   exports one predicate and the vocabulary gains one name.
3. **Presence is its own tiny namespace** (`engine.office`, `engine.signing`, `ai.local`…), resolved
   by the provider at startup or idle and exposed as a synchronous getter plus a change event, so an
   open palette or sheet can refresh. The catalog never awaits.

| Future state | Kind | Name |
|---|---|---|
| Office provider available | presence | `engine.office` |
| AI provider available | presence | `ai.local` (from `AIProvider`) |
| Signing engine | presence | `engine.signing` |
| Encryption engine (set a password) | presence | `engine.encryption` |
| Encrypted / protected file | requirement | `writable` (unmet); a positive `encrypted` for "remove password" |
| Read-only document (for example a history snapshot) | requirement | `writable`, defined **once** by the document (`canEditPages` or a successor), never assembled in the evaluator |
| Document type (XFA, signed, PDF/A) | **signal**, not a requirement | recommendations; actions refuse or confirm |
| Text / object / picture selection | requirement *only* where the command can't run without it | `selection.objects`, `selection.picture` |
| Page selection | relevance (page commands fall back to the current page) | `fits: 'pages.selected'` |
| Batch-capable | **neither**: a property of an operation (§17) | – |

That is 8 names in V1 and roughly 12–14 once the planned features land. That is a vocabulary, not
a rules engine.

### 8.3 The More menu

Move its `disabled:` expressions (`app.js:570–591`) onto `availability()` **in Phase 1** instead of
testing agreement with them. There are four patterns (`ready`, `canEditPages`, `encrypted`,
`history.canUse`), all of them already vocabulary names. Once moved there is nothing to disagree
with, and the test that can't be written (§4.2) is no longer needed.

## 9. Search architecture

**One engine, several surfaces: yes.** It is simple enough, and the palette should consume it.

1. **Make it generic.** `search.js` exports `normalise(text)`, `indexItems(items, fields)` and
   `rank(index, query, context)`. Tools feeds tool records (name, aliases, section and category,
   blurb, and the command label joined in). The palette feeds commands (label, group, and the aliases
   of the tool the command backs) and recent files (name, folder). Weights are data per surface.
2. **Score each token once across fields.** For each query token, take the best (tier × field weight)
   over all fields, then sum over tokens. The spec indexes the name (×3) and the command label (×1),
   which are nearly identical for most tools ("Compress PDF" and "Compress PDF…"). Summing per field
   double-counts tools whose name equals their label, against tools with distinct names.
3. **Rank by match band, then context.** Additive boosts (up to +66) can overturn tiers on low-weight
   fields (§4.2). Sort by (a) band: phrase > ordered > all tokens exact > prefix > inner > typo; then
   (b) text score; then (c) context (available, favorite, recent, recommended); then (d) catalog
   order. "Context only reorders within a band" is exact and testable.
4. **Direction words and numbers are optional tokens.** Under AND, ` 2 ` → ` to ` makes "rotate 2
   pages" require "to", so nothing matches (R8). Make `to`, `into` and digit-only tokens *optional*:
   they never exclude a result, and they feed the phrase and ordered bonuses (which is what separates
   "pictures to pdf" from "pdf to pictures").
5. **Should context influence ranking?** In Tools, yes, within a band. In the palette, no. It stays
   neutral and predictable, apart from its existing hiding of document commands with no document.
6. **Pin the palette's current behaviour** with one invariant: *for every command label, typing the
   exact label ranks that command first.* That protects §26's promise.
7. **Watch the fallback noise.** There are 41 "New text in …" font commands (`commands.js:168–173`),
   so "text" or "font" would fill the Tools fallback. Add "text" and "font" to the golden table and
   tune there, not with special cases.

No AI, no embeddings, no dictionary stemmer, no index structure. The spec's performance estimate
(well under 1 ms per keystroke for about 50 tools, or 150 commands in the palette) holds.

## 10. Command palette integration

- **Palette stays command-driven.** It keeps listing every command with a label, grouped by `group`,
  and gains (a) the shared engine and (b) aliases **joined per command** from the catalog. An alias
  appears only when its command exists and is present, which holds automatically because the palette
  iterates commands.
- **Category names don't affect palette ranking,** and the palette doesn't regroup by Tools category
  (Q11). That would couple the palette's browse view to a taxonomy still under review. Do fix the
  `GROUP_ORDER` omissions (Tools, Forms, Bookmarks, Links) now: that is a one-line bug fix.
- **No cycles.** `ui/palette.js` → `catalog/search.js`, `catalog/catalog.js` (and later
  `catalog/store.js` to record use). `ui/tools.js` → `catalog/*` and `requirements.js`. `catalog/*`
  imports neither surface. The "More commands" fallback in Tools reads the command registry passed
  to it, never the palette. Enforce this with a static import check in the Node suite.
- **Load lazily.** The palette starts importing `search.js` and the catalog on its first `open()`,
  and renders when they resolve. The input is focused at once, and the first render uses whatever has
  been typed. That keeps the startup budget honest (R10).

## 11. Tools sheet architecture

### 11.1 Form

| Option | For | Against | Verdict |
|---|---|---|---|
| **Modal sheet** (spec) | Same kind of surface as the palette and dialogs; document stays visible under the scrim; no new navigation model; lazy and temporary; focus handling is known | Largest blurred surface in the app; tight at 560 × 400 | **Recommended** |
| Full-page Tools workspace | Room for growth; no blur | Hides the document; needs a second back/navigation model; Vellum has no app-level routing | Rejected |
| Sidebar | Always one click away | Sidebar is 212 px and about pages; permanently takes width from the PDF (Vision §2.5) | Rejected |
| Command-centre overlay (search only) | Minimal | That is the palette. Browsing by intent is the point of Tools | Covered by the palette |
| Hybrid (palette gains a Browse mode) | One surface | Slows and complicates the fastest path; mixes two focus models | Rejected. The shared engine gives the same benefit at the data level |

### 11.2 Requirements the spec should add

1. **A shared modal helper, not a Tools-private one.** `#app.inert = true` is clean, because
   `#overlay-root` is a sibling (`index.html:43`), and it is better than a hand-written Tab trap. But
   it is new, so put it in `ui/focus.js` (for example `openModal(root)` returning a `close()` that
   removes `inert` **before** `restoreFocus`, which refuses anything inside `[inert]`, `focus.js:11`).
   Dialogs and the palette can adopt it later.
2. **Don't open over another modal.** The shortcut's `when` returns false while
   `[aria-modal="true"]` or `[data-own-keys]` exists. Dialogs don't set `data-own-keys`, so today a
   global shortcut can fire under a dialog.
3. **Keep the selection intact (verify R11).** Focusing the search field probably moves the page's
   text selection. Take the context snapshot **before** the sheet is inserted, and check with one
   targeted e2e step that Highlight run from Tools marks the selected text. If it doesn't, save the
   `Range` on open and restore it before running a tool that `fits` a text selection. The same issue
   may already affect Highlight from the palette. Check it once; don't assume.
4. **Size down to the window minimum.** 560 × 400 gives a sheet of about 512 × 310. Below about
   480 px of height, drop the tile grid to a single-column list and let the content scroll. Add a
   560 × 400 screenshot to the review set.
5. **`data-own-keys` is required,** not optional: with focus on the rail or the rows, single-letter
   shortcuts (V H U N D E) would otherwise fire under the sheet.
6. **Future category growth:** 8 rail items plus 3 fixed items fit a 312 px-tall sheet only with
   scrolling. The rail must scroll, independently of the content.

Keyboard, roles and semantics in spec §22 are sound (combobox and listbox as in the palette, a tab
list for the rail, list rows with roving focus). Keep them.

## 12. Material / motion architecture

**Sound as proposed.** Every token the spec names exists. `data-glass="off"` sets `--glass-float`
to `--surface` and `--blur` to `none` (`app.css:137–140`). Reduce motion sets every duration to 0
with `!important` (`app.css:2330–2337`), so the spec is right that nothing may wait for
`transitionend` (dialogs do, with a 250 ms fallback, `dialogs.js:30–31`). The spec's choice of the
palette's **unblurred** scrim, rather than the dialog scrim's `blur(3px)` (`app.css:928`), is correct:
a blurred scrim under a blurred sheet doubles the filter work.

**What drives the cost:** blurred device pixels (sheet area × DPR²; about 1.5 MP at 980 × 700 and
150 %), the filter itself (`blur(24px) saturate(1.6)`), and **how often the backdrop changes**. During
the open animation, the scrim fades and the sheet scales every frame, so the backdrop filter is
recomputed every frame for 220 ms. pdf.js still painting pages underneath does the same. Once static,
the cost is close to zero.

**How to measure (Phase 2, one targeted run):**

- **Where:** the generated `large` fixture (200 pages), with pages rendered under the sheet and a
  zoom change just before opening so painting is still in progress; the window maximised at the
  device's DPR.
- **What:** an in-page rAF interval sampler over open, category switch, typing and close, plus the
  Long Animation Frames observer (feature-detected) for frames over 50 ms.
- **A/B in the same run:** blur on, then `data-glass="off"`, so machine noise cancels.
- **Record first, judge second** (the performance suite's convention). A reasonable bar afterwards:
  p95 frame interval during open within 1.25× the refresh interval, and no long animation frame over
  50 ms.
- **If over budget, in this order:** open with opacity only (no scale) → the spec's component-scoped
  94 % `--glass-float` with a reduced blur, recorded in DESIGN_SYSTEM.md first. No new switches.

Dark mode, custom accent and System mode need no code, because every colour is a token. Contrast
checks must be e2e (computed colours), since the tokens are derived in CSS through `color-mix`.

## 13. Persistence architecture

**localStorage `vellum.catalog` is right for 1.0 (Q14).** It matches where appearance and annotation
colours live (ARCHITECTURE_GUIDELINES, "Feature state lives with the feature"). It needs no bridge
calls and no host schema. It is isolated in e2e because `VELLUM_DATA_DIR` holds the WebView2 profile
(`run.mjs:10–13`). It never holds document data. AppSettings would add a bridge round trip and a C#
schema for low-value data. If UI preferences ever move to the host, move them **all** together, not
favorites alone.

Specifics:

- Shape `{ v: 1, recent: [{ id, t }], favorites: [id] }`, as specified. Unknown ids are dropped on
  read.
- **No id renames, by rule** (§27). If one is ever unavoidable, a `RENAMED` map in `catalog.js` is
  applied on read. Don't build it until needed.
- **Recording scope stays as the spec says:** Tools, Home and the palette. Recording every surface
  would need a hook on every `run` (a registry decoration in `app.js` is possible) and would write
  storage on every H or U press. Defer (§26).
- Map a command to its tool through the catalog. The "one command, at most one tool" invariant
  (§7.2) makes this exact.

## 14. Recommendation architecture

**Location:** `catalog/recommend.js`, pure. Signals are **gathered** by a small collector in
`ui/tools.js` from feature-owned getters (`formFieldCount` and `attachmentCount` on `DocumentView`,
`hasUsableText` for the current page), and **passed in**. The module never touches the view.

**Keep it a list, not an engine:**

```js
export const RULES = [   // priority order; first 3 distinct available tools win
  { tool: 'recognize-text', when: (s) => s.pageHasText === false, reason: () => 'This page has no text layer. OCR makes it searchable.' },
  { tool: 'fill-form',      when: (s) => s.formFields > 0 && !s.encrypted, reason: (s) => `This PDF has ${s.formFields} form fields.` },
  // …
];
export const FITS = { 'selection.text': …, 'selection.objects': …, 'pages.selected': … }; // the selection strip
```

- **One module for both kinds of relevance:** document facts (the landing strip) and selection fit
  (the "For your selection" strip, driven by each tool's `fits`). No UI file names a tool.
- **Dismissal** ("Not now") is session memory in `ui/tools.js`: a `WeakMap` from view to dismissed.
  It is never persisted.
- **Scanned-page signal (Q9):** acceptable if it is async after the sheet's first paint, reads the
  current page only, is cached per view and page, is skipped for encrypted documents (their text
  isn't read, `app.js:303`) and on Home, and is dropped if the sheet closes first.
- **No feature-owned recommendation code.** Features own *signals* (facts), and the rule table owns
  *suggestions*. That keeps the UI free of feature conditions and the features free of Tools
  knowledge.

## 15. Category architecture

**Keep the taxonomy** (Edit, Review, Organize, Convert, Fill & Sign, Protect, Optimize, Research;
Automate reserved). The boundary tests in spec §5.2 are the strongest part of the IA and should go
into the placement rules.

| Challenge | Assessment |
|---|---|
| Review vs Annotate | **Review.** It honestly holds Compare and History, which aren't annotation. "annotate", "markup" and "comment" become aliases |
| Optimize | Keep. The rule "still a PDF, made fitter for a purpose" is clear. OCR is the weakest fit (people think "make searchable" or "scan"); aliases carry it. Don't move it: Convert's rule (the format changes) would be broken |
| Research | Keep over "Understand", as the spec argues. Local AI tools land here (§16) |
| Fill & Sign | Keep. The "Create a form" section is really form authoring. If it grows past about 6 tools, the owner decides whether it becomes its own category |
| Protect with 2 tools | Keep. "password" is correctly a forbidden alias until real encryption exists |
| Growth and cap | Keep the 2–14 rule, sections above 8, and 14 as a hard test. **Cap categories at 9 visible** (8 plus Automate). A tenth needs the owner, because the rail and tile grid are designed for 8–9 |
| Are sections enough for large categories? | Yes, up to 14. Organize at 12 is the one to watch; nothing planned adds to it |

Because tool ids won't contain categories (R2), renaming or rebalancing a category is a data edit
with no migration. That is what keeps the taxonomy safe to revise after 1.0.

## 16. Future feature compatibility

| Capability | Category / section | Catalog representation | Gate (on the command) | Command vs operation | Clean? |
|---|---|---|---|---|---|
| Office → PDF | Convert / To PDF | **One tool** "Office files to PDF" (the picker accepts all three; one engine), aliases "word to pdf" and so on. Split per format only if the workflows differ | `presentIf: 'engine.office'` | Command opens the picker; operation `office.toPdf(bytes, { format })` | Yes |
| Repair | Optimize | One tool | `document` | Operation bytes → bytes; batchable | Yes |
| Passwords | Protect / Security | "Add a password" and "Remove the password" | `presentIf: 'engine.encryption'`; `writable` / `encrypted` | Operation with a secret parameter (never persisted in a Flow) | Yes, once the positive `encrypted` name exists |
| Permissions | Protect / Security | One tool | as passwords | Operation | Yes |
| Metadata cleaning | Protect / Privacy | One tool | `writable` | Operation; batchable | Yes |
| Digital signatures | Fill & Sign / Digital signatures | "Sign with a certificate", kept apart from "Add signature" (a picture) | `presentIf: 'engine.signing'`, `writable` | Command first (certificate choice is interactive); operation later | Yes |
| Batch processing | **Automate** appears | One tool "Process many files", which opens Batch Center | none | Batch Center lists **operations**, named through the catalog. No `batch: true` on tools | Yes, if steps are operations |
| Vellum Flow | Automate | One tool "Workflows" | none | Steps are operation ids plus parameters | Yes, if steps are operations |
| Local AI summaries | Research | One tool | `presentIf: 'ai.local'`, `document` | Command opens a panel; operation text → summary via `AIProvider` | Yes, and hidden in the palette too (R1) |
| Local AI Q&A | Research | One tool | same | Interactive: command only | Yes |
| Translation | Convert (a new document), per spec | "Translate document" is a tool; "translate selection" is contextual (the selection bar), not a tool | `presentIf: 'ai.local'` or an engine | Operation for the document | Yes |
| Structured extraction | Research (read) / Convert (file out) | One tool per outcome, following the boundary rule | per engine | Operation for the file output | Yes |
| Document intelligence | Research | Individual tools, never an "Intelligence" category (brand words are banned) | `presentIf` | Mixed | Yes |

Every row fits **only** with R1 (command-level presence), R2 (stable ids) and R3 (no presets), which
is the case for making those changes before Phase 1 rather than after.

## 17. Batch / Flow / Operations boundary

**Should Vellum evolve toward `Capability → { UI command, Operation }`?** Yes, and the code is
already halfway there. The pure cores (`mergeDocuments`, `compressDocument`, `runExport`,
`imagesToPdf`, `composeDocument`) are headless and Node-tested. Commands and actions are the UI
binding around them. What is missing is a **registry of operations** with stable ids, serialisable
parameters and declared inputs and outputs. That is Vision §8's "operation pipeline", and it needs
its own spec before Automate.

```
             ┌── Tool (discovery: name, aliases, category) ──┐
 user goal ──┤                                                ├── points to
             │   Command (UI: resolves context) ──► Action (UI workflow) ──┐
             │                                                             ├──► Core (pure)
             └── Operation (future: id, params, run) ◄── Batch / Flow ─────┘
```

**Can the current command system safely grow to serve both?** No. `run()` resolves the *active
view* and *selected pages* and opens pickers and dialogs, and those are exactly what Batch and Flow
must not depend on. Stretching commands to run headless would mean every `run` branching on "is
there a UI". Keep commands UI-bound and build operations beside them, over the same cores.

**Can a Tool id safely become a Batch/Flow step id?** It wouldn't couple automation to commands,
because tool ids are already independent of command ids. It *would* couple saved workflows, which
are files on disk that must keep working for years, to the discovery taxonomy, which is designed to
be revised. It would also break when one tool maps to several operations ("PDF to images": JPG or PNG)
or when an operation has no tool. **Recommendation:** step ids are **operation ids**. A tool gains an
optional `operation` link when Automate appears, and the Automate UI names steps through that link.
Automation never reads `tool.command`.

**What this changes in the catalog now (and nothing more):**

1. Tool ids are category-free task slugs (R2).
2. No run parameters in the catalog (R3). Parameters belong to operations, or to per-variant commands.
3. No `batch: true` flags or step fields until the operation registry exists.

**For the owner (not decided here):** Vision §3.10 says "each step is an existing command/operation".
This review recommends recording "steps are operations" under Vision §13 *Open decisions* when the
owner agrees. This review doesn't edit the Vision.

## 18. Testing architecture

### 18.1 Node (`tests/catalog/*.test.mjs`): deterministic, most of the protection

| Test | Change from spec |
|---|---|
| Registry integrity | As spec, **plus**: "a command backs at most one tool"; build the registry with `createCommands({}, {}, {})` (safe once §21 is done: creation only builds closures) |
| Layering | **New:** `commands.js`, `requirements.js` and `catalog/*` import no `ui/*`, no `bridge.js`; `catalog/*` doesn't import `commands.js`. A static regex over the import lines |
| Categories and aliases | As spec |
| Search golden table | As spec, **plus** "text", "font", "rotate 2 pages", "convert to word"; band ordering; the exact-label invariant over every palette command |
| Ranking determinism | Rewritten as "context reorders only within a band" (§9) |
| Availability | Against `requirements.js` fixtures, per **command** |
| More-menu agreement | **Replaced**: the More menu reads `availability()` in Phase 1 (§8.3) |
| Recommendations | As spec, plus `fits` for the selection strip |
| Store | As spec |

Put the catalog tests beside the engine tests, with one documented command:
`node --test "tests/editing/*.test.mjs" "tests/catalog/*.test.mjs"`. Record it in CLAUDE.md and the
Testing section of ARCHITECTURE_GUIDELINES in Phase 1, and reuse `webModule` from
`tests/editing/harness.mjs`.

### 18.2 End to end (`tests/e2e/suites/tools.mjs`): routing and presentation only

The spec's cases are right, with these changes:

- Expose `window.__vellum.commands` (one line in `app.js`) rather than reaching through
  `ui.palette.commands`. Spies replace `commands[id].run`, which works because every surface looks up
  `c.run` at call time.
- **Stub every tool the suite activates.** Never let a real picker open. There are no
  `fillFileDialog` calls in this suite.
- Add: the selection survives opening (§11.2), the sheet doesn't open over a dialog, and a 560 × 400
  screenshot.
- Reduced motion, reduced transparency and dark contrast as specified (computed styles).
- `export const timeoutMs = 120000`. Every wait ≤ 5 s. One `area` per case.

## 19. Test safety review

How the 16 rules in spec §25 stand in the current infrastructure:

| Rule | Enforced by code today? | Gap → fix |
|---|---|---|
| 1 Hard timeouts | Partly: `connect` 60 s (but `fetch` and the WebSocket open are unbounded), `waitFor` between calls only, native dialog helpers ✔, window placement ✔ | CDP `send()` timeout; suite deadline; bound `prepare`, `cleanup`, `dotnet build` and `taskkill` (§20) |
| 2 No unbounded loops | `waitFor` and `viewportSettled` are bounded between calls | Bounded once `send()` is |
| 3 Retries ≤ 1 | ✔ Nothing retries | – |
| 4–6 Stop; no re-run; no second copy | ✔ `run.mjs:34–38` refuses when Vellum is running | – |
| 7 No indefinite waits on dialogs or processes | ✔ for the shared helpers (`native-dialog.mjs`, `window.mjs`); ✘ for a page-opened dialog blocking an evaluation; ✘ for seven synchronous child processes with no `timeout`: `history-move.mjs:72` (PowerShell filling the **real Save dialog**), `updates.mjs:83` (Inno Setup), `:107` (`dotnet build`), `:199` and `:421` (PowerShell), and `run.mjs:43` and `:103` | `send()` timeout; a `timeout` (plus `killSignal`) on every `spawnSync`. Both suites run only when named, so the default run isn't exposed today |
| 8 Kill the tree and report | ✔ `taskkill /T /F` in `finally`, **once reached** | Reached on every path once §20 is done |
| 9–10 Seams over GUI; native dialogs fail fast | ✔ `stubOpenDialog`, bridge stubs | – |
| 11–13 Human rules | Discipline | – |
| 14 Report infrastructure failures | Discipline | – |
| 15 Compact output | ✔ 600 and 800 character trims | Keep timeout diagnostics to one line plus the last 5 `__vellum.errors` |
| 16 Targeted suites | ✔ Named suites | – |

**Recommended additions to the rule text:** (a) no synchronous blocking call in a suite without a
`timeout`. `Promise.race` can't pre-empt `spawnSync`, which blocks Node's whole event loop. The shared
helpers already follow this; the seven calls listed under rule 7 don't, and should be fixed in step 1a; (b) one deliberately hanging self-test suite, `selftest-timeout`, that runs only when named. It
evaluates `new Promise(() => {})` and must fail within its limit, which proves the guardrail
deterministically.

**This session's compliance:** two Node import probes (20 s limit each, no side effects). No app
launch, no e2e, no regression, no retries.

## 20. E2E runner timeout review

**The proposal** is `Promise.race(suite.run(t), timeout)`, a 180 s default, `suite.timeoutMs`, and a
`finally` that kills the process tree.

| Question | Assessment |
|---|---|
| Is 180 s sensible? | **Not as a flat default.** Single waits already reach 180 s (`performance.mjs`), 120 s (`ocr`, `ocr-unicode`, `ocr-languages`) and 60 s (`pdfa`, `editing-store`). Print each suite's duration first, then set the default a comfortable margin above the slowest *default* suite, with explicit `timeoutMs` for `performance`, the OCR suites and `updates`. The new `tools` suite should be tight (120 s) |
| Is `Promise.race` safe? | Yes as a backstop. It doesn't cancel `suite.run`, so: `clearTimeout` on normal completion; `c.close()` in `finally`; mark the context dead so a late `check()` from the orphan neither prints nor adds to the report (`results` is kept by reference until `report.json` is written) |
| Is cleanup guaranteed? | Only for `run`, and only if nothing inside it blocks synchronously. `suite.prepare()` (`run.mjs:76`) and `suite.cleanup()` (`105`) are unbounded; `dotnet build` (`43`) and `taskkill` (`103`) have no `timeout`; and `history-move.mjs:72` and four calls in `updates.mjs` are unbounded `spawnSync` calls that no `Promise.race` can interrupt (§19, rule 7). Bound all of them |
| Are rejected promises handled? | Yes. `Promise.race` subscribes to both, so a later rejection of either is handled, not unhandled. Still clear the timer |
| Is process-tree cleanup reliable? | `taskkill /PID … /T /F` covers Vellum and its WebView2 children. Once the socket closes, the orphan's next CDP call stays pending, because `send()` never rejects. Once `send()` rejects on close, it fails fast instead |
| Are diagnostics compact? | Yes, if the timeout path records one line (suite, limit, last `area`) plus the last 5 `__vellum.errors`, captured with a **bounded** evaluation (≤ 5 s) or skipped. The page may be the thing that hung. Screenshot only through a bounded call |

**The root-cause fix belongs in `tools/cdp-client.mjs`:** a per-request timeout in `send()`
(overridable per call, because some suites await long operations in one evaluation; audit them
before choosing the default), and rejecting every pending request on `ws.onclose` and `ws.onerror`.
Then a hang becomes a precise failure ("Runtime.evaluate timed out: …") in seconds, instead of the
suite deadline minutes later. Give `connect()`'s `fetch` an `AbortSignal.timeout`. The suite deadline
remains the last line of defence.

## 21. Node registry test review

| Option | Assessment |
|---|---|
| **A. Move the UI dependency behind an action** | **Recommended.** `showAttachments` becomes `actions.attachments.show(view)`, wired in `app.js` like `actions.health` and `actions.history`. It removes the registry's only UI import, the one case where the registry breaks "the core never imports UI modules" |
| B. Dependency injection | Already the design: `createCommands(app, ui, actions)` *is* injection. The leak is one static import, not a missing DI mechanism |
| C. Test stubs | Needed only in the trivial form `createCommands({}, {}, {})`, which is safe because creation builds closures and reads `actions.pages` without calling it. **Don't** stub `globalThis.window` to get `bridge.js` to load: that hides the layering bug and ties the test to bridge internals |
| D. Split registry data from runtime | Rejected. Two files per command is the drift `commands.js` exists to prevent |
| E. Other | Add the layering test (§18.1) so the registry stays importable |

Result: after A, both remaining imports load in Node (probed), and the integrity test is real. The
change is about three lines plus a wiring line, in Phase 1.

## 22. Review of all 14 open questions

| Q | Recommendation | Reason | Blocks Phase 1? | Defer? |
|---|---|---|---|---|
| 1 Category names | Keep all 8 names; don't align the Vision's pillar names (pillars are scope, categories are intent) | Taxonomy is sound (§15). Category-free ids make later renames free | **No**, if ids are category-free | Must be settled before Phase 2 (visible) |
| 2 Sheet vs page | Sheet | §11.1 | No | Settle before Phase 2 |
| 3 Ctrl+T | **Not Ctrl+T.** Vellum already uses Ctrl+Shift+T for Reopen closed document, whose browser partner Ctrl+T means a new tab (Vellum's tab strip has one). Use Ctrl+Shift+A (free in `commands.js`; check once that WebView2 doesn't reserve it), or no key and only the title-bar button and palette | Avoid teaching the wrong shortcut and blocking "new tab" | No | Settle before Phase 2 |
| 4 Command arguments | **Defer.** Tools needs none if presets become commands (R3). When the menus consolidate: `run(e, args)`. **Never `run(args)`**: the first parameter is already the event | §2.1 | No | Yes, to Phase 5 |
| 5 More menu | Add "All tools…" first; keep the rest for 1.0; slim after, on the owner's judgement | No telemetry exists to decide from, so don't remove paths people know in the same release | No | Yes |
| 6 Export presets | Yes: `actions.export.run(view, { format })` pre-selects the dialog, exposed as **five commands** (`export.word`…) | Keeps tools thin and gives the palette "Export to Word…" | No (Phase 1 can add the commands) | Needed by Phase 2 |
| 7 Fill in form | Add `forms.fill` (scroll to and focus the first empty field) with `requires: ['formFields']` | Real, small, honest. The tool can't enter the catalog until the command exists (the integrity test ensures that) | No | Yes, any phase |
| 8 Collections | Home-only for 1.0 | A command needs a collection argument or picker | No | Yes |
| 9 Scanned-page signal | Acceptable, with the conditions in §14 | Current page only, async, cached | No | Phase 4 |
| 10 Comfort controls | Confirm: only Reduce transparency and Reduce motion | Two honest switches; nothing else exists | No | – |
| 11 Palette groups | Don't regroup by category; **fix `GROUP_ORDER`** now | Avoid coupling the palette to the taxonomy | No (the fix is Phase 1) | Regrouping: defer |
| 12 Tools/Modes | Rename the mode group's accessible name to "Modes" **in Phase 2**, when the second "Tools" appears | No test pins the label (tests use `.tool-seg`) | No | No: do it in Phase 2 |
| 13 Operations vs commands | Operations are a separate future registry over the existing cores; step ids are operation ids | §17 | No, apart from the three catalog constraints | Registry design: yes, before Automate |
| 14 Favorites storage | localStorage `vellum.catalog` | §13 | No | Revisit only if all UI preferences move to the host |

## 23. Alternative architectures

### A. The spec as written: the catalog owns tools, requirements and presets

- **Model:** Tool = discovery + availability + run preset. `catalog/context.js` evaluates.
- **Strengths:** everything about Tools lives in one folder. Fast to start.
- **Weaknesses:** the palette and menus can't share the evaluator (tool-backed commands only);
  `presentIf` can't hide palette entries (conflicts with Vision §3.9); presets are a second argument
  channel; category-shaped ids; five tools share one command.
- **Migration cost:** lowest now, and highest later: moving requirements to commands after Phase 5
  touches every surface twice.
- **Maintenance:** requirements are declared per tool, while commands keep `doc`, so two places to
  keep in step.
- **Extensibility:** weak for providers and automation.
- **Performance:** same as B.
- **Testing:** needs the agreement test that can't be written.

### B. Thin catalog, availability on commands (recommended)

- **Model:** Tool = discovery only. Command = execution plus availability (`doc`, `requires`,
  `presentIf`). One app-level `requirements.js`. Variants are commands. Operations come later as a
  separate registry that tools link to.
- **Strengths:** one evaluator for every surface; presence hides everywhere; the catalog can't drift
  from execution; ids survive taxonomy changes; automation has a clean seam.
- **Weaknesses:** Phase 1 touches `commands.js` (additive fields, five export commands, the
  attachments action). Two folders instead of one.
- **Migration cost:** small and additive. Existing behaviour is unchanged until a surface reads
  `requires`.
- **Maintenance:** adding a feature means command fields plus one catalog record. Removing it means
  deleting both, and the integrity test catches leftovers.
- **Extensibility:** providers, AI, signing and Batch/Flow all fit (§16).
- **Performance:** identical. Evaluation is O(1) per command, and a snapshot costs microseconds.
- **Testing:** everything important is Node-testable once §21 is done.

### C. Command-centric: discovery metadata on commands, no catalog

- **Model:** `aliases`, `blurb` and `category` added to each command. Tools reads the registry.
- **Strengths:** one file; the palette gets aliases natively; no join.
- **Weaknesses:** a tool isn't 1:1 with a command (variants, rotate left and right, OCR page and
  document); the volatile taxonomy and discovery wording would sit in the execution registry;
  `commands.js` would roughly triple in size; Home and recommendations would be keyed by command ids.
- **Migration cost:** medium. **Maintenance:** discovery changes churn the registry.
- **Extensibility:** poor for automation (it binds discovery to the UI layer).
- **Performance:** same.
- **Testing:** simpler integrity, harder golden tests.

*(D. A unified capability registry with commands **and** operations built now:* rejected as premature.
Automate isn't approved, and designing operations without a first real batch feature would guess
their shape.)

## 24. Recommended architecture

```
                      ┌──────────────── surfaces ────────────────┐
                      │ Tools sheet · Home row · palette · menus │
                      └───────┬──────────────┬───────────────────┘
                 discovery    │              │  execution + availability
      ┌───────────────────────▼───┐    ┌─────▼─────────────────────────────────┐
      │ catalog/  (no UI, no DOM) │    │ commands.js   id → label, keys, group, │
      │  catalog.js  TOOLS, CATS  │───►│               doc, requires, presentIf,│
      │  search.js   shared engine│ id │               run(e)                   │
      │  store.js    recent/favs  │    │ requirements.js  snapshot + availability│
      │  recommend.js relevance   │    └─────┬─────────────────────────────────┘
      └───────────────────────────┘          ▼
                                    actions.*  (UI workflows, explicit params)
                                             ▼
                                    cores  (pure; Node-tested)  ◄── operations (future) ◄── Batch / Flow
```

**Dependencies point one way:** surfaces → catalog, commands, requirements; catalog → nothing app- or
UI-specific; commands → actions (no `ui/*` imports); actions → cores; future operations → cores.
Automation never reaches commands or `tool.command`.

## 25. Recommended implementation plan

Small steps, each tested and reported before the next (Vision §8). Steps 1a–1c are Phase 1.

| Step | Delivers | Tests |
|---|---|---|
| **1a. Test infrastructure** (its own commit) | `send()` timeout and reject-on-close in `cdp-client.mjs`; suite deadline in `run.mjs` (race, `clearTimeout`, `c.close()`, dead context); bounded `prepare`, `cleanup`, `build` and `taskkill`; a `timeout` on the unbounded `spawnSync` calls in `history-move.mjs` and `updates.mjs`; per-suite durations printed; `selftest-timeout` suite (named only); the test-safety rule copied into ARCHITECTURE_GUIDELINES | `selftest-timeout` fails within its limit; **one** targeted suite (for example `regression`) still passes. No full run |
| **1b. Registry hygiene** | `actions.attachments.show`; `requires` and `presentIf` fields on commands; `requirements.js`; More menu reads `availability()`; `GROUP_ORDER` fix; five `export.*` commands plus `actions.export.run(view, { format })`; the §18.4 mode audit (enter the mode or refuse, never silently do nothing) | Node: registry importable, layering, requirement fixtures. E2E: `export`, `regression` |
| **1c. Catalog and search** | `catalog.js` (48 tools, task-slug ids), generic `search.js`, palette on the shared engine (lazy), aliases in the palette | Node: integrity, aliases, golden table, bands, exact-label invariant. E2E: `accessibility` |
| **2. Tools sheet** | After the owner answers Q2, Q3, Q6 and Q12: `ui/tools.js`, shared modal helper, title-bar button, shortcut, `app.tools`, "All tools…" in More, "Modes" rename, unavailable reasons, keyboard and screen-reader semantics | E2E `tools`; blur A/B measurement; selection-survival check; screenshots including 560 × 400 |
| **3. Recent, favorites, Home row** | `store.js`; recording from Tools, Home and the palette; Home row loaded after first paint | Node store; e2e recent and favorites |
| **4. Recommendations and the selection strip** | `recommend.js` (rules plus `fits`); signal collector | Node rule fixtures; e2e form-field and scanned fixtures |
| **5. Consolidation** *(each item decided by the owner)* | Menus onto commands (with `run(e, args)` if approved); More menu slimmed | Existing suites plus menu snapshots |
| **Before Automate** | An operation-registry spec (ids, parameters, inputs and outputs, progress, per-file results) | Its own |

## 26. Deferred decisions

Safe to defer, because nothing in Phases 1–4 depends on them:

- the command argument channel (`run(e, args)`), Phase 5
- slimming the More menu; palette grouping by category
- *Research a collection* as a command
- favorites or recent in AppSettings
- recording Recent from every surface (registry decoration)
- the `related` field (add it when a screen renders it)
- `scope` moving onto commands (when a second consumer appears)
- the operation registry and step ids (before Automate, in its own spec)
- forced-colours rules for the palette and menus (Tools does its own in Phase 2)
- a central command dispatcher. Not needed. Revisit only if automation or availability enforcement
  requires it

**Don't over-engineer:** no dispatcher, no argument channel, no operation registry, no `batch`
flags, no index structures or fuzzy matching beyond distance 1, no virtualisation, no new animation
system, no scoring engine for recommendations, no AppSettings sync, no Material Intensity, Glass
Effect or High Performance Mode, no animation per keystroke.

## 27. Architecture rules for future contributors

1. **Commands are the only thing that runs.** A tool names a command. It never executes, gates or
   carries run parameters.
2. **Availability is declared on the command.** `requires` names are synchronous, O(1) predicates
   with a reason. When a condition needs logic, the feature exports the predicate and the vocabulary
   gains one name.
3. **Presence hides a command everywhere,** the palette included. No provider, no entry point.
4. **A tool record is discovery data:** id, name, blurb, aliases, category, section, command and
   variants, `fits`, display `scope`, icon.
5. **Tool ids are task slugs:** never the category, never the command id, never reused, never
   renamed.
6. **Variants and presets are commands.** One command backs at most one tool.
7. **Layering is tested:** `commands.js` imports no `ui/*`; `catalog/*` and `requirements.js` import no
   `ui/*`, no `bridge.js` and no DOM; `catalog/*` doesn't import `commands.js`.
8. **No surface names a tool id,** apart from the catalog's own data and tests.
9. **One search engine.** Surfaces supply items and weights. Context only reorders within a match band.
10. **Recommendations are facts, cheap and listed** in `recommend.js`. Features own signals, never
    suggestions.
11. **Automation binds to operations,** never to commands or `tool.command`.
12. **Placement procedure** (replaces spec §15 rule 2, which as worded would also give Print, Find and
    Save an entry):
    - *File lifecycle, navigation, zoom, view, app preference, clipboard or undo?* Not a tool. It
      stays on its fast path and the palette (Tools search may fall back to it).
    - *Only meaningful on something already selected, and discovered after selecting (formatting,
      arrange, transforms, deleting the thing under the pointer)?* Not a tool. Contextual bar and
      palette.
    - *Otherwise, would someone come looking for it by name before selecting anything ("merge PDFs",
      "black out text", "make it searchable")?* **Exactly one tool,** in exactly one category, by
      spec §5.2's boundary tests.
    - *Variants of one goal* (rotate left or right, OCR page or document) → one tool with variants.
      *Different goals by the user's own words* (PDF to Word vs PDF to Excel) → separate tools.
13. **Testing:** every blocking step has a limit; no synchronous call without a `timeout`; stop on the
    first timeout; targeted suites only.

## 28. Final go / no-go assessment

1. **Is the UX spec architecturally sound enough to implement?** Its UX, IA and execution model are.
   Its data model needs the changes below first. They are small, and they make the rest easier.
2. **What must change before implementation?**
   - (a) `requires` and `presentIf` move to commands, with one `requirements.js` evaluator.
   - (b) Category-free tool ids.
   - (c) No `preset`: five `export.*` commands, and "one command, at most one tool".
   - (d) `fits` (relevance) separate from `requires`.
   - (e) `showAttachments` behind `actions.attachments.show`.
   - (f) `cdp-client` request timeouts, a calibrated suite deadline, and a `timeout` on every
     `spawnSync`, all before any Tools e2e.
   - (g) Search ranked by band, with optional direction and number tokens.
   - (h) The More menu reads the evaluator instead of an agreement test.
   - (i) The startup budget restated, with lazy loading in the palette and Home.
   - (j) Not Ctrl+T.
3. **What should stay exactly as proposed?** The one-execution-system principle; the 8-category
   taxonomy and its boundary tests; the modal sheet, its keyboard and screen-reader model and its
   material recipe; lazy loading; deterministic search with golden queries and the alias contract;
   honest unavailable rows; restrained, fact-only recommendations; localStorage `vellum.catalog`;
   Automate hidden; the test-safety rule.
4. **What can be deferred safely?** §26.
5. **What should not be over-engineered?** §26 "Don't over-engineer".
6. **What is the correct architecture for future Batch/Flow compatibility?** An operation registry
   over the existing pure cores, with operation ids as step ids. Commands stay UI-bound. Tools link to
   operations when Automate appears (§17).
7. **What is the correct relationship between Tools, Catalog, Commands and future Operations?**
   Tools (UI) → Catalog (discovery data) → Command (execution plus availability) → Action (UI
   workflow) → Core. Batch/Flow → Operation → Core. The catalog points at commands now and may point
   at operations later. Nothing points back at the catalog (§24).
8. **What is the recommended implementation sequence?** 1a test infrastructure → 1b registry
   hygiene → 1c catalog and search → 2 sheet (after Q2, Q3, Q6, Q12) → 3 recent, favorites and Home →
   4 recommendations → 5 consolidation, each on the owner's decision (§25).

**GO** for Phase 1 (steps 1a–1c) once items 2(a)–2(i) are folded into the spec. **NO-GO** for Phase 2
until the owner has answered Q2, Q3, Q6 and Q12 and step 1a has landed.
