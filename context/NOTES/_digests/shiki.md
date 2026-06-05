# shiki

## What it is (1-2 lines)
Shiki is a syntax highlighter that runs full VSCode TextMate grammars + themes to produce richly-colored tokens, then renders them to HTML, ANSI terminal output, or raw token arrays. It is a tokenization/coloring engine, not a TUI framework — but its token model, theme bit-packing, regex-engine abstraction, and ANSI color handling are directly reusable for terminal renderers.

## Architecture (how the pieces fit; key files with paths)
Monorepo of small layered packages. For TUI-relevant work the chain is:

- `@shikijs/vscode-textmate` (vendored fork of VSCode's `vscode-textmate`): the actual TextMate state machine. Produces `tokenizeLine2()` → an `Uint32Array` of `[startIndex, encodedMetadata, startIndex, metadata, ...]` plus a `ruleStack`. Shiki treats this as a black box and only decodes the metadata.
- `packages/primitive/src/` — the lowest Shiki layer. Owns the tokenizer loop, the grammar/theme registry, grammar-state, and color resolution. No HTML/ANSI here.
  - `textmate/registry.ts` — subclasses TextMate `Registry`; caches resolved themes/grammars, lazy-loads languages, resolves embedded-language dependency graph.
  - `highlight/code-to-tokens-base.ts` — `_tokenizeWithTheme()`, the core loop: iterate lines, call `grammar.tokenizeLine2`, decode metadata into `ThemedToken`s, carry `stateStack` across lines.
  - `highlight/code-to-tokens-themes.ts` — multi-theme tokenization + `alignThemesTokenization()` (the clever token-realignment algorithm).
  - `textmate/grammar-state.ts` — wraps the opaque `StateStack` so a snippet's ending state can resume highlighting later.
  - `utils/colors.ts`, `utils/strings.ts` — color replacement + `splitLines` (offset-preserving line splitter).
- `packages/core/src/` — adds rendering on top of primitive: `code-to-hast.ts` (HTML AST), `code-to-tokens-ansi.ts` (parse ANSI-escaped *input* into tokens), `theme-css-variables.ts` (dual-theme CSS vars).
- `packages/engine-oniguruma/` and `packages/engine-javascript/` — two interchangeable `RegexEngine` implementations. WASM Oniguruma (full fidelity) vs pure-JS via `oniguruma-to-es` (no WASM, smaller bundle, ~99% grammar compat).
- `packages/cli/src/code-to-ansi.ts` — the real **ANSI terminal output** renderer: `ThemedToken` → truecolor escape sequences via `ansis`.

## Core techniques

### Encoded-metadata bit decoding (the hot path)
`code-to-tokens-base.ts:190-211`. The TextMate engine returns tokens as a flat `Uint32Array` where every other entry is a bit-packed metadata int. Shiki never allocates per-character; it strides the array two at a time:
```ts
const result = grammar.tokenizeLine2(line, stateStack, tokenizeTimeLimit)
const tokensLength = result.tokens.length / 2
for (let j = 0; j < tokensLength; j++) {
  const startIndex     = result.tokens[2 * j]
  const nextStartIndex = j + 1 < tokensLength ? result.tokens[2 * j + 2] : line.length
  if (startIndex === nextStartIndex) continue          // skip zero-width
  const metadata = result.tokens[2 * j + 1]
  const color = colorMap[EncodedTokenMetadata.getForeground(metadata)]  // index into theme palette
  const fontStyle = EncodedTokenMetadata.getFontStyle(metadata)         // bitflags
  ...
}
```
Foreground is stored as an **index into a theme `colorMap` (string[])**, not a color — colors are interned once per theme. `fontStyle` is a bitfield (`Bold|Italic|Underline|Strikethrough`), checked with `&` everywhere (e.g. `cli/.../code-to-ansi.ts:25-32`). This index-into-palette + bitfield encoding is the key trick for cheap per-token styling — worth copying for a terminal cell buffer.

### Stateful line-by-line tokenization (resumable highlighting)
`code-to-tokens-base.ts:122-274`. The `stateStack` (rule stack) threads through the line loop and is the *only* cross-line state. This is what makes multi-line constructs (block comments, template strings) work. Two power features fall out of exposing it:
- `grammarContextCode`: tokenize a prefix first, throw away its tokens, keep its `stateStack`, then start the real code already "inside" a context (e.g. highlight a Vue `<script>` body as if it had the surrounding tags).
- `GrammarState` (`grammar-state.ts`): wraps the stack + lang + theme so you can stop highlighting at line N and resume at line N+1 in a later call. For an incremental/streaming TUI editor, you'd cache one `GrammarState` per line and re-tokenize only from the first changed line forward. Note the stack is stored *per theme* (`_stacks: Record<theme, StateStack>`) because dual-theme tokenizes the same code N times.

### Multi-theme token alignment (dual light/dark)
`code-to-tokens-themes.ts:97-136` `alignThemesTokenization()`. Two themes can split the same line into *different* token boundaries (`console.log` → 6 tokens in one, 5 in another). To emit one DOM/cell stream with per-theme colors, it walks all themes' tokens in lockstep, repeatedly slicing every token to the current **minimum content length** so all themes share identical boundaries:
```ts
const minLength = Math.min(...current.map(t => t.content.length))
// tokens at minLength advance; longer tokens are split: head emitted, tail kept
```
Result: identical token count/boundaries across themes, colors stored in `token.variants[themeColor]`. Then `flatTokenVariants` (`core/utils/tokens.ts`) emits either CSS vars or `light-dark()`. The lockstep-min-slice merge is a clean general technique for reconciling two independently-segmented streams over the same text.

### Performance guards in the loop
- `tokenizeMaxLineLength`: lines over the limit become one un-tokenized token (`base.ts:169`) — avoids pathological regex blowup on minified lines.
- `tokenizeTimeLimit` (default 500ms): passed into the engine per line.
- Empty lines short-circuit to `[]` without invoking the grammar (`base.ts:162`).
- Theme objects are cached: `Theme.createFromRawTheme` is expensive, so `registry.ts:64-72` keeps a `WeakMap<IRawTheme, TextMateTheme>` and overrides `setTheme` to reuse it — important because dual-theme support switches themes constantly.

### Pluggable regex engine (the hard portability problem)
TextMate grammars are written in Oniguruma regex syntax, which native JS `RegExp` cannot fully execute. Shiki abstracts a `RegexEngine` with `createScanner(patterns)` / `createString(s)`:
- `engine-oniguruma/src/index.ts` — wraps real Oniguruma compiled to WASM. Full fidelity, ~big bundle.
- `engine-javascript/src/scanner.ts` — `JavaScriptScanner` implements the `OnigScanner` interface using arrays of native `RegExp`. `findNextMatchSync` runs every pattern from `startPosition`, returns the match closest to start (immediate return on exact-start match as a fast path), and maps JS `match.indices` into Oniguruma's `captureIndices` `{start,end,length}` shape. Null capture groups are encoded as `start=end=MAX (4294967295)`.
- `engine-javascript/src/engine-compile.ts` — converts each Oniguruma pattern to a JS `RegExp` via `oniguruma-to-es` with carefully chosen rules: `allowOrphanBackrefs` (TM grammars merge backrefs across patterns), `singleline` (`^`→`\A`, `$`→`\Z` since matching is line-by-line), `hasIndices: true` (needed to recover capture offsets), and `lazyCompileLength: 3000` (defer compiling huge precompiled patterns until first use). Patterns are cached in a `Map<string, RegExp|Error>`; `forgiving` mode stores the error and skips the pattern instead of throwing.

### ANSI handling (two directions — note the asymmetry)
1. **ANSI input → tokens** (`core/.../code-to-tokens-ansi.ts`): when `lang === 'ansi'`, Shiki bypasses TextMate entirely (`code-to-tokens-base.ts:21-24` intercepts before delegating) and uses `ansi-sequence-parser` to parse escape codes into colored segments. Builds a palette from the theme's `terminal.ansi*` colors with VSCode-compatible fallbacks, resolves named/256/truecolor via `createColorPalette`, handles the `reverse` decoration by swapping fg/bg, and `dim` by halving alpha (`dimColor`, lines 105-147 — careful per-hex-length alpha math for #rgb/#rgba/#rrggbb/#rrggbbaa).
2. **Tokens → ANSI output** (`cli/src/code-to-ansi.ts`): the actual terminal renderer. For each token: `c.hex(color)(text)` (truecolor `38;2;r;g;b` via `ansis`), then layer bold/italic/underline/strikethrough by checking `fontStyle &` flags. Critically it **pre-flattens alpha** because terminals have no alpha channel: `hexApplyAlpha` (`cli/src/colors.ts`) composites `#rrggbbaa` over the theme background (black for dark themes, white for light) — `r*a` for dark, `r*a + 255*(1-a)` for light. This is the canonical fix for "theme colors have transparency but my terminal doesn't."

## Code patterns worth stealing

Offset-preserving line split (every token knows its byte offset into the source — useful for mapping back to cursor/selection):
```ts
// strings.ts — split on /(\r?\n)/g keeping the captured separators
const parts = code.split(/(\r?\n)/g)
for (let i = 0; i < parts.length; i += 2) {
  lines.push([parts[i], index])
  index += parts[i].length + (parts[i+1]?.length || 0)
}
```

Color interning: store a `colorMap: string[]` per theme; tokens carry an *index*, not a hex string. Decode lazily. (TextMate metadata + `colorMap[getForeground(metadata)]`.)

FontStyle as bitflags, applied additively:
```ts
let fontStyle = FontStyle.None
if (token.decorations.has('bold'))   fontStyle |= FontStyle.Bold
if (token.decorations.has('italic')) fontStyle |= FontStyle.Italic
// later: if (fontStyle & FontStyle.Bold) text = bold(text)
```

Resumable highlight state as a first-class value: snapshot the rule stack per line; on edit, recompute from the first dirty line until the stack converges with the cached one (stop early when stable). Shiki exposes the stack via `GrammarState`; the convergence loop is left to the consumer (e.g. `@shikijs/monaco`).

## Gotchas / non-obvious decisions
- "ANSI" in Shiki core means **parsing ANSI-colored input**, not emitting it. Emitting ANSI for terminals lives only in `@shikijs/cli`. Don't look in core for an escape-sequence writer.
- Tokens index into a `colorMap` — you must keep the map alive alongside the tokens, and re-tokenize (not just remap) when switching themes, because token *boundaries* can differ between themes (hence `alignThemesTokenization`).
- The TextMate `StateStack` is fully opaque; `getScopes()` walks `nameScopesList`/`parent` manually with a `visited` Set to guard against cycles (`grammar-state.ts:106`).
- JS regex engine returns the match *closest to start*, scanning all patterns each call — O(patterns) per position. Oniguruma's native scanner is more efficient; the JS engine trades speed for zero-WASM bundles.
- Alpha must be flattened before ANSI output; passing `#rrggbbaa` to a terminal truecolor sequence silently drops alpha and looks wrong against the theme bg. `hexApplyAlpha` composites against bg per theme type.
- `lazyCompileLength` and per-line `tokenizeTimeLimit`/`tokenizeMaxLineLength` exist because TextMate regexes can catastrophically backtrack on long/minified lines — any TUI doing live highlighting needs these guards.

## Relevance (which advanced-TUI topics this teaches)
- **ansi-escapes**: truecolor `38;2` emission, `fontStyle` bitflags → SGR, ANSI-input parsing, alpha-over-background compositing for terminals (`@shikijs/cli`, `code-to-tokens-ansi.ts`).
- **rendering-pipeline**: source → stateful tokenizer → styled token array → backend renderer (HTML/ANSI); index-into-palette + bitflag styling for cheap per-cell color.
- **widgets-rich-content**: building syntax-highlighted code views; resumable `GrammarState` for incremental/streaming re-highlight on edit.
- **app-architecture**: clean layering (engine ↔ tokenizer ↔ renderer), pluggable regex engine behind a tiny interface, theme/grammar registry with caching and lazy embedded-language loading.
