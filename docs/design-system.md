# Design system

Everything you see in WebTerm is built from one set of tokens and one set of components. The living
style guide is served by the app itself at `/design.html` (open it from any running instance), in light and dark.

The visual identity (name, logo, colours, terminal themes) comes from [`DESIGN.md`](DESIGN.md). That spec is the
reference; what is built so far is the identity, not the whole layout.

## What follows the spec, and where it differs

- **Names:** the spec's `--wt-*` tokens are our semantic tokens: `--wt-bg` is `--bg`, `--wt-surface` is
  `--surface-raised`, `--wt-surface-2` is `--surface-side` and `--surface-field`, `--wt-surface-3` is
  `--surface-selected`, `--wt-accent` is `--acc`, `--wt-accent-text` is `--acc-text` (use it for accent-coloured text
  and links), `--wt-on-accent` is `--acc-ink`. The values are the spec's.
- **Two values are adjusted to meet 4.5:1 text contrast on the selected and hovered row colours:** muted text
  (`--text-3`, `#9097a3` dark, `#5f6572` light) and warning text on light (`--warn`, `#9a6412`). `go test` checks
  every text pair.
- **White on danger:** the spec's white text on the dark danger red is 2.7:1, so dark uses the near-black `--acc-ink` green
  for `--on-danger`.
- **Terminals** are dark by default in both app themes, as in the spec ("Default (dark)"). Light, high contrast and
  the other palettes are per-host choices.
- **Not built yet:** the top bar, status bar, side-panel host editor, 4-step first-run, tab drag and drop, the
  terminal settings page, and the extra colour schemes. Jump hosts, port forwarding and the 12-character password
  minimum in the spec are intentionally not built.

Brand assets (`icon.svg`, `favicon.svg`, the PNG icons, `favicon.ico`, `logo-light.svg`, `logo-dark.svg`) are
rebuilt with `scripts/brand/build.sh`.

## Layers

```
cmd/webterm/web/
  css/tokens.css      raw values: palette, scales, sizes, motion. The only file allowed to hold them.
  css/base.css        reset, typography, focus, and a few layout helpers
  css/components.css  every component, each starting with an @component marker
  css/layouts.css     how components are arranged into screens
  css/guide.css       the style guide page only
  ui.js               the markup for each component, as functions (button, itemRow, settingRow, panel, ...)
  design.js           the style guide, drawn from the tokens and from those same functions
  icons.svg           the icon set (Tabler outline icons, MIT)
```

Tokens come in three layers, all in `tokens.css`:

1. **Primitives**: the palette (`--ink-*`, `--paper-*`, `--green-*`...) and the scales (`--s-*` space on a 2px grid,
   `--fs-*` type, `--r-*` radius, `--dur-*` motion).
2. **Semantic**: what a colour is for (`--bg`, `--surface-raised`, `--text-2`, `--acc`, `--danger`). Light and dark
   each set these; components only use these, never the palette.
3. **Component**: sizes that belong to one component (`--h-control`, `--w-dialog`, `--icon-lg`).

Terminal palettes (`--term-*`, under `[data-term=...]`) are tokens too: xterm reads them at run time through
`xtermTheme()`, so terminals follow the same system.

## Rules

`go test ./...` fails (and so does CI) if any of these break:

- No raw colour, or length other than `1px`, `1.5px`, `2px`, outside `tokens.css`. Scripts have no raw colours either.
- Every `var(--x)` is declared in `tokens.css`.
- No inline `style`. The few dynamic values (a divider position, a remote cursor image, a per-host terminal colour)
  are marked `ds-allow` with the reason.
- Every class used in a script or page is defined in the stylesheets.
- Every icon used exists in `icons.svg`.
- Every `@component` in `components.css` appears in the style guide, and the guide shows nothing that isn't a component.
- Text meets contrast targets in both themes: body and secondary text at 4.5:1 or better (primary text 7:1), hints at 3.5:1.
- The browser-chrome colours (`theme-color`, the web manifest) match the `--bg` token.
- There is one breakpoint, 760px.

## Adding to it

- **A value**: add a token in `tokens.css`, then use it. Don't reach for a number.
- **A component**: add its CSS to `components.css` under `/* @component name */`, add a builder to `ui.js` if screens
  will repeat its markup, and add an entry to `COMPONENTS` in `design.js` with a description and an example.
- **An icon**: add its symbol to `icons.svg`.
- Check your work in the guide, in both themes, and at phone width.

## UI tests

`tests/ui/run.sh` drives every screen in headless Chromium (dark, light, phone) and saves screenshots.
