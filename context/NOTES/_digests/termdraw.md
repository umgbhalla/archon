# termdraw

## What it is (1-2 lines)
A terminal-native drawing/diagram editor (boxes, lines, elbows, freehand brush, text) built on `@opentui/core` + `@opentui/react`. It exports either rendered ASCII/Unicode art or an editable versioned `.td.json` document, and ships as an embeddable OpenTUI renderable, a standalone Bun CLI, and a Pi overlay island.

## Architecture (how the pieces fit; key files with paths)
Bun monorepo, three published packages. The engine lives entirely in `packages/opentui`; the others are thin shells.

- `packages/opentui/src/draw-state.ts` (2.8k LOC) — `DrawState`, the single source of truth: retained object model, tool/selection/cursor state, undo/redo, pointer state machine, a cached "scene" render, document parse/validate/export. Everything below it is pure helpers.
- `packages/opentui/src/draw-state/` — pure helper modules with no class state:
  - `types.ts` — object model (`BoxObject | LineObject | ElbowObject | PaintObject | TextObject`), tool enums, transient interaction state types, render-grid types.
  - `geometry.ts` — rect normalize/contains/intersect, perimeter cell extraction, clamp.
  - `line.ts` — Bresenham, Braille sub-cell line rendering, axis constraint, elbow routing, paint-stroke accumulation.
  - `scene.ts` — the intermediate canvas/color/connection grids and the box-join glyph table (4-bit direction mask → box-drawing char).
  - `object-utils.ts` — clone, bounds, render-cells, hit-test, translate.
- `packages/opentui/src/app.ts` — `TermDrawRenderable extends FrameBufferRenderable`: the OpenTUI renderable that owns lifecycle, callbacks, sizing, and the save-prompt modal; delegates layout/draw/input to `src/app/*`. Subclasses `TermDrawAppRenderable` (full chrome) and `TermDrawEditorRenderable` (bare canvas).
- `packages/opentui/src/app/` — `layout.ts` (chrome regions + palette hit-targets), `render.ts` (all `buffer.drawText`/`setCell` calls), `input.ts` (key/mouse dispatch → `DrawState` method calls), `theme.ts` (colors, glyph option tables, hotkeys), `startup-logo.ts` (gradient splash overlay), `types.ts`.
- `packages/opentui/src/text.ts` — grapheme-aware cell measurement/truncation/padding via `Intl.Segmenter`, plus text-object render/selection rectangles.
- `packages/opentui/src/react.ts` — registers the renderable classes with `@opentui/react`'s `extend()` and exposes `TermDraw`/`TermDrawApp`/`TermDrawEditor` function components.
- `packages/app/src/main.tsx` — CLI bootstrap: `createCliRenderer`, `createRoot().render(<TermDrawApp/>)`, stdin/tty handling, output formatting.

Mental model: **`DrawState` is a headless editor model; the renderable is a dumb view + input adapter.** All rendering reads from `DrawState` getters; all input calls `DrawState` mutators then `requestRender()`. The model never touches the buffer.

## Core techniques (the actual TUI engineering)

### Retained-mode object model + cached scene rasterization
Objects are stored as a flat z-ordered array (`DrawObject[]`), not as cells. Rendering is a two-phase rasterize into intermediate grids, cached behind a dirty flag:
- `ensureScene()` (`draw-state.ts:1792`) rebuilds 4 grids only when `sceneDirty`: `renderCanvas` (chars), `renderCanvasColors`, `renderConnections` (box-edge connectivity), `renderConnectionColors`. Objects are sorted by `z` then insertion index (`:1800-1801`) and painted in order.
- Reads go through `getCompositeCell(x,y)` (`:774`): if a literal ink char exists use it, else fall back to the computed box-join glyph. `getCompositeColor` mirrors this. `markSceneDirty()` is called by every mutator via `setObjects()`.
- The renderable's `renderSelf` (`app.ts:235`) clears the frame buffer then per-cell composites: `handleChar ?? marqueeChar ?? previewChar ?? state.getCompositeCell(x,y)` (`render.ts:391`). Overlays (cursor, selection, resize handles, drag previews) are computed on the fly as `Map<"x,y",char>` and layered above the cached scene — they never dirty the scene cache.

### Box joins via directional connection bitmask (the clever part)
Instead of storing literal corner chars, each box edge increments a per-cell, per-direction, per-style counter on *both* the cell and its reciprocal neighbor (`scene.ts:adjustConnection`, `:128`). At read time `getConnectionGlyph` (`scene.ts:245`) builds a 4-bit N/E/S/W presence mask and indexes a glyph table (`LIGHT_GLYPHS`/`HEAVY_GLYPHS`/`DOUBLE_GLYPHS`, `:38-93`) — so overlapping/touching boxes automatically render tees (`├┬`) and crosses (`┼`). Heavy beats light, double beats heavy for mixed overlaps. This is how diagrams "weld" at intersections with zero special-casing in the drawing code. `"auto"` box style picks light/heavy/double by **nesting depth** (`getAutoBoxConnectionStyle`, `:2028` — counts how many other boxes strictly contain this rect). Dashed boxes bypass the connection grid and paint a literal perimeter (`:1807`) because they don't join.

### Sub-cell Braille smooth lines
For "smooth" diagonal lines that aren't pure 45°, `getLineRenderCharacters` (`line.ts:141`) switches from single-glyph Bresenham to Braille rasterization: each terminal cell maps to a 2×4 dot grid (`BRAILLE_DOT_MASKS`, `:50`). It samples 8 sub-cell points (`BRAILLE_X_OFFSETS`/`Y_OFFSETS`), lights a dot if its squared distance to the ideal segment is under threshold (`:173`), and emits `String.fromCodePoint(0x2800 + mask)`. This gives ~4× vertical resolution so shallow/steep diagonals look like real lines. Falls back to a single glyph if no dots light.

### Elbow connectors with corner inference
`getElbowRenderCharacters` (`line.ts:197`) routes horizontal-first or vertical-first via a computed corner point, lays Bresenham runs for each leg, then picks the corner glyph (`╔╗╚╝` etc.) from which directions actually connect, and appends a directional arrowhead (`>`,`<`,`v`,`^`) at the end.

### Pointer state machine
`handlePointerEvent` (`draw-state.ts:510`) is one switch over `down/drag/up/scroll` driving mutually-exclusive transient states (`pendingBox`, `pendingLine`, `pendingPaint`, `pendingSelection`, `dragState`, `eraseState`). On `down` it first tries `tryBeginObjectInteraction` (resize-handle → endpoint → move hit-test) before starting a new-shape gesture for the active tool. `hasActivePointerInteraction` (`:462`) is the OR of all transient states and is used to suppress palette clicks mid-drag. Scroll wheel cycles the active tool's style. Coordinates are translated from screen → canvas by subtracting `canvasLeftCol`/`canvasTopRow` and clamped; `event.shift` constrains lines to an axis or flips elbow routing.

### Undo/redo via full snapshots
`createSnapshot()` (`:1742`) deep-clones the entire object array plus selection/cursor/counters; `pushUndo()` (`:1758`) caps history at `MAX_HISTORY=100` and clears redo. Simple and correct for a small document; no command/diff objects. `restoreSnapshot` re-clamps objects into the current canvas and recomputes parent assignments, so undo survives a resize.

### Input/render separation
`input.ts` translates OpenTUI `KeyEvent`/`MouseEvent` into `DrawState` method calls and returns `handled: boolean`; it owns no state. Printable detection (`isPrintableKey`, `:39`) rejects ctrl/meta/escape-prefixed raws and requires `visibleCellCount(raw) === 1`. Mouse handling (`:73`) hit-tests palette buttons/style rows/swatches first (consuming the event) before forwarding canvas events as a normalized `PointerEventLike`. Every handler ends `requestRender()` + `preventDefault()` + `stopPropagation()`.

### Grapheme-correct text width
`text.ts` uses a module-level `Intl.Segmenter(granularity:"grapheme")` for all width math (`splitGraphemes`, `visibleCellCount`, `truncateToCells`, `padToWidth`) so emoji/combining marks count as one cell instead of multiple UTF-16 units. Used everywhere chrome lays out fixed-width regions.

### Layout as pure geometry + shared hit-targets
`layout.ts:getLayout` computes chrome regions from `(width,height)`; `getToolButtons`/`getContextualStyleButtons`/`getColorSwatches` return geometry objects consumed by *both* `render.ts` (to draw) and `input.ts` (to hit-test) — single source of truth for "where is the Box button". Below `MIN_WIDTH/MIN_HEIGHT`, full chrome is replaced by a centered "terminal too small" message (`render.ts:46`, `app.ts:241`).

## Code patterns worth stealing

Dirty-flag cached rasterization (rebuild only on mutation, read cheap):
```ts
private sceneDirty = true;
private ensureScene() { if (!this.sceneDirty) return; /* rebuild grids */ this.sceneDirty = false; }
private setObjects(next) { this.objects = next; this.markSceneDirty(); }
getCompositeCell(x,y){ this.ensureScene(); const c=this.renderCanvas[y][x]; return c!==" "?c:this.getConnectionGlyph(x,y); }
```

Layered cell composition with a clean precedence chain:
```ts
const cell = handleChar ?? marqueeChar ?? previewChar ?? state.getCompositeCell(x, y);
```

Reciprocal connection counting so box joins "just work":
```ts
// increment this cell's edge AND the neighbor's opposite edge
source[style] += delta;
grid[ny][nx][OPPOSITE_DIRECTION[direction]][style] += delta;
// read-time: 4-bit mask → glyph table
let mask=0; for (const d of DIRECTIONS) if (present(d)) mask|=DIRECTION_BITS[d];
return (hasDouble?DOUBLE:hasHeavy?HEAVY:LIGHT)[mask];
```

Braille sub-cell line: sample dot positions, threshold distance, emit `0x2800 + mask`.

Shared layout geometry drives both draw and hit-test:
```ts
const btn = getToolButtons(layout, mode).find(b => isInsideRect(x,y,b.left,b.top,b.width,b.height));
if (btn && down && left) state.setMode(btn.mode);   // input.ts
drawToolButton(buf, mode, btn);                      // render.ts
```

Headless model + thin renderable: `handleKeyPress`/`onMouseEvent` just call model mutators then `requestRender()`; `renderSelf` only reads getters.

OpenTUI React binding: `extend({ "term-draw": RenderableClass })` then `React.createElement("term-draw", props)`.

## Gotchas / non-obvious decisions
- **Coordinate spaces are easy to confuse:** screen → renderable (`event.x - this.x`) → canvas (`- canvasLeftCol/canvasTopRow`). Canvas insets differ by `chromeMode` (`getCanvasInsets`); full chrome reserves header/footer/palette.
- **Overlays are recomputed every frame, scene is cached.** Cursor/selection/preview/handles intentionally do *not* mark the scene dirty — they're separate `Map`s layered at composite time, so dragging a preview doesn't invalidate the cached rasterization.
- **Undo stores whole-document snapshots, not commands.** Fine at ≤100 entries / small docs; would not scale to large canvases.
- **`exportArt` re-runs `ensureScene` then trims trailing whitespace per line and blank top/bottom lines** (`:1216`) — export and on-screen render share the exact composite path, so WYSIWYG is guaranteed.
- **Document is versioned and strictly validated** (`validateDrawDocument`, `:293`): every field is type/enum-checked, duplicate ids rejected, legacy `elbow` `"smooth"` style migrated to `"light"` (`readElbowLineStyle`, `:174`). Loading resets all tool/history state.
- **`"auto"` box weight is recomputed live from nesting depth**, so adding an outer box can change an inner box's stroke weight at render time — the stored style stays `"auto"`.
- **`autoFocus` uses `queueMicrotask` guarded by `isDestroyed`** to focus after mount without racing teardown (`app.ts:171`).
- **CLI reads the editable doc from a TTY even when stdin is a pipe**: `--load -` with piped stdin opens `/dev/tty` separately for the interactive session (`main.tsx:30`, `getInteractiveStdin`).
- **`exitOnCtrlC: false` + `cancelOnCtrlC`** — the app intercepts Ctrl+C itself to route through the cancel callback rather than hard-exiting, so it can clean up the renderer and emit "Drawing cancelled".

## Relevance (which advanced-TUI topics this teaches)
- rendering-pipeline: dirty-flag cached rasterization, two-phase composite, intermediate grids, shared export/display path.
- reconciler-component-models: retained object model over an immediate-mode buffer; OpenTUI `FrameBufferRenderable` subclassing; `@opentui/react` `extend()` binding.
- input-keyboard-mouse: full pointer state machine, drag/resize/marquee, palette hit-testing, scroll-to-cycle, grapheme-aware printable detection.
- ansi-escapes: box-drawing glyph tables, Braille sub-cell rendering, directional connection welding.
- unicode-text-width: `Intl.Segmenter` grapheme cell counting, truncation/padding.
- layout: pure-geometry chrome layout shared by draw + hit-test, min-size fallback, centered modal overlay.
- app-architecture: headless editor model vs. thin view, callback-based save/cancel, versioned document persistence, monorepo split (engine / CLI / embed).
- widgets-rich-content: tool palette, contextual style rows, color swatches, modal save prompt, gradient startup splash.
