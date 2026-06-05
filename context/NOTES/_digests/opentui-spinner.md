# opentui-spinner

## What it is (1-2 lines)
A small, opinionated animated-spinner component for [@opentui](https://github.com/sst/opentui) terminal UIs. It wraps the `cli-spinners` frame catalog into an OpenTUI `Renderable` subclass and registers a `<spinner>` element for both the React and Solid reconcilers.

## Architecture (how the pieces fit; key files with paths)
The library is tiny (4 source files) and is a thin, well-behaved citizen of the OpenTUI render tree rather than a standalone renderer.

- `src/index.ts` — the whole component. `SpinnerRenderable extends Renderable` (OpenTUI core base class). Owns frame data, encoding, the animation timer, and `renderSelf`.
- `src/utils.ts` — `ColorGenerator` type plus two reusable per-char color functions (`createPulse`, `createWave`). Re-exported from `index.ts`.
- `src/react.ts` / `src/solid.ts` — 12-line adapters. Each calls `extend({ spinner: SpinnerRenderable })` from `@opentui/react` / `@opentui/solid` and augments the `OpenTUIComponents` interface via `declare module` so `<spinner ... />` is typed in JSX. This is the entire "react+solid" integration — the component class is framework-agnostic; the reconciler just instantiates the `Renderable` and pipes props to setters.
- `examples/knight-rider/utils.ts` — the most advanced code in the repo: a procedural frame + color generator for a bidirectional KITT scanner (trail gradients, hold frames, alpha fading). Shows how far the `frames` + `ColorGenerator` API can be pushed.
- `package.json` — `cli-spinners` is the only runtime dep; `@opentui/*` are peer deps (react/solid optional). Subpath exports `.`, `./react`, `./solid` map to the three entry files.

Data flow: framework JSX → reconciler `extend` registry → `new SpinnerRenderable(ctx, options)` → added to OpenTUI render tree → core calls `renderSelf(buffer)` each frame → spinner draws into the shared `OptimizedBuffer`.

## Core techniques (the actual TUI engineering)

**Component model: subclass a Renderable, don't reinvent the loop.**
The spinner does NOT own a render loop or touch the terminal. It hooks into OpenTUI's existing pipeline by overriding two lifecycle methods: `renderSelf(buffer)` (`src/index.ts:188`) and `destroySelf()` (`:220`). It signals "I changed, schedule a repaint" via `this.requestRender()` (`:177`, called from every setter and the timer). This is the key reconciler pattern: a leaf component pushes dirtiness up; core batches and repaints.

**Animation = a `setInterval` that only advances an index + requests render.**
`start()` (`src/index.ts:170`) installs a `setInterval(interval)` whose body is just `_currentFrameIndex = (idx+1) % frames.length; this.requestRender()`. The timer never draws — it mutates state and defers painting to core. `stop()` clears it; guards prevent double-timers (`if (this._intervalId) return`). Interval comes from `cli-spinners` per-spinner metadata (e.g. dots = 80ms).

**Pre-encode Unicode frames once, free on change/destroy.**
The clever perf move: each frame string is run through `lib.encodeUnicode(frame, ctx.widthMethod)` at construction (`_encodeFrames`, `src/index.ts:87`) and cached in `_encodedFrames` keyed by the raw frame string. Encoding resolves grapheme segmentation and per-char display width up front, so the hot `renderSelf` path never re-parses Unicode. Encoded buffers are native/allocated, so they MUST be released: `_freeFrames()` (`:96`) calls `lib.freeUnicode(...)` and is invoked from the `name`/`frames` setters before re-encoding, and from `destroySelf`. This is manual memory management around a native (zig/FFI) buffer — the non-obvious discipline OpenTUI requires.

**Width is computed from frame content, not assumed.**
`width = Math.max(...frames.map(f => f.length))`, `height = 1` (`src/index.ts:75`). Recomputed in the `name` and `frames` setters so layout (flexbox via OpenTUI/Yoga) reflows correctly when frames change. Note: uses `.length` (UTF-16 code units) for the bounding box but the encoded per-char `.width` for actual cursor advancement — see Gotchas.

**Per-character draw with correct width advancement.**
`renderSelf` (`src/index.ts:198`) iterates `encodedFrame.data` (array of `{char, width}`), drawing each char with `buffer.drawChar(char, x, y, fg, bg)` and advancing `x += data[i].width`. Using the encoded `.width` (not `+1`) is what makes wide glyphs / emoji spinners align. Colors are resolved per-char via `parseColor`.

**Per-character color generators (the extensibility seam).**
`color` is either a static `ColorInput` or a `ColorGenerator(frameIndex, charIndex, totalFrames, totalChars)` (`src/utils.ts:15`). In `renderSelf`, if `color` is a function it's called per char per frame, enabling waves/pulses/gradients without changing the frame strings. `createWave` shifts the palette index by `(charIndex + frameIndex) % totalChars`; `createPulse` cycles the palette by frame only.

**Procedural animation (knight-rider example).**
`examples/knight-rider/utils.ts` generates BOTH the frame glyph grid and a matching `ColorGenerator` from one shared `calculateColorIndex`/`getScannerState` model. It encodes a state machine over the frame index: forward sweep → hold-at-end → backward sweep → hold-at-start (`getScannerState`, line ~23). `calculateColorIndex` turns "distance behind the lead dot" into a palette index (trail gradient), returning `-1` for inactive cells. Alpha is faded in/out linearly over movement/hold (`:177`). Glyph choice (`⬥◆⬩⬪·` diamonds vs `■⬝` blocks) is driven by the same index. Takeaway: keep the visual model (positions/indices) separate from rendering, and reuse it for both glyph generation and coloring.

## Code patterns worth stealing

Renderable that animates by deferring paint to core:
```ts
class SpinnerRenderable extends Renderable {
  start() {
    if (this._intervalId) return;                 // idempotent
    this._intervalId = setInterval(() => {
      this._currentFrameIndex = (this._currentFrameIndex + 1) % this._frames.length;
      this.requestRender();                        // mutate state, let core repaint
    }, this._interval);
  }
  renderSelf(buffer) {
    const enc = this._encodedFrames[this._frames[this._currentFrameIndex]];
    let x = this.x;
    for (let i = 0; i < enc.data.length; i++) {
      const color = typeof this._color === "function"
        ? this._color(this._currentFrameIndex, i, this._frames.length, enc.data.length)
        : this._color;
      buffer.drawChar(enc.data[i].char, x, this.y, parseColor(color), parseColor(this._bg));
      x += enc.data[i].width;                      // advance by true display width
    }
  }
  destroySelf() { this.stop(); this._freeFrames(); super.destroySelf(); }
}
```

Cache-and-free native Unicode encodings:
```ts
_encodeFrames() {
  for (const f of this._frames) {
    const enc = this._lib.encodeUnicode(f, this.ctx.widthMethod);
    if (enc) this._encodedFrames[f] = enc;
  }
}
_freeFrames() {                                    // call before re-encoding AND on destroy
  for (const f in this._encodedFrames) this._lib.freeUnicode(this._encodedFrames[f]);
  this._encodedFrames = {};
}
```

Framework registration is one line + a type augmentation (works for both react & solid):
```ts
import { extend } from "@opentui/react";        // or @opentui/solid
import { SpinnerRenderable } from ".";
declare module "@opentui/react" { interface OpenTUIComponents { spinner: typeof SpinnerRenderable } }
extend({ spinner: SpinnerRenderable });
```

Setter that reflows layout + repaints, keeping the timer consistent:
```ts
set name(v) {
  this._freeFrames(); this._name = v;
  this._frames = v ? spinners[v].frames : this._defaultOptions.frames;
  this.width = Math.max(...this._frames.map(f => f.length));   // reflow
  this._encodeFrames(); this.requestRender();                  // repaint
}
set interval(v) { this.stop(); this._interval = v; this.start(); }  // restart timer
```

## Gotchas / non-obvious decisions
- **Native buffers must be freed.** `encodeUnicode` allocates; forgetting `freeUnicode` on frame change or unmount leaks. The library does this in every mutating setter and in `destroySelf`. Copy this discipline for any Renderable holding encoded text.
- **Two different width notions.** Bounding-box `width` uses `frame.length` (UTF-16 units), but drawing advances by the encoded per-char `.width`. For single-cell ASCII spinners these agree; for wide/emoji frames `.length` over-counts code units AND under-counts display width, so the reserved box may not match the painted width. Fine for the built-in `cli-spinners` set, a latent bug for arbitrary wide frames.
- **`name` vs `frames` precedence.** If `name` is set, it always wins and `options.frames`/`options.interval` are ignored (`constructor`, `:62`). Setting `frames` later does not clear `_name`, so state can become slightly inconsistent.
- **RGBA alpha mutation in knight-rider.** `createKnightRiderTrail` mutates `defaultRgba.a` in place every char (`:195`) instead of allocating, relying on synchronous single-threaded per-frame rendering. Cheap and correct here, but a footgun if the same RGBA escapes the render call.
- **Color generator runs per char per frame.** For wide spinners with expensive generators this is O(chars) work each repaint; keep generators pure and cheap.
- **No standalone runtime.** Without an OpenTUI renderer + react/solid reconciler there's nothing to drive `renderSelf`; this is glue, not an engine. The examples show three usage modes: JSX (`examples/react.tsx`, `examples/solid.tsx`) and imperative tree construction (`examples/knight-rider/index.ts` with `new BoxRenderable(...).add(spinner)`).

## Relevance (which advanced-TUI topics this teaches)
- **reconciler-component-models** — canonical example of authoring a custom Renderable and registering it into both the React and Solid reconcilers via `extend` + `declare module`; the `requestRender`/`renderSelf`/`destroySelf` lifecycle.
- **rendering-pipeline** — how a leaf participates in a batched, core-driven repaint loop instead of owning its own loop; decoupling state mutation (timer) from painting.
- **unicode-text-width** — pre-encoding frames with `encodeUnicode`/`widthMethod`, per-char `.width` cursor advancement, and the code-unit-vs-display-width pitfall.
- **widgets-rich-content** — animated component design, per-character color generators, and procedural frame/color generation (knight-rider state machine).
- **app-architecture** — minimal library packaging: framework-agnostic core class + thin per-framework adapters, optional peer deps, subpath exports.
