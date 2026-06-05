# opencode

## What it is (1-2 lines)
The TUI client for opencode (an AI coding agent), built as a **SolidJS application running on `@opentui` (opentui)** — a retained-mode terminal renderer with a JSX reconciler, flexbox layout, mouse, and Kitty-keyboard support. The TUI itself contains almost no low-level rendering: it leans on opentui for the render loop/diffing and uses SolidJS fine-grained reactivity for state, with a server-driven event stream as the source of truth.

Location: `packages/opencode/src/cli/cmd/tui/` (~29k LOC of `.ts`/`.tsx`).

## Architecture (how the pieces fit; key files with paths)
opentui is the "DOM + renderer"; SolidJS is the "framework"; opencode is the app. JSX tags like `<box>`, `<text>`, `<span>`, `<scrollbox>` are opentui `Renderable`s, reconciled by `@opentui/solid`.

- **Entry / lifecycle** — `app.tsx`
  - `tuiRendererConfig()` (app.tsx:131) builds the `CliRendererConfig`: `targetFps: 60`, `externalOutputMode: "passthrough"`, `useKittyKeyboard`, `useMouse`, `exitOnCtrlC: false`, `autoFocus: false`, console copy keybindings.
  - `tui()` (app.tsx:199) installs a win32 Ctrl-C guard, builds the keymap, registers opencode keymap layers, and sets up a `TuiLifecycle` (app.tsx:292) — a hand-rolled exit/cleanup state machine handling SIGHUP, renderer `destroy`, double-exit guards, and ordered teardown (keymap → plugin runtime → audio).
  - `mountTui()` (app.tsx:221) prewarms the terminal palette (`renderer.getPalette`) and resolves dark/light mode via `renderer.waitForThemeMode(1000)` *before* mounting, to avoid a first-paint theme flash, then calls opentui's `render(() => <tree/>, renderer)`.
  - The provider tree (app.tsx:228-289) is a deep nest of ~20 SolidJS context providers (Args, Exit, KV, Toast, Route, SDK, Project, Sync, SyncV2, Theme, Local, Dialog, Prompt history/stash/frecency, Editor). This is the app's dependency-injection backbone.
  - `App()` (app.tsx:370) is the root view: an absolute-sized `<box width/height={dimensions()}>` from `useTerminalDimensions()`, a `<Switch>` over the route type (`home` / `session`), plus plugin slots and a `StartupLoading` overlay.

- **State / event sourcing** — `context/sync.tsx` (the heart)
  - One big `createStore` (solid-js/store) holds *all* server state keyed by id: `session[]`, `message[sessionID][]`, `part[messageID][]`, `permission`, `question`, `todo`, `session_status`, `session_diff`, `lsp`, `mcp`, etc. (sync.tsx:40-108).
  - A single `event.subscribe` handler (sync.tsx:141) is a giant reducer over the server SSE event stream (`message.updated`, `message.part.delta`, `permission.asked`, `session.updated`, …) — this is event sourcing: the server emits events, the client folds them into the store.
  - `bootstrap()` (sync.tsx:407) does a **three-phase load**: blocking requests (`Promise.allSettled` → `aggregateFailures` to surface every failed endpoint, not just the first) flip status to `partial`; non-blocking requests fill in the rest and flip to `complete`. `args.continue` pulls session list into the blocking phase so it can navigate early.

- **Input / keybindings** — `keymap.tsx` + `@opentui/keymap`
  - Vim-like layered keymap: a **mode stack** (`createOpencodeModeStack`, keymap.tsx:42) implemented as a stack of `{id, mode}` with push/pop returning disposers; the top mode is published into keymap layer data, and bindings gate on `mode`.
  - `registerOpencodeKeymap` (keymap.tsx:203) wires opentui keymap addons: comma-chord bindings, **timed leader key** (`registerTimedLeader` with `leader_timeout`), escape-clears-pending-sequence, backspace-pops-sequence, key-alias expansion (enter→return), and a **managed-textarea layer** that only activates `input.*` bindings when a `TextareaRenderable` is focused (keymap.tsx:222).
  - Bindings are declared declaratively via `useBindings(() => ({ mode, enabled, bindings }))` throughout components, scoped by SolidJS lifecycle (auto-unregister on cleanup).

- **Routing** — `context/route.tsx`: a tiny `createStore<Route>` discriminated union (`home | session | plugin`); `navigate()` uses `reconcile()`. Plugins can register additional routes (`RouteMap` in app.tsx).

- **Dialogs / modals** — `ui/dialog.tsx`: a stack-based modal manager. `replace/clear/setSize`, escape/ctrl-c bindings to pop, focus save+restore (`refocus()` walks the renderable tree to re-focus after close, dialog.tsx:85), absolute-positioned overlay at `zIndex 3000` with a translucent backdrop (`RGBA.fromInts(0,0,0,150)`), and pushes a `"modal"` mode onto the keymap mode stack while open.

- **Message rendering** — `feature-plugins/system/session-v2.tsx`, `routes/session/index.tsx` (2.5k LOC): `<For>` over reversed messages inside a `<scrollbox stickyScroll stickyStart="bottom">`, with a `<Switch>` dispatching message type → component (user/assistant/tool/shell/compaction/agent-switched).

- **Custom GPU-style effect** — `component/bg-pulse-render.ts` + `bg-pulse.tsx` (the showpiece, see below).

## Core techniques (the actual TUI engineering)

**Reconciler model is SolidJS, not React.** opencode never diffs a virtual tree itself. opentui exposes intrinsic JSX elements (`box`, `text`, `span`, `scrollbox`) that map to `Renderable` instances; `@opentui/solid`'s reconciler creates/updates them, and SolidJS *fine-grained signals* mean updates touch only the exact renderable property that changed — no top-down re-render. This is why everything is `createMemo`/`createSignal` and stores rather than props.

**Store reconciliation for streaming.** The streaming-text problem (tokens arriving char-by-char) is solved with surgical store writes:
- `message.part.delta` appends to a string field in place via `produce` (sync.tsx:354): `part[field] = (existing ?? "") + delta`. Only that one text node re-renders.
- New/updated entities use **binary search + `reconcile`** to keep arrays sorted by id and patch in place: `Binary.search(arr, id, x=>x.id)` then `setStore(path, index, reconcile(next))` or `produce(draft => draft.splice(index,0,item))` (sync.tsx:148-352). `reconcile` diffs the new object against the stored one so unchanged fields don't trigger reactivity. This is the key trick for a fast streaming chat log.
- Bounded history: messages capped at 100; when exceeded the oldest message and its parts are evicted (sync.tsx:296-314).

**Sticky-bottom scroll.** Chat uses opentui's `<scrollbox stickyScroll stickyStart="bottom">` (session-v2.tsx:77) so new content keeps the viewport pinned to the bottom unless the user scrolls up — handled by opentui, not app code. Scroll speed is customizable via `CustomSpeedScroll implements ScrollAcceleration` (util/scroll.ts:4) or `MacOSScrollAccel`.

**Three-phase non-blocking bootstrap** (sync.tsx:407): blocking essentials → `status: "partial"` (UI can render) → background fetches → `status: "complete"`. `aggregateFailures` collects all rejected endpoints into one labeled error rather than letting the first rejection mask the rest.

**Per-session lazy hydration with delta-safe merge** (sync.tsx:550): `session.sync()` dedupes concurrent syncs (`syncingSessions` map), and tracks ids "touched" by live events while the fetch was in flight (`hydratingSessions`) so a slow REST response can't overwrite fresher SSE deltas — it prefers the in-store version for any id that received a live update mid-fetch (esp. for empty-text parts that would clobber streamed text).

**The background pulse effect — direct framebuffer painting** (`bg-pulse-render.ts`). This is the only place opencode bypasses the JSX layer. `GoUpsellArtRenderable extends FrameBufferRenderable` and overrides `renderSelf(buffer, deltaTime)` (bg-pulse.tsx:52). The painter writes raw RGB into `frameBuffer.buffers.fg / .bg` (Uint16Array, 4 bytes RGBA per cell) and char codes into `buffers.char`:
- It renders an animated radial "ring" pulse emanating from a centered ASCII logo, using cosine crests + exponential tails, eased with smoothstep `e*e*(3-2e)`, modulated by a precomputed per-cell distance field and edge falloff (`Float32Array`s rebuilt only on resize).
- **Half-block trick**: a single terminal cell shows two vertical pixels by using `▀` (TOP_HALF) with fg = top pixel color and bg = bottom pixel color — doubles vertical resolution. Falls back to `█` (FULL_BLOCK) when the terminal lacks truecolor (`_ctx.capabilities.rgb`).
- **Frame caching**: since the animation is periodic (`PERIOD = 4600ms`), it precomputes `CACHE_FRAME_COUNT` full framebuffer snapshots (one per ~33ms) incrementally over several frames, then just `buffer.set(frame.fg/bg)` per frame — turning per-pixel math into a memcpy. Cache invalidates on color/size change.
- `BgPulse` (bg-pulse.tsx:71) drops `renderer.targetFps`/`maxFps` to 30 while mounted and restores on cleanup, throttling the whole render loop for this expensive screen.

**Tool-output collapsing** (util/collapse-tool-output.ts): clamps to `maxLines` and `maxChars` using `Array.from(str)` (codepoint-correct, not `.length`) and appends `…`.

**Theme system** (context/theme.tsx): JSON themes with hex/ref/`{dark,light}` variants; resolves to `RGBA`; computes contrast-aware selected-row foreground via luminance (`0.299r+0.587g+0.114b`) for transparent backgrounds (theme.tsx:54). Prewarms terminal palette and reacts to OS dark/light. Provides opentui `SyntaxStyle` for code highlighting.

## Code patterns worth stealing

Streaming append into a fine-grained store (only the changed text node re-renders):
```ts
// on "message.part.delta"
const { found, index } = Binary.search(parts, partID, p => p.id)
if (!found) break
setStore("part", messageID, produce(draft => {
  const part = draft[index]
  part[field] = (part[field] ?? "") + delta   // in-place append
}))
```

Sorted-insert/patch with binary search + reconcile (keeps reactivity minimal):
```ts
const m = Binary.search(store.session, info.id, s => s.id)
if (m.found) setStore("session", m.index, reconcile(info))           // patch in place
else setStore("session", produce(d => d.splice(m.index, 0, info)))   // insert sorted
```

Mode-stack as disposer-returning push (modal/leader layers):
```ts
const pop = modeStack.push("modal")
onCleanup(pop)   // auto-pop when component unmounts
```

Custom framebuffer renderable (escape hatch below JSX):
```ts
class FX extends FrameBufferRenderable {
  renderSelf(buffer, deltaTime = 0) {
    if (!this.visible || this.isDestroyed) return
    this.painter.render(this.frameBuffer, { deltaTime, rgb: this._ctx.capabilities?.rgb })
    super.renderSelf(buffer)
  }
}
extend({ fx: FX })   // register as a JSX intrinsic <fx/>
```

Half-block double-resolution: one cell = `▀` with `fg = topPixel`, `bg = bottomPixel`.

DI-as-context factory (every subsystem is a provider):
```ts
const { use, provider } = createSimpleContext({ name: "Sync", init: () => {...} })
// init can expose `ready`; provider gates children on it (helper.tsx)
```

## Gotchas / non-obvious decisions
- **Two sync stores coexist**: `context/sync.tsx` (v1, source of truth) and `context/sync-v2.tsx` — v2 is a parallel/experimental message store; the `session-v2` view is gated behind a debug route. Don't assume one.
- **`exitOnCtrlC: false`** — Ctrl-C is app-handled (closes dialogs, then exits only when prompt is empty). A win32 Ctrl-C guard (`win32.ts`) is installed/removed around the session because Windows processed-input mode would otherwise eat it.
- **First-paint flash avoidance** is deliberate: palette prewarm + `waitForThemeMode` *before* `render()`, and `TimeToFirstDraw` is instrumented behind `OPENCODE_SHOW_TTFD`.
- **The pulse painter writes both fg and bg to the same color** for background cells and relies on `respectAlpha: false`; it manipulates `OptimizedBuffer.buffers` typed arrays directly — bypassing all of opentui's cell API for speed. Fragile but fast; cache must be invalidated on any color/size change.
- **Codepoint width**: text truncation uses `Array.from(str)` not `.length`, and width math imports `promptOffsetWidth` — they care about multi-byte/wide chars, but most layout is delegated to opentui's text measurement.
- **History eviction (100 msgs)** means scrolling far up won't show everything; `session.sync()` re-fetches the last 100 and re-merges, carefully preserving live-streamed parts.
- **Plugin system**: large parts of the UI (`feature-plugins/`) are structured as internal "TUI plugins" registering routes/slots via `TuiPluginRuntime` and `createTuiApi` — even first-party views go through the plugin API.

## Relevance (which advanced-TUI topics this teaches)
- **app-architecture** — provider-tree DI, event-sourced server-driven state, three-phase bootstrap, lifecycle/exit state machine, plugin slots/routes.
- **reconciler-component-models** — SolidJS fine-grained reactivity over a retained-mode terminal reconciler; stores + `reconcile`/`produce` as the streaming-update strategy instead of vdom diffing.
- **rendering-pipeline** — direct `FrameBufferRenderable.renderSelf` framebuffer painting, periodic frame caching, dynamic FPS throttling, custom `extend()`-ed renderables.
- **ansi-escapes / unicode-text-width** — truecolor RGBA cell buffers, half-block sub-cell rendering, capability detection (`rgb`), codepoint-aware truncation, terminal title sequences.
- **input-keyboard-mouse** — layered/moded keymap, timed leader chords, managed-textarea input layer, Kitty keyboard protocol, mouse selection/copy, win32 Ctrl-C handling.
- **layout** — opentui flexbox (`flexDirection`, `flexGrow`, `gap`, absolute `position`/`zIndex`), sticky-bottom scrollboxes, dialog overlays.
- **widgets-rich-content** — message/tool/diff renderers, collapsible output, syntax highlighting via `SyntaxStyle`, toasts, command palette, theme engine with light/dark variants.
