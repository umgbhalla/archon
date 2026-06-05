# termcast

## What it is (1-2 lines)
A from-scratch reimplementation of the `@raycast/api` extension API for the terminal: same component/hook surface (`List`, `Detail`, `Form`, `ActionPanel`, `Toast`, navigation, OAuth, storage), rendered with React on top of `@opentui/core`/`@opentui/react` (a Yoga-flexbox + ANSI terminal renderer). Termcast does NOT build its own reconciler — it consumes opentui's React reconciler — so its "engineering" is really *advanced compound-component design, focus/overlay orchestration, and custom opentui Renderables* layered on top.

## Architecture (how the pieces fit; key files with paths)
Reconciler ownership matters here: opentui owns the React host-config and the paint loop. Termcast is a React component library + a zustand global store + a few custom `Renderable` subclasses.

- **Entry / bootstrap**: `termcast/src/extensions/dev.tsx:241` — `createCliRenderer()` from `@opentui/core`, then `createRoot(renderer).render(<App/>)` from `@opentui/react`. `App` wraps the extension command in `<TermcastProvider>`. A `react-refresh-init` import must run *first* for hot reload.
- **Root provider tree**: `termcast/src/internal/providers.tsx` — `TermcastProvider` nests `ErrorBoundary > Suspense > PersistQueryClientProvider (TanStack Query) > theme box > DialogProvider > NavigationProvider(overlay=<DialogOverlay/>) > children`. Order is load-bearing: NavigationProvider is innermost so parent providers stay mounted across navigation.
- **Global state**: `termcast/src/state.tsx` — a single zustand `useStore`. Holds `navigationStack`, `dialogStack`, `toast`, `showActionsDialog`, `actionsPortalTarget`, `registeredActionShortcuts`, `activeSearchInputRef`, theme name, vim mode. The project convention (CLAUDE.md) forbids setter methods — always `useStore.setState(...)`, and selectors must return scalars to avoid render loops.
- **Navigation**: `termcast/src/internal/navigation.tsx` — push/replace/pop/popToRoot mutate `navigationStack` inside `startTransition`. The provider renders only the *top* stack element, re-keyed by `stack.length` so a pushed view fully remounts. Note the documented limitation: pushed elements' props are snapshotted (not reactive) — pass a zustand store down instead.
- **Dialogs/overlays**: `termcast/src/internal/dialog.tsx` — `dialogStack` + an always-mounted `DialogOverlay` portal target. Dialogs are flex-positioned boxes (`center`/`top-right`/`bottom-right`), not real windows.
- **Descendants engine**: `termcast/src/descendants.tsx` — the core mechanism behind every compound component (List/Form/Dropdown/ActionPanel). See below.
- **Components**: `termcast/src/components/*` — `list.tsx` (2800 lines, the reference implementation), `actions.tsx`, `detail.tsx`, `form/*`, plus chart Renderables (`graph.tsx`, `bar-graph.tsx`, `heatmap.tsx`, `candle-chart.tsx`, `histogram.tsx`).
- **opentui re-export**: `termcast/src/opentui.tsx` just re-exports `@opentui/core` + `@opentui/react`.

## Core techniques (the actual TUI engineering)

### 1. The descendants pattern (dynamic child indexing without prop drilling)
`termcast/src/descendants.tsx`. `createDescendants<T>()` returns a context + hooks. Children call `useDescendant(props)`; in a `useLayoutEffect` they call `getIndexForId(id, props)` to claim a monotonically increasing index (`descendants.tsx:68`). The provider **resets the index counter on every render** (`descendants.tsx:34` calls `props.value.reset()` during render) so re-ordering/filtering recomputes indices from scratch.

Key constraints (encoded in code + CLAUDE.md):
- `map.current` is **non-reactive and cleared every render** — only safe to read inside effects or event handlers (`useKeyboard`), never during render/`useMemo`.
- Use `descendantId` (stable) for per-item state, `index` (positional) for navigation.
- Opt-in reactivity via `useDescendantsRerender()` → `useSyncExternalStore` over a `committedMap` snapshot. A `versionRef` bumps on every commit (`descendants.tsx:94`) so subscribers re-render even when only *props* change (e.g. an item's `detail`), not just structural add/remove.
- The context value is intentionally **not memoized** (`descendants.tsx:103`) so it changes identity every render, defeating any `React.memo` on children — they must re-render to re-register in correct order.

### 2. Filtering by rendering null, not by slicing arrays
Because `map.current` can't be read in render, filtering works inverted: the parent broadcasts the search query via context; each `Item` reads it and returns `null` if it doesn't match (`descendants.tsx:229`, real impl in `list.tsx`). The parent never builds the visible list during render — it reads the sorted/filtered descendants map only inside keyboard handlers (`move()` at `list.tsx:1419`).

### 3. Selection + scroll without a virtual list
`list.tsx` keeps `selectedIndex` in `useState`, persisted into the navigation stack item (`persistSelectedIndexInCurrentNavigationItem`, `list.tsx:1185`) so selection survives push/pop. `move(direction)` reads visible items from `map.current`, finds current position, advances, and calls `scrollToItemIfNeeded` (`list.tsx:1324`). Scrolling uses opentui's `ScrollBoxRenderable`: it reads `scrollBox.content.y`, `scrollTop`, `viewport.height`, and the item's `elementRef.y`/`.height` (each item stores its own `BoxRenderable` ref in its descendant props) to do classic "scroll only when item leaves viewport, align top going down / bottom going up." Movement is wrapped in `flushSync` to avoid a stale intermediate frame.

### 4. Custom opentui Renderables for charts (the real low-level TUI work)
`termcast/src/components/graph.tsx` — `GraphPlotRenderable extends Renderable`, registered with `extend({'graph-plot': ...})` so it's usable as `<graph-plot>` in JSX, with a `declare module '@opentui/react'` augmentation for types. It draws directly into the `OptimizedBuffer` via `buffer.setCell(x, y, char, fg, bg)` / `buffer.drawText`.
- **Braille sub-pixel rendering**: braille block U+2800–U+28FF gives 2×4 dots per cell. A `BRAILLE_BITS[subRow][subCol]` table (`graph.tsx:55`) maps dot positions to bits; the cell char is `String.fromCharCode(0x2800 + bits)`. Effective resolution = `W*2 × H*4` virtual pixels.
- **Bresenham line rasterization** between data points into a per-column top-Y array (`computeLineYPerColumn`, `graph.tsx:202`), then fill-down to make an area chart.
- **Block/quadrant mode** (`▌ ▘ ▖`, `graph.tsx:48`) gives 2× vertical sub-rows and uses left-half chars to create visible gaps between bars.
- Setters call `this.requestRender()` to mark dirty; `renderSelf(buffer)` is opentui's per-frame hook. Axis layout, y-tick labels, and x-label overlap-skipping are computed in `computeLayout`/`drawAxes`.

### 5. Focus as context, not OS focus
`termcast/src/internal/focus-context.tsx` — `<InFocus inFocus={bool}>` provides a boolean; `useIsInFocus()` reads it. **Every** `useKeyboard` handler guards with `if (!inFocus) return`. `DialogProvider` sets children `inFocus={!dialogStack.length && !showActionsDialog}` so background content stops responding to keys while an overlay is up. This is the entire modality model — there is no real input capture, just cooperative gating. `useKeyboard` also has `evt.stopPropagation()`; handlers fire in `useEffect` registration order (children before parents, siblings in JSX order).

### 6. Offscreen registration + portal-back for actions
`termcast/src/internal/offscreen.tsx` + `components/actions.tsx`. `<ActionPanel>` is mounted **offscreen** (`<Offscreen>` sets a context flag; child renderables return null for visual output) so its `Action` descendants register early — this lets the footer show the first action's title and lets shortcuts be globally registered, all *before* the user opens the panel. When `showActionsDialog` becomes true, the panel `createPortal`s its real `Dropdown` into `actionsPortalTarget` (a box ref captured by `DialogOverlay`), wrapped in `<Onscreen>` to reset the offscreen flag. Crucially the portal keeps the original React context (navigation, form submit) even though it paints in the overlay.

### 7. Global keyboard shortcuts via a registry
`ActionPanel`'s `useLayoutEffect` (`actions.tsx:809`) scans its action descendants and writes `{shortcut, execute}[]` into `useStore.registeredActionShortcuts`. List/Detail/Form keyboard handlers consult this registry. It diffs shortcut keys to avoid re-renders, and *mutates* `execute` closures in place when only the function identity changed — keeping latest closures without triggering a store update.

### 8. ANSI / terminal escape integration
`providers.tsx` does direct escape work via the renderer:
- **OSC 11** (`\x1b]11;<color>\x07`) to set the terminal background to match the theme, written through `renderer.realStdoutWrite` to bypass opentui's stdout interception (`providers.tsx:179`).
- An input pre-handler (`renderer.prependInputHandler`) remaps the kitty-protocol Cmd+Backspace sequence `\x1b[127;9u` to Ctrl+U (`\x15`) so opentui's textarea delete-to-line-start binding fires (`providers.tsx:159`).
- Cmd+C copies the renderer's text selection and clears it (`providers.tsx:206`).
- Ctrl+D toggles opentui's debug overlay + console.
Markdown (`components/markdown.tsx`) wraps opentui's `<markdown>` with a custom `renderNode` (OSC 8 hyperlinks, borderless tables, syntax highlight).

## Code patterns worth stealing

Custom renderable registered into the JSX namespace:
```tsx
class GraphPlotRenderable extends Renderable {
  set series(v) { this._series = v; this.requestRender() }   // setter = mark dirty
  protected renderSelf(buffer: OptimizedBuffer) {
    buffer.setCell(x, y, String.fromCharCode(0x2800 + bits), fg, transparent)
  }
}
extend({ 'graph-plot': GraphPlotRenderable })
declare module '@opentui/react' {
  interface OpenTUIComponents { 'graph-plot': typeof GraphPlotRenderable }
}
```

Descendant child that filters by self-rendering null (read query from context, never from parent's map):
```tsx
function Item({ title }) {
  const { index, descendantId } = useDescendant({ title })
  const query = useContext(SearchContext)
  if (!title.toLowerCase().includes(query)) return null
  return <text>{title}</text>
}
```

Reading the descendant map ONLY in an event handler (never render):
```tsx
useKeyboard((evt) => {
  if (!inFocus) return
  const items = Object.values(map.current)
    .filter(i => i.index !== -1 && i.props?.visible !== false)
    .sort((a, b) => a.index - b.index)
  // navigate / scroll here
})
```

Cooperative focus gating + overlay:
```tsx
<InFocus inFocus={!dialogStack.length && !showActionsDialog}>{children}</InFocus>
// every handler: useKeyboard(e => { if (!inFocus) return; ... })
```

Selection move with no-flash + viewport-aware scroll:
```tsx
flushSync(() => setSelectedIndex(next.index))   // avoid stale frame
if (itemBottom > viewportBottom) scrollBox.scrollTo(Math.max(0, itemTop))
```

## Gotchas / non-obvious decisions
- **No custom reconciler.** All host primitives (`<box>`, `<text>`, `<scrollbox>`, `<markdown>`) and the diff/paint loop belong to opentui; termcast's value is the API port + patterns.
- **`map.current` is cleared every render** — reading it during render returns stale/empty data. This is the single most repeated footgun (CLAUDE.md devotes a whole section).
- **useLayoutEffect vs useEffect is a flash-avoidance contract**: any effect that sets *visible* state (selection, detail, dialog) MUST be `useLayoutEffect`, or you get a one-frame flash (`docs/flash-debugging.md`).
- **Colored boxes are invisible in text snapshots**: opentui only reports cells with text, so backgroundColor-only boxes must be filled with `█` matching-color chars + `position="absolute"` to show up in tests (and to not drive flex height).
- **Navigation push snapshots props**: pushed views don't react to parent state; pass a zustand store, not props.
- **`flushSync` + separate setState is banned** — use one `useLayoutEffect` to batch before paint.
- **Cmd/super modifier is unreachable in a normal terminal** (parent terminal eats it); only works in the bundled WezTerm app where `SendKey` forwards it.
- **ESC is overloaded and stateful**: clears search text → pops nav → exits process (but is a no-op at root in app mode, since `renderer.destroy()` would kill the whole app).
- Selection state keyed by **`descendantId` not `index`**, because indices are reused across filtering.

## Relevance (which advanced-TUI topics this teaches)
- **reconciler-component-models**: the descendants pattern is a complete, reusable solution for compound components on top of a React reconciler you don't own; index reset-on-render, `useSyncExternalStore` opt-in reactivity, non-memoized context to bypass `React.memo`.
- **rendering-pipeline**: custom `Renderable` subclasses, dirty-marking via setters + `requestRender()`, drawing into `OptimizedBuffer` with `setCell`/`drawText`, `useLayoutEffect`-as-no-flash discipline, `flushSync` for frame-correct selection.
- **unicode-text-width / widgets-rich-content**: braille (2×4) and quadrant/half-block sub-pixel charting, Bresenham rasterization, axis/label layout, OSC 8 hyperlink + themed markdown.
- **input-keyboard-mouse**: context-based cooperative focus model, `stopPropagation` ordering, a global shortcut registry, kitty-protocol key remapping, mouse hover-to-select + scroll-to-paginate.
- **ansi-escapes**: OSC 11 theme background sync, input pre-handlers, bypassing renderer stdout interception.
- **app-architecture**: zustand single-store with stack-based navigation + dialog stacks, portal-back-from-offscreen for action panels, TanStack Query persistence, error boundary that resets stacks.
