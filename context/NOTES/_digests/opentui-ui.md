# opentui-ui

## What it is (1-2 lines)
A monorepo component library built on `@opentui/core` (the SST OpenTUI renderer). It provides a framework-agnostic core (Badge, Checkbox), a Stitches-inspired type-safe styling engine (`styled()` with slots + variants + state selectors), React/Solid bindings, and two higher-level widget systems: Sonner-style toasts and an async dialog/prompt system.

## Architecture (how the pieces fit; key files with paths)
Monorepo, pnpm workspace, ESM, tsdown bundler, Biome, no test framework.

Packages (`packages/*/src`):
- `core/` — framework-agnostic renderables. `StyledRenderable` base class (`styled-renderable.ts`), plus `badge/` and `checkbox/`. Each component folder is split into `types.ts`, `constants.ts`, `meta.ts` (slot/state metadata), `<name>.ts` (the Renderable subclass), `index.ts`.
- `styles/` — the styling engine. `styled.ts` (factory + variant/prop splitting), `resolve.ts` (definition-time config processing + runtime style resolution), `merge.ts` (config composition), `symbols.ts` (branding symbols + state-selector prefix), `types.ts`.
- `react/`, `solid/` — thin framework wrappers. `styled.ts` wraps the agnostic `createStyled` and bridges to the renderable's `styleResolver` prop. Mirrors core's folder structure.
- `dialog/` — `manager.ts` (DialogManager: state + async prompt/confirm/alert/choice), `renderables/dialog-container.ts` (renders dialogs + backdrop, handles ESC/backdrop click + focus save/restore), `renderables/backdrop.ts` (opacity blending), `renderables/dialog.ts`.
- `toast/` — `state.ts` (Observer pub/sub singleton, Sonner-compatible `toast.*` API including `toast.promise`), `renderables/toaster.ts` (container: subscribes, positions, stacks), `renderables/toast.ts` (single toast: timer, pause/resume, spinner animation).
- `utils/` — `opacity.ts` (CSS-like opacity → 0-255), `padding.ts`, `styles.ts`.

Two distinct rendering strategies coexist:
1. **Leaf renderables (Badge, Checkbox)** extend `StyledRenderable extends Renderable` and draw directly into an `OptimizedBuffer` in `renderSelf()` using `buffer.fillRect` / `buffer.drawText`.
2. **Composite renderables (Toast, Dialog, Toaster)** extend `BoxRenderable` and build a subtree of child renderables (`TextRenderable`, nested `BoxRenderable`) using flexbox layout props — they never touch the buffer directly.

## Core techniques (the actual TUI engineering)

### The render contract from @opentui/core
- A `Renderable` is constructed with `(ctx: RenderContext, options)`. `ctx` exposes `width`, `height`, `keyInput`, `currentFocusedRenderable`, `root`.
- Components mutate state via setters, then call `this.requestRender()` to mark dirty — there is no manual frame loop. The engine batches and re-renders.
- Direct drawing happens in `protected renderSelf(buffer: OptimizedBuffer, deltaTime: number)`. See `core/src/badge/badge.ts:86` and `core/src/checkbox/checkbox.ts:193`.
- Layout for composite components is **flexbox** (`flexDirection`, `flexGrow`, `flexShrink`, `gap`, `alignItems`, `justifyContent`, `minWidth/maxWidth`) supplied as constructor options to `BoxRenderable` — Yoga-style layout handled by core. Leaf components instead compute their own `width`/`height` from content (e.g. checkbox `minWidth = maxSymbolLength + gap + label.length`, `checkbox.ts:67`).

### Color/alpha as the cheap compositing primitive
Colors are parsed once with `parseColor()` into `RGBA`. Rendering guards on alpha: `if (boxBg.a > 0) buffer.fillRect(...)` and `if (markFg.a > 0) buffer.drawText(...)` (`checkbox.ts:206-216`). `"transparent"` → alpha 0 → skip the draw entirely. This is how the library does "no background" without a special code path.

Backdrop opacity (`dialog/src/renderables/backdrop.ts:53`): parse the color, then set `rgba.a = opacity / 255`. Opacity normalization (`utils/src/utils/opacity.ts`) accepts CSS-like `0-1` floats or `"50%"` strings and maps to a 0-255 integer, throwing on out-of-range numbers.

### Parsed-color caching keyed by a string
Checkbox avoids re-parsing colors every frame: it builds a cache key from the resolved style strings (`getColorCacheKey()` → `"bg|fg|labelFg"`) and only re-runs `parseColor` when the key changes (`checkbox.ts:115-132`). Setters that change styling invalidate by nulling `_parsedColors` and `_colorCacheKey`.

### Width re-sync tied to layout-affecting style
Because gap/padding live in styles (which can change at runtime), leaf components re-derive their width during render: `syncWidthWithCurrentStyles()` is called at the top of `renderSelf` and only writes `this.width` when the computed value differs, to avoid spurious layout invalidation (`checkbox.ts:142`). Label/symbol setters call `recalculateWidth()`.

### The styling engine: slots + variants + state selectors (Stitches-for-TUI)
Two-phase design for performance:
- **Definition time** (`processStyledConfig`, `resolve.ts:24`): normalize config and pre-compute `variantNameSet = new Set(Object.keys(variants))` for O(1) prop splitting.
- **Runtime** (`resolveStyles`, `resolve.ts:69`): layered resolution, later layers win:
  1. base → 2. variant styles → 3. compound variants → 4. inline styles.
  State selectors are re-applied **at each layer** so a variant's `_checked` can override base's `_checked` without re-declaring everything.
- State selectors are keys prefixed with `_` (`STATE_SELECTOR_PREFIX`, `symbols.ts:47`), e.g. `_checked`, `_focused`, `_disabled`. `flattenSlotStyle` (`resolve.ts:225`) first copies all non-`_` props, then iterates `stateKeys` **in declaration order** and merges the selector block for each active state — declaration order defines precedence.
- Mutation-based accumulator: layers are merged into one `result` object rather than spreading intermediate objects each layer (explicit perf note at `resolve.ts:128`).

### Component metadata as the type/inference carrier
Each component exports `*_META` (`checkbox/meta.ts`) with `slots`, `slotStyleMap` (an empty object cast to a type — a pure type carrier), and `stateKeys` (`["checked","focused","disabled"] as const`). The component class attaches this under the branded symbol `$$OtuiComponentMeta`. `createStyled` reads it to infer slot names + state keys with zero explicit generics (`styled.ts:127`). There's a compile-time assertion that stateKeys match the State interface (`meta.ts:49-56`).

### Composition via branding symbols
`styled()` on an already-styled component is detected via `$$StyledComponent`/`$$StyledConfig` symbols (`styled.ts:189`); it pulls the stored processed config and deep-merges through `mergeStyledConfig` (`merge.ts:219`): base = deep merge, variants merged by name, defaultVariants shallow-merged (override wins), compoundVariants appended.

### Framework bridge
`react/src/styled.ts` does the agnostic→React glue: `splitVariantProps` separates variant props from forward props using the precomputed Set; variant values are extracted as primitives into `variantDeps` so `useMemo` recomputes the style resolver only when an actual variant value changes (`styled.ts:168-201`); the resolver is then passed to the base component as the `styleResolver` prop. Inline `styles` use reference equality (users must `useMemo`).

### Pub/sub state singletons drive imperative renderables
Both toast and dialog use the same shape: a state object holds an array + a `Set`/array of subscribers; the container renderable subscribes in its constructor and reconciles a `Map<id, Renderable>` against published events.
- Toast `Observer` (`toast/src/state.ts:33`) is a global singleton; `toast.success(...)` etc. mutate `toasts` and `publish()`. Dismissal pushes a `{ id, dismiss: true }` event on a `setTimeout(0)` ("requestAnimationFrame equivalent for terminal", `state.ts:159`).
- `ToasterRenderable` (`toast/src/renderables/toaster.ts`) subscribes; on add it enforces stacking mode (`single` clears all; `stack` evicts oldest beyond `visibleToasts`), and inserts at index 0 vs end depending on top/bottom position so visual stack order is correct (`toaster.ts:229-237`).

### Toast lifecycle: timers, pause/resume, spinner
`ToastRenderable` (`toast/src/renderables/toast.ts`) manages an auto-dismiss `setTimeout`. Hover (`onMouseOver`/`onMouseOut`) pauses/resumes by computing elapsed time and decrementing `_remainingTime` (`toast.ts:297-325`). Loading toasts run a `setInterval` spinner that mutates `_iconText.content` and calls `requestRender()` each frame (`toast.ts:330-343`). `updateToast` mutates the existing subtree in place (changing type, border color, icon, restarting/stopping spinner) instead of recreating — and there's a `TIME_BEFORE_UNMOUNT` delay before actual removal to allow exit effects.

### `toast.promise` state machine
`state.ts:290` chains `.then/.catch/.finally`, treating non-ok `Response` and `Error` instances as failures, supports function-valued success/error/description messages, and returns an `unwrap()` that re-resolves/rejects with the captured result.

### Dialog: async prompts + focus management
`DialogManager.showAsyncDialog` (`dialog/src/manager.ts:346`) wraps each prompt/confirm/alert/choice in a `Promise`, pre-generates the dialog id, and uses a `resolved` boolean guard so `onClose` (which always fires) can't double-resolve. A `fallback`/`defaultDismissValue` resolves ESC/backdrop dismissals. Focus is saved on first open (`ctx.currentFocusedRenderable`, blurred) and restored on last close, **deferred by `setTimeout(…, 1)`** to ensure the dialog is removed from the render tree before refocus (`manager.ts:118-137`). `DialogContainerRenderable` listens on `ctx.keyInput.on("keypress")` for ESC, honoring per-dialog `closeOnEscape` over container default and calling `evt.preventDefault()`.

## Code patterns worth stealing

Alpha-gated drawing (no special "transparent" path):
```ts
const bg = parseColor(style.backgroundColor ?? "transparent"); // a===0 if transparent
if (bg.a > 0) buffer.fillRect(x, y, w, h, bg);
if (fg.a > 0) buffer.drawText(text, x, y, fg, bg);
```

Re-parse colors only when the style string changes:
```ts
getColorCacheKey() { return `${bg}|${fg}|${labelFg}`; }
getParsedColors() {
  const key = this.getColorCacheKey();
  if (!this._parsed || this._key !== key) { this._parsed = parse(); this._key = key; }
  return this._parsed!;
}
```

Metadata-as-type-carrier for zero-generic inference:
```ts
export const CHECKBOX_META = {
  slots: CHECKBOX_SLOTS,
  slotStyleMap: {} as CheckboxSlotStyleMap, // runtime empty, carries the type
  stateKeys: ["checked","focused","disabled"] as const,
} as const;
// component[$$OtuiComponentMeta] = CHECKBOX_META;  styled() reads it for inference
```

Layered style resolution with per-layer state-selector flattening (`resolve.ts`): base → variants → compound → inline, each flattened against active state in `stateKeys` declaration order, mutating one accumulator.

Pub/sub singleton + Map reconciliation in the container:
```ts
this._unsub = State.subscribe((evt) => {
  if (isDismiss(evt)) this.removeToast(evt.id);
  else this.addOrUpdateToast(evt);    // existing? update in place; else create child
});
```

Promise-wrapped async dialog with double-resolve guard:
```ts
return new Promise<T>((resolve) => {
  let resolved = false;
  const safeResolve = (v: T) => { if (resolved) return; resolved = true; resolve(v); this.close(id); };
  this.show({ ...opts, id, onClose: () => safeResolve(fallback ?? defaultDismiss) });
});
```

Pause/resume a setTimeout by tracking remaining time:
```ts
pause() { clearTimeout(h); remaining -= Date.now() - startTime; }
resume() { startTime = Date.now(); h = setTimeout(fire, remaining); }
```

## Gotchas / non-obvious decisions
- **Controlled vs uncontrolled switches at runtime.** Checkbox flips to controlled mode the first time `checked` is set, because Solid spreads props *after* construction so `_isControlled` would be wrong otherwise (`checkbox.ts:224-240`).
- **State-selector precedence is declaration order**, not specificity — reorder `stateKeys` to change which wins.
- **`mergeStyle` skips `undefined` overrides** (preserves base) but lets any defined value win — important for partial overrides.
- **Width is recomputed during render** for leaf components, so layout-affecting style (`gap`, `paddingX`) can change without an explicit resize call; but it only writes when changed to avoid layout thrash.
- **Dismiss/focus-restore deferral via `setTimeout(0/1)`** is the terminal's stand-in for rAF / next-tick render flushing.
- **Dialog updates aren't in-place** — `addOrUpdateDialog` removes and recreates (explicit `// TODO`, `dialog-container.ts:134`). Toasts *do* update in place.
- **`destroy()` discipline:** every renderable clears timers/intervals, unsubscribes, nulls callbacks, and calls `super.destroy()`; containers `destroyRecursively()` children. Memory leaks in a long-lived TUI come from forgotten `setInterval`/subscriptions.
- **No tests** — TypeScript (verbatimModuleSyntax, noUncheckedIndexedAccess) is the only safety net.
- `slotStyleMap: {} as Type` is intentionally an empty runtime object; only its type matters.

## Relevance (which advanced-TUI topics this teaches)
- **reconciler-component-models** — headless-core + framework-binding split, branded-symbol metadata for type inference and composition, controlled/uncontrolled state.
- **rendering-pipeline** — `requestRender` dirty model, `renderSelf(buffer, deltaTime)`, parsed-color caching, alpha-gated draws.
- **layout** — flexbox via BoxRenderable vs manual content-based sizing for leaf renderables; runtime width re-sync.
- **widgets-rich-content** — full toast (timer/pause/spinner/promise) and dialog (async prompt/confirm/alert/choice, backdrop, focus trap) widget construction.
- **input-keyboard-mouse** — keypress handling (`handleKeyPress`, `ctx.keyInput.on`), ESC handling with preventDefault, mouse hover/up callbacks, focus save/restore.
- **app-architecture** — pub/sub singletons + Map reconciliation, Sonner-compatible imperative API surface, lifecycle/cleanup discipline.
