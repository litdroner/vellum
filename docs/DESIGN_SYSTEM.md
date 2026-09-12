# Vellum design system

Premium digital paper: **paper, clay and clear glass** in soft light. The PDF is the content and
stays visually dominant; the UI is the frame around it. One source of truth: `web/css/app.css`
(tokens → materials → components) and `web/js/themes.js` (theme data).

## Themes

A theme is nine **seed** colours per mode; everything else is derived in CSS with `color-mix()`.

| Seed | Use |
|---|---|
| `bg` | window background (misty ground) |
| `surface` | panels, cards, controls |
| `tint` | soft coloured wash (background glow, selected wells) |
| `accent` | the brand colour: primary buttons, selection, focus, active tool |
| `accent2` | warm secondary: unsaved-changes dots, multi-selected pages, highlighter stroke |
| `accent3` | calm tertiary: background glow, success |
| `ink` | text |
| `shadow` | tint of shadows (a cool teal-grey in light mode, black in dark) |
| `onAccent` | text/icons on the accent |

Curated colour themes (each has a Light and an **Obsidian** dark set): **Mist** (default, the
flagship), Ocean, Sage, Blush, Sand, Lavender, Graphite. Modes: Light, System (follows Windows),
Dark. A **custom accent** replaces the theme's accent; its text colour is picked for contrast and the
tint, hover, selection and focus shades follow automatically. Accent colours are chosen so white text
on them is at least ~4:1 in light mode.

Dark mode is designed, not inverted: obsidian surfaces, smoked glass, warm ivory text, restrained
accents. PDF pages stay white (faithful to the file) unless the user picks dark or sepia *page colours*.

## Materials

| Material | Where | Recipe (tokens) |
|---|---|---|
| Glass | tool bar, sidebar, recent cards | `--glass` fill, `--glass-shadow` (lit top edge, hairline, long soft shadow). No blur: it sits on the static background. |
| Floating glass | view bar, menus, dialogs, palette, find bar, toasts, contextual bars | `--glass-float` + `backdrop-filter: var(--blur)` + `--float-shadow`. Blur only on these small or temporary surfaces. |
| Clay | primary buttons, brand tile, theme tiles, Open card "+" | `--clay-accent` gradient + `--accent-shadow`; neutral clay is `--clay` + `--clay-shadow` |
| Paper | PDF pages, thumbnails, recent covers | white, `--paper-shadow` / `--page-shadow`, 4–6 px radius |

**Reduce transparency** (`data-glass="off"`) makes glass solid and removes blur everywhere.

## Tokens

- Text: `--ink`, `--ink-2` (secondary), `--ink-3` (captions), `--ink-4` (disabled).
- States: `--hover`, `--press`; selected = `--accent-soft` fill + `--accent-line` border + `--accent-ink` text.
- Lines: `--hairline` (panel edges), `--line`, `--line-2` (separators, input borders).
- Radius: panels 20 px, dialogs 20 px, cards 16 px, buttons 10–11 px, small buttons 8 px, pills 50%.
- Spacing: 10 px between panels (`--gap`); controls 34 px tall (28 px small).
- Type: Segoe UI Variable for UI (13 px), Jost for display (greeting, titles) and the wordmark
  (uppercase, letter-spacing .34em).
- Icons: Lucide, 1.6 px stroke, 16–18 px.

## Components

- **Title bar**: VELLUM wordmark with the clay brand tile, tab pills (active tab is a clay chip),
  command palette, settings and light/dark buttons, Windows caption buttons.
- **Tool bar**: sidebar + Open | annotation tools as a labelled segmented control (labels hide on
  narrow windows) + colour | save, search, page colours, print | More.
- **View bar**: floating at the bottom of the document: page, zoom, fit, rotate, layout.
- **Segmented control**: recessed track, raised knob that slides (260 ms spring).
- **Contextual tools**: selected text → highlight colours / underline / copy; selected annotation →
  colours / delete; selected pages → page bar (rotate, duplicate, extract, delete); text being
  edited → font, status (substitute font, what can't be written), Cancel / Done.
- **Edit text**: editable text gets a quiet dashed accent outline (hover fills it, keyboard focus
  thickens it, edited text uses `accent2`); text that can't be edited shows a dotted grey outline and
  explains itself when clicked. The editor sits exactly on the text, in the page's own font and paper
  colour (and follows page colours), ringed in the accent; the document itself is never tinted.
- **Selected object**: a picture selected in Edit mode gets a solid accent outline on its own oriented
  quad, not a bounding box, so a turned or mirrored picture is outlined as it looks. Four small white
  corner handles appear only where a uniform scale can really be written — never on an object whose
  capabilities refuse it, and never on the edge midpoints, which no writer could honour. A movable
  picture takes the `move` cursor; text keeps the caret, because clicking text types rather than
  moves. While a gesture is under way only the outline follows the pointer: the page is re-rendered
  once, when the change is written, so nothing is dragged around at the cost of a repaint per frame.
- **Home**: date, greeting, Open card (dashed inner edge), paper illustration, recent covers.
- **Settings**: left navigation (Appearance, Reading, Updates, Shortcuts, About), rows on surface.
- **Command palette** (Ctrl+K): every command from the registry plus recent files.

## App icon

A sheet of cream clay paper with its top-right corner peeled back over the page, lying in a glass
well inside a soft clay tile (`appIconSvg` in `web/js/brand.js`). It follows the accent: the title
bar and About use the current theme; each colour-theme swatch in Settings shows the icon in that
theme (on an obsidian tile in dark mode). `tools/make-icon.mjs` renders it from the running app into
`Assets/Vellum.ico` (default **mist**; also sage, ocean, blush, sand, lavender, graphite, dark) or,
with `--preview <dir>`, PNG previews of every variant.

## Motion

150 ms for hover/press, 220 ms for panels and dialogs, `--ease-out`; springs only for knobs and the
Open "+". Theme changes grow the new colours from the control used (view transition, 480 ms).
Everything respects Windows' reduced-motion setting and Vellum's own **Reduce motion**.

## Performance rules

- Never put blur or filters over the PDF canvas; pages are plain paper.
- `backdrop-filter` only on floating surfaces; none on persistent panels.
- Animate `transform` and `opacity`; no continuously animated shadows. The home illustration's
  only loop is two small orbs, and it stops when a document is open (the home screen is hidden).
- Themes and page colours are CSS only: switching never re-renders PDF pages.
