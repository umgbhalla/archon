# app-architecture

How production TypeScript TUIs are wired end-to-end: where state lives, how events fold into it, the update→render cycle, how components compose, how keybindings are organized, and how all of it stays fast at scale. Six real apps studied: **opencode** (SolidJS on opentui), **gloomberb** (React on opentui, finance terminal), **hunk** / **critique** / **ghui** (React on opentui, diff/PR viewers), and **rezi** (its own runtime-agnostic framework with a native C engine).

## TL;DR (the mental model in 3-5 bullets)

- **Every serious TUI is a single-writer event loop around an immutable-ish state value.** Input/server events fan in, get *folded* into state by a reducer-like step, and a *separate* render step turns the new state into a frame. The discipline that separates a toy from production is making "update" and "render" strictly non-overlapping phases — rezi literally throws `ZRUI_UPDATE_DURING_RENDER` if you mutate state mid-render (`createApp.ts:790`).
- **Coalesce, don't react.** N state changes in one tick must produce *one* frame. rezi does this with a microtask `TurnScheduler` + a `renderRequestQueuedForCurrentTurn` dedupe flag; opencode does it implicitly via SolidJS fine-grained signals + `batch()`. Either way the loop is "drain all pending work → commit once → render once."
- **State is event-sourced when there's a server.** opencode's entire UI is a fold over a server SSE stream: one giant `event.subscribe` switch that patches a normalized `createStore` keyed by id (`sync.tsx:141`). The store is the *projection*; the server stream is the *log*.
- **Keybindings are their own subsystem, not `if (key === 'q')` scattered in handlers.** The two best designs are ghui's **algebraic keymap** (bindings are composable values; dispatch is a pure function) and gloomberb's **phased, cancelable, editable-aware dispatch** over one listener. The load-bearing invariant everywhere: a bare letter key must not fire an action while a text input is focused.
- **Performance at scale = virtualization + memoized layout + caching around the reconciler, never re-rendering the whole tree.** hunk measures rows without mounting them and windows the visible slice; rezi memoizes layout in two-level WeakMaps with a dirty-set; gloomberb reads `scrollTop` straight off the native renderable to avoid React state churn.

## How it actually works (the mechanism, step by step)

### 1. The update→render cycle (rezi is the clearest reference)

rezi is the only repo that owns its whole runtime, so its loop is explicit and worth reading as the canonical shape. The orchestrator is `createApp()` (`context/rezi/packages/core/src/app/createApp.ts:130`). The pieces:

- A **state machine** (`stateMachine.ts:38`) with states `Created → Running → Stopped/Faulted/Disposed`. Every public method asserts a legal state first (`sm.assertOneOf([...])`). This is what makes teardown and "can't start twice" bulletproof.
- A **microtask `TurnScheduler`** (`turnScheduler.ts:21`). All work — input batches, user `update()` calls, render requests — is enqueued as `WorkItem`s and drained in one `queueMicrotask` turn. Re-entrant enqueues during a turn schedule a *follow-up* turn (`turnScheduler.ts:73`) rather than recursing.
- The turn body is `processTurn` (`eventLoop.ts:413`): it walks the batched items, processes event batches (which may call `commitUpdates()`), and at the very end calls `tryRenderOnce()` **exactly once** (`eventLoop.ts:483`). N updates in a turn → 1 frame.

The render-dedupe trick lives in `markDirty` (`createApp.ts:243`):

```ts
function markDirty(flags, schedule = true) {
  // ...set dirty bits...
  if (scheduler.isExecuting) {
    if (!renderRequestQueuedForCurrentTurn) {
      renderRequestQueuedForCurrentTurn = true;
      enqueueWorkItem({ kind: "renderRequest" });   // collapses many marks → one render
    }
    return;
  }
  if (scheduler.isScheduled) return;
  enqueueWorkItem({ kind: "renderRequest" });
}
```

`update()` (`createApp.ts:786`) is the single state-mutation door. It guards against re-entrancy (`ZRUI_REENTRANT_CALL` during commit, `ZRUI_UPDATE_DURING_RENDER` during render), enqueues the updater into an `UpdateQueue`, and schedules a `userCommit`. The commit (`eventLoop.ts:105`) drains the queue and *folds* updaters over the previous state — pure reducer semantics:

```ts
let next = getCommittedState();
for (const update of drained)
  next = typeof update === "function" ? update(next) : update;
if (next !== getCommittedState()) { setCommittedState(next); markDirty(DIRTY_VIEW, false); }
```

Note the dirty *flags* (`DIRTY_VIEW | DIRTY_LAYOUT | DIRTY_RENDER`, `dirtyPlan.ts`): a state change only marks `DIRTY_VIEW` (re-run `view(state)`); a resize marks `DIRTY_LAYOUT`; a spinner tick marks only `DIRTY_RENDER`. The render loop does the minimum work the flags demand — this is how rezi avoids re-laying-out on every animation frame.

Events are **poll-based, not callback-based** (`eventLoop.ts:486` `pollLoop`): the worker blocks on the native engine, the main thread `await backend.pollEvents()` in a loop, and each batch becomes a work item. A `pollToken` is bumped on stop/dispose so a late poll result from a previous run is discarded. This is a deliberate choice to avoid native→JS callbacks across the FFI boundary.

### 2. Event sourcing: state as a fold over a server log (opencode)

opencode's TUI holds essentially zero local business state — it's a *projection* of a server event stream. The store is one normalized `createStore` (solid-js/store) keyed by id: `session[]`, `message[sessionID][]`, `part[messageID][]`, `permission`, `question`, `todo`, `session_status`, … (`context/sync.tsx:40`). A single `event.subscribe` handler (`sync.tsx:141`) is the reducer — a giant switch over event types that patches the store in place.

The streaming-text problem (LLM tokens arriving char-by-char) is the interesting part. Three techniques:

- **Sorted insert / in-place patch via binary search + `reconcile`.** Arrays stay sorted by id; on an update, `Binary.search` finds the slot; found → `setStore(path, index, reconcile(next))` patches *only changed fields*; not found → `produce(draft => draft.splice(index, 0, item))` inserts (`sync.tsx:241-254` for sessions, `:277-315` for messages). `reconcile` diffs structurally so unchanged fields don't trigger reactivity.
- **In-place delta append.** `message.part.delta` appends to a string field of one part without replacing the object (`sync.tsx:354`):

```ts
setStore("part", messageID, produce(draft => {
  const part = draft[result.index];
  (part[field] as string) = (existing ?? "") + delta;   // only this text node re-renders
}));
```

- **Bounded history.** Messages cap at 100; exceeding it `batch()`es eviction of the oldest message *and* its parts (`sync.tsx:296`).

The lesson: with SolidJS fine-grained reactivity, the reducer's job is to mutate the store as *surgically* as possible so only the exact leaf that changed re-renders. This is the inverse of React's "re-render and diff" model.

### 3. Component composition & dependency injection (opencode vs the rest)

opencode's app is a deep nest of ~20 SolidJS context providers (`app.tsx:228-289`): `OpencodeKeymapProvider → ArgsProvider → ExitProvider → KVProvider → ToastProvider → RouteProvider → SDKProvider → ProjectProvider → SyncProvider → ThemeProvider → DialogProvider → …`. Each subsystem is a provider built with a `createSimpleContext({ name, init })` factory; this *is* the DI backbone. Providers can gate children on a `ready` signal so dependents never see a half-initialized service.

gloomberb takes a different composition tack: a **host abstraction** (`src/ui/host.tsx`) defines three context-injected interfaces (`UiHost` component library, `RendererHost` side-effects, `NativeRendererHost` low-level access) plus a `capabilities` object. Components call `useUiHost()`/`useUiCapabilities()` and *never import opentui directly*, so the same React tree drives both a terminal backend and a desktop (Electrobun) backend. Composition decisions become capability gates instead of component branches:

```ts
const { nativePaneChrome, precisePointer } = useUiCapabilities();
const dockGeometryOptions = nativePaneChrome ? { precise: true } : { reserveDividerGutters: true };
```

rezi's composition is `view(state) → VNode tree of ui.* factories`, reconciled against the previous committed tree (`runtime/commit.ts`, `runtime/reconcile.ts`) — a React-like keyed/unkeyed diff with stable instance IDs that preserve focus/local state across renders.

### 4. Keybinding systems (the part most apps get wrong)

Three distinct, all-good designs:

**ghui — algebraic keymap (best-in-class).** A `Keymap<C>` is an immutable list of `Binding<C>` parametric in a context type (`packages/keymap/src/keymap.ts:55`). The combinators form a closed algebra:
- Monoid under `union` (identity `Keymap.empty()`).
- **Contravariant** in `C`: `contramap(project)` lifts a narrow keymap into a wider context; `scope(project)` is the falsy-friendly partial lift so you write `km.scope(a => a.modalActive && a.modal)` instead of ternaries (`keymap.ts:92`, lift impl `liftBindingScope` at `keymap.ts:12`).
- `restrict(pred)` AND-merges a predicate into every binding's `when`; `prefix("g")` prepends a stroke for leader keys (`keymap.ts:101,108`).

Dispatch is a **pure function** (`pure-dispatch.ts:58`): `pureDispatch(keymap, state, stroke, ctx, now) → {state, decision}` where state is just `{ pending: ParsedStroke[], timeoutAt }`. Multi-stroke sequences (`g g`) are resolved by classifying matches into `exact` vs `continuing` (`findMatches`, `pure-dispatch.ts:26`): exact + no continuation → run now; any continuation → become `pending` with a 500ms disambiguation window; no match with pending → drop and retry fresh (`pure-dispatch.ts:75`). Crucially `pureTick` (`pure-dispatch.ts:96`) fires a timed-out pending binding by **re-evaluating against current ctx**, not the ctx captured at keypress — so actions taken between strokes stay correct. Because dispatch is pure and clock-injected, it's trivially testable.

The whole app is one `appKeymap` where each layer is a sub-keymap `.scope`d behind its active flag; *precedence is encoded by ordering* (`src/keymap/all.ts`): palette/quit first, then modals, then full-view layers gated `!modalActive`, then list nav. A flat `AppCtx` carries all the boolean flags and per-layer narrow contexts.

**gloomberb — phased, ref-based dispatch over one listener** (`src/react/input.ts`, `src/renderers/opentui/input-host.tsx`). A single `useKeyboard` fans out to a registry of `useShortcut(handler, {phase, enabled, allowEditable, scope})`. Three phases run in order `before → normal → after`, `after` skipped if a prior handler called `preventDefault`/`stopPropagation`; within a phase handlers run in registration order and `propagationStopped` short-circuits. Handlers are stored as refs so re-subscription isn't needed each render. The linchpin is `shouldDeliverShortcut` (`input.ts:`): bare keys are swallowed when an editable field is focused unless the chord has ctrl/meta/super — this is *the* thing that lets single-letter shortcuts (`q`, `r`) coexist with text inputs.

**opencode — layered mode stack** (`keymap.tsx`): a stack of `{id, mode}` with push/pop returning disposers (`onCleanup(pop)` auto-pops on unmount); bindings gate on the top mode. Adds a timed leader key, escape-clears-pending, and a *managed-textarea layer* that only activates `input.*` bindings when a `TextareaRenderable` is focused.

**rezi** routes keys inside the event loop (`eventLoop.ts:255-393`): keybindings get first crack via `routeKeyEvent`; if not consumed, the event falls through to widget routing (focus traps, zones). It even synthesizes key events from `text` events for ctrl-chords (`eventLoop.ts:314`) and pairs Shift+letter `key` events with their `text` twin to avoid double-handling (`pendingShiftTextPair`).

### 5. Startup dispatch & lifecycle (hunk)

hunk's entry (`src/main.tsx`) resolves a `StartupPlan` (`src/core/startup.ts:16`) into one of `help | daemon-serve | session-command | plain-text-pager | passthrough | static-diff-pager | app`. Only the `app` branch boots opentui; the others reuse the *same parse/highlight pipeline* but serialize straight to ANSI (the static pager) — explicitly forbidden from forking a second parser. This "one core, many run-modes" shape recurs in critique (`--web`/`--image`/`--pdf` render the same React tree off-screen via `createTestRenderer`). Lifecycle teardown is a single idempotent `shutdown()` removing signal handlers, disposing job-control hooks, and restoring the primary screen on every exit path (SIGINT/SIGTERM/suspend).

## Cross-repo comparison

| Concern | opencode | gloomberb | hunk / critique | ghui | rezi |
|---|---|---|---|---|---|
| Framework | SolidJS / opentui | React / opentui | React / opentui | React / opentui | own runtime + C engine |
| State model | event-sourced `createStore` keyed by id | Redux-ish `dispatch` + selected slices + `stateRef` | local React state + WeakMap caches | Effect atoms + command registry | immutable `S`, reducer `update()` |
| Update→render coalescing | SolidJS signals + `batch()` | React batching | React batching | React batching | explicit `TurnScheduler`, 1 frame/turn |
| Re-render granularity | fine-grained (signal per leaf) | selector slices + capability gates | `memo` + windowing | atom-driven | VNode reconcile + leaf-equality short-circuit |
| Keybindings | layered mode stack + leader | phased ref registry, editable-aware | single `useKeyboard` modal guard | **pure algebraic keymap** | in-loop route → focus zones |
| Composition / DI | ~20 context providers | host-abstraction capabilities | refs to native renderables | Effect services + atoms | `ui.*` factories / JSX |
| Big perf lever | surgical store writes | virtualized table, off-renderable scrollTop | measure→window→spacer virtualization | precomputed stacked offsets | WeakMap layout memo + dirty-set + binary drawlist |

Where they **agree**: single input→fold→render loop; one keyboard listener fanned out; bare-key suppression while typing; virtualization for large content; caching keyed by content identity; clean teardown restoring the terminal.

Where they **differ** (and which is better):
- **Reactivity**: opencode's fine-grained SolidJS store is the best fit for *streaming* (one delta touches one node, no diff). React apps (gloomberb/hunk/critique/ghui) pay a reconcile cost and compensate with `memo` + virtualization + reading scroll state off the native renderable. rezi sidesteps both by committing a VNode tree to a native diffing engine via a binary protocol.
- **Keybindings**: ghui's algebra is the cleanest *and* most testable (pure dispatch, composable values) — adopt it. gloomberb's phased model is the most pragmatic for cancelable global+local precedence. opencode's mode stack is simplest. All three beat scattered `if (key===...)`.
- **State management**: for server-driven apps, event sourcing (opencode) is correct — the server is the source of truth, the client is a projection. For self-contained apps, rezi's reducer `update()` with strict phase separation is the safest. gloomberb's hybrid (`stateRef.current` snapshot merged with selected slices, `app.tsx:90`) is a deliberate compromise to keep a full-state object available to imperative callbacks while still getting fine-grained selector re-renders.

## Pitfalls & hard parts

- **Updating state during render.** The single most corrupting bug. rezi makes it a hard error (`ZRUI_UPDATE_DURING_RENDER`, `createApp.ts:790`); React apps hit it as "cannot update during render" warnings or infinite loops. Keep `view(state)` pure.
- **Render storms.** Without coalescing, every keystroke/delta triggers a frame. Always dedupe render requests per tick (rezi's `renderRequestQueuedForCurrentTurn`; SolidJS `batch()`; React's automatic batching — but watch out for updates from async callbacks/timers which batch differently).
- **Bare-key-while-typing.** Forget `shouldDeliverShortcut`/editable-gating and typing `q` in a search box quits the app. Every repo handles this explicitly.
- **Disambiguation timeout staleness.** A pending leader (`g`+timeout) must re-read ctx at fire time, not capture it at keypress (ghui `pureTick`). Otherwise an action between strokes desyncs scope.
- **Stale async results after stop/restart.** Use a generation/token counter (rezi `pollToken`/`lifecycleGeneration`) so a late poll or fetch from a previous lifecycle is discarded.
- **Event-sourcing merge races.** A slow REST hydrate can clobber fresher live deltas. opencode tracks ids "touched" by live events mid-fetch (`hydratingSessions`) and prefers the in-store version (`sync.tsx:550`).
- **Teardown.** The alt-screen *must* be exited on every path (SIGINT, fatal, suspend) or the user's terminal is wrecked. Make `shutdown()` idempotent and call it from every exit (hunk `main.tsx`, rezi `doFatal`/`dispose`).
- **Two stores coexisting.** opencode ships `sync.tsx` (v1) and `sync-v2.tsx` simultaneously behind a debug route — don't assume one source of truth in a real codebase.

## If you were building this from scratch (recommended approach)

Use a strict single-writer loop with phase separation, microtask coalescing, and an algebraic keymap. Minimal pseudocode:

```ts
// --- state: one immutable value, one mutation door ---
type WorkItem = { kind: "event"; ev: InputEvent } | { kind: "update"; fn: (s: S) => S }
              | { kind: "render" };

let state: S = initialState;
let inRender = false, inCommit = false;
const queue = new TurnScheduler<WorkItem>(processTurn);   // queueMicrotask coalescer
let renderQueuedThisTurn = false;

function update(fn: (s: S) => S) {
  if (inRender) throw new Error("UPDATE_DURING_RENDER");
  queue.enqueue({ kind: "update", fn });
}
function markDirty() {
  if (queue.isExecuting) { if (!renderQueuedThisTurn) { renderQueuedThisTurn = true; queue.enqueue({kind:"render"}); } }
  else queue.enqueue({ kind: "render" });
}

function processTurn(items: WorkItem[]) {
  renderQueuedThisTurn = false;
  let next = state;
  for (const it of items) {
    if (it.kind === "event") routeInput(it.ev, next, update);   // keymap first, then focus/widgets
    else if (it.kind === "update") { inCommit = true; next = it.fn(next); inCommit = false; }
  }
  if (next !== state) { state = next; }
  // render ONCE per turn
  inRender = true;
  const frame = render(view(state));   // view is pure; diff against last frame
  commitFrame(frame);                   // your reconciler / native engine writes minimal ANSI
  inRender = false;
}

// input loop: poll, never block the writer
async function pollLoop(token: number) {
  while (running && token === pollToken) {
    const batch = await backend.pollEvents();
    if (token !== pollToken) { batch.release(); return; }
    queue.enqueue({ kind: "event", ev: batch });
  }
}

// --- keybindings: composable values, pure dispatch ---
const km = union(
  globalKm,                                   // quit/palette, gated !textInputActive
  modalKm.scope(s => s.modalOpen && s.modal),  // higher precedence by ordering
  listKm.scope(s => s.inList && s.list),
);
function routeKey(stroke, ctx, dispatchState) {
  if (textInputFocused(ctx) && !stroke.hasModifier) return passToTextInput(stroke);
  const { state: ds, decision } = pureDispatch(km, dispatchState, stroke, ctx, now());
  if (decision.kind === "ran") decision.binding.action(ctx);  // action calls update()
  return ds;
}
```

Rules to enforce: (1) `view(state)` is pure, no side effects, no `update()`; (2) one render per turn; (3) all mutation through `update()`; (4) a lifecycle state machine guards start/stop/dispose and a generation token invalidates stale async; (5) one keyboard listener, editable-aware, precedence by layer order; (6) for server-driven apps, make state a projection of an event log and patch it surgically; (7) virtualize anything that can exceed the viewport. Adopt ghui's keymap algebra and rezi's turn-scheduler verbatim — they're the two cleanest pieces across all six repos.

## Source map (which files to read for more)

- **rezi (the loop, done right)**: `context/rezi/packages/core/src/app/createApp.ts` (orchestration, `markDirty`/`update`/lifecycle), `app/turnScheduler.ts` (coalescing), `app/createApp/eventLoop.ts` (`commitUpdates`, `processTurn`, `pollLoop`, key routing), `app/stateMachine.ts` (lifecycle states), `app/createApp/dirtyPlan.ts` (dirty flags), `runtime/reconcile.ts` + `runtime/commit.ts` (VNode diff, leaf-equality short-circuit).
- **opencode (event sourcing)**: `context/opencode/packages/opencode/src/cli/cmd/tui/context/sync.tsx` (the reducer over the SSE stream; `bootstrap` three-phase load; `session.sync` delta-safe merge), `cmd/tui/app.tsx` (provider tree, `mountTui`, `TuiLifecycle`), `cmd/tui/keymap.tsx` (mode stack + leader).
- **ghui (keymap algebra)**: `context/ghui/packages/keymap/src/keymap.ts` (the `Keymap` algebra), `keymap/src/pure-dispatch.ts` (pure dispatch + tick), `keymap/src/dispatcher.ts` (stateful wrapper + clock), `src/keymap/all.ts` (layered precedence), `src/keyboard/opentuiAdapter.ts` (event normalization, single fan-out listener).
- **gloomberb (phased input, host abstraction, virtualization)**: `context/gloomberb/src/react/input.ts` (`useShortcut`, `shouldDeliverShortcut`), `src/renderers/opentui/input-host.tsx` (phased dispatch), `src/ui/host.tsx` (capability-gated DI), `src/app.tsx` (`stateRef`+selector merge), `src/components/ui/data-table/opentui/model.ts` (windowing off native scrollTop).
- **hunk (startup dispatch, virtualization)**: `context/hunk/src/core/startup.ts` (`StartupPlan`), `src/main.tsx` (boot + idempotent shutdown), `src/ui/diff/rowWindowing.ts` + `diffSectionGeometry.ts` (measure→window→spacer), `src/ui/components/panes/DiffPane.tsx` (overscan).
- **critique (multi-mode one tree)**: `context/critique/cli/src/cli.tsx` (run-modes + interactive `App`), `cli/src/store.ts` (zustand persisted), `cli/src/web-utils.tsx` (off-screen render of same tree).
