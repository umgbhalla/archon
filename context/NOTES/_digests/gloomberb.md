# gloomberb

## What it is (1-2 lines)
A keyboard-driven, data-dense finance terminal ("Bloomberg in a TUI") built with React on `@opentui/core` + `@opentui/react`, running under Bun. It implements a full tiling/floating window manager inside the terminal, virtualized data tables, and pixel-accurate price charts via the Kitty graphics protocol. The same React tree also targets a desktop (Electrobun/web) renderer through a host-abstraction layer.

## Architecture (how the pieces fit; key files with paths)
- **Entry**: `src/index.tsx` -> `src/renderers/opentui/start.tsx`. Start initializes the data dir, loads external plugins, dispatches CLI args (`src/cli`), then mounts the React app inside a stack of host providers.
- **Host abstraction (the key design move)**: `src/ui/host.tsx` defines three context-injected interfaces so the app never imports opentui directly:
  - `UiHost` — the component library (`Box`, `Text`, `ScrollBox`, `Input`, `Textarea`, `ChartSurface`, `DataTable`, `Tabs`, `AsciiText`...) plus a `capabilities` object (`nativePaneChrome`, `precisePointer`, `cellWidthPx`, `canvasCharts`, `nativeCharts`...).
  - `RendererHost` — imperative side-effects (`requestExit`, `openExternal`, `copyText`/`readText`, `notify`, `showContextMenu`).
  - `NativeRendererHost` — low-level renderer access (`terminalWidth/Height`, `resolution` in pixels, `requestRender`, `registerLifecyclePass`, `getSelection`, `copyToClipboardOSC52`, raw `write`).
  The opentui implementation lives in `src/renderers/opentui/host.tsx`; a parallel desktop renderer exists under `src/renderers/electrobun/`. Components consume via `useUiHost()`, `useRendererHost()`, `useNativeRenderer()`, `useUiCapabilities()`.
- **App shell**: `src/app.tsx` (`AppInner`) wires Redux-ish state (`src/state/app/context`), the `Header`, `StatusBar`, `Shell`, `CommandBar`, dialogs and toasts. Heavy logic is split into `src/app/runtime/*` hooks (startup, pane-runtime, ticker-refresh, broker-import, update).
- **Window manager**: `src/components/layout/shell/index.tsx` orchestrates docked panes, floating panes, drag, window-mode (keyboard resize), and context menus. The layout *math* is a pure library in `src/plugins/pane-manager/*`.
- **Plugins**: `src/plugins/registry/index.ts` + `src/plugins/builtin/*` — every pane (ticker detail, SEC filings, 13F, chat, screener, portfolio) is a plugin contributing panes, shortcuts, and context-menu items.
- **Widgets**: `src/components/ui/data-table/opentui/index.tsx` (virtualized table), `src/components/chart/native/*` (Kitty/braille charts), `src/ui/ascii-font.ts` (bitmap fonts).

## Core techniques (the actual TUI engineering)

### 1. BSP dock tree with path addressing — `src/plugins/pane-manager/dock-tree.ts`
Layout is a binary tree: `DockLayoutNode = {kind:"pane", instanceId}` or `{kind:"split", axis, ratio, first, second}`. Every leaf is addressed by a `path: Array<0|1>` (0=first, 1=second branch). All mutation is pure & immutable:
- `getNodeAtPath`, `replaceNodeAtPath`, `removeNodeAtPath` (removing a leaf collapses its parent split — `if (!first) return node.second`).
- `buildSplitAroundNode(existing, instanceId, position)` wraps a node in a new split, choosing axis from position (left/right -> horizontal, above/below -> vertical) and ordering first/second.
- `collectDockGeometry` recursively converts the tree + a `LayoutBounds` into concrete pixel/cell rects for leaves *and* dividers in one pass. `resolveSplitSizes` enforces `MIN_PANE_WIDTH=20` / `MIN_DOCKED_HEIGHT=5`, with two modes: integer/cell math (terminal) vs `precise` fractional math (`precise` flag for the desktop renderer where divider is 0.5px-centered). `reserveDividerGutters` subtracts a divider cell so panes don't overlap the gutter in cell mode.
- `getDockResizeTargets(layout, instanceId, ...)`: given a leaf path, find all ancestor dividers (`isPathPrefix`) and tag which branch the leaf is on — that's how a keyboard "grow my pane" command knows which split ratios to nudge.

### 2. Drag-to-dock + drop simulation — `src/plugins/pane-manager/docking.ts`
- `applyDrop(layout, draggedId, dropTarget)` handles frame edges, leaf positions (12 `LeafDropPosition`s incl. corners, normalized to top/bottom/left/right/center), and center = `swapPanes`.
- `swapPanes` handles all combinations of docked<->docked, floating<->floating, docked<->floating (transferring rect ownership).
- `simulateDrop` returns `{layout, previewRect}` so the drag overlay can preview the post-drop rectangle without committing.
- **Placement memory**: a pane remembers where it was docked (`placementMemory.docked` = position + path + anchor instance id) so re-docking after floating restores its old spot (`dockPane`).

### 3. "Gridlock" — inferring a clean tree from arbitrary rects — `src/plugins/pane-manager/gridlock-inference.ts`
The hard/clever part. After free-form dragging you can have messy overlapping/floating rects; `gridlockAllPanes` flattens *all* docked+floating rects and runs `inferDockTreeFromRects`, a recursive guillotine-cut solver:
- For a candidate axis, gather all rect edges as candidate cut lines; for each cut, partition rects into `first`/`second` (a rect straddling the cut invalidates that cut, `tolerance=1`).
- Score each valid cut by `balance*10 + centerBias` (prefer even splits near center), pick the min.
- Recurse on each half; fall back to `buildGridDockTree` (alternating-axis balanced split of sorted ids) when no clean guillotine cut exists.

### 4. Phased keyboard dispatch — `src/renderers/opentui/input-host.tsx` + `src/react/input.ts`
A single `useKeyboard` handler fans out to a registry of `useShortcut(handler, {phase, enabled, allowEditable, scope})` subscribers. Dispatch runs three phases in order: `before` -> `normal` -> `after`, where `after` is skipped if a prior handler called `preventDefault`/`stopPropagation`. Within a phase, handlers run in registration order (`nextShortcutOrder`), and `event.propagationStopped` short-circuits. Handlers are stored as refs (`handlerRef.current`) so re-subscription isn't needed every render; `useLayoutEffect` only re-runs on phase/scope change. `shouldDeliverShortcut` swallows bare keys when an editable field is focused (`targetEditable`) unless the chord has ctrl/meta/super — this is how single-letter shortcuts (`q`, `r`) coexist with text inputs.

Global shortcuts (`src/app/global-shortcuts.ts`) register in the `before` phase: clipboard (copy/paste via OSC52), Ctrl+P / Cmd+K command bar, backtick = ticker search, Ctrl+1..9 = switch layout, Tab/Shift+Tab = cycle pane focus, then fall through to plugin-registered shortcuts matched on `{key,ctrl,shift}`.

### 5. Virtualized data table — `src/components/ui/data-table/opentui/`
- `resolveDataTableVisibleWindow` (`model.ts`) computes `[startIndex,endIndex]` from `scrollTop`, measured `viewport.height`, and `overscan` (default 3), slicing `items` to only-rendered rows. It reads `scrollRef.current.scrollTop` directly off the native ScrollBox renderable rather than mirroring it in React state, and bumps a `scrollVersion` counter on scroll to recompute.
- `resolveDataTableScrollTop` implements scroll-to-index with `center`/`nearest` alignment and clamps to `maxTop = itemCount - visibleHeight`.
- Column layout (`src/components/ui/table-layout.ts`): `getTableWidth` sums column widths + per-column gutter; `expandTableColumns` distributes slack to the single `flexGrow` column; `buildTableGridTemplateColumns` emits CSS `minmax()` grid templates for the *web* renderer using a `var(--cell-w)` unit — same column model, two backends. `useMeasuredTableContentWidth` measures the real viewport via `queueMicrotask` after layout.

### 6. Pixel charts via Kitty graphics — `src/components/chart/native/`
The standout terminal-images technique. Charts are rasterized to an RGBA bitmap then blitted with the Kitty protocol; a braille renderer is the fallback.
- `renderer-selection.ts`: `resolveChartRendererState("auto"|"kitty"|"braille", kittySupported, resolution)` decides kitty vs braille. Support is probed once (`kitty/support.ts`, `buildKittyGraphicsQuery`) and cached on the renderer.
- `raster/price-chart.ts` + `raster/primitives.ts`: hand-rolled software rasterizer drawing into a `Uint8Array` RGBA buffer — `drawLine` (with width/AA), `drawAreaFill`, candle bodies/wicks, grid, session-background spans, glow passes (draw the line twice: thick low-alpha glow + thin opaque line). Projection helpers `projectX/projectY/projectChartX` map data domain -> pixels.
- `kitty/protocol.ts`: `encodeKittyTransmitRgba` deflates the RGBA (`o=z`), base64-encodes, and chunks into `\x1b_G...\x1b\\` APC sequences with `m=1` on all but the last (`f=32` = 32-bit RGBA, `i=` image id). `encodeKittyPlacement` positions the image at a cell with `\x1b[s\x1b[row;colH ... \x1b[u` (save/restore cursor) and supports source-pixel cropping (`x,y,w,h`) + cell span (`c,r`) + z-index.
- `chart-rasterizer.computeNativePlacement` maps a *clipped* visible cell rect back into a source pixel crop (so a chart scrolled half-off-screen only uploads/places the visible pixels). The surface lifecycle is driven by `registerLifecyclePass`/`onLifecyclePass` hooks on the renderable so placements re-sync when geometry changes, and `hashBitmap` (FNV-1a) makes a cache key to avoid re-uploading unchanged bitmaps.

### 7. ASCII bitmap fonts — `src/ui/ascii-font.ts`
Hand-authored 2-row half-block fonts (`▄▀█` etc.) keyed per glyph for headers/wordmarks — rendered through the host's `AsciiText`.

## Code patterns worth stealing

Immutable tree edit by binary path:
```ts
function replaceNodeAtPath(node, path, replacement) {
  if (path.length === 0) return replacement;
  if (node.kind !== "split") return node;
  const [head, ...rest] = path;
  return head === 0
    ? { ...node, first:  replaceNodeAtPath(node.first,  rest, replacement) }
    : { ...node, second: replaceNodeAtPath(node.second, rest, replacement) };
}
// removeNodeAtPath collapses the parent: if a branch becomes empty, return its sibling.
```

Phased, ref-based shortcut registry (single keyboard listener, ordered + cancelable):
```ts
for (const phase of ["before","normal","after"] as const) {
  if (phase === "after" && (event.defaultPrevented || event.propagationStopped)) return;
  for (const e of shortcuts) {
    if (e.phase !== phase || !e.enabledRef.current) continue;
    if (!shouldDeliverShortcut(event, e.allowEditableRef.current)) continue;
    e.handlerRef.current(event);
    if (event.propagationStopped) return;
  }
}
```

Single-axis renderer-agnostic capability gate (terminal vs desktop) instead of branching components:
```ts
const { nativePaneChrome, precisePointer, cellHeightPx } = useUiCapabilities();
const dockGeometryOptions = nativePaneChrome ? { precise: true } : { reserveDividerGutters: true };
// pane chrome / mouse handlers attach only when !nativePaneChrome
```

Kitty RGBA upload (compress + chunk APC):
```ts
const compressed = deflateSync(Buffer.from(rgba));
const chunks = chunkBase64(compressed.toString("base64"), 4096);
chunks.map((c,i) => `\x1b_G${i===0 ? "a=t,f=32,t=d,o=z,s=W,v=H,i=ID," : ""}m=${i<last?1:0};${c}\x1b\\`);
```

Virtualization reading scroll state off the native renderable (avoids React state churn):
```ts
const scrollTop = scrollRef.current?.scrollTop ?? 0;       // not useState
const { startIndex, endIndex } = resolveVisibleWindow({ scrollTop, overscan, viewportHeight });
// onScroll: setScrollVersion(v=>v+1); nativeRenderer.requestRender();
```

## Gotchas / non-obvious decisions
- **They patch opentui** (`patches/@opentui%2Fcore@0.1.90.patch`): the bundled `MouseParser` is rewritten to (a) project pixel mouse coords to cells (`projectPixelToCell` — needed for fractional/pixel pointer hosts) and (b) decode SGR *extended* mouse buttons (`rawButtonCode & 128` -> buttons 8–11) which upstream dropped. If you build precise-pointer or extra-button mouse UX on opentui you will hit the same gaps.
- **Resolution events are bridged manually** (`installResolutionEventBridge`): opentui doesn't emit a pixel-`resolution` change event, so they `prependInputHandler` + `on("resize")` and `queueMicrotask` an `emitIfChanged` comparing the renderer's `resolution`.
- **Two geometry modes share one tree**: cell-integer math vs `precise` fractional math diverge in `resolveSplitSizes`/divider centering. Mixing them produces off-by-one pane overlaps — `reserveDividerGutters` is only valid in cell mode (`&& !precise`).
- **Kitty placements must be re-synced on geometry change**, not just on data change — done via `onLifecyclePass` on the renderable; bitmaps are content-hashed (FNV-1a) so unchanged data isn't re-uploaded, and only the visible crop is placed.
- **Single-letter shortcuts vs text input**: `shouldDeliverShortcut` is the linchpin; bare keys are suppressed when `targetEditable` unless modified. Forget this and typing `q` in a search box exits the app.
- **Layout persistence** is debounced through `scheduleConfigSave` and there's an undo stack (`PUSH_LAYOUT_HISTORY` before each mutation).
- `state` in `AppInner` is rebuilt as a memoized merge of `stateRef.current` + individually-selected slices — a deliberate pattern to keep a full-state object available to imperative callbacks while still getting fine-grained selector re-renders.

## Relevance (which advanced-TUI topics this teaches)
- **layout**: gold-standard BSP/guillotine tiling window manager with path-addressed immutable trees, drag-dock, swap, gridlock inference, keyboard resize.
- **reconciler-component-models**: capability-gated host abstraction letting one React tree drive both a terminal (opentui) and desktop (electrobun) backend.
- **input-keyboard-mouse**: phased, cancelable, scoped shortcut dispatch over a single listener; editable-aware delivery; patched SGR/extended-button + pixel->cell mouse parsing.
- **terminal-images**: Kitty graphics protocol end-to-end (transmit w/ zlib + chunked APC, cropped placements, content-hash caching, capability probe) with a braille fallback.
- **rendering-pipeline**: software RGBA rasterizer (lines, AA, area fill, glow), bitmap diffing/caching, lifecycle-pass-driven surface re-sync, `requestRender` batching.
- **widgets-rich-content**: virtualized data table (windowing + overscan + scroll-to-index alignment), flex column layout shared across cell-grid and CSS-grid backends, ASCII half-block fonts.
- **ansi-escapes**: OSC52 clipboard, APC graphics sequences, save/restore-cursor positioning.
- **app-architecture**: plugin registry contributing panes/shortcuts/menus; runtime split into focused hooks; debounced+undoable layout persistence; CLI dispatch before UI mount.
