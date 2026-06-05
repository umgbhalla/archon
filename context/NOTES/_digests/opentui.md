# opentui

## What it is (1-2 lines)
A TypeScript TUI framework with a native Zig core (compiled to a shared lib, called over C-ABI FFI) that handles all cell-buffer management, diffing, ANSI emission, Unicode/grapheme width, and the threaded write loop. TS owns the renderable tree, layout (Yoga), input parsing, and the React/Solid reconcilers; Zig owns the pixel-pushing.

## Architecture (how the pieces fit; key files with paths)
Monorepo (`packages/`): `core` (the engine), `react` + `solid` (reconcilers over core), plus `three`, `qrcode`, `keymap`, `web`, `examples`.

The split is the whole point: **TS = scene graph + scheduling + input; Zig = buffers + diff + output.** They share memory zero-copy.

- `packages/core/src/zig/` — native core (~9.6k LOC of the hot path):
  - `renderer.zig` (`CliRenderer`) — double-buffered cell store (`currentRenderBuffer`/`nextRenderBuffer`), the diff+ANSI emitter (`prepareRenderFrameWithWriter`, line 1315), hit grid, cursor/mouse-pointer state diffing, split-scrollback.
  - `buffer.zig` (`OptimizedBuffer`) — SoA cell buffer (separate `char/fg/bg/attributes` arrays), alpha blending, scissor + opacity stacks, box/text drawing.
  - `grapheme.zig` — slab-allocated `GraphemePool` with generation handles; grapheme clusters are interned and referenced *inside the u32 char cell*.
  - `utf8.zig` — wcwidth / grapheme width tables (`WidthMethod`).
  - `renderer-output.zig` — `OutputBackend` (stdout vs memory), `BufferedBackend` with an optional dedicated **write thread** (mutex + condvar), `WriteStatus` backpressure.
  - `terminal.zig`, `ansi.zig`, `native-span-feed.zig` (async span ingestion), `text-buffer*.zig`, `rope.zig`, `edit-buffer.zig`, `editor-view.zig`, `syntax-style.zig`, `audio.zig`, `lib.zig` (the C-ABI export surface).
- `packages/core/src/`:
  - `renderer.ts` (`CliRenderer`, ~4.9k LOC) — the frame loop (`loop()`, line 4295), scheduler (`requestRender`/`activateFrame`), input dispatch, mouse hit-testing, selection, scrollback.
  - `Renderable.ts` — `BaseRenderable`/`Renderable`/`RootRenderable`; the scene-graph node, Yoga node ownership, the render-command-list walk.
  - `buffer.ts` (`OptimizedBuffer`) — TS wrapper that maps **typed-array views directly over Zig-owned cell memory** (`toArrayBuffer(ptr,...)`).
  - `platform/ffi.ts` — backend abstraction over **Bun FFI** and **node:ffi** (same symbol table, two dlopen impls).
  - `zig.ts` — the binding layer: declares every native symbol's `args/returns`, wraps calls, owns the `TextEncoder`.
  - `lib/` — input parsing (`parse.keypress*.ts`, `parse.mouse.ts`, kitty protocol), `terminal-capability-detection.ts`, `KeyHandler.ts`, `yoga.options.ts`, tree-sitter syntax highlighting.
- `packages/react/src/reconciler/host-config.ts` — react-reconciler HostConfig mapping host elements → core Renderables.
- `packages/solid/src/reconciler.ts` — solid-js universal renderer doing the same.

## Core techniques

### Double-buffered cell diffing in native code (the render core)
`renderer.zig:1315 prepareRenderFrameWithWriter` is the heart. Two full cell buffers; TS draws into `nextRenderBuffer`, native diffs it against `currentRenderBuffer` cell-by-cell and emits only changed cells:
- Per cell, skip if `char && attributes && fg && bg` all equal (1349-1362). Equal runs break the current ANSI run and emit `reset`.
- **Lazy frame start** (1321-1324): `frame_started` stays false until the first real change. A truly no-op frame emits *zero bytes* — not even cursor sync. This is the key idle-suppression mechanism.
- ANSI run-coalescing: only re-emit cursor move + SGR color/attr when `fg/bg/attrs` differ from the running state (`sameAttributes`, 1372-1374). Consecutive same-style cells just stream glyphs.
- After emitting a cell it calls `syncCell(x,y,nextCell)` (1452) to update the *current* buffer in place, so next frame's diff is correct — deliberately `syncCell` not full set to avoid clobbering continuation cells written earlier in the same left-to-right pass (bug #723).
- Frame is wrapped in synchronized-update markers (`beginRenderFrame`/`syncReset`) only if anything was emitted (1567).

### Cursor / mouse-pointer state are also diffed
`needsCursorRestore` (1516) only emits cursor sequences when position/style/color/visibility actually changed *or* the frame already produced output. Same pattern for mouse pointer style (1556) and hyperlinks (OSC 8, 1378). Everything is "emit only on change."

### SoA cell buffer + zero-copy FFI
`OptimizedBuffer` (buffer.zig:159) stores `char: []u32, fg: []RGBA, bg: []RGBA, attributes: []u32` as separate arrays (struct-of-arrays for cache/SIMD friendliness; `RGBA` is a `@Vector`). TS side (`buffer.ts:86`) builds `Uint32Array`/`Uint16Array` *views over the same native pointers* via `toArrayBuffer(charPtr, 0, size*4)` — no copy crossing FFI, TS writes cells directly into Zig memory.

### Graphemes packed into the char cell (clever bit-packing)
`grapheme.zig` top comment: the u32 char cell is tagged in bits 31-30:
- `00…` = direct Unicode scalar (30-bit codepoint).
- `10…` = grapheme **start** cell carrying a 26-bit pool ID `[class(3) | generation(7) | slot(16)]`.
- `11…` = **continuation** cell for the trailing columns of wide/emoji glyphs.
- bits 29-26 carry left/right extent (cell width) so the renderer knows how many columns to skip.
Multi-byte grapheme clusters live in a slab-allocated `GraphemePool` (size classes 8/16/32/64/128 bytes), refcounted with generation tags to catch use-after-free, and *interned* by bytes so repeats share an ID. The cell stays a flat u32; the heavy bytes are out-of-line.

### Hit grid for O(1) mouse hit-testing
`renderer.zig` keeps a `currentHitGrid`/`nextHitGrid` (`[]u32` of renderable IDs, one per cell). During render, each renderable writes its `num` into the grid clipped to scissor rects (`addToCurrentHitGridClipped`, 1751). Mouse hit-test is then `checkHit(x,y)` = single array index (1662) → renderable number. Hit grids are swapped each frame and `hitGridDirty` is computed via `std.mem.eql` so TS knows whether to recheck hover (`renderer.ts:4360`).

### Three-pass TS render with a render-command list
`RootRenderable.render` (`Renderable.ts:1740`) is explicitly 3-pass: (1) Yoga `calculateLayout` from root if dirty; (2) `updateLayout` walks the tree producing a flat `renderList` of commands (`render` / `pushScissorRect` / `popScissorRect` / `pushOpacity` / `popOpacity`); (3) execute that list against the buffer. Scissor/opacity are emitted as paired push/pop commands so nesting maps to the native scissor/opacity stacks. Comments note this *should* be 2-pass but Yoga isn't native yet, so layout is recomputed per frame (acknowledged perf debt, 1374-1380).

### Frame scheduler with idle detection
`renderer.ts loop()` (4295): bumps `_frameId`, runs animation requests + `frameCallbacks`, `root.render()` into nextBuffer, post-process fns, console overlay, then `renderNative()` → `lib.render`. Two modes:
- **Running** (`_isRunning`): self-reschedules at `targetFrameTime` (default 30fps).
- **On-demand**: `requestRender()` schedules a single frame via `process.nextTick`/`setTimeout` throttled to `minTargetFrameTime`; coalesces if already scheduled; sets `immediateRerenderRequested` if a render is in-flight.
`idle()` returns a promise that resolves when nothing is scheduled (`isIdleNow`) — used heavily by tests. A `_liveCount` propagated up the tree (`propagateLiveCount`) tracks whether any node needs continuous animation, switching between running and on-demand.

### Threaded output + backpressure
`renderer-output.zig BufferedBackend` can run a dedicated render/write thread (`renderThreadFn`, mutex+condvar). `render()` returns `WriteStatus`; if the writer can't keep up, native returns SKIPPED/FAILED and TS calls `scheduleRenderAfterFeedIdle()` to retry after the feed drains (`renderer.ts:4462`). `NativeSpanFeed` is an async channel for streaming styled spans without blocking the JS thread.

### Reconcilers map host nodes 1:1 to Renderables
React `host-config.ts`: `createInstance` looks up the type in a component catalogue and does `new components[type](container.ctx, {id, ...props})` — host instances *are* core Renderables. `appendChild`→`parent.add(child)`, `insertBefore`→`parent.insertBefore`, `commitUpdate`→`updateProperties`. `resetAfterCommit`→`container.requestRender()`. Property setters in core already call `requestRender()` internally, so the reconciler stays thin. Solid uses solid-js's universal renderer (`createRenderer`) with the same node model and a text-node subtree for inline styled text.

### Capability detection
`lib/terminal-capability-detection.ts` queries DA1 (`ESC[?...c`), kitty keyboard (`ESC[?Nu`), OSC 99 notifications, etc., on startup and parses responses from stdin to set caps like `hyperlinks`, `explicit_width`, truecolor. The native emitter branches on these (e.g. `explicit_width` uses the explicit-width ANSI sequence for graphemes vs. manual cursor repositioning, renderer.zig:1424).

## Code patterns worth stealing

Zero-copy typed-array view over native memory:
```ts
// buffer.ts — TS writes straight into Zig-owned cell arrays
const buffers = {
  char: new Uint32Array(toArrayBuffer(charPtr, 0, size * 4)),
  fg:   new Uint16Array(toArrayBuffer(fgPtr, 0, size * 4 * 2)),
  bg:   new Uint16Array(toArrayBuffer(bgPtr, 0, size * 4 * 2)),
  attributes: new Uint32Array(toArrayBuffer(attributesPtr, 0, size * 4)),
}
```

Lazy-frame no-op suppression (emit nothing if nothing changed):
```zig
var frame_started = sync_started;          // stays false until first real change
// ... per cell: if equal to current buffer -> continue (no output)
if (!frame_started) { beginRenderFrame(writer); frame_started = true; }
// ... at end: only close the synchronized-update wrapper if we opened it
if (frame_started) writer.writeAll(ansi.ANSI.syncReset) catch {};
```

ANSI run coalescing — only re-emit move+SGR when style breaks:
```zig
const sameAttributes = fgMatch and bgMatch and cell.attributes == currentAttributes;
if (!sameAttributes or runStart == -1) {
  if (runLength > 0) writer.writeAll(ANSI.reset);
  moveToOutput(writer, x+1, y+1+renderOffset);
  emitColor(writer, cell.fg, false); emitColor(writer, cell.bg, true);
  applyAttributes(writer, cell.attributes);
}
// else: just stream the glyph, no escape codes
```

Grapheme tagged into the cell (out-of-line bytes, flat u32 cell):
```
u32 cell: [ 00 + 30-bit codepoint ]                       // ASCII/BMP fast path
          [ 10 + ext(4) + 26-bit poolID ]  start cell     // poolID = class|gen|slot
          [ 11 + ext(4) + ... ]            continuation    // trailing wide columns
```

FFI backend abstraction (one symbol table, Bun or node:ffi):
```ts
// platform/ffi.ts exposes a uniform dlopen<Fns>(path, symbols) over both runtimes;
// zig.ts declares { args, returns } per symbol once and never branches on runtime.
```

Render as a flat command list (maps nesting → native stacks):
```ts
renderList.push({ action: "pushOpacity", opacity })
renderList.push({ action: "render", renderable: this })
renderList.push({ action: "pushScissorRect", x, y, width, height, screenX, screenY })
// ...children...
renderList.push({ action: "popScissorRect" })
renderList.push({ action: "popOpacity" })
```

## Gotchas / non-obvious decisions
- **Layout recomputed every frame.** Yoga lives in TS, so the tree walk + `updateFromLayout` runs per frame; comments flag this as the main perf debt and the reason it can't be a 2-pass renderer (would need native Yoga to hook the calculateLayout phase). `_lastLayoutFrame` guards against double-computing within a frame.
- **Cached absolute coords (`_screenX/_screenY`).** Hot render path must not walk the parent chain for position; coords are cached during layout and re-sampled *after* `renderBefore/renderAfter` hooks (which may move the node mid-frame).
- **`syncCell` vs full set after emit** — must not run span cleanup, or it destroys continuation cells written earlier in the same row pass (emoji bug #723).
- **Continuation cells write no space** — writing a space to the trailing column of a 2-cell emoji broke glyph output when the two cells had different colors, so it's intentionally disabled (renderer.zig:1436).
- **Generation handles in the grapheme pool** catch stale grapheme IDs (use-after-free) — IDs are `class|generation|slot`, and a generation mismatch is an error, not a crash.
- **Idle/scheduler is subtle**: `requestRender` is a no-op while `_isRunning` (the loop already self-schedules); during an in-flight render it only latches `immediateRerenderRequested`. Getting these guards wrong causes either dropped frames or infinite render loops (the code calls this out explicitly at 1443-1448).
- **Hit-grid swap + dirty check** avoids manual hover bookkeeping in TS — native tells you if the grid changed via `memcmp`.
- **Two FFI runtimes**: code targets Bun primarily but ships a node:ffi backend; pointer handling differs (Bun bigint pointers vs node ArrayBuffer-backed), normalized in `platform/ffi.ts`.

## Relevance (which advanced-TUI topics this teaches)
- **rendering-pipeline** — gold-standard double-buffer cell diffing, ANSI run coalescing, no-op frame suppression, synchronized-update wrapping, threaded output with backpressure.
- **ansi-escapes** — change-only emission of SGR/cursor/pointer/OSC-8 hyperlinks; capability-gated sequences.
- **unicode-text-width** — wcwidth/grapheme width, slab grapheme pool with generation handles, width info bit-packed into cells.
- **reconciler-component-models** — react-reconciler HostConfig and solid universal renderer both mapping host nodes directly to engine Renderables; thin reconcilers because setters self-request render.
- **layout** — Yoga (flexbox) ownership in TS, per-frame layout walk, scissor/opacity stacks, render-command list.
- **input-keyboard-mouse** — kitty keyboard protocol parsing, SGR mouse parsing, O(1) hit grid, event bubbling up the parent chain, autofocus on click.
- **app-architecture** — the native-core/JS-shell split with zero-copy shared memory and a uniform C-ABI is the central lesson: keep the per-cell hot loop in a fast language, keep the scene graph and ergonomics in JS.
- **widgets-rich-content** — `renderables/` has Text/Box/Input/Select/ScrollBox/Markdown/Code/TextTable/Textarea built on the same buffer primitives (tree-sitter syntax highlighting, edit-buffer ropes).
