# cli-spinners

## What it is (1-2 lines)
A pure-data package: 90 named terminal spinner animations, each a `{interval, frames[]}` record stored in one JSON file. No rendering engine — it ships the dataset and a trivial JS wrapper; consumers (ora, listr, etc.) drive the animation loop themselves.

## Architecture (how the pieces fit; key files with paths)
- `spinners.json` — the entire payload (~28 KB, 90 entries). The single source of truth. Each entry: `{ "interval": <ms>, "frames": [<string>, ...] }`.
- `index.js` — 12 lines. `import spinners from './spinners.json' with {type: 'json'}` (import attributes), re-exports it as default, plus a `randomSpinner()` helper that picks a key uniformly at random.
- `index.d.ts` — hand-maintained types. `SpinnerName` is a literal union of all 90 names (note the `// TODO: Load the spinner names from the JSON file` — the union is duplicated by hand, a known maintenance wart). `Spinner = {readonly interval: number; readonly frames: string[]}`.
- `example.js` / `example-all.js` — reference consumers showing the intended render loop (these are the only "TUI" code in the repo).
- `test.js` — ava tests; the interesting one enforces the constant-width invariant.

The package is data-as-API. There is no state machine, no diffing, no ANSI here. The render contract is implicit and pushed onto callers.

## Core techniques (the actual TUI engineering)
The actual TUI mechanics live in the *examples*, and the spinner format is shaped to make those mechanics trivial.

1. Fixed-interval frame advance with modulo cycling (`example.js:8-11`):
   ```js
   setInterval(() => {
     const {frames} = spinner;
     logUpdate(frames[index = ++index % frames.length] + ' Unicorns');
   }, spinner.interval);
   ```
   The whole animation model is: timer fires every `interval` ms, advance an index mod `frames.length`, repaint the current frame. `interval` is intentionally per-spinner because some animations read well fast (`dots` = 80ms) and others need to be slow (`material` etc.; intervals range 17–400ms across the set).

2. Single-line in-place repaint is delegated to `log-update`. cli-spinners never emits ANSI itself; `logUpdate(str)` is what owns the cursor-up / clear-line / rewrite cycle. The spinner frame is just the leading glyph concatenated with a label. This is the key architectural choice: the dataset stays terminal-agnostic and the cursor/erase logic is somebody else's problem.

3. **Constant display width is the load-bearing invariant.** Because the consumer overwrites in place without clearing trailing columns, every frame in a spinner MUST occupy the same number of terminal columns, or you get visual artifacts (stale glyphs left behind when a wide frame is followed by a narrow one). Enforced in `test.js:26-41`:
   ```js
   const firstFrameLength = stringLength(firstFrame);
   t.true(frames.every(frame => stringLength(frame) === firstFrameLength));
   ```
   Crucially this uses `string-length` (counts user-perceived characters / strips ANSI), **not** `String.prototype.length`. JS `.length` counts UTF-16 code units, which is wrong for astral-plane emoji (each is a surrogate pair, `.length === 2`) and for combining sequences.

4. Emoji width padding. Emoji spinners (`clock`, `earth`, `weather`, `moon`, `monkey`...) store frames with a **trailing space**: `"🕛 "`, `"🌍 "`. Two reasons: (a) many terminals render emoji as double-width (2 columns) and the maintainers normalize to a consistent rendered cell budget, and (b) it keeps the glyph from butting against the following label text. Some spinners legitimately mix code-point counts per frame (e.g. a `(2,3)` set) precisely because a base emoji + variation-selector/ZWJ sequence differs in code points while still being padded to equal *display* width — which is exactly why the test measures display width, not raw length.

5. Multi-cell / "scene" spinners. Frames aren't limited to one glyph. `bouncingBar`, `pong`, `shark`, `runner`, `christmas` are multi-column ASCII scenes (frame strings up to 20 chars). The same modulo loop animates them; the constant-width rule keeps the scene box stable.

## Code patterns worth stealing
- **Per-animation timing baked into the data.** Don't hardcode a global frame rate; let each animation carry its own `interval`. Frees the renderer from knowing anything about content.
  ```jsonc
  { "interval": 80, "frames": ["⠋","⠙","⠹","⠸","⠼","⠴","⠦","⠧","⠇","⠏"] }
  ```
- **Modulo ring buffer for cyclic animation** — no need to detect end-of-array; `i = (i + 1) % frames.length`.
- **Compute "play full animation once" duration** from the data (`example-all.js:26`):
  ```js
  setTimeout(showNextSpinner, Math.max(s.interval * s.frames.length, 1000));
  ```
  `interval * frames.length` = one full cycle; floor at 1000ms so very short loops are still watchable.
- **Measure width with a grapheme-aware library, never `.length`** when validating or laying out terminal content containing emoji/CJK/combining marks.
- **Raw-mode keypress wiring for "skip"** (`example-all.js:33-47`): `readline.emitKeypressEvents(stdin)`, `stdin.setRawMode(true)`, listen for `keypress`, manually re-handle Ctrl-C (`key.ctrl && key.name==='c' → process.exit(130)`) because raw mode disables the default SIGINT.
- **Data-driven enum + random pick**: `Object.keys(spinners)` derives the name list at runtime; `randomSpinner()` indexes by `Math.floor(Math.random()*list.length)`.

## Gotchas / non-obvious decisions
- Frames are **display-width constant, not byte- or code-unit-constant.** Mixing the two concepts is the classic terminal-rendering bug this dataset is built to avoid. The test's use of `string-length` is the whole lesson in one line.
- Emoji frames carry deliberate trailing spaces; if you `.trim()` them you break alignment and may collapse double-width cells.
- `index.d.ts` `SpinnerName` union is maintained by hand and can drift from `spinners.json` (explicit TODO). Runtime keys are authoritative; the type is a convenience.
- In raw mode you must re-implement Ctrl-C yourself or the process becomes unkillable from the keyboard (`example-all.js:38-41`).
- The library does zero terminal output and holds zero state — all animation/erase concerns are the consumer's. This is a feature: it makes the data reusable across ora/listr/log-update without coupling.
- `interval` is advisory ("intended time per frame"); actual cadence is whatever the consumer's timer achieves.

## Relevance (which advanced-TUI topics this teaches)
- **unicode-text-width**: the central lesson — display columns vs UTF-16 length, emoji double-width, padding frames to constant rendered width, validating with grapheme-aware measurement.
- **rendering-pipeline**: the minimal in-place repaint loop (timer → advance index → overwrite line) and why per-frame timing belongs in the data.
- **ansi-escapes**: by omission — shows the clean boundary where spinner data ends and cursor/erase ANSI (delegated to `log-update`) begins.
- **input-keyboard-mouse**: raw-mode keypress handling and manual Ctrl-C in the example driver.
- **widgets-rich-content**: a spinner is the smallest animated widget; the multi-column "scene" frames hint at how richer animated cells are stored as fixed-width frame strings.
