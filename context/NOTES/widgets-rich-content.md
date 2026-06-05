# widgets-rich-content

Higher-level building blocks for a TUI: prompt state machines + redraw, task-list renderers, tables, markdown-to-terminal, syntax highlighting (TextMate / highlight.js → ANSI), charts, spinners, boxes. This note compares twelve real libraries and extracts the shared engineering.

## TL;DR (the mental model in 3-5 bullets)

- **Almost every "live" widget is the same loop**: build the *entire* frame as one string, then hand it to an in-place updater that diffs against the previous frame and emits a minimal cursor/erase patch. Nobody keeps a per-widget virtual DOM. The only real differences are *who* owns the diff (inquirer/clack roll their own line accounting; listr2 delegates to `log-update`; cli-spinners delegates to whatever the consumer uses) and *what triggers a redraw* (keypress, timer tick, or an event-bus invalidation).
- **Static widgets are pure `data → string` transforms** with a strict phased pipeline and no loop: cli-table3 (model → layout → measure → init → draw), boxen (normalize → dimension → content → border), asciichart (range → quantize → fill grid → join). They produce a string region you blit into the live frame.
- **The single hardest sub-problem is display width.** `String.length` is wrong the moment ANSI codes, CJK, or emoji are present. The good libraries measure in *terminal columns* (`string-width`) and strip SGR before measuring; the cautionary ones (marked-terminal) only strip ANSI and silently miscount wide chars.
- **Styling/highlighting is a token-stream-to-ANSI mapping**: shiki decodes bit-packed TextMate metadata into truecolor SGR (flattening alpha first because terminals have no alpha); cli-highlight reuses highlight.js's *HTML* as a token stream and maps `hljs-*` classes to chalk fns; both delegate SGR open/close pairing and nesting to a styling lib like `ansis`.
- **The clean architecture is a headless engine + injected render closure / pluggable renderer.** clack (core ↔ prompts via a `render()` closure), listr2 (one task state machine ↔ passive renderers), inquirer (a React-hooks reconciler ↔ pure-function prompts), shiki (engine ↔ tokenizer ↔ backend renderer) all keep the loop in one place and let the visual layer be swapped.

## How it actually works (the mechanism, step by step)

### The live-redraw loop (the spine of every animated widget)

There are two design points everyone converges on, with different ownership.

**A. Roll-your-own line accounting (inquirer, clack).** No diff library; the renderer tracks how many lines it printed last and erases/repaints.

inquirer's `ScreenManager` (`context/inquirer/packages/core/src/lib/screen-manager.ts:88`) does the brute-force version — full-frame erase-and-redraw every tick:

```
this.write(cursorDown(this.extraLinesUnderPrompt) + eraseLines(this.height) + output);
this.extraLinesUnderPrompt = bottomContentHeight;
this.height = height(output);
```

`eraseLines(n)` (`context/inquirer/packages/ansi/src/index.ts:31`) is `(ESC[2K + cursorUp(1)).repeat(n-1) + ESC[2K + cursorLeft` — erase the current line and walk up. The view function re-runs entirely on every state change and returns a fresh string; the "reconciler" is just line counting. There is no text diff at all.

clack is the smarter version (`context/clack/packages/core/src/prompts/prompt.ts:284`): it computes the full frame, hard-wraps it ANSI-aware, then does `if (frame === this._prevFrame) return;` (cheapest no-op), and otherwise runs `diffLines(prev, next)` (`utils/string.ts`) — a naive index-by-index line comparison returning *which line numbers changed*. Then it branches on cardinality (`prompt.ts:297`):

- **Exactly one changed line** → move to it, `erase.lines(1)`, rewrite just that line, park cursor at bottom. This is the flicker-free single-character-typed path.
- **Multiple lines** → move to the first change, `erase.down()`, rewrite the whole tail.
- The genuinely subtle part is **scroll-aware cursor math** (`prompt.ts:296-325`): when the prompt is taller than the terminal, top lines have scrolled off and the cursor can't reach them. It computes `diffOffsetBefore/After = max(0, numLines - rows)` and only acts on diff lines `>= diffOffsetAfter`, with `restoreCursor()` doing `cursor.move(-999, -lines)` (the `-999` "go to column 0" idiom).

**B. Delegate the diff to a line-counting library (listr2, cli-spinners, ora-likes).** The renderer builds the whole frame and hands it to `log-update`, which owns all cursor math.

listr2's `DefaultRenderer.update()` is literally `this.updater(this.create())` (`context/listr2/packages/listr2/src/renderer/default/renderer.ts:111`), where `this.updater = createLogUpdate(...)` and `create()` does a recursive tree-walk producing the full string. Two redraw triggers (`renderer.ts:88`): a `Spinner` whose 100 ms interval calls `update()` (so frames animate), **and** a subscription to `ListrEventType.SHOULD_REFRESH_RENDER` (so state changes redraw immediately).

`log-update` v8 (`context/log-update/index.js`) is the reference implementation of the delegated diff:
1. `computeFrame` normalizes, **guarantees a trailing newline** (`index.js:189`) so the cursor always parks on a known blank line, and hard-wraps with `wrapAnsi(raw, width, {trim:false, hard:true, wordWrap:false})`.
2. `fitToTerminalHeight` (`index.js:18-61`) clips from the *top* when too tall, using `sliceAnsi` and a tricky `+1`-per-line correction (`stringWidth('\n')` is 0 but `sliceAnsi` counts `\n` as one column).
3. `diffFrames` (`index.js:66-82`) is a common-prefix/common-suffix line diff → minimal changed block.
4. `buildPatch` (`index.js:87-160`) turns the diff into one escape string: move to the first changed line, `eraseLine`+`cursorDown` per old line, write new block with `eraseEndLine` (wipe stale trailing chars), reposition to the trailing blank line.
5. `render` (`index.js:204-288`) is a strategy cascade: no-op → first-frame plain write → full-erase on width change/clip (diff invalid after reflow) → minimal patch.
6. Whole-frame writes are wrapped in DEC synchronized-output `ESC[?2026h … ESC[?2026l` (`index.js:166`) so supporting terminals present atomically with no tearing.

Note listr2's `end()` deliberately bypasses log-update for the final frame (`renderer.ts:124`): `updater.clear()` + `updater.done()` then writes the persisted frame straight to stdout — because log-update only tracks the *seen height*, persisted scrollback must be written raw. (`log-update.persist()`, `index.js`, is the symmetric escape hatch.)

### Caret rendering without moving the real cursor

Both inquirer and clack hide the real terminal cursor and render the caret as a styled character in the frame. clack's `userInputWithCursor` (core `text.ts:10`) appends a `█` block at end-of-string, or wraps the char under the caret in `styleText('inverse', ...)`. This sidesteps all cursor-coordinate bookkeeping across wrapped/multiline frames. inquirer is the exception: it lets Node `readline` own the editable line and only feeds `rl.setPrompt()` the *non-editable* prefix (`screen-manager.ts:39-50`), syncing the cursor column on keypress via `checkCursorPos()`.

### Prompt state machines

clack's `state: ClackState = 'initial'|'active'|'cancel'|'submit'|'error'` (`context/clack/packages/core/src/types.ts`) is the single source of visual truth; the injected `render(this)` closure switches on it. Transitions happen in `onKeypress` (`prompt.ts:212`): `error` auto-recovers to `active` on next key; `return` runs validation (fail → `error` + re-inject input into readline; pass → `submit`); cancel key → `cancel`; on submit/cancel it emits `finalize`, renders one last time, and closes. inquirer instead models state inside React-style hooks (`useState` in `context/inquirer/packages/core/src/lib/use-state.ts`) over an `AsyncLocalStorage`-backed index-addressed hook store (`hook-engine.ts`), with `withUpdates` batching multiple `setState`s into one render.

### Task-list renderer (listr2)

The reactive core is **setter "channels"** on `Task` (extends `EventEmitter`): assigning `task.state$ = FAILED` mutates state, emits a per-task event, cascade-cancels children, *and* fires `SHOULD_REFRESH_RENDER` on the one shared `ListrEventManager` bus. Frame assembly (`create()` → `renderer(tasks, level)`, `renderer.ts:130/269`) is a recursive `flatMap` over the tree with `level*indentation`. Two performance tricks: **finished-task freezing** — `if (this.cache.render.has(task.id)) return cache.get(...)` (`renderer.ts:277`) so done subtrees never recompute; and **output capture by monkeypatching `stream.write`** (`utils/process-output/process-output-stream.ts:31`) into a timestamped ring buffer so stray `console.log` never corrupts the live frame, exposed back via a `Proxy` that only overrides `write`. ANSI is *cleansed* not parsed (`utils/format/cleanse-ansi.ts` strips cursor/clear sequences with two regexes, keeps color SGR) so captured output can't fight log-update. Renderer selection degrades to the append-only `simple` renderer when `!isTTY && !renderer.nonTTY` (`utils/ui/renderer.ts:26`).

### Tables (cli-table3) — the layout-math widget

Strictly phased, no loop (`context/cli-table3/src/table.js:38`): prepend head → `makeTableLayout` → per-cell `mergeTableOptions` (wrap, desired sizes) → `computeWidths`/`computeHeights` → per-cell `init` → row-by-row draw.

- **Grid allocation with spans** (`layout-manager.js`): `layoutTable` assigns `(x,y)` using a sweep-line `alloc` map `{col: rowsRemaining}` tracking vertical occupancy from rowspans above; `next(alloc,col)` skips occupied columns. Conflict detection is pure interval overlap on both axes (`cellsConflict`, `:51`). `fillInTable` (`:127`) auto-patches sparse/ragged input with synthetic cells.
- **Width distribution** (`makeComputeWidths`, `:193`): one generic fn for both axes. Pass 1 seeds minimums from non-spanning cells; pass 2 (reverse) lets each spanner *only grow* the editable columns it covers, distributing the deficit evenly. Border accounting via `sumPlusOne` reduce (`a+b+1`, seed `-1`) so N columns = Σw + (N-1) shared borders.
- **Junction selection** (`_topLeftChar`, `cell.js:184`) inspects neighbor cells to pick `┌┬┐├┼┤` correctly — detecting a `ColSpanCell` above (no divider) or `RowSpanCell` to the left — which is what makes spanned borders look continuous.
- ANSI-safe primitives in `utils.js`: `strlen` strips SGR then `string-width`; `colorizeLines`/`rewindState`/`unwindState` carry SGR state across wrapped sub-lines so every wrapped line is self-closing; truncation re-emits closing codes; OSC-8 hyperlinks.

### Markdown → terminal (marked-terminal)

A `marked` renderer extension (`context/marked-terminal/index.js`). Key tricks: `textLength` strips ANSI before counting (`:70`, the load-bearing primitive — but counts code points, so wide chars miscount). `reflowText` (`:405-499`) word-wraps colored text by splitting on the SGR regex into fragments and never wrapping a zero-width (escape) fragment. Hard breaks use `\r` as an in-band sentinel (`:26`) safe because marked's lexer normalizes `\r`→`\n`. Tables are bridged from marked's streaming `tablecell`/`tablerow` to cli-table3's 2-D array by suffixing magic delimiters (`^*||*^`, `*|*|*|*`) and re-splitting in `table()` (`:253-265`). Code blocks delegate to cli-highlight with graceful degradation (`highlight()` short-circuits when `chalk.level === 0`, `:591`). Links use OSC-8 only when `supportsHyperlinks.stdout` (`:326`).

### Syntax highlighting → ANSI (two opposite strategies)

**shiki** runs real VSCode TextMate grammars. The hot path decodes a bit-packed `Uint32Array` from `tokenizeLine2` two entries at a time (`context/shiki/packages/primitive/src/highlight/code-to-tokens-base.ts:190`): foreground is an *index into the theme's `colorMap: string[]`* (colors interned once), `fontStyle` is a bitfield checked with `&`. Cross-line state is the single `stateStack` (resumable highlighting — cache one `GrammarState` per line, re-tokenize only from the first changed line). The terminal renderer (`context/shiki/packages/cli/src/code-to-ansi.ts:25`) emits truecolor `38;2;r;g;b` via `ansis`, layering bold/italic/underline by `fontStyle &` flags — **but first flattens alpha** (`cli/src/colors.ts` `hexApplyAlpha` composites `#rrggbbaa` over the theme bg) because terminals have no alpha channel. Guards against catastrophic backtracking: `tokenizeMaxLineLength`, `tokenizeTimeLimit` (500 ms).

**cli-highlight** is the lightweight inversion (`context/cli-highlight/src/index.ts`): highlight.js only emits HTML, so it *reuses that HTML as the token stream* — `parse5` re-parses `<span class="hljs-keyword">` into a tree, and `colorizeNode` recursively maps `hljs-*` classes to chalk fns, styling at the tag boundary on the joined child string so chalk's nested resets just work. Three-level fallback inlined at the call site: `(theme[tok] || DEFAULT_THEME[tok] || plain)(text)`. Sublanguage spans without an `hljs-` prefix recurse with `context` reset (`:27-29`).

### Charts (asciichart)

A ~110-line pure `plot(series, cfg)` (`context/asciichart/asciichart.js:33`). Project value space onto a discrete grid via a single `ratio = height/range` (`:57`), `rowOf(v) = round(v*ratio) - min2`. Allocate a `(rows+1)×width` framebuffer of *string* cells (so a cell can hold a multi-char label or an ANSI-wrapped glyph without breaking the join). Draw line segments with **slope-aware glyph selection** (`:86-106`): `y0==y1` → `─`; rising/falling → corner elbows `╰╭╮╯` at the two heights plus `│` fill between; row index flipped via `result[rows - y]` because array row 0 is the top. Color wraps the glyph (`color+char+reset`) and costs no width accounting because columns are reserved structurally by `offset` *before* coloring.

### Boxes (boxen)

Pure string composition, no buffer (`context/boxen/index.js:343`): normalize → `determineDimensions` → `makeContentText` → `boxContent`. The invariant that makes border-wrapping trivial: **after `makeContentText`, every content line has identical display width**, so the border code blindly prepends/appends the vertical glyph. Padding is `width - stringWidth(line)` (`:188`) — measured in columns, emoji-safe. `getBorderWidth` is the constant 2; the user's `width` is the *outer* size, converted to content width once up front (`:268`). Cleverest part is margin *shrinking* (`:307-318`): when box+margins overflow, scale margins proportionally rather than clip. Titles are embedded into the top-border run (`makeTitle`, `:101`), not a separate row. The `none` border is modeled as empty-string glyphs so the same assembly path runs.

### Spinners (cli-spinners as data; the loop lives in consumers)

cli-spinners is *data-as-API*: `spinners.json`, 90 entries of `{interval, frames[]}`. The render contract is implicit and pushed onto consumers: `setInterval(interval)` → `i = ++i % frames.length` → repaint via log-update. Two non-obvious rules: **per-animation timing is baked into the data** (intervals 17–400 ms), and **frames must be display-width constant** — enforced with `string-length` not `.length` (`test.js:26`), because in-place overwrite without clearing leaves stale glyphs when a wide frame follows a narrow one. Emoji frames carry deliberate trailing spaces (`"🕛 "`) to normalize double-width cells. clack's spinner (`context/clack/packages/prompts/src/spinner.ts`) shows the consumer side: its own `setInterval(delay)` (`delay = unicode ? 80 : 120`), `frames = unicode ? ['◒','◐','◓','◑'] : ['•','o','O','0']`, a `block()` to swallow input while active, and `uncaughtException`/`SIGINT`/`exit` hooks so a crash stops the spinner instead of freezing it. inquirer's `use-prefix.ts` waits 300 ms before showing a spinner to avoid flicker on fast ops.

### The SGR styling substrate (ansis)

Underneath everything that emits color. Each style carries cumulative `openStack = parent.open + open` and `closeStack = close + parent.close` (reversed) (`context/ansis/src/index.js:33`). Closes are **attribute-specific resets** (`22` bold, `39` fg, `49` bg) never blanket `[0m`, so one layer peels off without wiping others. Nested-style restoration (`:60-83`): walk ancestors and `replaceAll(child._close, child._open)` inside child output so an inner `green` doesn't kill the outer `red`'s trailing text — guarded by `if (output.includes('\x1b'))`. Multiline `\n` is rewrapped `closeStack + '\n' + openStack` (`:85`) so background colors don't bleed across line breaks. Truecolor→256→16→BW downgrade is composed at construction time so the hot path is branch-free.

## Cross-repo comparison

| Concern | Who / how | Tradeoff |
|---|---|---|
| Live redraw, own diff | inquirer (full erase+redraw, no text diff), clack (line-index diff + cardinality branches + scroll math) | inquirer simplest but repaints whole block; clack near-optimal but the off-screen cursor math is where most line-mode renderers break |
| Live redraw, delegated diff | listr2 → log-update; cli-spinners → consumer's updater | clean separation, terminal-agnostic data; but `persist`/final-frame needs a raw-write escape hatch around log-update's height tracking |
| Diff granularity | clack: changed *line indices* only; log-update: common-prefix/suffix block | neither computes a true edit script; both abandon diffing on reflow (width/height change) and full-erase |
| Redraw trigger | inquirer/clack: keypress; listr2: 100ms timer + event-bus invalidation; cli-spinners: timer only | event-bus avoids polling for state changes; timer needed only for animation frames |
| Caret | clack: styled char in frame (real cursor hidden); inquirer: readline owns the line, sync column on keypress | clack avoids all cursor-coord bookkeeping; inquirer gets free readline editing (backspace/word-delete) |
| Display width | string-width: cli-table3, boxen, log-update, cli-spinners (correct) vs marked-terminal `textLength` (strips ANSI only — wide chars miscount) | the recurring fault line; only column-accurate measurement keeps borders aligned |
| Highlighting | shiki (real TextMate, bit-packed metadata, alpha-flatten, resumable) vs cli-highlight (reuse hljs HTML as token stream) | shiki = fidelity + incremental re-highlight + WASM/JS engine choice; cli-highlight = tiny, no streaming, leans on chalk for all SGR |
| SGR emission | ansis (attribute-specific resets, nesting restoration) vs chalk (cli-highlight, marked-terminal) | ansis lets you peel one attribute; chalk is the ubiquitous default |
| Static layout style | cli-table3 / boxen / asciichart: phased pure functions; cli-table3 uses a 2D cell grid, boxen pure string concat, asciichart a string-cell framebuffer | grid needed for spans/junctions; string concat suffices when every line is pre-sized to equal width |
| Capability fallback | unicode→ASCII glyph maps (clack `common.ts`, listr2), `chalk.level===0` short-circuit (marked-terminal, cli-highlight), non-TTY 80×24 (log-update, boxen) | everyone degrades; the question is whether they detect at glyph level or whole-feature level |

**Where they agree:** full-frame string generation, ANSI-aware wrapping, measure-in-columns, capability-gated glyphs, delegate SGR to a styling lib, abandon diffing on reflow.
**Where they differ:** who owns the diff (self vs log-update), diff granularity (none / line-index / prefix-suffix block), and whether width is measured correctly (string-width) or approximately (strip-ANSI only).

## Pitfalls & hard parts

- **`String.length` is a lie.** ANSI escapes, CJK (2 cols), emoji (surrogate pairs, often 2 cols), combining marks. Use `string-width` and strip SGR first. marked-terminal's `textLength` strips ANSI but not wide chars — its table/reflow widths are wrong for non-ASCII. cli-spinners validates with `string-length`, *not* `.length`, for exactly this reason.
- **The `\n`-vs-column off-by-one.** `stringWidth('\n') === 0` but `sliceAnsi` counts `\n` as one column. log-update's height-clip adds `+1` per removed line (`index.js:37`) and then nudges the cut ±1 until height matches. Forgetting this corrupts top-clipping.
- **Off-screen cursor math.** When the frame exceeds terminal rows, you cannot move the cursor to scrolled-off lines. clack's `diffOffsetBefore/After` filter (`prompt.ts:296`) exists solely for this; it's the most error-prone part of any line-mode renderer.
- **Diffing dies on reflow.** Width change or height clip reflows every line, invalidating line-to-line correspondence — you must full-erase, not patch (log-update `index.js:240`).
- **The trailing-newline invariant.** log-update parks the cursor on a blank line below content; `shouldWriteTrailingNewline` exists only to preserve it after a partial patch (`index.js:131`). Break it and all subsequent cursor math drifts.
- **Stray output corrupting the frame.** Any `console.log` during a live render tears the frame. listr2 monkeypatches `stream.write` into a ring buffer and replays it cleansed on release — the only robust fix.
- **Alpha in terminal colors.** TextMate themes carry `#rrggbbaa`; passing that to a truecolor `38;2` sequence silently drops alpha and looks wrong. shiki composites over the theme bg first (`hexApplyAlpha`).
- **Catastrophic regex backtracking** on long/minified lines in TextMate highlighting — needs `tokenizeMaxLineLength` + per-line time limits.
- **Constant-width spinner frames.** In-place overwrite without clearing leaves stale glyphs if frame width varies; emoji frames need trailing-space padding; don't `.trim()` them.
- **In-band sentinels are pragmatic, not airtight.** marked-terminal's table/colon delimiters ("improbable" strings) can collide with real source text.
- **Raw mode disables SIGINT.** If you take over input (spinners, prompts) you must re-handle Ctrl-C yourself or the process is unkillable.
- **Nested SGR bleed.** An inner style's close code (`[39m`) kills the outer style for trailing text unless you re-open it (ansis's restoration walk) or let chalk emit balanced resets.

## If you were building this from scratch (recommended approach)

Build a small layered stack. Do **not** write your own line-diff if you can avoid it.

```
// Layer 0: styling — use ansis/chalk. Never hand-roll SGR.
// Layer 1: width — one function, used everywhere.
const colsOf = (s) => stringWidth(stripAnsi(s));   // terminal columns, not .length

// Layer 2: live region — wrap log-update; it already does diff + synced output + clipping.
const region = createLogUpdate(process.stdout);
function repaint() { region(buildFrame()); }        // build full string, let it diff

// Layer 3: state + triggers — one state object is the source of visual truth.
const bus = new EventEmitter();
state.set = (k, v) => { state[k] = v; bus.emit('dirty'); };   // setter channel
bus.on('dirty', repaint);                                     // event-driven redraw
if (animated) setInterval(repaint, frameInterval);            // + timer for spinner frames

// Layer 4: frame builder — compose static widget strings into regions.
function buildFrame() {
  return [ boxify(title), taskTree(tasks), bottomBar(lastNLines) ]
    .filter(Boolean).join('\n');
}

// Static widgets are PURE: data -> equal-width lines -> joined string.
function boxify(text) {
  const lines = wrapAnsi(text, width, { hard: true }).split('\n')
    .map(l => l + ' '.repeat(width - colsOf(l)));        // equal-width invariant
  return [tl + h.repeat(width) + tr,
          ...lines.map(l => v + l + v),
          bl + h.repeat(width) + br].join('\n');
}

// On exit / persisted output: bypass the live region so it lands in scrollback.
function persist(s) { region.clear(); process.stdout.write(s + '\n'); }
```

Key decisions, justified by the comparison:
- **State machine, not flags.** A single `state` enum/object as the source of truth (clack) is far easier to reason about than scattered booleans. Setter channels (listr2) make redraw invalidation automatic.
- **Full-frame rebuild + delegated diff.** Building the whole string each tick and letting `log-update` patch it is simpler and less buggy than custom cursor math, and you get synchronized output + height-clipping for free.
- **Two redraw triggers**: event-bus for state changes, timer only for animation frames.
- **Render the caret as a styled char, hide the real cursor** (clack) unless you specifically want readline's editing for free (inquirer).
- **Freeze finished work** (listr2's render cache) so per-frame cost stays bounded.
- **Capability detection up front**: pick unicode vs ASCII glyph sets, gate hyperlinks/color on `chalk.level`/`supportsHyperlinks`, fall back to 80×24 and a plain append-only renderer when not a TTY.
- **For highlighting**: use shiki if you need fidelity + incremental re-highlight (cache `GrammarState` per line); use cli-highlight/chalk if you just need cheap fenced-code coloring. Either way flatten alpha before emitting truecolor.

## Source map (what to read for more)

- **Live redraw / diff**: `context/log-update/index.js` (`computeFrame`, `diffFrames` :66, `buildPatch` :87, `render` :204, synced output :166). `context/clack/packages/core/src/prompts/prompt.ts:284-336` (full-frame + cardinality diff + scroll math). `context/inquirer/packages/core/src/lib/screen-manager.ts:88` + `packages/ansi/src/index.ts:31` (erase-and-redraw).
- **Prompt state machine / hooks**: `context/clack/packages/core/src/{types.ts,prompts/prompt.ts}`; `context/inquirer/packages/core/src/lib/{hook-engine.ts,use-state.ts,create-prompt.ts}`.
- **Task-list renderer**: `context/listr2/packages/listr2/src/renderer/default/renderer.ts` (:88 triggers, :111 update, :130/269 tree walk, :277 cache, :124 end); `lib/task.ts` (setter channels); `utils/process-output/process-output-stream.ts:31` (write hijack); `utils/format/cleanse-ansi.ts`.
- **Tables**: `context/cli-table3/src/layout-manager.js` (:13 layoutTable, :193 width distribution), `src/cell.js:184` (junctions), `src/utils.js` (strlen, colorizeLines, truncate).
- **Markdown**: `context/marked-terminal/index.js` (:70 textLength, :405 reflowText, :253 table bridge, :591 highlight, :326 link).
- **Highlighting**: `context/shiki/packages/primitive/src/highlight/code-to-tokens-base.ts:190` (metadata decode), `packages/cli/src/code-to-ansi.ts:25` + `src/colors.ts` (ANSI out + alpha flatten); `context/cli-highlight/src/index.ts` (HTML-as-token-stream, colorizeNode) + `src/theme.ts`.
- **Charts**: `context/asciichart/asciichart.js:33-108` (whole engine).
- **Boxes**: `context/boxen/index.js` (:135 makeContentText, :208 boxContent, :278 determineDimensions, :101 makeTitle, :307 margin shrink).
- **Spinners**: `context/cli-spinners/{spinners.json,test.js:26}`; `context/clack/packages/prompts/src/spinner.ts`; `context/inquirer/packages/core/src/lib/use-prefix.ts`.
- **SGR substrate**: `context/ansis/src/index.js` (:33 stacks, :60 nesting restore, :85 multiline) + `src/color-math.js` (downgrade), `src/color-support.js` (detection).
