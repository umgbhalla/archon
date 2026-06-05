# anser

## What it is (1-2 lines)
A small (~635 LOC, single-file) ANSI SGR (Select Graphic Rendition) parser that converts terminal escape-coded text into HTML spans, a structured JSON token stream, or plain text. Descends from drudru's `ansi_up`; the JSON output is the interesting part for vdom/React-style rendering because it yields styled text chunks rather than HTML strings.

## Architecture (how the pieces fit; key files with paths)
- `lib/index.js` — the entire implementation. A single `Anser` class with static convenience methods (`ansiToHtml`, `ansiToJson`, `ansiToText`, `escapeForHtml`, `linkify`) that each `new Anser()` and delegate to instance methods.
- `lib/index.d.ts` — the public data model. The key type is `AnserJsonEntry` (`lib/index.d.ts:7`): `{ content, fg, bg, fg_truecolor, bg_truecolor, clearLine, decoration, decorations[], was_processed, isEmpty() }`. This is the contract a renderer consumes.
- `DOCUMENTATION.md`, `README.md` — docs only. `test/ansi_up-test.js` — behavioral spec. `example/index.js` — usage demo.

Pipeline shape (all in `lib/index.js`):
`process()` → split input on CSI → `processChunk()` per chunk → `processChunkJson()` (the actual parser) → emit JSON token OR serialize to a `<span>`.

The crucial design choice: **the parser is stateful across chunks**. `fg`, `bg`, `fg_truecolor`, `bg_truecolor`, `bright`, and `decorations[]` live on the instance (`constructor`, `lib/index.js:128`) and persist between chunks, exactly like a real terminal's "current graphic state." Each chunk inherits the style left by previous SGR codes until reset.

## Core techniques (the actual engineering)

### 1. Split-on-CSI tokenization (`process`, lib/index.js:260)
```js
let raw_text_chunks = txt.split(/\033\[/);      // split on ESC + "["
let first_chunk = raw_text_chunks.shift();      // text before the first escape
```
Instead of a char-by-char state machine, it splits the whole string on the CSI introducer `\033[` (ESC `[`). Every element after the split is "an SGR command immediately followed by its text." The first element is bare text with no preceding code and is handled specially (no style applied). This is a pragmatic, allocation-heavy but very short approach — fine for log/output coloring, not for a streaming PTY.

### 2. The chunk-parsing regex (`processChunkJson`, lib/index.js:346)
```js
let matches = text.match(/^([!\x3c-\x3f]*)([\d;]*)([\x20-\x2c]*[\x40-\x7e])([\s\S]*)/m);
//  group1: private/CSI prefix bytes (! and 0x3c-0x3f, e.g. ?)
//  group2: the numeric ;-separated parameters  ("1;31")
//  group3: intermediate bytes + the final byte (0x40-0x7e); "m" = SGR
//  group4: the text payload that the command styles
```
This single regex decomposes a CSI sequence per the ECMA-48 grammar: optional private markers, parameter bytes, intermediate+final byte, then the payload. The guard `if (matches[1] !== "" || matches[3] !== "m") return result;` (lib/index.js:355) means **only SGR (`...m`) sequences are interpreted**; cursor moves, erase, etc. are silently dropped and their *text* still passes through. That's how non-color escapes are "hidden from output" without breaking text flow.

### 3. SGR parameter interpreter (lib/index.js:365-479)
A `while (nums.length)` loop shifting one parameter at a time, with a big if/else mapping SGR codes to state mutations:
- `0`/NaN → reset fg, bg, decorations.
- `1,2,3,4,5,7,8,9` → push `bold/dim/italic/underline/blink/reverse/hidden/strikethrough` into `decorations[]`.
- `21..29` → `removeDecoration(...)` (the "turn off" codes; lib/index.js:625 splices from the array).
- `30-37`/`90-97` (fg), `40-47`/`100-107` (bg) → index `ANSI_COLORS[bright][num%10]`.
- `39`/`49` → reset fg/bg only.
- `38`/`48` → **extended color**; consume sub-parameters from the same `nums` stream:
  - `5;<n>` → 256-color palette index (lib/index.js:431)
  - `2;<r>;<g>;<b>` → 24-bit truecolor (lib/index.js:454)

The `38/48` branch is the clever part: it keeps `shift()`-ing the *same* parameter list to read the mode and its operands, so a single chunk like `38;2;255;0;0` is parsed in one pass.

### 4. 256-color palette generation (`setupPalette`, lib/index.js:141)
Built lazily on first truecolor/palette need (`if (!this.PALETTE_COLORS) self.setupPalette()`, lib/index.js:435). Three regions per xterm spec:
- 0..15: the 16 system colors (from `ANSI_COLORS`).
- 16..231: a 6×6×6 RGB cube using the non-linear ramp `[0,95,135,175,215,255]` (lib/index.js:153) — note the gap from 0→95, this is the actual xterm level table, not `i*51`.
- 232..255: 24-step grayscale starting at 8, step 10 (lib/index.js:165).

### 5. `reverse`/inverse video handling (`processChunk`, lib/index.js:521)
Reverse video is resolved at serialization time, not parse time. The decorations array is `.filter()`-ed; when `reverse` is found it swaps fg/bg (and the truecolor pair), defaults missing colors to white-fg/black-bg, sets `isInverted=true`, and removes `reverse` from the list (returns `false` from the filter). Doing the swap downstream keeps the parser's stored state canonical.

### 6. Two serialization backends from one token (lib/index.js:543-622)
After producing the JSON token, `processChunk` branches:
- `options.json` → return the token object as-is (the vdom path).
- else → build a `<span>`: either inline `style="color:rgb(...);..."` or `class="ansi-red-fg ansi-bold ..."` when `use_classes`. Truecolor in class mode is emitted as a `data-ansi-truecolor-fg="r,g,b"` attribute (lib/index.js:571) since there's no class for arbitrary RGB.

### 7. HTML safety & linkify (lib/index.js:180, 198)
`escapeForHtml` does minimal `& < > "` escaping and is meant to run **before** `ansiToHtml`. `linkify` runs **after**, wrapping URLs (regex at lib/index.js:28, RFC-3986 derived, with `&amp;` already-escaped handling) in `<a>`. Order matters — escaping first, then ANSI->span, then linkify.

## Code patterns worth stealing

**Stateful style accumulator that survives between tokens (terminal "graphic state"):**
```js
constructor() { this.fg = this.bg = this.fg_truecolor = this.bg_truecolor = null;
                this.bright = 0; this.decorations = []; }
// code 0 / NaN  => full reset;  39/49 => color-only reset; 22 => clear bold+dim
```
This is the right mental model for any terminal renderer: parse mutates a persistent attribute set; each emitted run carries a *snapshot* of it.

**Consume variadic SGR operands inline:**
```js
if (num === 38 || num === 48) {
  let mode = nums.shift();
  if (mode === "5") palette = parseInt(nums.shift());            // 256
  else if (mode === "2") { r=+nums.shift(); g=+nums.shift(); b=+nums.shift(); } // truecolor
}
```

**One parse, multiple sinks:** produce a neutral JSON token, then have thin serializers (HTML-inline / HTML-class / JSON / text). Lets the same engine feed a React component tree or a string.

**Token shape for a vdom renderer** (`AnserJsonEntry`): each entry is `{content, fg, bg, decorations[], ...}` — map directly to `<span style={...}>{content}</span>` or a `<Text>` widget. `decoration` is a convenience holding the last-declared decoration; `decorations[]` is the full set.

## Gotchas / non-obvious decisions
- **Not a streaming parser.** `split(/\033\[/)` requires the whole string. A CSI split across two `write()` calls would break — wrong tool for live PTY byte streams; right tool for finished log buffers.
- **Only SGR is interpreted.** Cursor/erase/scroll CSI sequences are dropped (their final byte != `m`), but the trailing text is preserved. No cursor-addressed grid model at all — this is inline text styling, not a screen buffer.
- **`clearLine` is a heuristic.** `options.clearLine = /\r/.test(txt)` (lib/index.js:268) flags presence of a carriage return for the whole input; it does NOT implement CR overwrite semantics (a real terminal would erase to line start). Consumers must act on the flag themselves.
- **`ansiToJson` forces `clearLine=false` then recomputes** and unshifts a synthetic first token for the pre-escape text (lib/index.js:272). The first chunk never carries style.
- **`remove_empty` only applies in JSON mode** (lib/index.js:276), filtering tokens whose `content` is empty via `isEmpty()`.
- **Truecolor + classes is awkward:** there's no CSS class for an arbitrary RGB, so it uses class `ansi-truecolor` plus a `data-` attribute; the styling must be applied by the consumer's CSS/JS reading that attribute.
- **Reverse defaults are hardcoded** to white fg / black bg when a color is absent (lib/index.js:526) — assumes a dark terminal background, matching the upstream "standard assumes black background" note.
- **Mutating the options object:** `ansiToJson` writes `options.json`/`options.clearLine` onto the caller's object. Minor, but a shared options object would leak state.

## Relevance (which advanced-TUI topics this teaches)
- **ansi-escapes** — the central lesson: how to parse CSI/SGR sequences, the ECMA-48 byte-range grammar (params 0x30-0x3f, intermediates 0x20-0x2f, finals 0x40-0x7e), 16/256/truecolor color models, and the xterm 6x6x6 + grayscale palette tables.
- **rendering-pipeline** — clean example of "parse to a neutral token stream, then fan out to multiple serializers (HTML/JSON/text)"; the stateful style accumulator pattern that every terminal renderer needs.
- **reconciler-component-models / widgets-rich-content** — `AnserJsonEntry[]` is exactly the styled-run representation you'd feed into a React/vdom `<Text>` component tree to render colored log output without `dangerouslySetInnerHTML`.
