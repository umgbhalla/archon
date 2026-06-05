# rezi

## What it is (1-2 lines)
Rezi is a runtime-agnostic TypeScript TUI framework (npm-workspaces monorepo) for serious terminal apps (dashboards, control planes, log viewers). It builds a committed widget tree in JS, compiles it to a binary drawlist (ZRDL), and hands rendering/diffing/terminal-IO to a native engine ("Zireael", C with a Rust N-API binding) running on a worker thread with a SharedArrayBuffer frame transport.

## Architecture (how the pieces fit; key files with paths)
Packages (`packages/*/src`):
- `@rezi-ui/core` — runtime-agnostic everything: widget API, commit/reconcile, layout, focus, input routing, drawlist codec, theme, forms, router, testing. No runtime-specific imports allowed.
- `@rezi-ui/node` — Node/Bun backend: terminal IO, worker thread hosting the native engine, frame transport, scheduling.
- `@rezi-ui/native` — Rust N-API binding to the C Zireael engine (`native/src/ffi.rs`, `lib.rs`).
- `@rezi-ui/jsx` — optional JSX surface that lowers to `ui.*` factories.
- `@rezi-ui/testkit` — snapshot/golden/fuzz/rng helpers.
- `create-rezi` — scaffolding CLI + templates (`minimal`, `cli-tool`, `starship`).

The frame pipeline (all in core unless noted):
1. App holds immutable state `S`. `app.view(state)` returns a VNode tree of `ui.*` widgets.
2. **Commit**: `runtime/commit.ts` reconciles the new VNode tree against the previous committed `RuntimeInstance` tree, allocating/reusing stable instance IDs.
3. **Layout**: `layout/engine/layoutEngine.ts` measures + positions the committed tree into a `LayoutTree` of int32 cell rects.
4. **Render to drawlist**: `renderer/renderToDrawlist.ts` walks the layout tree and emits drawing commands into a `DrawlistBuilder` (`drawlist/builderBase.ts`), producing ZRDL bytes.
5. **Submit**: drawlist bytes are written into a SAB slot and published to the worker (`node/src/backend/nodeBackend/frameTransport.ts`); the native engine diffs against its framebuffer and writes minimal ANSI to the terminal.
6. **Input**: worker polls the engine for a binary event batch (ZREV); `runtime/router/{key,mouse,wheel,zones}.ts` route events to focus/scroll targets; handlers call `app.update()`.

Orchestration: `app/createApp.ts` wires a `TurnScheduler` (microtask coalescing, `app/turnScheduler.ts`), `AppStateMachine` (`app/stateMachine.ts`), render loop (`app/createApp/renderLoop.ts`), and `RuntimeBackend` (`backend.ts`). ABI version pins and error codes are in `abi.ts`.

## Core techniques (the actual TUI engineering)

**Binary drawlist protocol (ZRDL).** Instead of writing ANSI from JS, the JS side serializes draw commands into a versioned binary buffer with a 64-byte header (`drawlist/builderBase.ts:22`). Layout: header → command stream → string span table + string bytes → blob span table + blob bytes. Everything is 4-byte aligned (`align4`, line 62), little-endian, with magic `0x4c44525a` ('ZRDL'). Opcodes: CLEAR, FILL_RECT, DRAW_TEXT, PUSH_CLIP, POP_CLIP, DRAW_TEXT_RUN, SET_CURSOR (`builderBase.ts:36`). The builder is the contract boundary to the C engine — codegen (`scripts/generate-drawlist-writers.ts` → `drawlist/writers.gen.ts`) keeps the byte layout in sync with `scripts/drawlist-spec.ts`; do not hand-edit generated writers.

**String interning + per-frame text arena.** Text is deduplicated: `internString` (`builderBase.ts:696`) maps string→index so repeated labels are stored once; commands reference the index + byte length. A fast ASCII path skips `TextEncoder` entirely (`encodeUtf8`, line 750) — it only invokes the encoder for non-ASCII, and counts encoder calls as a perf metric. `drawlist/textArena.ts` is a separate contiguous UTF-8 arena using `encodeInto` directly into a growable buffer (worst case 3 bytes/UTF-16 unit, line 75) to avoid per-segment allocation. The whole builder supports `reuseOutputBuffer` and bounded growth toward `maxDrawlistBytes` so steady-state frames allocate ~nothing.

**Reconciliation (`runtime/reconcile.ts`).** React-like keyed/unkeyed diff. Fast path: if neither prev nor next children have keys, do index-based matching (`reconcileUnkeyedChildren`, line 119) with no Map allocation. Keyed path builds a `prevBySlotId` map; slot IDs are `k:<key>` or `i:<index>`. Duplicate sibling keys are a fatal `ZRUI_DUPLICATE_KEY`. Reuse requires same `kind` and matching composite widget key (`canReuseVNode`, line 63). Reused instances keep their instanceId (preserving local state/focus); unmatched prev instances are unmounted.

**Commit with leaf-equality short-circuit (`runtime/commit.ts`).** `commitNode` recurses with a `prevNodeStack` and a layout-depth counter (warns past a threshold, fatals past `MAX_LAYOUT_NESTING_DEPTH`, line 94 — prevents stack blowup from pathological trees). If `prev.vnode.kind === vnode.kind && leafVNodeEqual(prev, vnode)` it reuses the instance untouched and clears dirty flags (line 119) — this is the cheap "nothing changed" path. Interactive-widget IDs and focus-container IDs are validated for global uniqueness during commit (`ensureInteractiveId`/`ensureFocusContainerId`). Error boundaries are implemented in-commit: `errorBoundary` nodes catch `ZRUI_USER_CODE_THROW` from their protected child and swap to a fallback subtree (line 152).

**Layout engine with two-cache memoization (`layout/engine/layoutEngine.ts`).** Split measure/position. `measureNode` returns natural `{w,h}` given `(maxW, maxH, axis)`; `layoutNode` positions into rects. Both memoize on a `WeakMap<VNode, ...>`: measure cache keyed by `axis → maxW → maxH`; layout cache nested `axis → maxW → maxH → forcedW → forcedH → x → y` (lines 377-437). A dirty set (`dirtySet.has(vnode)`) invalidates layout-cache hits selectively (line 776) so only changed subtrees recompute. Constraint system supports fixed numbers, `full`, `auto`, `fluid(...)`, `expr("parent.w * 0.5")` — percentage strings and responsive breakpoint maps are explicitly removed and produce dev errors (`findLegacyConstraintUsage`, line 168). `fragment`/`themed` are transparent: single child passes through, multiple children get a cached synthetic `column` (line 439). Per-kind dispatch routes to `layoutStackKinds`, `layoutGridKinds`, `layoutOverlays`, `layoutCollections`, etc.

**Unicode width, pinned and deterministic (`layout/unicode/props.ts`, `layout/textMeasure.ts`).** Width must match the C engine exactly, so Unicode 15.1.0 data tables are vendored and a `check:unicode` script verifies sync. Grapheme cluster breaking (UAX#29), East Asian Width, emoji presentation, and extended-pictographic lookups are all binary searches over flat `Uint32Array` range tables (`inRanges`/`ranges8Lookup`, lines 27/50). Width rules: ASCII 1, control 0, CJK/wide 2, combining 0, emoji clusters 2 (policy-controlled `wide`/`narrow`), invalid surrogates → U+FFFD width 1. Emoji policy change clears the measure cache (`setTextMeasureEmojiPolicy`).

**SharedArrayBuffer frame transport, latest-wins (`node/src/backend/nodeBackend/frameTransport.ts`, `node/src/worker/engineWorker/frameMailbox.ts`).** Default 8 slots × 1 MiB. A control SAB holds a header (published seq/slot/bytes/token, consumed seq) plus per-slot `states` (FREE/WRITING/READY) and `tokens` arrays. Producer: `acquireSabSlot` CAS-claims a FREE slot; under backpressure it reclaims a stale READY slot (latest-wins, line 116) rather than blocking or falling back to message-copy. `publishSabFrame` writes slot/bytes/token then the seq last (seq is the publish barrier). Consumer `readLatestSabFrame` does a seqlock-style read: load seq-before, read fields, load seq-after, retry up to 4× if they differ (line 158) — lock-free single-frame handoff. Falls back gracefully to transfer-v1 (postMessage with transferable ArrayBuffer) if SAB is unavailable or config is malformed.

**Input routing layered by intent (`runtime/router/*`).** Documented path: `key/mouse input → router → wheel router (nearest scroll target)`. Key codes are duplicated as constants pinned to the engine ABI (`router/key.ts:13`). `routeKeyWithZones` (`router/zones.ts`) resolves TAB/Shift+TAB → trap-wrap > zone-to-zone traversal > linear list; arrow keys → in-zone spatial/grid movement; Enter/Space → press the focused enabled pressable. Focus model (`runtime/focus.ts`) supports linear and 2D grid zones (`computeZoneMovement`, line 301: grid movement via `columns` + wrap), tab-index-sorted zone ordering, and focus traps (modal trapping). Wheel routing (`router/wheel.ts`) clamps scroll deltas (3 lines/notch) against content vs viewport extents.

**Turn-based coalescing (`app/turnScheduler.ts`).** All work items (events, updates, render requests) are enqueued and drained in a single `queueMicrotask` turn. Re-entrant enqueues during a turn schedule a follow-up turn (line 73). A per-turn `renderRequestQueuedForCurrentTurn` flag dedupes render requests so N state updates in one turn produce one frame. `update()` during render throws `ZRUI_UPDATE_DURING_RENDER`.

**Explicit buffer ownership across the FFI boundary.** `BackendEventBatch.release()` must be called exactly once per batch even on parse failure (`backend.ts:77`); backend must not reuse the buffer until released. Optional zero-copy markers let backends expose `beginFrame()` returning a backend-owned writable view + `commit(byteLen)` so the drawlist is built directly into shared memory (`backend.ts:52`). Engine config/limits are `#[repr(C)]` structs negotiated by ABI version (`native/src/ffi.rs:36`): arena caps, max cmds/strings/blobs/clip-depth, damage-rect cap, color mode, mouse/paste/focus/OSC52 toggles, width policy, target fps.

## Code patterns worth stealing

Seqlock-style lock-free latest-frame read (retry on torn read):
```ts
for (let attempt = 0; attempt < 4; attempt++) {
  const seqBefore = Atomics.load(h, PUBLISHED_SEQ_WORD);
  if (seqBefore <= lastConsumedSeq) return null;
  slotIndex = Atomics.load(h, PUBLISHED_SLOT_WORD);
  byteLen   = Atomics.load(h, PUBLISHED_BYTES_WORD);
  const seqAfter = Atomics.load(h, PUBLISHED_SEQ_WORD);
  if (seqBefore === seqAfter) { stableSeq = seqAfter; break; } // consistent snapshot
}
```

ASCII fast-path before hitting TextEncoder:
```ts
let asciiOnly = true;
for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) > 0x7f) { asciiOnly = false; break; }
if (asciiOnly) { /* memcpy charCodes directly, no encoder */ }
else { this.textEncoderCalls += 1; return this.encoder.encode(text); }
```

Leaf-equality short-circuit so unchanged subtrees cost ~one comparison:
```ts
if (prev && prev.vnode.kind === vnode.kind && leafVNodeEqual(prev.vnode, vnode)) {
  prev.dirty = false; prev.selfDirty = false;
  return { ok: true, value: { root: prev } }; // reuse instance untouched
}
```

Unkeyed fast path avoids Map allocation entirely; only build slot maps when keys exist:
```ts
if (!prevContainsKeys && !nextContainsKeys)
  return reconcileUnkeyedChildren(prev, next, allocator); // index-based, no Map
```

Microtask render dedupe:
```ts
if (!renderRequestQueuedForCurrentTurn) {
  renderRequestQueuedForCurrentTurn = true;
  enqueueWorkItem({ kind: "renderRequest" }); // N updates -> 1 frame
}
```

## Gotchas / non-obvious decisions
- **The render target is a binary buffer, not ANSI.** JS never writes escape codes for the framebuffer; it serializes ZRDL and the C engine owns diffing + ANSI emission + cursor + scroll optimization. Raw control writes (OSC 52 clipboard) are an explicit opt-in backend marker outside the frame path (`backend.ts:40`).
- **Determinism is a hard requirement.** Unicode tables, text-measure version (`ZRUI_TEXT_MEASURE_VERSION`), drawlist version, and engine ABI are all pinned and CI-verified; JS width must equal engine width or layout desyncs from render.
- **Events are poll-based, not callback-based** (`pollEvents()`), deliberately to avoid native→JS callbacks; the worker blocks on the engine and the main thread polls.
- **Backpressure = drop, not block.** SAB transport reclaims stale READY slots and overwrites pending frames ("mailbox-latest-wins", `frameMailbox.ts:218`); only the newest frame matters for a TUI.
- **`update()` during render is illegal** and throws a deterministic error code; all state mutation flows through the turn scheduler.
- **Layout depth is bounded** with a warn threshold then a fatal cap, because the commit recursion would otherwise overflow on degenerate trees.
- **Instance reuse depends on `kind` + composite widget key**, not on `id`. Duplicate interactive `id`s are caught at commit as fatal errors, distinct from reconciliation keys.
- **`core` must stay runtime-free** — terminal/Node imports only live in `@rezi-ui/node`; the backend is an interface (`RuntimeBackend`) so the same core runs under a test renderer or a real PTY.
- **Errors are deterministic union codes** (`ZrUiErrorCode` / `ZrResult`) rather than ad-hoc throws, enabling behavior-first contract tests and reproducible replay (`node/src/repro/recorder.ts`).

## Relevance (which advanced-TUI topics this teaches)
- rendering-pipeline — committed-tree → binary drawlist → native diff; turn-coalesced single-frame-per-turn loop; buffer reuse/arenas.
- reconciler-component-models — keyed/unkeyed VNode reconciliation, stable instance IDs, leaf-equality short-circuit, in-commit error boundaries.
- layout — two-phase measure/position engine, multi-level WeakMap memo caches, dirty-set invalidation, constraint expr/fluid system.
- unicode-text-width — pinned Unicode 15.1.0 grapheme/EAW/emoji tables, binary-search range lookups, deterministic cross-engine width parity.
- ansi-escapes — the inverse lesson: how to push ANSI generation out of the app layer into a native engine via a versioned binary protocol.
- input-keyboard-mouse — zone/trap focus model, 2D grid spatial navigation, wheel-to-nearest-scroll-target routing, ABI-pinned key codes.
- app-architecture — runtime-agnostic core vs backend split, microtask turn scheduler, state machine, poll-based events, explicit buffer-ownership FFI contract, SAB worker transport.
- widgets-rich-content — large first-party widget set (tables, virtual lists, trees, charts, canvas, code/diff viewers, command palette, dialogs) over a single `ui.*` factory + JSX parity layer.
