# hunk

## What it is (1-2 lines)
A production terminal diff viewer / git pager built on OpenTUI + React, rendering syntax-highlighted split/stack diffs with virtualized scrolling, agent review notes, and a non-interactive ANSI fallback pager. The diff renderer is also shipped as an embeddable library (`hunkdiff/opentui`: `HunkDiffView` + lower-level primitives).

## Architecture (how the pieces fit; key files with paths)
- **Entry / startup dispatch** — `src/main.tsx`. Resolves a `startupPlan` (`prepareStartupPlan` in `src/core/startup.ts`) into one of several modes: `help`, `daemon-serve`, `session-command`, `plain-text-pager`, `passthrough`, `static-diff-pager`, or the interactive `app`. Only the `app` branch boots OpenTUI (`createCliRenderer` + `createRoot` from `@opentui/react`), mounts `<AppHost>`, and installs SIGINT/SIGTERM + job-control (suspend/interrupt) handlers that tear the renderer down cleanly so the primary screen returns.
- **Data model** — `src/core/types.ts`. `DiffFile` wraps Pierre's `FileDiffMetadata` (`@pierre/diffs`) plus `language`, `stats`, agent context, and an optional `sourceFetcher` capability for lazy full-text fetch (used to expand collapsed gaps). `Changeset` is a list of files.
- **Diff parse + highlight** — `src/ui/diff/pierre.ts` (~920 lines, the core). Wraps Pierre's `renderDiffWithHighlighter` / `renderFileWithHighlighter` (shiki-wasm under the hood). Flattens Pierre's HAST output into terminal `RenderSpan[]` and produces the normalized `DiffRow` union.
- **Render model → planned rows → geometry → window → JSX**:
  - `src/ui/diff/pierre.ts` builds `DiffRow[]` (split + stack).
  - `src/ui/diff/reviewRenderPlan.ts` / `plannedReviewRows.ts` interleave diff rows with agent/user inline notes into `PlannedReviewRow[]`.
  - `src/ui/diff/diffSectionGeometry.ts` measures each planned row's terminal height (without mounting it) into `rowBounds`, building per-file `DiffSectionGeometry` (cached in a `WeakMap` keyed off agent notes).
  - `src/ui/diff/rowWindowing.ts` slices planned rows to the visible window + top/bottom spacers (virtualization).
  - `src/ui/diff/renderRows.tsx` (~1800 lines) emits the actual OpenTUI `<box>`/`<text>` JSX per row, memoized.
- **Orchestration** — `src/ui/components/panes/DiffPane.tsx` owns the `<scrollbox>`, computes visible file IDs + per-file visible body bounds with overscan, and wires mouse/keyboard.
- **App shell** — `src/ui/App.tsx` (state: layout mode, theme, wrap, line numbers, sidebar, focus area, horizontal offset) and `src/ui/AppHost.tsx`.
- **Keyboard** — `src/ui/hooks/useAppKeyboardShortcuts.ts` + `src/ui/lib/keyboard.ts` (encoding-robust key matchers).
- **Static fallback** — `src/ui/staticDiffPager.ts`. Reuses the same parse/highlight/`buildStackRows` stack but serializes to raw ANSI truecolor for `TERM=dumb` hosts (LazyGit panels).
- **Session/IPC** — `src/session-broker/*` + `packages/session-broker-core` + `packages/session-broker`: a daemon broker so external agents can drive/query a running review session.

## Core techniques

### Diff row model (the spine)
`DiffRow` (`pierre.ts:97`) is a tagged union: `collapsed` (a hidden run of N unchanged lines with `oldRange`/`newRange` file-line bounds), `hunk-header`, `split-line` (left+right `SplitLineCell`), and `stack-line` (single `StackLineCell` with both old/new line numbers). Split vs stack are *separate* row builders (`buildSplitRows`/`buildStackRows`) over the same highlighted data. Expanded gap rows carry `isExpansionRow?: true` so they sort with a neighbor hunk but don't count toward that hunk's bounds.

### HAST → terminal span flattening, heavily cached
Pierre returns syntax highlighting as HAST (HTML AST) with inline `style="color:#..."` or CSS-variable colors. `flattenHighlightedLine` (`pierre.ts:~315`) recursively walks the tree into coalesced `RenderSpan[]`. Three caching layers make remount/relayout cheap:
- `parsedStyleValueCache: Map<string, Map<string,string>>` — memoizes parsing of identical inline style strings (`color:#...;`).
- `normalizedColorCache` per-theme — remaps Pierre token hues that *collide with diff add/remove semantics* into theme-safe syntax colors (`RESERVED_PIERRE_TOKEN_COLORS`, `pierre.ts:182`).
- `flattenedHighlightedLineCache: WeakMap<HastNode, Map<themeKey, RenderSpan[]>>` — the big win: caches flattened spans keyed by the HAST node identity + `theme:emphasisBg`. Revisiting a file or building both split *and* stack rows skips the whole recursive walk. WeakMap means it's GC'd with the node.
- `mergeSpan` coalesces adjacent runs with identical fg/bg into one span (fewer terminal writes).

### Context-line aliasing
`aliasHighlightedContextLines` (`pierre.ts:~545`): Pierre highlights unchanged context on *both* diff sides. The code points both `deletionLines[i]` and `additionLines[i]` at the *same node object* for context lines, so the WeakMap span cache flattens it once and fans the result out to both sides.

### Word-diff background strengthening (perceptual contrast)
Pierre marks inline word-diff emphasis with a `data-diff-span` attribute (not a separate row). `strengthenWordDiffBg` (`pierre.ts:208`) blends the emphasis bg toward the sign color in 0.005 steps until `hexColorDistance` ≥ `MIN_WORD_DIFF_BG_DISTANCE` (28), so subtle theme colors stay visible. Cached per theme.

### Serialized async highlight queue
`queueHighlightedWork` (`pierre.ts:~500`) chains highlight jobs through a single `queuedHighlightWork` promise + `queueMicrotask`, so highlighting runs in request order (startup work stays serialized, avoiding shiki contention). `useHighlightedDiff.ts` adds a shared `Map` cache (max 150 entries, insertion-order LRU eviction) plus an in-flight promise map keyed by an FNV-1a fingerprint of the diff lines/metadata (`lineSetFingerprint`, `metadataFingerprint`) — same content never re-highlights.

### Virtualized scrolling without losing layout height
Two-stage virtualization:
1. **Measure-without-mounting**: `diffSectionGeometry.ts` computes each planned row's height via `measureRenderedRowHeight` (renderRows.tsx) and stores cumulative `rowBounds` (`{top,height,key,stableKey,stableKeys}`). Cached in a `WeakMap<VisibleAgentNote[], Map<cacheKey, geometry>>` so memory tracks the visible diff, not renders. Cache key includes an FNV-1a `sourceTextFingerprint` so same-length edits still invalidate.
2. **Window + spacers**: `rowWindowing.ts:resolveVisiblePlannedRowWindow` binary-searches `rowBounds` (`findFirstRowWithBottomAfter` / `findLastRowWithTopBefore`) for the `[minVisibleTop, maxVisibleBottom)` interval, returns only those `plannedRows` plus a `topSpacerHeight` and `bottomSpacerHeight`. The spacers are empty boxes that preserve total scroll height so the scrollbar and `scrollTop` stay correct while offscreen rows are unmounted. Zero-height structural rows (hidden hunk headers carrying anchor ids) are deliberately kept attached to the visible slice (`rowWindowing.ts:~150`).

### Overscan that adapts to scroll velocity
`DiffPane.tsx` mounts a halo around the viewport: `overscanTerminalRows = max(24, viewport.height*2, rapidScrollOverscanRows)`. `adaptiveScrollOverscan.ts:computeRapidScrollOverscanRows` grows the halo temporarily during bursty wheel/page scrolls (so the terminal shows real over-rendered rows instead of blank placeholders while scroll events outrun React commits), then decays after `RAPID_SCROLL_OVERSCAN_IDLE_MS` (160ms). Mouse wheel uses OpenTUI's `MacOSScrollAccel` (`scrollAcceleration.ts`): first tick precise, sustained bursts ramp to 3×.

### Viewport anchoring across layout changes
`viewportAnchor.ts:findViewportRowAnchor` binary-searches per-file row bounds to capture which logical row owns the viewport top (`{fileId, rowKey, stableKey, rowOffsetWithin}`). Before toggling split↔stack or wrap, App stashes `scrollTop`; after relayout it re-resolves the anchor so the user stays on the same logical line even though row heights changed. `stableKeys` lets one split row map to/from multiple stacked rows.

### Unicode-correct width & slicing
`src/ui/lib/text.ts`: `measureTextWidth` fast-paths printable ASCII (`/^[ -~]*$/` → `.length`) and falls back to `string-width` for CJK/emoji. `sliceTextByWidth` iterates **grapheme clusters** via `Intl.Segmenter` so wide/combining characters never split. Tabs are expanded to a fixed `DIFF_CODE_TAB_WIDTH=2` *before* measuring (`codeColumns.ts`) so cell widths stay predictable. `padText`/`fitText` clamp to exact terminal cell width with an ellipsis.

### Terminal text sanitization
`src/lib/terminalText.ts` strips C0/C1 control codes (`/[\x00-\x1f\x7f-\x9f]/`) from any text routed to the screen (`sanitizeTerminalLine`, `sanitizeTerminalSpans`), with a newline-preserving variant. Applied at flatten time and in the static pager so untrusted diff content can't inject escape sequences.

### Encoding-robust keyboard matching
`src/ui/lib/keyboard.ts` matches keys across raw, Kitty/CSI-u, and tmux control-mode encodings. E.g. `isSaveDraftNoteKey` checks `key.ctrl && name==='s'`, raw ``, *and* the CSI-u sequence `[115;5u`. Escape is normalized across `escape`/`esc` aliases. This is the kind of defensiveness real terminals demand.

### Lazy gap expansion
`expandCollapsedRows.ts` turns a `collapsed` row into real context rows on demand, fetching full file text via `DiffFile.sourceFetcher` (`FileSourceStatus`: loading/loaded/error). Gaps have stable keys (`gapKey(position, hunkIndex)`) so expansion state survives re-renders, and `selectGapForKeyboardToggle` picks which gap a keypress expands relative to the selected hunk.

### Non-interactive ANSI rendering
`staticDiffPager.ts` reuses the *same* parse/highlight/`buildStackRows` pipeline but serializes to raw ANSI truecolor (`ansiColor` emits `\x1b[38;2;r;g;bm`), one `\x1b[0m` reset per fragment, for hosts that can't run the alt-screen TUI (`TERM=dumb`, LazyGit). On any failure it falls back to the sanitized raw patch so the pager pipeline never breaks. The module docstring explicitly warns: do not fork a second diff parser here — keep it a thin adapter.

## Code patterns worth stealing

**WeakMap node-identity span cache (avoids re-walking syntax AST):**
```ts
const flattenedHighlightedLineCache = new WeakMap<HastNode, Map<string, RenderSpan[]>>();
function flattenHighlightedLine(node, theme, emphasisBg) {
  const cacheKey = `${theme.id}:${emphasisBg}`;
  const cached = flattenedHighlightedLineCache.get(node)?.get(cacheKey);
  if (cached) return cached;        // skip full recursive walk on remount
  // ...walk HAST, mergeSpan() coalescing adjacent equal-color runs...
}
```

**Measure → window → spacer virtualization:**
```ts
// 1. geometry: cumulative rowBounds[{top,height}], measured without mounting
// 2. binary-search the visible [top,bottom) interval
// 3. mount only the slice; replace the rest with spacer boxes of known height
return { topSpacerHeight: startRow.top,
         plannedRows: plannedRows.slice(startIndex, endIndex),
         bottomSpacerHeight: bodyHeight - (endRow.top + endRow.height) };
```

**Velocity-adaptive overscan:**
```ts
const overscan = Math.max(24, viewport.height * 2, rapidScrollOverscanRows);
// rapidScrollOverscanRows spikes on fast wheel deltas, decays after 160ms idle
```

**Multi-encoding key matcher:**
```ts
return (key.ctrl && (name === "s" || sequence === "s" || sequence === CTRL_S))
  || sequence === CTRL_S || raw === CTRL_S
  || sequence === CTRL_S_CSI_U || raw === CTRL_S_CSI_U;
```

**ASCII fast-path width measurement:**
```ts
const printableAsciiRegex = /^[ -~]*$/;
const measure = (t) => printableAsciiRegex.test(t) ? t.length : stringWidth(t);
// slicing uses Intl.Segmenter grapheme clusters so wide chars never split
```

**Clean teardown on every exit path** (`main.tsx`): single idempotent `shutdown()` removes signal handlers, disposes job-control hooks, stops the session client, and calls `shutdownSession({root, renderer})` so the alt-screen is exited and the primary terminal restored even on SIGINT.

## Gotchas / non-obvious decisions
- **Split and stack are distinct row trees**, not one tree styled differently — they have different gutter geometry (`resolveSplitPaneWidths` vs stack). Layout toggle re-measures everything; that's why anchor restoration exists.
- **Syntax colors can collide with diff semantics.** Pierre's red/green keyword/string hues are explicitly remapped per-theme so a red keyword doesn't read as a deletion.
- **Geometry cache keying is subtle**: keyed off the agent-notes array via WeakMap *and* an FNV-1a fingerprint of expansion state + source text, so same-length edits and gap toggles correctly invalidate.
- **Zero-height rows are load-bearing.** Hidden hunk headers carry anchor ids / stable keys; the windower keeps them attached to the visible slice instead of stranding them in a spacer.
- **`renderer.intermediateRender()`** is fired in an effect on layout/wrap/dimension changes to force an immediate redraw so relayout "feels instant" rather than waiting for the next React commit.
- **Highlighting is async and queued**, so the first paint uses a plain-text fallback (`makeSplitCell`/`makeStackCell` build spans from raw line when `highlightedLine === undefined`) and upgrades when spans arrive — startup never blocks on shiki.
- **Horizontal scroll moves only code columns**, not gutters/headers (`codeHorizontalOffset` + `sliceSpansWindow`), and is disabled when `wrapLines` is on.
- **The static pager must never fork the parser** — explicit doc contract to keep one source of truth for parse/highlight/plan.

## Relevance (which advanced-TUI topics this teaches)
- **rendering-pipeline** — async-queued shiki highlight → HAST → cached span flatten → measure → window → JSX; plain-text-first then upgrade.
- **layout** — split vs stack geometry, gutter/line-number column sizing, fixed tab expansion, spacer-preserving virtualization.
- **reconciler-component-models** — OpenTUI + React, `memo` with hand-written prop comparators, `WeakMap`/`Map` caches around the reconciler to keep commits cheap.
- **input-keyboard-mouse** — encoding-robust key matching (raw/CSI-u/tmux), mouse drag selection, wheel acceleration, velocity-adaptive overscan.
- **ansi-escapes** — truecolor `38;2`/`48;2` serialization in the static pager; control-code sanitization of untrusted diff text.
- **unicode-text-width** — `string-width` + `Intl.Segmenter` grapheme slicing, ASCII fast path.
- **widgets-rich-content** — syntax-highlighted diffs, inline agent notes, collapsible/expandable gaps, word-diff emphasis.
- **app-architecture** — startup-plan dispatch into many run modes, clean signal/job-control teardown, embeddable library surface (`hunkdiff/opentui`), session-broker daemon IPC for agent-driven review.
