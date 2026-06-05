# node-sixel

## What it is (1-2 lines)
A SIXEL image codec for terminals (node + browser): a WASM-based streaming decoder and a pure-TS band encoder, plus palette quantization. SIXEL is the DEC escape-sequence protocol that lets terminals render raster bitmaps inline.

## Architecture (how the pieces fit; key files with paths)
- `src/index.ts` - public surface: `Decoder`/`DecoderAsync`/`decode`/`decodeAsync` (decode side), `sixelEncode`/`image2sixel`/`introducer`/`FINALIZER` (encode side), color/palette helpers.
- `src/Decoder.ts` - JS wrapper around the WASM decoder. Owns the JS-side pixel canvas, band assembly, mode/size bookkeeping. The hot inner loop is NOT here.
- `wasm/decoder.cpp` - the actual decoder. A flat C struct of static state + three state-machine decode functions (`decode_raster`, `decode_m1`, `decode_m2`). Compiled to WASM via `wasm/build.sh` (emscripten), then base64-inlined into `src/wasm.ts` by `bin/wrap_wasm.js`.
- `src/SixelEncoder.ts` - pure-TS encoder. Processes the image in 6px-tall bands, emits per-color SIXEL run-length strings.
- `src/Quantizer.ts` - palette reduction (kd-tree via UPNG) + a 16³-box nearest-color matcher + cheap dithering.
- `src/Colors.ts` - RGBA8888 packing (ABGR32 in memory on LE), RGB/HLS normalization, VT340 + ANSI-256 palettes, euclidean nearest-color.
- `src/Types.ts` - the WASM export interface (`IWasmDecoderExports`) and `ParseMode` enum that mirror the C struct layout.

The JS<->WASM contract is the load-bearing seam: JS reads the C `ps` struct directly via typed-array views over `wasm.memory.buffer`, indexed by hardcoded offsets.

## Core techniques (the actual engineering)

### SIXEL format primer (needed to read the code)
Each printable char `?`..`~` (0x3F..0x7E) encodes a vertical strip of 6 pixels: `code = char - 63`, bit N set = pixel N of the 6px column is "on". Bands are 6px tall. `$` = carriage return (back to band start), `-` = newline (advance one band), `#n` = select color register n, `#n;2;r;g;b` = define register as RGB%, `!count` = RLE repeat next sixel. `"Pan;Pad;Ph;Pv` = raster attributes (aspect + width/height).

### WASM decoder: 6 parallel row buffers, not a 2D canvas
`wasm/decoder.cpp:64-71` holds six line buffers `p0..p5` (one per pixel-row within a band) of width `MAX_WIDTH+4`. A sixel column is "scattered" across the six buffers by `put_single` (decoder.cpp:100):
```c
ps.p0[(code >> 0 & 1) * cursor] = color;  // if bit 0 set, write at cursor; else write to slot 0 (throwaway)
...
ps.p5[(code >> 5 & 1) * cursor] = color;
```
The `(bit * cursor)` trick is branchless: if the bit is 0 the write lands on index 0 (a sacrificial cell) instead of the real cursor — no `if` per row. RLE `put` (decoder.cpp:112) is the same idea but loops `n` writes per active row. The 6 buffers are interleaved back into a real raster on the JS side in `_handle_band` (Decoder.ts:180).

### Three operating modes (the clever size/perf decision)
Decoder.ts:91-105 documents M0/M1/M2; implemented in `decode_raster` (decoder.cpp:425).
- **M0** undecided after init.
- **M1** level-1 (no raster attrs) or `truncate=false`. Width unknown up front, grows on the fly; bands can have different widths so the JS side stores `_bandWidths[]` and may re-align pixels at the end (Decoder.ts:410-432, the "worst case" path).
- **M2** level-2 + `truncate=true` (default). Raster attrs give width/height up front, so the canvas is allocated once and excess pixels are truncated. ~15-20% faster, height not rounded to multiples of 6, O(1) `data32`.

`decode_raster` peeks the stream: if it sees raster attrs before any sixel data → level 2; if it sees sixel/color/RLE/`-` first → level 1. It even recovers from malformed raster attrs (decoder.cpp:469) by falling back to M1. Mode choice dispatches through a function-pointer table `DECODERS[3]` (decoder.cpp:266) — no per-call branch.

### Streaming via fixed chunk buffer
JS never passes pointers; it copies up to `CHUNK_SIZE` bytes into the WASM-owned `ps.chunk` then calls `decode(0, length)` (Decoder.ts:334-341). `decodeString` does the same char-by-char (slow path, Decoder.ts:348). A sentinel `0xFF` is written at `c_end` (decoder.cpp:275) so the inner digit/sixel scan loops can run without bounds checks and naturally stop at the sentinel.

### Callback-driven band emission (WASM → JS)
WASM imports two JS functions: `handle_band(width)` (called on each `-`) and `mode_parsed(mode)` (called once the mode is decided, to size the canvas). The async path can't bind instance methods at instantiate time, so `CallbackProxy` (Decoder.ts:32) provides stable function identities whose handlers are swapped in after construction — a lazy-binding indirection to keep one shared WASM import object.

### Buffer clearing optimization
M1 clears lazily in 128px blocks via `clear_next` (decoder.cpp:200) only as the cursor advances; M2 clears exactly `ps.width` (decoder.cpp:233). Both use a "blueprint" trick: fill p0's first chunk with `fill_color`, then `memcpy` it into p1..p5. `fill_color` is stored as a doubled 64-bit value (decoder.cpp:506) so 8 bytes (two pixels) write per store.

### Encoder: per-color run-length within a band (SixelEncoder.ts:53)
`processBand` walks each of the 6px-tall band's columns. For every column it builds a 6-bit `code` per palette color seen (`code[slot] |= 1 << row`). It then run-length-collapses identical consecutive column-codes per color (`last`/`accu`/`code`/`slots` typed arrays). Output is grouped by color: `#idx` + RLE sixels + `$`. Background (slot 0) is skipped. `codeToSixel` (SixelEncoder.ts:41) emits `!count c` for runs >3, else literal repeats. New colors that appear mid-band "catch up" by back-filling a zero-run of length `i` (SixelEncoder.ts:104). `sixelEncodeIndexed` is the same but takes pre-indexed pixels and reuses scratch buffers across bands.

### Quantization (Quantizer.ts)
Palette built by UPNG's kd-tree (`reduce`, Quantizer.ts:37). Nearest-color is accelerated by `ColorMatcher`: precompute, for each of 4096 (16³) coarse RGB boxes, the palette indices within an inner sphere (radius 14) and an outer "uncertain" sphere (radius 42). At lookup time only check the small candidate list for the pixel's box, and only consult the outer list if the pixel is near a box edge (distance>192 from box center, Quantizer.ts:155). Dithering (Quantizer.ts:62) spreads quantization error to 4 neighbors with `>>2`/`>>1` shifts (cheap, not full Floyd–Steinberg; noted as imperfect on gradients).

### Color packing
RGBA8888 is actually ABGR32 in memory on little-endian (`toRGBA8888`, Colors.ts:39). Channel extraction is masking/shifts (Colors.ts:19-33). SIXEL color values are 0-100% → byte via integer rounding `(x*256 - x + 50)/100` in C (decoder.cpp:133) to avoid float. HLS hue is rotated +240° per VT340 (Colors.ts:127, decoder.cpp:156).

## Code patterns worth stealing
- **Branchless scatter write**: index a write by `(predicate * realIndex)` so the false case lands on a sacrificial slot 0 instead of branching (decoder.cpp:100).
- **Function-pointer dispatch tables** for state-machine modes / color converters instead of switch per byte (decoder.cpp:169,266).
- **Sentinel-terminated scan**: write a guard byte past the buffer end so tight inner loops drop bounds checks (decoder.cpp:275).
- **Struct-over-shared-memory ABI**: expose `get_*_address()` from WASM, build typed-array views once in the ctor, then read C state by fixed index (Decoder.ts:234-238; `_states[2]`, `_states[3]`, etc map to struct fields).
- **64-bit doubled fill value** + blueprint-then-memcpy to clear many parallel buffers fast (decoder.cpp:202-207).
- **Spatial bucketing for nearest-neighbor**: precompute candidate lists per coarse-grid cell with inner/outer spheres; only escalate to the outer list near cell boundaries (Quantizer.ts).
- **Per-color RLE band assembly** with lazy back-fill of zero-runs when a new color first appears mid-band (SixelEncoder.ts:104).
- **Block-growth realloc**: grow the canvas in fixed 65536-pixel blocks to bound reallocations (Decoder.ts:166).
- **Lazy callback rebinding** via a proxy object to keep one stable WASM import object across sync/async instantiation (Decoder.ts:32).

## Gotchas / non-obvious decisions
- LE-only: BE platforms warn and misbehave (Colors.ts:13). RGBA8888 is a lie — it's ABGR32 in memory.
- M2's truncation is intentionally not 100% spec-conformant (spec says decoders shouldn't truncate) but matches what conformant encoders produce, traded for speed and early sizing (Decoder.ts:93).
- `cursor` starts at 4, widths carry a `+4` offset everywhere (the `p*` buffers reserve 4 lead cells; slot 0 is the branchless-write sacrifice). `width = _states[2] - 4` (Decoder.ts:128).
- `data32` getter mutates state: it "peeks" the in-progress (not-yet-`-`-terminated) band into the canvas, and in M1's mixed-width worst case allocates a fresh aligned canvas every call (Decoder.ts:412). Repeated `data32` access mid-stream is not free.
- Decoder holds memory between images to cut GC; you must call `release()` after big images (Decoder.ts:459). `memoryLimit` (default 256MB) is an emergency abort, not a target.
- Convenience `decode()`/`decodeAsync()` spin up a fresh WASM instance per call (~25% slower than reusing a `Decoder`).
- `MAX_WIDTH` must be a multiple of 128 (clear logic is hardcoded to 128px blocks, build.sh).
- Color-register overflow wraps with modulo `paletteLimit` rather than erroring (decoder.cpp:172 `fastmod`).
- `decoder-simd.cpp` is an abandoned PoC with a fixed 1536×1536 canvas, not wired to the JS interface.
- Encoder `sixelEncodeIndexed` still has FIXMEs: no transparent-pixel handling, dithering ignores image borders.

## Relevance (which advanced-TUI topics this teaches)
- **terminal-images**: the canonical reference for SIXEL encode/decode, raster attributes, color registers, the introducer/finalizer DCS sequence, background-select semantics.
- **ansi-escapes**: DCS framing (`\x1bP...q ... \x1b\\`), parameter parsing state machines, byte-level escape handling.
- **rendering-pipeline**: streaming chunked decode, band-based incremental assembly, branchless pixel scatter, parallel-buffer clearing, block realloc — directly transferable to any high-throughput TUI raster pipeline and to WASM-in-JS perf architecture.
