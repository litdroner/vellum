# Architecture guidelines

Easy to add, easy to remove, hard to break. Keep it practical: small modules with one job, one
registry for actions, and no framework.

## Layers

```
src/Vellum/                       C# host (WPF + WebView2)
  App.xaml.cs                     startup, single instance, file-association switches
  MainWindow.xaml.cs              window chrome + bridge handlers for files, recents, window, theme
  MainWindow.Updates.cs           bridge handlers for in-app updates (one partial file per host feature)
  Hosting/                        BridgeHost (JSON request/reply + events), AppResourceServer (serves UI and PDFs)
  Services/                       settings, recent files, updater, file association, single instance
  Services/Conversion/            Office → PDF: providers, selection, the office.toPdf operation, process runner
  web/                            the UI, served from https://app.vellum
    js/app.js                     composition root: creates the app, wires features together
    js/commands.js                THE registry of user actions (label, keys, icon, group, run)
    js/document-view.js           one pdf.js viewer per document: navigation, zoom, layout, save
    js/annotations/               annotation model (undo/redo), SVG layer, pdf-lib persistence, painting
    js/editing/                   text editing engine (no UI): content lexer + interpreter, fonts, runs
                                  (cross-checked with pdf.js), edit records, apply (writing), session
    js/pages/                     page plan (pure functions) + page actions (dialogs, menus, toasts)
    js/themes.js                  colour themes and appearance (data + apply)
    js/ui/                        one module per piece of UI (title bar, toolbar, sidebar, dialogs…)
    css/app.css                   the design system (tokens → materials → components)
```

Dependencies point one way: `ui/*` and features use `document-view` and the stores; the core
never imports UI modules. The host knows nothing about the UI beyond named bridge calls.

## Rules

- **Every user action is a command** in `commands.js`. Toolbar buttons, menus, shortcuts and the
  command palette all call commands, so they can't drift apart. A command has `label`, optional
  `keys`, `icon`, `group` and `when`, and `run`.
- **Feature state lives with the feature**: annotations in `AnnotationStore`, page plans and text
  edits in the same store (one undo history), appearance in `themes.js` + localStorage, host
  settings in `AppSettings`.
- **UI modules own their DOM** and talk to the rest through the app's events (`activechange`,
  `viewchange`, `tabchange`, `viewready`) and commands. No module reaches into another's DOM.
- **PDF bytes are only written by `annotations/persist.js`** (`composeDocument`), and only the host
  touches the file system (atomic saves via `/save/{token}`, paths registered by dialogs). Text edits
  are applied inside `composeDocument` by `editing/page-writer.js`, which rewrites only edited pages.
- **A shared object is never changed in place.** A Form XObject is drawn by any number of pages and
  any number of `Do` operators, so editing text inside one occurrence copies that form first and
  repoints only that one `Do` (`editing/objects/form-copy.js`). The original is only read. Hold to
  this for anything else a file shares.
- **Editing never guesses.** Text is only offered for editing when the engine's reading of it agrees
  glyph for glyph with pdf.js's (codes, text, widths, positions); anything else is refused with a
  reason. Keep that rule for future editors (images, forms, redaction).
- **The bridge is an allow-list**: each host call is a named handler that validates its input.
  Group related handlers in their own `MainWindow.<Feature>.cs` partial.
- Rendering the UI never re-renders PDF pages: themes and page colours are CSS only.

## Offline and privacy

Vellum is local-first: PDF documents are processed locally and Vellum does not upload document data.
Vellum's own network activity is limited to the GitHub update service and to OCR language packs the user
chooses to download (from GitHub, only on a click in Settings → OCR), while the Microsoft WebView2
runtime may make independent Microsoft connections.

User-facing wording (use this, or wording with exactly the same meaning):

> Vellum processes your documents entirely on your computer: no document, file name or document content
> leaves your PC. Vellum itself goes online only to check for updates and, when you ask for one, to download
> an OCR language pack, both from GitHub. Its display engine,
> Microsoft Edge WebView2 (part of Windows), makes its own connections to Microsoft, such as SmartScreen
> security checks and component updates, as it does in every app that uses it.

Never claim that Vellum makes no network traffic at all, that GitHub is the only traffic of the running
app (its WebView2 runtime included), or that WebView2 is offline. The evidence is in
`docs/WEBVIEW2_NETWORK_AUDIT.md`: a runtime measurement of what Vellum and WebView2 do on the network.

- Every PDF feature runs locally and keeps working with Wi-Fi and Ethernet off: reading, rendering,
  editing, annotations, pages, merging and splitting, and later conversion, compression, OCR,
  metadata, security, redaction, forms, signing, batch processing and workflows.
- No cloud processing, document uploads, cloud storage, online AI APIs, API keys, cloud sign-in,
  telemetry, analytics or third-party SaaS. Libraries and fonts are vendored (`web/vendor`,
  `web/fonts`); the page loads nothing from the internet (pdf.js's worker, CMaps, standard fonts,
  wasm and ICC profiles all come from `https://app.vellum`, see `pdfjs.js`).
- The page can't leave the app: navigating anywhere else is cancelled, and http(s)/mailto links in a
  PDF open in the user's browser (`NavigationStarting` in MainWindow).
- Vellum's only network code is the updater (`Services/Updater.cs`): it asks GitHub for the latest
  release and downloads the installer, sending no document data (just the version, in the User-Agent).
  The daily check is a setting ("Check once a day") and fails quietly; checking by hand and "What's
  new" after an update also ask GitHub.
- The WebView2 runtime connects to Microsoft on its own whatever Vellum does: SmartScreen checks
  Vellum's start page, plus Edge configuration, component updates (downloaded through Windows BITS) and
  other Microsoft services. It also looks up the hostname `app.vellum` in DNS at launch. None of this carries
  document data, and Vellum works without it. It stays as it is: SmartScreen stays on, no unsupported
  browser switches, no Windows settings changed. Re-run the audit after changing the WebView2 setup, the
  updater, or anything else that could touch the network.
- A future feature that needs the internet must be opt-in, behind an explicit setting the user
  controls, must say plainly what leaves the device, and must leave everything else working without
  it. No hidden requests, and never for PDF processing.

## Vellum Intelligence (future)

AI isn't in Vellum yet, and no AI UI may appear until a real provider exists. When it's added, it
goes behind one provider abstraction, so choosing local, cloud or hybrid stays a separate decision:

```
AIProvider              the interface features call (what it can do, whether it's available, requests)
├── LocalAIProvider     models running on the user's own hardware
└── CloudAIProvider     future: interface only, not implemented; no API keys, no cloud sign-in
```

- Features ask for the provider and work normally when there is none: their AI entry points simply
  don't appear.
- No document is sent to an external service. A cloud provider, if ever chosen, is its own opt-in
  decision and follows "Offline and privacy" above.

## Office conversion providers

Word, Excel and PowerPoint → PDF run in an Office application already on the PC, locally; Vellum bundles no
Office renderer and uses no conversion service. The host owns it (`Services/Conversion/`):

```
IOfficeProvider              Detect (installed? which formats? starts nothing) · BusyReason (now?) · ConvertAsync
├── MicrosoftOfficeProvider  Word / Excel / PowerPoint's own automation, in a child Vellum.exe --office-to-pdf
└── LibreOfficeProvider      soffice --headless --convert-to pdf, in a throwaway profile
OfficeConversion             selection, and the office.toPdf operation (OfficeToPdfRequest → ConversionResult)
ProcessRunner                the only way a provider starts a program: time limit, cancellation, whole tree ended
```

- **Three questions, three answers.** Installed at all (else `noProvider`), can convert this format (else
  `notSupported`: Office without PowerPoint), can run now (else `unavailable`: PowerPoint is open).
  Detection reads the registry and files only, and claims a format only when the real application is there:
  the COM server must be that application's own program, Office 2010 or later, each application on its own;
  LibreOffice's Writer, Calc and Impress each on their own.
- **Selection is fixed:** Microsoft Office, then LibreOffice — the first installed, capable and not busy. A
  failure is reported with the provider named, never retried with the other. A request may name a provider;
  there are no preference settings yet.
- **One operation, no UI in it.** `office.toPdf` takes full paths and returns a structured result (status,
  message, provider, output, diagnostics). The bridge's `office.toPdf` adds the Open and Save dialogs; batch
  processing calls the operation through `batch.office` with the files the person chose, and a workflow does
  too (held, when it is a step in between: see *Operations, batch processing and workflows*), never through a
  tool id. `office.providers` reports
  what the PC has, starting nothing (off the UI thread).
- **The tools** (`js/office/`): Word, Excel and PowerPoint to PDF, one per format, each `presentIf`
  `engine.office.word` / `.excel` / `.powerpoint`: present when an installed provider can convert the format,
  busy or not, read once from `office.providers` and again when a run finds no provider. A tool passes its
  format to the bridge, which refuses before any dialog when that format can't be converted now, and refuses a
  second request while one runs (never queued). `office-converting` tells the page the dialogs are done, so it
  shows the running conversion with Cancel (`office.cancel`); the page says the outcome from the result alone.
- **Files.** The source is only read: the provider converts a private copy under a plain name, in a work
  folder under the data folder that is removed afterwards (and swept at startup). The PDF must start as a PDF,
  is written beside its destination and moved into place, so a failure never touches an existing file. A
  password-protected .docx/.xlsx/.pptx is refused before anything starts; nothing is ever prompted for.
- **The process boundary.** One conversion at a time, each with a time limit (3 minutes by default, 30 at
  most) and cancellation. Programs run with no window and no shell, arguments one by one, inside a Windows job
  that ends whatever is left when the run ends or Vellum does. Past the limit the whole tree is ended, and so
  is the Office application the helper started — never one it didn't start: Vellum converts only in an
  instance it started itself. Macros are off and nothing is asked (alerts off); Excel leaves links to other
  workbooks alone, and LibreOffice starts with a profile set to block links to untrusted content. No Office
  setting that outlives the conversion is changed.
- **Privacy.** Vellum uploads nothing. The provider is a third-party application: a document that links to
  web content may make it fetch that content, as opening the document in that application would. Claim no more.

## Operations, batch processing and workflows

Automation runs **operations**, never tools or commands (docs/TOOLS_UX_SPEC.md §29 Q13). Five words, five things:

| | What it is | Where |
|---|---|---|
| **Tool** | a discovery record: the task a person looks for, pointing at a command | `catalog/catalog.js` |
| **Command** | a user action (label, keys, availability, `run`) that menus, the palette and Tools call | `commands.js` |
| **Operation** | a feature's core, run on one file with nobody at the screen: stable id, serialisable parameters | `operations/registry.js` |
| **Batch** | one operation repeated over many files, one at a time | `batch/engine.js` |
| **Workflow** | a saved, named list of operations and their settings, run in order on each file | `flow/`, `workflows.json` |

A workflow composes operations; a batch repeats one. A workflow runs on the files the person picks *as a batch*
(it is handed to the batch engine as one operation), so batch never knows about workflows and nothing is built
twice.

- **An operation** (`js/operations/registry.js`) is a feature's own core reached without its UI — never a
  second implementation. It has a stable id (a Flow step will name it: never a tool id or a command id), the
  files it takes (`accepts(name)`), the name of the file it makes, serialisable parameters with defaults and a
  check, the choices a person picks them from, a time limit per file, a refusal for a file it can't take on this
  PC now, and `run(job, env)`: one file, no dialog, no open document. It resolves an outcome — `succeeded`
  (always with the file it wrote), `failed`, `skipped`, `cancelled` or `timedOut`, with a code, the reason in
  the operation's own words, the provider and diagnostics — and a refusal is an outcome, never an exception.
  `env` is how it reaches the host (the abort signal, progress, reading and writing files, pdf-lib), so the
  registry imports no UI and no bridge and runs in Node. Four today: `pdf.compress` (Compress PDF V1,
  `optimize/compress.js`, on the file's bytes), `office.toPdf` (the host's operation, one file per
  `batch.office`), `pdf.pageNumbers` and `pdf.watermark` (text only) — every page, through the writer saving a
  document uses (`pages/stamps.js` `writePageSettings`), with the Page numbers and Watermark dialogs' own size and
  opacity. A new one is added here, with its tests, when its feature's core can run without its UI. For
  workflows an operation also says what it is as a step (`step`), the kind of file it makes (`makes`, which the
  next step must `accept`), what it needs on this PC at all (`presentIf`, with the sentence `absent`), and —
  optionally — what only pdf-lib can check about its settings (`verify`: a watermark's characters).
- **The engine** (`js/batch/engine.js`, pure, tested in Node) plans and runs one operation over many files.
  Files run one at a time, in the order they were added: conversions are one at a time on the host anyway,
  and the page's operations share one thread, so running two at once would only race. Each file has its own
  abort signal and result; an error, refusal or time-out in one never changes another, and an exception is
  reported without its text (kept as diagnostics). Every output name is fixed before anything runs: never a
  source of the batch, never another output of it. Stop starts nothing new and stops the running file, which
  ends as the operation reports it or, past a grace period (15 s), as stopped; files never started say so.
  Nothing stopped, timed out or without a file counts as done. An outcome with `stopBatch` (no Office provider
  left on this PC) skips the rest with its reason. A batch's outcome is done, partial, failed, stopped or
  nothing; failed, stopped and timed-out files can run again.
- **The host** (`MainWindow.Batch.cs`) adds no second way to convert, name or write a file. `batch.choose` is
  the Windows dialog for files, or a folder (the files of that kind directly in it, in name order; hidden,
  system and Office `~$` owner files left out; 1000 at most). Each file chosen is registered **read-only**:
  the page may read it (`/doc/{token}`) and name it by its token, never write it. `batch.office` converts one
  chosen file (by token only) through `office.toPdf` into the export destination contract, one conversion at
  a time shared with the Office tools, `office.cancel` stopping it; it always answers with a structured result.
- **Output.** New files go through the Export Center's destination contract: `export.targets` decides the
  path (`Services/ExportTargets.cs`: a cleaned name in a folder the host already allowed — the source's own,
  or one the person chose), and `/export/{token}` writes it atomically. What is already on disk is asked about
  once, for the whole batch: Replace, or Keep both (the host numbers the name). A file the page may only read —
  a batch's source, a history snapshot — is never a target, whatever was asked: its name is numbered too, so
  an output can never overwrite an input.
- **The UI** (`js/ui/batch.js`, `js/batch/actions.js`): one dialog per operation, opened from its Automate
  tool, with three stages in place — setup (files, the operation's choices, where the new files go, and what
  will be skipped and why), running (each file's state, the batch's progress, Stop; it can't be closed while
  a file is being worked on) and finished (each file's outcome with Show in folder, a summary that says what
  didn't work, Try again). One batch at a time; closing Vellum while one runs asks first.
- **Workflows, the definition** (`js/flow/model.js`, pure): `{ id, name, steps: [{ op, params }] }` — an operation
  id and plain settings per step, nothing from a document and no path; which files it runs on and where the new
  files go are chosen each time it runs. Kept by the host in `workflows.json` in the data folder
  (`Services/Workflows.cs`, `MainWindow.Flow.cs`: `flow.load`, `flow.save`) as `{ v: 1, workflows: [...] }`,
  written atomically. Reading is forgiving and loses nothing it can keep: a step whose operation this Vellum
  doesn't have, or whose settings don't check, stays as written and the workflow says it can't run and why;
  only entries that aren't workflows are dropped (and counted); a file that isn't a workflow list is kept as
  `workflows.json.bad` and the list starts empty; a file from a newer Vellum (`v` above 1) isn't read, so it is
  never written over. `checkWorkflow` checks each step (unknown operation, settings, this PC, and order: a step
  must take the kind of file the one before makes, so Office → PDF can only come first) and at most 12 steps.
- **Workflows, running** (`js/flow/runner.js`, pure): `workflowOperation` presents a workflow to the batch engine
  as one operation (its first step's files, one output per file named "<file> (<workflow>).pdf", a time limit
  that is the net under every step's own). For one file the steps run in order, each through the engine's
  `runOperation` — its own time limit, Stop and grace, judged honestly. A step's file goes to the next **in
  memory** (a *held* output); only the last step writes, through the same destination contract as a batch.
  **All or nothing:** a step that fails, is skipped, stopped or past its time ends the file with that outcome in
  that step's words ("Step 2, Add page numbers: …") and nothing is written. An Office step in between converts
  with `batch.office` `hold: true` into the host's own work folder (`flow-work` under the data folder), is read
  by a read-only token and let go (`batch.release`: forgotten and deleted); anything left is removed when Vellum
  next starts. No concurrency, no branching, loops, scripts or network steps.
- **Workflows, the UI** (`js/ui/flow.js`, `js/flow/actions.js`): one dialog, from the Automate tool *Workflows*
  and the palette (`flow.open`): the list (each workflow's steps, or why it can't run; Run, Edit, Delete — which
  asks first — and New) and the editor in place (a name; the steps in order, each with its operation's own
  choices, moved up or down or removed; Add step offers only the operations that can follow the last one and
  that this PC can do; Save stays off, with the reason, until the workflow can run). Run opens the batch dialog
  on the workflow: files, destination, progress, Stop, results and Try again are batch processing's own. There
  is no task history yet: the finished batch is the record of a run.

## Adding a feature

1. Put its logic in its own module (`js/<feature>/` or `js/ui/<feature>.js`).
2. Register its actions in `commands.js` (with `group` and `icon`, so the palette and menus pick
   them up, and `doc` / `requires` / `presentIf` for what they need, decided by `requirements.js`), and
   add toolbar/menu entries that call those commands. A task a person would look for by name also gets
   one record in `catalog/catalog.js` (docs/TOOLS_UX_SPEC.md §28).
3. If it needs the host, add a `MainWindow.<Feature>.cs` partial with its bridge handlers.
4. Styles go in `app.css` under their own section, using design tokens only.
5. Update `docs/FEATURE_REGISTRY.md`.

## Removing a feature

Delete its module, its commands (menus and palette follow automatically), its CSS section and its
bridge partial. Nothing else should need to change; if it does, that coupling is a bug to fix.

## Testing

Two suites, both on fixtures generated from the vendored libraries and fonts — never on anyone's own
files.

**The engine, in Node**: `node --test "tests/editing/*.test.mjs"` covers the text-editing engine and
PDF writing, against the app's own pdf.js build and pdf-lib. Fixtures are generated into a temp
folder (`tests/editing/fixtures.mjs`); saved files are re-read independently (pdf-lib for structure,
pdf.js for what's drawn). `VELLUM_TEST_PDFS="a.pdf;b.pdf"` adds real files, read only.
`node --test "tests/catalog/*.test.mjs"` covers the command registry, `requirements.js`, the Tools
catalog and the shared search (golden queries, the palette's exact-label promise) and which modules
may import which; it needs no app and no PDF.
`dotnet run --project tests/host` covers the host's services, the Office conversion providers among them
(a fake registry and runner, and the real process runner's limits); `VELLUM_OFFICE_SMOKE=1` adds a real
conversion with whatever this PC has, skipped when it has none. The Office tools' presence and outcomes are in
`tests/catalog`; their wiring in the app (presence, the running dialog, Cancel, one at a time, Home, Recent
and Favorites) is the e2e suite `office-tools`, with the host stubbed on the page: no dialog, no Office.
`node --test "tests/batch/*.test.mjs"` covers the operations and the batch engine (planning, names, order,
isolation, Stop, time limits, outcomes, Try again) with fake hosts, and page numbers, watermarks and a held
Office conversion on generated PDFs read back with pdf.js; `tests/host` covers the export targets
(no output on a read-only source) and the workflow store (whole, atomic, damaged kept as .bad). The e2e suite
`batch` runs it in the app: a real Compress over copies,
through the host's write path, and Office files, Stop, the quit question and a partial result with
`batch.choose`, `batch.office` and `office.providers` stubbed on the page.
`node --test "tests/flow/*.test.mjs"` covers workflows: reading damaged, newer and unknown definitions, a
deterministic round trip, checking (unknown operation, settings, order, this PC), steps in order in memory with
one write, failure, skip, errors and time limits per step, Stop, many files with Try again, and real operations
chained. The e2e suite `flow` makes, saves, reloads, runs (real files on copies), stops (Office stubbed), repairs
and deletes workflows in the app, and checks a damaged `workflows.json`.

**The app, end to end**: `node tests/e2e/run.mjs [--no-build] [suite ...]` drives the real Debug
build over DevTools (`tools/cdp-client.mjs`) with keys, mouse and typing. Suites are in
`tests/e2e/suites`: `text-editor`, `regression` (annotations, search, rotation), `editing-store`,
`phase0` (signed, tagged and PDF/A documents, soft masks, layers, thumbnails), `selection`,
`manipulation` (move, scale, turn, flip and delete one object), `multi-select` (several objects on a
page), `page-changes` (moved objects through the page organiser, save and reopen), and — only when
named — `performance` (`VELLUM_PERF_PDF=<file>` measures a real document; it is
copied first, never changed). A suite clicks what it has first scrolled into view, and waits for the
state it needs rather than for a fixed time, because how far a document is scrolled once several are
open, and how fast a freshly started app responds, both vary. It stops if Vellum is already open (it's single-instance, so a test would drive that copy)
and runs the app with a throwaway data folder: `VELLUM_DATA_DIR`, honoured by Debug builds only, so a
person's settings, recent files and WebView2 profile are never touched. Everything lands in a temp
folder, printed as the run starts.

Updates are tested with a loopback release feed (`VELLUM_UPDATE_FEED`) and a test installer with its
own AppId, never against a real install: `node tests/e2e/run.mjs updates` (needs Inno Setup 6) builds one
that shares `installer/InAppUpdate.iss` with Vellum.iss and fails on purpose, so the no-window install,
the automatic restart and the failed-update message are all exercised.

**Test safety (a permanent rule).** Quality is never traded away, and testing is never allowed to loop,
hang or burn time (docs/TOOLS_UX_SPEC.md §25):

1. Every operation that can block has a hard timeout: process start, DevTools connect and every
   DevTools request (`tools/cdp-client.mjs`: 60 s unless a call or suite asks for longer), `waitFor`,
   window discovery, file I/O waits, and the whole suite (`run.mjs`: 300 s, or the suite's own
   `timeoutMs`).
2. No unbounded retry, polling, wait, process-wait, dialog-wait or window-discovery loop, ever.
3. Retries are bounded: **at most 1**, and only where a documented flake exists.
4. If a test stops making progress, stop.
5. Don't re-run a failing test hoping it passes.
6. Don't start a second copy of a test because the first looks stuck.
7. Never wait indefinitely for a native dialog, window, process, WebView, browser, PowerShell script or
   file operation.
8. **On timeout:** terminate the test process **and its process tree** (`taskkill /PID … /T /F`), capture
   compact diagnostics (the area it was in, `__vellum.errors`, one screenshot if a bounded call can take
   it), report, and stop. `run.mjs` does this for a suite past its deadline, and drops whatever the
   stopped suite does afterwards.
9. Prefer deterministic seams and stubs (the bridge stub for `openDialog` / `pictureDialog`, command
   spies) over GUI automation whenever the GUI isn't what's under test.
10. Native Windows dialogs are fail-fast infrastructure: a test that could open one must stub it or not
    run.
11. Never ask the user to click a dialog to unblock a test.
12. Never continue exploratory debugging automatically after a timeout.
13. No speculative multi-fix attempts: after one failed automated attempt, analyse before trying again.
14. If the test infrastructure itself is broken, report **TEST INFRASTRUCTURE BLOCKED** and stop.
15. Keep output compact: pass/fail lines, and details only for failures.
16. Run targeted suites (`node tests/e2e/run.mjs <suite>`), not the full regression, unless a release
    asks for it.
17. No synchronous blocking call (`spawnSync`, `execSync`) without a `timeout` and `killSignal`: a
    blocked event loop can't be interrupted by any deadline.

`node tests/e2e/run.mjs selftest-timeout` (only when named) checks the limits themselves: it never
finishes, and passes only when a never-answered request fails at its own limit and the runner stops
the suite at its deadline.
