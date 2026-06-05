# cli-highlight

## What it is (1-2 lines)
A small library/CLI that wraps highlight.js to produce ANSI-colored source code for the terminal. It does not own a parser — it leans on highlight.js to emit HTML, then re-parses that HTML and maps each `hljs-*` token class to a chalk styling function.

## Architecture (how the pieces fit; key files with paths)
The whole project is ~3 source files. The pipeline is strictly one-directional, no diffing, no state, no event loop.

- `src/index.ts` — the engine. `highlight()` (entry) -> highlight.js -> `colorize()` -> recursive `colorizeNode()`.
- `src/theme.ts` — the token->style mapping layer. Defines `Tokens<T>` (the full highlight.js token vocabulary), `DEFAULT_THEME` (token -> `chalk` fn), and JSON (de)serialization (`fromJson`/`toJson`/`parse`/`stringify`).
- `src/cli.ts` — thin CLI: yargs arg parsing, STDIN-vs-file input, optional JSON theme file, write to stdout.

Data flow (`src/index.ts:86-94`):
```
code (string)
  -> hljs.highlight(code, {language}) OR hljs.highlightAuto(code, subset)   // returns HTML string
  -> parse5.parseFragment(html, {treeAdapter: htmlparser2Adapter})          // HTML string -> DOM-ish tree
  -> fragment.childNodes.map(colorizeNode).join('')                         // tree -> ANSI string
```

The clever architectural decision: rather than re-implement a lexer per language, it reuses highlight.js's HTML output (`<span class="hljs-keyword">...</span>`) as an intermediate representation, then transforms HTML-tree -> ANSI. highlight.js becomes the tokenizer; this lib is purely the renderer.

## Core techniques (the actual engineering)

### HTML token stream as an intermediate representation
highlight.js does not expose a clean token array in its public API; it emits HTML. cli-highlight treats that HTML as the token stream. It parses it back into a tree with `parse5` using the `parse5-htmlparser2-tree-adapter` (`src/index.ts:36-38`) so it can walk `node.type === 'text' | 'tag'` nodes. This is the key insight worth remembering: when a tool only gives you styled HTML, you can recover semantic tokens by re-parsing the HTML and reading the class names.

### Recursive tree walk with context propagation (`src/index.ts:8-33`)
`colorizeNode(node, theme, context)` is the heart:
- `text` node: if `context === undefined` (top-level text not inside any token span), style with `theme.default`. If inside a token span, return raw text — the *parent tag* will style the whole concatenated string. This avoids double-wrapping ANSI codes and keeps nesting cheap.
- `tag` node: extract the token name via `/hljs-(\w+)/.exec(node.attribs.class)`. If matched, recurse into children passing the token name as `context`, join the children, then wrap the joined string once with the matching style function.
- Crucial fallback (`src/index.ts:27-29`): if a tag's class is NOT prefixed with `hljs-` (happens with sublanguages — JSX, embedded Markdown code blocks, etc.), it recurses but resets `context` to undefined and returns children unstyled-by-tag. This handles highlight.js's nested-language output gracefully instead of crashing.
- Anything else throws `Invalid node type` (`src/index.ts:32`).

Note the styling is applied at the tag boundary on the *fully joined child string*, not per-child. So `<span class="hljs-string">"a<span class="hljs-subst">b</span>c"</span>` produces children where `subst` is styled inline (its own tag), text "a"/"c" returns raw, and the outer `string` tag wraps the whole `"a<styled-b>c"` in red. ANSI codes therefore nest correctly because chalk resets and re-opens around inner codes.

### Token vocabulary as a typed contract (`src/theme.ts:6-211`)
`Tokens<T>` enumerates every highlight.js token class (`keyword`, `built_in`, `string`, `subst`, `selector-tag`, `template-variable`, `addition`/`deletion` for diffs, etc.) as a generic over the value type. Reused two ways:
- `Theme extends Tokens<(s: string) => string>` — runtime: token -> formatter fn.
- `JsonTheme extends Tokens<Style | Style[]>` — serializable: token -> chalk style name(s).
This is a clean pattern: define the key vocabulary once, parametrize the value type for different representations.

### Three-level theme fallback (`src/index.ts:13, 24`)
Every lookup is `(theme[token] || DEFAULT_THEME[token] || plain)(text)`. A user theme need only override the tokens it cares about; everything else falls through to `DEFAULT_THEME`, and unknown tokens fall through to `plain` (identity). No merge step needed — fallback is inlined at the call site.

### JSON theme (de)serialization with chalk chaining (`src/theme.ts:513-527`)
`fromJson` turns `["red","bold"]` into a chalk function by reducing over the chalk builder: start with `chalk`, walk each style name accessing `chalk.red.bold` via property chaining; `"plain"` short-circuits to the identity `plain`. Lets users define themes in pure JSON files (`--theme foo.json`) that get compiled to formatter functions at load time.

### CLI input handling (`src/cli.ts:39-64`)
- Detects piped input vs interactive by checking `process.stdin.isTTY`. If not a TTY and no file arg, it reads STDIN via the `readable`/`end` event pattern, accumulating chunks.
- If a file is given, infers language from the file extension (`path.extname(file).slice(1)`) but only if `supportsLanguage(extension)` (`src/cli.ts:73-77`).
- Uses `ignoreIllegals: true` so malformed code still renders instead of throwing.
- Writes via `process.stdout.write(..., cb)` wrapped in a Promise to respect backpressure before `process.exit(0)`.

## Code patterns worth stealing

Recursive styler with context to avoid double-wrapping:
```ts
function colorizeNode(node, theme, context?) {
  if (node.type === 'text')
    return context === undefined ? (theme.default ?? plain)(node.data) : node.data
  if (node.type === 'tag') {
    const m = /hljs-(\w+)/.exec(node.attribs.class)
    const inner = node.childNodes.map(n => colorizeNode(n, theme, m ? m[1] : undefined)).join('')
    return m ? (theme[m[1]] ?? DEFAULT_THEME[m[1]] ?? plain)(inner) : inner
  }
}
```

Vocabulary-once, value-type-parametrized interfaces:
```ts
interface Tokens<T> { keyword?: T; string?: T; /* ...all token classes... */ }
interface Theme     extends Tokens<(s: string) => string> { default?: (s: string) => string }
interface JsonTheme extends Tokens<Style | Style[]> {}
```

Build a chalk styler from a list of style names:
```ts
style.reduce((prev, cur) => cur === 'plain' ? plain : prev[cur], chalk)  // ["red","bold"] -> chalk.red.bold
```

Inlined fallback chain (no theme-merge step):
```ts
(theme[token] || DEFAULT_THEME[token] || plain)(text)
```

## Gotchas / non-obvious decisions
- It re-parses HTML it just generated. Sounds wasteful, but it is the only stable way to read highlight.js token boundaries since highlight.js's public API only emits HTML, not tokens. The `parse5-htmlparser2-tree-adapter` is chosen specifically so node shapes are `{type, data, attribs, childNodes}` (htmlparser2 style) rather than parse5's default tree shape.
- Sublanguage spans without an `hljs-` prefix are intentionally passed through unstyled-at-this-level (`src/index.ts:27-29`); forgetting this would throw or mis-style embedded languages.
- Styling happens at tag close on the *joined* child string, relying on chalk to nest ANSI reset codes. It does not manually manage SGR open/close sequences — chalk owns all ANSI emission.
- `toJson` (`src/theme.ts:532-539`) iterates `Object.keys(jsonTheme)` on the freshly-created empty object instead of `theme` — effectively a no-op bug; `stringify` would return `{}`. Real serialization relies on `fromJson` direction only.
- `chalk` auto-detects color support; if stdout is not a TTY (piped), chalk emits no codes, so `highlight | cat` is plain. This is delegated entirely to chalk, not handled here.
- No streaming: the entire input is buffered, highlighted, and written at once. Fine for files; not suited to live/incremental rendering.

## Relevance (which advanced-TUI topics this teaches)
- **ansi-escapes**: token -> ANSI color mapping, delegating SGR emission to chalk, nesting/reset behavior, TTY-aware color stripping. This is the canonical "syntax highlighting in a terminal" pattern.
- **widgets-rich-content**: how to render styled code blocks — directly applicable to building a code viewer/pager widget or rendering Markdown fenced code in a TUI.
- **rendering-pipeline**: a clean example of source -> intermediate representation (HTML/token tree) -> output transform; recursive tree-walk rendering with context propagation to avoid redundant escape codes.
