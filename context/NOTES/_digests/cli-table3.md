# cli-table3

## What it is (1-2 lines)
A pretty-printer for static Unicode/ANSI tables in the terminal (the `cli-table` successor). It does no live rendering or input — it's a one-shot layout engine that takes a 2D array of cells (with colSpan/rowSpan, word-wrap, alignment, ANSI colors, hyperlinks) and produces a single multi-line string. The value here is the *layout math*: grid allocation with spans, width/height distribution, border-junction character selection, and ANSI-safe width/wrap/truncate.

## Architecture (how the pieces fit; key files with paths)
Pipeline is strictly phased — no incremental/diff rendering. All in `src/`:

- `src/table.js` — entry point. `Table extends Array`; you push rows onto it. `toString()` drives the whole pipeline.
- `src/layout-manager.js` — pure grid logic. Turns rows of raw cell specs into a fully-populated 2D grid of `Cell`/`ColSpanCell`/`RowSpanCell`, assigns each cell `(x,y)`, and computes final per-column widths and per-row heights.
- `src/cell.js` — the cell object model + all *drawing*. `Cell` plus two placeholder classes `ColSpanCell` (draws nothing) and `RowSpanCell` (delegates to the original cell with a line offset).
- `src/utils.js` — ANSI-aware string primitives: `strlen`, `pad`, `truncate`, `wordWrap`/`textWrap`, `colorizeLines` (ANSI state machine), `hyperlink`, option merging, default box-drawing chars.
- `src/debug.js` — tiny leveled logger captured into `table.messages`.
- `index.js` — re-exports `src/table.js`.

`toString()` orchestration (`src/table.js:38`):
1. Prepend `options.head` as row 0 if present.
2. `makeTableLayout(array)` → grid of Cells.
3. Each cell `mergeTableOptions(options, cells)` — resolves chars/style/padding, computes wrapped `lines`, `desiredWidth`/`desiredHeight`.
4. `computeWidths(colWidths, cells)` then `computeHeights(rowHeights, cells)`.
5. Each cell `init(options)` — now that final col/row sizes exist, compute pixel `width`/`height`, alignment, `drawRight`.
6. Row-by-row draw loop emits `top` border, each text line `0..heightOfRow`, and `bottom` on the last row; joins with `\n`.

## Core techniques

### Grid allocation with row/col spans (`layout-manager.js`)
This is the cleverest part. Cells start with only content + span counts; the layout manager assigns coordinates and fills holes.

- `layoutTable` (`:13`) assigns `(x,y)`. It keeps an `alloc` map `{columnIndex: rowsRemaining}` of columns currently occupied by a rowSpan from above. `next(alloc, col)` (`:6`) skips forward past any occupied column so a new cell lands in the first free slot. After each row, every `alloc` counter is decremented and dropped at 0 (`:30`). This is essentially a sweep-line over rows tracking vertical occupancy.
- `fillInTable` (`:127`) detects *missing* cells (sparse input) by scanning every `(x,y)` up to `maxWidth`×`maxHeight`; where no existing cell conflicts, it greedily grows a colSpan rightward and a rowSpan downward (`allBlank`) and inserts a synthetic empty `Cell`, emitting a `warn`. So you can specify a ragged table and it auto-patches the grid.
- Conflict detection is pure interval overlap on both axes (`cellsConflict`, `:51`): two cells conflict iff their `[yMin,yMax]` and `[xMin,xMax]` ranges (derived from x/y + span) both overlap.
- `addRowSpanCells` (`:90`): for a cell with rowSpan N, insert N-1 `RowSpanCell` placeholders into the rows below, each pointing at the original. `insertCell` (`:119`) keeps each row sorted by `x` via linear-scan splice.
- `addColSpanCells` (`:104`): iterate rows bottom-up, splice `ColSpanCell` placeholders to the right of any colSpan>1 cell so column counts line up. Bottom-up avoids index shifting affecting unprocessed cells.

### Width/height distribution (`makeComputeWidths`, `layout-manager.js:193`)
One generic function parameterized to do both axes (`computeWidths` = colSpan/desiredWidth/x; `computeHeights` = rowSpan/desiredHeight/y). Algorithm:
1. Non-spanning cells set `result[col] = max(existing, desiredWidth, forcedMin)`.
2. User-supplied fixed `colWidths` override.
3. Spanning cells processed last (in reverse): if the cell's `desiredWidth` exceeds the sum of the columns it spans (`existingWidth = Σ widths + (span-1)` for the borders between them), the deficit is distributed evenly across the *editable* (non-fixed) columns it covers, `Math.round(dif/editableCols)` at a time. Note the `+1` per internal border is baked into `existingWidth` so spans account for the border chars they swallow.
4. `Object.assign(vals, result, auto)` writes back, then clamp every value to `forcedMin`.

This is the reusable trick: **handle the simple cells first to seed minimums, then let spanning cells only *grow* columns, distributing the overflow.**

### Cell sizing & the `sumPlusOne` border accounting (`cell.js:111`)
`init()` slices `colWidths[x .. x+colSpan]` and reduces with `sumPlusOne` (`a+b+1`, seeded at `-1`) to get the cell's drawable `width`. The `+1` per gap and `-1` seed means a single column = its width, two columns = w1+w2+1 (the shared border), etc. Same for heights. `drawRight` is true only for the rightmost column so only the last cell draws the right edge (interior cells share borders).

### Box-drawing junction selection (`_topLeftChar`, `cell.js:184`)
The hard rendering problem is choosing the correct ┌ ┬ ┐ ├ ┼ ┤ ─ etc. at every junction. For the top edge of each cell, it picks among `topLeft / topMid / top` (first row) or `leftMid / midMid / bottomMid / topMid / mid` (interior rows) based on x position and offset within the cell's spanned width — and crucially inspects neighbor cells in `this.cells` to detect whether a `ColSpanCell` sits above (no vertical divider needed → use `topMid`/`mid`) or a `RowSpanCell` sits to the left (→ `leftMid`). This neighbor-awareness is what makes spanned borders look continuous.

### ANSI-safe text width, wrap, truncate (`utils.js`)
- `strlen` (`:7`): strips SGR codes via regex `\[(?:\d*;){0,5}\d*m`, then uses `string-width` (handles CJK/emoji double-width) per line, returning the max line width.
- `wordWrap` (`:252`): splits on `/(\s+)/g` so whitespace is preserved as alternating tokens; accumulates words until `strlen` would exceed maxLength. `textWrap` (`:283`) is the hard-break variant. `multiLineWordWrap` splits on `\n` first then applies the chosen handler.
- `truncate` (`:186`) + `truncateWidthWithAnsi` (`:155`): truncation walks the string split by SGR codes, re-emitting codes and tracking an SGR `state`, so cuts don't strip mid-color. `unwindState` appends the closing codes (`[39m`/`49m` and per-attribute off codes) so the truncated string is balanced.
- `colorizeLines` (`:312`): when one logical cell line carries color that should continue onto wrapped sub-lines, it carries SGR `state` across lines — `rewindState` prepends active codes to the start of each line, `unwindState` closes them at the end. This is the canonical "make every wrapped line independently styled and self-closing" pattern.

### Vertical/horizontal alignment in draw (`cell.js:133`)
`draw(lineNum)` computes `padTop` from `vAlign` (top/center/bottom) and the gap between `height` and `lines.length`, returns `drawEmpty` for padding lines, else `drawLine(lineNum-padTop)`. `forceTruncation` triggers the `…` when content has more lines than the cell is tall and we're on the last visible line. `drawLine` (`:251`) pads horizontally via `utils.pad` with `hAlign`, wraps with left/right border chars and padding spaces.

### Hyperlinks (`utils.js:327`)
OSC-8 escape: `]8;;<url><text>]8;;`. `truncate` specially re-appends the closing `\x1B]8;;\x07` tag if truncation dropped it.

## Code patterns worth stealing

Sweep-line occupancy for rowspans:
```js
// alloc[col] = number of further rows this column stays occupied
function next(alloc, col){ return alloc[col] > 0 ? next(alloc, col+1) : col; }
// place cell at first free column, then after the row decrement+expire all counters
Object.keys(alloc).forEach(idx => { if (--alloc[idx] < 1) delete alloc[idx]; });
```

Border-aware multi-column width via reduce:
```js
function sumPlusOne(a, b){ return a + b + 1; }   // +1 per shared border
this.width = this.widths.reduce(sumPlusOne, -1); // seed -1 cancels the leading +1
```

ANSI state carried across wrapped lines so each line is self-contained:
```js
let state = {};
for (const raw of inputLines) {
  let line = rewindState(state, raw);   // re-open codes still active from prev line
  state = readState(line);              // parse SGR codes -> {bold:true, lastFg:'\e[31m'...}
  output.push(unwindState({...state}, line)); // close everything at line end
}
```

Two-phase distribution: seed mins from simple cells, then grow only for spanners:
```js
// pass 1: result[col] = max(desiredWidth) over non-spanning cells
// pass 2 (reverse): for each spanner, if desired > sum(spanned cols)+borders,
//                   spread the deficit evenly across non-fixed columns
```

## Gotchas / non-obvious decisions
- **`Table extends Array`** — the table *is* the rows array; `options` is a non-enumerable defined property so `JSON`/iteration only sees rows. Quirky but lets you `table.push([...])`.
- **No diffing / no live update.** Every `toString()` recomputes the full layout from scratch. There is no render loop, no PTY, no input handling. It is a string formatter.
- **Spanners processed in reverse order** in both `addColSpanCells` and the width-distribution loop, to avoid splice/index interference and to let later (lower/right) cells win.
- **`fillInTable` mutates ragged input** into a full grid and only `warn`s about missing cells — silent-ish auto-repair, easy to miss.
- **`draw(lineNum, 10, this.truncate)` at `cell.js:136`** uses a hardcoded `10` for the debug-log preview truncation only — not the real content truncation (which uses the cell width). Easy to misread.
- **Color application is best-effort** — `wrapWithStyleColors` lazily `require('ansis')` inside a try/catch and returns plain content if it throws, so missing/odd styles degrade gracefully. Supports `hex(...)`/`bgHex(...)` parsed by `parseHexValue`.
- **`strlen` returns the max width across `\n`-split lines**, not the sum — used for desiredWidth of multi-line content.
- **Padding is subtracted from `fixedWidth` before word-wrap** (`cell.js:78`) and colSpan columns' widths are summed in so wrapping uses the true inner width.
- **`compact` style** suppresses interior top borders (`table.js:73`) except the header separator.

## Relevance (which advanced-TUI topics this teaches)
- **layout** — the core lesson: grid allocation with col/row spans via interval-overlap conflict detection and a sweep-line occupancy map; two-phase width/height distribution where spanners only grow constrained columns.
- **unicode-text-width** — `string-width` integration, SGR-stripping before measuring, max-over-lines width.
- **ansi-escapes** — SGR state machine (`readState`/`rewindState`/`unwindState`), color-safe truncation, OSC-8 hyperlinks.
- **widgets-rich-content** — box-drawing junction selection with neighbor awareness (continuous borders across spans), vertical/horizontal alignment, word vs hard wrap, vertical truncation with `…`.
- **rendering-pipeline** — a clean example of a *phased* (non-incremental) pipeline: model → layout → measure → init → draw, useful as a contrast to reconciler/diff-based TUIs.
