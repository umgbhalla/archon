# melker

## What it is (1-2 lines)
A Deno/Node TUI engine ("Melker Engine") where apps are HTML-like `.melker` documents: declarative markup + `<style>` CSS + `<script>` handlers, rendered to ANSI terminals via a dual-buffer diffing pipeline with flexbox layout and sextant/quadrant pixel-canvas rendering. Distinctive angle: apps are readable documents you run from a URL inside a permission sandbox.

## Architecture (how the pieces fit; key files with paths)
Document-first pipeline: `.melker` file → HTML parse → `Element` tree → flexbox layout → dual-buffer render → ANSI diff to terminal.

- `src/template.ts` — `.melker` parser. Uses an HTML5 parser (`parseHtml` from deps), splits the `<melker>` wrapper into `<script>`, `<style>`, `<title>`, `<oauth>`, `<help>`, `<messages>` (i18n), `<policy>`, and UI elements. Converts the AST to `Element`s via `createElement`. Also doubles as a *bundler front-end* (`parseMelkerForBundler`) that extracts script blocks and event handlers (`onClick="..."`) with source ranges by regex, assigning each a stable handler id.
- `src/element.ts` / `src/types.ts` — React-like `createElement(type, props, ...children)`, abstract `Element` base, component registry. Capability interfaces are duck-typed: `Renderable`, `Focusable`, `Clickable`, `Draggable`, `Wheelable` with `isRenderable(el)` etc. guards.
- `src/document.ts` — `Document` wraps the root element, provides `getElementById`, `getElementsByType`, `focus()`.
- `src/layout.ts` (1.7k lines) — single flexbox engine. Border-box model, main/cross-axis resolution, flex-grow/shrink distribution, wrap into lines, justify/align.
- `src/buffer.ts` — `TerminalBuffer` (2D `Cell[][]`), `DualBuffer` (current/previous + dirty-row tracking), `DiffCollector` (fast-path that emits `BufferDiff[]` without a 2D array).
- `src/renderer.ts` — `TerminalRenderer`: turns `BufferDiff[]` into minimal ANSI (cursor moves, SGR runs, OSC 8 links), wraps frames in synchronized-output markers.
- `src/engine.ts` (2.5k lines) — lifecycle + render orchestration; three render paths (full / cached-layout / fast input). Delegates to handler modules: `engine-keyboard-handler.ts`, `engine-mouse-handler.ts`, `engine-buffer-overlays.ts`, `focus-navigation-handler.ts`, `scroll-handler.ts`, `text-selection-handler.ts`.
- `src/input.ts` — raw-mode stdin parser: escape sequences, SGR mouse, bracketed paste, modifier keys, terminal-capability detection (sixel/kitty) interleaved on the same stdin.
- `src/ui-animation-manager.ts` — one shared timer for all animations, Nyquist-based adaptive tick, drift correction.
- Canvas pixel graphics: `src/components/canvas-terminal.ts` (sextant/quadrant/ASCII char tables), `canvas-render-sextant.ts`, `canvas-render-quadrant.ts`, plus sixel/kitty/iTerm2 true-graphics overlay path in `graphics-overlay-manager.ts`.

## Core techniques

### Dual-buffer diffing with dirty-row tracking (`src/buffer.ts`)
- `DualBuffer` keeps `_currentBuffer` + `_previousBuffer`. Each frame: render into current, `swapAndGetDiff()` returns changed cells, then swap and clear.
- **Dirty-row optimization:** the current buffer is given `setDirtyTracking(referenceBuffer, dirtyRows: Set<number>)`. Every `setCell` compares the written cell against the *previous frame's* cell and, if different, adds `y` to the dirty set (`buffer.ts:343-349`). `_computeDirtyDiff()` then scans only dirty rows instead of the full grid (`buffer.ts:793`). `markForceNextRender()` forces a full diff (used on dialog open). Resize marks all rows dirty.
- **No per-cell allocation in the hot path:** `setCell` mutates the existing `Cell` object in place field-by-field rather than replacing it (`buffer.ts:295-339`), and `clear()` resets fields in place. Cells in the diff are passed *by reference* (not cloned) because the buffer holding them won't be mutated until the next frame (`buffer.ts:792`).
- Stats (cell counts, render timing) are only computed when the Performance Dialog is open — otherwise just cheap counters.

### Wide-character correctness (`buffer.ts` + `char-width.ts`)
- `_wideCharMap: boolean[][]` tracks which cells belong to a 2-wide glyph. A wide char writes the glyph + a continuation cell (`char: ''`, `width: 0`, `isWideCharContinuation: true`). Overwriting either half clears both (`_clearWideCharAt`).
- `char-width.ts` is a hand-rolled wcwidth: control = -1, combining/ZW = 0, CJK/emoji = 2, else 1. Fast ASCII path in `setCell`: codes 32–126 are width 1 without calling `getCharWidth`.

### ANSI output minimization (`src/renderer.ts`)
- Diffs are sorted by (y, x), then consecutive cells on a row are emitted as a single string with one cursor move (`\x1b[y+1;x+1H`) — cursor moves only when position breaks (`renderer.ts:202-284`).
- SGR codes are emitted *only on style change*; `_getOptimizedStyleCode` computes whether a reset is needed (attribute turned off) and emits just the deltas. `lastStyle` is carried across cells.
- OSC 8 hyperlinks are tracked independently of SGR because a reset does not close a link (`renderer.ts:383-390`).
- Whole frame is wrapped in `ANSI.beginSync`/`endSync` (synchronized output, DEC 2026) to prevent tearing (`renderer.ts:426`).
- 16-color mode runs `_ensureContrast`: if fg/bg grayscale levels are <2 apart it bumps the bg so text stays visible.

### Three render paths (`agent_docs/architecture.md`, `engine.ts`)
- **Full render** — layout + buffer + diff. Used for any event that could change the tree/focus/scroll/animation that affects layout.
- **Cached-layout render** (`renderCachedLayout()`) — `renderer.render()` caches its `LayoutNode` tree; this path re-renders to the buffer reusing cached positions, skipping `calculateLayout()`. Safe ONLY when just pixel data / buffer overlays changed (shader frame, video frame, toast, tooltip, spinner tick). Falls back to full render if no cache.
- **Fast input render** — for Input/Textarea keystrokes: update state, render to buffer using cached bounds via the `DiffCollector` (avoids O(w×h) copy), output the diff immediately (~2ms), then schedule a full render on a 16ms debounce (`engine.ts:434` `createDebouncedAction(..., 16)`).
- Safety model is explicit opt-in: a `requestCachedRender` callback is threaded alongside `requestRender`; components choose. Pending renders from the render lock always promote to full render.

### Sextant pixel canvas (`canvas-terminal.ts`, `canvas-render-sextant.ts`)
- Each terminal cell encodes a **2×3 pixel block** using Unicode sextant glyphs (U+1FB00 range). `BLOCKS_2X3` maps a 6-bit pattern → glyph; `PIXEL_TO_CHAR[64]` is a flat lookup array (faster than a Map). Also `PIXEL_TO_QUAD[16]` (2×2 quadrants, near-universal font support) and `PATTERN_TO_ASCII` (density-ramp fallback for no-Unicode terminals: `--gfx-mode=block|pattern|luma`).
- Render samples a 2×3 grid from the pixel buffer per cell, tracking two layers (drawing + image) separately. Because a cell has only one fg + one bg color, it must **quantize 6 colors into 2 groups**: `quantizeBlockColorsInline` splits by median brightness (luma `(r*77+g*150+b*29)>>8`), averages each group → fg/bg, sets the sextant bit for "on" (brighter) pixels (`canvas-render-sextant.ts:19`). Special cases: all-same color, drawing-over-image two-color optimization, image-only quantization.
- The whole render loop is **manually unrolled** (3 rows × 2 cols) and the quantizer is intentionally duplicated between sextant/quadrant paths — a shared function would block V8 inlining on the hottest per-cell-per-frame path (see header comment, `canvas-render-sextant.ts:2-5`).
- Edge workaround: skips the last column when the canvas hits the exact terminal right edge to avoid sextant autowrap glitches.

### Input parsing (`src/input.ts`)
- Raw mode enabled BEFORE terminal setup (else `ENOTTY`). One read loop decodes bytes, handles **partial escape sequences** by buffering an incomplete tail (`_pendingEscape`) until the next read (`input.ts:303-310`).
- **Bracketed paste**: text between `\x1b[200~` and `\x1b[201~` is extracted as a `paste` event (newlines normalized) and bypasses char-by-char key processing — avoids treating pasted control chars as shortcuts.
- SGR mouse sequences parsed to mousedown/up/move/wheel; coords converted 1-based→0-based. `mapMetaToAlt` defaults true for macOS Option key.
- Terminal graphics capability detection (sixel/kitty) writes query escapes and reads responses off the *same* stdin via `feedDetectionInput`, avoiding orphaned reads that would swallow Ctrl+C.

### Flexbox layout (`src/layout.ts`)
- Single engine. Resolves main/cross axis from `flexDirection`, computes `mainAxisSize`/`crossAxisSize`, breaks children into lines for `flex-wrap` (`layout.ts:592`), then distributes free space: positive → `flexGrow` share, negative → `flexShrink * hypotheticalMain` weighted (`layout.ts:626-644`). Border-box throughout. `fill` auto-sets `flexGrow:1` (`layout.ts:1035`). `display:flex` is auto-inferred when flex props are present. NaN axis falls back to block layout.

### Centralized animation timer (`src/ui-animation-manager.ts`)
- One timer; components `register(id, cb, intervalMs, {affectsLayout})`. Tick = `max(MIN_TICK, min(intervals)/2)` (Nyquist). Drift correction advances `lastTick += interval`, resetting only if >1 interval behind (no catch-up spam). Per-tick it tracks which callbacks requested a render and whether any `affectsLayout` — if none do, it dispatches `renderCachedLayout()` instead of a full render.

## Code patterns worth stealing

Dirty-row diffing driven by the write path itself:
```ts
// On every setCell, compare against previous frame and mark the row dirty
if (this._dirtyRows && this._referenceBuffer) {
  const ref = this._referenceBuffer._cells[y]?.[x];
  if (!ref || !this._cellsEqualDirect(written, ref)) this._dirtyRows.add(y);
}
// Diff scans only dirty rows, not w×h
for (const y of this._dirtyRows) { /* compare row */ }
```

In-place cell mutation to kill GC pressure (no `{...cell}` per write):
```ts
const target = this._cells[y][x];
target.char = cell.char; target.foreground = cell.foreground; /* ...all fields */
```

ANSI run-length output — one cursor move + style only on change:
```ts
if (currentX !== diff.x || currentY !== diff.y) output.push(`\x1b[${diff.y+1};${diff.x+1}H`);
while (sameRow && contiguous) {
  if (styleChanged(last, next)) { flush(chars); output.push(styleDelta(last, next)); last = next; }
  chars += cell.char; expectedX += cell.width;
}
```

Sextant: 6 pixels → 1 fg + 1 bg via brightness split, then 6-bit pattern → glyph:
```ts
const luma = (r*77 + g*150 + b*29) >> 8;           // integer luma
// brighter-than-median pixels => fg group (bit on), rest => bg group
const pattern = (px[5]?1:0)|(px[4]?2:0)|(px[3]?4:0)|(px[2]?8:0)|(px[1]?16:0)|(px[0]?32:0);
const char = PIXEL_TO_CHAR[pattern];               // flat 64-entry lookup
```

Wrap each frame in synchronized output to prevent tearing:
```ts
stdout.writeSync(enc(ANSI.beginSync + frame + ANSI.endSync)); // CSI ?2026h ... l
```

## Gotchas / non-obvious decisions
- **Cached-layout render is unsafe by default.** Only callers certain they didn't touch layout may call it; everything ambiguous (including the render-lock's pending renders) promotes to a full `render()`. The mapping of trigger→path is enumerated in `architecture.md`.
- **Diffs reference live cells, not copies** — correctness depends on the swap-then-clear ordering: the buffer holding diffed cells becomes `_previousBuffer` and is not mutated until next frame.
- **Hot-path duplication is intentional**: sextant and quadrant quantizers are copy-pasted to preserve V8 inlining; the sextant loop is hand-unrolled.
- **Init order is load-bearing**: raw mode must precede terminal setup or you get `ENOTTY`. On `stop()`, `_isInitialized=false` is set first and all render paths guard on it to avoid writing garbage after exit.
- **No reactivity in `.melker` apps.** Props are updated imperatively (`$melker.getElementById('id').props.x = v`); event handlers auto-render after completion unless `$melker.skipRender()`. Primitive script exports are copied by value (use setters).
- **HTML5 parser quirks worked around in `template.ts`**: self-closing `<script/>`/`<style/>` are rewritten to explicit pairs; `<graph>` inner content is entity-escaped so embedded `<button>` isn't parsed as real elements; handlers/scripts are also re-extracted by regex for the bundler so source offsets line up after script removal.
- Style **inheritance is deliberately limited** to color/bg/weight/style/decoration/dim/reverse/borderColor/opacity; opacity multiplies down the tree (CSS semantics); layout props never cascade.
- Last canvas column dropped at terminal right edge to dodge sextant autowrap artifacts.

## Relevance (advanced-TUI topics this teaches)
- rendering-pipeline — three-tier render paths, dual buffer, dirty-row diffing, synchronized output, in-place cell mutation.
- reconciler-component-models — HTML→Element tree, `createElement`, duck-typed capability interfaces, document model; imperative (non-reactive) update model.
- layout — full flexbox (grow/shrink/wrap/justify/align) with border-box on a character grid.
- ansi-escapes — minimal SGR delta encoding, OSC 8 links, cursor-run batching, DEC 2026 sync, alt-screen/mouse/keypad setup.
- unicode-text-width — wcwidth implementation, wide-char continuation cells, wide-char map invariants.
- input-keyboard-mouse — raw-mode parser, partial-escape buffering, bracketed paste, SGR mouse, capability-probe interleaving.
- terminal-images — sextant/quadrant/ASCII pixel encoding + 6-to-2 color quantization; plus sixel/kitty/iTerm2 true-graphics overlays.
- widgets-rich-content — 30+ components (tables, markdown, canvas, video, command palette, split panes, data viz).
- app-architecture — engine lifecycle, handler-module decomposition, centralized animation timer, document-as-app sandbox model.
