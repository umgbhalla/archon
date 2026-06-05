# asciichart

## What it is (1-2 lines)
A dependency-free ~110-line JS function that renders one or more numeric series as an ASCII/Unicode line chart string for the terminal or browser console. The entire engine is a single pure function `plot(series, cfg)` in `asciichart.js`.

## Architecture (how the pieces fit; key files with paths)
- `asciichart.js` — the whole library. A UMD-style IIFE that binds to `exports` (CommonJS) or to a global `this['asciichart']` (browser). Lines 1-110.
  - Color constants: 18 ANSI SGR color escapes exported as named members (`asciichart.js:7-24`).
  - `colored(char, color)` helper (`asciichart.js:26-29`).
  - `plot(series, cfg)` — the renderer (`asciichart.js:33-108`).
- `test.js` — exercises basic plot, custom height/format/offset, min/max bounds, custom symbols, multi-series with colors. Good cfg-shape reference.
- `asciichartpy/__init__.py`, `pplot` (Python), `README.rst` — port + docs. JS is the canonical source.
- No render loop, no input handling, no diffing. It is a pure data-to-string transform; "updates" happen by the caller re-plotting and re-printing (the README streaming demo clears screen and re-prints).

## Core techniques (the actual engineering)
The whole trick: project a continuous value space onto a discrete character grid, then draw line segments with box-drawing glyphs chosen by local slope direction.

1. **Input normalization** (`asciichart.js:37-39`): accepts either `[n,n,...]` or `[[...],[...]]`. A single number array is wrapped into `[series]` so the rest of the code is uniformly multi-series.

2. **Range scan** (`asciichart.js:43-51`): min/max computed across all series (or taken from `cfg.min`/`cfg.max`). `range = |max - min|`.

3. **Vertical quantization via `ratio`** (`asciichart.js:57-62`): this is the key layout math.
   ```
   height = cfg.height ?? range
   ratio  = range !== 0 ? height / range : 1
   min2   = round(min * ratio)
   max2   = round(max * ratio)
   rows   = |max2 - min2|
   ```
   Every value `v` maps to a row via `round(v * ratio) - min2`. `ratio` compresses or stretches the real value range into the requested pixel/row height. When `range===0` (flat series) ratio falls back to 1 to avoid divide-by-zero.

4. **Width** (`asciichart.js:63-67`): `max series length + offset`. `offset` (default 3) reserves left columns for the y-axis labels and axis glyph. So chart width == data length; there is no horizontal interpolation/resampling — one column per data point.

5. **Grid allocation** (`asciichart.js:73-79`): a `(rows+1) x width` 2D array of single-space strings. This is the framebuffer. Note cells hold *strings*, not chars, so a cell can hold a multi-char label or an ANSI-wrapped glyph.

6. **Axis + labels pass** (`asciichart.js:80-84`): for each axis row `y` in `[min2..max2]`:
   - Label value = `max - (y-min2)*range/rows` (linear interpolation top→bottom). Formatted right-aligned by the default `format`.
   - Label string is written into the cell at `offset - label.length` (right-justified into the gutter).
   - Axis glyph at column `offset-1`: `symbols[0]` (`┼`) if this row corresponds to value 0, else `symbols[1]` (`┤`).

7. **Line-drawing pass** (`asciichart.js:86-106`): per series, per adjacent pair of points. Compute row of left point `y0` and right point `y1`. The glyph at column `x+offset` is chosen by slope:
   - `y0 == y1` → `─` (`symbols[4]`), flat segment.
   - rising/falling → draw a corner pair: an "elbow" at the new height and a matching elbow at the old height, plus vertical bars `│` (`symbols[9]`) filling the rows strictly between. The corner glyph depends on direction (`y0>y1` vs not): `symbols[5/6]` (`╰`/`╭`) at the y1 cell, `symbols[7/8]` (`╮`/`╯`) at the y0 cell.
   - First point gets `symbols[0]` (`┼`) at the axis to seat the line on the axis (`asciichart.js:88-89`).
   - Row index is flipped: `result[rows - y]` because array row 0 is the top of the screen but high values should be at top.

8. **ANSI color** (`asciichart.js:26-29, 87`): each series picks `colors[j % colors.length]`; glyphs are wrapped `color + char + reset`. Because the grid stores strings, color wrapping costs no grid-width accounting — the printed character is still one cell wide.

9. **Serialization** (`asciichart.js:107`): `result.map(row => row.join('')).join('\n')`. Pure string output; the caller does the I/O.

## Code patterns worth stealing
- **Value→row projection with a single ratio**, decoupling logical range from display height:
  ```js
  const ratio = range !== 0 ? height / range : 1
  const min2  = Math.round(min * ratio)
  const rowOf = v => Math.round(v * ratio) - min2   // 0..rows
  // flip for screen coords (row 0 = top):
  grid[rows - rowOf(v)][col] = glyph
  ```
- **Slope-aware glyph selection** for smooth line segments instead of plotting isolated dots:
  ```js
  if (y0 === y1)        draw('─')                       // flat
  else {
    draw_at(y1, y0>y1 ? '╰' : '╭')                      // new-height elbow
    draw_at(y0, y0>y1 ? '╮' : '╯')                      // old-height elbow
    for (let y = min(y0,y1)+1; y < max(y0,y1); y++)
      draw_at(y, '│')                                   // vertical fill
  }
  ```
- **String-cell framebuffer**: storing strings (not chars) in grid cells lets a single cell carry a right-aligned multi-char label or an ANSI-escaped glyph without breaking the join. Width is reserved structurally via `offset`, not by counting escape bytes.
- **Right-align via slice trick** for fixed-width numeric labels:
  ```js
  (padding + x.toFixed(2)).slice(-padding.length)   // pad-left to padding width
  ```
- **Config with `typeof x !== 'undefined' ? x : default`** everywhere — tolerant of `0`/falsy legitimate values (e.g. `min: 0`).
- **Injectable `symbols` array and `format` fn**: the renderer is fully reskinnable (the test swaps `┼` for `┣` to make a bracket-style axis).

## Gotchas / non-obvious decisions
- **No horizontal scaling**: chart width is exactly `data.length + offset`. To fit a terminal you must downsample/aggregate data yourself before calling `plot`. There is no x-axis resampling.
- **`offset` minimum is effectively 2** (axis glyph lives at `offset-1`, labels right-justified into `offset-length`). Labels longer than `offset` get clamped to column 0 via `Math.max(offset - label.length, 0)` and will overwrite/overflow.
- **Row flip (`rows - y`)** is easy to get backwards; high data values map to *low* array indices because index 0 prints first (top).
- **Quantization rounds to whole rows**, so two distinct values closer than one row collapse to a flat `─`. Increase `cfg.height` for vertical resolution.
- **`range === 0` guard**: a constant series would divide by zero in `height/range`; ratio defaults to 1 and you get a single flat line.
- **Color wrapping breaks naive width math** if you ever post-process the output — the cell contains `\x1b[..m─\x1b[0m`, many bytes for one visible column. This lib sidesteps it by reserving columns before coloring.
- **Multi-series overdraw**: later series in the loop overwrite earlier ones in shared cells; there is no z-ordering or blending, last-writer-wins per cell.
- Default y-axis label `format` always uses `toFixed(2)` and an 11-space pad; override for integer or wider ranges.

## Relevance (which advanced-TUI topics this teaches)
- **rendering-pipeline**: textbook example of the data → quantize → fill 2D buffer → serialize-to-string pipeline, minus any diffing.
- **layout**: mapping a continuous coordinate space onto a fixed discrete grid (`ratio`, `offset`, row flip), reserving a label gutter.
- **ansi-escapes**: SGR color constants and the reset-wrapping pattern; illustrates the visible-width-vs-byte-width problem.
- **unicode-text-width**: relies on box-drawing glyphs (`┼ ┤ ─ ╰ ╭ ╮ ╯ │`) each being one cell wide; a concrete case where char width assumptions matter.
- **widgets-rich-content**: a minimal, embeddable chart "widget" producing a string any TUI framework can blit into a region.
