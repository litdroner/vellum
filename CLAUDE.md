# Vellum — notes for Claude

Vellum is a shipped Windows PDF reader/editor (GitHub: litdroner/vellum, releases v0.1, v0.2.0).
WPF (.NET 10) window hosting a WebView2 page; the UI is plain ES modules (no build step) on pdf.js
(rendering) and pdf-lib (writing). Developed by Pankaj Manhas, Homelabs; that credit must stay in
About and in the exe/installer metadata.

Continue the existing code. Never start over, never add a second system for something that exists
(themes, toolbar, commands, dialogs). Read these first:

- `docs/FEATURE_REGISTRY.md` — what exists, what is partial, what is planned (and must not be faked)
- `docs/ARCHITECTURE_GUIDELINES.md` — layers, feature boundaries, how to add or remove a feature
- `docs/DESIGN_SYSTEM.md` — themes, materials, tokens, components, motion

## Build, run, test

```powershell
tools\run.ps1 -Debug -Files x.pdf           # build Debug and launch; DevTools on port 9222
node tools\cdp.mjs eval "expr"               # evaluate in the running page (also: shot <png>)
tools\publish.ps1                            # Release build + dist\Vellum-Setup.exe (Inno Setup 6)
tools\release.ps1 -NotesFile notes.md        # GitHub release; ONLY when the user asks
node --test "tests/editing/*.test.mjs"       # text-editing engine + PDF writing tests (Node, no app)
```

`tools/cdp-client.mjs` drives the app (keys, mouse, drag, screenshots) for end-to-end checks.
`window.__vellum` exposes `app`, `actions`, `ui` and collected `errors` for tests.

## Rules

- Test only on copies of PDFs in a scratch folder; never modify the user's own files.
- Never touch the git repo rooted at the user's home directory; this repo is the project folder.
- Do not commit, push or publish a release unless the user asks. Never rewrite history.
- Password-protected PDFs: open with the correct password only. No cracking, bypass or recovery.
- Don't fake features (AI, cloud, signatures, OCR…): only real functionality gets UI.
- Keep the PDF the visual focus and the UI light: see the performance rules in DESIGN_SYSTEM.md.
