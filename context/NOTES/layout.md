# layout

How a TUI turns a styled tree into rectangles, then maps those rectangles onto a fixed grid of terminal cells. Two distinct families show up in the corpus:

1. **Flexbox engines** that compute a tree of float boxes (Yoga in `opentui`/`glyph`; a hand-rolled flexbox in `melker`), which a renderer then snaps to integer cells.
2. **One-shot string formatters** that do their own bespoke layout math — the box model (`boxen`) and the table grid (`cli-table3`) — with no tree, no diff, no engine.

Both families share one non-negotiable subsystem: **measuring in display columns, not string length** (`string-width` / wcwidth). That is the real fence everything is built behind.

## TL;DR (the mental model)

- **Layout = solve for boxes, then snap to cells.** A flex engine works in floats (it must, to distribute fractional free space); the integer-cell grid is a separate, later rounding step. Keeping these two coordinate systems straight is the whole game.
- **The terminal cell grid forces two things CSS doesn't:** (a) `pointScaleFactor`/edge-rounding so adjacent boxes never gap or overlap by 1 cell, and (b) **measure functions that count display columns** (CJK/emoji = 2, combining = 0, ANSI = 0), because `.length` lies.
- **Text is a Yoga leaf with a `measureFunc`** — Yoga calls it repeatedly with different `MeasureMode`s (Undefined=intrinsic, AtMost=fit, Exactly=stretch) and a node with a measure func **cannot have children**. This is the seam where wrapping + width-counting plug in.
- **Box model in a TUI is integer cells:** border = exactly 1 cell each side, padding/margin in whole cells. `content = outer − 2·border − padL − padR`. Off-by-2 bugs live in the outer-vs-content coordinate confusion.
- **Tables are the hard case of layout** because of col/row spans: a sweep-line grid allocator places cells, then a two-phase width distribution (seed minimums from simple cells, then let spanners only *grow* the columns they cover, spreading the deficit).

## How it actually works (mechanism, step by step)

### A. Flex layout via Yoga: the node tree, measure, dirty propagation

Yoga (`context/yoga/`) is a pure CSS-flexbox engine — no rendering, no ANSI. It answers one question: *given this node tree and these styles, where does every box go?* A TUI supplies `measureFunc`s for text leaves and reads `getComputedLayout()` back.

**The two-phase algorithm.** Every recursive call in `CalculateLayout.cpp` carries a `performLayout` bool. When `false`, Yoga only wants *dimensions* (to resolve flex bases and probe children); positions are not committed. When `true`, it commits final position/dimension. Because flex resolution must measure children under several trial constraints before one real layout, **measure passes vastly outnumber layout passes** — which is why the measurement cache matters.

**The generation-counter cache (the clever core).** `calculateLayoutInternal` (`CalculateLayout.cpp:2498`) gates every node:
```cpp
const bool needToVisitNode =
    (node->isDirty() && layout->generationCount != generationCount) ||
    layout->configVersion != node->getConfig()->getVersion() ||
    layout->lastOwnerDirection != ownerDirection;
```
A global atomic `gCurrentGenerationCount` is bumped once per top-level `calculateLayout()` (`CalculateLayout.cpp:2707`). That forces each dirty node to be visited at least once per tree layout, but lets repeated visits *within* a pass hit cache. `canUseCachedMeasurement` (`Cache.cpp:45`) is **not** an equality check — it understands sizing semantics: a FitContent request can reuse an old MaxContent result if it still fits (`oldSizeIsMaxContentAndStillFits`). Comparisons are against pixel-grid-rounded available sizes (`Cache.cpp:64`) so sub-pixel jitter doesn't cause spurious misses.

**Dirty propagation.** `Node::markDirtyAndPropagate()` (`Node.cpp:453`) walks *up* to the owner marking ancestors dirty, and short-circuits if already dirty — so dirtying is O(depth), and a no-op style write costs nothing. Only nodes with a measure func may be explicitly `markDirty()`'d by the host (a text leaf whose content changed). After layout, the host diffs via `hasNewLayout()` and acks with `markLayoutSeen()`.

**The contract for TUIs:** text/input nodes are Yoga leaves with `setMeasureFunc`; a measured node *cannot* have children (asserted in `Node.cpp:138`). `MeasureMode` must be respected and the measurer must be cheap/cached.

### B. Mapping flex output to a cell grid — the rounding problem, two answers

This is where the two real Yoga consumers diverge, and it's the single sharpest cross-repo contrast in the corpus.

**glyph: `pointScaleFactor = 0` + manual edge-based rounding.** `nodes.ts:19-20` creates the config with rounding disabled:
```ts
export const yogaConfig = Yoga.Config.create();
yogaConfig.setPointScaleFactor(0);  // Yoga returns raw floats; we round ourselves
```
Then `extractLayout` (`yogaLayout.ts:295-301`) rounds **absolute edges**, not extents:
```ts
const rawX = parentRawX + cl.left;          // raw float, accumulated from root
const x = Math.round(rawX);
const width = Math.round(rawX + cl.width) - x;   // NOT round(cl.width)
```
Children are passed the **raw unrounded** parent position (`extractLayout(child, rawX, rawY, …)`, `yogaLayout.ts:459`) so rounding stays sub-pixel-accurate across depth. The payoff: two adjacent siblings compute the same rounded value for their shared edge → **zero gaps, zero overlaps**. This is the classic fence-post bug solved correctly, and it's exactly the trick Yoga's own `PixelGrid.cpp:65` uses internally (`width = round(absLeft+width) − round(absLeft)`).

**opentui: `pointScaleFactor = 1` — let Yoga round to the integer grid.** `Renderable.ts:204` sets `yogaConfig.setPointScaleFactor(1)`, so `getComputedLayout()` already returns integers snapped to a 1-unit grid (Yoga's `roundLayoutResultsToPixelGrid` does the edge-rounding in C++). `updateFromLayout` (`Renderable.ts:1079`) then just reads them and caches absolute screen coords:
```ts
this._x = layout.left; this._y = layout.top;
this._screenX = parentScreenX + this._x + this._translateX;  // 1098
this._screenY = parentScreenY + this._y + this._translateY;
```
A frame-id guard (`_lastLayoutFrame === frameId`, `:1082`) skips the FFI round-trip on repeated calls within a frame. Note `Math.max(layout.width, 1)` (`:1101`) — never zero-size a renderable.

**Which is better?** Both are correct because both round *edges*. glyph's `factor=0` gives it control to thread raw floats through its own incremental extractor and is the right call when you do the rounding anyway. opentui's `factor=1` is simpler — it trusts Yoga's `PixelGrid` and reads integers — and is the natural choice when Yoga is the source of truth. The wrong approach (neither repo does) is `round(width)` independently per node, which produces 1-cell seams.

**melker** has no Yoga at all — `src/layout.ts` (~1.7k lines) is a hand-rolled flexbox over a border-box model. Its grow/shrink (`layout.ts:618-659`) mirrors Yoga's: positive free space → `flexGrow` share, negative → `flexShrink × hypotheticalMain` weighted, then clamp to `[minMain, maxMain]`. Line breaking for `flex-wrap` (`layout.ts:588-607`) accumulates `outerMain + gap` until it exceeds `mainAxisSize`. NaN main axis falls back to block layout (`layout.ts:568`). It's a faithful subset of CSS flexbox without the engine.

### C. The render-command-list pass (flex output → draw ops)

opentui's `RootRenderable.render` (`Renderable.ts:1737-1766`) is explicitly **3-pass**:
```ts
this.calculateLayout();                 // 1. Yoga solve (if dirty, :1756)
this.renderList.length = 0;
this.updateLayout(deltaTime, this.renderList);  // 2. walk tree → flat command list
for (… renderList) { … buffer.pushScissorRect(…) }  // 3. execute against buffer
```
`updateLayout` (`:1366`) emits paired commands so nesting maps to native stacks:
```ts
renderList.push({ action: "pushOpacity", opacity });    // 1400
renderList.push({ action: "render", renderable: this }); // 1403
renderList.push({ action: "pushScissorRect", x, y, width, height, … }); // 1410
// …children recurse…
renderList.push({ action: "popScissorRect" });  // 1444
renderList.push({ action: "popOpacity" });       // 1447
```
The code comment (`:1748-1755`) admits this *should* be 2-pass, but because Yoga lives in JS (not the Zig core) it can't hook the calculateLayout phase, so layout is recomputed and re-walked per frame — the acknowledged perf debt.

glyph's equivalent is `extractLayout` itself: it walks the Yoga tree producing `LayoutRect`s with both outer (`x,y,width,height`) and **inner/content-box** coords computed from border+padding (`yogaLayout.ts:359-362`):
```ts
const bw = hasBorder ? 1 : 0;
innerX = x + bw + padLeft;
innerWidth = Math.max(0, width - bw*2 - padLeft - padRight);
```
It has a fast path (`yogaLayout.ts:268`) skipping subtrees where `!hasNewLayout() && !parentMoved`, and a clip-cull (`:308`) that drops off-screen subtrees while still tracking their stale rects for the painter to clear.

### D. Box / border / padding — the integer box model

In a flex engine border is just a Yoga property set to `1` cell when present (glyph `yogaLayout.ts:130-132`):
```ts
const hasBorder = style.border != null && style.border !== "none";
yogaNode.setBorder(Edge.All, hasBorder ? 1 : 0);
```
Yoga then reserves that cell, and the content box (`getComputedPadding` + border) is where children/text live.

**boxen** (`context/boxen/index.js`) is the box model *without* an engine — pure string composition, no 2D buffer. The load-bearing invariant: after `makeContentText` (`index.js:135`), **every content line has identical display width** = `options.width`, so the border code (`index.js:240`) blindly prepends/appends the vertical glyph:
```js
result += lines.map(line =>
  marginLeft + colorizeBorder(chars.left) + colorizeContent(line) + colorizeBorder(chars.right)
).join('\n');
```
The equal-width invariant is enforced by padding **in display columns** (`index.js:188`): `newLine + PAD.repeat(width - stringWidth(newLine))` — a line with a 2-cell emoji gets one fewer pad space so the right border stays aligned. `getBorderWidth` returns a constant `2` (`index.js:46`); `sanitizeOptions` does `width = max(1, width − borderWidth)` **once up front** (`index.js:268`) so a user `width` is the *outer* box and all internal math is in content coords. Overflow is handled by *proportional margin shrink* rather than clipping (`index.js:307-318`):
```js
const multiplier = spaceForMargins / (margin.left + margin.right);
margin.left = Math.max(0, Math.floor(margin.left * multiplier));
```
The title is embedded into the top-border glyph run (`makeTitle`, `index.js:101`), not a separate row, and can force the box wider than its content (`index.js:298`).

### E. Table column sizing & wrapping (cli-table3)

`cli-table3` (`context/cli-table3/`) is the most sophisticated *static* layout in the corpus. `toString()` (`table.js:38`) runs a strictly phased pipeline: layout → mergeOptions (wrap, compute desired sizes) → computeWidths → computeHeights → cell.init → draw.

**Grid allocation with spans (`layout-manager.js`).** `layoutTable` (`:13`) is a sweep-line over rows. It keeps `alloc[col] = rowsRemaining` for columns still occupied by a rowSpan from above; `next(alloc, col)` skips forward to the first free column; after each row every counter is decremented and expired at 0. `fillInTable` (`:127`) auto-patches sparse/ragged input by scanning `(x,y)` and inserting synthetic empty cells. Conflict detection is pure interval overlap on both axes (`cellsConflict`, `:51`).

**Two-phase width distribution (`makeComputeWidths`, `layout-manager.js:193`)** — one generic fn parameterized for both axes:
1. Non-spanning cells seed `result[col] = max(existing, desiredWidth, forcedMin)`.
2. User-supplied fixed widths override (`if typeof val === 'number'`).
3. **Spanners processed last, in reverse.** For a spanning cell, `existingWidth = Σ spanned widths + (span−1)` — the `+1` per internal border is baked in because the span *swallows* those border columns. If `desiredWidth > existingWidth`, the deficit is spread evenly across only the **editable** (non-fixed) columns it covers, `Math.round(dif/editableCols)` at a time:
```js
existingWidth += 1 + result[col + i];        // +1 per shared border between spanned cols
if (cell[desiredWidth] > existingWidth) {
  let dif = Math.round((cell[desiredWidth] - existingWidth) / editableCols);
  result[col + i] += dif; existingWidth += dif; editableCols--;
}
```
The reusable lesson: **simple cells set minimums; spanners only grow, and only the deficit.**

**Border accounting in cells (`cell.js:111`).** `init()` slices `colWidths[x..x+colSpan]` and reduces with `sumPlusOne = (a,b)=>a+b+1` seeded at `-1`, so 1 col = its width, 2 cols = w1+w2+1 (shared border). `drawRight` is true only for the rightmost column so interior cells share borders (`cell.js:122`).

**Junction selection (`cell.js:184` `_topLeftChar`).** Choosing the right `┌ ┬ ┐ ├ ┼ ┤` glyph at every junction is the hard rendering bit: it inspects neighbor cells (`this.cells[y-1][x] instanceof ColSpanCell`) — if a colspan sits above, no vertical divider is needed so it uses `topMid`/`mid` instead of `midMid`. Neighbor-awareness is what makes spanned borders continuous.

**Wrapping & vertical alignment.** `wordWrap` (`utils.js:252`) preserves whitespace as alternating tokens; `textWrap` is the hard-break variant. Vertical align (`cell.js:133`) computes `padTop` from `vAlign` and the `height − lines.length` gap; `forceTruncation` adds `…` when content exceeds cell height on the last visible line. Padding is subtracted from fixed width *before* wrapping (`cell.js:78`) so wrap uses true inner width.

glyph's own text wrap (`textMeasure.ts:95` `wordWrap`) is the live equivalent: accumulate a word buffer, place it if `currentWidth + wordWidth ≤ maxWidth`, else newline, else hard-break per char — all measured via `ttyCharWidth` (display columns). `measureText` (`:5`) is the Yoga measure func: under `MeasureMode.Undefined` measure intrinsic width; otherwise wrap to `floor(maxWidth)` and return `{width: maxLineWidth, height: lineCount}`.

## Cross-repo comparison

| Concern | yoga | opentui | glyph | melker | boxen | cli-table3 |
|---|---|---|---|---|---|---|
| Layout model | flexbox engine (C++) | Yoga (TS) | Yoga (TS/WASM) | hand-rolled flexbox | string box model | grid + spans |
| Cell rounding | `PixelGrid.cpp` edge-round | `pointScaleFactor=1` (Yoga rounds) | `pointScaleFactor=0` + manual edge-round | block/border-box float→? | pad to col width | `sumPlusOne` border math |
| Text measure | host `measureFunc` | wcwidth in core (Zig) | `measureText`+`ttyWidth` table | `char-width.ts` wcwidth | `string-width` dep | `strlen`+`string-width` |
| Incremental? | gen-counter + dirty bit | per-frame re-layout (debt) | dirty fast-path + clip-cull | 3 render paths + cached-layout | no (one-shot) | no (one-shot) |
| Border/padding | Yoga props | Yoga props | Yoga `setBorder(1)` + inner rect | border-box in engine | constant width 2, content coords | `+1` per shared border |
| Spans | n/a | n/a | n/a | n/a | n/a | sweep-line + 2-phase grow |
| Output | floats only | native cell buffer | framebuffer + char diff | dual buffer + dirty rows | one string | one string |

**Where they agree:** measure in display columns; round *edges* not extents; border = 1 cell; text is a leaf measure func. **Where they differ:** who owns rounding (Yoga vs. the host), whether layout is incremental (Yoga's gen-counter is the gold standard; opentui punts and recomputes every frame; the string formatters don't need it), and whether there's an engine at all.

## Pitfalls & hard parts

- **Independent per-node rounding → 1-cell seams.** Always round absolute edges and derive extent as `round(right) − round(left)` (glyph `yogaLayout.ts:300`; yoga `PixelGrid.cpp:65`). Never `round(width)` standalone.
- **Outer vs. content coordinate confusion** is the #1 box-model bug. boxen converts user `width` to content width *once* in `sanitizeOptions` (`index.js:268`); mixing the two gives off-by-2 errors.
- **`.length` ≠ display width.** Emoji/CJK = 2 cells, combining marks/ZWJ = 0, ANSI escapes = 0. glyph hand-rolls `ttyWidth` *because* `string-width` v7 over-counts BMP symbols (↗ ✓ ♥) as width-2. Wide chars need a continuation/skip cell so the right half isn't overwritten.
- **Measured Yoga nodes can't have children** (`Node.cpp:138`). A text widget must be a leaf; nested styled text needs a different model (glyph composes child text into one measured string, `collectAllText` `yogaLayout.ts:187`).
- **Stale Yoga state leaks across reused nodes.** React reuses host instances via `commitUpdate`, so glyph's `resetYogaNode` (`yogaLayout.ts:68`) resets *every* property (Yoga uses `NaN` = unset) before applying the new style — otherwise an old `maxWidth` survives a view switch.
- **`getChild(i) === child.yogaNode` always fails** in WASM bindings (fresh wrapper each call) — derive insert index from your own children array, not Yoga's.
- **`hasNewLayout` isn't always set for new nodes** whose computed values match Yoga defaults — glyph notes this caused virtualized items to stack at origin and now reads position from Yoga unconditionally on the parentMoved path (`yogaLayout.ts:281-294`).
- **Cached-layout shortcuts are unsafe by default** (melker): only re-render to buffer with cached `LayoutNode` positions when you're *certain* layout didn't change (spinner tick, video frame); anything ambiguous must promote to a full `calculateLayout()`.
- **Spanners must be processed in reverse** (cli-table3) in both span-cell insertion and width distribution, to avoid splice/index interference.

## If you were building this from scratch

Use Yoga; don't hand-roll flexbox unless you have a hard no-WASM constraint (then copy melker's `layout.ts` subset). The minimal integration:

```
config = Yoga.Config.create()
config.setPointScaleFactor(0)              // we round edges ourselves

// per node, mirror your tree into a Yoga tree at mutation time (not per frame)
function onCreateNode(n):
    n.yoga = Yoga.Node.createWithConfig(config)
    if n.isText: n.yoga.setMeasureFunc(measure(n))   // leaf only — no children!

function measure(n) = (availW, wMode, _, _) =>
    if wMode == Undefined: return { width: maxLineDisplayWidth(n.text), height: lineCount }
    lines = wordWrap(n.text, floor(availW), displayWidthFn)   // count CJK=2, combining=0
    return { width: max(displayWidth(l) for l in lines), height: lines.length }

// per frame, only if dirty:
function layout(root, cols, rows):
    syncChangedStylesOnly(root)            // ref-compare; skip unchanged (Yoga is sticky)
    root.yoga.setWidth(cols); root.yoga.setHeight(rows)
    root.yoga.calculateLayout(cols, rows, LTR)
    extract(root, rawX=0, rawY=0)

function extract(n, rawX, rawY):
    if not n.yoga.hasNewLayout() and not parentMoved: recurse with cached; return
    n.yoga.markLayoutSeen()
    cl = n.yoga.getComputedLayout()
    ax = rawX + cl.left; ay = rawY + cl.top
    x = round(ax); y = round(ay)
    w = round(ax + cl.width) - x          // EDGE rounding → gapless siblings
    h = round(ay + cl.height) - y
    bw = n.hasBorder ? 1 : 0
    n.rect = { x, y, w, h,
               innerX: x+bw+padL, innerY: y+bw+padT,
               innerW: max(0, w-2*bw-padL-padR), innerH: max(0, h-2*bw-padT-padB) }
    for c in n.children: extract(c, ax, ay)   // pass RAW float down
```

For **tables**, don't put each cell in Yoga — do cli-table3's phased approach: sweep-line allocate the grid (track rowspan occupancy), seed column minimums from non-spanning cells' wrapped `desiredWidth`, then let spanners grow only their editable columns by the deficit, accounting `+1` per shared border. Pick junction glyphs by inspecting neighbors.

For a standalone **box**, boxen's pattern is enough: measure in columns, enforce one equal-width invariant on every content line, then wrap with border glyphs — no buffer needed.

## Source map

- **Yoga engine:** `context/yoga/yoga/algorithm/CalculateLayout.cpp` (11-step flexbox; `:2498` cache gate, `:2707` gen-counter), `Cache.cpp:45` (sizing-aware reuse), `node/Node.cpp:138` (measure-leaf assert), `:453` (dirty propagation), `algorithm/PixelGrid.cpp:65` (edge rounding), `algorithm/SizingMode.h` (MeasureMode mapping), `javascript/src/wrapAssembly.ts` (JS class wrapper, polymorphic setters `:295-362`).
- **opentui:** `context/opentui/packages/core/src/Renderable.ts` — `:204` `pointScaleFactor(1)`, `:1079` `updateFromLayout`, `:1366` `updateLayout` (render-command list), `:1737` 3-pass `render`; `src/lib/yoga.options.ts` (string↔enum maps).
- **glyph:** `context/glyph/packages/glyph/src/layout/yogaLayout.ts` — `:68` `resetYogaNode`, `:108` `applyStyleToYogaNode`, `:204` `syncYogaStyles`, `:257` `extractLayout` (edge rounding `:298-301`, inner box `:359`), `:483` `computeLayout`; `src/reconciler/nodes.ts:19` `pointScaleFactor(0)`; `src/layout/textMeasure.ts` (measure func + wordWrap); `src/utils/ttyWidth.ts` (hand-rolled wcwidth).
- **melker:** `context/melker/src/layout.ts` — `:568` NaN→block fallback, `:588` flex-wrap line breaking, `:618-659` grow/shrink; `src/components/data-table.ts` + `agent_docs/data-table.md`; `agent_docs/layout-engine-notes.md`.
- **boxen:** `context/boxen/index.js` — `:46` `getBorderWidth`, `:135` `makeContentText`, `:188` equal-width pad, `:208` `boxContent`, `:268` `sanitizeOptions`, `:278` `determineDimensions` (margin shrink `:307`), `:101` `makeTitle`.
- **cli-table3:** `context/cli-table3/src/layout-manager.js` — `:6` `next`, `:13` `layoutTable`, `:51` `cellsConflict`, `:127` `fillInTable`, `:193` `makeComputeWidths`; `src/cell.js:111` `init` (`sumPlusOne`), `:133` `draw` (vAlign), `:184` `_topLeftChar` (junctions); `src/utils.js:252` `wordWrap`, `:7` `strlen`.
