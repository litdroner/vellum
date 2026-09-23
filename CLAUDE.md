# Vellum — notes for Claude

Vellum is a shipped Windows PDF reader/editor (GitHub: litdroner/vellum; releases v0.2.0 to v0.4.1).
WPF (.NET 10) window hosting a WebView2 page; the UI is plain ES modules (no build step) on pdf.js
(rendering) and pdf-lib (writing). Developed by Pankaj Manhas, Homelabs; that credit must stay in
About and in the exe/installer metadata.

Continue the existing code. Never start over, never add a second system for something that exists
(themes, toolbar, commands, dialogs). Read these first:

- `docs/VELLUM_VISION.md` — the long-term product direction and durable decisions (below this file only)
- `docs/DESIGN_SYSTEM.md` — the visual authority: themes, materials, tokens, components, motion
- `docs/ARCHITECTURE_GUIDELINES.md` — engineering constraints: layers, boundaries, adding or removing a feature
- `docs/FEATURE_REGISTRY.md` — what exists, is being built, is next, planned, research, or never to be built
- `docs/VELLUM_VISUAL_REFERENCES.md` — visual assets in the repository, and external references that aren't
- `docs/planning/` — detailed implementation and audit plans (0.5.0: `VELLUM_0.5.0_AUDIT.md`)
- `docs/WEBVIEW2_NETWORK_AUDIT.md` — measured network activity of Vellum and its WebView2 runtime

## Build, run, test

```powershell
tools\run.ps1 -Debug -Files x.pdf           # build Debug and launch; DevTools on port 9222
node tools\cdp.mjs eval "expr"               # evaluate in the running page (also: shot <png>)
tools\publish.ps1                            # Release build + dist\Vellum-Setup.exe (Inno Setup 6)
tools\release.ps1 -NotesFile notes.md        # GitHub release; ONLY when the user asks
node --test "tests/editing/*.test.mjs"       # text-editing engine + PDF writing tests (Node, no app)
node --test "tests/catalog/*.test.mjs"       # commands, requirements, Tools catalog + search (Node, no app)
node tests\e2e\run.mjs                       # the app itself over DevTools (Debug build; close Vellum first)
```

`tools/cdp-client.mjs` drives the app (keys, mouse, drag, screenshots) for end-to-end checks.
`window.__vellum` exposes `app`, `actions`, `ui` and collected `errors` for tests.

## Rules

- Test only on copies of PDFs in a scratch folder; never modify the user's own files.
- Never touch the git repo rooted at the user's home directory; this repo is the project folder.
- Do not commit, push or publish a release unless the user asks. Never rewrite history.
- Password-protected PDFs: open with the correct password only. No cracking, bypass or recovery.
- Don't fake features (AI, cloud, signatures, OCR…): only real functionality gets UI.
- Local-first: every PDF feature runs locally and works with no network; document data is never
  uploaded. No cloud processing, cloud storage, online AI, API keys, telemetry or analytics. Vellum's
  own network activity is only the GitHub updater and OCR language packs the user downloads (from GitHub,
  on a click, verified before use). The WebView2 runtime makes its own Microsoft
  connections: leave it as it is (SmartScreen on, no unsupported switches, no Windows settings changed).
  Never claim zero traffic or an offline WebView2. Use the privacy wording in "Offline and privacy" in
  ARCHITECTURE_GUIDELINES.md. AI, when it comes, goes behind `AIProvider` (local first; cloud interface only).
- Keep the PDF the visual focus and the UI light: see the performance rules in DESIGN_SYSTEM.md.
- Durable requirements live in the repository, not in chat. Deferring a feature changes
  FEATURE_REGISTRY.md only; nothing leaves VELLUM_VISION.md without the owner's recorded decision.
  Conflicting requirements go to "Open decisions" there, never resolved silently.
