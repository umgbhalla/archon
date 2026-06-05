# react-curse

## What it is (1-2 lines)
A curses-like React renderer for the terminal (react-reconciler host config) whose distinguishing feature is per-cell diffing: each frame it rebuilds a `Char[][]` screen buffer, diffs it against the previous buffer, and emits the minimal ANSI to repaint only changed cells. Supports fullscreen (alt-buffer) and inline modes, keyboard + mouse, with the only runtime deps being `react` and `react-reconciler`.

## Architecture (how the pieces fit; key files with paths)
Pipeline is a clean 4-stage separation, all in the repo root:

1. `reconciler.ts` — react-reconciler host config. The host tree is a tree of `TextElement` nodes (only one element type: `<text>`). Reconciler is mutation-based and trivially simple; mutations just push/splice children arrays. `resetAfterCommit` callback triggers a render.
2. `screen.ts` (`Screen`) — Layout + rasterization. Walks the `TextElement` tree, resolves positions/sizes/bounds, and paints into a 2D `Char[][]` buffer where `Char = [string, Modifier]`. No ANSI here — pure cell array.
3. `term.ts` (`Term`) — Diffing + ANSI emission. Diffs new buffer vs `prevBuffer`, groups runs of changed cells into chunks, computes minimal cursor-move escapes, builds the SGR modifier sequences, and writes to stdout. Owns alt-buffer/cursor lifecycle and resize handling.
4. `input.ts` (`Input`) — Raw stdin parser. Splits a stdin chunk into discrete key/escape/mouse "chunks", dispatched via an EventEmitter.

Glue:
- `renderer.ts` (`Renderer`, default-exported singleton) — wires the four together. `render()` boots `Term`, then `createContainer`/`updateContainer`. The `throttle` method is the frame loop: caps at 60fps, then `screen.render(container.children)` → `term.render(screen.buffer)` → `input.render()`.
- `index.ts` — public API surface (re-exports renderer + components + hooks).
- `components/Text.tsx` — the ONLY primitive; everything else (`View`, `List`, `Frame`, `Canvas`, `Bar`, `Scrollbar`, `Input`, `Spinner`, `Banner`) is composed from `<Text>`. `Text` just renders the intrinsic `<text>` host element with all props passed through.
- `hooks/` — `useInput`, `useMouse`, `useSize`, `useChildrenSize`, `useWordWrap`, `useAnimation`/`useTrail`, `useClipboard`, `useBell`, `useExit`.

## Core techniques (the actual TUI engineering)

### Frame loop / throttling (`renderer.ts:97-107`)
react-reconciler's `resetAfterCommit` does not render directly — it calls `throttle`. Throttle coalesces commits to ~60fps via a `setTimeout` whose delay is `Math.max(0, 1000/60 - (now - lastFrame))`, clearing any pending timeout. So a burst of React state updates collapses into one repaint. The render order each frame is: rasterize tree → diff+flush ANSI → drain one queued input chunk.

### The host tree is dead simple (`reconciler.ts:6-54`)
`TextElement` holds `{props, parent, children[]}`. `appendChild`/`insertBefore`/`removeChild` are array ops. `TextInstance` wraps a string with a `toString()`. Only `createInstance('text')` is legal — any other host type throws `'must be <Text>'`. `shouldSetTextContent` returns false so text always becomes child `TextInstance`s. Update priority plumbing (`setCurrentUpdatePriority` etc., `:83-86`) is the only react-reconciler 0.32 ceremony; default priority 16 (DefaultLane).

### Layout: percent/relative bounds resolution (`screen.ts:84-157`)
There is no flexbox. Layout is recursive bounds propagation. Each element carries optional `x/y/width/height` (number OR percent-string like `"100%-1"`) and `absolute`/`block` flags.
- `stringAt` (`:73-82`) parses `"50%"`, `"100%-1"`, `"%-3"` into a cell count relative to either the full screen (`absolute`) or the parent's interior (`x2-x`). Regex `/%[+-]\d+$/` extracts the `+N/-N` offset.
- `bounds = {x,y, x1,y1, x2,y2}`: `x/y` is the draw cursor origin; `x1,y1,x2,y2` is the clip rectangle. Children inherit and intersect (`Math.max`/`Math.min`) parent clip — this is the clipping mechanism that keeps a child from drawing outside its parent (used by `View` for scroll windows).
- `block` prop = "newline after me"; calls `carret()` to advance the cursor to next row at parent's left edge. `width`/`height` also reposition the cursor after the element (inline-vs-block flow).
- Modifiers (color/bold/etc.) inherit down: child merges its own props over `prevProps`, keeping only truthy ones (`:129-133`).

### Rasterization (`screen.ts:159-187`)
- `fill()` paints a rectangle of `[' ', modifiers]` for `background`/`clear` (with clipping).
- `put()` writes a string char-by-char into the row, respecting clip bounds, returns the new cursor x.
- Multi-line text is split on `\n` and each line re-rendered with a `carret()` between (`:141-146`).
- Buffer is fully regenerated each frame (`generateBuffer` allocs `rows × cols` of `[' ', {}]`). Diffing happens later in Term, so Screen is stateless/idempotent.

### The diff + minimal-ANSI emitter (`term.ts:178-303`) — the clever core
For each row `y`:
1. **Cell diff** (`:197-205`): map each cell against `prevBuffer[y][x]`; cells equal in both char AND modifier (compared via `JSON.stringify`) become `null`, others kept. On resize in fullscreen, `full=true` forces a complete repaint after `ESC[H`.
2. **Chunking** (`:207-223`): consecutive non-null cells are grouped into chunks keyed by their starting x. A `null` cell bumps `chunksAt = x+1`, breaking the run. Each chunk accumulates two strings: plain `[0]` (for width/emoji detection) and `[1]` with embedded SGR sequences. SGR is only emitted when `modifier` differs from the running `prevModifier` — so color codes are not repeated per cell.
3. **Cursor positioning** (`:225-274`): for each chunk it computes the cheapest cursor move from the tracked `this.cursor`:
   - same column 0 and exactly next row → just `\n`
   - row+col both differ → absolute `ESC[{y};{x}H`
   - only row differs → `ESC[{n}B` / `ESC[{n}A` (down/up, omit count if 1)
   - only col differs → `ESC[{n}C` / `ESC[{n}D` (right/left)
   This is what makes it "draw only changed cells" with minimal bytes — great for SSH.
4. **Modifier state** persists across rows in `prevModifier`; `createModifierSequence` (`:152-171`) only emits the SGR params that changed vs prev (e.g. just `31` for color), and resets via 39/49/22/23/... codes. Empty modifier → `'0'` (full reset).

### Wide-char / emoji / nerd-font handling (`term.ts:173-176, 228-268`)
Emoji and "icon" glyphs (private-use / specific codepoint ranges in `isIcon`) occupy 2 cells but the buffer tracks 1, so naive relative cursor math drifts. When a chunk `includesEmoji`/`includesIcon`, it falls back to absolute column positioning: `ESC[G` (col 0) then `ESC[{x}C` (right N) instead of relative `C/D`. This sidesteps the terminal's own width accounting.

### Color parsing (`term.ts:105-150`)
Accepts: named (`Red` → 31, `BrightRed` → 91), 256-index `number` → `38;5;{n}`, hex `#rrggbb`/`#rgb` → truecolor `38;2;{r};{g};{b}`. Background uses `+10` offset (`parseColor(color, 10)`). `parseHexColor` expands 3-digit shorthand.

### Inline mode + cursor bookkeeping (`term.ts:36-39, 56-72, 231-281`)
Fullscreen uses alt screen buffer `ESC[?1049h` + clear `ESCc`. Inline mode instead queries the real cursor position up front via DSR `ESC[6n` and parses the `ESC[{row};{col}R` reply (`termGetCursor`, `:87-103`), storing it as `offset`. Render then tracks `maxCursor` (furthest the content has grown) and emits `\n`s to scroll, adjusting `offset.y` when content pushes past the bottom row. On terminate it moves the cursor to just past the content and re-shows it (`ESC[?25h`). This is the hard part of "inline" — keeping a virtual viewport inside a scrolling terminal without owning the whole screen.

### Input parsing (`input.ts:26-56`)
Hand-rolled state machine over the stdin string. It greedily consumes escape sequences by length: `ESC` (1b) + next byte; if it ends in `[` (5b) take another (arrows = `1b 5b 41`); if that's `1/4/5/6` take a `~` terminator (pageup/down/home/end); if it's `M` take 3 more bytes (X10 mouse report `1b 5b 4d b x y`). Multiple keypresses in one chunk are split into `chunks[]`; extras beyond the first are stashed in `queue` and drained one-per-frame by `render()` (so paste/fast-typing doesn't lose keys but also doesn't flood a single frame). `\x03` (Ctrl-C) → `process.exit()` in `useInput`.

### Mouse decode (`hooks/useMouse.ts:17-27`)
X10/1000 protocol enabled via `ESC[?1000h ESC[?1005h` (`term.enableMouse`). Button byte at index 3: `(1<<6)&b` = wheel (then `1&b` distinguishes up/down), `(3&b)===3` = mouseup else mousedown. Coords are `charCodeAt(4/5) - 0o41` (the `-33` X10 offset).

## Code patterns worth stealing

**Frame-rate-capped commit coalescing** (decouple React commits from paints):
```ts
private throttle = () => {
  const nextAt = Math.max(0, 1000/60 - (Date.now() - this.throttleAt))
  clearTimeout(this.throttleTimeout)
  this.throttleTimeout = setTimeout(() => {
    this.throttleAt = Date.now()
    this.screen.render(this.container.children) // tree -> Char[][]
    this.term.render(this.screen.buffer)        // diff -> ANSI -> stdout
    this.input.render()                          // drain 1 queued key
  }, nextAt)
}
```

**Cell as `[char, modifier]` tuple** — the whole buffer is `Char[][]`, and equality is `char1!==char2 || JSON.stringify(m1)!==JSON.stringify(m2)`. Simple, correct, no per-cell class.

**Minimal cursor move from tracked position** (instead of always absolute-positioning):
```ts
if (y!==cur.y && x!==cur.x) move = `ESC[${y+1};${x+1}H`     // both -> absolute
else if (y>cur.y)          move = `ESC[${(d>1?d:'')}B`       // down N
else if (x>cur.x)          move = `ESC[${(d>1?d:'')}C`       // right N
// ...emoji/icon -> fall back to ESC[G + ESC[xC (absolute col)
```

**SGR delta encoding** — keep `prevModifier`; only push the codes that changed:
```ts
if (m.color !== prev.color) seq.push(m.color ? parseColor(m.color) : 39)
if (m.bold  !== prev.bold)  seq.push(m.bold ? 1 : 22)
// ... join(';') -> `\x1b[${seq}m`
```

**Percent layout DSL** (`"100%-1"`, `"50%"`) resolved against parent interior or full screen:
```ts
const pct = parseFloat(value)
const diff = value.match(/%[+-]\d+$/) ? value.slice(idx+1) : '0'
return Math.round(limit/100 * pct) + parseInt(diff)
```

**Scroll viewport = negative-offset child inside a clipped parent** (`View.tsx`): outer `<Text height={h}>` clips, inner `<Text y={-yo}>{children}</Text>` slides; `useChildrenSize` measures content height, vi/arrow keys adjust `yo`, `Scrollbar` pinned at `x="100%-1"`.

**Braille/quadrant canvas for sub-cell graphics** (`Canvas.tsx`): pack a sub-cell pixel grid into a byte per cell, OR-in bits with a per-mode `map`, then map byte → braille (`0x2800 + i`) or block-element char via a lookup `table`. `2x4` mode = braille (8 dots/cell); includes a Bresenham `line()` and half-block two-color trick (`▀` with separate fg/bg when the two stacked pixels differ).

**Module-level resize subscriber set** (`useSize.ts`): one `process.stdout.on('resize')` fans out to all hook instances via a `Set<setState>` — avoids N listeners.

## Gotchas / non-obvious decisions
- **`JSON.stringify` for modifier equality** is used both in the per-cell diff and SGR-change check (`term.ts:203, 217`). Simple but allocates and is key-order sensitive (fine here since keys are constructed in fixed order).
- **Buffer fully reallocated every frame** (`generateBuffer`); cheap-ish for terminal sizes, and lets Screen stay stateless. Diffing is what saves I/O, not buffer reuse.
- **Only `<Text>` exists.** All layout semantics live in props (`x,y,width,height,absolute,block`) interpreted by `Screen`, not in distinct element types. Keeps the reconciler trivial but pushes all complexity into `renderElement`.
- **Inline mode relies on DSR `ESC[6n` round-trip** at startup and on `\n`-based scroll accounting with `offset`/`maxCursor`. This is fragile across terminals and is where the trickiest, most-commented code is.
- **Emoji width handling is heuristic** (`isIcon` codepoint ranges + `/\p{Emoji}/u`), not a real wcwidth table — wide CJK outside those ranges can misalign.
- **`spawnSync` re-inits the terminal** (`renderer.ts:77-86`) so you can shell out to an editor/pager and restore the UI after.
- **Mouse-down events are swallowed in `useInput`** (`input.startsWith('\x1b\x5b\x4d')` returns) so keyboard handlers don't see mouse bytes; `useMouse` handles them separately.
- `Term` is constructed twice (`renderer.ts:23` then `:27`) — the constructor one is a TODO placeholder.

## Relevance (which advanced-TUI topics this teaches)
- **rendering-pipeline**: textbook example of decoupling React commits → cell buffer → diff → minimal byte stream, with fps throttling.
- **ansi-escapes**: SGR delta encoding, relative vs absolute cursor moves, alt-buffer, cursor show/hide, DSR cursor query.
- **layout**: percent/relative bounds propagation, clip-rectangle inheritance, inline-vs-block flow without flexbox.
- **reconciler-component-models**: minimal react-reconciler 0.32 host config, single-primitive design.
- **input-keyboard-mouse**: hand-rolled escape-sequence state machine, X10 mouse decode, multi-key chunk queueing.
- **unicode-text-width**: emoji/nerd-font 2-cell handling via absolute-column fallback (a pragmatic wcwidth workaround).
- **widgets-rich-content**: braille/block-element sub-cell canvas, scroll viewport, scrollbar, spinner/banner built from one primitive.
- **app-architecture**: singleton renderer, module-level resize fan-out, throttled animation hooks with interpolation/trail.
