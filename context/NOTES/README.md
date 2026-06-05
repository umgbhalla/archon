# Advanced TypeScript TUIs — Study Notes

A reading map for building production-grade terminal UIs in TypeScript. Twelve **topic notes** (synthesized cross-repo deep-dives) sit in this directory; ~70 **submodule repos** they draw from live one level up under `../`; per-repo **digests** are in [`./_digests/`](./_digests/). Start with the [learning path](#recommended-learning-path) below.

## Map (what's in this NOTES/ dir)

Each topic note is a cross-repo synthesis: mental model, mechanism with file:line citations, cross-repo comparison table, pitfalls, and a "build it from scratch" section.

- [rendering-pipeline.md](./rendering-pipeline.md) — cell buffer → double buffer → char-level diff → minimal ANSI byte stream → the frame loop; sub-cell pixel tricks.
- [layout.md](./layout.md) — styled tree → float boxes (Yoga / hand-rolled flexbox) → snapped to integer cells; the box model and table column-sizing.
- [reconciler-component-models.md](./reconciler-component-models.md) — how a React/Solid VDOM (or a `view(state)` fn) becomes a live node tree; host configs, child diffing, focus & routing.
- [input-keyboard-mouse.md](./input-keyboard-mouse.md) — raw mode, the byte-level framing state machine, CSI-u/Kitty + SGR mouse decoding, dispatch to focus via a hit grid.
- [ansi-escapes.md](./ansi-escapes.md) — the escape-sequence grammar (SGR/CSI/OSC/DCS/APC), generating vs parsing, the truecolor→256→16→BW color ladder, capability detection.
- [unicode-text-width.md](./unicode-text-width.md) — turning a string into a count of terminal cells: grapheme segmentation (UAX#29) + East Asian Width + emoji/Hangul special cases. The most error-prone primitive.
- [pty-emulation.md](./pty-emulation.md) — spawning a PTY (host), the VT500 emulator (grid + scrollback + reflow), resize, and driving a real TUI for testing (the settle loop).
- [terminal-images.md](./terminal-images.md) — putting raster pixels in a text grid: kitty graphics, iTerm IIP, SIXEL, and the universal half-block fallback; pinning pixels to cells.
- [effect-cli.md](./effect-cli.md) — the Effect-TS text stack: Wadler/Leijen `Doc` layout, the ANSI annotation monoid, the `Terminal` service, and the prompt render/update loop.
- [widgets-rich-content.md](./widgets-rich-content.md) — higher-level widgets: live-redraw loops, prompts, task lists, tables, markdown→ANSI, syntax highlighting, charts, spinners, boxes.
- [app-architecture.md](./app-architecture.md) — wiring a whole app: single-writer event loop, state folding, update→render coalescing, keybinding subsystems, performance at scale.
- [opentui-deep.md](./opentui-deep.md) — OpenTUI end-to-end: the TS-scene-graph / Zig-pixel-core split, zero-copy FFI buffers, the 3-pass render walk, schedulers, and building a custom `Renderable`.

## Submodule index by category

The ~70 repos under `../`, grouped. Each links to the repo dir and (where present) its digest.

### opentui-ecosystem — the OpenTUI core + things built on it
- [`../opentui`](../opentui) ([digest](./_digests/opentui.md)) — TS TUI framework with a native Zig render core (cell buffers, diff, ANSI, threaded writer); the reference architecture.
- [`../opentui-ui`](../opentui-ui) ([digest](./_digests/opentui-ui.md)) — component library: Stitches-style `styled()` engine, Badge/Checkbox leaves, toast + async-dialog systems.
- [`../opentui-spinner`](../opentui-spinner) ([digest](./_digests/opentui-spinner.md)) — animated `<spinner>` Renderable over the cli-spinners catalog; cleanest custom-Renderable + dual-framework registration example.
- [`../opentui-doom`](../opentui-doom) ([digest](./_digests/opentui-doom.md)) — DOOM (WASM) blitted into a `FrameBufferRenderable` via half-block glyphs; high-FPS pixel case study.
- [`../opentui-examples`](../opentui-examples) — assorted OpenTUI usage samples.
- [`../create-tui`](../create-tui) — project scaffolder / starter for OpenTUI apps.

### frameworks — full render engines (own reconciler/renderer or a layer on one)
- [`../glyph`](../glyph) ([digest](./_digests/glyph.md)) — from-scratch React renderer: own react-reconciler + Yoga + cell framebuffer + char diff. Cleanest readable diff engine.
- [`../melker`](../melker) ([digest](./_digests/melker.md)) — Deno/Node engine where apps are HTML-like `.melker` documents; dual-buffer diff, hand-rolled flexbox, sextant pixel canvas, dirty-row tracking.
- [`../rezi`](../rezi) ([digest](./_digests/rezi.md)) — runtime-agnostic framework with its own keyed VNode reconciler and a native C engine; the canonical single-writer turn-scheduler loop.
- [`../react-curse`](../react-curse) ([digest](./_digests/react-curse.md)) — minimal React renderer; one primitive, per-cell diff, ~50-line reconciler. Best for grasping the shape.
- [`../nberlette-tui`](../nberlette-tui) ([digest](./_digests/nberlette-tui.md)) — dependency-free cross-runtime lib driven by fine-grained signals wired straight into a cell-diffing canvas (no tree diff).
- [`../termui`](../termui) ([digest](./_digests/termui.md)) — large themed component library built on Ink (Ink+Yoga do layout/diff); AI-streaming hooks + imperative prompt APIs.
- [`../termcast`](../termcast) ([digest](./_digests/termcast.md)) — Raycast extension API reimplemented for the terminal on opentui/React; advanced compound-component + overlay/focus orchestration.
- [`../termdraw`](../termdraw) ([digest](./_digests/termdraw.md)) — drawing/diagram editor on opentui; clean headless `DrawState` model + dumb view, braille sub-cell lines, cached scene rasterization.

### primitives — low-level engines: layout, PTY, emulator, escapes, width
- [`../yoga`](../yoga) ([digest](./_digests/yoga.md)) — Meta's C++ Flexbox engine; the generation-counter measure cache + edge-rounding are the layout gold standard.
- [`../xterm`](../xterm) ([digest](./_digests/xterm.md)) — production browser terminal emulator; the best reference for VT500 parsing, bit-packed cell buffers, reflow, and image protocols.
- [`../node-pty`](../node-pty) ([digest](./_digests/node-pty.md)) — PTY host transport (forkpty/posix_spawn/ConPTY), termios, ioctl resize, exit reaping. No ANSI parsing.
- [`../terminal-control`](../terminal-control) ([digest](./_digests/terminal-control.md)) — Rust `termctrl` + TS client: drive/capture real TUIs through a PTY; the settle loop + capability-probe responder.
- [`../ansi-escapes`](../ansi-escapes) ([digest](./_digests/ansi-escapes.md)) — pure escape-sequence generator catalog (cursor/erase/alt-screen/sync-output/OSC links + images).
- [`../ansis`](../ansis) ([digest](./_digests/ansis.md)) — ANSI styling lib; masterclass in attribute-specific resets, nesting restoration, color downgrade.
- [`../anser`](../anser) ([digest](./_digests/anser.md)) — non-streaming SGR parser → HTML/JSON/text (split-on-CSI).
- [`../ansi-up`](../ansi-up) ([digest](./_digests/ansi-up.md)) — streaming SGR + OSC-8 parser → HTML (hand-written packetizer that buffers partial sequences).
- [`../node-sixel`](../node-sixel) ([digest](./_digests/node-sixel.md)) — SIXEL codec: WASM streaming decoder + pure-TS band encoder + palette quantization.
- [`../string-width`](../string-width) ([digest](./_digests/string-width.md)) — visual column width (EAW + emoji + Hangul + combining + ANSI strip). The pure-measurement reference.
- [`../unicode-segmenter`](../unicode-segmenter) ([digest](./_digests/unicode-segmenter.md)) — zero-alloc UAX#29 grapheme segmentation; the best segmenter for a render hot loop.
- [`../get-east-asian-width`](../get-east-asian-width) — EAW lookup (range arrays + binary search) under string-width.

### widgets — static/animated higher-level building blocks
- [`../cli-table3`](../cli-table3) ([digest](./_digests/cli-table3.md)) — static table layout: grid allocation with spans, two-phase width distribution, border-junction selection.
- [`../boxen`](../boxen) ([digest](./_digests/boxen.md)) — bordered box string transformer (the box model without a buffer; equal-width-line invariant).
- [`../asciichart`](../asciichart) ([digest](./_digests/asciichart.md)) — ~110-line pure line-chart `plot()` with slope-aware glyph selection.
- [`../cli-spinners`](../cli-spinners) ([digest](./_digests/cli-spinners.md)) — 90 spinner animations as `{interval, frames[]}` data; loop lives in the consumer.
- [`../log-update`](../log-update) ([digest](./_digests/log-update.md)) — in-place multi-line overwrite; the reference line-level diff + synchronized output + height clip.
- [`../clack`](../clack) ([digest](./_digests/clack.md)) — headless prompt engine (state machine + line diff with cardinality branches + scroll math) + styled layer.
- [`../inquirer`](../inquirer) ([digest](./_digests/inquirer.md)) — CLI prompts on a React-like hooks runtime over Node readline; full erase-and-redraw.
- [`../listr2`](../listr2) ([digest](./_digests/listr2.md)) — concurrent task-list renderer; setter-channel reactivity, render cache, write-hijack output capture, delegates diff to log-update.
- [`../marked-terminal`](../marked-terminal) ([digest](./_digests/marked-terminal.md)) — Markdown → ANSI (boxed tables, highlighted code, OSC-8 links).
- [`../shiki`](../shiki) ([digest](./_digests/shiki.md)) — TextMate-grammar syntax highlighter → HTML/ANSI/tokens; bit-packed metadata, resumable per-line state, alpha flatten.
- [`../cli-highlight`](../cli-highlight) ([digest](./_digests/cli-highlight.md)) — lightweight highlight.js HTML reused as a token stream → chalk.

### effect — the Effect-TS terminal stack (primitives, not a framework)
- [`../effect`](../effect) ([digest](./_digests/effect.md)) — `@effect/printer` (Wadler/Leijen Doc layout), `@effect/printer-ansi` (ANSI monoid), `@effect/platform` `Terminal` service, `@effect/cli` (declarative commands + prompts).

### real-apps — production TUIs studied for end-to-end architecture
- [`../opencode`](../opencode) ([digest](./_digests/opencode.md)) — SolidJS-on-opentui AI-coding-agent client; event-sourced store as a fold over a server SSE stream; surgical streaming-text patches.
- [`../gloomberb`](../gloomberb) ([digest](./_digests/gloomberb.md)) — React-on-opentui finance terminal; in-TUI window manager, virtualized tables, Kitty-graphics charts, host-abstraction (terminal + desktop).
- [`../ghui`](../ghui) ([digest](./_digests/ghui.md)) — React-on-opentui GitHub PR reviewer; the best-in-class **algebraic keymap** (`@ghui/keymap`, pure composable dispatch).
- [`../hunk`](../hunk) ([digest](./_digests/hunk.md)) — production diff viewer/git pager on opentui; measure-without-mount virtualization, async highlight queue, ANSI fallback pager.
- [`../critique`](../critique) ([digest](./_digests/critique.md)) — Bun diff viewer on an opentui fork; feeds the built-in `<diff>` correctly; headless render-to-ANSI/HTML/PNG.

## The big picture: how an advanced TUI works end-to-end

A single frame travels through one pipeline. The topic notes each own a stage:

**input → state → reconcile → layout → render diff → ANSI write**

1. **Input** ([input-keyboard-mouse](./input-keyboard-mouse.md)). stdin is one undelimited byte stream in raw mode. A push-driven byte state machine frames it — the load-bearing trick is the ~20ms ESC timeout that distinguishes a lone Escape from the start of `ESC[A`. Complete units are classified (a table lookup) into typed events: keys (legacy / modifyOtherKeys / Kitty CSI-u), SGR/X10 mouse, paste, focus, and — critically — *capability replies* tagged as `response` so they never leak into a text box.

2. **State** ([app-architecture](./app-architecture.md)). Events fan into a **single-writer event loop**. They are *folded* into one immutable-ish state value through a single mutation door (a reducer `update()`), strictly separated from rendering — mutating state mid-render is the most corrupting bug there is. Keybindings are their own subsystem (an algebraic keymap or a phased, editable-aware registry), not scattered `if (key===…)`. Server-driven apps make state a projection of an event log and patch it surgically.

3. **Reconcile** ([reconciler-component-models](./reconciler-component-models.md)). The new state produces a UI tree. A React/Solid host config (or a hand-rolled keyed reconciler) maps element creation/mutation onto live node operations. The best designs make **the node *be* the renderable** and put dirty-marking in the node's setters, so the reconciler stays thin. N state changes **coalesce to one frame** via a microtask/turn scheduler. Focus & routing ride on the node tree (tree-order DFS + trap stack), not on the framework.

4. **Layout** ([layout](./layout.md), [unicode-text-width](./unicode-text-width.md)). The styled tree is solved into float boxes by a flexbox engine (Yoga), then **snapped to the integer cell grid** by rounding *edges* (`round(right) − round(left)`), never extents, so adjacent boxes never gap or overlap. Text is a measured leaf whose `measureFunc` counts **display columns** — grapheme-cluster segmentation then East Asian Width + emoji/Hangul rules. `.length` is a lie; everything downstream (borders, wrap, truncate, cursor math) depends on getting this right.

5. **Render diff** ([rendering-pipeline](./rendering-pipeline.md)). Layout output is rasterized into a **cell buffer** (`{char, fg, bg, attrs}`), painted into a `next` buffer while `prev` still mirrors the screen. The whole game is the **double-buffer char diff**: walk cells, skip unchanged ones, move the cursor only when it isn't already in place, re-emit an SGR style only on a style break. Rich content (tables, markdown, charts, highlighted code, spinners — [widgets-rich-content](./widgets-rich-content.md); the Effect Doc engine — [effect-cli](./effect-cli.md)) and images ([terminal-images](./terminal-images.md)) all resolve to cells or to escape sequences that ride alongside.

6. **ANSI write** ([ansi-escapes](./ansi-escapes.md), [opentui-deep](./opentui-deep.md)). The diff becomes a minimal byte stream wrapped once in DEC 2026 **synchronized output** so the terminal presents the frame atomically (no tearing). A truly no-op frame emits **zero bytes**. The bytes are flushed in one back-pressure-aware write. Capability detection up front picks the color tier (truecolor→256→16→BW) and the glyph set (unicode vs ASCII).

The whole loop runs **on demand** (commit → coalesce → paint), switching to a **fixed-FPS callback loop** only for animation/games. To *test* it, you spawn the app in a PTY, feed an emulator, answer its capability probes, and assert only after the screen **settles** ([pty-emulation](./pty-emulation.md)).

## Recommended learning path

Beginner → advanced. Read the note, then skim the cited repo(s).

**1. Foundations — measure and emit correctly first.** Everything else is downstream of these two.
- [unicode-text-width.md](./unicode-text-width.md) → [`../string-width`](../string-width), [`../unicode-segmenter`](../unicode-segmenter). Why `.length` is wrong; segment-then-width.
- [ansi-escapes.md](./ansi-escapes.md) → [`../ansi-escapes`](../ansi-escapes), [`../ansis`](../ansis). The escape grammar, the color ladder, attribute-specific resets.

**2. The frame — buffers and the diff.** The single most important optimization in any TUI.
- [rendering-pipeline.md](./rendering-pipeline.md) → [`../log-update`](../log-update) (smallest correct double-buffer, line-level), then [`../react-curse`](../react-curse) and [`../glyph`](../glyph) (cleanest char-level diff to read).

**3. Layout — tree to rectangles to cells.**
- [layout.md](./layout.md) → [`../yoga`](../yoga) (the engine), [`../glyph`](../glyph)/[`../melker`](../melker) (mapping to cells), [`../boxen`](../boxen) + [`../cli-table3`](../cli-table3) (the hard static cases: box model, spans).

**4. Declarative UI — reconcilers and component models.**
- [reconciler-component-models.md](./reconciler-component-models.md) → [`../react-curse`](../react-curse) (minimal), [`../glyph`](../glyph) (real react-reconciler + Yoga sync), [`../rezi`](../rezi) (hand-rolled keyed reconciler), [`../nberlette-tui`](../nberlette-tui) (signals, no tree diff).

**5. Input — the byte machine and dispatch.**
- [input-keyboard-mouse.md](./input-keyboard-mouse.md) → `../opentui` `lib/stdin-parser.ts` (read this first), [`../xterm`](../xterm) `KittyKeyboard.ts` (the encode-side spec), [`../react-curse`](../react-curse) (the toy decoder to see the shape).

**6. Widgets & rich content — build the visible layer.**
- [widgets-rich-content.md](./widgets-rich-content.md) → [`../listr2`](../listr2)/[`../clack`](../clack)/[`../inquirer`](../inquirer) (live loops), [`../shiki`](../shiki)/[`../cli-highlight`](../cli-highlight) (highlighting), [`../marked-terminal`](../marked-terminal), [`../asciichart`](../asciichart).
- [effect-cli.md](./effect-cli.md) → [`../effect`](../effect) for the Wadler/Leijen Doc layout engine + ANSI monoid (a different, purely-functional take on the same problems).

**7. The native-core architecture — OpenTUI.**
- [opentui-deep.md](./opentui-deep.md) → [`../opentui`](../opentui) core, then [`../opentui-spinner`](../opentui-spinner) (custom Renderable), [`../opentui-ui`](../opentui-ui) (styling/composites), [`../termdraw`](../termdraw)/[`../opentui-doom`](../opentui-doom) (framebuffer leaves).

**8. Whole-app architecture — wiring it all together.**
- [app-architecture.md](./app-architecture.md) → [`../rezi`](../rezi) (the loop done right), [`../ghui`](../ghui) (keymap algebra), [`../opencode`](../opencode) (event sourcing), [`../gloomberb`](../gloomberb)/[`../hunk`](../hunk) (composition + virtualization).

**9. Advanced / specialized — read as needed.**
- [terminal-images.md](./terminal-images.md) → [`../node-sixel`](../node-sixel) (codec), [`../xterm`](../xterm) `addon-image` (protocols + cell pinning).
- [pty-emulation.md](./pty-emulation.md) → [`../node-pty`](../node-pty) (host), [`../xterm`](../xterm) (emulator), [`../terminal-control`](../terminal-control) (test harness).

## Build-an-advanced-TUI cheatsheet

The key decisions and the best-in-class choice for each, drawn from the cross-repo comparisons.

| Decision | Best-in-class choice | Why / where |
|---|---|---|
| **Render model** | Double buffer + per-cell char diff, wrapped in DEC 2026 synchronized output, emitting **zero bytes** on a no-op frame. Skip unchanged cells, move cursor only when needed, re-emit SGR only on a style break. | The single biggest win for free. See [rendering-pipeline](./rendering-pipeline.md); cleanest code in `../glyph` `diff.ts`, idle-suppression in `../opentui` `renderer.zig:1315`. |
| **Layout** | **Yoga** flexbox; snap to cells by **edge rounding** (`round(right)−round(left)`), not extent rounding. Don't hand-roll flexbox unless you have a hard no-WASM constraint (then copy `../melker` `layout.ts`). Text = a measured leaf (a measured node can't have children). | [layout](./layout.md). `../glyph` uses `pointScaleFactor=0` + manual edge round; `../opentui` uses `pointScaleFactor=1` and trusts Yoga's PixelGrid. |
| **Component model** | **Make the node the renderable; put dirty-marking in its setters** so the reconciler stays thin. React (`react-reconciler`) for batching + familiarity, Solid for fine-grained streaming, or a hand-rolled keyed reconciler (`../rezi`) for determinism + no dep. **Coalesce N commits → 1 frame.** | [reconciler-component-models](./reconciler-component-models.md). `../opentui`/`../glyph` host configs; `../rezi` for the from-scratch path. |
| **Input** | A **push-driven byte state machine with a ~20ms ESC timeout**, chunk-invariant, streaming pastes, capability replies typed as `response`. Dispatch keyboard→focus (with cancellation + editable-aware bare-key guard) and mouse→an **O(1) hit grid**. Enable Kitty CSI-u only after capability detection; reset all modes on exit. | [input-keyboard-mouse](./input-keyboard-mouse.md). `../opentui` `stdin-parser.ts` is the reference; `../ghui`/`../gloomberb` for dispatch ergonomics. |
| **Text width** | **Segment into grapheme clusters (UAX#29), then assign EAW + emoji/Hangul/combining width per cluster.** ASCII fast path first. Don't ship Unicode tables on Node≥20 — compose `Intl.Segmenter` + `get-east-asian-width` (`../string-width`). In a hot loop, use `../unicode-segmenter` + a separate EAW table and thread break-state across chunks. | [unicode-text-width](./unicode-text-width.md). Never `.length`. Expose ambiguous-width and wrap snap policy as explicit toggles. |
| **Styling** | A styling lib with **attribute-specific resets** (`22`/`39`/`49`, never blanket `[0m`) + nesting restoration, plus compile-time **truecolor→256→16→BW downgrade** and capability detection (`COLORTERM`/`NO_COLOR`/`FORCE_COLOR`). | [ansi-escapes](./ansi-escapes.md), [widgets-rich-content](./widgets-rich-content.md). `../ansis` is the model; route all OSC through one tmux-passthrough choke point (`../ansi-escapes` `wrapOsc`). |
| *(bonus)* **App loop** | **Single-writer event loop:** events fold into one immutable state through one `update()` door; `view(state)` is pure; one render per turn; lifecycle state machine + generation token for stale async; virtualize anything that can exceed the viewport. | [app-architecture](./app-architecture.md). Adopt `../rezi`'s turn scheduler and `../ghui`'s keymap algebra verbatim. |
| *(bonus)* **Native core** | Only if pushing full-screen 30fps+ content: keep the per-cell hot loop in Zig/Rust/WASM with **struct-of-arrays cell buffers shared zero-copy over FFI**; keep the scene graph + scheduling + input in JS. | [opentui-deep](./opentui-deep.md). The lesson is the *split*, not the Zig. For most apps, pure JS + in-place mutation + dirty tracking is plenty. |
| *(bonus)* **Images** | A capability-detected cascade: **kitty → iTerm IIP → SIXEL → half-block fallback** (`▀`, fg=top pixel, bg=bottom pixel — works in any truecolor terminal). Pin decoded pixels to grid cells so they scroll/clip with text; make decode handlers async. | [terminal-images](./terminal-images.md). `../node-sixel` (codec), `../xterm` `addon-image` (protocols + cell pinning). |
