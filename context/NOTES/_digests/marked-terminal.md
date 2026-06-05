# marked-terminal

## What it is (1-2 lines)
A `marked` renderer extension that turns Markdown into styled, ANSI-colored terminal output: syntax-highlighted code blocks, boxed tables, lists, headings, blockquotes, OSC-8 hyperlinks, and emoji. Single-file library (`index.js`, ~680 lines) that plugs into marked's renderer hook system.

## Architecture (how the pieces fit)
- **Single source file**: `/Users/umang/hub/zonko/archon/context/marked-terminal/index.js`. No internal modules; everything is one Renderer prototype plus free functions.
- **Two integration shapes** for marked compatibility:
  - `Renderer` (default export, `index.js:57`) — classic marked renderer object with prototype methods (`heading`, `code`, `table`, etc).
  - `markedTerminal(options, highlightOptions)` (`index.js:364`) — newer marked "extension" form. It builds `{ renderer: {...}, useNewRenderer: true }` by reducing over the list of renderer func names (`index.js:367-388`), wrapping each so that `r.options`/`r.parser` are rebound from marked's `this` on every call (`index.js:392-396`). This bridge is the key to supporting `marked >=1 <17` across API changes.
- **Dual token/string signature handling**: every renderer method begins with `if (typeof X === 'object')` (e.g. `index.js:91-96`, `116-120`, `213-236`). Old marked passed pre-rendered strings; new marked passes token objects that must be parsed via `this.parser.parse(...)` / `this.parser.parseInline(...)`. One method body handles both eras.
- **Dependencies do the heavy lifting**: `chalk` (color), `cli-table3` (box-drawing tables), `cli-highlight` (code syntax highlighting), `node-emoji`, `ansi-escapes` (OSC-8 links), `supports-hyperlinks` (capability detection), `ansi-regex` (width math).
- **Build**: rollup produces a CJS twin (`index.cjs`) alongside the ESM `index.js`; `exports` map serves both (`package.json:7-13`).

## Core techniques (the actual engineering)

### Visible-width measurement that ignores ANSI
`textLength(str)` strips ANSI escapes with a precompiled `ansiRegex()` before counting characters (`index.js:70-72`, regex cached at `index.js:20`). This is the foundation for all wrapping/layout math — you cannot use `String.length` once color codes are embedded. (Note: it counts code points, not display columns, so wide CJK/emoji width is NOT handled — see Gotchas.)

### Reflow that preserves ANSI runs (`reflowText`, `index.js:405-499`)
The hard part of the repo. Word-wraps colored text to a target width without splitting or miscounting escape sequences:
1. Split into "sections" on hard-return markers (`\r`, or `<br />` under GFM) so explicit breaks are never reflowed (`index.js:408-409`).
2. Split each section on the SGR color-escape regex `/(\[(?:\d{1,3})(?:;\d{1,3})*m)/g` so escape codes become standalone fragments (`index.js:415`).
3. Walk fragments: a fragment with `textLength === 0` is an escape code — append it whole, set `lastWasEscapeChar = true`, and crucially do NOT add a separating space after it (`index.js:431-436`, `442-443`). This prevents stray spaces appearing between a color-on code and the first word.
4. For real words, track `column` (visible width) and greedily push lines; words longer than `width` are hard-split into width-sized chunks (`index.js:446-478`).

### Hard vs soft line breaks via a sentinel char
`\r` is reused as `HARD_RETURN` (`index.js:26`). Comment at `index.js:22-25` explains why it's safe: marked's lexer pre-normalizes `\r`/`\r\n` to `\n`, so a literal `\r` can never appear naturally and is a free in-band signal. `br()` emits `\r` when reflow is on, plain `\n` otherwise (`index.js:291-293`). `fixHardReturn` converts it back at render time (`index.js:76-78`).

### Tables: serialize-then-reparse through a delimiter protocol
marked calls `tablecell`/`tablerow` incrementally, but `cli-table3` needs a 2-D array. The trick (`index.js:253-265`): each cell is suffixed with a magic delimiter `^*||*^` (`TABLE_CELL_SPLIT`) and each row wrapped in `*|*|*|*` (`TABLE_ROW_WRAP`). In `table()` the accumulated string is fed to `generateTableRow` (`index.js:621-636`) which strips the wrap markers and splits on the cell delimiter to recover the grid, then pushes rows into a `cli-table3` instance for box rendering (`index.js:237-250`). Delimiters are chosen to be improbable in real text and are escaped for regex use (`escapeRegExp`, `index.js:638`).

### Colon escaping to protect emoji syntax
Inline code can contain `:` which would be mis-detected as emoji shorthand (`:smile:`). `codespan` replaces `:` with sentinel `*#COLON|*` (`index.js:288`), emoji substitution runs, then `undoColon` restores real colons (`index.js:617-619`). The restore is wired into the `transform` pipeline.

### Composed text-transform pipeline
`this.transform = compose(undoColon, this.unescape, this.emoji)` (`index.js:65`). `compose` (`index.js:655-664`) applies right-to-left. So order is: insert emoji -> unescape HTML entities -> undo colon sentinels. Per-method styling composes the chalk style on top, e.g. `compose(this.o.listitem, this.transform)` (`index.js:186`).

### Capability-gated hyperlinks (OSC 8)
`link()` checks `supportsHyperlinks.stdout` (`index.js:326`). If supported, emits a real terminal hyperlink via `ansiEscapes.link(label, href)`; otherwise falls back to `text (href)` plain rendering (`index.js:339-343`). URL `+` is replaced with `%20` because the width/escape logic breaks on `+` (`index.js:336-337`).

### Syntax highlighting with graceful degradation
`highlight()` short-circuits to raw code when `chalk.level === 0` (no color support) (`index.js:591`), tries `cli-highlight`, and falls back to the plain `code` chalk style if highlighting throws (unknown language, etc.) (`index.js:597-601`).

### List rendering: bullet/number reconstruction after indent
Lists are rendered with a placeholder bullet `* ` (`BULLET_POINT`, `index.js:540`), then post-processed. `bulletPointLines` keeps pointed lines and space-pads continuation lines to align (`index.js:541-548`); `numberedLines` rewrites `* ` into incrementing `N. ` while threading the counter through a map (`index.js:550-578`). `fixNestedLists` (`index.js:516-530`) uses a regex to force a newline before a sub-point that got glued onto its parent's last line — a subtle layout bug fix.

## Code patterns worth stealing

ANSI-aware length (the load-bearing primitive):
```js
const ANSI_REGEXP = ansiRegex();
function textLength(str) { return str.replace(ANSI_REGEXP, '').length; }
```

In-band sentinel for a signal that can't occur naturally (hard break):
```js
// marked's lexer normalizes \r -> \n, so \r is a free signal channel
var HARD_RETURN = '\r';
Renderer.prototype.br = function () {
  return this.o.reflowText ? HARD_RETURN : '\n';
};
```

Reflow loop guarding against splitting escape codes:
```js
var fragments = section.split(/(\[(?:\d{1,3})(?:;\d{1,3})*m)/g);
// ...
if (!textLength(fragment)) {        // pure escape code
  currentLine += fragment;          // keep whole, never wrap
  lastWasEscapeChar = true;         // and suppress the next leading space
  continue;
}
```

Serialize-with-delimiters then reparse to bridge a streaming API to a 2-D consumer:
```js
tablecell = c => c + TABLE_CELL_SPLIT;          // '^*||*^'
tablerow  = c => TABLE_ROW_WRAP + c + TABLE_ROW_WRAP + '\n';
// later: strip wrap, split on cell delimiter -> rows[], feed cli-table3
```

Version-agnostic renderer over a shifting upstream API (string OR token object):
```js
Renderer.prototype.heading = function (text, level) {
  if (typeof text === 'object') {            // new marked: token
    level = text.depth;
    text = this.parser.parseInline(text.tokens);
  }
  // ...same code path for both eras
};
```

Extension factory that rebinds parser/options per call:
```js
return funcs.reduce((ext, fn) => {
  ext.renderer[fn] = function (...args) {
    r.options = this.options; r.parser = this.parser;  // marked's `this`
    return r[fn](...args);
  };
  return ext;
}, { renderer: {}, useNewRenderer: true });
```

## Gotchas / non-obvious decisions
- **No real display-width handling**: `textLength` counts JS string length minus ANSI, so wide chars (CJK), zero-width joiners, and emoji clusters miscount columns. Reflow/table widths can therefore be wrong for non-ASCII. Contrast with libraries that use `string-width`/`east-asian-width`.
- **Sentinel collisions**: the table (`^*||*^`, `*|*|*|*`) and colon (`*#COLON|*`) sentinels are "improbable" but not impossible in source text; this is a pragmatic, not airtight, choice.
- **`fixHardReturn` bug-ish call**: `text.replace(HARD_RETURN, /\n/g)` (`index.js:77`) passes a regex as the *replacement* string, which stringifies oddly — only meaningful because callers mostly pass reflow=false. A reminder that these in-band hacks are fragile.
- **Color gating cascades**: behavior changes silently based on `chalk.level` and `supportsHyperlinks.stdout` — output is environment-dependent, which complicates testing (tests force `FORCE_HYPERLINK=0`, `package.json:21`).
- **`hr` width fallback** uses `process.stdout.columns` directly (`index.js:613`) unless reflow width is set — couples rendering to live TTY state.
- **`new Array(n).join(x)` idiom** is used for repetition (tabs, hr, heading `#`s) — produces `n-1` copies, an easy off-by-one to misread.
- **Right-to-left compose**: `compose(a, b, c)` runs `a(b(c(x)))`; transform ordering is the reverse of the argument list.

## Relevance (which advanced-TUI topics this teaches)
- **rendering-pipeline** — token -> styled-string pipeline, transform composition, graceful degradation by capability.
- **layout** — word-wrap/reflow to a width column, list indentation and continuation-line alignment, nested-list fixups.
- **ansi-escapes** — SGR color codes, OSC-8 hyperlinks via `ansi-escapes`, capability detection, splitting/preserving escape runs during wrapping.
- **unicode-text-width** — the *cautionary* case: visible-length math that strips ANSI but does NOT handle wide chars (shows why a proper width function matters).
- **widgets-rich-content** — tables (box drawing via cli-table3), syntax-highlighted code blocks, blockquotes, emoji, checkboxes.
