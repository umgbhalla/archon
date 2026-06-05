# rendering-pipeline

How a frame goes from "your component tree changed" to "the terminal shows new pixels" — the cell buffer, the double buffer, the diff, the minimal ANSI byte stream, and the loop that drives it. Sources studied: opentui (Zig core), glyph, react-curse, melker, log-update, opentui-doom, termdraw, xterm.

## TL;DR (the mental model in 3-5 bullets)

- A TUI frame is a **2D grid of cells**. A cell is `{char, fg, bg, attributes}` (bold/underline/etc). You never write to the terminal directly; you paint into an in-memory cell buffer.
- **Double buffer + diff is the whole game.** Keep two cell buffers (`current` = what's on screen, `next` = what you just painted). Compare them cell-by-cell; emit ANSI only for cells that differ. This turns an O(w·h) repaint into "bytes proportional to what actually changed" — the single most important optimization for over-SSH latency and flicker.
- **Minimizing bytes has two more levers beyond skipping unchanged cells:** (1) only move the cursor when it isn't already where you want it (run-coalescing adjacent cells), and (2) only re-emit an SGR style sequence when the style breaks from the running style. A row of 80 same-colored chars = one cursor move + one SGR + 80 glyph bytes.
- **Wrap each frame in DEC mode 2026 (synchronized output)** so the terminal presents it atomically — no tearing/flicker mid-frame. Cheap, universally ignored by terminals that don't support it.
- **The loop runs on demand, not on a fixed clock** (mostly). React/Solid commit → coalesce via microtask/timer → paint → diff → flush. Animations/games opt into a fixed-FPS callback loop. A truly no-op frame should emit **zero bytes**.
- **Half/quarter/sextant block glyphs** turn one cell into 2/4/6 sub-pixels by abusing fg/bg colors, giving "graphics" at 2–6× the cell resolution.

## How it actually works (the mechanism, step by step)

### 1. The cell buffer (framebuffer) model

Two storage strategies in the wild:

**Array-of-objects (most TS engines).** glyph's `Framebuffer` is a flat `Cell[]` of length `width*height` (`context/glyph/packages/glyph/src/paint/framebuffer.ts:15`). The critical discipline is **zero per-frame allocation**: `allocCells` is the *only* place `Cell` objects are created (`framebuffer.ts:27`); `clear`, `set`, `copyFrom` all mutate cells in place. melker does the same — `setCell` writes field-by-field into the existing `Cell` rather than replacing it (`context/melker/src/buffer.ts:295-339`), explicitly "to avoid object allocation". This matters because the buffer is rewritten every frame; allocating a fresh cell per write would thrash GC at 30–60fps.

**Struct-of-arrays / typed arrays (fast cores).** opentui's `OptimizedBuffer` stores `char: []u32, fg: []RGBA, bg: []RGBA, attributes: []u32` as *separate* arrays (cache/SIMD friendly). The TS side maps `Uint32Array`/`Uint16Array` views **directly over the Zig-owned memory** via `toArrayBuffer(ptr,...)` — zero copy across the FFI boundary. xterm.js goes furthest: 3×`uint32` per cell packed in one `Uint32Array` (`context/xterm/src/common/buffer/BufferLine.ts:13`): `content = width(2)|combinedFlag|codepoint(21)`, plus packed fg/bg words; combined glyphs and extended attrs live in sparse side-maps read only when a flag bit is set. Cells are read into a *reused* `CellData` scratch object to avoid GC. This is the model to copy if you need a true emulator-grade grid.

react-curse is the minimalist end: a cell is just a tuple `Char = [string, Modifier]` and the buffer is `Char[][]`, fully reallocated every frame (`context/react-curse/screen.ts`). It works because terminal grids are small and the *diff*, not buffer reuse, is what saves I/O.

### 2. Double buffering and the swap

You hold two buffers. You paint the new frame into `next`/`current` while `prev` still holds what's on screen. After diffing, you make them swap roles.

glyph's loop (`context/glyph/packages/glyph/src/render.ts:530` `performRender`):
```ts
const output = diffFramebuffers(prevFb, currentFb, fullRedraw, cursor);  // :605
terminal.write(output);
prevFb.copyFrom(currentFb);   // :626  zero-alloc swap: prev now mirrors what's on screen
```
`copyFrom` (`framebuffer.ts:120`) mutates `prevFb`'s existing cells from `currentFb` — no allocation.

melker uses an explicit `DualBuffer` with `_currentBuffer` + `_previousBuffer`; each frame renders into current, `swapAndGetDiff()` (`context/melker/src/buffer.ts:750`) returns the changed cells, *then* swaps and clears. A subtle correctness rule: the returned diff references **live cells, not copies** (`buffer.ts:792`) — this is only safe because the buffer holding those cells becomes `_previousBuffer` and isn't mutated until the next frame. Get the swap-then-clear ordering wrong and you read freed cells.

opentui keeps `currentRenderBuffer` / `nextRenderBuffer` in Zig. TS draws into `next`; the native diff emits and then `syncCell`s each emitted cell into `current` so next frame's diff is correct (`context/opentui/packages/core/src/zig/renderer.zig:1452`). At end of frame it `clear`s the next buffer (`:1579`).

### 3. The char-level diff — the heart

The canonical loop: walk every cell; if it equals the previous-frame cell, skip; otherwise emit. glyph's `diffFramebuffers` (`context/glyph/packages/glyph/src/paint/diff.ts:139-174`) is the cleanest reference:

```ts
for (let y = 0; y < next.height; y++) {
  for (let x = 0; x < next.width; x++) {
    const nc = next.get(x, y)!;
    if (nc.ch === "") continue;                       // wide-char continuation: skip (:146)
    if (!fullRedraw) {
      const pc = prev.get(x, y);
      if (pc && next.cellsEqual(nc, pc)) continue;     // UNCHANGED -> emit nothing (:151)
    }
    if (cursorY !== y || cursorX !== x) writeCursorMove(x, y);  // move only if needed (:156)
    const sgr = buildSGR(nc);
    if (sgr !== lastSGR) { writeAscii(sgr); lastSGR = sgr; }    // restyle only on change (:162)
    writeStr(nc.ch);
    cursorX = x + ttyCharWidth(nc.ch);                 // wide-char-aware cursor advance (:171)
    cursorY = y;
  }
}
```

Three independent minimizations are visible here and recur in *every* engine:
1. **Skip unchanged cells** (`cellsEqual`, compares ch + colors + all SGR flags, `framebuffer.ts:145`).
2. **Skip redundant cursor moves** by tracking the terminal's *actual* cursor column — crucially advancing it by the glyph's display width so wide chars don't desync (`diff.ts:171`).
3. **Skip redundant SGR** by tracking `lastSGR` and only re-emitting on a style break.

opentui's native version (`renderer.zig:1315 prepareRenderFrameWithWriter`) does the same but with run-coalescing made explicit: it tracks `currentFg/currentBg/currentAttributes` and only re-emits cursor-move + color + attributes when `sameAttributes` is false or a run just started (`:1394`); consecutive same-style cells just stream glyph bytes (`:1446`). When it hits an unchanged cell mid-run it closes the run with a `reset` (`:1356`).

melker's emitter (`context/melker/src/renderer.ts`) sorts diffs by (y,x), emits one cursor move per contiguous run, and carries `lastStyle` across cells emitting only deltas; OSC-8 hyperlinks are tracked *independently* of SGR because an SGR reset does not close a hyperlink.

react-curse is instructive for the cursor-move minimization specifically (`context/react-curse/term.ts:247-269`): it picks the *cheapest* escape — `\n` for "column 0, next row", `CSI nB`/`nA` for pure vertical, `CSI nC`/`nD` for pure horizontal, and only falls back to absolute `CSI y;xH` when both differ. It also delta-encodes SGR (`createModifierSequence`, only pushes the params that changed vs `prevModifier`).

### 4. Dirty tracking: don't even scan unchanged regions

The diff above still scans all w·h cells to *find* the changed ones. Two ways to cut that:

**Dirty-row tracking driven by the write path (melker).** When dirty tracking is on, every `setCell` compares the written cell against the previous frame's cell and, if different, adds `y` to a `Set<number>` (`context/melker/src/buffer.ts:343-349`). `_computeDirtyDiff()` (`buffer.ts:793`) then iterates *only* dirty rows instead of the full grid. `markForceNextRender()` (`buffer.ts:745`) forces a full diff (used on dialog open / resize). This makes the diff cost proportional to touched rows, not screen size.

**Dirty-flag cached rasterization (termdraw).** A retained object model rebuilds the intermediate "scene" grids only when `sceneDirty` is set by a mutator (`context/termdraw/packages/opentui/src/draw-state.ts:1792 ensureScene`). Transient overlays (cursor, selection, drag preview) are layered on top at composite time and deliberately do *not* dirty the scene cache — so dragging a preview rectangle re-composites cheaply without re-rasterizing the whole drawing.

**Render-model diffing (xterm WebGL).** The GPU renderer writes a flat `Int32Array` model (`code,bg,fg,ext` per cell) and skips cells whose packed slot already matches (`context/xterm/addons/addon-webgl/src/WebglRenderer.ts:560`); only changed cells call `glyphRenderer.updateCell`. Same diff idea, just against a GPU upload model instead of an ANSI stream.

### 5. Line-level diff (log-update) — the no-reconciler case

For progress bars/spinners with no cell grid, log-update diffs *lines*, not cells (`context/log-update/index.js:66 diffFrames`): common-prefix + common-suffix scan yields the minimal changed contiguous block `[start, endPrevious] -> [start, endNext]`. `buildPatch` (`:87`) then moves the cursor to the first changed line, erases the old block, writes the new block (with `eraseEndLine` to wipe stale trailing chars when the new line is shorter), and reparks the cursor on a trailing blank line. The trailing-newline invariant (`:189`) is load-bearing: all cursor math assumes the cursor rests one line below the content. Diffing is abandoned (full erase+rewrite) whenever width changes or the frame is height-clipped, because reflow invalidates the line-to-line correspondence.

### 6. Synchronized output — atomic frames

Every serious engine wraps the frame in DEC private mode 2026:
```
CSI ?2026h   ... entire frame's bytes ...   CSI ?2026l
```
glyph (`diff.ts:88,203`), melker (`renderer.ts` `ANSI.beginSync/endSync`), log-update (`index.js:10-11`), opentui (`beginRenderFrame`/`syncReset` in `renderer.zig`). The terminal buffers all output and paints it in one shot, eliminating mid-frame tearing/flicker. Terminals that don't support it ignore the sequences harmlessly. glyph adds two extra disciplines worth stealing: it **unconditionally hides the cursor** (`?25l`) at frame start as cheap insurance against state desync from image protocols (`diff.ts:95`), and **disables auto-wrap** (`?7l`) every frame because writing the last column with auto-wrap on puts Kitty/Ghostty into a "pending wrap" state that corrupts cursor positioning under sync output (`diff.ts:103-113`).

### 7. No-op frame suppression

opentui's sharpest trick: `frame_started` stays `false` until the *first* real change (`renderer.zig:1324`). A frame where nothing changed — including cursor and mouse-pointer state — emits **zero bytes**, not even the sync wrapper (`:1567` only closes sync if it was opened). Cursor sequences are themselves diffed: `needsCursorRestore` is true only if the frame already produced output OR the cursor position/style/color/visibility actually changed (`:1516`). This is what lets an idle TUI cost nothing.

### 8. The render loop — when it runs

**Demand-driven (the default).** React's reconciler commits → `resetAfterCommit`/`onCommit` → `scheduleRender`, which coalesces a burst of state updates into one paint:
- glyph: `queueMicrotask`, guarded by a `renderScheduled` flag (`render.ts:521-528`).
- react-curse: `setTimeout` capped to ~60fps, clearing any pending timeout (`context/react-curse/renderer.ts:97-107`). Render order per frame: rasterize tree → diff+flush → drain one queued input key.
- opentui (on-demand mode): `requestRender()` schedules a single frame via `process.nextTick`/`setTimeout` throttled to `minTargetFrameTime`, coalescing if already scheduled.

**Fixed-FPS callback loop (animations/games).** opentui's `loop()` (`context/opentui/packages/core/src/renderer.ts:4295`) self-reschedules at `targetFrameTime` when `_isRunning`; a `_liveCount` propagated up the tree decides whether *any* node needs continuous animation, switching between the running loop and on-demand. opentui-doom drives DOOM at `targetFps: 35` via `renderer.setFrameCallback`, rewriting all framebuffer cells each tick and letting opentui own the diff (`context/opentui-doom/src/index.ts`).

**Three-tier paths (melker).** melker picks per-event: **full render** (layout + buffer + diff), **cached-layout render** (`renderCachedLayout()`, reuses cached layout positions, repaints buffer — safe only when just pixel data changed, e.g. a spinner tick or video frame), and **fast input render** (Input/Textarea keystrokes: update state, diff via `DiffCollector` using cached bounds, flush immediately ~2ms, then schedule a full render on a 16ms debounce). Cached-layout is opt-in and unsafe by default; anything ambiguous promotes to full render.

### 9. Sub-cell pixel tricks (half-block / quadrant / sextant / braille)

A terminal cell is ~2:1 tall and has exactly one fg + one bg color. You exploit that to pack multiple pixels per cell:

- **Half-block (`▀`, 2× vertical):** fg color = top pixel, bg color = bottom pixel. opentui-doom (`context/opentui-doom/src/index.ts:264-293`) blits DOOM's RGBA framebuffer this way: `setCell(x, y, "▀", RGBA(topPixel), RGBA(bottomPixel))`, sampling two source rows per cell row (`srcY1 = floor(y*2*scaleY)`, `srcY2 = floor((y*2+1)*scaleY)`). Effective resolution = `width × height*2`.
- **Quadrant (2×2) and Sextant (2×3):** melker's canvas (`context/melker/src/components/canvas-render-sextant.ts`) encodes a 2×3 pixel block per cell using Unicode sextant glyphs (U+1FB00 range) via a flat 64-entry `PIXEL_TO_CHAR` lookup. Because a cell has only one fg + one bg, it must **quantize 6 colors into 2 groups** by median brightness (integer luma `(r*77+g*150+b*29)>>8`), average each group → fg/bg, set the sextant bit for the brighter group (`canvas-render-sextant.ts:19`). The per-cell loop is hand-unrolled and the quantizer is deliberately copy-pasted between sextant/quadrant paths to preserve V8 inlining on the hottest path.
- **Braille (2×4, 8 dots/cell):** for smooth diagonal lines. termdraw (`context/termdraw/packages/opentui/src/draw-state/line.ts:141`) and react-curse's `Canvas` both map a cell to a 2×4 dot grid, light a dot if its distance to the ideal segment is under threshold, and emit `String.fromCodePoint(0x2800 + mask)`. ~4× vertical resolution, monochrome.

Gotcha shared across all of these: skip the last column when the canvas hits the exact terminal right edge to dodge autowrap glitches (melker).

## Cross-repo comparison

| Repo | Cell storage | Diff granularity | Output min. | Loop | Distinctive |
|---|---|---|---|---|---|
| **opentui** | SoA typed arrays in Zig, zero-copy FFI views | per-cell, native | run-coalesce + no-op suppression + diffed cursor/pointer | fixed-FPS or on-demand, `_liveCount` driven | native core; emits *zero bytes* on idle; threaded writer w/ backpressure |
| **glyph** | flat `Cell[]`, zero per-frame alloc | per-cell, `fullRedraw` flag | cursor-skip + SGR-skip; `?7l` autowrap discipline | `queueMicrotask` coalesced | text-raster cache; native cursor via OSC 12; cleanest diff to read |
| **react-curse** | `Char[][]`, realloc每frame | per-cell, per-row chunking | cheapest relative cursor move; SGR delta | `setTimeout` 60fps cap | minimal; inline mode via DSR cursor query; emoji→absolute-col fallback |
| **melker** | `Cell[][]` in-place mutate, `DualBuffer` | **dirty-row** + `DiffCollector` | run-batch + SGR delta + OSC-8 separate | three render paths (full/cached/fast) | dirty-row tracking from the write path; sextant canvas |
| **log-update** | none (string of lines) | **line-level** prefix/suffix | minimal changed block patch | per-`render()` call | no grid; the smallest correct double-buffer mental model |
| **termdraw** | retained objects → cached scene grids | dirty-flag cached rasterization | (delegates ANSI to opentui) | `requestRender()` | overlays layered above cached scene; box-join bitmask |
| **xterm** | bit-packed `Uint32Array`, sparse side-maps | render-model diff (DOM/WebGL) | GPU glyph atlas + instanced quads | back-pressured `WriteBuffer`, ≤12ms slices | emulator-grade; three renderer strategies; resumable parser |

**Where they agree:** double buffer + per-cell (or per-line) diff; emit cursor moves and SGR only on change; wrap frames in DEC 2026; treat wide-char continuation cells as skip-in-diff; never allocate cells in the hot path.

**Where they differ / tradeoffs:**
- **Native vs JS core.** opentui pays an FFI complexity tax for a per-cell loop that never touches the GC; everyone else keeps it in JS and leans on in-place mutation + dirty tracking. For most apps the JS approach is plenty; opentui's design pays off for full-screen 30fps+ content (games, video).
- **Scan-everything vs dirty-row.** glyph/react-curse scan all cells each frame to find changes (simple, correct, fine for normal UIs). melker's write-path dirty-row tracking wins big for huge buffers with localized changes (a single input field on an 80×50 screen), at the cost of bookkeeping that must be invalidated correctly on resize/dialog.
- **Buffer reuse vs realloc.** react-curse reallocs the whole buffer every frame and still performs well — proof that the *diff* is what saves I/O, not buffer reuse. But realloc adds GC pressure; for high FPS, in-place mutation (glyph/melker) or typed arrays (xterm/opentui) is the right call.
- **Equality check cost.** react-curse uses `JSON.stringify` for modifier equality (`term.ts:203`) — simple but allocates and is key-order sensitive. opentui/xterm compare packed integers/typed fields directly. The stringify approach is a real per-cell allocation you'll want to kill at scale.

## Pitfalls & hard parts

- **Wide chars desync the cursor.** A CJK/emoji glyph occupies 2 columns but you store it in 1 cell + a continuation cell. The diff must (a) skip continuation cells (`nc.ch === ""` in glyph, `isContinuationChar` in opentui, `_wideCharMap` in melker) and (b) advance the tracked cursor by the *display width*, not 1 (`cursorX = x + ttyCharWidth(nc.ch)`). Overwriting half a wide char must clear both halves (`_clearWideCharAt`, `context/melker/src/buffer.ts:353`). opentui intentionally writes *no space* for continuation cells because a space overwrite broke 2-color emoji (`renderer.zig:1437`, bug #723).
- **Syncing the current buffer after emit.** opentui uses `syncCell` (set without span cleanup) not a full set, because span cleanup would destroy continuation cells written earlier in the same left-to-right pass (`renderer.zig:1452`).
- **Pending-wrap corruption.** Writing the last column with auto-wrap enabled, under DEC 2026, corrupts cursor positioning on Kitty/Ghostty. Disable `?7l` per frame, re-enable `?7h` at the end (glyph `diff.ts:103-113`).
- **OSC-8 hyperlinks survive SGR reset.** They must be tracked and closed independently of SGR (melker `renderer.ts:383-390`, opentui `renderer.zig:1378`).
- **Full redraw vs incremental.** On resize/init you must full-clear with `CSI 2J` (not per-line `2K`) because shrinking terminals reflow/wrap stale alt-screen content that per-line erase misses (glyph `diff.ts:115-131`). Diffing across a reflow is invalid — force a full repaint.
- **Diff references live cells.** If your diff returns cell references (melker, for speed), the buffer holding them must not be mutated until next frame — depends entirely on swap-then-clear ordering (`buffer.ts:792`).
- **Layout recomputed every frame.** opentui's Yoga layout lives in TS, so the tree walk + `updateFromLayout` runs per frame — acknowledged perf debt and the reason it can't be a clean 2-pass renderer (`Renderable.ts` comments). glyph mitigates with a persistent Yoga tree + `isLayoutDirty()` early-out and edge-based rounding (`pointScaleFactor=0`) for gapless siblings.
- **Coalescing correctness.** Render scheduling must be idempotent: a `renderScheduled`/`_frameRequested` flag must short-circuit duplicate schedules, and an in-flight render that gets a new request must latch a re-render rather than dropping it (opentui's `immediateRerenderRequested`). Get this wrong → dropped frames or infinite render loops.
- **Backpressure.** If the writer can't keep up (slow SSH), you can flood. opentui returns a `WriteStatus` (SKIPPED/FAILED) from a threaded writer and reschedules after the feed drains. xterm time-slices its write queue to a 12ms budget and re-schedules.

## If you were building this from scratch (recommended approach + pseudocode)

Start JS-only with array-of-objects cells and in-place mutation. Add dirty tracking and a native core only if profiling demands it.

```ts
type Cell = { ch: string; fg: number; bg: number; attrs: number };
class Framebuffer {
  cells: Cell[];                       // flat width*height, allocated ONCE
  set(x, y, ch, fg, bg, attrs) { /* mutate existing cell in place */ }
  clear(bg) { /* reset all cells in place */ }
  copyFrom(src) { /* field-copy every cell, no alloc */ }
}

let prev = new Framebuffer(w, h);      // what's on screen
let next = new Framebuffer(w, h);      // scratch
let scheduled = false, fullRedraw = true;

function scheduleRender() {            // demand-driven; coalesce a burst into one paint
  if (scheduled) return;
  scheduled = true;
  queueMicrotask(() => { scheduled = false; render(); });
}

function render() {
  next.clear(defaultBg);
  paintTree(rootNode, next);           // layout (cached/dirty-gated) -> rasterize into `next`
  const out = diff(prev, next, fullRedraw);
  if (out) stdout.write(out);          // single atomic write
  prev.copyFrom(next);                 // swap roles, zero-alloc
  fullRedraw = false;
}

function diff(prev, next, full): string {
  let s = "\x1b[?2026h\x1b[?25l\x1b[?7l";   // sync on, hide cursor, autowrap off
  if (full) s += "\x1b[r\x1b[2J\x1b[H";
  let curX = -1, curY = -1, lastSGR = "";
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const n = next.get(x, y);
    if (n.ch === "") continue;                       // wide-char continuation
    if (!full && cellsEqual(n, prev.get(x, y))) continue;   // unchanged -> nothing
    if (curY !== y || curX !== x) { s += `\x1b[${y+1};${x+1}H`; }   // move only if needed
    const sgr = buildSGR(n);
    if (sgr !== lastSGR) { s += sgr; lastSGR = sgr; }              // restyle only on break
    s += n.ch;
    curX = x + charWidth(n.ch); curY = y;            // wide-char-aware advance
  }
  s += "\x1b[0m\x1b[?7h\x1b[?2026l";                 // reset, autowrap on, sync off
  return s === "...preamble only..." ? "" : s;        // emit nothing for no-op frames
}
```

Then, in priority order:
1. **Synchronized output + cursor-skip + SGR-skip** (above) — biggest win for free.
2. **No-op suppression** — track whether anything was actually emitted; return `""` if not.
3. **Dirty tracking** — mark dirty rows from the write path (melker's pattern) once full-scan shows up in profiles.
4. **Sub-cell graphics** — half-block first (trivial), braille/sextant if you need it.
5. **A fixed-FPS callback loop** layered beside demand-rendering, gated by a live/animating flag.
6. **Native core / typed arrays** only if you're pushing full-screen high-FPS content.

## Source map

- **Diff + ANSI emission (read these first):**
  - `context/glyph/packages/glyph/src/paint/diff.ts` — cleanest full char-diff (`diffFramebuffers` :76-215).
  - `context/opentui/packages/core/src/zig/renderer.zig:1315` — `prepareRenderFrameWithWriter`, run-coalescing + no-op suppression + diffed cursor (1315-1592).
  - `context/melker/src/renderer.ts` — run-batched SGR-delta emitter, OSC-8 handling.
  - `context/react-curse/term.ts:178-303` — cheapest-relative-cursor-move + SGR delta + inline mode.
- **Buffers / double buffering:**
  - `context/glyph/packages/glyph/src/paint/framebuffer.ts` (`Framebuffer`, `allocCells` :27, `copyFrom` :120, `cellsEqual` :145).
  - `context/melker/src/buffer.ts` (`DualBuffer`, `swapAndGetDiff` :750, `_computeDirtyDiff` :793, in-place `setCell` :295-349, `DiffCollector` :41).
  - `context/opentui/packages/core/src/zig/buffer.zig` (`OptimizedBuffer`, SoA) + `context/opentui/packages/core/src/buffer.ts` (zero-copy views).
  - `context/xterm/src/common/buffer/BufferLine.ts:13` — bit-packed typed-array cells, the emulator-grade model.
- **Loop / scheduling:**
  - `context/glyph/packages/glyph/src/render.ts:521-630` (`scheduleRender`, `performRender`).
  - `context/react-curse/renderer.ts:97-107` (throttled commit coalescing).
  - `context/opentui/packages/core/src/renderer.ts:4295` (`loop()`, on-demand vs running).
  - `context/melker/agent_docs/architecture.md` + `fast-input-render.md` + `dirty-row-tracking.md` (three render paths).
- **Sub-cell graphics:**
  - `context/opentui-doom/src/index.ts:264-293` (half-block blit).
  - `context/melker/src/components/canvas-render-sextant.ts` (sextant + 6→2 color quantize).
  - `context/termdraw/packages/opentui/src/draw-state/line.ts:141` (braille lines).
- **Line-level diff (no grid):** `context/log-update/index.js:66 diffFrames`, `:87 buildPatch`.
- **GPU render-model diff:** `context/xterm/addons/addon-webgl/src/WebglRenderer.ts:419-560`, `TextureAtlas.ts`.
