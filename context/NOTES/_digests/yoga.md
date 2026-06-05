# yoga

## What it is (1-2 lines)
Meta's cross-platform Flexbox layout engine: a C++ core (`yoga/`) that takes a tree of styled nodes and computes positions/dimensions, with bindings to JS (Emscripten/wasm), Java/JNI, and Swift. It is the layout engine behind React Native and a common choice for TUI frameworks (Ink, etc.) that need CSS-flexbox semantics in a non-DOM environment.

## Architecture (how the pieces fit; key files with paths)
Pure layout engine — no rendering, no input, no ANSI. It answers one question: "given this node tree and these styles, where does every box go?" A TUI built on Yoga supplies `measureFunc`s (text width) and consumes `getComputedLayout()` to drive its own renderer.

- **Public C API**: `yoga/Yoga.h` + `yoga/YGNode*.cpp` (`YGNodeNew`, `YGNodeInsertChild`, `YGNodeStyleSet*`, `YGNodeCalculateLayout`, `YGNodeLayoutGet*`). Opaque `YGNodeRef` handles.
- **Node tree / data structures**: `yoga/node/Node.{h,cpp}` (children vector, owner pointer, style, measure/baseline/dirtied callbacks, dirty bit). `yoga/node/LayoutResults.{h,cpp}` holds computed output + the per-node measurement cache. `yoga/node/CachedMeasurement.h` is one cache slot.
- **The algorithm**: `yoga/algorithm/CalculateLayout.cpp` (2785 lines) is the whole flexbox machine. Entry `calculateLayout()` → `calculateLayoutInternal()` (cache gate) → `calculateLayoutImpl()` (the 11-step CSS flexbox algorithm).
- **Support algorithm pieces**: `Cache.cpp` (cache-validity logic), `FlexLine.cpp` (line breaking), `AbsoluteLayout.cpp` (position:absolute children), `Baseline.cpp` (baseline alignment), `PixelGrid.cpp` (rounding to a device pixel grid), `BoundAxis.h`/`Align.h`/`FlexDirection.h` (axis/min-max helpers).
- **Sizing model**: `yoga/algorithm/SizingMode.h` maps CSS sizing (StretchFit / MaxContent / FitContent) to the public `MeasureMode` (Exactly / Undefined / AtMost).
- **JS bindings**: `javascript/src/wrapAssembly.ts` (1025 lines, the hand-written JS class wrapper over the wasm exports), `javascript/src/wasm_bridge.c` (Emscripten C glue for struct returns and JS callbacks), `index.ts`/`load.ts` (entry points; `index.ts` top-level-awaits the wasm module, `load.ts` exposes a lazy `loadYoga()`).

## Core techniques (the actual engineering)

### 1. Two-phase layout: measure vs. perform-layout
Every recursive call carries a `performLayout` bool (`CalculateLayout.cpp:1523`). When `false`, Yoga only wants *dimensions* (used to resolve flex bases and probe children); positions are not committed. When `true`, it commits final `position`/`dimension`. Flex resolution needs to measure children multiple times under different constraints before doing one real layout pass — so measure passes vastly outnumber layout passes, which is exactly why the measurement cache (below) matters.

### 2. The measurement cache + generation counter (the clever core)
This is the performance heart. `calculateLayoutInternal` (`CalculateLayout.cpp:2498`) gates every node:
```cpp
const bool needToVisitNode =
    (node->isDirty() && layout->generationCount != generationCount) ||
    layout->configVersion != node->getConfig()->getVersion() ||
    layout->lastOwnerDirection != ownerDirection;
```
- A global atomic `gCurrentGenerationCount` is incremented once per top-level `calculateLayout()` (`:2707`). This forces every dirty node to be visited *at least once per tree layout*, but lets repeated visits *within* a pass hit cache.
- Each `LayoutResults` keeps one `cachedLayout` (the perform-layout result) plus an array of `cachedMeasurements[MaxCachedMeasurements]` (a small ring buffer; index wraps at `:2641`).
- `canUseCachedMeasurement` (`Cache.cpp:45`) decides reuse. It is *not* a simple equality check — it understands CSS sizing semantics: an exact (StretchFit) request can reuse a prior result if the size matches; a FitContent request can reuse an old MaxContent result if it still fits (`oldSizeIsMaxContentAndStillFits`); a stricter FitContent can reuse a looser one if the old computed size is still within bounds (`newSizeIsStricterAndStillValid`). This captures "if I already know it wants 80px at max-content and you now give it 100px available, the answer is still 80px."
- Cache comparisons are done against *pixel-grid-rounded* available sizes (`Cache.cpp:64-80`) so sub-pixel jitter doesn't cause spurious cache misses.

### 3. Dirty propagation (incremental layout)
`Node::markDirtyAndPropagate()` (`Node.cpp:453`) walks *up* to the owner, marking ancestors dirty, and stops early if already dirty (`if (!isDirty_)`) — so a no-op style write costs nothing and dirtying is O(depth) not O(tree). Setting any style that affects layout calls this. Only nodes with a measure function may be explicitly `markDirty()`'d by the host (leaf text whose intrinsic size changed). Combined with the generation counter, a re-layout after one style change only recomputes the dirty spine and re-measures what genuinely changed.

### 4. Flexbox as 11 explicit steps
`calculateLayoutImpl` is structured as labeled steps (grep `STEP` in `CalculateLayout.cpp`):
1. Calculate values for remainder (`:1670`)
2. Determine available main/cross size (`:1698`)
3. Determine flex basis per item (`:1722`)
4. Collect items into flex lines — line breaking via `calculateFlexLine` (`:1794`)
5. Resolve flexible lengths on main axis — grow/shrink distribution (`:1827`)
6. Main-axis justification + cross-axis size (`:1929`)
7. Cross-axis alignment (`:1987`)
8. Multi-line content alignment (align-content) (`:2109`)
9. Compute final dimensions (`:2339`)
10. Set trailing positions for RTL/reverse (`:2447`)
11. Size & position absolute children (`:2470`)
Flex grow/shrink is iterative: `FlexLineRunningLayout` (`FlexLine.h:17`) tracks `totalFlexGrowFactors`, `totalFlexShrinkScaledFactors`, and `remainingFreeSpace`, decrementing as space is distributed and re-running when min/max clamps freeze an item.

### 5. Pixel-grid rounding (sub-pixel → integer device pixels)
`PixelGrid.cpp` rounds final positions to a `pointScaleFactor` grid. The non-obvious trick (`roundLayoutResultsToPixelGrid`, `:65`): round **absolute** edges (left, right=left+width) independently, then derive width as `round(right) - round(left)`. This guarantees adjacent boxes share an edge with no 1px gaps/overlaps from independent rounding. Text nodes (`NodeType::Text`) are never rounded *down* (`forceFloor`/`forceCeil` flags) to avoid clipping a glyph. `roundValueToPixelGrid` (`:15`) carefully handles negative fractions and NaN. For a TUI this maps directly: `pointScaleFactor = 1` gives integer cell coordinates.

### 6. Measure-function caching at the leaf
Text measurement is the most expensive thing in the tree. Beyond the C++ cache, the wasm bridge adds a *second* memoization layer per measure function in JS (`wasm_bridge.c:97-103`): it stashes `_cachedResult/_cachedWidth/...` on the function object and returns the cached `{width,height}` if the four inputs match — needed because `globalMeasureFunc` calls JS twice per measurement (once for width, once for height) since wasm can't return a struct.

## Code patterns worth stealing

**Generation-counter cache invalidation** — cheaper than clearing caches; one atomic increment invalidates "this pass" semantics globally without touching nodes:
```cpp
gCurrentGenerationCount.fetch_add(1, std::memory_order_relaxed);
// a node is fresh iff layout->generationCount == generationCount
```

**Sizing-mode-aware cache reuse** instead of exact-match (huge hit-rate win):
```cpp
// FitContent can reuse a MaxContent result that still fits
sizeMode == FitContent && lastSizeMode == MaxContent && size >= lastComputedSize
```

**Round absolute edges, not extents**, to keep neighbors flush:
```
width = round(absLeft + width) - round(absLeft)   // not round(width)
```

**Polymorphic setter dispatch in the JS wrapper** — one JS method handles `setWidth(10)`, `'auto'`, `'50%'`, `'max-content'`, `'stretch'` by parsing the value, picking a Unit, and routing to the matching wasm export (`setWidthPercent`, `setWidthAuto`, ...) via a suffix table (`wrapAssembly.ts:295-362`):
```ts
const suffix = {[Unit.Percent]:'Percent', [Unit.Auto]:'Auto', ...}[unit];
return this[`${fnName}${suffix}`].call(this, ...args, asNumber);
```

**Struct return across wasm via a static scratch buffer** — wasm functions can't return structs by value, so C writes into a static `float[2]` and JS reads it through `HEAPF32`/`HEAP32` at a fixed offset (`wasm_bridge.c:14-24`, `wrapAssembly.ts:276-289`):
```ts
const valueBufIdx = lib._jswrap_YGValueBuffer() >> 2;
return { value: lib.HEAPF32[valueBufIdx], unit: lib.HEAP32[valueBufIdx+1] };
```

**FinalizationRegistry for native memory** — JS GC of the wrapper object triggers `_YGNodeFinalize(ptr)` and removes callback-map entries, so users don't manually free wasm pointers (`wrapAssembly.ts:366-374`).

**JS↔wasm callbacks via a side Map keyed by pointer** — `EM_JS` glue looks up `Module["_yogaMeasureFuncs"].get(nodePtr)` rather than passing function pointers across the boundary; `WeakRef` in the dirtied-func wrapper avoids keeping nodes alive (`wasm_bridge.c:83-94`, `wrapAssembly.ts:904-908`).

## Gotchas / non-obvious decisions
- **Nodes with a measure function cannot have children** — asserted in `setMeasureFunc` (`Node.cpp:138`); measured leaves are opaque to the layout (set `NodeType::Text`). This is the contract a TUI text widget must honor.
- **`measureFunc` is called many times with different `MeasureMode`s** (`Undefined`=intrinsic/max-content, `AtMost`=fit-content, `Exactly`=stretch). Your measurer must respect the mode, and should be cheap/cached — Yoga assumes it is.
- **The C++ measurement cache returns negative as "no value"** — `computedWidth = -1` is the sentinel; `canUseCachedMeasurement` rejects negative cached sizes (`Cache.cpp:59`).
- **`hasNewLayout` / `markLayoutSeen`** is the host's diffing hook: after layout, only nodes with `hasNewLayout()==true` actually changed; call `markLayoutSeen()` to ack. A renderer should only repaint those subtrees.
- **Sub-pixel rounding is config-driven**; `pointScaleFactor==0` disables rounding entirely. TUIs want `1`.
- **`Display::Contents`** nodes are spliced out of the box tree (no box generated) and may be *cloned* into their owner (`Node.cpp:440`, `cloneContentsChildrenIfNeeded`) — a subtle ownership wrinkle.
- **`index.ts` uses top-level `await`** to instantiate wasm at import time; `load.ts` is the alternative for environments that can't await at module scope.
- **wasm is single-threaded**, which is *why* a static return buffer and global generation counter are safe — none of this is thread-safe by design.

## Relevance (which advanced-TUI topics this teaches)
- **layout**: the canonical reference implementation of CSS flexbox — line breaking, grow/shrink resolution, min/max clamping, baseline & content alignment, RTL. If your TUI does flex, this is the source of truth.
- **rendering-pipeline**: two-phase measure/layout, generation-counter caching, dirty propagation, and `hasNewLayout` diffing are directly transferable to a frame loop that minimizes recompute and repaint.
- **reconciler-component-models**: the node-tree + owner pointer + dirty-bit + measure-callback model is the substrate React-Native-style reconcilers (and Ink) build on; shows the clean seam between "compute layout" and "build/diff the tree."
- **unicode-text-width**: the measure-function contract (mode-aware, heavily cached, leaf-only) is exactly where a TUI plugs in grapheme/east-asian-width measurement; the double-memoization shows how costly text measurement is assumed to be.
