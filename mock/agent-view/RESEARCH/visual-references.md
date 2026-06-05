# Claude Code Agent View — Visual References

Research notes for building a faithful visual mock of Claude Code's Agent View TUI
(`claude agents`). Compiled from the official docs, the two official screenshots
(light + dark), the theme-system deep dive, and the reverse-engineered spinner
animation, plus general terminal-TUI conventions.

> The two official screenshots were rendered directly during research. Both show the
> exact same content (same rows, same layout); they differ only in palette
> (dark = near-black bg / light off-white text; light = white bg / dark text). Notes
> below are grounded in those images.

---

## Color palette

Claude Code's themes are a semantic-token system: 6 named themes
(`dark`, `light`, `dark-daltonized`, `light-daltonized`, `dark-ansi`, `light-ansi`),
each mapping ~70 semantic tokens to raw color values (RGB / hex / ANSI). `auto`
resolves to `dark` or `light` at runtime from `$COLORFGBG` or an OSC 11 background
probe (luminance via BT.709; >0.5 = light).

### Confirmed dark-theme token values (source of truth for the mock)

| Token            | Value                | Role                                         |
| :--------------- | :------------------- | :------------------------------------------- |
| `claude`         | `rgb(215,119,87)`    | Claude orange — spinner, assistant label, primary accent. Set this first. |
| `success`        | `rgb(78,186,101)`    | green — completed state, passed PR checks    |
| `error`          | `rgb(255,107,128)`   | red — failed state                           |
| `autoAccept`     | `rgb(175,135,255)`   | purple/lavender — auto/accept mode, merged PR |
| `selectionBg`    | `rgb(38,79,120)`     | blue — selected-row background (dark)        |
| `diffAdded`      | `rgb(34,92,43)`      | dark green — added-line bg                   |

Notes:
- Daltonized variants swap green→blue: `claude` `rgb(255,153,51)`, `success`
  `rgb(51,153,255)`, `diffAdded` `rgb(0,68,102)`.
- ANSI variants use names (`ansi:redBright`, `ansi:greenBright`, `ansi:blue`)
  instead of RGB so they inherit the terminal's 16-color palette
  (Dracula/Catppuccin/etc.).
- The light theme's explicit RGB values are not published. From the screenshot it is:
  white/near-white background, near-black/dark-grey body text, the SAME Claude
  orange accent, the same green/red/purple semantics, and a light-grey
  selected-row background. Treat light as "invert bg/fg, keep accents."
- Known limitation: interactive elements (yes/no prompts, selection highlights,
  permission dialogs) use hardcoded 24-bit RGB and ignore the terminal's ANSI palette.

### Agent-view state color coding (from the docs table)

| State       | Icon color / treatment | Meaning                                      |
| :---------- | :--------------------- | :------------------------------------------- |
| Working     | **Animated** (orange shimmer) | actively running tools / generating  |
| Needs input | **Yellow**             | waiting on a question / permission decision  |
| Idle        | **Dimmed**             | nothing to do, ready for next prompt         |
| Completed   | **Green**              | finished successfully                        |
| Failed      | **Red**                | ended with an error                          |
| Stopped     | **Grey**               | stopped via `Ctrl+X` / `claude stop`         |

### PR label color coding (right edge of a row)

| Color  | PR status                                     |
| :----- | :-------------------------------------------- |
| Yellow | waiting on checks/review, or checks failed    |
| Green  | checks passed, no blocking review             |
| Purple | merged                                        |
| Grey   | draft or closed                               |

---

## Icon & spinner set

Two orthogonal axes encode each row: **icon shape = process liveness**,
**icon color/animation = state** (table above).

### Row leading icons (shape = process state)

| Glyph          | Unicode                                   | Meaning                                  |
| :------------- | :---------------------------------------- | :--------------------------------------- |
| `✻`            | U+273B SIX-POINTED BLACK STAR (teardrop-spoked asterisk) | process alive, replies immediately |
| `✽` (animated) | U+273D HEAVY TEARDROP-SPOKED ASTERISK     | process alive + working (animates)       |
| `∙`            | U+2219 BULLET OPERATOR (rendered as a middle dot) | process exited; can still peek/reply/attach |
| `✢`            | U+2722 FOUR TEARDROP-SPOKED ASTERISK      | a `/loop` session sleeping between runs (shows run count + countdown) |

In the official screenshots the working/needs-input rows lead with `✶`/`✽`-style
asterisks and completed rows lead with `•`/`∙` dots colored green.

### "Working" spinner animation (reverse-engineered)

The thinking/working spinner cycles six flower-like glyphs:

```
·   ✻   ✽   ✶   ✳   ✢
```

(U+00B7 middle dot, U+273B, U+273D, U+2736 six-pointed black star,
U+2733 eight-spoked asterisk, U+2722 four-teardrop-spoked asterisk.)

- Color: orange, animated as a shimmer/gradient — frames step through ANSI 256
  oranges, e.g. `\x1b[38;5;174m` and `\x1b[38;5;216m`. The `claude` token
  (`rgb(215,119,87)`) is the base; paired `*Shimmer` tokens supply the lighter
  gradient step. (`_FOR_SYSTEM_SPINNER` suffix isolates the spinner blue from
  user-facing permission-prompt colors in source.)
- Timing: eased — the first and last frame hold slightly longer than the middle
  frames (not a uniform interval).
- Accompanied by status text with an ellipsis, e.g. `Sketching…`.
- Row summaries (the one-line activity text) refresh at most every 15s while working.

---

## Typography & spacing

- **Monospace throughout** (screenshots use a humanist monospace; any standard
  terminal mono — JetBrains Mono / SF Mono / Menlo / Fira Code — is faithful).
- **Bold** used for: the product name `Claude Code`, group headers
  (`Needs input`, `Working`, `Completed`), and the session name (first column).
- **Dim/regular grey** used for: version string, model + cwd line, the summary
  count line, activity/summary text, relative timestamps, and footer hints.
- Column layout per row: `‹2-col icon+space›  ‹session name (bold)›  ‹gap›  ‹activity/summary or PR link (dim)›  …  ‹right-aligned relative time, dim›`.
  - Name column is fixed-width and left-aligned; activity starts at a common
    tab-stop (~col 32 in the screenshots).
  - Timestamp (`12m`, `3m`, `40m`, `1h`) is right-aligned to the terminal edge.
- **Group blocks**: a bold header line, its rows, then ONE blank line before the
  next group. No box borders around groups — whitespace + bold headers only.
- **Padding**: ~2 spaces left margin for group headers; rows indented under them.
  Generous left gutter for the icon. This matches the TUI convention of
  `paddingX≈1–2` and using whitespace/weight (not borders) for hierarchy.
- **Selected-row highlight**: full-width background band behind the row
  (blue `rgb(38,79,120)` in dark; light-grey in light) — not reverse-video, not a
  border. In the screenshots the top "Needs input" row carries this highlight band
  spanning the whole width.
- **Separators**: two thin horizontal rules (dim) bracket the dispatch input —
  one above it (separating list from input) and one below (separating input from
  footer hints). These read as single-pixel/dim lines, not box-drawing borders.

---

## Header & footer

### Header (top-left, 3 text lines beside a pixel-art "Clawd" mascot)

```
[mascot]  Claude Code v2.1.140
          Opus 4.7 (1M context) · /Users/jane/code/web-app
          1 awaiting input · 1 working · 2 completed
```

- Line 1: **`Claude Code`** bold + `v2.1.140` dim. (Mock target version string:
  "Claude Code v2.1.140".)
- Line 2: model name + context window, then `·`, then working directory (dim).
- Line 3: summary counts joined by ` · ` middots (dim).
- Mascot: a small pink/salmon pixel-art creature ("Clawd") to the left of the
  header text. Same pose in both themes (slightly different shade).
- Terminal tab title mirrors state: `2 awaiting input · claude agents`.

### Group section (middle)

Bold header + rows, in priority order top→bottom:
`Pinned`, `Ready for review`, `Needs input`, `Working`, `Completed`.
Older completed rows collapse into a dim `… N more` row.

### Dispatch input (near bottom)

```
❯ describe a task for a new session
```

- Leading `❯` chevron prompt glyph, then placeholder text (dim) or typed prompt.
- A block cursor sits on the first char (visible in both screenshots).
- `!` as first char switches to a shell-command job; `Too short` hint if <4 chars.
- Bounded above and below by dim horizontal rules.

### Footer (very bottom, dim hint line)

```
enter to open · space to reply · ctrl+x to delete · ? for shortcuts
```

- Lowercase, dim, key actions joined by ` · ` middots.
- The active permission-mode/model/effort defaults also surface in the footer area
  below the input when set via flags.

---

## Light vs dark

| Aspect            | Dark                                  | Light                                   |
| :---------------- | :------------------------------------ | :-------------------------------------- |
| Background        | near-black (`~#161616`)               | white / near-white (`~#fafafa`)         |
| Body text         | off-white / light grey                | near-black / dark grey                  |
| Dim/secondary     | mid-grey                              | mid/lighter grey                        |
| Accent (`claude`) | orange `rgb(215,119,87)` — unchanged  | same orange (mascot slightly warmer/darker) |
| Success / Error / Merged | green / red / purple — unchanged hues | same semantic hues                |
| Selected-row band | blue `rgb(38,79,120)`                 | light-grey band                         |
| Mascot            | brighter pink/salmon                  | terracotta/darker salmon                |

Implementation rule: same layout + same accent/semantic hues in both; only
background, body-text, dim, and selected-row-band colors flip.

---

## Reference screenshots & URLs

- Official docs (layout, icons, states, shortcuts, PR colors):
  https://code.claude.com/docs/en/agent-view
- Dark screenshot (rendered during research, 1772×780):
  https://mintcdn.com/claude-code/1B48Qz2Z9hac4SLG/images/agent-view-dark.png
- Light screenshot (1772×780):
  https://mintcdn.com/claude-code/1B48Qz2Z9hac4SLG/images/agent-view-light.png
- Theme / token system deep dive (token names + RGB values, downgrade logic):
  https://www.markdown.engineering/learn-claude-code/41-theme-styling
- Spinner reverse-engineering (frames, easing, ANSI orange codes):
  https://medium.com/@kyletmartinez/reverse-engineering-claudes-ascii-spinner-animation-eec2804626e0
- Built-in themes overview:
  https://blog.vincentqiao.com/en/posts/claude-code-theme/
- Terminal config (truecolor, COLORTERM, Apple Terminal 256-color downgrade):
  https://code.claude.com/docs/en/terminal-config
- ANSI-palette limitation issues:
  https://github.com/anthropics/claude-code/issues/39369 ,
  https://github.com/anthropics/claude-code/issues/40905

### General terminal-TUI conventions (for fidelity)

- Box-drawing families: light `─ │ ┌ ┐ └ ┘ ├ ┤ ┬ ┴ ┼`, rounded `╭ ╮ ╰ ╯`,
  heavy `━ ┃ …`, double `═ ║ …`. Agent View itself avoids boxes — it uses
  whitespace, bold headers, and a couple of dim horizontal rules (lazygit/k9s lean
  restrained too). Reserve box-drawing for any peek-panel/modal in the mock.
- Hierarchy from weight + intensity, not color: ~80% body in default fg, headers
  bold, metadata dim, status in semantic color, accent only on interactive bits.
  Must remain legible in 16-color mode; truecolor only enhances.
- Selected row = dedicated background slot (band), not just fg change; `reverse`
  and `dim` are the standard emphasis attributes. Available text styles in CC:
  bold, dim, italic, underline, strikethrough, inverse.
- Padding rhythm: `paddingX` 1 (baseline) to 2 (headers); truncate row content to
  inner width before padding so nothing overruns the canvas edge.
- Always surface keybindings in a footer hint line; `?` opens full help — Agent
  View follows this exactly.
- Box-drawing needs Unicode; degrade to ASCII (`- | +`) on VT100-only terminals.
- Reference TUIs: lazygit (multi-pane + per-key status bar), k9s/htop
  (fixed header + scrollable list + function bar). Agent View is the
  header + grouped-list + input + footer-hints archetype.
  - TUI design notes: https://griffen.codes/post/tui-design-skill-claude/
  - Box drawing reference: https://unicodefyi.com/guide/box-drawing-block-elements/

### PR labels as hyperlinks

- A `PR #1234` label appears at the row's right edge, **linked to the PR via OSC 8
  terminal hyperlinks** in terminals that support them (renders as clickable
  underlined/colored text; falls back to plain text otherwise). In the screenshots
  the completed row instead shows the bare URL `github.com/acme/web-app/pull/142`
  in the activity column.
- Multiple PRs collapse to a count label like `3 PRs`, colored by the open PR that
  most needs attention. Number color follows the PR-status table above
  (yellow/green/purple/grey).
