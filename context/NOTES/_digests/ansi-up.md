# ansi-up

## What it is (1-2 lines)
A dependency-free TypeScript library (single file `ansi_up.ts`, ~780 lines) that converts a stream of terminal output containing ANSI SGR escape codes into HTML. It is *streaming* and *stateful*: you can feed it arbitrary chunks via `ansi_to_html()` and it buffers partial escape sequences across calls, carrying SGR color/style state forward.

## Architecture (how the pieces fit; key files with paths)
Everything lives in `/Users/umang/hub/zonko/archon/context/ansi-up/ansi_up.ts`. The `.js`/`.d.ts` are compiled artifacts.

The design is a hand-written **packetizing state machine** wrapped around a small object. Pipeline:

1. `ansi_to_html(txt)` (ansi_up.ts:563) — public entry. Appends `txt` to an internal `_buffer`, then loops pulling packets.
2. `get_next_packet()` (ansi_up.ts:231) — the lexer. Slices one `TextPacket` off the front of `_buffer`, mutating `_buffer`.
3. `process_ansi(pkt)` (ansi_up.ts:599) — the SGR interpreter. Mutates the instance's style state (`fg`, `bg`, `bold`, ...). Produces no output.
4. `with_state(pkt)` (ansi_up.ts:595) — snapshots current style state onto a `TextWithAttr` for a text packet.
5. `transform_to_html(fragment)` (ansi_up.ts:682) — renders one styled text fragment to a `<span>`.
6. `process_hyperlink(pkt)` (ansi_up.ts:742) — renders OSC-8 hyperlinks to `<a>`.

Key data structures:
- `PacketKind` enum (ansi_up.ts:34): `EOS, Text, Incomplete, ESC, Unknown, SGR, OSCURL`. This enum *is* the protocol between lexer and the main loop.
- `TextPacket { kind, text, url }` — the token.
- `TextWithAttr` — a text fragment plus a full snapshot of style state. Comment at ansi_up.ts:19 notes this design "would allow deferred processing... if ever needed."
- `AU_Color { rgb:number[], class_name:string }` — a color carries both its RGB triple and a CSS class name, so the renderer can emit either inline styles or classes.
- Instance fields `fg, bg, bold, faint, italic, underline` — the persistent SGR state machine.
- `_buffer:string` — the streaming accumulator.

## Core techniques (the actual TUI engineering)

### Streaming with incomplete-sequence buffering (the central trick)
`ansi_to_html` never assumes it received a complete input. `get_next_packet()` can return `PacketKind.Incomplete`, and the main loop (ansi_up.ts:573) `break`s on it, leaving the partial bytes in `_buffer`. The next call to `ansi_to_html` prepends new text and retries. This is how it handles an ESC sequence split across network/pty chunks. Concrete guards:
- `if (len < 3)` → Incomplete (ansi_up.ts:268): every handled sequence needs ≥3 chars, so don't even classify yet.
- OSC needs ≥4 (ansi_up.ts:378).
- CSI regex returning `null` → Incomplete (ansi_up.ts:340).

### The "match legal OR illegal" regex termination guarantee
The CSI parse (ansi_up.ts:307) is the cleverest part. JS regex has no partial-match mode, so you can't ask "is this a prefix of a valid sequence?" The author sidesteps this by building one regex with two alternatives:
- Alternative 1 matches a *complete legal* CSI sequence.
- Alternative 2 matches a CSI followed by an *illegal* control char (capture group 4).

So: match `null` ⇒ we have neither a complete legal sequence nor an illegal one ⇒ must be an incomplete prefix ⇒ wait for more bytes. Match with group 4 set ⇒ garbage ⇒ drop the ESC and resync. Match without group 4 ⇒ valid sequence, consume it. This converts "do we have enough bytes yet?" into a single deterministic regex match (comment at ansi_up.ts:329: "This match is guaranteed to terminate even on invalid input").

The CSI grammar it encodes (ansi_up.ts:296):
```
CSI = ESC '[' , private-mode([<=>?])? , params([\d;]*) , intermediate([\x20-\x2f]?) command([\x40-\x7e])
```
Only sequences with empty private-mode and command char `'m'` become `SGR`; everything else is `Unknown` and dropped (ansi_up.ts:363).

### OSC-8 hyperlink parsing without partial-match support
Because OSC URLs are open-ended, the lexer (ansi_up.ts:421) uses a *global, stateful* regex (`_osc_st`) and runs `exec()` twice, advancing `lastIndex` each time to find two consecutive String Terminators (ESC-`\` or BEL). Only after locating both STs does it run the full `_osc_regex` (ansi_up.ts:501) to capture URL + text. Comment at ansi_up.ts:440 stresses: must reset `lastIndex = 0` and rely on global-exec statefulness. Illegal control chars inside the OSC (capture group 3) abort the match and resync on the ESC.

### Param-consuming SGR interpreter
`process_ansi` (ansi_up.ts:599) splits the param string on `;` and `shift()`s through it in a `while` loop rather than `forEach` — *because some SGR codes consume following params* (explicit comment at ansi_up.ts:607). Codes 38/48 (extended color) peek ahead: mode `5` consumes one 256-palette index; mode `2` consumes three RGB bytes (ansi_up.ts:641-677). A `forEach` couldn't do this lookahead.

SGR reset semantics encoded inline: `0`/NaN resets all; `22` clears both bold and faint; `39`/`49` reset fg/bg only (ansi_up.ts:616-639).

### 256-color palette construction
`setup_palettes()` (ansi_up.ts:154) builds the xterm-256 table programmatically: indices 0-15 from the named ANSI tables, 16-231 as a 6×6×6 RGB cube using levels `[0,95,135,175,215,255]`, and 232-255 as a 24-step grayscale ramp starting at 8 stepping by 10. Cube/grayscale entries get `class_name:'truecolor'` so the renderer knows they have no named CSS class.

### Dual rendering: inline styles vs CSS classes
`transform_to_html` (ansi_up.ts:682) supports `use_classes` mode. Named colors emit `class="ansi-red-fg"`; truecolor/cube colors fall back to inline `color:rgb(...)` even in class mode (ansi_up.ts:715) because there's no class for arbitrary RGB. Fast path: a fragment with no attributes returns escaped text with no `<span>` wrapper at all (ansi_up.ts:691) — minimizes DOM/markup bloat.

## Code patterns worth stealing

**Verbose, commented regexes via a tag function.** `rgx`/`rgxG` (ansi_up.ts:762) are template-literal tags that strip whitespace and `#` comments from `.raw[0]`, letting you write multi-line annotated regexes that compile to a compact `RegExp`. Uses `.raw` so backslashes aren't doubled.
```ts
function rgx(tmplObj, ...subst) {
  let regexText = tmplObj.raw[0];
  let wsrgx = /^\s+|\s+\n|\s*#[\s\S]*?\n|\n/gm;
  return new RegExp(regexText.replace(wsrgx, ''));
}
```

**Lazy regex init at point of use.** Each big regex is built on first need (`if (!this._csi_regex)`), keeping the pattern textually adjacent to the code that uses it (readability) while compiling once.

**Lexer mutates a shared buffer and returns one token.** `get_next_packet` slices `_buffer` and returns `{kind, text, url}`. The main loop is a clean `while(true)` switch on `kind`. Classic separation: lexer knows bytes, loop knows policy (drop/render/update-state).

**Snapshot-state-onto-token.** `with_state` copies current style flags into the text token so rendering is pure w.r.t. that snapshot — decouples "when state changes" from "when text is emitted."

**HTML escaping in one regex pass** (ansi_up.ts:212): `/[&<>"']/gm` with a replacer covering the 5 dangerous chars; gated by `_escape_html`.

**URL allowlist by scheme** (ansi_up.ts:742): split on `:`, check `_url_allowlist[scheme]` (default `{http:1, https:1}`), drop everything else — prevents `javascript:`/`data:` injection through OSC-8.

## Gotchas / non-obvious decisions
- **`get_next_packet` has no return on the `(` branch's fallthrough**; the `(` charset-select case (ansi_up.ts:550) blindly drops 3 chars as `Unknown` — it assumes a 3-byte charset designator, which can be wrong for longer ones, but those are rare.
- **State is per-instance and persistent.** Reusing one `AnsiUp` across unrelated streams leaks color state. There is no reset method; you instantiate a fresh `AnsiUp` per logical stream.
- **`background-color:rgb(${bg.rgb})`** (ansi_up.ts:711) relies on `Array.toString()` joining with commas — works but inconsistent with the explicit `.join(',')` used for fg.
- **Bold/faint coupling:** code `22` clears both; `21` only clears bold. This matches the messy real-world SGR spec, not intuition.
- **Illegal-sequence recovery always drops just one byte** (the ESC) and re-lexes, rather than skipping the whole bad sequence — guarantees forward progress without over-consuming valid following text.
- **OSC-8 requires the full close sequence** `ESC]8;;ST` to be present (URL capped at 512 chars, ansi_up.ts:507); a hyperlink whose closing tag hasn't streamed in yet stays buffered as Incomplete indefinitely.
- The `palette_256` truecolor cube entries reuse RGB levels even for the 16 base slots' overlap region — base colors come first so they win.

## Relevance (which advanced-TUI topics this teaches)
- **ansi-escapes**: a reference implementation for parsing CSI/SGR and OSC-8 hyperlink escapes, including the legal-or-illegal regex termination trick and param-consuming SGR interpretation.
- **rendering-pipeline**: clean lexer → token → state-update → render separation; snapshot-state-onto-token pattern; cheap fast-path for unstyled runs.
- **pty-emulation**: directly applicable to consuming raw pty/stream output where escape sequences arrive split across chunks; the Incomplete-buffering protocol is the core lesson.
- **widgets-rich-content**: turning terminal styling (256/truecolor, bold/italic/underline, hyperlinks) into safe, class- or style-based HTML widgets with scheme allowlisting and HTML escaping.
