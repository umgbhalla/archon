# reconciler-component-models

How a declarative UI tree (React/Solid VDOM, or a plain `view(state)` function)
becomes a live terminal scene graph: the host config / universal renderer that
maps elements to nodes, how children mount and diff, the node tree those nodes
form, and how focus + routing ride on top.

Repos studied: **opentui** (custom react-reconciler HostConfig + Solid universal
renderer over a Zig-backed scene graph), **glyph** (from-scratch react-reconciler
+ Yoga + framebuffer), **react-curse** (minimal react-reconciler, one primitive),
**rezi** (no React at all — its own keyed VNode reconciler with stable instance
IDs), **nberlette-tui** (no VDOM — fine-grained signals drive dirty marking),
**termcast** (consumes opentui's reconciler; builds compound components with a
"descendants" pattern), **opentui-ui** (headless renderable core + thin React/Solid
bindings), **termui** (consumes Ink; mount/unmount-per-prompt bridge).

## TL;DR (the mental model in 3-5 bullets)

- A "reconciler" is just an **adapter that translates tree mutations into node
  operations**. React (`react-reconciler`) and Solid (`createRenderer`/universal
  renderer) both hand you a tiny set of callbacks — `createInstance`,
  `appendChild`/`insertNode`, `removeChild`/`removeNode`, `commitUpdate`/`setProperty`,
  `resetAfterCommit`/render-trigger. You implement them against your own node type.
- The **node IS the renderable**, in the best designs. opentui, glyph, opentui-ui
  all make `createInstance(type)` return a live engine node (a `Renderable` /
  `GlyphNode`); `appendChild` is literally `parent.add(child)`. The reconciler stays
  thin because the node's own property setters mark dirty and request a frame.
- **Diffing children is the framework's job, not yours** when you use React/Solid —
  they give you `appendChild`/`insertBefore`/`removeChild` and you just splice arrays
  + a parallel layout (Yoga) tree. If you don't use a VDOM library (rezi), you write
  the keyed/unkeyed reconciliation yourself, with stable instance IDs to preserve
  state/focus across reorders.
- **There are two reactivity models.** VDOM (React, Solid-over-reconciler): re-render
  produces a new tree, the reconciler diffs and mutates. Fine-grained signals
  (nberlette-tui, Solid's actual strength): a signal write marks exactly the affected
  node dirty — no tree diff at all. opentui's setters + `requestRender()` are a hybrid
  (imperative dirty marking under a VDOM).
- **Focus & routing are layered on the node tree, not on React.** Either tree-order
  DFS over the live nodes (glyph), an engine-owned `currentFocusedRenderable` +
  zone/trap model (rezi, opentui), or cooperative context gating with no real input
  capture (termcast). Hit-testing for mouse routes to a node, then events bubble up
  the parent chain.

## How it actually works (the mechanism, step by step)

### 1. The React HostConfig: map element type → node, mutation → node op

A `react-reconciler` HostConfig is an object of ~40 callbacks. The load-bearing ones
for a TUI are small. opentui's
(`context/opentui/packages/react/src/reconciler/host-config.ts`):

```ts
supportsMutation: true,            // mutation mode (mutate nodes in place)
createInstance(type, props, container) {
  const id = getNextId(type)
  const components = getComponentCatalogue()
  if (!components[type]) throw new Error(`Unknown component type: ${type}`)
  return new components[type](container.ctx, { id, ...props })   // host instance == core Renderable
},
appendChild(parent, child)  { parent.add(child) },               // :67
insertBefore(parent, child, beforeChild) { parent.insertBefore(child, beforeChild) },
removeChild(parent, child)  { parent.remove(child.id) },
commitUpdate(instance, type, oldProps, newProps) { updateProperties(instance, type, oldProps, newProps) },
resetAfterCommit(container) { container.requestRender() },       // :97 — schedule a frame
```

Three things to internalize:

- **`createInstance` returns a live engine node.** `host-config.ts:60`
  `new components[type](container.ctx, {...})` — the instance React tracks *is* the
  opentui `Renderable`. There is no separate "fiber → node" map to maintain.
- **The reconciler is thin because setters self-dirty.** The comment at
  `host-config.ts:157` is explicit: "core's property setters already call
  `requestRender()` internally, and `resetAfterCommit` handles the frame trigger."
  `commitUpdate` just sets props; it doesn't schedule rendering itself.
- **Text is a special host context.** `getChildHostContext` sets
  `isInsideText` (`host-config.ts:108`); `createTextInstance` throws if you create raw
  text outside a `<text>` node (`:119`), and returns a `TextNodeRenderable.fromString`.
  `shouldSetTextContent` returns `false` so text always becomes child text-instances
  rather than collapsing into a string prop.

The required-but-boring callbacks (priority plumbing
`setCurrentUpdatePriority`/`resolveUpdatePriority` defaulting to `DefaultEventPriority`,
suspense stubs `maySuspendCommit → false`, `preloadInstance → true`,
`detachDeletedInstance → destroyRecursively`) are ceremony imposed by
react-reconciler 0.31+. glyph's host config
(`context/glyph/packages/glyph/src/reconciler/hostConfig.ts`) has the identical
shape — same stubs, same `resetAfterCommit(container) → container.onCommit()`
(`:159`) which calls `scheduleRender`.

### 2. The minimal case: react-curse — one element type, trivial mutations

react-curse (`context/react-curse/reconciler.ts`) is the smallest real example.
`TextElement = {props, parent, children[]}`; `createInstance('text')` is the *only*
legal type (anything else throws `'must be <Text>'`); `appendChild`/`insertBefore`/
`removeChild` are plain array push/splice. No layout tree, no dirty flags — the whole
tree is re-rasterized into a `Char[][]` buffer every frame and diffed downstream. This
is the proof that the reconciler can be ~50 lines; all the complexity lives in
layout + diff, not the host config.

### 3. The Solid universal renderer: same idea, different callbacks

Solid doesn't use `react-reconciler`. It exposes `createRenderer({...})`
(solid-js universal renderer) with a different but parallel callback set. opentui's
(`context/opentui/packages/solid/src/reconciler.ts`, wired via
`packages/solid/src/renderer/index.ts`):

```ts
createRenderer<DomNode>({
  createElement(tagName)   { return new elements[tagName](solidRenderer, { id }) },  // :191
  createTextNode(value)    { return TextNode.fromString(decodeHTML(value), { id }) },
  insertNode(parent, node, anchor) { /* parent.add(node) or parent.add(node, anchorIndex) */ }, // :58
  removeNode(parent, node) { parent.remove(node.id); process.nextTick(destroyIfOrphan) },        // :111
  setProperty(node, name, value, prev) { /* events via on:/off, style merge, focus() */ },       // :220
  getParentNode, getFirstChild, getNextSibling,   // sibling/parent walking, used by Solid's <For>/<Show>
})
```

Differences worth noting versus React:

- **Property setting is explicit and switch-y** (`setProperty`, `:220`). `on:click`
  → `node.on('click', value)` / `node.off('click', prev)`; `focused` → `node.focus()`
  or `node.blur()` (`:254`); `onChange` maps to a *different event name per node type*
  (`SelectRenderableEvents.SELECTION_CHANGED` vs `InputRenderableEvents.CHANGE`, `:262`);
  the generic `style` case iterates props and skips unchanged ones (`:326`).
- **Solid needs tree-walking callbacks** React never asks for: `getFirstChild`,
  `getNextSibling`, `getParentNode` (`:357`–`:404`). These exist because Solid's
  control-flow components (`<For>`, `<Show>`) reconcile by walking the actual DOM-like
  node tree, not by diffing a VDOM.
- **There's no commit phase / no `resetAfterCommit`.** Solid is fine-grained: a signal
  write runs only the effect that touched that node, which calls `setProperty` directly.
  The "frame request" is the node setter's own `requestRender()`. This is structurally
  simpler than React's render→commit→reset cycle.
- **A `SlotRenderable` indirection** handles components that wrap a child
  (`getSlotChild`, `:69`) and a `ScrollBoxRenderable` parent-rewrite (`:170`) because the
  scrollbox delegates `add`/`remove` to an internal `content` wrapper four levels down,
  so `getParentNode` must climb back up so Solid's identity checks pass.

### 4. The node tree itself: opentui Renderable

`context/opentui/packages/core/src/Renderable.ts` is the canonical "node = renderable"
implementation. `BaseRenderable extends EventEmitter` (`:138`) declares the abstract
tree API: `add(obj, index?)`, `remove(id)`, `insertBefore(obj, anchor)`,
`getChildren()`, `requestRender()`. `Renderable` (`:206`) implements it and owns:

- A **Yoga layout node** (`this.yogaNode = Yoga.Node.create(yogaConfig)`, `:297`) kept
  structurally in sync. `add()` does `this.yogaNode.insertChild(childLayoutNode, idx)`
  (`:1223`); `insertBefore()` derives the index from `_childrenInLayoutOrder` (`:1299`).
- **Two child orderings**: `_childrenInLayoutOrder` (flow order) and
  `_childrenInZIndexOrder` (paint order); a `needsZIndexSort` flag (`:1207`).
- **Reparenting logic in `add`** (`:1202`): if the child already belongs to this parent
  it's removed from Yoga and re-inserted (a reorder), else `replaceParent` detaches it
  from its old parent first — exactly the move-vs-insert distinction React relies on.
- **Cached absolute coords** `_screenX/_screenY` (`:217`) so the render hot path never
  walks the parent chain for position.
- **A live count** (`_liveCount`, `propagateLiveCount`, `:486`) bubbled up the tree so
  the engine knows whether *any* descendant needs continuous animation (switching the
  scheduler between running and on-demand). `add`/`insertBefore` propagate the child's
  live count into the parent (`:1215`, `:1292`).
- **`requestRender()`** (`:505`) just forwards to `this._ctx.requestRender()` — every
  mutating setter (visibility, position, color, etc.) calls it. This is *the* reason the
  reconciler can be dumb.

opentui-ui (`context/opentui-ui`) shows the component-author side of the same contract:
`StyledRenderable extends Renderable`, draw in `protected renderSelf(buffer, deltaTime)`,
mutate via setters that call `this.requestRender()`. Leaf components draw directly with
`buffer.fillRect`/`buffer.drawText`; composite ones build a subtree of child
`BoxRenderable`/`TextRenderable` and let Yoga lay them out.

### 5. The parallel layout tree + dirty tracking: glyph's mutation ops

glyph (`context/glyph/packages/glyph/src/reconciler/nodes.ts`) is the clearest study of
"keep a Yoga tree structurally synced at mutation time, and be careful about dirtying."
Each `GlyphNode` owns a `yogaNode` (`:148`). Every mutation op
(`appendChild` `:167`, `insertBefore` `:249`, `removeChild` `:203`) does three things:
splice the GlyphNode children array, mirror the op into Yoga
(`yogaAppendChild`/`yogaInsertBefore`/`yogaRemoveChild`, `:317`–`:353`), and
`markLayoutDirty()`.

Non-obvious, hard-won decisions encoded here (these are the real lessons):

- **`appendChild`/`insertBefore` deliberately do NOT set `parent._paintDirty`**
  (`nodes.ts:180`). Adding a child doesn't change the parent's own pixels; eager
  parent-dirtying triggers a destructive pre-clear that wipes absolute-positioned
  overlays underneath. Layout shifts are detected later in `extractLayout`.
- **Yoga subtrees are freed synchronously in `removeChild`** via `freeYogaSubtree`
  (`:223`, `:397`), not deferred to React's `detachDeletedInstance`, to avoid zombie
  WASM objects between the mutation phase and passive-effects phase.
- **`getChild(i) === child.yogaNode` always fails** — yoga-layout's WASM bindings
  return a *fresh* JS wrapper each call. So the correct insert index is derived from the
  GlyphNode children array, never from Yoga identity (`yogaInsertBefore`, `:342`–`:352`).
- **`commitUpdate` keeps the old style reference when values are equal**
  (`hostConfig.ts:330`, `shallowStyleEqual`): React makes a new style object every render,
  but if the *values* match, keeping the old reference lets `resolveNodeStyles` skip →
  `syncYogaStyles` skip → the text raster cache hit. This is a per-commit cascade
  short-circuit and is the single most impactful perf decision in the reconciler.
- **`removeChild` calls `collectStaleRects(child)`** (`:208`) to record the removed
  subtree's screen area into `pendingStaleRects`, which the painter drains to clear
  ghosts — needed because an absolute dropdown's area falls *outside* the parent's rect.

### 6. No VDOM at all: rezi's own keyed reconciler

rezi (`context/rezi/packages/core/src/runtime/reconcile.ts`) has no React/Solid — the app
is `view(state): VNode`, and rezi reconciles the new VNode tree against the previous
committed instance tree itself. Worth studying because it shows what React does *for* you:

- **Fast path: unkeyed children match by index, no Map allocation**
  (`reconcileUnkeyedChildren`, `:119`). Only if either side `containsAnyKey` does it build
  a `prevBySlotId` map keyed `k:<key>` / `i:<index>` (`reconcileChildren`, `:194`).
- **Stable instance IDs** preserve local state/focus across reorders. Reused instances
  keep their `instanceId`; new ones get fresh allocations; unmatched prev instances are
  unmounted (`ReconcileChildrenOk`, `:39`).
- **Reuse requires same `kind` + matching composite widget key** (`canReuseVNode`, `:63`)
  — `kind` mismatch forces a remount.
- **Duplicate sibling keys are a fatal `ZRUI_DUPLICATE_KEY`** (`:25`), not a silent
  last-wins like the DOM.
- The companion `commit.ts` adds a **leaf-equality short-circuit**: if
  `prev.vnode.kind === vnode.kind && leafVNodeEqual(prev, vnode)` it reuses the instance
  untouched and clears dirty flags — the "nothing changed" path costs ~one comparison.

This is essentially a hand-rolled React reconciler scoped to TUI needs, with deterministic
error codes instead of throws so the same tree can be replayed/tested.

### 7. No tree diff at all: nberlette-tui's signals

nberlette-tui (`context/nberlette-tui/src/signals/`) skips reconciliation entirely. A
`Component` owns a `drawnObjects` map of `Renderable`s; component signals →
renderable rectangle/style/text signals → an Effect marks the object dirty and pushes it
onto `canvas.updateObjects`. There is no element tree to diff: a `signal.value` write
calls `propagate()` (only if `oldValue !== newValue`), which marks exactly the dependent
node dirty. `signalify(valueOrSignal)` lets every prop accept a static value *or* a
signal. The tradeoff: dependency tracking is **asynchronous** (a freshly created
Computed/Effect needs `await Promise.resolve()` before it sees deps), unlike Solid's
synchronous tracking — a real footgun called out repeatedly in their docs.

### 8. The commit→render handshake (how a frame gets scheduled)

Every repo decouples "React/Solid committed" from "paint", and coalesces:

- **opentui (React):** `resetAfterCommit → container.requestRender()` (`host-config.ts:97`).
  The core scheduler coalesces via `process.nextTick`/`setTimeout`, throttled to
  `minTargetFrameTime`, and the `_liveCount` decides running-vs-on-demand.
- **glyph:** `resetAfterCommit → container.onCommit() → scheduleRender()`, which
  coalesces via `queueMicrotask` (`render.ts`). Layout subscriber notifications are
  deferred to a *second* microtask after commit to avoid "Maximum update depth exceeded"
  from setState-during-commit.
- **react-curse:** `resetAfterCommit → throttle`, an fps-capped (`1000/60`) `setTimeout`
  that collapses a burst of commits into one repaint.
- **rezi:** a `TurnScheduler` drains all events/updates/render-requests in one
  `queueMicrotask` turn; a `renderRequestQueuedForCurrentTurn` flag dedupes so N updates
  → 1 frame. `update()` during render throws `ZRUI_UPDATE_DURING_RENDER`.

### 9. Focus & routing on the node tree

Four distinct strategies:

- **glyph — tree-order DFS, zero registration** (`render.ts:303`
  `getTreeOrderFocusables`): walk the live GlyphNode tree collecting any node with a
  `focusId` (auto-assigned to inputs and `focusable` nodes), skipping `hidden` subtrees.
  Tab/Shift-Tab cycle the filtered list; a stack of id-sets implements focus *traps* for
  modals; `skippableIds` (`:277`) excludes disabled elements; focus-on-click finds the
  nearest focusable *ancestor* of the hit node (`findFocusableAncestor`, `:203`).
- **rezi — engine-owned zones + traps + 2D grid** (`runtime/focus.ts`): focus is
  `FocusZone`s with `tabIndex`, `navigation`, `columns` (`:155`). `computeZoneMovement`
  (`:301`) handles in-zone spatial/grid moves via `computeGridMovement` (`:199`);
  `computeZoneTraversal` (`:376`) does Tab order: active trap > zone-to-zone > linear,
  constrained to the trap's focusables when a trap is on the stack. Pure functions over
  the committed tree — fully testable.
- **opentui — `ctx.currentFocusedRenderable` + node.focus()/blur()**: focus lives on the
  engine context; `Renderable.focus()` (`:392`) sets `_focused` and `requestRender()`.
  Solid sets it via the `focused` prop (`setProperty` `:254`); React via
  `setInitialProperties`. Mouse hit-testing uses the native O(1) hit grid → renderable
  number, then events bubble up `parent`.
- **termcast — cooperative context gating, no real capture**
  (`internal/focus-context.tsx`): `<InFocus inFocus={bool}>` provides a boolean; every
  `useKeyboard` handler guards `if (!inFocus) return`. `DialogProvider` sets children
  `inFocus={!dialogStack.length && !showActionsDialog}` so background content stops
  responding while an overlay is up. Modality with no input-capture machinery at all.

## Cross-repo comparison

| Repo | Reconciler tech | Node model | Diffs children? | Frame trigger | Focus model |
|---|---|---|---|---|---|
| **opentui (react)** | `react-reconciler` HostConfig, mutation mode | instance == core `Renderable` (Yoga node + Zig buffer) | React does it; `add`/`insertBefore`/`remove` | `resetAfterCommit → requestRender` | `ctx.currentFocusedRenderable`, `node.focus()`, native hit grid |
| **opentui (solid)** | solid-js universal `createRenderer` | same `Renderable`; `SlotRenderable` indirection | Solid walks tree (`getFirstChild`/`getNextSibling`) | setter `requestRender()`; no commit phase | `focused` prop → `focus()/blur()` |
| **glyph** | `react-reconciler` HostConfig, mutation mode | `GlyphNode` + parallel Yoga tree, dirty flags | React does it; manual Yoga sync per op | `resetAfterCommit → onCommit → scheduleRender` (microtask) | tree-order DFS, traps, skippable ids |
| **react-curse** | `react-reconciler`, single `<text>` primitive | `TextElement {props,parent,children}` | React does it; pure array ops | `resetAfterCommit → throttle` (60fps) | hooks-based, minimal |
| **rezi** | hand-rolled keyed/unkeyed VNode reconciler | `RuntimeInstance` w/ stable `instanceId` | **you** (keyed slots, leaf short-circuit) | `TurnScheduler` microtask, dedup flag | zones + traps + 2D grid, pure fns |
| **nberlette-tui** | none (fine-grained signals) | `Component` owns `Renderable`s; `signalify` | n/a — signal write marks node dirty | `canvas.render()` loop at refreshRate | `state` signal (`base/focused/active/disabled`) gates input |
| **termcast** | consumes opentui's | opentui `Renderable`s + custom `extend()`d ones | opentui/React | opentui | cooperative `<InFocus>` context gating |
| **opentui-ui** | headless core + thin React/Solid bindings | `StyledRenderable extends Renderable` | opentui/React/Solid | `requestRender()` | `ctx.currentFocusedRenderable` save/restore |
| **termui** | consumes Ink (Yoga) | Ink nodes | Ink | Ink | mount/unmount per imperative prompt |

Tradeoffs:

- **VDOM (React) vs universal renderer (Solid):** React forces a render→commit→reset
  cycle and a pile of suspense/priority stubs, but gives you batching + a familiar mental
  model. Solid is structurally simpler (no commit phase; setters fire directly) and
  faster for fine-grained updates, but you must supply tree-walking callbacks and a slot
  indirection for wrapper components.
- **Reconciler-you-own (rezi) vs library:** owning it buys determinism (error codes,
  replay), no React dep, and a leaf-equality short-circuit tuned for TUIs — at the cost of
  reimplementing keyed diffing and hooks-equivalents yourself.
- **Signals (nberlette-tui, Solid) vs VDOM (React):** signals avoid tree diffing
  entirely and update the minimum, ideal for high-frequency dashboards; but async dep
  tracking (nberlette-tui) and the lack of a "re-render everything from props" escape
  hatch make some patterns awkward. React's coarse re-render is simpler to reason about.
- **Node == renderable (opentui/glyph/opentui-ui) vs node → separate buffer ops
  (react-curse):** making the instance the live engine node keeps the reconciler thin and
  enables incremental dirty painting. react-curse's "rebuild the whole `Char[][]` each
  frame" is dead simple but leans entirely on the downstream cell diff for efficiency.

## Pitfalls & hard parts

- **Don't eagerly dirty the parent on child insert** (glyph `nodes.ts:180`). It triggers a
  destructive pre-clear that wipes absolute overlays. Let layout extraction dirty only the
  nodes that actually moved.
- **WASM/native node identity is not stable.** yoga-layout returns a fresh JS wrapper on
  every `getChild()`, so `===` comparisons fail — derive indices from your own children
  array (glyph `yogaInsertBefore` `:342`; opentui solid `insertInContainerBefore` `:241`).
- **Free native subtrees synchronously on `removeChild`, not in `detachDeletedInstance`**
  (glyph `freeYogaSubtree` `:397`; opentui solid `process.nextTick(destroyIfOrphan)` `:133`)
  — otherwise zombie native objects linger between commit and passive-effects.
- **Style-reference stability is a real perf lever.** React creates a new style object
  every render; if you naively assign it you defeat every downstream cache. Compare values
  and keep the old reference when equal (glyph `commitUpdate` `:330`).
- **Text is a special parent.** A `<text>` (or text-node) parent must reject element
  children / require a measure-leaf Yoga node, and raw text outside text throws (opentui
  `host-config.ts:120`; opentui solid orphan-text error `:78`). glyph guards
  `markDirty()` to only fire on measure-leaf nodes (`hostConfig.ts:304`) or Yoga asserts.
- **setState during commit explodes.** glyph defers layout-subscriber notifications to a
  microtask *after* commit to dodge "Maximum update depth exceeded" at high frame rates.
- **Reorders are moves, not delete+insert.** React calls `appendChild`/`insertBefore`
  for reorders (only true deletions go to `removeChild`); your op must detect "already a
  child" and reposition, preserving the node + its native resources (opentui
  `add` `:1202`; glyph splice-from-old-position in every op).
- **`map.current`-style descendant registries are stale during render** (termcast
  `descendants.tsx`): index is claimed in `useLayoutEffect`, the map is cleared every
  render, so it's only safe to read in effects/event handlers — never in render/`useMemo`.
- **Duplicate keys:** the DOM silently keeps last; rezi makes it fatal. Pick one and be
  loud — silent key collisions corrupt state preservation across reorders.

## If you were building this from scratch (recommended approach)

If you want React/Solid ergonomics, **make your node the renderable and keep the host
config thin.** Put dirty marking in the node setters, not the reconciler.

```ts
// 1. The node IS the renderable. Setters mark dirty + request a frame.
class Node {
  children: Node[] = []; parent: Node | null = null;
  yoga = Yoga.Node.create(cfg);
  private _dirty = true;
  set color(v) { if (v !== this._color) { this._color = v; this._dirty = true; ctx.requestRender(); } }
  add(child, index?) {
    if (child.parent === this) { this.yoga.removeChild(child.yoga); this.children.splice(this.children.indexOf(child),1); } // reorder
    else child.parent?.remove(child);                                                                                       // move
    const i = index ?? this.children.length;
    this.children.splice(i, 0, child); this.yoga.insertChild(child.yoga, i);                                                 // mirror to Yoga
    child.parent = this; ctx.requestRender();
  }
  remove(child) { this.yoga.removeChild(child.yoga); freeSubtree(child); /* sync */ this.children.splice(this.children.indexOf(child),1); }
}

// 2. React host config — almost all delegation.
const hostConfig = {
  supportsMutation: true,
  createInstance: (type, props) => new catalogue[type]({ id: nextId(type), ...props }),
  appendChild:  (p, c) => p.add(c),
  insertBefore: (p, c, before) => p.add(c, p.children.indexOf(before)),
  removeChild:  (p, c) => p.remove(c),
  commitUpdate: (inst, _t, oldP, newP) => {
    for (const k in newP) if (newP[k] !== oldP[k]) inst[k] = newP[k];   // setters self-dirty
  },
  resetAfterCommit: (container) => container.requestRender(),           // coalesced frame
  // ...the ~25 required stubs: priority → Default, suspense → false/true, detachDeletedInstance → destroy
};

// 3. Coalesced scheduler (decouple commits from paints).
let scheduled = false;
function requestRender() {
  if (scheduled) return; scheduled = true;
  queueMicrotask(() => { scheduled = false; layout(); paintDirty(); diffAndFlush(); });
}

// 4. Focus on the tree, not on React.
function focusables(root): Node[] {                 // tree-order DFS, skip hidden
  const out = []; (function walk(n){ if (n.hidden) return; if (n.focusable) out.push(n); n.children.forEach(walk); })(root);
  return out;
}
function onTab(shift) {
  const list = focusables(root).filter(n => !n.disabled);
  const i = list.indexOf(current);
  current = list[(i + (shift ? -1 : 1) + list.length) % list.length];
  current.focus();
}
```

Decisions, in order of impact:
1. **Node == renderable; setters self-dirty.** Makes the reconciler trivial and enables
   incremental painting.
2. **Maintain a parallel Yoga tree at mutation time**, indexing by your own children array
   (never native identity).
3. **Coalesce commits → one frame** via microtask/throttle; track a live-count for
   animation-driven continuous rendering.
4. **Compare style values, keep stable references** to short-circuit layout/paint/text
   caches.
5. **Focus = tree-order DFS over the node tree** (+ a trap stack for modals); upgrade to
   zones/grid (rezi) only if you need 2D spatial navigation.
6. If you don't want a VDOM dependency, write a **keyed/unkeyed reconciler with stable
   instance IDs** (rezi) — unkeyed-by-index fast path, keyed-slot map only when keys exist,
   leaf-equality short-circuit, fatal duplicate-key errors.

## Source map (where to read more)

- **opentui React HostConfig:** `context/opentui/packages/react/src/reconciler/host-config.ts`
  (createInstance `:48`, appendChild `:67`, resetAfterCommit `:97`, text context `:108`–`:125`);
  `reconciler/reconciler.ts`, `reconciler/renderer.ts` wire it up.
- **opentui Solid universal renderer:** `context/opentui/packages/solid/src/reconciler.ts`
  (createElement `:191`, insertNode `:58`, removeNode `:111`, setProperty `:220`,
  getFirstChild/getNextSibling `:357`–`:404`); `solid/src/renderer/index.ts`,
  `renderer/universal.d.ts`.
- **opentui node tree:** `context/opentui/packages/core/src/Renderable.ts` (BaseRenderable
  `:138`, Renderable `:206`, add `:1179`, insertBefore `:1233`, propagateLiveCount `:486`,
  focus `:392`).
- **glyph HostConfig + node model:** `context/glyph/packages/glyph/src/reconciler/hostConfig.ts`
  (commitUpdate style short-circuit `:315`, commitTextUpdate measure guard `:287`) and
  `reconciler/nodes.ts` (mutation ops `:167`–`:301`, Yoga sync helpers `:303`–`:404`,
  collectStaleRects `:118`, freeYogaSubtree `:397`); focus in `glyph/src/render.ts`
  (`getTreeOrderFocusables` `:303`, `findFocusableAncestor` `:203`).
- **react-curse minimal reconciler:** `context/react-curse/reconciler.ts`,
  `renderer.ts` (throttle frame loop).
- **rezi own reconciler + focus:** `context/rezi/packages/core/src/runtime/reconcile.ts`
  (canReuseVNode `:63`, reconcileUnkeyedChildren `:119`, reconcileChildren keyed `:194`),
  `runtime/commit.ts` (leaf short-circuit), `runtime/focus.ts` (computeZoneMovement `:301`,
  computeGridMovement `:199`, computeZoneTraversal `:376`).
- **nberlette-tui signals:** `context/nberlette-tui/src/signals/` (signal.ts, computed.ts,
  effect.ts, dependency_tracking.ts, signalify.ts); component/renderable split in
  `src/component.ts`, `src/canvas/renderable.ts`.
- **termcast compound-component patterns over a borrowed reconciler:**
  `context/termcast/src/descendants.tsx`, `internal/focus-context.tsx`,
  `internal/navigation.tsx`, custom renderables `components/graph.tsx` (`extend()`).
- **opentui-ui headless core + bindings:** `context/opentui-ui/packages/core/src/styled-renderable.ts`,
  `react/src/styled.ts`, `solid/src/styled.ts`.
- **termui (consumer of Ink):** `context/termui/packages/adapters/clack-ink/index.tsx`
  (mount/await/unmount-per-prompt bridge).
