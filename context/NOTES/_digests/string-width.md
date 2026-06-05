# string-width

## What it is (1-2 lines)
Computes the visual column width of a string for terminal layout — how many monospace cells it occupies. Handles East Asian wide chars, emoji (RGI + ZWJ + keycap + skin tone), Hangul jamo composition, combining/zero-width marks, and ANSI escape stripping. sindresorhus/string-width v8, ~200 LOC, two deps.

## Architecture (how the pieces fit; key files with paths)
- `index.js` — the entire implementation. One default export `stringWidth(input, options)`.
- `index.d.ts` — `Options = { ambiguousIsNarrow?: boolean (default true); countAnsiEscapeCodes?: boolean (default false) }`.
- Dependencies do the heavy Unicode lifting:
  - `strip-ansi` (via `ansi-regex`) removes escape sequences before measuring.
  - `get-east-asian-width` maps a code point to its EAW width (1 or 2), with `ambiguousAsWide` option.
- `Intl.Segmenter` (built into V8/Node ≥20) does grapheme cluster segmentation — no userland grapheme table needed.

The pipeline is a single pass: validate → strip ANSI → ASCII fast path → segment into grapheme clusters → classify each cluster → sum widths.

## Core techniques (the actual engineering)

### 1. Grapheme-cluster segmentation matches terminal rendering
`const segmenter = new Intl.Segmenter();` (index.js:16). The loop `for (const {segment} of segmenter.segment(string))` (index.js:175) iterates *user-perceived characters* (grapheme clusters), not code points or UTF-16 units. This is the key insight: a terminal renders one cluster in N cells, so width must be computed per-cluster, not per-code-point. E.g. `é` (e + combining acute) is one cluster of width 1; `👨‍👩‍👧‍👦` (family ZWJ sequence, 7 code points) is one cluster of width 2.

### 2. Layered fast paths to skip the expensive segmenter
Performance matters because this runs in hot layout loops. Three short-circuits before the general path:
- Empty / non-string → `0` (index.js:147).
- ANSI only stripped if `` (ESC) or `` (CSI) is present (index.js:159) — avoids constructing the strip-ansi regex machinery for clean strings.
- **Printable-ASCII fast path** (index.js:168): `if (/^[ -~]*$/.test(string)) return string.length;`. For pure ASCII, width === length. No segmenter, no regex per char, no EAW lookup. This covers the overwhelmingly common case.

### 3. Zero-width / non-printing cluster detection
`zeroWidthClusterRegex = /^(?:\p{Default_Ignorable_Code_Point}|\p{Control}|\p{Format}|\p{Mark}|\p{Surrogate})+$/v` (index.js:19). A whole cluster made only of these contributes 0. Catches: control chars, tabs (`\t` is width 0 *by design* — issue #45), newlines, ZWSP/ZWNJ/ZWJ alone, VS15/VS16 alone, BOM, lone surrogates, combining-marks-only clusters, tag sequences. Uses the `v` (Unicode sets) regex flag for `\p{...}` property escapes.

### 4. Emoji width = 2, via two detectors
- **RGI emoji**: `rgiEmojiRegex = /^\p{RGI_Emoji}$/v` (index.js:25). The `\p{RGI_Emoji}` property (ES2024 `v` flag) matches *Recommended for General Interchange* emoji sequences as whole clusters — fully-qualified ZWJ sequences, flags, skin-tone modifiers, keycaps. One regex test handles most emoji.
- **Minimally-qualified / unqualified sequences** that RGI misses (`isDoubleWidthNonRgiEmojiSequence`, index.js:31): emoji that *should* render double-width but lack the VS16 qualifier. Two heuristics:
  - Unqualified keycap: `/^[\d#*]⃣$/` (digit/#/* + combining keycap, no VS16).
  - ZWJ sequence with ≥2 `Extended_Pictographic` code points (e.g. `❤‍🔥` heart-on-fire missing VS16): `segment.includes('‍')` then count pictographics (index.js:42-45).
  - Guard: `if (segment.length > 50) return false` (index.js:33) — real emoji clusters are <30 chars; bails on pathological input before running global regex matching.

### 5. Hangul jamo syllable composition (the hard part)
Decomposed Hangul (separate Leading + Vowel + Trailing jamo) can land in one grapheme cluster and a terminal composes them into width-2 syllable blocks. `hangulClusterWidth` (index.js:79) walks the cluster's visible code points:
- Classifies each as Leading (L), Vowel (V), or Trailing (T) jamo by code-point ranges, including the *extended* jamo blocks (L: U+A960–A97C; V: U+D7B0–D7C6; T: U+D7CB–D7FB) alongside the standard U+11xx block (index.js:58-71).
- When it sees **L immediately followed by V**, it consumes L+V (+T if present) as one syllable of width 2 and advances the index 1 or 2 (index.js:113-120).
- **Unmatched jamo stay additive** — repeated leading jamo `ᄀᄀ` = 4, vowel-only `ᅡᅡᅡ` = 3. This deliberately mirrors how target terminals render orphan jamo, not the Unicode "ideal".
- Mixed clusters (jamo + a precomposed syllable like `ᄀ가`) fall back to summing EAW for the non-jamo remainder (index.js:103-108).
- Returns `undefined` (not a Hangul cluster) so the caller can fall through to the generic EAW path.

### 6. Generic East Asian Width fallback
For anything else (index.js:194): take the cluster's **first visible scalar** (after stripping leading non-printing chars via `baseVisible` / `leadingNonPrintingRegex`, index.js:50,22) and look up its EAW. Wide/Fullwidth → 2, else → 1. Ambiguous chars (±, ×, ÷) controlled by `ambiguousIsNarrow` → mapped to `{ambiguousAsWide: !ambiguousIsNarrow}` (index.js:173).

### 7. Trailing halfwidth/fullwidth forms (issue #55)
Halfwidth Katakana + voiced sound mark (`ﾊﾞ`) is one cluster but the dakuten adds a cell. `trailingHalfwidthWidth` (index.js:128) scans every code point *after the first* and adds EAW for any in the Halfwidth/Fullwidth Forms block (U+FF00–U+FFEF). So `ﾊﾞ`=2, `ｳﾞｰ`=3.

## Code patterns worth stealing

Iterate user-perceived characters, not code points:
```js
const segmenter = new Intl.Segmenter();
for (const {segment} of segmenter.segment(string)) {
  // segment is one grapheme cluster
}
```

Cheap pre-check before an expensive operation:
```js
// Don't even build the ANSI regex unless an escape byte exists
if (!countAnsiEscapeCodes && (s.includes('') || s.includes(''))) {
  s = stripAnsi(s);
}
// ASCII width == length; skip all Unicode machinery
if (/^[ -~]*$/.test(s)) return s.length;
```

`v`-flag Unicode property regexes as whole-cluster classifiers:
```js
const zeroWidth = /^(?:\p{Default_Ignorable_Code_Point}|\p{Control}|\p{Format}|\p{Mark}|\p{Surrogate})+$/v;
const rgiEmoji  = /^\p{RGI_Emoji}$/v;   // matches entire RGI emoji sequences
```

Range-based classification + lookahead compose (Hangul):
```js
if (isLeadingJamo(cp) && isVowelJamo(cps[i+1])) {
  width += 2;
  i += isTrailingJamo(cps[i+2]) ? 2 : 1;  // consume the whole syllable
}
```

Bail-out guard against pathological input before global regex matching:
```js
if (segment.length > 50) return false; // real emoji clusters are < 30 chars
```

## Gotchas / non-obvious decisions
- **Tabs are width 0 by design** (issue #45) — not 8, not 1. Width is content-only; tab expansion is the caller's job.
- **VS15 (text-style selector) does NOT force width 1** in practice. Many terminals still render `⏳︎`, `⌚︎`, `⭐︎` as 2 because EAW says Wide. The library matches real terminal behavior over the spec (index.js comment rule 5; many tests lines 252-261).
- **Ambiguous defaults to narrow** per UAX #11: if context can't be established, treat ambiguous as 1.
- The first-visible-scalar approach (`baseVisible`) deliberately ignores leading Prepend/Format/Mark code points (Arabic number sign U+0600, leading ZWJ) so they don't "steal" the base width — `؀你`=2, `‍A`=1.
- Requires **Node ≥20** for `Intl.Segmenter` + `RGI_Emoji` / `v`-flag regex support. This offloads the entire grapheme + emoji table maintenance to the engine — no shipped Unicode data, tiny package.
- Single regional indicator alone = 1, a pair (a flag) = 2 — handled by RGI matching whole clusters; the segmenter pairs the indicators.
- Returns 0 for non-string input rather than throwing — defensive for layout code.

## Relevance (which advanced-TUI topics this teaches)
This is the canonical reference for **unicode-text-width**: how to turn a JS string into terminal cell counts correctly, the single most error-prone primitive in any TUI (every box-drawing, table, wrapping, truncation, and cursor-positioning routine depends on it). Also teaches **ansi-escapes** handling (escapes occupy 0 cells, must be stripped before measuring) and the **layout** foundation — width is the input to wrapping/alignment/grid sizing.
