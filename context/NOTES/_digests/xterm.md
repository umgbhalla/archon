# xterm

## What it is (1-2 lines)
xterm.js: a production browser terminal emulator. A headless VT-parsing + buffer core (`src/common`, `src/headless`), a browser layer with three renderers (DOM, canvas, WebGL via addons), and addons for images (sixel/IIP/kitty), unicode graphemes, ligatures, search, etc. The single best open-source reference for "how a terminal emulator actually works."

## Architecture (how the pieces fit; key files with paths)
- **Write pipeline (back-pressure aware):** `Terminal.write(data)` → `src/common/input/WriteBuffer.ts` queues chunks → time-sliced `_innerWrite` (≤12ms/frame) → decode bytes→UTF32 → `InputHandler.parse` → `EscapeSequenceParser.parse`.
- **VT parser (the heart):** `src/common/parser/EscapeSequenceParser.ts` is a VT500 state machine (Paul Williams' diagram) driven by a flat `Uint16Array` transition table. Sub-parsers for string-type sequences: `OscParser.ts`, `DcsParser.ts`, `ApcParser.ts`. Params packed/parsed in `Params.ts`.
- **Buffer model:** `src/common/buffer/BufferLine.ts` (typed-array cell storage), `Buffer.ts` (lines + scrollback as a circular list), `BufferSet.ts` (normal/alt screens), `BufferReflow.ts` (rewrap on resize), `AttributeData.ts` (bit-packed fg/bg/flags), `CellData.ts`, `Marker.ts`.
- **Input encoding:** `src/common/input/Keyboard.ts` (legacy xterm modifiers), `KittyKeyboard.ts` (CSI-u protocol), `Win32InputMode.ts`, `TextDecoder.ts` (UTF8→UTF32 streaming), `XParseColor.ts`.
- **Renderers:** shared model in `src/browser/renderer/shared/`; `dom/DomRenderer.ts` + `DomRendererRowFactory.ts` (span-per-run DOM); WebGL renderer in `addons/addon-webgl/src/WebglRenderer.ts` with `GlyphRenderer.ts`, `RectangleRenderer.ts`, `TextureAtlas.ts`, `CellColorResolver.ts`, `RenderModel.ts`.
- **Images:** `addons/addon-image/src/` — `ImageAddon.ts` wires DCS sixel (`SixelHandler.ts`), OSC 1337 iTerm IIP (`IIPHandler.ts`), and APC kitty graphics (`kitty/`); `ImageStorage.ts` pins pixel data to buffer cells via extended attrs; `ImageRenderer.ts` composites onto the canvas.
- **Unicode:** `src/common/services/UnicodeService.ts` + version providers; `addons/addon-unicode-graphemes/` adds UAX#29 grapheme clustering via a compiled unicode-trie.

## Core techniques

### Table-driven VT state machine (no per-byte branching)
`EscapeSequenceParser.ts:97` builds `VT500_TRANSITION_TABLE` once. Index = `currentState << 8 | charCode`; value = `action << 8 | nextState`, both packed into one `Uint16Array` slot (`TableAccess` enum, line 38). The parse loop (`:684`) is just: lookup transition, `switch(action)`, set `currentState`. States and actions are `const enum`s so they inline to integers. Non-ASCII printables are folded to a single pseudo-byte `0xA0` (`NON_ASCII_PRINTABLE`, line 90) so the table stays 256-wide per state (size 4257).

### Hot-path read-ahead loops bypassing the table
The dispatch loop hardcodes tight inner loops for high-volume actions so it doesn't pay a table lookup per byte (`:531` doc comment lists them):
- **PRINT** (`:754`): 4-way-unrolled scan forward while bytes are printable, then one `_printHandler(data, start, end)` call over the whole run.
- **PARAM** (`:812`): inner `do/while` consuming digits/`;`/`:` directly.
- **OSC_PUT / DCS_PUT / APC_PUT**: scan to the next control byte and hand the slice off in one call.
- **EXE fast-path** (`:688`): control bytes `<0x18` in non-payload states skip the table entirely via `_executeHandlersArr[code]`.
- **CSI fast-path** (`:695`): when it sees `ESC [` with room, it collapses prefix+params+final parsing into one inlined loop, never entering the formal CSI states.

### Async handler suspension (resumable parser)
Handlers may return a `Promise`. The parser saves a stack (`_preserveStack`, `:515`: handlers list, handler index, transition, chunk position) and returns the promise. `WriteBuffer._innerWrite` (`:219`) re-schedules continuation when it resolves, passing the resolved boolean back into `parse(data, len, promiseResult)`. On resume (`:581`) it replays the remaining handler loop from the saved index. Improper resumption throws hard (`:604`) rather than silently corrupting state. This is how image decode (a slow async op) blocks the byte stream in-band without freezing the UI.

### Bit-packed cell storage (typed arrays, zero per-cell objects)
`BufferLine` stores 3 × `uint32` per cell in one `Uint32Array` (`BufferLine.ts:13`):
- `[0] content` = `width(2) | combinedFlag | codepoint(21)`
- `[1] fg` = `mode(2)/flags | color(24)`
- `[2] bg` = flags | color
Combined glyphs (emoji ZWJ, combining marks) and extended attrs (true-color underline etc.) are kept in **sparse side maps** (`_combined`, `_extendedAttrs`) only read when a flag bit is set (`:208`,`:213`). Cells are read via `loadCell(index, cell)` into a **reused** `CellData` object to avoid GC (`:203`). Module-level `$workCell`/`$startIndex` scratch globals (`:43`) eliminate allocation in insert/delete/scroll loops. `AttributeData.ts` exposes all flag tests as bit masks (`isBold() { return this.fg & FgFlags.BOLD }`).

### Wide-char / fullwidth handling in line ops
`insertCells`/`deleteCells`/`replaceCells` carefully fix up half of a wide char left dangling at edges (e.g. `:292` "reset cell one to the left if pos is second cell of a wide char"). Width is stored per cell; cell width 0 = trailing half / combining char.

### Renderer = diffed model, not direct draw
WebGL `_updateModel` (`WebglRenderer.ts:419`) walks the visible rows, resolves colors per cell (`CellColorResolver`), and writes a flat `Int32Array` model (`code, bg, fg, ext` per cell). **Crucially it diffs**: if the model slot already equals the new values it `continue`s (`:560`) — only changed cells call `glyphRenderer.updateCell`. Background rects only re-upload if `modelUpdated`. Cursor and per-row blink state tracked separately so a blink doesn't redraw text.

### GPU glyph atlas with multi-key cache
`TextureAtlas.ts` rasterizes each glyph once into a packed texture page and caches by `FourKeyMap<code|chars, bg, fg, ext>` (`:60`). Same char with different colors = different cache entries (color baked into the glyph, so the shader is a dumb textured-quad blit). Shelf packing with `ROW_PIXEL_THRESHOLD` padding; pages capped at 4096² (`FORCED_MAX_TEXTURE_SIZE`). `GlyphRenderer` uses instanced quads (`a_unitquad` + per-cell attributes, double-buffered `attributesBuffers` so the GPU can read frame N while CPU fills N+1, `:23`). Glyph color/coords passed as vertex attributes; fragment shader just samples the right texture page.

### DOM renderer: span-per-run coalescing
`DomRendererRowFactory.ts` builds one `<span>` per run of cells sharing identical attributes, accumulating `textContent` and only emitting a new span when style breaks (`:185`,`:475`). Minimum-contrast and underline-color handled via inline style. Avoids one element per character.

### Kitty keyboard (CSI-u) encoding
`KittyKeyboard.ts` implements the progressive-enhancement protocol as a 5-bit flag set (`KittyKeyboardFlags`, `:15`). `evaluate()` (`:416`) routes a key event: arrows/Home/End → CSI-letter, F1-4 → SS3, Insert/PageUp/F5-12 → CSI-`~`, everything else → CSI-`u`. The `useCsiU` decision (`:485`) is the tricky bit: it encodes the spec's rules for when DISAMBIGUATE / REPORT_EVENT_TYPES / REPORT_ALL_KEYS force the unicode form, with special legacy carve-outs for Enter/Tab/Backspace/space. Modifiers = `1 + bitfield`; release events suppressed unless reporting enabled.

### Unicode width + graphemes
`UnicodeGraphemeProvider.ts:24` `charProperties(codepoint, preceding)` returns packed `(kind, width, shouldJoin)`. ASCII fast path returns a frozen shared object (`:28`). For grapheme clustering it asks `UC.shouldJoin(prevKind, charInfo)` (UAX#29 break table from a compiled unicode-trie). Width: emoji-presentation/wide = 2, combining/extend = 0, regional-indicator pairs → width 2. `preceding` state is threaded through the parser as `precedingJoinState` so cluster joining survives chunk boundaries.

## Code patterns worth stealing
```ts
// 1. Pack a (state,input)->(action,nextState) transition table into one typed array.
table[state << 8 | code] = action << 8 | next;          // build
const t = table[currentState << 8 | code];               // lookup
switch (t >> 8) { ... }; currentState = t & 0xFF;        // dispatch

// 2. Read a struct out of a flat typed array into a reused object (no GC).
loadCell(i, cell) { const o = i*3; cell.content = data[o]; cell.fg = data[o+1]; cell.bg = data[o+2]; }

// 3. Diff a render model: skip cells whose packed attrs are unchanged.
if (model[i]===code && model[i+1]===bg && model[i+2]===fg) continue;

// 4. Time-slice a write queue to keep the frame budget.
while (queue.length) { process(chunk); if (now()-start >= 12) { schedule(); break; } }

// 5. Suspend a synchronous loop on a promise and resume it later.
if (result instanceof Promise) { preserveStack(handlers, j, ...); return result; }
// caller: parse(chunk, len, await result)  // replays from saved index
```

## Gotchas / non-obvious decisions
- **The fast-path loops duplicate the transition table logic.** The comment at `:531` warns any table change must be mirrored in the hardcoded PRINT/PARAM/OSC/DCS loop conditions — they are intentionally not kept in sync automatically.
- **Zero Default Mode (ZDM):** empty CSI params default to `0` (`:245`), which is *not* current ECMA-48; sub-params (colon-separated) default to `-1` instead. Deliberate vt100 compatibility.
- **Prefix/intermediate limits:** only one prefix byte (`0x3c–0x3f`) and two intermediates are supported (`_identifier`, `:338`), narrower than the spec — justified by "no known sequences need more."
- **`NON_ASCII_PRINTABLE` folding** means the table can't distinguish unicode codepoints; actual codepoint handling happens in the PRINT handler, not the state machine.
- **Combined/extended data in sparse maps** must be copied on `clone`/`copyFrom`/`resize` keyed on the flag bit, and trimmed when shrinking a line (`:405`). Forgetting this leaks stale glyphs.
- **`loadCell` must clone `extended`** when not present (`:218`) to avoid aliasing the shared `$workCell`'s extended attrs into a line during insert/delete.
- **Resize avoids realloc** when the underlying `ArrayBuffer` still fits — it just re-views/subarrays (`:388`); a separate `cleanupMemory` reclaims after big shrinks (2× threshold).
- **Input latency hack:** first write after user keystroke parses synchronously instead of waiting for the next macrotask (`WriteBuffer.ts:167`).
- **String cache via WeakRef + generation counter** (`BufferLine.ts:584`): `translateToString` caches only canonical full-line requests; invalidated lazily by bumping a generation, GC'd via `WeakRef`.
- **WebGL context-loss handling** and a `DISCARD_WATERMARK` (~50MB) that throws to force flow control rather than crash the tab.

## Relevance
- **ansi-escapes / pty-emulation:** definitive table-driven CSI/OSC/DCS/APC parser, resumable async handlers, the canonical reference implementation.
- **rendering-pipeline:** model-diffing, GPU glyph atlas + instanced quads, double-buffered vertex data, DOM run-coalescing, three renderer strategies to compare.
- **unicode-text-width:** wcwidth, wide/combining cells, UAX#29 grapheme clustering with state threaded across chunks.
- **input-keyboard-mouse:** kitty CSI-u protocol, legacy xterm modifier encoding, win32 input mode.
- **terminal-images:** sixel/IIP/kitty graphics decoded async and pinned to buffer cells via extended attributes.
- **widgets-rich-content:** bit-packed attribute model (truecolor, styled underlines, ligatures/joiners) worth copying for any rich text grid.
- **app-architecture:** back-pressure write buffer, time-sliced parsing, service-based DI, addon plugin model.
