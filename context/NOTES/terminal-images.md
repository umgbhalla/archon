# terminal-images

How to put real raster pixels into a text grid. Four protocols, four philosophies, one shared problem: a terminal has no native "image" concept, so every scheme smuggles a bitmap through the byte stream (an escape sequence) and then has to reconcile a pixel-addressed picture with a cell-addressed grid.

## TL;DR (the mental model in 3-5 bullets)

- **There are only ~4 ways to show pixels in a terminal, ranked by fidelity:** kitty graphics (best, PNG/raw + placement geometry), iTerm inline image / OSC 1337 (whole encoded file + cell sizing), SIXEL (DEC palette-bitmap escape sequence, oldest + most widely supported), and the **half-block fallback** (`▀` with fg=top-pixel, bg=bottom-pixel — works in *any* truecolor terminal, 1 char = 2 vertical pixels). You ship a cascade and feature-detect.
- **Every protocol is "escape framing + base64 payload + geometry params".** The decoder is a string state machine that pulls fields out of the framing, then hands a byte blob to an image codec. The framing differs (DCS `ESC P … ST` for sixel, OSC `ESC ] 1337 … ST/BEL` for iTerm, APC `ESC _ G … ST` for kitty); the codec differs (sixel = palette RLE you decode yourself; iTerm/kitty = PNG/JPEG/QOI/raw RGBA you hand to `createImageBitmap`).
- **SIXEL is the only one where the terminal/library does the pixel decode.** It encodes a 6-pixel-tall vertical strip per printable char (`code = char-63`, bit N = pixel N on), grouped into 6px **bands**, with **color registers** (`#n;2;r;g;b`, RGB in 0–100%) and **RLE** (`!count`). This forces a **palette quantization** step on the encode side (256 colors max, often 16). iTerm/kitty sidestep all that by shipping the original compressed file.
- **The cell/pixel impedance mismatch is the actual hard part, not decoding.** The image is pixels; the grid is cells. xterm.js solves it by **pinning decoded image data to buffer cells via extended attributes** (`imageId`/`tileId` riding on the cell's extended-attr slot) so the image scrolls, reflows, and gets overwritten with the text underneath it (`ImageStorage.ts:83`, `:283`).
- **Decode is slow and must be async without freezing the byte stream.** xterm.js's VT parser supports **resumable handlers that return a `Promise`**; image decode blocks the in-band stream cleanly while the UI stays responsive (the `unhook`/`end` returning `Promise<boolean>` pattern, e.g. `IIPHandler.ts:196`, `KittyGraphicsHandler.ts:217`).

## How it actually works (the mechanism, step by step)

### 0. The shared framing layer

All three "real" protocols are *string sequences* parsed by the VT state machine, differing only in their introducer/terminator and which sub-parser the bytes route to:

| Protocol | Introducer | Terminator | Parser class in xterm.js |
|---|---|---|---|
| SIXEL | `ESC P <p>;<bg>;<p> q` (DCS) | `ESC \` (ST) | `SixelHandler` (`IDcsHandler`) |
| iTerm IIP | `ESC ] 1337 ; File=…` (OSC) | `BEL` or `ESC \` | `IIPHandler` (`IOscHandler`) |
| kitty | `ESC _ G <control> ; <payload>` (APC) | `ESC \` (ST) | `KittyGraphicsHandler` (`IApcHandler`) |

The introducer strings are produced on the *emit* side by tiny string builders. `sixel/src/SixelEncoder.ts:26` literally returns `` `\x1bP0;${backgroundSelect};q` `` for `introducer()` and `'\x1b\\'` for `FINALIZER`. `ansi-escapes/base.js:147` builds the iTerm OSC. Note `ansi-escapes` always wraps OSC output through `wrapOsc` for tmux passthrough (doubling `ESC`, using `ESC \` as ST) — a real-world footgun for any image emitter running under a multiplexer.

A crucial cross-cutting detail in the IIP emitter: `size=<byteLength>` is **optional per spec but mandatory in practice** because xterm.js requires it (`ansi-escapes/base.js:164-165`), and the handler uses it as the transfer cap.

### 1. SIXEL — the only protocol where *you* decode the pixels

**Format primer (needed to read any of the code).** Each printable char `?`..`~` (0x3F–0x7E) encodes a vertical strip of 6 pixels: `code = char - 63`, bit N set = pixel N of the 6px column is "on" for the *currently selected color register*. Control chars within the DCS payload:
- `#n` select color register n; `#n;2;r;g;b` *define* register n as RGB in **0–100%** (`;2;` = RGB, `;1;` = HLS).
- `!count` RLE-repeat the next sixel char `count` times.
- `$` carriage return (back to band start, same band), `-` newline (advance one 6px band).
- `"Pan;Pad;Ph;Pv` raster attributes (aspect numerator/denominator + pixel width/height) — lets a decoder size its canvas up front.

**Decode (node-sixel WASM).** The hot loop lives in `wasm/decoder.cpp`, not JS. The clever bit is it does **not** keep a 2D canvas during a band; it keeps six parallel row buffers `p0..p5` and "scatters" a column across them branchlessly: `ps.p0[(code>>0 & 1) * cursor] = color; … ps.p5[(code>>5 & 1) * cursor] = color;` (decoder.cpp:100). If the bit is 0 the write lands on sacrificial index 0 instead of `cursor` — no per-row `if`. The six buffers are interleaved back into the real raster JS-side in `_handle_band` (`Decoder.ts:180`). It picks one of three modes (M0 undecided / M1 grow-on-the-fly / M2 raster-attrs-known-up-front, dispatched via a function-pointer table `DECODERS[3]`, decoder.cpp:266) — M2 is ~15–20% faster because the canvas is sized once. SIXEL color % → byte is done as integer `(x*256 - x + 50)/100` to avoid float (decoder.cpp:133). LE-only: `RGBA8888` is actually ABGR32 in memory (`Colors.ts:39`).

**Encode (node-sixel pure TS).** `sixelEncode` (`SixelEncoder.ts:168`) processes the image in 6px bands. `processBand` (`:53`) walks each column, and for each palette color seen builds a 6-bit `code` (`code[slot] |= 1 << row`, `:113`), then run-length-collapses identical consecutive column-codes per color using parallel scratch arrays `last/accu/code/slots`. Output is grouped *by color*: `#idx` + RLE sixels + `$` (`:140`). `codeToSixel` (`:41`) emits `!count c` only for runs > 3, else literal repeats. Background (slot 0, alpha 0) is skipped — that's how transparency works in SIXEL. A subtle trick: a color that first appears mid-band "catches up" by back-filling a zero-run of length `i` (`:104-107`).

**Quantization (the price of SIXEL).** Because SIXEL caps at 256 color registers (16 on a real VT340), arbitrary RGBA must be reduced. `Quantizer.ts:reduce` (`:37`) builds the palette with UPNG's kd-tree, then for each pixel does nearest-color matching + cheap dithering. The nearest-color matcher is the interesting engineering: `ColorMatcher` (`:85`) precomputes, for each of 4096 (16³) coarse RGB boxes, the palette indices inside an inner sphere (radius 14) and an outer "uncertain" sphere (radius 42). At lookup (`nearest`, `:136`) it bins the pixel into its box (`box = (r>>4)<<8 | (g>>4)<<4 | (b>>4)`), scans only the small inner candidate list, and **only consults the outer list when the pixel is near a box edge** (distance > 192 from box center, `:155`). Dithering (`:62-76`) spreads quantization error to 4 neighbors with `>>2`/`>>1` shifts — cheap, not full Floyd–Steinberg, and explicitly noted as imperfect on gradients (moiré/striping).

`image2sixel(data,w,h,maxColors,bgSelect)` (`SixelEncoder.ts:403`) is the one-call convenience: `reduce` → `sixelEncodeIndexed` → wrap with `introducer()`/`FINALIZER`.

### 2. iTerm inline image protocol (OSC 1337 File=)

The whole point: **ship the original encoded file, let the platform decode it.** Wire shape (from `ansi-escapes/base.js:147` + `IIPHeaderParser.ts`):

```
ESC ] 1337 ; File = inline=1 ; size=<bytes> ; width=<W> ; height=<H> ; preserveAspectRatio=<0|1> : <base64 payload> BEL
```

xterm.js's `IIPHeaderParser.parse` (`IIPHeaderParser.ts:167`) is a hand-rolled char state machine (`START→KEY→VALUE→END`) keyed on `;` `=` `:` codepoints. It recognizes the sequence type by matching marker byte arrays — `File`, `MultipartFile`, `FilePart`, `FileEnd`, `ReportCellSize` (`:107-115`) — so it also supports **chunked/multipart transfer** and a **cell-size query** the terminal answers with `OSC 1337;ReportCellSize=<h>;<w>;<scale> ST` (`IIPHandler.ts:121-132`). `width`/`height` values are flexible: `N` (cells), `Npx` (pixels), `N%` (percent of session), or `auto` — decoded/validated by `toSize` (`IIPHeaderParser.ts:74`) and resolved against cell metrics in `_dim`/`_resize` (`IIPHandler.ts:203-228`).

Decode path (`IIPHandler.put`/`end`): base64 is streamed into a **WASM base64 decoder** (`Base64Decoder.wasm`) as it arrives (`:74`), then `imageType` sniffs the magic bytes to get mime + intrinsic dimensions *without a full decode* — PNG/JPEG/GIF/QOI (`IIPMetrics.ts:21`; PNG reads IHDR at byte 16, JPEG walks SOF markers in `jpgSize`). QOI is decoded by another WASM module (`QoiDecoder.wasm`); everything else becomes a `Blob` handed to `createImageBitmap(blob, {resizeWidth, resizeHeight})` (`IIPHandler.ts:196`). That returns a Promise → the OSC handler returns the Promise → parser suspends. Pixel-limit and size-limit guards abort mid-stream (`:163`, `:70` in SixelHandler analog).

### 3. kitty graphics protocol (APC _G)

The richest protocol: image *transmission* is decoupled from *placement*, images are addressable by id, support z-index layering, cropping, scaling-to-cell, and chunked uploads. Wire shape: `ESC _ G <comma-separated control k=v> ; <base64 payload> ESC \`. Control keys are single letters parsed by `parseKittyCommand` (`KittyGraphicsTypes.ts:143`): `a` action (`t` transmit / `T` transmit+display / `q` query / `p` placement / `d` delete), `f` format (`24`=RGB, `32`=RGBA, `100`=PNG), `i` image id, `o` compression (`z`=zlib), `m` more-chunks-coming, `c`/`r` columns/rows to display over, `x/y/w/h` source crop rect, `z` z-index, `C` cursor-movement policy (`KittyGraphicsTypes.ts:37-82`).

`KittyGraphicsHandler.put` (`:122`) scans for the `;` that splits control data from payload, parses the command once for early validation (e.g. rejecting both `i` and `I`, `:152`), then streams the payload into the same WASM `Base64Decoder`. **Chunked uploads** are the gnarly part: `_pendingTransmissions` is a `Map<id, {decoder, totalEncodedSize, …}>`; subsequent chunks per spec may omit `i=`, so it falls back to `_lastPendingKey` (`:179`, `:240`). On the final chunk it decodes, optionally zlib-decompresses via `DecompressionStream` (`:775`), and for raw RGB it does a fast uint32-block RGB→RGBA interleave (3 reads / 4 writes per 4 pixels, `:749`). `_decodeAndDisplay` (`:552`) implements crop (`x/y/w/h`), scale-to-`c`×`r`-cells, sub-cell `X/Y` offset via an intermediate canvas, and z-index → `'top'`/`'bottom'` layer. The terminal replies on a control channel: `ESC _ G i=<id>;OK ESC \` (or `EINVAL:…`), suppressed by the `q` quiet level (`_sendResponse`, `:534`).

### 4. The half-block fallback (works everywhere)

Not in these repos as a dedicated module, but it's the universal floor and worth stating precisely. A truecolor terminal can render two vertical pixels per character cell using the upper-half block `▀` (U+2580): set the **foreground** color to the top pixel and the **background** color to the bottom pixel. So a cell at grid `(col,row)` shows source pixels `(col, 2*row)` and `(col, 2*row+1)`:

```
write: ESC[38;2;<rT>;<gT>;<bT>m ESC[48;2;<rB>;<gB>;<bB>m "▀"
```

Resolution is `cols × (2·rows)` pixels, no decode, no protocol negotiation — just SGR truecolor (the same `ESC[38;2;r;g;b`/`48;2` sequences the rest of the terminal stack already emits). It is the correct degrade target when feature detection finds neither kitty, iTerm, nor SIXEL.

### 5. Pinning pixels to the text grid (the part everyone forgets)

A decoded `ImageBitmap`/canvas isn't enough — it has to live *in the grid* so it scrolls and gets clobbered correctly. xterm.js's `ImageStorage.addImage` (`ImageStorage.ts:250`) computes `cols = ceil(img.width/cellW)`, `rows = ceil(img.height/cellH)`, then walks the buffer writing an `imageId` + per-tile `tileId = row*cols + col` into each covered cell's **extended attribute** (`_writeToCell`, called at `:283`). `ExtendedAttrsImage` (`:83`) extends the normal styled-underline extended-attr object with `imageId`/`tileId`, so an image tile rides on the exact same sparse side-channel xterm.js uses for true-color underlines — zero per-cell object overhead for plain text. The renderer (`ImageRenderer`) later walks visible rows, coalesces runs of consecutive same-image same-tile-sequence cells into single draw calls (`:426-493`), and composites the right sub-rectangle of the bitmap. Overwriting a cell with text wipes the extended attr → the image tile disappears under the text automatically.

## Cross-repo comparison

| Concern | node-sixel | xterm addon-image (sixel) | xterm addon-image (IIP) | xterm addon-image (kitty) | half-block |
|---|---|---|---|---|---|
| Who decodes pixels | self (WASM C decoder) | delegates to node-sixel `Decoder` (`SixelHandler.ts:12`) | platform `createImageBitmap` + magic-byte sniff | platform `createImageBitmap` / raw-RGBA / zlib | none |
| Color fidelity | ≤256 palette, quantized | same | full / lossless | full / lossless | full truecolor |
| Needs quantization | yes (`Quantizer.ts`) | yes | no | no | no |
| Geometry source | raster attrs `"Pan;Pad;Ph;Pv` | raster attrs | `width/height` keys + cell-size report | `c/r/s/v/x/y/w/h` keys | implicit (2px/cell) |
| Addressable / re-placeable | no | no | no | **yes** (id + placement) | no |
| Chunked transfer | streaming chunks (decode) | DCS_PUT chunks | `MultipartFile`/`FilePart`/`FileEnd` | `m=1` chunks + pending map | n/a |
| Async suspension | n/a (sync API) | `unhook` returns `Promise<boolean>` | `end` returns Promise | `end` returns Promise | n/a |

**Where they agree:** all of xterm's handlers share the same skeleton (`hook/start` → streaming `put` into a WASM decoder with a size cap → `unhook/end` returning an optionally-async boolean), and all reuse the same `Base64Decoder.wasm` and `ImageStorage` cell-pinning. node-sixel and xterm agree on the SIXEL byte semantics (xterm literally imports node-sixel's `Decoder`, `Colors`, palettes).

**Where they differ / which is better:**
- **node-sixel owns the hard codec work; xterm owns the integration.** If you want to *generate* SIXEL, node-sixel's `image2sixel` is the reference. If you want to *consume* any of the three protocols inside a live terminal, xterm's addon is the reference for framing + cell pinning + async flow control.
- **kitty is the technically best protocol** (lossless, addressable, layered, croppable) and should be preferred where supported; iTerm IIP is simpler and nearly as good for "just show this PNG"; SIXEL is the most broadly supported but lossy and CPU-heavy because of quantization. The pragmatic ranking is exactly the detection cascade.
- node-sixel's quantizer is a deliberate speed/quality compromise (boxed nearest-neighbor + 4-neighbor dithering); a from-scratch build wanting quality should swap in real Floyd–Steinberg + a better palette generator, which the code's own FIXMEs invite (`Quantizer.ts:35,68`).

## Pitfalls & hard parts

- **Endianness lie.** `RGBA8888` in node-sixel is ABGR32 in memory on little-endian (`Colors.ts:13,39`); BE platforms misbehave. xterm has to `convertLe` color-manager values (BE) before feeding node-sixel (`SixelHandler.ts:148`).
- **SIXEL bands round height to multiples of 6** unless M2/truncate is used; the encoder pads the last band (`SixelEncoder.ts:227` passes a short `bandHeight`). Off-by-band errors smear or clip the bottom.
- **Transparency only respects alpha == 0** (`SixelEncoder.ts:154`); any other alpha is forced opaque. `sixelEncodeIndexed` still has a FIXME for transparent pixels (`:267`).
- **`data32` on the decoder mutates state** (peeks the in-progress band into the canvas; in M1 mixed-width worst case it reallocates an aligned canvas every call, `Decoder.ts:412`). Reading it repeatedly mid-stream is not free.
- **Memory.** Decoders hold buffers between images to dodge GC; you must `release()` after large images (node-sixel `Decoder.release`, and xterm frees over `MEM_PERMA_LIMIT = 4MB`, `SixelHandler.ts:103`). Kitty stores decoded data **off-heap as a `Blob`** to dodge the 2GB JS heap cap (`KittyGraphicsTypes.ts:135`).
- **Color register overflow wraps modulo paletteLimit** rather than erroring (decoder.cpp `fastmod`) — silently corrupts colors past the limit.
- **Async handler resumption is fragile.** The parser saves a stack and replays; improper resumption throws hard rather than corrupting state. Returning a Promise from an image handler is what keeps the byte stream from freezing the UI — but it means image decode is *in-band* and back-pressures everything behind it.
- **tmux/screen passthrough.** OSC/DCS/APC image sequences must be wrapped (`ESC P tmux; … ESC \`, every inner `ESC` doubled) under a multiplexer or they leak as visible garbage (`ansi-escapes` `wrapOsc`).
- **Cell-size discovery is a moving target.** IIP `width/height` in cells/percent needs the live cell pixel size, which depends on DPR and font; xterm answers `ReportCellSize` with `dpr` scale (`IIPHandler.ts:129`). Guessing cell size wrong distorts aspect ratio.
- **kitty chunking edge case:** non-first chunks may omit `i=`; you must track `_lastPendingKey` or you lose the upload (`KittyGraphicsHandler.ts:179,240,68`).

## If you were building this from scratch (recommended approach + minimal pseudocode)

**Architecture:** one capability-detected `display(image, x, y, opts)` that dispatches to the best available protocol, plus a SIXEL encoder for the SIXEL path. Detect once at startup (query kitty with `ESC_Gi=1,a=q;…ESC\` and read the reply; check `$TERM`/`$TERM_PROGRAM` for iTerm; probe SIXEL via DA1 / `ESC[c`). Always have the half-block path as the floor.

```
function display(rgba, w, h, cols, rows):
  switch detectedProtocol:
    case KITTY:    return kittyTransmitDisplay(rgba, w, h, cols, rows)
    case ITERM:    return osc1337(pngEncode(rgba, w, h), cols, rows)
    case SIXEL:    return image2sixel(rgba, w, h, maxColors=256)
    default:       return halfBlock(rgba, w, h, cols, rows)

# kitty: control data + base64, chunked at ~4096B
function kittyTransmitDisplay(rgba, w, h, cols, rows):
  b64 = base64(rgba)
  out = ""
  for chunk, isLast in split(b64, 4096):
    ctrl = firstChunk ? f"a=T,f=32,s={w},v={h},c={cols},r={rows}," : ""
    out += f"\x1b_G{ctrl}m={isLast?0:1};{chunk}\x1b\\"
  return out

# half-block floor: 2 vertical px per cell, fg=top bg=bottom
function halfBlock(rgba, w, h, cols, rows):
  for ry in 0..rows-1:
    for cx in 0..cols-1:
      (rt,gt,bt) = sample(rgba, cx, 2*ry)
      (rb,gb,bb) = sample(rgba, cx, 2*ry+1)
      emit(f"\x1b[38;2;{rt};{gt};{bt}m\x1b[48;2;{rb};{gb};{bb}m▀")
    emit("\x1b[0m\n")

# sixel encode (per node-sixel): quantize → band RLE
function image2sixel(rgba, w, h, maxColors):
  {indices, palette} = quantize(rgba, w, maxColors)   # kd-tree + boxed nearest + dither
  s = introducer(bgSelect=0)                           # \x1bP0;0;q
  s += rasterAttrs(w, h)                                # "1;1;w;h
  s += definePalette(palette)                           # #i;2;r%;g%;b%
  for band in bandsOf6(indices, w, h):
    for color in colorsInBand(band):
      s += "#" + color.idx
      for run in rle(band.column6bitCodes(color)):     # !count or literal repeat
        s += run
      s += "$"                                          # CR within band
    s += "-"                                            # next band
  return s + "\x1b\\"                                    # FINALIZER
```

**Key decisions to copy from the repos:**
1. Stream base64 into a decoder with a hard byte cap; abort + release on overflow (xterm handlers).
2. Sniff image type from magic bytes to size before decode (`IIPMetrics.imageType`).
3. Pin decoded images to cells via an extended-attribute side-channel so they scroll/clip with text (`ImageStorage`).
4. Make decode handlers async (return Promise) so a slow decode doesn't freeze the input stream (xterm resumable parser).
5. For SIXEL, do boxed-spatial nearest-neighbor quantization, not naive O(palette) per pixel (`ColorMatcher`).
6. Route all OSC/DCS/APC through a single tmux-passthrough wrapper (`ansi-escapes wrapOsc`).

## Source map

**SIXEL codec (the reference):** `context/node-sixel/`
- `src/SixelEncoder.ts` — `introducer`/`FINALIZER` (:26,:35), `processBand` (:53), `sixelEncode` (:168), `sixelEncodeIndexed` (:316), `image2sixel` (:403), `codeToSixel` (:41).
- `src/Quantizer.ts` — `reduce` (:37), dithering (:62), `ColorMatcher` boxed nearest-neighbor (:85, `nearest` :136, edge escalation :155).
- `src/Colors.ts` — RGBA8888/ABGR32 packing (:39), endianness guard (:13), palettes.
- `wasm/decoder.cpp` — branchless scatter `put_single` (:100), mode dispatch `DECODERS` (:266), `%`→byte (:133).
- `src/Decoder.ts` — JS↔WASM seam, `_handle_band` (:180), `data32` peek (:412), `release` (:459).

**Protocol integration in a real terminal:** `context/xterm/addons/addon-image/src/`
- `SixelHandler.ts` — DCS handler, `hook`/`put`/`unhook` (:54,:65,:85), bg-color extraction (:118), `convertLe` (:148).
- `IIPHandler.ts` — OSC 1337, header parse + chunked/multipart + cell-size report (:70,:121), resize logic (:203), async `end` (:196).
- `IIPHeaderParser.ts` — the `File=…` field state machine (:167), sequence markers (:107-115), value decoders (:95).
- `IIPMetrics.ts` — magic-byte sniffing PNG/JPEG/GIF/QOI (:21), `jpgSize` SOF walk (:59).
- `kitty/KittyGraphicsHandler.ts` — APC handler, chunking + pending map (:122,:179,:217), crop/scale/offset/z-index display (:552), RGB→RGBA fast path (:749), responses (:534).
- `kitty/KittyGraphicsTypes.ts` — control-key enums + `parseKittyCommand` (:37,:143), off-heap Blob storage (:135).
- `ImageStorage.ts` — cell pinning via `ExtendedAttrsImage` (:83), `addImage` tile layout (:250,:283), draw-call coalescing (:426).

**Emit-side sequence builders:** `context/ansi-escapes/`
- `base.js` — `image()` OSC 1337 builder (:147), `wrapOsc` tmux passthrough (:10-27), `size=` xterm quirk (:164).

**Note:** opentui does *not* implement terminal images (no sixel/kitty/iip renderable; only kitty *keyboard* parsing). For pixels in a terminal the canonical sources are node-sixel (codec) and xterm's addon-image (protocol + integration).
