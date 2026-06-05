# clack

## What it is (1-2 lines)
A two-package toolkit for interactive CLI prompts: `@clack/core` is a headless, unstyled prompt engine (state machine + line-mode renderer + input handling); `@clack/prompts` is the opinionated styling/component layer (text, select, spinner, notes, etc.) built on top of core. This digest covers the line-mode rendering/diffing core, state model, and how the styled layer plugs in.

## Architecture (how the pieces fit; key files with paths)
- **`packages/core/src/prompts/prompt.ts`** — the base `Prompt<TValue>` class. Owns: readline interface, raw-mode input, the typed event emitter, the render+diff loop, validation, lifecycle. Every prompt type subclasses it. This is the whole engine.
- **`packages/core/src/types.ts`** — `ClackState = 'initial' | 'active' | 'cancel' | 'submit' | 'error'` and the typed `ClackEvents` map (cursor/key/value/userInput/confirm/finalize/...).
- **`packages/core/src/prompts/{text,select,multi-select,multi-line,confirm,date,password,autocomplete,select-key,group-multiselect}.ts`** — thin subclasses. They hold prompt-specific state (e.g. `cursor` index for select, caret position for text) and subscribe to events; they do NOT render. Rendering is injected.
- **`packages/core/src/utils/string.ts`** — `diffLines(a, b)`, the line diff primitive.
- **`packages/core/src/utils/index.ts`** — `setRawMode`, `block` (modal input blocker for spinner), `getColumns`/`getRows`, `wrapTextWithPrefix`, `isCancel`, `CANCEL_SYMBOL`.
- **`packages/core/src/utils/cursor.ts`** — `findCursor` (list nav skipping disabled options, with wraparound) and `findTextCursor` (2D caret movement over a `\n`-joined string).
- **`packages/core/src/utils/settings.ts`** — global mutable `settings`: action set, key aliases (vim `j/k/h/l`, ctrl-c, escape→cancel), localized messages. `isActionKey` resolves a raw key/sequence to a semantic `Action`.
- **`packages/prompts/src/*.ts`** — styled components. Each is a factory that instantiates a core prompt and passes a `render()` closure that returns the full frame string. `common.ts` holds all the box-drawing/unicode glyphs with ASCII fallbacks and the `symbol(state)` color mapper. `limit-options.ts` is the scrolling-viewport algorithm. `spinner.ts` is a separate animation loop that bypasses the diff engine.

The key seam: **core never styles, the prompts layer never re-implements the loop.** `render` is a function passed into `PromptOptions`, bound as `this._render`, and called by core's private `render()` every keystroke/resize.

## Core techniques

### Full-frame render + line diff (the central trick)
`prompt.ts` does not track widgets or a virtual DOM. Each tick it asks the subclass for a complete string frame, then reconciles it against the previous frame line-by-line.

`render()` (prompt.ts:284):
1. `wrapAnsi(this._render(this), columns, { hard: true, trim: false })` — wrap to terminal width, hard-breaking long lines, preserving whitespace. Wrapping is ANSI-aware so color codes don't count toward width.
2. `if (frame === this._prevFrame) return;` — cheapest possible no-op guard.
3. On `initial` state: just hide cursor and print the frame once.
4. Otherwise: `diffLines(prevFrame, frame)` to find changed line indices, move the cursor back to the top of the previously-drawn block (`restoreCursor`), and surgically redraw.

`diffLines` (string.ts:1) is deliberately naive: split both frames on `\n`, compare index-by-index, return `{ lines: number[], numLinesBefore, numLinesAfter, numLines }`. No LCS, no move detection — just "which line numbers differ."

### Surgical redraw based on diff cardinality (prompt.ts:297-336)
- **Exactly one changed line** (`diff.lines.length === 1`): move cursor down to that line, `erase.lines(1)`, write only the new line content, then move the cursor back down to the bottom. This is the fast path for typing a character into a single-line text prompt — one line rewritten, zero flicker.
- **Multiple changed lines**: move to the first changed line, `erase.down()` (clears everything below), and rewrite the entire tail (`frame.split('\n').slice(diffLine)`). Cheaper than full clear when only the bottom of a tall prompt changed.
- **No usable diff** (everything scrolled off): fall through to `erase.down()` + full frame write.

### Scroll-aware cursor math (prompt.ts:296-325)
The hard part: when the prompt is taller than the terminal, the top lines have scrolled off-screen and the cursor can't be moved to them. The code computes `diffOffsetBefore = max(0, numLinesBefore - rows)` and `diffOffsetAfter = max(0, numLinesAfter - rows)` — how many leading lines are off-screen in the old vs. new frame — and only acts on diff lines `>= diffOffsetAfter`. Cursor moves are adjusted by `diffLine - diffOffsetBefore` so vertical motion is relative to what's actually visible. If the only changes are above the fold, it skips drawing entirely and just stores the new frame.

`restoreCursor()` (prompt.ts:277): recomputes how many wrapped lines the *previous* frame occupied (`wrapAnsi(...).split('\n').length - 1`) and does `cursor.move(-999, -lines)` — column to far-left, up by that many rows. `-999` is the idiom for "go to column 0 regardless of width."

### State machine driving render
`state: ClackState` is the single source of truth for appearance. Transitions happen in `onKeypress` (prompt.ts:212):
- `error` state auto-recovers to `active` on the next keypress (line 221).
- `return` + `_shouldSubmit()` runs validation; failure sets `error` and re-injects `userInput` into readline; success sets `submit`.
- `isActionKey([...], 'cancel')` sets `cancel`.
- On `submit`/`cancel`: emit `finalize`, `render()` one last time (so the final styled frame paints), then `close()`.
`prompt()` resolves the promise via `once('submit'|'cancel')` handlers that restore the cursor, detach the resize listener, and disable raw mode.

### Input: readline as a line buffer, keypress for semantics (prompt.ts:151-264)
Clack runs readline in `terminal: true` raw mode but uses it for two distinct jobs:
- **Text editing**: for trackable prompts (`_track`), readline maintains the actual line buffer and caret. `onKeypress` reads `this.rl.line` and `this.rl.cursor` back into `this.userInput`/`this._cursor`. Backspace/word-delete are delegated to readline by *writing control codes back into it* (e.g. `this.rl.write(null, { ctrl: true, name: 'h' })` for backspace, `'u'` to clear the line). Clever: it reuses readline's editing logic instead of reimplementing it.
- **Semantic actions**: every keypress is mapped through `settings.aliases`/`settings.actions` and emitted as a `cursor` event with an `Action`, plus a raw `key` event. Non-text prompts (select, `_track=false`) navigate purely off `cursor` events.
- `y`/`n` always emit a `confirm` event (so confirm prompts work without enter).
- `escapeCodeTimeout: 50` disambiguates ESC-as-cancel from ESC-as-escape-sequence prefix.

### Caret rendering as inline string styling (text.ts core)
There is no real terminal cursor positioning for the caret. `userInputWithCursor` (core/text.ts:10, multi-line.ts:20) renders the caret by splitting the string at `this.cursor`: if at end, append a `█` block; otherwise wrap the character under the caret in `styleText('inverse', ...)`. The real terminal cursor is hidden (`cursor.hide`) the whole time. This sidesteps all cursor-position bookkeeping across wrapped/multi-line frames.

### 2D caret over a flat string (cursor.ts:20 `findTextCursor`)
For multi-line editing, the caret is a single integer offset into a `\n`-joined string. `findTextCursor(cursor, dx, dy, value)` converts offset→(x,y) by walking lines, applies the delta with clamping and line-wrap carry (moving left past column 0 wraps to the end of the previous line, etc.), then converts back to a flat offset. Keeps the model one-dimensional while supporting arrow-key navigation.

### Scrolling viewport with sliding window + ellipses (limit-options.ts)
`limitOptions` is the algorithm for long select lists that don't fit. Highlights worth stealing:
- Available rows = `getRows(output) - rowPadding`, clamped to min 5 (`computedMaxItems`).
- Sliding window only starts scrolling once the cursor is within 3 of the bottom (`cursor >= computedMaxItems - 3`), keeping the active item visible with lookahead.
- Top/bottom `...` ellipses are conditionally rendered and *count as a line*, so the window math accounts for them.
- Because each option can wrap to multiple lines, it works in **line groups** (one group = the wrapped lines of one option) and trims whole groups from the preceding/following side (`trimLines`) until the line count fits — never splitting an option mid-render. The trim direction is biased to preserve the cursor's group.

### Spinner: a separate animation loop outside the diff engine (spinner.ts)
The spinner does NOT use the Prompt class. It runs its own `setInterval(delay)` that:
- `clearPrevMessage()` (spinner.ts:104): wraps the previous message to know its line count, moves `cursor.up(prevLines-1)`, `cursor.to(0)`, `erase.down()` — a manual mini-diff for a single message line.
- Cycles frames (`['◒','◐','◓','◑']` unicode / `['•','o','O','0']` fallback), optional timer or animated trailing dots.
- Uses `block()` (utils/index.ts:34) to swallow user input while active — a readline interface whose keypress handler erases any typed char and intercepts ctrl-c to exit cleanly.
- Registers `uncaughtException`/`unhandledRejection`/`SIGINT`/`SIGTERM`/`exit` hooks so a crash still stops the spinner and prints an error/cancel glyph instead of leaving a frozen spinner. CI mode degrades to plain newline-appended logging.

### Unicode width / capability handling
- `is-unicode-supported` gates every glyph via `unicodeOr(fancy, ascii)` in common.ts, so the entire UI has an ASCII fallback (e.g. `│`→`|`, `◆`→`*`, `[•]` checkboxes).
- `fast-wrap-ansi` (not the core's own code) handles ANSI-aware width measurement and hard wrapping — clack delegates the unicode-width hard problem to it rather than computing grapheme widths itself.

## Code patterns worth stealing

Full-frame render with memoized no-op:
```ts
const frame = wrapAnsi(this._render(this) ?? '', columns, { hard: true, trim: false });
if (frame === this._prevFrame) return;          // skip if nothing changed
const diff = diffLines(this._prevFrame, frame);  // [] of changed line indices
```

Single-line fast path (the flicker-free typing case):
```ts
if (diff.lines.length === 1) {
  this.output.write(cursor.move(0, diffLine - diffOffsetBefore));
  this.output.write(erase.lines(1));
  this.output.write(frame.split('\n')[diffLine]);   // rewrite just this line
  this.output.write(cursor.move(0, lines.length - diffLine - 1)); // park cursor at bottom
}
```

Reuse readline's editing by feeding it control codes:
```ts
// backspace: send ctrl-h INTO readline so it edits its own buffer
this.rl?.write(null, { ctrl: true, name: 'h' });
// clear line: ctrl-u
this.rl?.write(null, { ctrl: true, name: 'u' });
this._setUserInput(this.rl?.line);   // read the edited buffer back out
```

Caret without terminal cursor positioning:
```ts
if (this.cursor >= input.length) return `${input}█`;
const before = input.slice(0, this.cursor);
const [under, ...rest] = input.slice(this.cursor);
return `${before}${styleText('inverse', under)}${rest.join('')}`;
```

Inject styling via a render closure (the core/prompts seam):
```ts
return new TextPrompt({
  validate, placeholder, defaultValue,
  render() {                       // `this` is the prompt instance
    switch (this.state) {
      case 'error':  return `${title}\n${yellowBar}${this.userInputWithCursor}\n...`;
      case 'submit': return `${title}${dim(this.value)}`;
      default:       return `${title}${cyanBar}${userInput}\n${barEnd}\n`;
    }
  },
}).prompt();
```

Disabled-aware list nav with wraparound (cursor.ts):
```ts
const clamped = newCursor < 0 ? maxCursor : newCursor > maxCursor ? 0 : newCursor;
if (options[clamped].disabled) return findCursor(clamped, delta < 0 ? -1 : 1, options); // skip & keep direction
```

## Gotchas / non-obvious decisions
- **No virtual DOM / no per-widget reconciliation.** The "reconciler" is line-index string diffing on full frames. Simple and robust, but every render rebuilds the entire frame string; fine because frames are tiny.
- **The diff only knows changed line *indices*, not insert/delete/move.** It compensates with the cardinality branches (1 line vs many) rather than computing a true edit script. A line inserted in the middle marks every subsequent line as "changed," triggering the rerender-the-tail path.
- **Off-screen scroll handling is the genuinely subtle part** — `diffOffsetBefore/After` and the `>= diffOffsetAfter` filter exist solely so cursor moves never target lines that scrolled past the top. Easy to get wrong; this is where most TUI line-mode renderers break.
- **The real cursor is hidden the entire time**; the visible caret is a styled character in the frame. Means no need to ever compute the cursor's screen coordinates.
- **The spinner deliberately does not erase the leading `S_BAR`** (noted TODO at spinner.ts:199) — `clear()` leaves a dangling bar.
- **`getRows`/`getColumns` fall back to 20/80** when not a TTY, so rendering still produces sane output when piped.
- **Settings are global mutable singletons** (`settings`), and `updateSettings` only *adds* key aliases, never overwrites — intentional so user config can't clobber built-in vim/ctrl-c bindings.
- **Two input paradigms coexist**: trackable prompts let readline own the buffer; non-trackable prompts (`super(opts, false)`) ignore the buffer and run purely on `cursor`/`key` events. Confirm/select pass `false`.
- **`-999` column move** is the portable "go to column 0" idiom used in `restoreCursor`.

## Relevance (which advanced-TUI topics this teaches)
- **rendering-pipeline** — full-frame generation, ANSI-aware wrap, memoized skip, then write. Canonical line-mode (not alternate-screen) pipeline.
- **reconciler-component-models** — a minimal, no-VDOM reconciler: line-index diffing + cardinality-based redraw. Good contrast to Ink/React-style reconcilers.
- **input-keyboard-mouse** — readline-as-buffer + keypress-as-semantic-action duality, control-code injection, key alias/action mapping, modal input blocking (`block`).
- **ansi-escapes** — cursor move/hide/show, `erase.lines`/`erase.down`, the `-999` column trick, scroll-aware cursor restoration.
- **unicode-text-width** — capability detection with ASCII fallbacks for every glyph; delegating hard wrap/width to `fast-wrap-ansi`.
- **layout** — sliding-window viewport for overflowing lists working in wrapped line-groups with conditional ellipses.
- **widgets-rich-content** — spinner as an independent animation loop with crash-safe lifecycle hooks; box-drawing glyph system.
- **app-architecture** — clean headless-core / styled-layer split via an injected `render` closure and a typed event emitter; state machine as the single source of visual truth.
