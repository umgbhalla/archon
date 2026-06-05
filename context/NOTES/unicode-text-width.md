# unicode-text-width

How to turn a JS/Zig string into a count of terminal cells — the single most error-prone primitive in any TUI. Every box border, table column, wrap, truncation, and cursor-position calculation is downstream of getting this right.

## TL;DR (the mental model in 3-5 bullets)

- **A terminal lays out *user-perceived characters* (grapheme clusters), each occupying an integer number of monospace cells (0, 1, or 2).** Width must be computed per-cluster, never per-`String.length` (UTF-16 units), per-code-point, or per-`[...str]`. `"é"` (`e` + U+0301) is 1 cluster / 1 cell but `.length === 2`; `"👨‍👩‍👧‍👦"` is 1 cluster / 2 cells but `.length === 11`.
- **The pipeline is always two layers: (1) segment into grapheme clusters (UAX#29), then (2) assign each cluster a cell width.** Segmentation answers "where do I cut"; width answers "how many columns". They are independent concerns and confusing them is the root of most bugs.
- **Width assignment per cluster = East Asian Width (EAW, UAX#11) of the base scalar, plus emoji/regional-indicator/Hangul special cases, minus zero-width marks/control/format codepoints.** EAW Wide/Fullwidth → 2; everything else → 1; ambiguous → 1 by default (configurable). Combining marks, ZWJ, VS, control → 0.
- **There is no single "correct" answer — width is a *prediction* of what some terminal will draw, and terminals disagree** (especially on emoji without VS16, ambiguous-width, and orphan Hangul jamo). Libraries deliberately match real terminal behavior over the Unicode spec, and expose toggles (`ambiguousIsNarrow`, `wcwidth` vs `unicode` mode, Unicode version) because the right answer depends on the target terminal.
- **`String.length` lies** because it counts UTF-16 code units. `[...str].length` / code-point count lies because clusters span multiple code points. Even grapheme count lies for width because one cluster can be 2 cells wide. You need the full two-layer machine.

## How it actually works (the mechanism, step by step)

### Layer 0: strip ANSI and take fast paths

Escape sequences occupy 0 cells, so they must be removed before measuring. `string-width` only invokes the (expensive) regex machinery when an escape byte is actually present:

```js
// context/string-width/index.js:159
if (!countAnsiEscapeCodes && (string.includes('') || string.includes(''))) {
  string = stripAnsi(string);
}
// :168  printable-ASCII fast path: width === length, skip ALL unicode machinery
if (/^[ -~]*$/.test(string)) {
  return string.length;
}
```

The ASCII fast path is the single most important optimization — it covers the overwhelmingly common case (English text, code, numbers) with one regex test and zero segmenter/EAW work. opentui does the same with a SIMD16 scan: `isAsciiOnly` (`context/opentui/packages/core/src/zig/utf8.zig:13`) checks 16 bytes at a time against `[32,126]`.

### Layer 1: grapheme cluster segmentation (UAX#29)

Three strategies appear across the repos:

**(a) Delegate to the engine.** `string-width` uses the built-in `Intl.Segmenter` (`context/string-width/index.js:16`):
```js
const segmenter = new Intl.Segmenter();
for (const {segment} of segmenter.segment(string)) { /* segment = one cluster */ }
```
This offloads the entire UAX#29 grapheme table + emoji ZWJ rules to V8 — zero shipped Unicode data, but requires Node ≥20 and pays `Intl.Segmenter`'s per-call overhead.

**(b) Hand-roll a streaming boundary state machine.** `unicode-segmenter` implements GB1–GB999 directly as a generator that walks UTF-16 code units, decoding code points on the fly and keeping only the previous category + a few scalar flags (`context/unicode-segmenter/src/grapheme.js:47`). It never materializes a code-point array — O(1) memory, early-exit friendly:
```js
let cp = input.codePointAt(0);
let cursor = cp <= 0xFFFF ? 1 : 2;            // surrogate-pair-aware step (:54)
while (cursor < len) {
  cp = input.codePointAt(cursor);
  catAfter = cat(cp);
  // ...decide boundary from catBefore/catAfter + flags...
  if (boundary) { yield input.slice(index, cursor); index = cursor; }
  cursor += cp <= 0xFFFF ? 1 : 2;             // (:207)
  catBefore = catAfter;
}
```
The GB rules are tested **hot-path-first, not in spec order** (`:95`–`:142`): CR×LF first (GB3), then the dominant no-break "× (Extend|ZWJ|SpacingMark)" (GB9/9a, `:110`), then Prepend (GB9b), emoji-ZWJ (GB11), regional indicators (GB12/13), Hangul (GB6/7/8), and finally the expensive Indic conjunct rule (GB9c, `:139`) gated behind `cp >= 2325` so non-Indic text never pays for it.

The two notable tricks:
- **Regional-indicator flag pairing via parity:** `boundary = riCount++ % 2 === 1` (`:124`) — first RI breaks before, second joins, repeat. Two RIs = one flag.
- **Emoji ZWJ (GB11):** track `extPic` (saw Extended_Pictographic) and `emoji` (saw `ExtPic Extend* ZWJ`) flags so `❤️‍🔥`-style sequences stay one cluster across the ZWJ (`:117`–`:120`, `:166`–`:169`).

`cat(cp)` itself is layered by codepoint region for speed: ASCII branches, two 4-bit nibble-packed tables for the BMP, arithmetic for Hangul syllables (`(cp-0xAC00)%28===0 ? LV : LVT`), inlined branches for CJK, binary search for the long tail.

**(c) Use a precompiled trie / threaded state.** xterm's grapheme addon asks `UC.shouldJoin(prevKind, charInfo)` against a compiled unicode-trie (`context/xterm/addons/addon-unicode-graphemes/src/UnicodeGraphemeProvider.ts:44`), threading the preceding break-kind through the VT parser as `precedingJoinState` so cluster joining **survives chunk boundaries** in the byte stream. opentui calls Zig's `uucode.grapheme.isBreak(prev_cp, curr_cp, &break_state)` (`utf8.zig:786`,`:811`) with an explicit mutable `BreakState` — the same threaded-state idea.

### Layer 2: assign a cell width to each cluster

This is where the real Unicode subtlety lives. `string-width`'s per-cluster classifier (`context/string-width/index.js:175`–`:200`) runs these checks in order:

1. **Zero-width whole cluster → 0** (`:177`). One `v`-flag property regex: `/^(?:\p{Default_Ignorable_Code_Point}|\p{Control}|\p{Format}|\p{Mark}|\p{Surrogate})+$/v` (`:19`). Catches control chars, tab (width 0 *by design*), newlines, ZWSP/ZWNJ/ZWJ alone, lone VS, BOM, lone surrogates, combining-marks-only clusters, tag sequences.
2. **RGI emoji → 2** (`:182`). `/^\p{RGI_Emoji}$/v` (`:25`) matches *Recommended for General Interchange* emoji sequences as whole clusters — fully-qualified ZWJ sequences, flags, skin tones, keycaps — in one test.
3. **Minimally/unqualified emoji → 2** (`isDoubleWidthNonRgiEmojiSequence`, `:31`): emoji that should render double-wide but lack the VS16 qualifier. Two heuristics — unqualified keycap `/^[\d#*]⃣$/`, and ZWJ sequence with ≥2 `Extended_Pictographic` codepoints. Guarded by `if (segment.length > 50) return false` against pathological input.
4. **Hangul jamo composition** (`hangulClusterWidth`, `:79`). Decomposed L+V(+T) jamo land in one cluster and terminals compose them into width-2 syllable blocks. It walks visible code points; when it sees L immediately followed by V, it consumes L+V(+T) as one width-2 syllable (`:113`–`:120`). **Unmatched/orphan jamo stay additive** (`ᄀᄀ`=4) because that mirrors real terminal rendering, not the Unicode ideal. Returns `undefined` to fall through if not Hangul.
5. **Generic EAW fallback** (`:194`). Take the cluster's first *visible* scalar (after stripping leading Prepend/Format/Mark via `baseVisible`/`leadingNonPrintingRegex`, so `؀你`=2 not 1), look up its EAW: Wide/Fullwidth → 2, else 1. Then `trailingHalfwidthWidth` (`:128`) adds width for trailing Halfwidth/Fullwidth Forms in the same cluster (dakuten `ﾊﾞ`=2).

The EAW lookup itself (`context/get-east-asian-width/index.js:15`):
```js
export function eastAsianWidth(codePoint, {ambiguousAsWide = false} = {}) {
  if (isFullWidth(codePoint) || isWide(codePoint)
      || (ambiguousAsWide && isAmbiguous(codePoint))) return 2;
  return 1;
}
```
Each category is a sorted flat `[start,end,start,end,...]` range array searched by binary search (`isInRange`, `context/get-east-asian-width/utilities.js:8`), bounded by per-category min/max codepoint guards so out-of-range codepoints reject in O(1). `isWide` additionally has a **hot-path range** around U+4E00 (common CJK) to skip the binary search entirely (`lookup.js:25`,`:98`).

### xterm: width as bit-packed properties, threaded across the stream

xterm packs `(charKind, width, shouldJoin)` into one integer (`UnicodeService.createPropertyValue`, `context/xterm/src/common/services/UnicodeService.ts:28`): `(state<<3) | (width<<1) | shouldJoin`. `getStringCellWidth` (`:67`) walks UTF-16, decodes surrogate pairs, and for each codepoint calls `charProperties(code, precedingInfo)`. The crucial move: when a codepoint **joins** the preceding cluster (a combining mark, width 0), it *subtracts the preceding width back out* so the cluster isn't double-counted:
```js
// UnicodeService.ts:92
const currentInfo = this.charProperties(code, precedingInfo);
let chWidth = UnicodeService.extractWidth(currentInfo);
if (UnicodeService.extractShouldJoin(currentInfo)) {
  chWidth -= UnicodeService.extractWidth(precedingInfo);
}
result += chWidth;
precedingInfo = currentInfo;
```
The legacy `UnicodeV6` provider is pure wcwidth: a lazily-built `Uint8Array(65536)` table (`context/xterm/src/common/input/UnicodeV6.ts:90`) filled with 1, zeroed for controls, set to 2 for wide ranges, then combining ranges overwrite back to 0 last (`:117`). `wcwidth` is a single array index for the BMP plus a binary search for astral combining (`:123`). The grapheme provider (V15) instead uses VS16 to upgrade width-1 → 2 and treats regional-indicator pairs as width 2 (`UnicodeGraphemeProvider.ts:35`–`:55`).

### opentui: pluggable WidthMethod, EAW + huge emoji range table

opentui exposes three width modes via an enum (`context/opentui/packages/core/src/zig/utf8.zig:5`): `wcwidth` (tmux-style: cluster for rendering but sum codepoint widths), `unicode` (grapheme-aware), `no_zwj` (break on ZWJ). Its `eawToWidth` (`:637`) is the most explicit width table in any of the repos: zero for marks (`general_category` ∈ {mark_nonspacing, mark_spacing_combining, mark_enclosing}), zero for an explicit list of zero-width codepoints (ZWSP/ZWNJ/ZWJ/WJ/U+034F/BOM/Mongolian VS/VS1-16/tag selectors, `:647`–`:655`), `2` for EAW wide/fullwidth, then **dozens of hardcoded emoji ranges** (`:659`–`:737`) because EAW alone misses emoji that aren't tagged Wide. `GraphemeWidthState` (`:817`) accumulates per-cluster width with special handling: VS16 upgrades width 1→2 (`:861`), Indic virama + Devanagari base composition (`:880`), regional-indicator pairs (`:874`).

### Wrapping & truncation in cells

Once you can measure, wrapping/truncation is "walk clusters, accumulate columns, cut at a boundary without exceeding the limit." opentui's `handleClusterForWrap` (`utf8.zig:918`) is the canonical shape:
```zig
if (is_break) {
  if (state.prev_cp != null) {
    if (state.columns_used + state.cluster_width > max_columns) return true; // stop
    state.columns_used += state.cluster_width;
    state.grapheme_count += 1;
  }
  state.cluster_width = 0;  state.cluster_start = new_cluster_start;
}
```
The hard part is **wide-char straddling**: a width-2 cluster that would land half-on/half-off the limit must move *entirely* to the next line (or be dropped), never split. opentui formalizes this with two snapping policies in `handleClusterForPos` (`:949`): `include_start_before` (snap forward — include a grapheme starting at/before the column) vs the default (snap backward — exclude a grapheme that would *end* past the column). This is exactly the policy you need for selection endpoints and for truncation-with-ellipsis.

xterm stores width per cell and represents a wide char as **cell N width 2 + cell N+1 width 0** (trailing half). Line operations (`insertCells`/`deleteCells`) must fix up a dangling half-wide char at edges. opentui's grapheme cells encode a "continuation" marker with left/right extent so a wide/grapheme cell knows how many cells it spans (`context/opentui/packages/core/src/zig/grapheme.zig:464`, `encodedCharWidth` `:471`).

## Cross-repo comparison

| Concern | string-width | unicode-segmenter | xterm | opentui (zig) |
|---|---|---|---|---|
| Segmentation | `Intl.Segmenter` (engine) | hand-rolled GB1–999 streaming SM | compiled unicode-trie, state threaded across chunks | `uucode.grapheme.isBreak` + threaded `BreakState` |
| Unicode data | none shipped (engine) | ~7KB base36 delta-encoded tables | compiled trie blob | `uucode` Zig lib + inlined emoji ranges |
| Width source | `get-east-asian-width` (range arrays + binary search) | **none** (segmentation only) | wcwidth table / packed char-props | EAW (`uucode`) + big hardcoded emoji table |
| Emoji | `\p{RGI_Emoji}` + unqualified heuristics | GB11 join only (no width) | VS16 upgrade, RI-pair=2 | VS16 upgrade, RI-pair, emoji range table |
| Ambiguous | `ambiguousIsNarrow` (default narrow) | n/a | `ambiguousCharsAreWide` flag | `wcwidth` vs `unicode` mode |
| Hangul jamo | explicit L+V(+T) composition, orphans additive | GB6/7/8 boundaries only | via wcwidth ranges | EAW only |
| Output | total column count | cluster boundaries | per-cell width + grapheme cells | wrap positions, per-cell extents, cluster pool |
| Memory model | one pass, alloc strings | zero-alloc streaming generator | bit-packed cells, sparse side maps | slab-allocated interned grapheme pool |

Where they **agree**: two layers (segment then width); ASCII fast path; combining marks/control/format = 0; EAW Wide/Fullwidth = 2; emoji ZWJ sequences are one cluster; regional-indicator pairs are one width-2 flag; VS16 forces emoji presentation (width 2). All thread or imply state to keep clusters intact.

Where they **differ / who's better**:
- **string-width is the best pure measurement reference** — tiny, correct, leans on the engine for the two hardest tables (graphemes + RGI emoji). But it allocates and depends on Node ≥20. Best for layout code that runs occasionally.
- **unicode-segmenter is the best *segmenter*** (zero-alloc, beats native `Intl.Segmenter`) but ships **no width layer** — you must bolt EAW on top. Best for a render hot loop measuring widths every frame.
- **xterm is the best reference for "width inside a live emulator"** — threading join-state across an async byte stream, bit-packed cell storage, wide-char half-cells, version-pluggable providers. Heaviest, most complete model.
- **opentui is the best reference for *configurable* width** — the `WidthMethod` enum acknowledges head-on that there is no one true answer and lets the app pick wcwidth (matches tmux/many terminals) vs strict unicode. Its explicit emoji range table is the most honest about EAW's gaps.

## Pitfalls & hard parts

- **`String.length` / `.length` is UTF-16 code units, not columns and not even code points.** `[...str].length` gives code points, still wrong for clusters. Grapheme count is still wrong for width (one cluster can be 2 cells). Only the full two-layer machine is correct.
- **Emoji without VS16.** `❤` (U+2764) is text-presentation width 1 by EAW, but `❤️` (+VS16) renders width 2. RGI matching catches fully-qualified sequences; unqualified ones need heuristics (string-width `:31`) or a VS16→2 upgrade (xterm `:37`, opentui `:861`). Terminals disagree wildly here.
- **Ambiguous-width characters (UAX#11 "A": ±, ×, ÷, Greek, Cyrillic, box-drawing).** Width depends on the user's locale/terminal/font. Default to narrow (1) per spec, but expose a toggle. Getting this wrong misaligns CJK-locale users' tables.
- **Tab width is content-independent and the caller's job.** string-width treats `\t` as 0 (issue #45). opentui takes an explicit `tab_width` param (`asciiCharWidth` `:743`). Never hardcode 8.
- **Leading non-printing codepoints can "steal" the base width.** A cluster starting with a Prepend (Arabic number sign U+0600) or leading ZWJ must measure the *first visible* scalar, not literally `codePointAt(0)` — string-width's `baseVisible` (`:50`).
- **Orphan/decomposed Hangul jamo** compose into syllable blocks only when L+V adjacent; unmatched jamo stay additive. Spec-ideal width disagrees with what terminals draw.
- **State must survive chunk boundaries** in a streaming emulator — a cluster split across two `write()` calls must still join (xterm's `precedingJoinState`, opentui's `break_state`). A naive per-chunk segmenter double-counts.
- **Wide chars must never be split by wrap/truncate.** A width-2 cluster straddling the limit moves whole to the next line; truncation that cuts mid-wide-char corrupts the grid and leaves a dangling half-cell. Pick a snap-forward vs snap-backward policy explicitly (opentui `:949`).
- **Unicode version skew.** Width tables change between Unicode versions; the terminal you target may be on an older table. xterm makes this an explicit pluggable provider (`activeVersion`).
- **Pathological input.** A 10k-codepoint "cluster" of combining marks will DoS a regex-per-cluster classifier — guard cluster length before global regex matching (string-width `:33`).

## If you were building this from scratch (recommended approach + minimal pseudocode)

Recommendation: **don't ship your own Unicode tables unless you're in a no-runtime-engine environment.** In JS on Node ≥20, compose `Intl.Segmenter` + `get-east-asian-width` exactly as string-width does. In a native/WASM render loop, use a streaming segmenter (unicode-segmenter / a `uucode`-style lib) and a separate EAW table; thread break-state if you parse a stream.

```
function stringWidth(s, { ambiguousWide = false } = {}):
    if s is empty: return 0
    if s contains ESC/CSI: s = stripAnsi(s)
    if s is pure printable ASCII: return s.length        # fast path

    width = 0
    for cluster in segmentGraphemes(s):                  # UAX#29 layer
        if isAllZeroWidth(cluster):        continue       # Mark/Control/Format/ignorable
        if isRgiEmoji(cluster):            width += 2; continue
        if isUnqualifiedEmoji(cluster):    width += 2; continue   # ZWJ w/ ≥2 pictographic, keycap
        if hw = hangulWidth(cluster):      width += hw;  continue # L+V(+T) -> 2, orphans additive
        base = firstVisibleScalar(cluster)               # skip leading Prepend/Mark/ZWJ
        width += eaw(base, ambiguousWide)                # Wide/Fullwidth -> 2 else 1
        width += trailingHalfwidth(cluster)              # dakuten etc.
    return width

# wrap/truncate: walk clusters, accumulate columns, cut at boundary
function wrapToCols(s, maxCols):
    col = 0; out = ""
    for cluster in segmentGraphemes(s):
        w = clusterWidth(cluster)
        if col + w > maxCols:                            # wide char never split
            yield out; out = ""; col = 0
        out += cluster; col += w
    yield out
```
Key decisions to make explicit (don't bury them): ambiguous narrow/wide, whether ZWJ joins, tab width, Unicode version, and the wide-char snap policy at the wrap edge.

## Source map (which files in which repos to read for more)

- **Measurement, end to end (start here):** `context/string-width/index.js` — the whole 203-line algorithm; read `:146`–`:203` (the pipeline) then the helpers (`:79` Hangul, `:128` trailing halfwidth, `:31` emoji).
- **East Asian Width:** `context/get-east-asian-width/index.js:15` (`eastAsianWidth`), `lookup.js:25`,`:98` (wide hot-path + binary search), `lookup-data.js` (the range arrays), `utilities.js:8` (`isInRange`).
- **Pure UAX#29 segmentation (the segment layer):** `context/unicode-segmenter/src/grapheme.js:47` (`graphemeSegments` state machine), `:95`–`:142` (GB rules hot-path-ordered), `:319`+ (`cat()` layered lookup), `src/core.js` (`findUnicodeRangeIndex`, `decodeUnicodeData`).
- **Width inside a live emulator:** `context/xterm/src/common/services/UnicodeService.ts:28`,`:67`,`:92` (packed props, `getStringCellWidth`, join-subtract trick); `src/common/input/UnicodeV6.ts:84`–`:130` (wcwidth table); `addons/addon-unicode-graphemes/src/UnicodeGraphemeProvider.ts:24`–`:71` (VS16/RI-pair, threaded grapheme state).
- **Configurable width + cell encoding + wrapping:** `context/opentui/packages/core/src/zig/utf8.zig:5` (`WidthMethod`), `:637` (`eawToWidth` + emoji table), `:817` (`GraphemeWidthState`), `:777` (`isGraphemeBreak`), `:918`/`:949` (wrap/pos cluster handlers); `src/zig/grapheme.zig:454`–`:481` (wide/continuation cell encoding & `encodedCharWidth`).
- **Digests:** `context/NOTES/_digests/string-width.md`, `unicode-segmenter.md`, `xterm.md`.
