# nberlette-tui

## What it is (1-2 lines)
`@nick/tui` v2.4.0 — a fork of `deno_tui` (Im-Beast): a dependency-free, cross-runtime (Deno + Node via `node:process`) reactive terminal UI library. Its defining trait is a hand-rolled fine-grained **signals** system (Signal/Computed/Effect) wired directly into a **cell-level diffing canvas** so that only the exact terminal cells that changed are repainted.

## Architecture (how the pieces fit; key files with paths)
Layered, bottom-up:

- **Signals** (`src/signals/`) — reactivity primitives. `signal.ts` (Signal), `computed.ts` (derived), `effect.ts` (side effect re-run on dep change), `dependency_tracking.ts` (auto dep capture), `flusher.ts` + `lazy_*` (deferred updates), `reactivity.ts` (deep-observe via Proxy/defineProperty for objects/Map/Set), `signalify.ts` (wrap value-or-signal into a Signal).
- **Canvas / Renderables** (`src/canvas/`) — the render engine. `canvas.ts` owns the frame buffer, the z-sorted draw list, intersection (occlusion) computation, and the flush-to-stdout loop. `renderable.ts` is the base "draw object" (a.k.a. painter); `box.ts` and `text.ts` are the two concrete primitives that actually write styled strings into cells.
- **Tui root** (`src/tui.ts`) — app root + render-loop driver. Sets up secondary screen buffer, hides cursor, polls console size, ticks `canvas.render()` at `refreshRate`, wires SIGINT/SIGWINCH and exit handling.
- **Components** (`src/component.ts` + `src/components/*`) — stateful, themed, focusable widgets (Button, Input, Table, Slider, Combobox, etc.). A Component is *not* a Renderable; it owns a `drawnObjects` map of Renderables (BoxObject/TextObject) and reacts to its own signals.
- **Input** (`src/input/`) — raw stdin parsing. `mod.ts` read loop + buffer splitter; `keyboard.ts` decodes escape sequences to KeyPress; `mouse.ts` decodes SGR + legacy VT/UTF8 mouse protocols. `controls.ts` maps input to focus/navigation; `input.ts` is the thin Tui glue.
- **Layout** (`src/layout/`) — `grid_layout.ts`, `horizontal_layout.ts`, `vertical_layout.ts` produce `Signal<Rectangle>` per slot; components subscribe to those for positioning.
- **View** (`src/view.ts`) — a scroll/clip viewport: a rectangle + offset that Renderables can be parented to, shifting and clipping their cells.
- **Utils** (`src/utils/`) — `strings.ts` (textWidth, grapheme splitting, ANSI strip/crop), `numbers.ts` (rectangle intersection/equality), `sorted_array.ts` (auto-sorting Array subclass), `ansi_codes.ts` (escape constants + `moveCursor`).
- Entry: `mod.ts` re-exports; `deno.json` `exports` map exposes fine-grained subpath imports for every module.

Data flow: `Component` signals → `Renderable` rectangle/style/text signals → Effect/subscription marks object dirty and pushes onto `canvas.updateObjects` → `canvas.render()` recomputes occlusion, repaints dirty cells into `frameBuffer`, and emits a minimal cursor-move + write sequence.

## Core techniques (the actual TUI engineering)

### Cell-level diffing with a frame buffer (`canvas/canvas.ts`)
- `frameBuffer: (string|Uint8Array)[][]` is the source of truth: `[row][column]` of already-styled cell strings.
- `rerenderQueue: Set<number>[]` — per-row set of column indices that changed this frame. The flush loop (`render()` lines 178-211) iterates rows, and for each queued column emits a cell; it only injects a `moveCursor(row,column)` escape when the cursor isn't already at `(lastRow, lastColumn+1)` (canvas.ts:185). Contiguous runs cost zero cursor moves — this is the central output-minimization trick.
- Windows quirk: if a pending `drawSequence` exceeds 1024 bytes it's flushed early with a fresh cursor move (canvas.ts:192-197), because Windows terminals choke on huge writes.

### Dirty-object pipeline + occlusion ("objectsUnder" / "omitCells")
- `updateObjects: Renderable[]` is the dirty queue. Each frame it's sorted **top z-index first** (canvas.ts:133), then each object's `update()/updateMovement()/render()|rerender()` runs once (`object.updated` guards double-processing).
- **Occlusion is precomputed, not z-tested per cell.** `updateIntersections()` (canvas.ts:76-118): for a given object, walk all drawn objects; anything with higher z (or equal-z but higher id) that overlaps contributes its overlapping cells to this object's `omitCells[row]: Set<column>` — i.e. "don't bother painting these, something covers them." Lower objects that overlap are recorded in `objectsUnder` so they can be told to repaint when this object moves/erases.
- This means a Renderable's `rerender()` skips any cell in `omitCells` (see box.ts:92, text.ts:249). Z-ordering is resolved once at intersection-update time rather than per-pixel.

### Movement diffing (`canvas/renderable.ts` `updateMovement`, lines 222-263)
When an object's rectangle changes, it computes `rectangleIntersection(new, previous)`. Cells in the **old** rect but not the intersection are queued for repaint on the objects *under* it (to "uncover" them); cells in the **new** rect but not the intersection are queued on *itself*. The intersection (the cells that didn't move) is left untouched. `previousRectangle` is mutated in place to avoid allocation (renderable.ts:208-220).

### Text diffing per character (`canvas/text.ts`)
- TextObject is explicitly single-line. On text change `update()` (text.ts:58-111) compares `valueChars` to `previousValueChars` character-by-character and only `queueRerender`s columns where the char differs. Shrinking text queues the freed trailing columns on `objectsUnder` so the background shows through (the "barrier" logic, text.ts:83-103).
- Auto-width: when `overwriteRectangle` is false, width is recomputed via `textWidth()` and a width change flags `moved` (text.ts:64-74).
- `rerender()` writes `style(valueChars[column - rectangle.column])` per visible column, respecting `omitCells`, canvas bounds, and the optional `view` clip rect.

### Unicode width + grapheme handling (`utils/strings.ts`)
- `characterWidth()` (strings.ts:154) is a sindresorhus-style fullwidth-codepoint table returning 2 for CJK/wide ranges, 0 for ZWSP/specific, else 1.
- `textWidth()` walks the string, skipping ANSI escape runs (detects `\x1b`, jumps `i += 2`, ends on a "final ANSI byte" 0x40-0x6F via `isFinalAnsiByte`), summing `characterWidth`.
- `getMultiCodePointCharacters()` uses a large lodash-derived `UNICODE_CHAR_REGEXP` to split emoji/ZWJ/flag/skin-tone sequences into single visual chars, and re-attaches trailing ANSI style runs to each grapheme so styled emoji survive the split.
- `cropToWidth()` truncates by *visual* width (not code units), padding a space if a wide char would be cut mid-cell.

### Signals: async dependency tracking (`signals/`)
- A global `activeSignals: Set` (dependency_tracking.ts:4). Reading `signal.value` does `activeSignals?.add(this)` (signal.ts:218-221). `peek()` reads without tracking; `jink()` sets without propagating.
- `track()` (dependency_tracking.ts:10-31) is **async** and serialized with an `incoming` counter (`while (incoming) await Promise.resolve()`), so Computed/Effect construction captures deps in microtask order without re-entrancy. This is why the docs repeatedly say "dependency tracking is asynchronous; `await Promise.resolve()` before expecting updates."
- `optimize()` (dependency_tracking.ts:36-48) flattens a Computed's deps to their *root* Signals so one source change doesn't fire an Effect multiple times through intermediate Computeds.
- `propagate()` (signal.ts:154-180) runs subscriptions, conditional `when` subscriptions, then `update()`s dependants. Setter only propagates if `oldValue !== newValue` (or `forceUpdateValue`) (signal.ts:223-229).
- **Deep observation**: `new Signal(obj, {deepObserve:true})` wraps the object so mutating a property fires propagation — via Proxy (`watchObjectIndex:true`, catches new keys) or `Object.defineProperty` (existing keys only); Map/Set get method-patched (reactivity.ts). This is how mutating `rectangle.width` triggers a repaint without reassigning the signal.
- `Flusher`/`LazyComputed`/`LazyEffect`: defer dependant updates until `flusher.flush()` — for batching expensive recompute to e.g. an animation frame.
- DX touches: Signal implements `Symbol.toPrimitive`, `valueOf`, `toString`, `Symbol.dispose`; `isSignal` uses a private-field brand check installed in a `static {}` block (signal.ts:260-262).

### Input parsing (`input/`)
- Read loop (`input/mod.ts`): raw mode on, fixed 1024-byte buffer reused, `setTimeout(read, minReadInterval)` self-reschedule (not a tight await loop) to throttle at refresh rate.
- `decodeBuffer()` (mod.ts:65-82) splits a buffer that contains *multiple* escape sequences by finding the last `\x1b` and recursing on the two halves — handles pasted/batched input where several keys arrive in one read.
- Decoders return a **single reused mutable event object** ("don't hold onto the reference") to avoid GC churn (keyboard.ts:7, mouse.ts:4).
- Keyboard (keyboard.ts): Ctrl-letters detected via `buffer[0] + 96` mapping to a-z; meta via leading ESC byte; CSI sequences parsed for modifiers (`\d+.+(\d+)` → 2=shift,3=meta,5=ctrl) and arrow/function/nav keys.
- Mouse: both modern SGR (`\x1b[<...M/m`, mouse.ts:25) and legacy VT/UTF8 (`\x1b[M` + char-code coords, mouse.ts:126). Modifier bitfield decoded by subtracting 64/32/16/8/4 to extract scroll/drag/ctrl/meta/shift; `movementX/Y` derived from the previous event.

### Render loop & terminal lifecycle (`tui.ts`)
- `run()` writes `USE_SECONDARY_BUFFER + HIDE_CURSOR`, then `updateStep()` calls `canvas.render()` and re-`setTimeout`s at `refreshRate` (tui.ts:200-209). Destroy restores `USE_PRIMARY_BUFFER + SHOW_CURSOR` and un-raws stdin (tui.ts:222).
- Resize: SIGWINCH + stdout/stderr `resize` events on POSIX; a polling `setInterval` on Windows (tui.ts:123-129). Size lives in `canvas.size` Signal with `deepObserve`, and a subscription sets `resizeNeeded`; `resize()` (canvas.ts:63-74) marks every in-bounds object dirty.

## Code patterns worth stealing

**Contiguous-run cursor minimization (the heart of the diff flush):**
```ts
for (const column of changedColumnsInRow) {
  if (row !== lastRow || column !== lastColumn + 1) {
    drawSequence += moveCursor(row, column); // only move when not adjacent
  }
  drawSequence += frameBuffer[row][column];
  lastRow = row; lastColumn = column;
}
```

**Precomputed occlusion instead of per-cell z-test:**
```ts
// for each object above me that overlaps, mark its cells as "skip"
for (let r = isect.row; r < isect.row + isect.height; ++r) {
  const omit = omitCells[r] ??= new Set();
  for (let c = isect.column; c < isect.column + isect.width; ++c) omit.add(c);
}
// rerender() then: if (omitColumns?.has(column)) continue;
```

**signalify — accept value-or-signal everywhere:**
```ts
this.zIndex = signalify(options.zIndex); // number | Signal<number> -> Signal<number>
// component API can take static values OR reactive signals interchangeably
```

**Reuse one event object across the hot path:**
```ts
const keyPress = { key:"-", ctrl:false, shift:false, meta:false, buffer:null };
export function decodeKey(buf, code) { keyPress.key = ...; return keyPress; } // no alloc per key
```

**Mutate-in-place reactive object to trigger repaint (deepObserve):**
```ts
this.rectangle = signalify(rect, { deepObserve: true, watchObjectIndex: true });
rect.width = textWidth(text); // fires subscription, no reassignment
```

**Split a multi-sequence input buffer:**
```ts
const last = code.lastIndexOf("\x1b");
if (code.indexOf("\x1b") !== last) { yield* decode(buf.slice(0,last)); yield* decode(buf.slice(last)); }
```

## Gotchas / non-obvious decisions
- **Dependency tracking is asynchronous.** A freshly created Computed/Effect does not see new dependency changes until a microtask later (`await Promise.resolve()`). Surprising vs. SolidJS/Preact signals which track synchronously. Caused by the `track()` serialization in `dependency_tracking.ts`.
- **TextObject is single-line only** — multiline text is the component layer's job (it composes multiple TextObjects).
- **Components are not Renderables.** A Component holds a `drawnObjects` map; `draw()` erases-and-recreates those objects. Visibility cascades to children via the `visible` signal subscription.
- **Z-order tiebreak is creation id**, not insertion order: `SortedArray` compares `zIndex.peek() || id` (canvas.ts:50-52). Later-created objects at equal z render on top.
- **`SortedArray` re-sorts on every push/splice/fill** — O(n log n) per mutation; fine for typical UI object counts, a footgun at large scale.
- Renderable carries both `omitCells` (covered, skip) and `rerenderCells` (queued to draw) per row as sparse `Set[]` arrays — two different per-row cell sets, easy to confuse.
- `View` clipping is applied independently in each Renderable's `rerender()` and `updateOutOfBounds()`; there's no central clip stack.
- Events go through a custom `EventEmitter` (`event_emitter.ts`), not Node's; component focus is modeled as a `state` Signal (`base|focused|active|disabled`) that gates input forwarding (component.ts:128-151).
- Cross-runtime: uses `node:process` for signals/platform but `Deno.build.os` in `input/mod.ts` — so the input layer still assumes Deno globals despite the Node import elsewhere.

## Relevance (which advanced-TUI topics this teaches)
- **rendering-pipeline**: textbook cell-diffing frame buffer + dirty queue + minimal cursor-move output; the clearest small implementation to learn from.
- **reconciler-component-models**: signal-driven dirty marking instead of a vdom reconciler; Component-owns-Renderables composition.
- **ansi-escapes**: secondary buffer, cursor hide/show, mouse enable, `moveCursor`, ANSI-aware string scanning.
- **unicode-text-width**: fullwidth tables, grapheme/ZWJ/emoji splitting, width-aware cropping with style preservation.
- **input-keyboard-mouse**: raw-mode read loop, multi-sequence buffer splitting, SGR + legacy mouse decoding, reused event objects.
- **layout**: grid/horizontal/vertical layouts that emit `Signal<Rectangle>` slots consumed reactively.
- **app-architecture**: render-loop lifecycle, resize handling (SIGWINCH vs Windows polling), signals reactivity engine, fine-grained vs vdom tradeoffs.
- **widgets-rich-content**: themed, focusable component set (Table, Combobox, Slider, Input) built on the two primitives.
