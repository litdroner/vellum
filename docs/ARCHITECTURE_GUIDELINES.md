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
  are applied inside `composeDocument` by `editing/apply.js`, which rewrites only edited pages.
- **Editing never guesses.** Text is only offered for editing when the engine's reading of it agrees
  glyph for glyph with pdf.js's (codes, text, widths, positions); anything else is refused with a
  reason. Keep that rule for future editors (images, forms, redaction).
- **The bridge is an allow-list**: each host call is a named handler that validates its input.
  Group related handlers in their own `MainWindow.<Feature>.cs` partial.
- Rendering the UI never re-renders PDF pages: themes and page colours are CSS only.

## Adding a feature

1. Put its logic in its own module (`js/<feature>/` or `js/ui/<feature>.js`).
2. Register its actions in `commands.js` (with `group` and `icon`, so the palette and menus pick
   them up), and add toolbar/menu entries that call those commands.
3. If it needs the host, add a `MainWindow.<Feature>.cs` partial with its bridge handlers.
4. Styles go in `app.css` under their own section, using design tokens only.
5. Update `docs/FEATURE_REGISTRY.md`.

## Removing a feature

Delete its module, its commands (menus and palette follow automatically), its CSS section and its
bridge partial. Nothing else should need to change; if it does, that coupling is a bug to fix.

## Testing

End-to-end checks drive the real app over DevTools (`tools/cdp-client.mjs`) on copies of PDFs.
Updates are tested with a loopback release feed (`VELLUM_UPDATE_FEED`) and a test installer with its
own AppId, never against a real install.

The text-editing engine and PDF writing are tested in Node, against the app's own pdf.js build and
pdf-lib: `node --test "tests/editing/*.test.mjs"`. Fixtures are generated into a temp folder from the
vendored libraries and fonts (`tests/editing/fixtures.mjs`); saved files are re-read independently
(pdf-lib for structure, pdf.js for what's drawn). `VELLUM_TEST_PDFS="a.pdf;b.pdf"` adds real files,
read only.
