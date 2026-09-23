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
