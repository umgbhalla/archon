# unicode-segmenter

## What it is (1-2 lines)
A zero-dependency JS implementation of UAX#29 extended grapheme-cluster segmentation (port of Rust's `unicode-segmentation`), tuned to outperform the native `Intl.Segmenter`. For TUI work it answers the load-bearing question "how many cursor cells does this string occupy / where do I cut it" — the prerequisite for any correct width/layout/cursor math in a terminal.

## Architecture (how the pieces fit; key files with paths)
- `src/grapheme.js` — the engine. A single generator `graphemeSegments(input)` implements the GB1–GB999 boundary rules as a streaming state machine, plus the per-codepoint category lookup `cat(cp)`. Wrappers `splitGraphemes` and `countGraphemes` consume it.
- `src/core.js` — shared primitives: `findUnicodeRangeIndex` (binary search over sorted `[from,to,cat]` ranges) and `decodeUnicodeData` (decoder for the compressed range tables). Defines the `Segmenter<Ext>` / `SegmentOutput<Ext>` types.
- `src/_grapheme_data.js`, `src/_emoji_data.js`, `src/_general_data.js`, `src/_incb_data.js` — generated data tables (do not edit; produced by `scripts/unicode.js`). Two strings per table: a base36 delta-encoded range list and a parallel base36 category string.
- `src/emoji.js` / `src/general.js` — single-codepoint property matchers (`isExtendedPictographic`, `isEmojiPresentation`, `isLetter`, `isAlphabetic`, `isNumeric`) built on the same range tables. Useful standalone for width heuristics.
- `src/intl-adapter.js` — a drop-in `Intl.Segmenter`-shaped class (`segment()`, `resolvedOptions()`, `Segments.containing(idx)`) wrapping `graphemeSegments`. Only `grapheme` granularity; `word`/`sentence` throw.
- `src/index.js` — barrel re-export. `package.json` ships granular subpath exports (`./grapheme`, `./emoji`, `./general`, `./utils`, `./intl-adapter`) so bundlers tree-shake unused tables.
- `scripts/unicode.js` + `scripts/lib/encoding.js` — offline pipeline that ingests Unicode data files, sorts/merges ranges, filters out ranges covered by inlined fast paths, and emits the `_*_data.js` files via `encodeUnicodeData`.

## Core techniques (the actual engineering)

### Streaming boundary state machine (no array of codepoints)
`graphemeSegments` (`src/grapheme.js:47`) walks the UTF-16 string by code unit, decoding code points on the fly with `input.codePointAt(cursor)` and advancing `cursor += cp <= 0xFFFF ? 1 : 2` (`:207`). It never materializes a code-point array — it keeps only the previous category (`catBefore`) and a handful of scalar flags. Segments are emitted as `input.slice(index, cursor)` lazily via `yield`. This is the right shape for a TUI: O(1) memory, early-exit friendly, and you can stop after N graphemes without scanning the rest.

State carried across the loop (`:59`–`:89`):
- `catBefore` / `catAfter` — Grapheme_Cluster_Break category of the codepoint before/after the cursor.
- `riCount` — count of Regional_Indicator codepoints, for the flag rule (pairs of RI = one flag).
- `extPic`, `emoji` — track the `ExtPic Extend* ZWJ × ExtPic` emoji-ZWJ-sequence pattern (GB11).
- `consonant`, `linker` — Indic conjunct (InCB) state for GB9c.
- `index`, `_catBegin`, `_hd` — segment-start byte offset, start category, and start codepoint (the `_`-prefixed fields are emitted as private extras for advanced callers).

### Boundary rules as an ordered if/else by frequency (not by rule number)
The GB rules are checked in *hot-path-first* order, not spec order (`:95`–`:142`). The common no-break case "× (Extend | ZWJ | SpacingMark)" (GB9/GB9a) is tested early (`:110`), CR×LF (GB3) first, and the expensive Indic GB9c check (`:139`) is last and additionally gated on `catAfter === 0 && consonant && linker`. The flag rule uses a slick parity trick: `boundary = riCount++ % 2 === 1` (`:124`) — post-increment makes every second RI a no-break.

### Categories as small integers, not strings
The 15 Grapheme_Cluster_Break values are numbered 0–14 (`GraphemeCategory`, generated). All comparisons are integer equality (`catBefore === 14`), which is branch-predictor and JIT friendly and lets two categories pack into one byte.

### `cat(cp)`: layered lookup with inlined fast paths (`src/grapheme.js:319`)
The category function is the perf core. Rather than one big binary search, it short-circuits by codepoint region:
1. **ASCII fast path** (`cp < 0x80`): pure branches, no table — returns Control/CR/LF/Any directly (`:321`).
2. **Two 4-bit packed segment tables** `SEG0` (0x0080–0x2FFF) and `SEG1` (0xA000–0xABFF). Each byte stores two adjacent codepoints' categories (`cat << 4` high nibble for odd, low nibble for even). Lookup is `SEG0[(cp-MIN)>>1]` then nibble-select on `cp & 1` (`:329`). Total index ≈ 7.4KB built once at module init (`SEG_CURSOR` IIFE, `:284`).
3. **CJK fast path** (0x3000–0x9FFF): ~28k codepoints with only ~12 non-Any ranges, inlined as hand-written branches (`:333`) instead of stored.
4. **Hangul syllables** (0xAC00–0xD7A3): LV vs LVT computed arithmetically — `(cp-0xAC00) % 28 === 0 ? LV : LVT` (`:349`) — 11k codepoints with zero table cost.
5. **Hangul Jamo Ext-B, Private Use**: more inlined branches (`:352`, `:357`).
6. **Specials + all non-BMP**: fall back to `findUnicodeRangeIndex` binary search over `grapheme_ranges`, starting the search at `SEG_CURSOR` so it skips the ranges already covered by the packed tables (`:361`).

The principle: pick the representation per region by density/cost. Dense-but-uniform regions (Hangul) → arithmetic; sparse-but-clustered (CJK) → inlined branches; medium-density BMP → packed nibble array; long tail → binary search.

### Compressed, self-describing data tables
`decodeUnicodeData` (`src/core.js:35`) decodes two base36 strings into `[from, to, cat]` ranges. The range string is delta-encoded: alternating `base36(from)` and `base36(to - from)` pairs; empty token means 0. base36 keeps even 6-figure codepoints to a few chars. The category string is one base36 digit per range, indexed `cats[i>>1]`. `encodeUnicodeData` (`scripts/lib/encoding.js:15`) is the inverse used at build time. Net effect: the entire grapheme table is two literals in a ~7KB source file, and the runtime index is rebuilt in memory at load.

## Code patterns worth stealing

Streaming variable-width scan over UTF-16 (the canonical TUI cursor-advance loop):
```js
let cp = input.codePointAt(0);
let cursor = cp <= 0xFFFF ? 1 : 2;     // surrogate-pair aware step
while (cursor < input.length) {
  cp = input.codePointAt(cursor);
  // ...decide boundary using only prev/next category + scalar flags...
  if (boundary) { yield input.slice(index, cursor); index = cursor; }
  cursor += cp <= 0xFFFF ? 1 : 2;
  catBefore = catAfter;
}
```

Parity-based pairing rule (regional-indicator flags / any "break every other one"):
```js
boundary = riCount++ % 2 === 1; // post-inc: 1st RI breaks, 2nd joins, repeat
```

4-bit nibble-packed lookup table (two categories per byte) for a BMP region:
```js
seg[idx] = cp & 1
  ? (seg[idx] & 0x0F) | (cat << 4)   // odd cp -> high nibble
  : (seg[idx] & 0xF0) |  cat;        // even cp -> low nibble
// read:
let byte = SEG0[(cp - MIN) >> 1];
return cp & 1 ? byte >> 4 : byte & 0x0F;
```

Binary search over sorted inclusive ranges, with a start offset to skip already-handled prefixes:
```js
function findUnicodeRangeIndex(cp, ranges, lo = 0, hi = ranges.length - 1) {
  while (lo <= hi) {
    let mid = (lo + hi) >>> 1, r = ranges[mid];
    if (cp < r[0]) hi = mid - 1;
    else if (cp > r[1]) lo = mid + 1;
    else return mid;
  }
  return -1;
}
```

## Gotchas / non-obvious decisions
- **Indices are UTF-16 code-unit offsets, not code points.** `segment.index` / `slice` use `.length`; astral chars count as 2. Matches `Intl.Segmenter`, but TUI width math must not assume index == column.
- **Grapheme count != display width.** This lib gives cluster boundaries only; an emoji ZWJ sequence is one grapheme but two columns wide. You still need an East-Asian-Width / wcwidth layer on top — the `emoji.js`/`general.js` matchers are the building blocks but width is out of scope here.
- **`cat()`'s SEG tables are built once at import** via a top-level IIFE (`SEG_CURSOR`, `:284`). First import pays ~7.4KB of array fill; thereafter lookups are branch + shift. Don't re-import per call.
- **Hot rules are ordered by frequency, not GB number** — easy to misread as a bug. The early `catAfter === 3|14|11` block intentionally pre-empts later Hangul/Indic branches because Extend/ZWJ/SpacingMark dominate real text.
- **GB9c (Indic conjunct) is gated behind `cp >= 2325`** before touching the consonant/linker state (`:171`) so non-Indic text never pays for it; ZWNJ (U+200C) explicitly breaks the linker pattern (`:177`).
- **`intl-adapter` only does graphemes.** `word`/`sentence` granularity throws; `Segments.containing` is O(n) (re-scans from start each call) and the upstream `Intl` type wrongly says it can't return undefined.
- **`src/utils.js` surrogate helpers are all `@deprecated never used`** — dead code kept for API stability; don't rely on them, the engine inlines surrogate handling.
- **Correctness strategy**: verified against the official Unicode test suite and fuzzed against native `Intl.Segmenter` with `fast-check` (`test/`), maintaining 100% coverage — the way to trust a hand-rolled segmenter.

## Relevance (which advanced-TUI topics this teaches)
- **unicode-text-width**: the foundational layer — correct grapheme clustering is the prerequisite for cursor positioning, truncation, and column math in any terminal renderer; emoji-ZWJ, regional-indicator, and Indic-conjunct handling are exactly the cases that break naive `.length`/`[...str]` approaches.
- **rendering-pipeline**: demonstrates a zero-allocation streaming scan and per-region representation choice (packed nibble tables, arithmetic, inlined branches, binary search) — the kind of micro-optimization a render hot loop measuring string widths every frame needs.
