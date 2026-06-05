# ansi-escapes

A study note on ANSI/escape-sequence engineering for terminal UIs: how the sequences are structured (SGR / CSI / OSC / DCS / APC), how to *generate* them, how to *parse* them, the truecolor→256→16→BW color ladder, and capability/level detection. Grounded in five real codebases that sit at different points on the generate-vs-parse spectrum.

Repos compared (paths under `context/`):
- `ansi-escapes/` — pure **generator** (string catalog of sequences).
- `ansis/` — **generator** with color downgrade + level detection + nesting.
- `anser/` — non-streaming **SGR parser** (regex, split-on-CSI) → HTML/JSON/text.
- `ansi-up/` — streaming **SGR + OSC-8 parser** (hand-written packetizer) → HTML.
- `xterm/` — full **VT500 emulator** (table-driven state machine, all sequence classes).

---

## TL;DR (the mental model in 3-5 bullets)

- **An escape sequence is a tiny binary grammar, not a magic string.** Every sequence starts with an *introducer* (CSI `ESC [`, OSC `ESC ]`, DCS `ESC P`, APC `ESC _`), carries *parameters* (digits + `;`), maybe *intermediate* bytes, and ends with a *final byte* whose value selects the command. SGR is just CSI with final byte `m`. Generating is "concatenate the right bytes"; parsing is "classify bytes by ECMA-48 ranges and dispatch on the final byte."
- **SGR is a stateful accumulator, not per-token formatting.** Color/style codes mutate a persistent "graphic rendition" state in the terminal; each run of text inherits whatever was last set until a reset. Both parsers (`anser`, `ansi-up`) and the generator with nesting (`ansis`) model this as a state object you snapshot onto each text run.
- **There are exactly three color tiers and a fixed downgrade math between them.** Truecolor `38;2;r;g;b` → 256-palette `38;5;n` → 16 named (`30-37`/`90-97`). The 256 palette is *not* linear: 0-15 named, 16-231 a 6×6×6 cube on levels `[0,95,135,175,215,255]`, 232-255 a 24-step gray ramp from 8 step 10. Everyone implements the same tables.
- **Closes must be attribute-specific, never blanket `[0m`.** Bold closes with `22`, foreground with `39`, background with `49`. This is what lets styles nest without one inner reset wiping the outer style.
- **The hard parts are all at the boundaries:** sequences split across stream chunks (streaming parsers), terminal/multiplexer quirks (tmux DCS-wrapping, Apple Terminal save/restore), and detecting how much color the terminal actually supports. Generation is easy; *robust* generation and *streaming* parsing are not.

---

## How it actually works (the mechanism, step by step)

### 1. The byte grammar (ECMA-48)

The introducers are the literal ESC byte `` (0x1B) plus one selector byte. In `ansi-escapes/base.js:5-7`:

```js
const ESC = '[';   // CSI — Control Sequence Introducer
const OSC = ']';   // Operating System Command (string-type, open-ended)
const BEL = '';    // BEL — one valid OSC terminator (the other is ST = ESC \)
```

A **CSI** sequence is `ESC [ <params> <intermediates> <final>`:
- params = bytes `0x30-0x3F` (digits, `;`, `:`, and private-marker bytes `<=>?`),
- intermediates = `0x20-0x2F` (space, `!`, `#`, …),
- final byte = `0x40-0x7E` and *selects the command* (`m`=SGR, `H`=CUP, `J`=erase-display, `K`=erase-line, `A/B/C/D`=cursor up/down/fwd/back, `n`=device-status).

`anser` encodes this grammar in literally one regex (`anser/lib/index.js:346`):

```js
let matches = text.match(/^([!\x3c-\x3f]*)([\d;]*)([\x20-\x2c]*[\x40-\x7e])([\s\S]*)/m);
//  g1: private/prefix bytes (! and 0x3c-0x3f = <=>?)
//  g2: numeric ;-separated parameters    "1;31"
//  g3: intermediates (0x20-0x2c) + final byte (0x40-0x7e)
//  g4: the text payload the command styles
```

The guard `if (matches[1] !== "" || matches[3] !== "m") return result;` (`anser/lib/index.js:355`) means **only SGR is interpreted**; every other CSI (cursor moves, erase) is dropped while its trailing text still flows through. That is the whole reason a log colorizer can ignore cursor control without corrupting text.

**OSC** is different: it is *string-type* and open-ended — `ESC ] <command> ; <payload> <terminator>` where the terminator is BEL (``) or ST (`ESC \`). You cannot regex it with a fixed length because the payload is arbitrary (URLs, file names, base64 images). DCS (`ESC P`) and APC (`ESC _`) are also string-type, used for sixel/passthrough and kitty graphics respectively.

### 2. Generating — the `ansi-escapes` catalog

`ansi-escapes` is the canonical "emit, never parse" reference. Two key normalizations:

**0-based public API over 1-based VT coordinates, with row/col inversion hidden** (`ansi-escapes/base.js:29-38`):

```js
export const cursorTo = (x, y) => {
	if (typeof y !== 'number') return ESC + (x + 1) + 'G';   // CHA — column only
	return ESC + (y + 1) + SEP + (x + 1) + 'H';              // CUP — note y;x order, both +1
};
```

CUP (`H`) is `row;col`, *y first*, and 1-based — so the API `+1`s and swaps. A no-`y` call degrades to CHA (`G`), column-only. This is a footgun the lib hides once at the boundary.

**Sign-decomposed relative motion** emits only nonzero axes (no `ESC 0 A` no-ops) — `ansi-escapes/base.js:41-58` splits `cursorMove(x,y)` into CUU/CUD/CUF/CUB by sign.

**`eraseLines` — the redraw-in-place idiom** (`base.js:77-89`), the core trick behind spinners/progress/live status:

```js
export const eraseLines = count => {
	let clear = '';
	for (let i = 0; i < count; i++)
		clear += eraseLine + (i < count - 1 ? cursorUp() : '');  // erase, step up, but NOT past the last line
	if (count) clear += cursorLeft;   // ESC G → column 0
	return clear;
};
```

Note the deliberate off-by-one: it skips the final `cursorUp` so the cursor lands on the topmost erased line, ready to rewrite. This is exactly what `log-update` / Ink do per frame.

**Full-screen primitives** (`base.js:132-137`):
- Alternate screen `ESC ?1049h` / `?1049l` (the private mode vim/less/htop use — clean buffer + scrollback restore).
- **Synchronized output** `ESC ?2026h … ?2026l` brackets a frame so the terminal renders it atomically — the modern anti-flicker primitive. Build the whole next frame, wrap once, write once.

**OSC features**, all routed through `wrapOsc` (`base.js:18`): hyperlinks (`OSC 8 ;; url BEL text OSC 8 ;; BEL`, `base.js:141-145`) and iTerm2 inline images (`OSC 1337;File=inline=1;…;size=<bytes>:<base64>BEL`, `base.js:147-165`). The `size=` field is spec-optional but **mandatory for xterm.js** — a documented spec-vs-reality fixup at `base.js:165`.

### 3. Parsing the stateful SGR stream

Both `anser` and `ansi-up` keep a persistent style state and walk parameters with `shift()` (not `forEach`) because **some SGR codes consume following params**. `anser/lib/index.js:427-454`:

```js
} else if (num === 38 || num === 48) {     // extended color, 38=fg 48=bg
	let mode = nums.shift();
	if (mode === 5) { /* 256-palette */ palette_index = nums.shift(); }
	else if (mode === 2) { r = nums.shift(); g = nums.shift(); b = nums.shift(); } // truecolor
}
```

Reset semantics are encoded inline and are *not* intuitive: `0`/NaN → full reset; `39`/`49` → reset fg/bg color only; `22` → clear **both** bold and faint; `21` → clear bold only. These messy couplings come straight from the real SGR spec; `ansi-up` documents them at the param loop.

**256-color palette construction** is identical in both (`anser/lib/index.js:141` `setupPalette`, built lazily on first need at `:436`):
- 0-15: the 16 named system colors.
- 16-231: 6×6×6 cube on the non-linear ramp `[0,95,135,175,215,255]` (note the 0→95 jump — this is the real xterm table, *not* `i*51`).
- 232-255: 24-step grayscale from 8, step 10.

### 4. Streaming vs non-streaming parsing — the central divide

`anser` is **not streaming**: `process()` does `txt.split(/\033\[/)` (`anser/lib/index.js:262`), which requires the whole buffer. A CSI split across two `write()` calls breaks. Great for finished log buffers, wrong for a live PTY.

`ansi-up` is a hand-written **packetizing state machine** that buffers partial sequences. Its cleverest trick: JS regex has no "is-this-a-prefix" mode, so the CSI regex matches *either a complete legal sequence OR a CSI-then-illegal-control-char* (a capture group). Three outcomes:
- `null` ⇒ neither legal-complete nor illegal ⇒ must be an incomplete prefix ⇒ `break` and wait for more bytes;
- match with the illegal group set ⇒ garbage ⇒ drop the ESC and resync;
- match without it ⇒ valid ⇒ consume.

This converts "do we have enough bytes yet?" into one deterministic regex match. OSC-8 (open-ended) is handled separately with a global stateful regex run twice to find two consecutive String Terminators before parsing URL+text, with a scheme allowlist (`{http,https}`) to block `javascript:`/`data:` injection.

### 5. The industrial parser — xterm's VT500 table machine

`xterm/src/common/parser/EscapeSequenceParser.ts` is the reference implementation. It builds a flat `Uint16Array` transition table once (`VT500_TRANSITION_TABLE`, `:97`). Index = `state << 8 | charCode`, value = `action << 8 | nextState`, both packed in one slot (`TableAccess` enum, `:38`; build at `:71`):

```js
this.table[state << INDEX_STATE_SHIFT | code] = action << TRANSITION_ACTION_SHIFT | next;
```

The introducers are first-class states: `0x9b`→CSI_ENTRY, `0x9d`→OSC_STRING, `0x90`→DCS_ENTRY, `0x9f`→APC_ENTRY (`:126-130`). The parse loop (`public parse`, `:574`) is just: lookup transition, `switch(transition >> ACTION_SHIFT)` (`:753`), set `currentState = transition & state-mask`. States/actions are `const enum`s so they inline to integers. Non-ASCII printables fold to one pseudo-byte `NON_ASCII_PRINTABLE = 0xA0` (`:90`) to keep each state's row 256 wide.

Two features no string library has:
- **Hot-path read-ahead loops** that bypass the table for PRINT/PARAM/OSC_PUT to avoid a lookup per byte (the case at `:754`).
- **Resumable async handlers**: a handler can return a `Promise` (e.g. slow image decode). The parser `_preserveStack(...)`s (handlers list, index, transition, position — `:515`, `:725`, `:803`, `:872`) and returns the promise; the write buffer re-invokes `parse(data, len, promiseResult)` on resolve, replaying from the saved handler index. This blocks the byte stream in-band without freezing the UI — impossible with a pure-regex approach.

---

## Cross-repo comparison

| Concern | ansi-escapes | ansis | anser | ansi-up | xterm |
|---|---|---|---|---|---|
| Direction | Generate only | Generate only | Parse (SGR) | Parse (SGR + OSC-8) | Parse (everything) |
| Sequence classes | CSI + OSC + DCS-wrap | CSI(SGR) + OSC-8 | CSI(SGR) only | CSI(SGR) + OSC-8 | CSI/OSC/DCS/APC/SOS/PM |
| Parser model | n/a | n/a | `split(/\033\[/)` + regex | hand-written packetizer | table-driven VT500 FSM |
| Streaming-safe | n/a | n/a | **No** | **Yes** (Incomplete buffering) | **Yes** (+ async resume) |
| Color tiers | n/a (you pass codes) | truecolor/256/16/BW + downgrade | 16/256/truecolor | 16/256/truecolor | full, bit-packed attrs |
| Level detection | n/a | **Yes** (`color-support.js`) | no | no | host app's job |
| Nesting/restoration | no | **Yes** (re-open after child close) | n/a | n/a | n/a (grid model) |
| Output sink | terminal string | terminal string | HTML / JSON / text | HTML | screen buffer + renderers |

Where they **agree** (the durable consensus):
- Same 256 palette tables (`[0,95,135,175,215,255]` cube + 8/step-10 gray ramp). `anser`, `ansi-up`, `ansis`, xterm all build it identically.
- Same extended-color grammar `38/48 ; {5;n | 2;r;g;b}`, consumed with `shift()` lookahead.
- Same insight that SGR is a persistent state accumulator and only the SGR final byte `m` matters for styling.

Where they **differ** (and which is better):
- **Tokenization.** `anser`'s split-on-CSI is the simplest but cannot stream and allocates the whole string. `ansi-up`'s packetizer streams correctly. xterm's table machine is the only one that handles all sequence types and survives any chunk boundary. For a log colorizer → `anser`; for a PTY → minimum `ansi-up`, ideally an xterm-style FSM.
- **Closes.** `ansis` uses attribute-specific resets (`22/23/24/39/49`, `ansis/src/index.js`) so nesting peels one layer at a time; a naive generator that closes everything with `[0m` corrupts nested styles. `ansis` is the correct model.
- **Downgrade.** Only `ansis` does compile-time color-level downgrade by composing functions at construction so the hot path is branch-free (`createRgbFallbackFn`). The parsers don't downgrade — they emit RGB to HTML where the browser handles it.

---

## Pitfalls & hard parts

- **CUP is `row;col` (y first), 1-based.** `cursorTo(x,y)` must swap and `+1` (`ansi-escapes/base.js:38`). Easy to ship a transposed-coordinate bug.
- **`eraseLines` off-by-one.** Must skip the final `cursorUp` (`base.js:84`) or the cursor lands one line too high and you overwrite good output.
- **Never close with `[0m` if you nest.** Use `39`/`49`/`22`/`23`/`24`. A blanket reset inside `red(green(x) + y)` kills the red for `y`. `ansis` solves this by walking ancestors and replacing each inner *close* with the inner *open* (re-open after child closes), guarded by `if (output.includes('\x1b'))` to skip plain strings.
- **Background bleed across newlines.** A styled run with a `\n` lets the bg color paint to end-of-line on every wrapped line. `ansis` rewraps: `output.replace(/(\r?\n)/g, closeStack + '$1' + openStack)`.
- **Streaming: sequences split across chunks.** A pure regex/split parser (`anser`) silently breaks. You need an Incomplete state that buffers the tail (`ansi-up`) or a resumable FSM (xterm). JS regex has no partial-match — use the legal-OR-illegal-alternative trick.
- **OSC is open-ended.** Don't try a fixed regex; scan for BEL or `ESC \`. Buffer until the terminator arrives (an unclosed OSC-8 stays Incomplete forever — cap URL length).
- **OSC injection.** OSC-8 hyperlinks can carry `javascript:`/`data:` URLs into an HTML renderer; allowlist schemes (`ansi-up`).
- **Multiplexer & terminal quirks:**
  - tmux requires OSC payloads wrapped in a DCS passthrough `ESC P tmux; <seq> ESC \` with **every inner ESC doubled** and only `ESC \` as terminator (`wrapOsc`, `ansi-escapes/base.js:18-27`). Get it wrong and the sequence leaks as visible text.
  - Apple Terminal uses DEC `ESC 7`/`ESC 8` save/restore, not `ESC s`/`ESC u` (`base.js:69-70`).
  - Pre-Win10 has no VT processing for `ESC 3J`; fall back (`base.js:104-130`).
- **Destructive clears.** `clearScreen` (RIS `ESC c`) and `clearTerminal` wipe scrollback and reset modes inconsistently across terminals; prefer `clearViewport = eraseScreen + ESC H` (`base.js:102`).
- **Generators don't parse responses.** `cursorGetPosition` (`ESC 6n`, `base.js:71`) *sends* a query; reading the terminal's reply on stdin is the caller's job.
- **SGR reset asymmetry.** `22` clears bold *and* faint; `21` only bold; `39/49` only color. Hard-coding "reset = clear all" is wrong.

---

## If you were building this from scratch

Build **two separable layers**: a generator and a parser. Don't entangle them.

**Generator** (model after `ansi-escapes` + `ansis`):
```
ESC = ''
CSI = ESC + '['
csi(params, final) = CSI + params.join(';') + final
sgr(...codes)      = csi([...codes], 'm')

cursorTo(x, y)     = y==null ? csi([x+1],'G') : csi([y+1, x+1], 'H')   // 0-based in, 1-based out, y;x
fg(level, r,g,b):
  truecolor -> sgr(38,2,r,g,b)
  256       -> sgr(38,5, rgbToAnsi256(r,g,b))     // cube: 16+36*round(r/51)+6*round(g/51)+round(b/51)
  16        -> sgr(ansi256To16(rgbToAnsi256(...)))
  bw        -> ''                                  // no-op style
close(attr) = sgr(SPECIFIC_RESET[attr])            // 22/23/24/39/49 — NEVER 0
frame(s)    = '[?2026h' + s + '[?2026l'  // synchronized output, one write
```
Compose the level→formatter choice at construction time so the per-call path has no branching (ansis trick). Route every OSC through one `wrapOsc` choke point for tmux/Apple quirks.

**Parser** — a streaming, table-ish FSM (model after xterm, simplified):
```
state = GROUND; params = []; sgr_state = {fg, bg, flags}; buf = ''

feed(chunk):
  buf += chunk
  while i < buf.length:
    c = buf[i]
    switch state:
      GROUND:    if c==ESC -> state=ESCAPE; else emit_run(c, snapshot(sgr_state))
      ESCAPE:    if c=='[' -> state=CSI; elif c==']' -> state=OSC; else dispatch_esc(c)->GROUND
      CSI:       collect params/intermediates; on final byte 0x40..0x7e:
                    if final=='m' apply_sgr(params, sgr_state)   // 0,1,4,22,38;2.., 38;5.., 39 ...
                    else dispatch_csi(final, params)             // cursor/erase
                    state=GROUND
      OSC:       if c==BEL or (c=='\\' and prev==ESC): dispatch_osc(); state=GROUND
                 else accumulate
    i++
  // KEY: if we fall off the end mid-sequence, keep `state` + partial in `buf` for next feed()
```
Walk SGR params with `shift()` so `38/48` can consume their `2;r;g;b` / `5;n` operands. Snapshot `sgr_state` onto each emitted text run (decouples "state change" from "text emit"). For a real emulator, replace the `switch` with the packed `Uint16Array` transition table and add async handler resumption.

**Capability detection** (model after `ansis/src/color-support.js`): priority order — `COLORTERM` (truecolor/256) → CI (GitHub=truecolor, else 16) → not-a-TTY or `TERM=dumb` → BW → `TERM` matches `-256` → 256 → default 16. Then apply overrides: auto < `NO_COLOR` < `--color`/`--no-color` < `FORCE_COLOR`.

---

## Source map (which files to read for more)

**Generation:**
- `ansi-escapes/base.js` — entire sequence catalog. Read `:5-27` (introducers + tmux/Apple shims), `:29-58` (cursor), `:77-102` (erase/clear), `:132-165` (alt screen, sync output, OSC links/images).
- `ansi-escapes/base.d.ts:202-224` — the destructive-clear warnings (RIS vs clearViewport).
- `ansis/src/index.js` — open/close stack chaining, nested-style restoration, multiline rewrap, attribute-specific closes, OSC-8 link.
- `ansis/src/color-math.js:17-34` (hexToRgb), `:45-62` (rgbToAnsi256 cube+gray), `:70+` (ansi256To16) — the downgrade math.
- `ansis/src/color-support.js:23` (autoDetectLevel priority), `:118` (getLevel overrides) — level detection.
- `ansis/src/color-levels.js` — the level enum.

**Parsing (non-streaming, SGR→HTML/JSON):**
- `anser/lib/index.js:262` (split-on-CSI), `:346` (the grammar regex), `:355` (SGR-only guard), `:365-479` (param interpreter), `:141` (256 palette), `:427-454` (38/48 extended color).
- `anser/lib/index.d.ts:7` — `AnserJsonEntry`, the styled-run token shape for vdom renderers.

**Parsing (streaming, SGR + OSC-8):**
- `ansi-up/ansi_up.ts` — `get_next_packet` (lexer, the Incomplete protocol), the legal-or-illegal CSI regex, OSC-8 double-ST scan + scheme allowlist, `setup_palettes`, `transform_to_html` (inline-vs-class).

**Parsing (full VT emulator):**
- `xterm/src/common/parser/EscapeSequenceParser.ts:38` (TableAccess packing), `:97` (VT500_TRANSITION_TABLE build), `:126-130` (introducer states), `:515` (`_preserveStack`), `:574` (`parse`), `:753` (action dispatch), `:754` (PRINT hot path).
- `xterm/src/common/parser/{OscParser,DcsParser,ApcParser,Params}.ts` — the string-type sub-parsers and packed param storage.
- `xterm/src/common/buffer/AttributeData.ts` — bit-packed fg/bg/flags (truecolor + styled underline) cell model.
