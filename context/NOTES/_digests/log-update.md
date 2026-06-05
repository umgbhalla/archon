# log-update

## What it is (1-2 lines)
A tiny single-file library (`sindresorhus/log-update` v8) that overwrites the previous multi-line terminal output in place — the core primitive behind progress bars, spinners, and animations. v8 is notably richer than older versions: it adds line-level frame diffing, synchronized-output, terminal-height clipping, and a `persist()` scrollback escape hatch.

## Architecture (how the pieces fit; key files with paths)
- `index.js` (~320 lines) — the entire implementation. Everything below lives here.
- `index.d.ts` — types: `createLogUpdate(stream, options)` returns a callable `render` function augmented with `.clear()`, `.done()`, `.persist()`.
- Default exports: `logUpdate` (bound to `process.stdout`) and `logUpdateStderr` (`process.stderr`), both built via `createLogUpdate`.
- Dependencies do the text-measurement heavy lifting:
  - `ansi-escapes` — cursor moves, `eraseLine`, `eraseLines`, `eraseEndLine`.
  - `wrap-ansi` — hard-wrap text to terminal width while preserving ANSI styles.
  - `slice-ansi` — slice a styled string by visible column count (used for height clipping).
  - `string-width` — visible width of a line (handles wide/zero-width chars).
  - `strip-ansi` — strip styles to count true lines / measure plain width.
  - `cli-cursor` — hide/show the cursor.

The data flow per call: `render(args)` → `computeFrame()` (normalize + wrap + height-clip) → choose a render strategy (no-op / first-write / full-erase / diff-patch) → `write()` (optionally wrapped in synchronized-output markers) → persist `previousOutput` / `previousWidth` / `previousLineCount` as state for the next call.

## Core techniques (the actual TUI engineering)

### 1. Frame normalization and wrapping (`computeFrame`, index.js:186-196)
- Coerces input to string, **guarantees a trailing newline** (`index.js:189`). This is the key invariant: the cursor always ends up parked on a trailing blank line below the content, which makes the next erase/redraw math uniform.
- Wraps with `wrapAnsi(raw, width, {trim: false, hard: true, wordWrap: false})` — hard char-wrap (no word boundaries, no trimming) so the rendered frame matches exactly what the terminal will show at `width` columns.
- An empty frame is represented as `lines.length === 0` (the `rows === 0` clip case), distinct from a one-blank-line frame.

### 2. Terminal-height clipping (`fitToTerminalHeight`, index.js:18-61)
The clever/hard part. Goal: when the frame is taller than `stream.rows`, drop lines from the **top** so the bottom stays visible — but the frame is a styled string, and you must cut without breaking ANSI sequences. Approach:
- Compute how many lines to remove: `lines.length - terminalHeight`.
- Estimate a visible-column cut point by summing `stringWidth(line) + 1` per removed line. The `+1` is the subtle bit: `sliceAnsi` counts each `\n` as 1 column, but `stringWidth('\n')` returns 0, so you must add 1 per newline to keep the two width models aligned (`index.js:33-38`, called out in the comment).
- `sliceAnsi(wrappedText, cut)` slices off the top while keeping styles intact.
- Then **bidirectional normalization loops** (`index.js:44-58`) nudge `cut` up or down one column at a time until the resulting frame height exactly equals `terminalHeight` — correcting for any drift between the estimated cut and sliceAnsi's actual column accounting.
- `rows === 0` → emit nothing but record `wasClipped` so the caller still erases prior output (`index.js:21-24`).

### 3. Line-level frame diffing (`diffFrames`, index.js:66-82)
Classic common-prefix / common-suffix diff over arrays of lines:
- Scan from the top while `previousLines[i] === nextLines[i]` → `start` (shared prefix length).
- Scan from the bottom while lines match (and indices stay `>= start`) → `endPrevious` / `endNext` (last changed line in each frame).
- Result is the minimal contiguous changed block `[start, endPrevious]` (old) → `[start, endNext]` (new). Anything outside that block is untouched on screen — only the changed middle is rewritten. This is the optimization that makes a 1-line change in a 30-line frame cheap.

### 4. Building the redraw patch (`buildPatch`, index.js:87-160)
Translates the diff into one concatenated escape sequence. Mental model: cursor starts on the trailing blank line (line `prevCount - 1`).
- Move cursor up/down by `start - (prevCount-1)` to land on the first changed line, then `cursorLeft` (`index.js:97-108`).
- **Clear the old changed block**: emit `eraseLine` + `cursorDown()` per old line in the block, then `cursorUp(linesToClear-1)` to return to the top of the block (`index.js:111-124`).
- **Write the new block**: join changed lines with `\n`, append `eraseEndLine` to wipe any trailing leftover chars on the final written line (`index.js:127-145`). A `shouldWriteTrailingNewline` guard re-adds a newline when the next frame ends with one but the chunk didn't (keeps the trailing-blank-line invariant intact).
- **Reposition** cursor back down to the final trailing blank line so the next `render` call starts from a known position (`index.js:147-157`).

### 5. Render strategy selection (`render`, index.js:204-288)
A decision cascade, fastest/cheapest first:
1. `lines.length === 0` → erase previous, write nothing (`index.js:213-222`).
2. **No-op**: `wrapped === previousOutput && previousWidth === width` → return immediately (`index.js:225`).
3. **First frame** (`previousLineCount === 0`) → plain `write(wrapped)` (`index.js:230`).
4. **Width changed OR content was clipped** → full `eraseLines(previousLineCount) + wrapped`. Diffing is invalid here because wrapping/clipping reflows everything (`index.js:240`).
5. If lines were inserted/removed, the suffix's screen row shifts, so the diff block is widened to the end of both frames (`index.js:254-257`).
6. **`start === 0`** (no shared prefix) → just full-erase; the patch wouldn't save anything (`index.js:265`).
7. Otherwise → `buildPatch(...)` and write the minimal patch (`index.js:274-283`).

### 6. Synchronized output (index.js:10-11, 166-179)
Wraps every TTY write in DEC private mode `[?2026h` … `[?2026l` (begin/end synchronized update). Terminals that support it buffer the whole frame and present it atomically, eliminating tearing/flicker during multi-line redraws. Only applied when `stream.isTTY === true`.

### 7. Lifecycle methods (index.js:290-309)
- `.clear()` → `eraseLines(previousLineCount)` + reset state.
- `.done()` → reset state and `cliCursor.show()`; lets a fresh log session start below.
- `.persist(...)` → erase the in-place region, then write the text **without** height-clipping (`clipToHeight=false`) and reset. This dumps permanent content into scrollback (like `console.log`) while keeping the live-update region working afterward.

## Code patterns worth stealing

Guarantee a trailing newline so the cursor always parks on a known blank line:
```js
const raw = text.endsWith('\n') ? text : `${text}\n`;
```

Common-prefix/suffix line diff (minimal changed block):
```js
let start = 0;
while (start < a.length && start < b.length && a[start] === b[start]) start++;
let ea = a.length - 1, eb = b.length - 1;
while (ea >= start && eb >= start && a[ea] === b[eb]) { ea--; eb--; }
// changed block: a[start..ea] -> b[start..eb]
```

Atomic frame presentation via synchronized output:
```js
const BEGIN = '[?2026h', END = '[?2026l';
if (isTTY) stream.write(BEGIN + frame + END); else stream.write(frame);
```

Slice a styled multi-line string by visible columns, accounting for the `\n`-vs-width mismatch:
```js
let cut = 0;
for (let i = 0; i < toRemove; i++) cut += stringWidth(lines[i]) + 1; // +1 per newline
let clipped = sliceAnsi(wrapped, cut);
// then nudge `cut` ±1 until getFrameHeight(clipped) === terminalHeight
```

`eraseEndLine` after writing a line to wipe stale trailing chars when the new line is shorter than the old one:
```js
sequence += chunk + ansiEscapes.eraseEndLine;
```

## Gotchas / non-obvious decisions
- **The trailing-newline invariant is load-bearing.** Almost all cursor math assumes the cursor rests on a blank line one below the content. `shouldWriteTrailingNewline` (index.js:131-134) exists purely to preserve it after a partial patch.
- **`stringWidth` returns 0 for `\n` but `sliceAnsi` counts it as 1 column** — the explicit `+1` in the height-clip cut (index.js:37) is the reconciliation. Forgetting this off-by-one per line is a classic styled-slice bug.
- **Diffing is abandoned whenever layout reflows** — width change or height clip forces a full erase+rewrite, because a single reflow invalidates the line-to-line correspondence the diff relies on.
- **`start === 0` short-circuits to full erase** even when a suffix matches: with no shared prefix the patch's cursor-positioning overhead isn't worth it.
- Line counting uses **`stripAnsi` before splitting** (`getFrameHeight`, index.js:13-16) so ANSI codes never inflate the line count; and empty string maps to height 0, not 1.
- Cursor is hidden lazily on every `render` (index.js:205-207) rather than once — cheap and robust against external code re-showing it.
- Non-TTY (piped/redirected) output skips synchronized markers and falls back to `defaultWidth`/`defaultHeight` (80×24) so it degrades gracefully.

## Relevance (which advanced-TUI topics this teaches)
- **rendering-pipeline**: the canonical in-place multi-line redraw loop — compute frame, diff against previous, emit minimal patch, atomic flush. The cleanest small example of a frame-buffer/double-buffer mental model without a full reconciler.
- **ansi-escapes**: precise cursor movement (up/down/left), `eraseLine` / `eraseLines` / `eraseEndLine`, cursor hide/show, and DEC synchronized-output mode (`?2026`).
- **unicode-text-width**: `string-width` for visible width, the `\n` width-model mismatch with `slice-ansi`, and ANSI-aware line counting via `strip-ansi`.
- **layout**: hard-wrapping to terminal columns and top-clipping to terminal rows while keeping styles intact — minimal but real terminal layout constraints.
- **app-architecture**: factory (`createLogUpdate`) closing over per-stream state, with a callable+method API and a `persist()` escape hatch separating ephemeral live UI from permanent scrollback.
