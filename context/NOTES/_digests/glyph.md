# glyph

## What it is (1-2 lines)
A from-scratch React renderer for the terminal: a custom `react-reconciler` host config builds a `GlyphNode` tree, Yoga (flexbox) computes layout, a cell-grid framebuffer rasterizer paints into a `Cell[]`, a char-level diff emits minimal ANSI, and a single synchronized `stdout.write` flushes each frame. Comparable to Ink, but with its own diff engine, dirty-tracking, native-cursor handling, image protocols, and mouse/focus systems.

## Architecture (how the pieces fit; key files with paths)
Pipeline per frame (orchestrated in `packages/glyph/src/render.ts`, function `performRender` ~line 530):
1. **React → GlyphNode tree.** `reconciler/hostConfig.ts` implements the mutation-mode host config (`createInstance`, `appendChild`, `commitUpdate`, etc). `reconciler/nodes.ts` defines `GlyphNode` and all tree mutation ops, each mirroring the change into a parallel **Yoga tree** kept structurally in sync at mutation time. `reconciler/reconciler.ts` wires `react-reconciler` to the host config.
2. **Layout (Yoga).** `layout/yogaLayout.ts::computeLayout` resolves responsive styles, syncs only changed styles to Yoga, calls `calculateLayout`, then `extractLayout` walks the tree converting Yoga's float positions into rounded `LayoutRect`s (x/y/width/height + inner* for content box).
3. **Paint.** `paint/painter.ts::paintTree` collects z-sorted `PaintEntry`s, pre-clears stale regions, and rasterizes bg/border/text/input into a `Framebuffer` (`paint/framebuffer.ts`) — a flat `Cell[]` array.
4. **Diff & flush.** `paint/diff.ts::diffFramebuffers` compares prev/next framebuffers cell-by-cell and builds one ANSI string (cursor moves + SGR + chars) wrapped in DEC 2026 synchronized-update markers; `render.ts` does a single `terminal.write`.
5. **Swap.** `prevFb.copyFrom(currentFb)` (zero-alloc).

Runtime glue: `runtime/terminal.ts` (raw mode, alt screen, OSC filtering, palette query, signal cleanup), `runtime/input.ts` (ANSI/Kitty/SGR-mouse parser), `runtime/hitTest.ts` (mouse → node), `runtime/imageProtocol.ts` (Kitty/iTerm2 inline images). Context providers in `hooks/context.ts` expose input/focus/layout/mouse/image systems to components. Components in `components/*.tsx` (Box, Text, Input, ScrollView, Select, Table, etc.) are pure React on top of three host primitives: `box`, `text`, `input`.

The render loop is **demand-driven**, not a fixed framerate: `scheduleRender` coalesces via `queueMicrotask` (render.ts:521); React's `resetAfterCommit` calls `container.onCommit()` → `scheduleRender`.

## Core techniques (the actual TUI engineering)

### Cell-grid framebuffer with zero per-frame allocation
`Framebuffer` (framebuffer.ts) is a flat `Cell[]` of `width*height`. Cells are mutated in place — `allocCells` is the *only* place `Cell` objects are created (line 27). `clear`, `set`, `copyFrom` all mutate existing cells. Two persistent buffers (`prevFb`, `currentFb`) are kept and swapped, so steady-state rendering allocates nothing in the hot path.

### Char-level diff → minimal ANSI (diff.ts)
- Iterates every cell; on `!fullRedraw` skips cells equal to prev (`cellsEqual`, framebuffer.ts:145 compares ch + colors + all SGR flags).
- Tracks the terminal's *actual* cursor column accounting for wide chars (`cursorX = x + ttyCharWidth(nc.ch)`, diff.ts:171) so it only emits a cursor-move CUP when not already in position.
- Tracks `lastSGR` string and only re-emits SGR when style changes (diff.ts:162).
- **Output buffer is a reused `Buffer.allocUnsafe(64KB)`** that grows but never shrinks; ASCII escapes written as latin1 (1 byte), text as utf8 (diff.ts:15-37). Returns a string at the end.
- Wide-char continuation cells store `ch === ""` and are **skipped** in the diff loop (diff.ts:146) so the right half of a CJK/emoji glyph isn't overwritten.

### Synchronized output + auto-wrap discipline (the clever ANSI part)
Each frame is wrapped in `CSI ?2026h ... CSI ?2026l` (DEC 2026 synchronized update) so the terminal paints atomically — no tearing/flicker (diff.ts:88,203). Auto-wrap is disabled **every frame** (`CSI ?7l`) and re-enabled at the end (`CSI ?7h`), because writing the last column with auto-wrap on puts terminals into a "pending wrap" state that corrupts cursor positioning under synchronized output, especially on Kitty/Ghostty (diff.ts:103-113). Cursor is unconditionally hidden (`?25l`) at frame start as cheap insurance against state desync from image protocols. Full redraws use `CSI 2J` (full clear) rather than per-line `2K` because shrinking terminals reflow alt-screen content (diff.ts:115-131).

### Persistent Yoga tree + dirty tracking + edge-based rounding
- Yoga tree structure is maintained by the reconciler mutations (not rebuilt each frame). `computeLayout` has a fast-path early-out: if `!force && !isLayoutDirty()` it returns immediately (yogaLayout.ts:497). `markLayoutDirty()` is set on style changes, text-length changes, structural changes.
- **`pointScaleFactor = 0`** (nodes.ts:20) disables Yoga's per-node rounding; instead `extractLayout` rounds using edges: `x=round(rawX)`, `width=round(rawX+w)-x` (yogaLayout.ts:298-301). This guarantees adjacent siblings share a rounded edge — **zero gaps, zero overlaps**, a classic sub-pixel fence-post bug fixed correctly.
- `extractLayout` propagates *raw unrounded* absolute positions to children so rounding stays accurate across depth, and has a fast path skipping subtrees where `!hasNewLayout() && !parentMoved` (yogaLayout.ts:268).
- Text/input nodes are Yoga **leaves** with a `setMeasureFunc` callback that wraps/measures text (yogaLayout.ts:217-235). Yoga children are never added under text/input (nodes.ts:319).

### Two-pass dirty painting with stale-rect clearing
`paintTree` is incremental: on non-full frames it only repaints nodes where `entry.dirty` (node `_paintDirty` OR an ancestor dirty, computed in `collectPaintEntries`). Three clearing passes prevent ghosting (painter.ts:104-181):
- **Pass 0:** drain `pendingStaleRects` — areas of *removed* or *moved absolute* nodes (e.g. a closed Select dropdown) that fall outside any surviving node's rect, so marking a parent dirty wouldn't clear them. Pushed by `removeChild`/`extractLayout`.
- **Pass 1:** for each dirty node, clear its `_prevLayout` rect (it moved) or current rect (content changed), filling with the inherited bg.
- **Pass 2:** paint nodes in z-order.
The two-pass separation (clear ALL, then paint ALL) exists specifically so a node's old-position pre-clear can't wipe a freshly-painted sibling that shifted into that space (painter.ts:96-101).

### Text rasterization cache
`paintText` caches the fully-processed line layout (segments → parseAnsi → wrap → per-char style+width) keyed on text + innerWidth + styleRef + every inherited style field (painter.ts:500-519). When a text node is repainted only because an ancestor was dirty (its own content unchanged) it replays from cache via `paintFromCache`, skipping all wrapping/ANSI work. Cache is skipped for nested-Text nodes (children carry styles not tracked in the key).

### Unicode width done right (utils/ttyWidth.ts)
Hand-rolled `wcwidth`-style table instead of `string-width`, because `string-width` over-classifies BMP symbols (↗ ✓ ♥) as width 2 — terminals render them as 1. Uses `Intl.Segmenter` for grapheme clusters so ZWJ emoji (👨‍👩‍👧) and flags (🇺🇸) count as a single width-2 unit. Large explicit zero-width (combining marks, variation selectors) and width-2 (CJK/Hangul/fullwidth) ranges. `ttyCharWidth` ASCII fast-paths to 1.

### Input parsing: legacy + Kitty + SGR mouse (runtime/input.ts)
Single `parseInput(data)` walks the byte stream emitting `{kind:"key"|"mouse"}`. Handles: CSI sequences, SS3 (`ESC O`), Kitty keyboard protocol (`CSI code;mod u`), xterm modifyOtherKeys (`CSI 27;mod;code ~`), VT `~` sequences, Alt+char (`ESC` + printable), Ctrl combos (0x01-0x1a), and SGR mouse (`ESC [ < Pb;Px;Py M/m`) with button/modifier/motion/wheel bitmask decoding (input.ts:443). Modifier bits are 1-indexed in protocol, decoded via `applyModifiers` (input.ts:131).

### OSC response filtering + palette query (terminal.ts)
A stateful filter (`filterOsc`, terminal.ts:236) strips terminal *responses* (OSC `... BEL`/`ST`) out of the stdin stream before keys reach the parser — critical because `queryPalette` sends `OSC 4;i;?` for colors 0-15 and the replies would otherwise be parsed as keystrokes. A standalone `ESC` is disambiguated from a sequence prefix with a **50ms flush timer** (terminal.ts:225). Palette query resolves on 16 responses or 200ms timeout, then triggers a full redraw so theme-accurate colors apply.

### Native cursor handling
For focused inputs, the painter does NOT draw a block cursor; it returns the cursor's screen position+bg (`paintInput`), and `diffFramebuffers` emits a real terminal cursor: OSC 12 to set a contrast color (`getContrastCursorColor`) and `?25h` to show it, inside the sync block (diff.ts:192-200). Position/color are diffed against last frame to skip redundant escapes.

### Focus system (render.ts:274-448)
Focus is **tree-order, no explicit registration needed**: `getTreeOrderFocusables` DFS-walks the live GlyphNode tree collecting any node with a `focusId` (auto-assigned to inputs and `focusable` nodes), skipping `hidden` subtrees. Tab/Shift-Tab cycle the filtered list; focus *traps* (a stack of id-sets) scope navigation for modals; `skippableIds` excludes disabled elements. Focus-on-click finds the nearest focusable ancestor of the hit node.

### Mouse dispatch (render.ts:189-272)
`dispatchMouseEvent` hit-tests against the last frame's z-sorted paint entries (`runtime/hitTest.ts` reverse-iterates for topmost), then **bubbles** handlers up the parent chain (`onClick`/`onMouseDown`/`onWheel`/hover enter/leave). `onClick` fires on mousedown (not mouseup) because terminal press/release arrive as separate chunks and the target node may be stale by release (render.ts:239-243).

### Inline images (runtime/imageProtocol.ts)
Kitty Graphics Protocol (chunked base64, `a=T,f=100,c=,r=`, per-image `i=` id for deletion) and iTerm2 OSC 1337. tmux DCS passthrough by doubling all `ESC` bytes inside `ESC Ptmux; ... ESC \`. Pure-JS PNG/JPEG/GIF/WebP header parsing (`getImageDimensions`) to compute aspect ratio. Images are tracked in `renderedImages` and only re-sent when position/size changes (render.ts:134), painted *on top* of the framebuffer after the diff flush.

## Code patterns worth stealing

Demand-driven coalesced render scheduling:
```ts
let renderScheduled = false;
function scheduleRender() {
  if (renderScheduled) return;
  renderScheduled = true;
  queueMicrotask(() => { renderScheduled = false; performRender(); });
}
// react-reconciler hostConfig.resetAfterCommit -> container.onCommit() -> scheduleRender()
```

Style-reference stability to short-circuit the whole pipeline (hostConfig.commitUpdate):
```ts
const newStyle = newProps.style ?? EMPTY_STYLE;
if (newStyle !== instance.style && !shallowStyleEqual(instance.style, newStyle)) {
  instance.style = newStyle; instance._paintDirty = true; markLayoutDirty();
}
// else keep the OLD reference: resolveStyles skips -> syncYogaStyles skips -> textCache hits
```

Edge-based rounding for gapless siblings (pointScaleFactor=0):
```ts
const x = Math.round(rawX);
const width = Math.round(rawX + cl.width) - x;  // shares rounded edge with neighbor
```

Diff loop only emitting deltas:
```ts
if (!fullRedraw && pc && next.cellsEqual(nc, pc)) continue;   // unchanged cell
if (cursorY !== y || cursorX !== x) writeCursorMove(x, y);    // only move if needed
if (sgr !== lastSGR) { writeAscii(sgr); lastSGR = sgr; }      // only restyle if needed
writeStr(nc.ch); cursorX = x + ttyCharWidth(nc.ch);           // wide-char-aware advance
```

Wide-char continuation cell:
```ts
fb.setChar(x, y, "文", fg, bg);
if (ttyCharWidth(ch) === 2) fb.setChar(x + 1, y, "", fg, bg); // "" = skip in diff
```

## Gotchas / non-obvious decisions
- **`appendChild`/`insertBefore` deliberately do NOT set `parent._paintDirty`** (nodes.ts:180). Adding a child doesn't change the parent's own pixels; `extractLayout` dirties only nodes whose layout actually shifted. Eager parent-dirtying would destructively pre-clear and wipe absolute overlays.
- **Yoga `getChild(i) === child.yogaNode` always fails** — WASM bindings return a fresh JS wrapper each call. Insert index is derived from the GlyphNode children array instead (nodes.ts:342-352).
- **Yoga subtrees are freed synchronously in `removeChild`** (`freeYogaSubtree`), not deferred to React's `detachDeletedInstance`, to avoid zombie WASM objects between mutation and passive-effect phases (nodes.ts:215-223).
- **Layout subscriber notifications are deferred to a `queueMicrotask`** after commit (render.ts:554) — calling setState during the commit cycle triggers "Maximum update depth exceeded" at high frame rates.
- **`resetYogaNode` resets every property before applying style** (yogaLayout.ts:68) because React reuses host instances via `commitUpdate`; stale Yoga values would otherwise leak across view switches. Yoga uses `NaN` as "unset".
- **Stale-rect logic is skipped inside clip containers** (yogaLayout.ts:381): ScrollView's inner box moves every scroll tick; pushing stale rects would force a full-viewport repaint of all overlapping siblings.
- **Ctrl+Z uses `SIGSTOP` on pid 0** (whole process group), not `SIGTSTP` which Node ignores; `terminal.suspend()`/`resume()` restore terminal modes around it (render.ts:683-690).
- **`onClick` fires on mousedown**, and focus-blur is skipped when the target has an `onClick` ancestor, so Select dropdown items don't close before the click handler runs (render.ts:226-243).
- Custom `ttyWidth` exists *because* `string-width` v7 mis-measures BMP symbol/emoji glyphs.

## Relevance (which advanced-TUI topics this teaches)
- rendering-pipeline — full reconciler→tree→layout→framebuffer→diff→stdout loop with dirty tracking, double-buffering, and a text raster cache.
- layout — Yoga/flexbox integration, persistent tree, measure functions, edge-based sub-pixel rounding, clip/overflow.
- reconciler-component-models — a real `react-reconciler` host config (mutation mode), GlyphNode data model, three host primitives + React component library.
- input-keyboard-mouse — legacy + Kitty + xterm key parsing, SGR mouse decode, hit-test + event bubbling, tree-order focus with traps.
- ansi-escapes — DEC 2026 synchronized output, auto-wrap discipline, SGR minimization, OSC 12 cursor color, OSC 4 palette query + response filtering.
- unicode-text-width — hand-rolled wcwidth table + `Intl.Segmenter` grapheme clustering + wide-char continuation cells in the diff.
- terminal-images — Kitty + iTerm2 inline image protocols, tmux DCS passthrough, JS image-header dimension parsing.
- widgets-rich-content — ScrollView (virtualization via clip culling), Table, Select, Input (multiline + cursor), Markdown package.
- app-architecture — context-provider injection of input/focus/layout/mouse systems, AppHandle lifecycle, signal/cleanup handling.
