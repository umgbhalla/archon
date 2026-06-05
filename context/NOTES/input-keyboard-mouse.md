# input-keyboard-mouse

How a TUI reads the keyboard and mouse from a terminal: put stdin into raw
mode, parse the resulting byte stream (mostly ANSI escape sequences) into typed
events, and dispatch those events to the focused component. This note compares
five real implementations and tells you what to build.

Note on direction: a terminal has two opposite sides.
- **Encode** (browser-emulator side): a key *event object* (e.g. a DOM
  `KeyboardEvent`) is turned into the *bytes* an app would receive. `xterm.js`
  does this (`KittyKeyboard.ts`) because it pretends to be the terminal for a
  hosted program.
- **Decode** (app/framework side): raw *bytes* from stdin are turned into a
  key *event object* your widgets handle. `opentui` and `react-curse` do this.
  This is what you build when you write a TUI.

The same protocols (CSI-u, SGR mouse, bracketed paste) appear on both sides;
the two directions are mirror images of the same wire format.

## TL;DR (the mental model in 3-5 bullets)

- **Stdin is one undelimited byte stream of ANSI sequences.** A keystroke, a
  10KB paste, a mouse wheel tick, and the terminal's reply to a capability
  query all arrive interleaved on `process.stdin`. There are no message
  boundaries — your parser *is* the framing layer.
- **The hard problem is framing, not decoding.** Once you have a complete
  sequence string, classifying it is a table lookup. The difficulty is: a lone
  `ESC` vs the start of `ESC[A`, sequences split across chunk boundaries, and
  not letting a capability reply or mouse report leak into text input. The
  canonical fix is a **byte-level state machine with a ~20ms ESC timeout**.
- **Three keyboard encodings coexist and you must handle all three.** Legacy
  xterm (`ESC[A`, `\x03` = Ctrl-C, `\x7f` = Backspace), `modifyOtherKeys`
  (`CSI 27;mod;code~`), and the **Kitty keyboard protocol / CSI-u**
  (`CSI code;mod:event;text u`) which alone reports key *releases*, *repeats*,
  base-layout codepoints, and unambiguous Ctrl/modifier combos.
- **Mouse is SGR (`ESC[<b;x;yM/m`) on modern terminals, X10 (`ESC[M` + 3 raw
  bytes) on old ones.** The button byte is a bitfield: low 2 bits = button,
  `&4/&8/&16` = shift/alt/ctrl, `&32` = motion/drag, `&64` = wheel. You opt in
  with `ESC[?1006h` (SGR) + `ESC[?1000/1002/1003h` (click/drag/move).
- **Dispatch is "route to focus, then bubble, with cancellation."** Keyboard
  goes to the focused component (global handlers first, `preventDefault` /
  `stopPropagation` to cut the chain). Mouse goes to whatever is under the
  cursor — resolved by an **O(1) hit grid** (renderable-id per cell), not a
  tree walk.

## How it actually works (the mechanism, step by step)

### Step 0: Raw mode + opt-in to protocols

Cooked mode buffers a line and handles Ctrl-C for you. A TUI needs every byte
immediately, so it flips raw mode. `react-curse` does the minimal thing:

```ts
// react-curse/hooks/useInput.ts:5
if (!process.stdin.isRaw) process.stdin.setRawMode?.(true)
```

Then you *enable* the protocols you want by writing escape sequences to stdout.
`opentui`'s catalog (`opentui/packages/core/src/zig/ansi.zig`):

```zig
enableButtonEventTracking = "\x1b[?1002h"   // report drags (button held + move)
enableAnyEventTracking    = "\x1b[?1003h"   // report bare mouse moves
enableSGRMouseMode        = "\x1b[?1006h"   // SGR encoding (decimal, unbounded coords)
focusSet                  = "\x1b[?1004h"   // FocusIn/FocusOut events (ESC[I / ESC[O)
bracketedPasteSet         = "\x1b[?2004h"   // wrap pastes in ESC[200~ ... ESC[201~
csiUPush                  = "\x1b[>{d}u"     // push Kitty keyboard flags (progressive enhancement)
csiUPop                   = "\x1b[<u"        // pop them on teardown
modifyOtherKeysSet        = "\x1b[>4;1m"     // xterm modifyOtherKeys fallback
```

`react-curse` only does `ESC[?1000h ESC[?1005h` (`react-curse/term.ts:83`) —
basic X10 click reporting, no SGR, no drag. That is the floor.

**Kitty keyboard is gated on capability detection.** `opentui` queries
`ESC[?u` at startup and only pushes flags if the terminal answered
(`terminal.zig:365`). The default flag set is `0b00101` =
`DISAMBIGUATE_ESCAPE_CODES | REPORT_ALTERNATE_KEYS` (`terminal.zig:120`). It
*disables* `modifyOtherKeys` when Kitty is on (`terminal.zig:366-369`) so the
two encodings don't both fire. Crucial teardown detail: every mode you set must
be reset on exit (`terminal.zig:214` resets Kitty), or you leave the user's
shell in a broken state.

### Step 1: The byte-level framing state machine (the heart)

`opentui`'s `StdinParser` (`opentui/packages/core/src/lib/stdin-parser.ts`) is
the most complete real-world example. It is a push-driven state machine: you
`push(bytes)`, it emits typed `StdinEvent`s (`"key" | "mouse" | "paste" |
"response"`, `stdin-parser.ts:20-41`). The states (`stdin-parser.ts:65-99`)
mirror the VT protocol families: `ground`, `esc`, `csi`, `ss3`, `osc`, `dcs`,
`apc`, plus specialized sub-states for SGR mouse and parametric CSI.

The loop (`scanPending`, `stdin-parser.ts:850`) walks pending bytes one at a
time. From `ground`, the first byte decides everything (`:881-910`):
`ESC` → `esc` state; `<0x80` → emit a one-char key; a UTF-8 lead byte → `utf8`
state collecting continuation bytes; an invalid high byte → legacy meta-key
path. Inside `esc` (`:966`), the next byte picks the sub-protocol:
`[`→CSI, `O`→SS3, `]`→OSC, `P`→DCS, `_`→APC.

**The ESC-disambiguation timeout is the single most important trick.** A lone
`ESC` keypress and the first byte of `ESC[A` (up-arrow) are byte-identical.
The parser resolves this with time: if an incomplete unit sits in the buffer
longer than `DEFAULT_TIMEOUT_MS = 20` (`stdin-parser.ts:113`), a `forceFlush`
flag is set and the next `read()` commits the partial unit as a final event
(a lone `ESC` becomes the Escape key, `:956-958`). The comment notes the
industry spread: "Gemini/Claude uses 50ms, Codex uses 20ms." `react-curse`
has *no* timeout — it relies on the OS delivering whole sequences in one
`data` event, which is why it's fragile over SSH/slow links.

**Chunk-shape invariance** is the parser's contract (`stdin-parser.ts:563-565`):
the same bytes produce the same events regardless of how they're chopped into
`push()` calls. Split UTF-8 reassembles; an `ESC \` (string terminator) that
splits across chunks is tracked with a `sawEsc` flag per OSC/DCS/APC state
(`:1598`, `:1642`, `:1678`). The `ByteQueue` (`:139`) uses start/end offsets
and only compacts via `copyWithin` when the consumed prefix exceeds half the
buffer — amortized-O(1) consume without reallocating.

`react-curse`'s parser (`react-curse/input.ts:26-56`) is the toy version of the
same idea — a greedy length-based muncher:

```ts
// react-curse/input.ts:31  — grow the chunk by fixed lengths per sequence shape
if (['\x10','\x1b'].includes(res)) {           // ESC-prefixed
  res += chars.shift()                          // +1
  if (res.endsWith('\x5b')) {                   // it's CSI ([)
    res += chars.shift()                         // +1 (e.g. arrow final byte)
    if (/[1456]$/) res += chars.shift()          // pageup/home/end → +1 (the ~)
    else if (res.endsWith('\x4d')) {             // X10 mouse (M)
      res += chars.shift(); res += chars.shift(); res += chars.shift() // +3 raw bytes
    }
  }
}
```

It hard-codes the byte counts for the handful of sequences it knows. Multiple
keypresses in one chunk become `chunks[]`; extras beyond the first are stashed
in a `queue` and drained one-per-frame (`input.ts:19,67-70`) so a fast typist
or a paste doesn't flood a single render frame.

### Step 2: Classifying a complete sequence into a key

Once framing yields a complete string, `parseKeypress`
(`opentui/.../lib/parse.keypress.ts:214`) decodes it. Its structure is a long
`if/else` chain, and the *order* matters because it doubles as a filter:

1. **Reject non-keys first** (`parse.keypress.ts:230-291`): SGR/X10 mouse
   reports, DSR cursor replies (`ESC[r;cR`), Device Attributes (`ESC[?...c`),
   window-size reports, **focus events** (`ESC[I` / `ESC[O`, `:279`), and
   **bracketed-paste markers** (`ESC[200~` / `ESC[201~`, `:289`) all return
   `null`. This is how capability traffic avoids being typed into a text box.
2. **Kitty** if enabled (`:312`, delegates to `parseKittyKeyboard`).
3. **modifyOtherKeys** (`:324`): `CSI 27;mod;code~`. Modifier is `param-1` as a
   bitfield: `&1`=shift, `&2`=alt/meta, `&4`=ctrl, `&8`=super, `&16`=hyper
   (`:329-334`).
4. **Legacy single bytes** (`:360-398`): `\r`→return, `\x7f`→backspace,
   `\x03`→ctrl+c. Control letters: `getCtrlKeyName` (`:143`) maps `0x01..0x1a`
   → `a..z` (so Ctrl-A is byte 1), `0x1c..0x1f` → `\ ] ^ _`. `A-Z` → lowercase
   name + `shift:true`.
5. **Legacy CSI/SS3 function keys** via a big lookup table (`keyName`, `:9-123`)
   plus the `fnKeyRe` regex (`:7`) that pulls out the modifier param. The table
   carries variants for xterm, rxvt, putty, Cygwin, and VT100 application
   keypad (SS3) — e.g. `OP`→f1, `[15~`→f5, `[[A`→f1.

The output is a `ParsedKey` (`:161-182`): `{name, ctrl, meta, shift, option,
sequence, eventType, source, baseCode?, ...}`.

### Step 3: Kitty / CSI-u — the modern protocol, both directions

**Decode** (`opentui/.../lib/parse.keypress-kitty.ts:304`). Wire format:
`CSI unicode-code[:shifted[:base]] ; modifiers[:event-type] ; text-codepoints u`.

- Field 1 splits on `:` into (codepoint, shifted-codepoint, base-layout
  codepoint) (`:343`). The base-layout codepoint is gold: a Korean-layout key
  can print `ㅊ` but report base `99` = `c`, letting `Ctrl+C` shortcuts work
  regardless of layout/IME. opentui keeps it as `key.baseCode` (`:381`).
- Field 2 is `modifier-1` (Kitty modifiers are 1-based) decoded via
  `fromKittyMods` (`:165`): `&1`shift `&2`alt `&4`ctrl `&8`super `&16`hyper
  `&32`meta `&64`capslock `&128`numlock. The event-type sub-field is
  `1`=press `2`=repeat `3`=release (`:410-420`) — **the only protocol that
  reports release and repeat.**
- Field 3 is the literal text the key produced as codepoints (`:424`), so the
  app gets exact text even for dead-key / compose sequences.
- High codepoints `57344+` map to named functional keys via `kittyKeyMap`
  (`:6-137`): `57352`=up, `57441`=leftshift, `57414`=kpenter, etc.

**Encode** (`xterm/src/common/input/KittyKeyboard.ts:416 evaluate`) is the
mirror. Given a DOM-like event + the active flag set, it decides the output
form (`:448-507`): arrows/Home/End → CSI-letter (`ESC[1;mod A`), F1-4 → SS3
(`ESC O P`), Insert/PgUp/F5-12 → CSI-`~`, everything else → CSI-`u`. The
genuinely hard logic is `useCsiU` (`:485-503`): the spec's rules for *when* the
unicode form is forced, with legacy carve-outs so Enter/Tab/Backspace/space
"still generate the same bytes as in legacy mode" unless modified. Modifiers
are encoded as `1 + bitfield` (`_encodeModifiers`, `:207`); release events are
suppressed unless `REPORT_EVENT_TYPES` is set (`:432`). The five progressive-
enhancement flags (`KittyKeyboardFlags`, `:15-27`) are exactly the bits
`opentui` pushes with `ESC[>{flags}u`.

### Step 4: Mouse decoding

`opentui/.../lib/parse.mouse.ts` (`MouseParser`). Two encodings, one button
bitfield. SGR (`parseSgrSequence`, `:84`): `ESC[<` then three decimal params
then `M` (press) or `m` (release). `decodeSgrEvent` (`:141`):

```ts
const button   = rawButtonCode & 3
const isScroll = (rawButtonCode & 64) !== 0   // wheel
const isMotion = (rawButtonCode & 32) !== 0   // move/drag
const modifiers = { shift:(rb&4), alt:(rb&8), ctrl:(rb&16) }
// motion + a button held (tracked in a Set) ⇒ "drag", else "move"
// scroll button 0/1/2/3 ⇒ up/down/left/right
```

It tracks pressed buttons in a `Set` (`:23`) so a motion report becomes `drag`
vs `move` based on whether a button is currently down (`:156-165`) — the
terminal does not tell you "drag", you infer it. X10 (`parseBasicSequence`,
`:126`) reads three *raw* bytes after `ESC[M`, each offset by 33 (`-32` for the
button byte). Critical encoding gotcha: opentui decodes the buffer as `latin1`
(`decodeInput`, `:38`) precisely so X10 payload bytes ≥ 0x80 survive — UTF-8
decoding would corrupt high coordinate bytes. That's also why X10 can't report
coords past ~223.

`react-curse` (`hooks/useMouse.ts:21`) shows the same bitfield by hand:
```ts
const type = (1<<6)&b ? (1&b?'wheelup':'wheeldown') : (3&b)===3 ? 'mouseup' : 'mousedown'
const x = input.charCodeAt(4) - 0o41   // 0o41 == 33, the X10 offset
```

`gloomberb` patches opentui's `MouseParser` (`gloomberb/patches/*.patch`)
because upstream dropped two things: **extended buttons** (`rawButtonCode & 128`
→ buttons 8-11, the back/forward/extra mouse buttons) and **pixel→cell
projection** (`projectPixelToCell`) for hosts with sub-cell pointer resolution.
If you build precise-pointer or extra-button UX you will hit the same gaps.

### Step 5: Paste

Bracketed paste (`ESC[?2004h`) wraps pasted text in `ESC[200~ … ESC[201~`.
Without it, a multi-line paste looks like a flurry of Enter keypresses (and a
paste containing `:q` could quit your editor). `opentui`'s parser has a dedicated
`PasteCollector` (`stdin-parser.ts:104,531`): when it sees the start marker it
switches the whole stream into paste mode (`consumePasteBytes`, `:1892`),
accumulating raw bytes *without* running them through the keypress machine, and
keeps only a small tail to detect the end marker across chunk boundaries. This
is essential — a 1MB paste must not grow the parser's pending buffer or get
parsed byte-by-byte. It emits one `{type:"paste", bytes}` event.

### Step 6: Dispatch to the focused component

Two different routing rules: keyboard → focus, mouse → geometry.

**Keyboard / focus.** `opentui` keeps a single `_currentFocusedRenderable`
(`renderer.ts:867`). Calling `.focus()` on a renderable (`Renderable.ts:392`)
registers a keypress handler on the shared `InternalKeyHandler` and calls
`ctx.focusRenderable(this)` which blurs the previous holder
(`renderer.ts:1320-1340`). When focus changes it also walks ancestors flipping
`_hasFocusedDescendant` (`propagateFocusChange`, `:425`) so containers can style
themselves.

The dispatch order is the interesting part (`InternalKeyHandler.emitWithPriority`,
`KeyHandler.ts:141`): **global listeners run first, in registration order**, and
between each it checks `event.propagationStopped` (`:160`). Then renderable
(focused-component) handlers run, but only if no global handler set
`defaultPrevented`/`propagationStopped` (`:179`). The handler list is snapshotted
before iterating (`:171`) so a handler that changes focus mid-dispatch doesn't
receive the in-flight event. `KeyEvent` itself carries
`preventDefault`/`stopPropagation` (`KeyHandler.ts:55-61`).

`gloomberb` builds a richer **phased shortcut registry** on top of opentui's
single `useKeyboard` (`gloomberb/src/renderers/opentui/input-host.tsx:22`):

```ts
for (const phase of ["before","normal","after"] as const) {
  if (phase === "after" && (event.defaultPrevented || event.propagationStopped)) return
  for (const entry of shortcuts) {
    if (entry.phase !== phase || !entry.enabledRef.current) continue
    if (!shouldDeliverShortcut(event, entry.allowEditableRef.current)) continue
    entry.handlerRef.current(event)
    if (event.propagationStopped) return
  }
}
```

Handlers are stored as refs (`handlerRef.current`) so re-subscribing isn't
needed each render; `useLayoutEffect` only re-runs on phase/scope change.
The linchpin is `shouldDeliverShortcut` (`gloomberb/src/react/input.ts:61`):
bare single-letter keys are **swallowed when a text field is focused**
(`targetEditable`) unless the chord has ctrl/meta/super. Get this wrong and
typing `q` in a search box quits the app.

**Mouse / hit-testing.** opentui resolves the target via an **O(1) hit grid**:
the native renderer writes each renderable's numeric id into a per-cell
`[]u32` during render, so `hitTest(x,y)` is one array index. `processMouseEvent`
in the renderer (`renderer.ts:3380`) looks up `Renderable.renderablesByNumber`,
then synthesizes higher-level events the protocol never sends: tracking
`lastOverRenderable` to fire `out`/`over` (hover, `:3440-3461`),
`capturedRenderable` to deliver `drag`/`drag-end`/`drop` to the element where
the drag started even after the pointer leaves it (`:3463-3490`), and starting
a text selection on left-down (`:3385-3403`). Clicking a focusable renderable
focuses it. This synthesis layer (move→over/out, down+move→drag, drag+up→drop)
is the bulk of "mouse support" and the protocol gives you none of it.

## Cross-repo comparison

| Concern | opentui | xterm.js | react-curse | gloomberb | terminal-control |
|---|---|---|---|---|---|
| Direction | decode (bytes→event) | **encode** (event→bytes) | decode | decode (on opentui) | encode (test harness) |
| Framing | full byte state machine, ESC timeout, chunk-invariant | n/a (it's the emulator) | greedy length-muncher, no timeout | inherits opentui | n/a |
| Kitty CSI-u | parse: code/shifted/base, event types, text | encode: full progressive-enhancement flags + useCsiU rules | none | inherits | none |
| modifyOtherKeys | yes (`CSI27;m;c~`) | no | no | inherits | no |
| Mouse | SGR + X10, drag/hover/scroll synthesis, latin1-safe | n/a | X10 only, basic | + extended buttons + pixel→cell (patch) | encodes keys only |
| Paste | bracketed, dedicated collector, streaming | n/a | filtered out, not surfaced | inherits | n/a |
| Focus events | `ESC[?1004h`, filtered in parse | n/a | no | inherits | n/a |
| Dispatch | focus + global/renderable phases, hit grid | n/a (lib emits a key event) | flat `useInput`/`useMouse` hooks | phased+scoped shortcut registry, editable-aware | JSONL key→bytes for tests |
| Key→bytes table | n/a | the whole thing | n/a | n/a | `driver.rs:478 key_bytes` |

**Where they agree:** the wire format (CSI-u, SGR mouse, bracketed paste,
modifier bitfields). xterm.js encoding `1+modifier` and opentui decoding
`modifier-1` is the same convention seen from both ends.

**Where they differ / who's better:**
- **Framing robustness:** opentui's `StdinParser` is far ahead — the ESC
  timeout, chunk-invariance, paste streaming, and "is this a capability reply
  or a key?" deferral logic (`canDeferParametricCsi`, `:398`) are exactly the
  things react-curse's muncher gets wrong over real-world I/O. If you read one
  file, read `stdin-parser.ts`.
- **Encoding completeness:** xterm.js `KittyKeyboard.ts` is the reference for
  the *encode* side and the subtle `useCsiU` rules. Use it as the spec when
  writing a decoder.
- **Dispatch ergonomics:** gloomberb's phased + scoped + editable-aware registry
  is the best-factored dispatch model; opentui's renderer gives you focus +
  hit-grid + mouse-event synthesis underneath it.

## Pitfalls & hard parts

- **Lone ESC vs escape sequence.** Without a timeout you can't tell them apart.
  20-50ms is the accepted range (`stdin-parser.ts:113`). Too short = arrow keys
  break on slow links; too long = pressing Escape feels laggy.
- **Sequences split across chunks.** `ESC` in one `data` event, `[A` in the
  next. A naive `chunk.toString()` parser drops or mis-parses these. You need a
  pending buffer and a resumable state machine (react-curse has neither).
- **Capability replies leaking into text.** The terminal answers your DSR/DA1/
  Kitty/theme queries on the *same* stdin as keystrokes. If your parser doesn't
  recognize and route them (opentui emits them as `"response"` events,
  `parse.keypress.ts:254-291` returns `null`), `ESC[?62;c` shows up in a text
  box. terminal-control inverts this: as a fake host it *answers* probes so the
  app doesn't hang waiting (`terminal-control/src/shot.rs:502`).
- **Mouse coordinate corruption (X10).** X10 packs coords as raw bytes; decode
  as latin1, never UTF-8 (`parse.mouse.ts:36-41`). X10 also can't express
  columns past ~223 — that's why SGR (`?1006h`, decimal, unbounded) exists.
- **Bracketed paste or you eat commands.** A pasted `:wq\n` without bracketed
  paste runs as keystrokes. And the collector must *stream* — don't buffer a
  huge paste through the per-key parser.
- **Single-letter shortcuts vs text inputs.** A global `q`-to-quit must not fire
  while a text field is focused. `shouldDeliverShortcut`
  (`gloomberb/src/react/input.ts:61`) is the canonical guard: suppress bare keys
  when editable unless ctrl/meta/super.
- **Three keyboard encodings at once.** The same Enter can arrive as `\r`,
  `CSI 27;1;13~`, or `CSI 13 u` depending on which modes are active. Don't
  enable Kitty *and* modifyOtherKeys simultaneously (opentui disables the
  latter, `terminal.zig:366`).
- **Mouse drag/hover aren't in the protocol.** The terminal sends down/up/move;
  you synthesize over/out/drag/drag-end/drop and capture
  (`renderer.ts:3440-3490`). This is most of the work.
- **Resetting modes on exit.** Every `?...h` you set must be `?...l`-reset and
  Kitty flags popped (`ESC[<u`), or the shell is left broken after your app
  exits or crashes.
- **macOS Backspace.** `\x7f` (DEL) is Backspace on macOS, not Ctrl-? —
  handled at `parse.keypress.ts:371`.

## If you were building this from scratch

Build a **push-driven byte state machine** that emits typed events, plus a
**decode table**, plus a **focus + hit-grid dispatcher**. Don't write a
greedy length-muncher; it will not survive real I/O.

```ts
// 1. Setup
stdin.setRawMode(true)
write("\x1b[?1006h\x1b[?1002h\x1b[?1003h\x1b[?1004h\x1b[?2004h")  // sgr mouse, drag, move, focus, paste
if (kittySupported) write("\x1b[>5u")                              // disambiguate + alternate keys
onExit(() => write("\x1b[?1006l...\x1b[?2004l\x1b[<u"))            // RESET EVERYTHING

// 2. Framing: feed bytes, emit complete units
let pending = []; let state = "ground"; let pendingSince = null
function push(bytes) {
  for (const b of bytes) {
    pending.push(b)
    switch (state) {
      case "ground":
        if (b === ESC) state = "esc"
        else if (b < 0x80) emit(decodeKey(takeUnit()))   // plain key
        else collectUtf8()
        break
      case "esc":   state = (b==='[') ? "csi" : (b==='O') ? "ss3" : ...; break
      case "csi":
        if (b === 'M' && atOffset(2)) state = "x10mouse(3 bytes)"
        else if (b === '<' && atOffset(2)) state = "sgrmouse"
        else if (b === '2' .. && isPasteStart()) state = "paste"
        else if (isFinalByte(b)) emit(classify(takeUnit())); state="ground"
        break
      // ... osc/dcs/apc end at BEL or ESC\, tracking a sawEsc flag
    }
    if (incomplete) pendingSince ??= now()
  }
  armTimeout()
}
// 3. The ESC timeout — the load-bearing trick
function onTimeout() {                       // ~20ms after last incomplete byte
  if (now() - pendingSince >= 20) emit(classify(takeUnit()))  // lone ESC ⇒ Escape key
}

// 4. classify(seq): the decode table
//   ESC[<b;x;ym|M ⇒ mouse (button=b&3, drag=b&32, wheel=b&64, mods=b&4/8/16)
//   ESC[200~..ESC[201~ ⇒ paste (stream the body, don't per-char parse)
//   ESC[I / ESC[O ⇒ focus in/out
//   ESC[?...c, ESC[r;cR, ESC P... ⇒ "response" (NOT a key)
//   CSI code;mod:event u ⇒ kitty: split field1 on ':' for base codepoint;
//                          mod-1 bitfield; event 1/2/3 = press/repeat/release
//   \x03 ⇒ ctrl+c; \x7f ⇒ backspace; 0x01..0x1a ⇒ ctrl+letter; ESC[A ⇒ up; ...

// 5. Dispatch
function onKey(ev) {
  for (const h of globalHandlers) { h(ev); if (ev.stopped) return }
  if (focused && !ev.defaultPrevented) focused.handleKey(ev)   // route to focus
}
function onMouse(ev) {
  const target = hitGrid[ev.y * cols + ev.x]                   // O(1), id-per-cell
  // synthesize over/out vs lastOver; drag/drop vs captured; then deliver + bubble
  for (let n = target; n; n = n.parent) { n.handleMouse(ev); if (ev.stopped) break }
}
```

Key decisions, in priority order: (1) **ESC timeout** — without it nothing else
matters; (2) **typed events including a `response` type** so capability replies
never become text; (3) **stream pastes**; (4) **hit grid** for mouse, not a tree
walk; (5) **focus routing with cancellation** + an editable-aware guard for bare
keys. Add Kitty only after capability detection succeeds, and always reset modes
on exit.

## Source map (which files to read for more)

Decode side (what you build for a TUI):
- `opentui/packages/core/src/lib/stdin-parser.ts` — **the** byte state machine:
  framing, ESC timeout (`:113`), chunk-invariance, paste streaming (`:1892`),
  capability-reply deferral (`canDeferParametricCsi`, `:398`). Read this first.
- `opentui/packages/core/src/lib/parse.keypress.ts` — sequence→`ParsedKey`,
  the legacy key table (`:9-123`), non-key filtering (`:230-291`),
  modifyOtherKeys (`:324`).
- `opentui/packages/core/src/lib/parse.keypress-kitty.ts` — Kitty decode,
  field split + base codepoint (`:343`), event types (`:410`).
- `opentui/packages/core/src/lib/parse.mouse.ts` — SGR (`:84`) + X10 (`:126`)
  decode, button bitfield (`:141`), drag inference, latin1 safety (`:38`).
- `opentui/packages/core/src/lib/KeyHandler.ts` — global vs renderable dispatch,
  propagation (`emitWithPriority`, `:141`).
- `opentui/packages/core/src/Renderable.ts:392-457` — focus/blur, handler
  (de)registration, `_hasFocusedDescendant` propagation.
- `opentui/packages/core/src/renderer.ts:3314-3560` — mouse hit-test dispatch,
  over/out/drag/drop/capture synthesis, focus-on-click.
- `opentui/packages/core/src/zig/ansi.zig:303-393` + `terminal.zig:351-393` —
  the actual enable/reset escape sequences and Kitty flag push/pop + capability
  gating.
- `opentui/packages/core/src/lib/terminal-capability-detection.ts` — recognizing
  capability responses so they aren't keys.

Encode side (the spec, mirror image):
- `xterm/src/common/input/KittyKeyboard.ts` — Kitty *encode*: flags (`:15`),
  `evaluate` (`:416`), the `useCsiU` decision (`:485`).
- `xterm/src/common/input/Keyboard.ts`, `Win32InputMode.ts` — legacy xterm
  modifier encoding and Windows input mode.

Minimal reference / dispatch patterns:
- `react-curse/input.ts`, `hooks/useInput.ts`, `hooks/useMouse.ts`,
  `term.ts:70-83` — the smallest working decoder + mouse enable; good to grasp
  the shape, but note the missing timeout and SGR support.
- `gloomberb/src/react/input.ts` + `src/renderers/opentui/input-host.tsx` —
  phased/scoped/editable-aware shortcut registry; `global-shortcuts.ts`.
- `gloomberb/patches/@opentui*.patch` — extended mouse buttons (`&128`) and
  pixel→cell projection.
- `terminal-control/src/driver.rs:478 key_bytes` — named-key→escape-sequence
  table (the test-harness encode direction); `src/shot.rs:502 Host` answers
  capability probes.
