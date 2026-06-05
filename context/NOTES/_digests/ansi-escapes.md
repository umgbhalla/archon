# ansi-escapes

## What it is (1-2 lines)
A tiny, dependency-light catalog of ANSI/OSC escape sequences for terminal control: cursor movement, screen/line erasing, alternative screen, synchronized output, hyperlinks, inline images (iTerm2 OSC 1337), and shell CWD reporting. Pure string-builder — emits sequences, parses nothing.

## Architecture (how the pieces fit; key files with paths)
- `base.js` — the entire implementation. ~200 lines of exported constants and functions. No state, no render loop; every export is either a precomputed string constant or a pure function returning a string.
- `index.js` — re-exports everything from `base.js` both as named exports and as a `default` namespace (`export * as default from './base.js'`), so both `import {cursorTo}` and `import ansi from 'ansi-escapes'` styles work.
- `base.d.ts` — types + the real documentation (per-sequence semantics, terminal-support caveats, warnings). `index.d.ts` just re-exports.
- `example.js` — usage: inline image from a JPEG buffer + an iTerm annotation positioned via `cursorPrevLine`.
- Single external dep: `environment` (provides `isBrowser`). Everything else gates on `process.env` / `process.platform` / `os.release()`.

Three byte-level primitives drive all output (`base.js:5-8`):
```
const ESC = '[';   // CSI — Control Sequence Introducer
const OSC = ']';   // Operating System Command
const BEL = '';    // string terminator for OSC (alternative to ST = ESC \)
const SEP = ';';
```

## Core techniques (the actual TUI engineering)

### CSI cursor/erase sequences (the bread-and-butter)
- Absolute position is **1-based** in the terminal but the API is **0-based**, so every coordinate is `+1`'d: `cursorTo(x,y)` → `ESC + (y+1) + ';' + (x+1) + 'H'` (`base.js:38`). Note the row;col ordering (y first) — a classic footgun the lib hides.
- `cursorTo(x)` with no `y` uses CHA (`G`, column-only) rather than CUP (`H`) — `base.js:35`.
- `cursorMove(x,y)` decomposes relative motion into separate CUD/CUU/CUF/CUB sequences by sign, emitting only nonzero axes (`base.js:48-58`). Pattern worth copying: don't emit `ESC 0 A` no-ops.
- Erase family maps directly to CSI codes: `eraseEndLine = ESC K` (0K), `eraseStartLine = ESC 1K`, `eraseLine = ESC 2K`, `eraseDown = ESC J`, `eraseUp = ESC 1J`, `eraseScreen = ESC 2J` (`base.js:91-96`).

### eraseLines — the redraw-in-place idiom (`base.js:77-89`)
The one piece of "logic." To overwrite N lines of prior output (the core trick behind progress bars / live status / spinners):
```js
eraseLines(count) {
  let clear = '';
  for (let i = 0; i < count; i++) {
    clear += eraseLine + (i < count - 1 ? cursorUp() : ''); // erase, then step up — but not past the last
  }
  if (count) clear += cursorLeft;  // ESC G — return to column 0
  return clear;
}
```
Key detail: it erases the current line, moves up, repeats, and skips the final `cursorUp` so the cursor lands on the topmost erased line ready to rewrite. `cursorLeft` (`ESC G`, `base.js:68`) snaps to column 0. This is exactly how `log-update` / Ink-style "rewrite the last frame" works.

### Screen/state management for full-screen apps
- Alternate screen: `enterAlternativeScreen = ESC ?1049h` / `exitAlternativeScreen = ESC ?1049l` (`base.js:132-133`) — the private mode that gives you a clean buffer and restores the user's scrollback on exit (what vim/less/htop use).
- Synchronized output (`base.js:135-137`): `ESC ?2026h` … `ESC ?2026l` brackets a frame so the terminal renders it atomically — **the modern anti-flicker primitive**. `synchronizedOutput(text)` wraps a whole frame string. Critical for advanced TUIs doing full-frame repaints.
- `clearViewport = eraseScreen + ESC H` (`base.js:102`) is the "safe" clear (viewport + home). `clearScreen = ESC c` (RIS) and `clearTerminal` (`ESC 2J ESC 3J ESC H`) also nuke scrollback — `3J` is the "erase saved lines" extension. The `.d.ts` explicitly warns RIS resets modes and behaves inconsistently (`base.d.ts:209-224`).

### OSC sequences (richer terminal features)
- Hyperlinks (`base.js:141-145`): OSC 8 with two empty params then the URL, terminated by BEL, then `OSC 8 ;; BEL` to close: `link(text,url)` = `OSC 8 ;; url BEL  text  OSC 8 ;; BEL`.
- iTerm2 inline image (`base.js:147-166`): `OSC 1337;File=inline=1` + optional `;width=`/`;height=`/`;preserveAspectRatio=0`, then **`;size=<byteLength>`** (spec says optional but xterm.js requires it — a documented compatibility tweak), then `:` + base64 payload + BEL.
- iTerm annotations (`base.js:171-195`): OSC 1337 `AddAnnotation=` / `AddHiddenAnnotation=`. Positional form packs `message|length|x|y`; un-positioned form is `length|message`. Validates that x/y/length come as a set, and strips `|` from the message since it's the field delimiter.
- CWD reporting: `iTerm.setCwd` → `OSC 50;CurrentDir=...`; `ConEmu.setCwd` → `OSC 9;9;...`; `setCwd` emits both (`base.js:168-202`).

### Terminal/multiplexer quirk handling (`base.js:10-27`)
This is the most "durable knowledge" part — the compatibility shims:
- **tmux OSC wrapping** (`wrapOsc`): tmux requires OSC payloads be wrapped in a DCS passthrough `ESC P tmux; <seq> ESC \`, AND every `ESC` inside the payload doubled (`replaceAll('','')`), and only accepts `ESC \` as the terminator. Every OSC-emitting function routes through `wrapOsc`. Detection: `TERM` starts with `screen`/`tmux` or `$TMUX` is set (`base.js:12`).
- **Apple Terminal** uses the DEC `ESC 7`/`ESC 8` save/restore instead of `ESC s`/`ESC u` (`base.js:69-70`), gated on `TERM_PROGRAM === 'Apple_Terminal'`.
- **Old Windows** (`isOldWindows`, `base.js:104-122`): pre-Win10 or build < 10586 had no VT processing for `3J`; `clearTerminal` falls back to `eraseScreen + ESC 0f` (`base.js:124-130`).
- Browser guard: `process.cwd` is replaced with a throwing stub when `isBrowser` so the bundle is import-safe in browsers (`base.js:14-16`).

## Code patterns worth stealing
- **0-based public API over 1-based VT coordinates** — normalize once at the boundary, never make callers remember row;col order or the +1.
- **Sign-decomposed relative motion**, emitting only nonzero axes (no `ESC 0 A` garbage).
- **OSC terminator wrapper as a single choke point** (`wrapOsc`) so every multiplexer quirk is fixed in one place rather than per-call-site.
- **Constants vs. functions split**: parameterless sequences are exported as precomputed strings (zero call overhead), parameterized ones as functions. Lets a renderer concatenate hot-path constants directly.
- **Synchronized-output wrapping of a whole frame** — build the entire next-frame string, wrap in `?2026h … ?2026l`, write once. The flicker-free render strategy.
- **Spec-vs-reality fixups documented inline** (e.g. forcing `size=` for xterm.js) — annotate why a deviation exists.

## Gotchas / non-obvious decisions
- `cursorTo` order is `(x, y)` in the API but emits `y;x` in CUP — internal inversion, easy to get wrong if reimplementing.
- `eraseLines` deliberately omits the last `cursorUp`; off-by-one here leaves the cursor on the wrong line.
- `clearScreen` (RIS) and `clearTerminal` have destructive side effects (scrollback wipe, mode reset) and are inconsistent across terminals; `clearViewport` is the recommended viewport-only clear (`base.d.ts:202-224`).
- iTerm `size=` is "optional" per spec but mandatory in practice for xterm.js (`base.js:164`).
- Annotation `|` is the field separator → it is stripped from user messages (`base.js:180`); positional vs non-positional argument packing differs in field order.
- tmux passthrough requires doubling every ESC and using `ESC \` as ST, not BEL — getting either wrong makes the sequence leak as visible text.
- This library only *emits* sequences. It does NOT parse responses — e.g. `cursorGetPosition` (`ESC 6n`) sends the query, but reading the terminal's reply is the consumer's job.

## Relevance (which advanced-TUI topics this teaches)
- **ansi-escapes**: the definitive concrete reference for CSI/OSC/DCS construction, terminator rules, and multiplexer-safe wrapping.
- **rendering-pipeline**: synchronized output (`?2026`), alternate screen, and the `eraseLines` redraw-in-place idiom are the foundation of flicker-free frame rendering and live-updating regions.
- **terminal-images**: complete worked example of the iTerm2 OSC 1337 inline-image protocol (base64 + size + dimension params) and the xterm.js `size=` quirk.
- **input-keyboard-mouse** (peripheral): shows the cursor-position *query* side (`ESC 6n`) even though it leaves parsing to the caller.
