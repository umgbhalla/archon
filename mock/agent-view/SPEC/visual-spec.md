# Agent View — Visual / Component Spec

A faithful spec for mocking Claude Code's Agent View TUI (`claude agents`). Grounded in
`SPEC/_raw-inventory.md` (cited `L#` into `RESEARCH/agent-view-docs.md`) and
`RESEARCH/visual-references.md` (the two official light/dark screenshots + theme/spinner
deep dives). Where research supplies a concrete value it is used; otherwise reasonable
terminal-TUI defaults are noted as **(default)**.

The design language is whitespace + weight + semantic color — **no box borders around
the list**. Box-drawing is reserved for the peek panel / overlays only.

---

## 1. Screen layout regions

The table view is the default screen. Five stacked regions fill the terminal top→bottom:

1. **Header** — mascot + 3 text lines (version / model·cwd / summary counts).
2. **Group sections** — bold group header, its rows, one blank line, repeat. Priority
   order top→bottom: `Pinned`, `Ready for review`, `Needs input`, `Working`,
   `Completed` (inventory §3; refs L156-158). Older completed rows fold into `… N more`.
3. **Rows** — one per session (see §6 row anatomy).
4. **Dispatch input** — `❯` prompt, bracketed above and below by dim horizontal rules.
5. **Footer hints** — one dim lowercase line of keybindings; active defaults
   (permission-mode / model / effort) surface here when set via flags (L412).

### ASCII wireframe (dark theme, ~96 cols)

```
┌ region: HEADER ─────────────────────────────────────────────────────────────────────────────┐
  ▟▙   Claude Code v2.1.140                                                                      
  ▜▛   Opus 4.7 (1M context) · /Users/jane/code/web-app                                          
       1 awaiting input · 1 working · 2 completed                                                
                                                                                                 
  region: GROUP SECTIONS ────────────────────────────────────────────────────────────────────  
  Pinned                                                                                         
    ✽ clawd walk cycle          Write assets/sprites/clawd-walk.png                          3m  
                                                                                                 
  Ready for review                                                                               
    ∙ jump physics              Opened PR with collision fix                       PR #2048  2h  
                                                                                                 
  Needs input                                                                                    
 ▏▓▓ ✻ power-up design          needs input: double jump or wall climb?                      1m ▓▏   ← selected row (full-width band)
                                                                                                 
  Working                                                                                        
    ✽ collision detection       Edit src/physics/CollisionSystem.ts                          2m  
    ✢ playtest level 3          run 12 · all checkpoints cleared                          in 4m  
                                                                                                 
  Completed                                                                                      
    ✻ title screen              result: menu, options, and credits done                     9m  
    ∙ sound effects             result: 14 SFX exported to assets/audio                     4h  
    … 6 more                                                                                     
                                                                                                 
  ───────────────────────────────────────────────────────────────────────────────────────────  ← dim rule
  region: DISPATCH INPUT                                                                          
  ❯ describe a task for a new session                                                            
  ───────────────────────────────────────────────────────────────────────────────────────────  ← dim rule
  region: FOOTER HINTS                                                                            
  enter to open · space to reply · ctrl+x to delete · ? for shortcuts                            
└───────────────────────────────────────────────────────────────────────────────────────────────┘
```

(The outer box is illustrative only — the real screen has no border. The mascot `▟▙ / ▜▛`
stands in for the pink/salmon pixel-art "Clawd".)

### Vertical layout rules

- Left margin: ~2 spaces for group headers; rows indented one icon-gutter further (refs L123).
- Exactly **one blank line** between group blocks (refs L121-122). No blank line between a
  header and its first row.
- Header block = 3 text lines beside the mascot, then one blank line before the first group.
- Dispatch input is bracketed by two dim single-line rules (refs L130-132).
- If the list overflows, the `Completed` group folds (`… N more`) before scrolling; failures
  and open-PR rows always stay visible (inventory §3; L202).

---

## 2. Color-token tables

Source-of-truth dark values are from the confirmed token table (refs L23-33). Light values
are not officially published — per the implementation rule "invert bg/fg, keep accents"
(refs L40-43, L195-196) — so light backgrounds/text are **(default)** choices; accents and
semantic hues are identical across themes.

### 2a. Surface / text tokens

| Role               | Token name      | Dark (hex / rgb)            | Light (hex / rgb)             |
| :----------------- | :-------------- | :-------------------------- | :---------------------------- |
| Background         | `bg`            | `#161616` rgb(22,22,22)     | `#fafafa` rgb(250,250,250) **(default)** |
| Body text          | `fg`            | `#e6e6e6` off-white **(default)** | `#1a1a1a` near-black **(default)** |
| Dim / secondary    | `fgDim`         | `#8a8a8a` mid-grey **(default)** | `#6b6b6b` mid-grey **(default)** |
| Primary accent     | `claude`        | `#d77757` rgb(215,119,87)   | `#d77757` rgb(215,119,87) (same) |
| Selected-row band  | `selectionBg`   | `#264f78` rgb(38,79,120)    | `#dcdcdc` light-grey **(default)** |
| Diff-added bg      | `diffAdded`     | `#225c2b` rgb(34,92,43)     | (lighter green) **(default)** |

### 2b. Session-state tokens (leading-icon color / treatment)

State color coding from inventory §1 / refs L49-56. Hues identical in light + dark.

| State        | Treatment              | Token       | Hex / rgb (both themes)        |
| :----------- | :--------------------- | :---------- | :----------------------------- |
| Working      | **animated** orange shimmer (not static) | `claude` (+ shimmer) | base `#d77757` rgb(215,119,87); shimmer steps ANSI-256 `\x1b[38;5;174m` (`#d75f5f`) → `\x1b[38;5;216m` (`#ffaf87`) |
| Needs input  | yellow                 | `warning`   | `#e5c07b` rgb(229,192,123) **(default — docs say "Yellow")** |
| Idle         | dimmed                 | `fgDim`     | `#8a8a8a` (dark) / `#6b6b6b` (light) — apply `dim` attr |
| Completed    | green                  | `success`   | `#4eba65` rgb(78,186,101)      |
| Failed       | red                    | `error`     | `#ff6b80` rgb(255,107,128)     |
| Stopped      | grey                   | `fgDim`     | `#8a8a8a` (dark) / `#6b6b6b` (light) |

### 2c. PR-label tokens (right edge of a row)

PR status color coding from inventory §4 / refs L60-65. Same hues both themes.

| PR color | Status                                      | Token       | Hex / rgb                  |
| :------- | :------------------------------------------ | :---------- | :------------------------- |
| Yellow   | waiting on checks/review, or checks failed  | `warning`   | `#e5c07b` rgb(229,192,123) **(default)** |
| Green    | checks passed, no blocking review           | `success`   | `#4eba65` rgb(78,186,101)  |
| Purple   | merged                                      | `autoAccept`| `#af87ff` rgb(175,135,255) |
| Grey     | draft or closed                             | `fgDim`     | `#8a8a8a` / `#6b6b6b`       |

### 2d. Daltonized / ANSI fallbacks (refs L35-39)

- Daltonized: green→blue. `claude` `rgb(255,153,51)`, `success` `rgb(51,153,255)`,
  `diffAdded` `rgb(0,68,102)`.
- ANSI themes use named ANSI (`ansi:redBright`, `ansi:greenBright`, `ansi:blue`) so they
  inherit the terminal's 16-color palette. Must stay legible in 16-color mode; truecolor
  only enhances (refs L226-228).

---

## 3. Icon + spinner set

Two orthogonal axes: **shape = process liveness**, **color/animation = state**
(inventory §2; refs L71-72).

### 3a. Row leading icons (shape)

| Glyph | Unicode | Meaning |
| :---- | :------ | :------ |
| `✻`   | U+273B six-pointed black star | process alive, replies immediately |
| `✽`   | U+273D heavy teardrop-spoked asterisk | process alive **and** working (animates) |
| `∙`   | U+2219 bullet operator (renders as middle dot) | process exited; still peek/reply/attach |
| `✢`   | U+2722 four-teardrop-spoked asterisk | `/loop` session sleeping; row shows run count + countdown |

The leading icon is **2 columns wide** (icon + one space) and is tinted by the §2b state
color. `✽` is the only one that animates (the working shimmer).

### 3b. "Working" spinner animation (refs L86-104)

Six flower-like frames, cycled while a session is actively working:

```
frame:  0    1    2    3    4    5
glyph:  ·    ✻    ✽    ✶    ✳    ✢
unicode U+00B7 U+273B U+273D U+2736 U+2733 U+2722
```

- **Color**: orange, animated as a shimmer/gradient — frames step through ANSI-256 oranges
  (`\x1b[38;5;174m` … `\x1b[38;5;216m`). Base = `claude` `#d77757`; lighter gradient step
  comes from the paired `*Shimmer` token.
- **Timing**: eased — frame 0 and frame 5 hold slightly longer than the middle frames
  (not a uniform interval). A reasonable mock value is ~80ms middle frames, ~140ms
  hold on first/last **(default)**.
- Accompanied by status text ending in an ellipsis, e.g. `Sketching…`.
- Row summary text refreshes at most every 15s while working (L137).

---

## 4. Row anatomy

Per-row column layout (refs L117-120, inventory §4 row anatomy):

```
  ✻  power-up design            needs input: double jump or wall climb?           PR #2048  1m
  └┬─┘└──────┬───────┘          └────────────────┬──────────────────┘           └───┬───┘ └┬┘
  icon     name col            summary / activity (dim)                        PR label  time-ago
 (2 col)  (fixed width,                                                        (optional, (right-
          bold, left-aligned)                                                   colored)  aligned,
                                                                                          dim)
```

| Slot | Width / position | Style | Notes |
| :--- | :--------------- | :---- | :---- |
| Icon | cols 1-2 (after gutter); 2 cols (glyph + space) | colored by state (§2b), `✽` animates | shape per §3a |
| Name | fixed-width, left-aligned, starts after icon | **bold**, default `fg` | session name (L84, L114) |
| Summary | starts at common tab-stop (~col 32 in screenshots) | `dim` | one-line Haiku-generated activity; may lead with a `done/total` count e.g. `2/5 ` when ≥2 parallel work items (L138); `/loop` rows show `run N · …` |
| PR label | right side, before time | colored per §2c, OSC-8 hyperlink to PR | `PR #N`, or count `3 PRs` when >1 (colored by the most-needy PR) (L142-157). Optional. |
| Time-ago | right-aligned to terminal edge | `dim` | e.g. `3m`, `2h`, `1m`, `in 4m` (countdown for `/loop`) (L87-101) |

- Name column is fixed-width; summary begins at a shared tab-stop (~col 32) so summaries
  align vertically across rows (refs L118-119).
- Truncate summary to inner width before the PR-label/time slots so nothing overruns the
  edge (refs L233).
- When a session has an open PR but no label fits, the bare PR URL can appear in the
  summary column instead (refs L248).

### Selected-row highlight (refs L126-129)

- A **full-width background band** behind the entire row — color `selectionBg`
  (`#264f78` blue in dark; light-grey `#dcdcdc` in light).
- **Not** reverse-video, **not** a border. The band spans icon→time, edge to edge.
- The icon, name, summary, and time keep their own fg colors over the band.
- In the screenshots the top `Needs input` row carries this band.

---

## 5. Peek panel layout

Opened with `Space` on the selected row (inventory §8; L160). Shows what the session needs,
its most recent output, and any PRs — recent output **or** the waiting question, never the
full transcript (L161). Unlike the list, the peek panel **may** use box-drawing (refs L225).

```
  ╭─ power-up design ─────────────────────────────────────────── ✻ needs input ─╮
  │                                                                              │
  │  Most recent output                                                          │
  │  ─────────────────                                                           │
  │  I can add a double jump or a wall climb for the next level. Which           │
  │  movement should the power-up grant?                                         │
  │                                                                              │
  │  Choose an option:                                                           │
  │    1. Double jump                                                            │
  │    2. Wall climb                                                             │
  │                                                                              │
  │  Pull requests                                                               │
  │  ─────────────                                                               │
  │    PR #2048  collision fix          waiting on checks                        │
  │                                                                              │
  ├──────────────────────────────────────────────────────────────────────────────┤
  │  ❯ type a reply, or press 1–2 to choose · tab fills a suggested reply         │
  ╰──────────────────────────────────────────────────────────────────────────────╯
  ↑/↓ peek adjacent · → attach · space/esc close
```

- **Title bar**: session name (bold, left) + state icon & label (right), e.g. `✻ needs input`.
- **Body**: section sub-headers (`Most recent output`, `Pull requests`) bold with a thin dim
  underline rule; body text `dim`/`fg`.
- **Multiple-choice**: numbered options; press a number key to pick (L165).
- **PR rows**: `PR #N` colored per §2c + status text.
- **Reply input**: a `❯` line near the bottom inside the panel. `Tab` fills a suggested
  reply; prefix `!` to send a Bash command instead (L165). Voice push-to-talk available
  while focused (L167).
- **Navigation hint line** below the panel: `↑/↓` peek adjacent sessions without closing,
  `→` attach (L169).
- Rounded box-drawing `╭ ╮ ╰ ╯ ─ │` (refs L222); degrade to ASCII `+ - |` on VT100-only.

---

## 6. Attached session ("inbuilt terminal") layout

Attach with `Enter` or `→` (inventory §9; L172). Agent view is **replaced** by a full
interactive Claude Code session rendered **fullscreen** regardless of `tui` setting (L177).
This is a normal Claude Code session — every command/shortcut/feature works (L175).

```
  ▟▙  power-up design · /Users/jane/code/web-app                          attached ✻
  ──────────────────────────────────────────────────────────────────────────────────

  Recap — while you were away
    · Generated 3 power-up sprite variants
    · Opened PR #2048 with the collision fix
    · Now waiting: double jump or wall climb?

  ⏵ I can add a double jump or a wall climb. Which should the power-up grant?

  > █

  ──────────────────────────────────────────────────────────────────────────────────
  ← detach · ctrl+o transcript · ctrl+c×2 detach · /stop end session
```

- **Top line**: session name + cwd (dim), and an `attached` indicator with the state icon
  at the right.
- **Recap block**: on attach, Claude posts a short recap of what happened while away
  (L173). Rendered as a small bulleted block.
- **Scrollback**: `PgUp`/`PgDn`/mouse wheel; `Ctrl+O` for transcript mode (L177). Background
  session has no scrollback, so attach fills fresh.
- **Detach hints** in footer: `←` on empty prompt detaches; `Ctrl+Z` if a dialog won't
  respond; `Ctrl+C` twice on empty prompt detaches; detaching never stops the session;
  `/stop` ends it (L179-183).
- Prompt is a standard session prompt (`>`), not the `❯` dispatch chevron.

---

## 7. Help overlay layout

Opened with `?` (inventory §5; L216). A centered modal listing every shortcut in context.
Two-column key→action layout; box-drawing permitted (overlay).

```
  ╭─ Keyboard shortcuts ──────────────────────────────────────────────────────────╮
  │                                                                                 │
  │   ↑ / ↓               Move between rows                                         │
  │   Enter               Attach to selected session, or dispatch if input has text │
  │   Space               Open or close the peek panel                              │
  │   Shift+Enter         Dispatch and attach immediately                           │
  │   →                   Attach to the selected session                            │
  │   Alt+1 .. Alt+9      Attach to session 1–9 in the focused directory            │
  │   Tab                 Browse subagents (empty input) / apply suggestion         │
  │   Ctrl+S              Switch grouping between state and directory                │
  │   Ctrl+T              Pin or unpin the selected session                          │
  │   Ctrl+R              Rename the selected session                                │
  │   Ctrl+G              Open the dispatch prompt in $VISUAL / $EDITOR              │
  │   Ctrl+X              Stop; press again within 2s to delete                      │
  │   Shift+↑ / Shift+↓   Reorder the selected session                              │
  │   Esc                 Close peek panel, clear input, or exit                     │
  │   Ctrl+C              Clear input; press twice to exit                           │
  │   ?                   Show all shortcuts                                         │
  │                                                                                 │
  ╰──────────────────────── esc or ? to close ─────────────────────────────────────╯
```

- **Title bar**: `Keyboard shortcuts` (bold).
- **Key column**: fixed-width left column, key chords in default `fg` (optionally bold);
  action descriptions in `dim`. Two-column key→action alignment.
- Source rows verbatim from the shortcut table (inventory §7; L218-235).
- **Dismiss hint** centered in the bottom border: `esc or ? to close`.
- Rendered over a dimmed/unchanged backdrop; rounded box-drawing, ASCII fallback.

---

## 8. Typography

- **Monospace throughout** — screenshots use a humanist monospace; any standard terminal
  mono (JetBrains Mono / SF Mono / Menlo / Fira Code) is faithful (refs L111-112).
- **Bold** is used for: the product name `Claude Code`; group headers (`Pinned`,
  `Needs input`, `Working`, `Completed`, etc.); the session **name** column; panel/overlay
  titles and section sub-headers (refs L113-114, L122).
- **Dim / regular grey** (`fgDim`) is used for: the version string, the model + cwd line,
  the summary-count line, all activity/summary text, relative timestamps, footer hint lines,
  the `… N more` fold row, and the onboarding hint (refs L115-116).
- **Semantic color** appears only on the leading state icon (§2b) and the PR label (§2c).
  Roughly 80% of body text stays in default `fg`; accent/semantic color is reserved for
  status and interactive bits (refs L226-228).
- Available text attributes in Claude Code: `bold`, `dim`, `italic`, `underline`,
  `strikethrough`, `inverse` (refs L230-231). Emphasis here comes from `bold` + `dim`,
  not from `inverse` (selection uses a background band, not reverse-video).
- **Tabular alignment**: time-ago is right-aligned to the terminal edge; use fixed-width
  digit columns for clean stacking of `3m` / `2h` / `in 4m`.
- **Rules / separators**: the two lines bracketing the dispatch input are thin **dim**
  horizontal rules (read as single-pixel lines), not box-drawing borders (refs L130-132).
- **Padding rhythm**: `paddingX` ≈ 1 baseline, 2 for headers; ~2-space left margin for group
  headers, rows indented one icon-gutter further (refs L123, L232).
