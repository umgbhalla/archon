# opentui-deep

A teach-yourself note on **OpenTUI** — the SST terminal-UI framework with a native Zig render core, a TypeScript scene-graph model, and React/Solid bindings. Citations point into `context/opentui/` (the core monorepo) and the apps built on it: `context/opentui-spinner/`, `context/opentui-ui/`, `context/ghui/`, `context/critique/`, `context/hunk/`, `context/termdraw/`, `context/opentui-doom/`.

## TL;DR (the mental model in 3-5 bullets)

- **The split is the entire architecture: TS owns the scene graph + scheduling + input; Zig owns the pixel pushing.** TS draws cells into a buffer, Zig diffs that buffer against the previous frame and emits only the changed cells as ANSI. They share the cell memory zero-copy over a C-ABI FFI (`buffer.ts:86`, `renderer.zig:1315`).
- **A `Renderable` is the unit of everything.** It owns a Yoga (flexbox) layout node, a position in a tree, and exactly two hooks you override: `renderSelf(buffer, deltaTime)` to draw, and lifecycle setters that call `this.requestRender()` to mark dirty. There is **no manual frame loop** in app code — you mutate state and request a render; core batches and repaints.
- **Render is a 3-pass walk per frame** (`Renderable.ts:1740`): (1) Yoga `calculateLayout` if dirty, (2) `updateLayout` walks the tree into a flat `RenderCommand[]` (render / pushScissor / pushOpacity / pop…), (3) execute that list against the buffer. Layout is recomputed in TS every frame because Yoga isn't native yet — the acknowledged main perf debt (`Renderable.ts:1374-1380`).
- **Two scheduling modes**: *running* (self-reschedules at `targetFrameTime`, default 30fps) for animation, and *on-demand* (`requestRender()` → one coalesced frame) for idle UIs. A `_liveCount` propagated up the tree (`Renderable.ts:486`) decides which mode you're in. A truly no-op frame emits **zero bytes** (`renderer.zig:1321`).
- **The reconcilers are thin.** React's `react-reconciler` HostConfig and Solid's universal renderer both map host elements 1:1 to core `Renderable` instances via a component catalogue + `extend()` (`react/.../host-config.ts:60`, `react/.../components/index.ts:66`). Custom widgets register the same way the built-ins do.

## How it actually works (the mechanism, step by step)

### 1. The native/JS boundary: zero-copy SoA cell buffers

The Zig `OptimizedBuffer` stores cells as **struct-of-arrays** — separate `char: []u32`, `fg`, `bg`, `attributes` arrays — for cache/SIMD friendliness. On the TS side, `OptimizedBuffer.buffers` are typed-array **views over the same native pointers**, so TS writes cells directly into Zig-owned memory with no copy crossing FFI (`buffer.ts:86`):

```ts
char: new Uint32Array(toArrayBuffer(charPtr, 0, size * 4)),
fg:   new Uint16Array(toArrayBuffer(fgPtr, 0, size * 4 * 2)),
bg:   new Uint16Array(toArrayBuffer(bgPtr, 0, size * 4 * 2)),
attributes: new Uint32Array(toArrayBuffer(attributesPtr, 0, size * 4)),
```

`platform/ffi.ts` abstracts over **two FFI runtimes** with one symbol table: Bun FFI (numeric pointers) and node:ffi (bigint pointers), normalized so `zig.ts` declares each native symbol's `{ args, returns }` exactly once and never branches on runtime (`ffi.ts:14-26,100-123`; `zig.ts:223` `createRenderer`, `:1216` `encodeUnicode`).

### 2. The diff core (`renderer.zig:1315` `prepareRenderFrameWithWriter`)

There are two full cell buffers: TS draws into `nextRenderBuffer`, native diffs it against `currentRenderBuffer` cell-by-cell and emits only the deltas.

- **Lazy frame start** is the idle-suppression mechanism: `frame_started` stays false until the first real change (`:1324`). A no-op frame emits nothing — not even cursor sync. The synchronized-update wrapper (`beginRenderFrame`/`syncReset`) is only opened/closed if something was emitted (`:1367-1370`, `:1466`).
- **Per-cell skip**: if `char && attributes && fg && bg` all equal, `continue` (and break the running ANSI run with a `reset` if one was open) (`:1348-1362`).
- **ANSI run coalescing**: re-emit cursor-move + SGR color/attrs only when `fg/bg/attrs` differ from the running state (`sameAttributes`, `:1372-1374`). Consecutive same-style cells just stream their glyphs (`:1394-1412`).
- After emitting a cell it calls `self.currentRenderBuffer.syncCell(x, y, nextCell)` (`:1452`) — deliberately `syncCell` (no span cleanup) rather than a full set, because span cleanup would destroy continuation cells written earlier in the same left-to-right row pass (the emoji bug #723, comment at `:1448-1451`).
- **Cursor, mouse-pointer style, and OSC-8 hyperlinks are all diffed too** — emitted only on change (`:1378` link id, `:1470` cursor). Everything is "emit only on change."

### 3. Graphemes packed into the u32 cell (`grapheme.zig:9-31`)

The char cell is tagged in bits 31-30: `00…` = direct 30-bit Unicode scalar (ASCII/BMP fast path); `10…` = grapheme **start** cell carrying a 26-bit pool ID `[class(3) | generation(7) | slot(16)]`; `11…` = **continuation** cell for trailing columns of wide/emoji glyphs. Bits 29-26 carry left/right cell extent so the renderer knows how many columns to skip (`charRightExtent`, used at `renderer.zig:1423`). Multi-byte clusters live in a slab-allocated `GraphemePool` (size classes 8/16/32/64/128), interned by bytes so repeats share an ID, refcounted with **generation tags** to catch use-after-free (`WrongGeneration` error). Cell stays a flat u32; heavy bytes are out-of-line.

### 4. The TS render walk (`Renderable.ts`)

`RootRenderable.render` (`:1740`) is the per-frame entry, explicitly 3-pass:

```
1. if (yogaNode.isDirty()) calculateLayout()      // Yoga flexbox, in TS
2. renderList.length = 0; updateLayout(dt, renderList)   // tree → flat command list
3. for command in renderList: execute against buffer     // render / scissor / opacity
```

`updateLayout` (`:1366`) per node: `onUpdate(dt)` → `updateFromLayout()` (samples Yoga coords) → push `pushOpacity` if `_opacity < 1` → push `{action:"render", renderable:this}` → push `pushScissorRect` if `overflow !== "visible"` → recurse z-ordered children → pop scissor/opacity. Scissor/opacity become paired push/pop commands that map onto the native scissor/opacity stacks (`buffer.pushScissorRect`, `:485`). The actual draw happens in `Renderable.render` (`:1451`): optional `renderBefore` hook → `renderSelf(buffer, dt)` → `renderAfter` hook → then it **re-samples cached `_screenX/_screenY`** (because hooks may have moved the node) and writes the node's `num` into the hit grid via `ctx.addToHitGrid` (`:1471-1475`).

`_screenX/_screenY` are **cached absolute coords** updated during layout (`:519-522`), so the hot path never walks the parent chain. `_lastLayoutFrame` (`:261`, guard at `:1082`) prevents double-computing a node's layout within one frame.

### 5. The scheduler (`renderer.ts`)

`loop()` (`:4295`) per iteration: bump `_frameId`, run `animationRequest` callbacks (each does `dropLive()`), `await` each `frameCallback`, `root.render(nextRenderBuffer, dt)`, post-process fns, console overlay, then `renderNative()` (`:4430`). Two modes:

- **Running** (`_isRunning`): after a successful native render, self-reschedules at `targetFrameTime` (or `minTargetFrameTime` if `immediateRerenderRequested`) (`:4384-4391`).
- **On-demand**: `requestRender()` (`:1434`) is a **no-op while `_isRunning`** (the loop already self-schedules); during an in-flight render it only latches `immediateRerenderRequested` to avoid an infinite render loop (`:1443-1448`); otherwise it schedules one `activateFrame()` via `process.nextTick`/`setTimeout` throttled to `minTargetFrameTime`, coalescing if already scheduled.

`requestLive()/dropLive()` flip the renderer between modes; `RootRenderable.propagateLiveCount` (`:1793`) calls them when the tree's total live count crosses 0. `idle()` (`:1517`) resolves when `isIdleNow()` (`:1496`) — used heavily by tests and by headless capture.

**Backpressure**: `renderNative` returns `"rendered" | "backpressured" | "skipped"`. On SKIPPED/FAILED from the native writer it calls `scheduleRenderAfterFeedIdle()` (`:1407`) to retry after the async span feed drains. The Zig `BufferedBackend` can run a dedicated write thread (mutex+condvar) so output never blocks the JS thread.

`intermediateRender()` (`:4425`) forces a synchronous immediate frame — hunk fires it on layout/wrap changes so relayout "feels instant" rather than waiting for the next React commit.

### 6. The reconcilers (React + Solid)

The component model is the same on both: a global **component catalogue** maps element type-name → `Renderable` subclass constructor; `extend(objects)` does `Object.assign(componentCatalogue, objects)` (`react/.../components/index.ts:52,66`). The React HostConfig (`react/.../reconciler/host-config.ts`):

- `createInstance(type, props, container)` → `new components[type](container.ctx, { id, ...props })` — **host instances *are* core Renderables** (`:60`).
- `appendChild` → `parent.add(child)` (`:67`); `insertBefore` → `parent.insertBefore` (`:77`); `commitUpdate` → `updateProperties` (`:159`); `removeChild` → `parent.remove(child.id)`.
- `resetAfterCommit` → `container.requestRender()` (`:99`). Commit methods need **no explicit requestRender** because core's property setters already call it internally (comment at `:157`); the reconciler stays thin.

Solid uses solid-js's `createRenderer` universal renderer with the same catalogue lookup (`solid/src/reconciler.ts:190-198`), a `setProperty` mapping, and a text-node subtree for inline styled text.

### 7. Building a custom Renderable — the canonical recipe

Two strategies, both seen across the apps:

**(a) Leaf that draws into the buffer.** Subclass `Renderable`, override `renderSelf(buffer)`, mutate via setters that call `requestRender()`. The spinner (`opentui-spinner/src/index.ts`) is the cleanest example: `start()` (`:170`) installs a `setInterval` whose body only advances an index and calls `requestRender()` — the timer never draws, it defers painting to core. `renderSelf` (`:188`) iterates pre-encoded frames and `buffer.drawChar(char, x, y, fg, bg)`, advancing `x += data[i].width` by **true display width**. Frames are pre-encoded once via `lib.encodeUnicode(frame, ctx.widthMethod)` (`:87`) and — critically — **freed** with `lib.freeUnicode` on frame change and in `destroySelf` (`:96`), because those are native allocations. Registration is one line + a type augmentation, identical for React and Solid:

```ts
import { extend } from "@opentui/react"            // or @opentui/solid
extend({ spinner: SpinnerRenderable })
declare module "@opentui/react" { interface OpenTUIComponents { spinner: typeof SpinnerRenderable } }
```

`opentui-ui` shows the styled-leaf version: `Badge`/`Checkbox` extend `StyledRenderable extends Renderable`, draw with `buffer.fillRect`/`buffer.drawText` in `renderSelf` (`checkbox.ts:193`), **alpha-gate** every draw (`if (bg.a > 0) …` — `"transparent"` → a=0 → skip, no special path), and cache parsed colors keyed by a style string so they don't re-parse every frame (`checkbox.ts:115-132`).

**(b) Composite that builds a subtree.** Extend `BoxRenderable` and add child `TextRenderable`/`BoxRenderable` with flexbox props — never touch the buffer. `opentui-ui` Toast/Dialog do this; layout is Yoga.

**(c) Framebuffer leaf.** `FrameBufferRenderable` (`core/.../renderables/FrameBuffer.ts:11`) owns its own `OptimizedBuffer`; you write cells into `this.frameBuffer.setCell(...)` and `renderSelf` blits it with `buffer.drawFrameBuffer`. termdraw's `TermDrawRenderable` and opentui-doom both subclass this — doom blits a downscaled DOOM framebuffer using half-block `▀` glyphs (fg = top pixel, bg = bottom pixel) for 2× vertical resolution (`opentui-doom/src/index.ts:264-293`), letting the lib own all diffing.

## Cross-repo comparison

| Repo | Renderable strategy | Reconciler | Standout technique |
|---|---|---|---|
| **opentui (core)** | the engine | provides both | Zig diff core, zero-copy SoA buffers, grapheme bit-packing, 3-pass walk |
| **opentui-spinner** | leaf `renderSelf` + timer | `extend` both | pre-encode+free native Unicode; per-char `ColorGenerator`; per-char width advance |
| **opentui-ui** | leaf (`StyledRenderable`) **and** composite (`BoxRenderable` subtree) | thin React/Solid wrappers | Stitches-style `styled()` (slots+variants+state selectors); alpha-gated draws; parsed-color cache; pub/sub singletons + Map reconciliation (toast/dialog) |
| **ghui** | uses built-in `<box>/<text>/<diff>` + refs | React 19 (`createRoot`) | the **keymap algebra** (pure composable bindings, `pureDispatch`); imperative per-line diff coloring with a settle retry loop; runtime theme from terminal palette |
| **critique** | built-in `<diff>`, never own grid | React 19 (opentui fork) | feed the `<diff>` correctly: delimiter balancing for tree-sitter; headless `createTestRenderer` → ANSI/HTML/PNG; quiescence detection via monkey-patched `requestRender` |
| **hunk** | built-in `<box>/<text>` + heavy memo | React 19 | virtualization (measure-without-mount geometry → window + spacer boxes); WeakMap span caches; velocity-adaptive overscan; `intermediateRender()` |
| **termdraw** | `FrameBufferRenderable` subclass | `extend` | headless `DrawState` model + dumb view; dirty-flag cached scene rasterization; box-join via directional bitmask; Braille sub-cell lines |
| **opentui-doom** | `FrameBufferRenderable` | imperative (`setFrameCallback`) | half-block 2× pixels; terminal-repeat → press/release synthesis; WASM framebuffer blit |

**Where they agree:** never hand-roll ANSI or a grid — write cells, let core diff. Mutate state then `requestRender()`; the timer/handler never draws. Free native resources (`freeUnicode`, `destroy()`, clear intervals) or leak in a long-lived TUI. Use `Intl.Segmenter` / `string-width` / encoded `.width` for cell width, never `.length`.

**Where they differ / who's better:**
- **Input.** ghui's keymap algebra (`packages/keymap`) is best-in-class: bindings are values, dispatch is `pureDispatch(keymap, state, stroke, ctx, now) → {state, decision}`, multi-stroke disambiguation re-reads ctx at timeout. critique/hunk use a single `useKeyboard` handler with hand-ordered modal precedence — simpler but the ordering is "the load-bearing invariant." Prefer the algebra for anything with leader keys or layered modes.
- **Rich content.** critique and hunk both drive the built-in `<diff>` but solve different problems: critique preprocesses the patch (delimiter balancing so per-hunk tree-sitter stays sane) and does multi-backend headless capture; hunk does production-grade virtualization + async shiki highlight queue + plain-text-first-then-upgrade. hunk is the better reference for large-document performance; critique for correctness of third-party-widget feeding.
- **Retained vs immediate.** termdraw is the cleanest "headless model + thin view" separation (the `DrawState` model never touches the buffer); everything reads getters, all input calls mutators then `requestRender()`. Best template for an editor.

## Pitfalls & hard parts

- **Layout is recomputed every frame in TS** (`Renderable.ts:1374-1380`). It can't be 2-pass until Yoga moves native. Keep trees shallow; memoize JSX (hunk uses `memo` with hand-written comparators).
- **Native resources must be freed manually.** `encodeUnicode` → `freeUnicode` (spinner); every Renderable's `destroySelf` must clear timers/intervals, unsubscribe, and call `super.destroySelf()`. Forgotten `setInterval`/subscriptions are the #1 long-lived-TUI leak (opentui-ui notes this explicitly).
- **`syncCell` not full set after emit** in the diff core, or you clobber continuation cells written earlier in the same row pass (emoji #723). Continuation cells deliberately write **no space** (`renderer.zig:1437`).
- **Scheduler guards are subtle.** `requestRender` is a no-op while running; during an in-flight render it only latches `immediateRerenderRequested`. Get these wrong → dropped frames or an infinite render loop (`renderer.ts:1443-1448`).
- **Renderables settle async.** Diff line geometry / split-view rebuild aren't ready on mount — ghui retries imperative line coloring 8× @16ms (`useDiffLineColors.ts:176`); critique's headless capture needs **two** wait phases because opentui's `DiffRenderable` schedules a split rebuild via `queueMicrotask` after `isHighlighting` goes false.
- **Width has two notions.** Bounding-box width often uses `.length` (UTF-16 units) but cursor advance must use the encoded per-char `.width`; they disagree for wide/emoji glyphs (spinner gotcha).
- **Terminals give repeats, not press/release.** For game-like input you must synthesize key-up via a debounce timer (opentui-doom `doom-input.ts`).
- **Coordinate spaces stack:** screen → renderable (`event.x - this.x`) → content/canvas. Easy to confuse (termdraw `getCanvasInsets`).
- **Compiled-Bun `stdout.columns === 0`** even when `isTTY` — patch dimensions via `tput` *before* importing opentui (critique `patch-terminal-dimensions.ts`).
- **Clean teardown on every exit path** — `exitOnCtrlC: false` + funnel SIGINT/SIGTERM/exit through one idempotent shutdown that exits alt-screen and kills subprocesses (hunk `main.tsx`, doom `cleanup()`).

## If you were building this from scratch (recommended approach)

The lesson is the **architecture split**, not the Zig. Keep the per-cell hot loop in a fast language; keep the scene graph and ergonomics in JS; share cell memory zero-copy.

```
// NATIVE (or WASM): owns buffers + diff + ANSI
struct Cell { char: u32; fg: RGBA; bg: RGBA; attrs: u32 }   // SoA arrays, not AoS
fn render(force):
  frame_started = false
  for y, x in cells:
    if !force and next[x,y] == current[x,y]: continue        // skip unchanged
    if !frame_started: writer.write(SYNC_BEGIN); frame_started = true
    if style(next) != running_style: writer.write(cursorMove(x,y) + sgr(next))
    writer.write(glyph(next))
    current[x,y] = next[x,y]                                  // sync for next diff
  if frame_started: writer.write(RESET + SYNC_END)            // else: ZERO bytes

// JS: scene graph + scheduler
class Renderable {
  renderSelf(buf, dt) {}                  // override to draw
  requestRender() { ctx.requestRender() } // setters call this; never draw in setters
}
class Root extends Renderable {
  render(buf, dt) {
    if (yoga.dirty) calculateLayout()
    list = []; this.updateLayout(dt, list)            // tree → flat command list
    for (cmd of list) execute(cmd, buf)               // render / scissor / opacity
  }
}
function loop() {
  frameId++
  for (cb of frameCallbacks) await cb(dt)
  root.render(nextBuffer, dt)
  status = native.render(force)                       // diff + flush
  if (running || immediateRequested) schedule(loop, targetFrameTime)
}
function requestRender() {                             // on-demand mode
  if (running) return                                  // loop self-schedules
  if (rendering) { immediateRequested = true; return } // avoid infinite loop
  if (!scheduled) { scheduled = true; nextTick(loop) } // coalesce
}
```

Then: pack graphemes into the u32 cell (tag bits + out-of-line pool) so the cell stays flat; diff cursor/pointer/hyperlink state too (emit only on change); wrap each frame in synchronized-update markers only when non-empty; expose `extend({ name: RenderableClass })` + a host-config that maps elements 1:1 to Renderables and calls `requestRender` in `resetAfterCommit`. Run output on a dedicated thread with a 3-state return (rendered/backpressured/skipped) and retry on backpressure.

## Source map (where to read more)

**Core engine — `context/opentui/packages/core/`**
- `src/zig/renderer.zig:1315` `prepareRenderFrameWithWriter` — the diff + ANSI emitter; `:1470` cursor diff; hit grid `:190,273`.
- `src/zig/grapheme.zig:9-31` — cell bit-packing; `:37` `GraphemePool` slab allocator.
- `src/zig/buffer.zig` — SoA `OptimizedBuffer`, alpha blending, scissor/opacity stacks.
- `src/Renderable.ts:206` `Renderable`, `:1366` `updateLayout`, `:1451` `render`, `:1715` `RootRenderable`, `:486` `propagateLiveCount`.
- `src/renderer.ts:4295` `loop`, `:1434` `requestRender`, `:1465` `activateFrame`, `:4430` `renderNative`, `:4425` `intermediateRender`, `:666` `createCliRenderer`.
- `src/buffer.ts:86` zero-copy views; `:233` `setCell`, `:250` `drawText`, `:485` `pushScissorRect`.
- `src/platform/ffi.ts` — Bun/node:ffi abstraction; `src/zig.ts:223,1216` symbol table.
- `packages/react/src/reconciler/host-config.ts:48-99`; `packages/react/src/components/index.ts:66` `extend`; `packages/solid/src/reconciler.ts:190`.
- `src/renderables/FrameBuffer.ts:11`, `Box.ts:46` — base widget classes.

**Apps**
- Custom Renderable + dual-framework registration: `context/opentui-spinner/src/index.ts:87,170,188,220`, `react.ts`/`solid.ts`.
- Styling engine + composite widgets: `context/opentui-ui/packages/styles/resolve.ts:24,69`, `core/src/checkbox/checkbox.ts:115,193`, `toast/src/renderables/toast.ts`, `dialog/src/manager.ts:346`.
- Input algebra: `context/ghui/packages/keymap/src/{keymap.ts,pure-dispatch.ts:58,dispatcher.ts:47}`; bridge `src/keyboard/opentuiAdapter.ts`.
- Feeding `<diff>` + headless capture: `context/critique/cli/src/{balance-delimiters.ts,web-utils.tsx:134,diff-view.tsx:35}`.
- Virtualization + async highlight: `context/hunk/src/ui/diff/{pierre.ts,rowWindowing.ts,diffSectionGeometry.ts}`, `DiffPane.tsx`.
- Retained model + framebuffer: `context/termdraw/packages/opentui/src/{draw-state.ts:1792,app.ts:235,scene.ts:245}`.
- Framebuffer blit / WASM: `context/opentui-doom/src/{index.ts:264,doom-engine.ts:244,doom-input.ts}`.
