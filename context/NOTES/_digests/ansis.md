# ansis

## What it is (1-2 lines)
A tiny, fast Node/Deno/browser library for ANSI terminal styling (`red.bold('x')`, `hex('#abc')`, chaining, nesting, truecolor→256→16→BW downgrade). No render loop — it's a string-decoration library, but its internals are a masterclass in ANSI code generation, nesting/restoration, color-level detection, and V8-shape micro-optimization.

## Architecture (how the pieces fit; key files with paths)
All source lives in `src/`. The literal ESC byte `\x1b` is embedded directly in string literals (shown as `` in editors), so escape sequences are `[31m` etc.

- `src/constants.js` — re-exports `Object.{defineProperty,getPrototypeOf,setPrototypeOf,create,keys}` as short locals (terser-friendly), plus `EMPTY_STRING=''`, `SEPARATOR=','`.
- `src/color-levels.js` — the level enum: `LEVEL_UNDEFINED=-1`, `LEVEL_BW=0`, `LEVEL_16COLORS=1`, `LEVEL_256COLORS=2`, `LEVEL_TRUECOLOR=3`.
- `src/color-math.js` — pure conversions: `hexToRgb`, `rgbToAnsi256`, `ansi256To16`. These implement the graceful color downgrade.
- `src/color-support.js` — `getLevel(globalThis)` and `autoDetectLevel(proc, env, envKeys)`: terminal/CI/env color-capability detection with a documented priority order.
- `src/index.js` — the engine: `Ansis()` factory builds a style registry, `createStyle()` builds a callable style function with cumulative open/close stacks and nested-style restoration, `createMethod()` installs lazy memoized getters.
- `src/index.mjs` — ESM wrapper that destructures named exports off the default instance.
- Build: `rollup.config.js` + `@rollup/plugin-replace` swaps the ESM export for `module.exports = ansis.default = ansis` in the CJS bundle; terser mangles `_open`/`_close`.

The public chain works because each style getter lives on a prototype shared by the instance, and chained styles inherit that prototype, so `red.bold.underline` is just repeated getter access that each calls `createStyle(thisChain, styleDef)`.

## Core techniques (the actual engineering)

### 1. Open/close stack accumulation for chaining (`src/index.js:33-35`)
Each style carries two cumulative strings:
```
openStack  = parent.open + open          // outer→inner open codes
closeStack = close + parent.close         // inner→outer close codes (reversed!)
```
Wrapping is `openStack + content + closeStack`. The close order is reversed so the SGR resets nest correctly: `red.bold('x')` → `[31m[1mx[22m[39m`. Note: closes use specific reset codes (bold closes with `22`, fg color with `39`), not a blanket `[0m`, so you can disable *one* attribute without wiping the others — essential for correct nesting.

### 2. Nested-style restoration ("re-open after a child closes") (`src/index.js:60-83`)
The hard problem: `red('a' + green('b') + 'c')` — the inner `green` emits a fg-close `[39m` which would also kill the outer red for the trailing `'c'`. Ansis walks a linked list of ancestor style nodes and replaces every inner *close* code with the inner *open* code inside the child output, so the outer style survives:
```
// effectively output.replaceAll(node._close, node._open) for each ancestor
while ((node = node.p)) {
  let { _open: replacement, _close: search } = node;
  // hand-rolled replaceAll via indexOf loop — ~30% faster than String.replaceAll
  for (; ~(pos = output.indexOf(search, lastPos)); lastPos = pos + searchLength)
    result += output.slice(lastPos, pos) + replacement;
  output = result + output.slice(lastPos);
}
```
Guarded by `if (output.includes('\x1b'))` — skip the whole walk if the child string has no escape codes at all. The traversal is over `.p`, an internal singly-linked list node `{ _open, _close, p }` (see anatomy comment at `src/index.js:93-100`).

### 3. Multiline handling (`src/index.js:85-90`)
If output contains `\n`, every newline is rewrapped: `output.replace(/(\r?\n)/g, closeStack + '$1' + openStack)`. This closes the style before each line break and re-opens after, so pagers / line-buffered terminals and tools that process output line-by-line keep correct styling per line (and background colors don't bleed to end-of-line across the break).

### 4. Lazy, self-memoizing getters (`src/index.js:213-223`)
Styles are registered as getters. First access computes the style function, then *overwrites the getter with a plain value property* on the object via `defineProperty(this, name, {value})`, so all subsequent reads are direct data-property reads (claimed up to 5x faster). `defineProperty` returns the object, so `[name]` chains right off it.

### 5. Color-level detection priority (`src/color-support.js`)
`autoDetectLevel` order (each documented inline):
1. `COLORTERM` map → truecolor/256/16.
2. `CI`: `,GITHUB` in env-keys → truecolor; any other CI → 16.
3. Not a TTY or `TERM=dumb` → BW.
4. Windows → truecolor (assumes Win10 ≥ build 14931).
5. `TERM` matches `-256` → 256.
6. default → 16.
Then `getLevel` applies an *override* priority (`src/color-support.js:175`): auto-detect < `NO_COLOR` < CLI `--color/--no-color` flags < `FORCE_COLOR`. `FORCE_COLOR` maps `false/0/1/2/3` to explicit levels; presence-check `FORCE_COLOR in env` lets it win even when value is empty. Browser detection: `thisRef.window?.chrome` → truecolor.
Deno wrinkle: `keys(env)` can throw a permission prompt; it's wrapped in try/catch and on denial `env` is reset to `{}` so later accesses don't keep prompting (`src/color-support.js:125-134`).

### 6. ANSI code generation by level (`src/index.js:225-310`)
`esc(open, close)` returns `{open:'[${open}m', close:'[${close}m'}` or the empty `visible` object when colors are off — so a single function transparently produces no-op styles at BW level.
- Truecolor: `38;2;r;g;b` (fg) / `48;2;r;g;b` (bg) via `createRgbFn(3|4, closeCode)`.
- 256: `38;5;code` / `48;5;code`.
- Fallback chain: if not truecolor, `rgb` routes through `rgbToAnsi256`; if not even 256, `ansi256` routes through `ansi256To16`. Built by composing functions at construction time (`createRgbFallbackFn`), so the per-call hot path has no level branching.
- The 16 base colors are generated in a loop from the string `'gray,black,red,green,yellow,blue,magenta,cyan,white'`, with `gray` placed first as a deliberate code-size/offset trick (it maps to bright-black 90/100). `addColor(name, code)` registers both fg and `bg`+Capitalized name with `code + 10`.

### 7. OSC 8 hyperlinks (`src/index.js:273-277`)
`link` is an extension formatter: `]8;;${url}${text}]8;;`, with a graceful text-only fallback `text (url)` when colors are unsupported.

## Code patterns worth stealing

Prototype set *before* own props to keep V8 hidden-class shape monomorphic (`src/index.js:102-105`):
```js
// Setting prototype AFTER adding props drops styleFn into dictionary (slow) mode, ~30% slower.
setPrototypeOf(styleFn, getPrototypeOf(parent)).p = { _open: open, _close: close, p: parent.p };
styleFn.open = openStack;
styleFn.close = closeStack;
```

hex→rgb without allocations, via integer parse and bit shifts (`src/color-math.js:17-34`):
```js
let decimal = ('0x' + hex) | 0;
return [decimal >> 16, (decimal >> 8) & 255, decimal & 255];
```

rgb→ansi256: grayscale axis vs 6×6×6 cube, integer-rounded (`src/color-math.js:45-62`):
```js
if (r ^ g | g ^ b)  // not gray
  return 16 + 36*round(r/51) + 6*round(g/51) + round(b/51);
// gray ramp 232..255 else clamp to 16/231
```

ANSI-strip regex handling both CSI and OSC-8 (`src/index.js:158`):
```js
str.replace(/][^]*|[][[()#;?]*(?:\d+(?:;\d*)*)?[\dA-ORZcf-nqry=><]/g, '')
```

Bitwise idioms used throughout for size/speed: `~indexOf` for found-test, `n ^ k` instead of `n !== k`, `(x / 36) | 0` for floor, `(g > 2) << 1` to pack channel bits.

`extend()` snapshots the current style getters into a fresh prototype so user-defined styles and chains coexist (`src/index.js:180-203`); string extension values are auto-treated as hex and produce both `name` and `bgName`.

## Gotchas / non-obvious decisions
- Closes are attribute-specific resets (`22/23/24/39/49`…), never `[0m`, so nested styles can be peeled off one layer at a time. `reset` is the only style with an empty close.
- The nesting-restore loop reuses terser-mangled `_open`/`_close` (raw single-style codes) vs public `.open`/`.close` (cumulative stacks) — two different concepts on the same function object; see the anatomy comment.
- `falsy` argument handling is subtle (`src/index.js:43-51`): `reset()` with no arg returns the raw open code; `''`/`null` → `''`; but `false/0/NaN` fall through and get stringified.
- `gray` is listed first in the color loop purely so its special bright-black code math falls out with fewer operations and smaller output — pure golf with documented offset arithmetic.
- `level` can be forced by passing a number to `new Ansis(2)`; passing an object treats it as a mock `globalThis` (how the tests inject env).
- Detection assumes any modern Windows supports truecolor — a deliberate simplification.
- The whole nesting walk is skipped unless the child output contains a literal ESC byte, so plain strings cost nothing.

## Relevance (which advanced-TUI topics this teaches)
- **ansi-escapes**: canonical reference for SGR open/close pairing, attribute-specific resets, truecolor/256/16 escape formats, OSC 8 hyperlinks, and a robust strip regex.
- **rendering-pipeline**: the open/close-stack model and the nested-style restoration algorithm are exactly what any TUI text-styling layer needs to compose styled spans without bleed; the multiline rewrap trick is widely applicable.
- **app-architecture**: lazy memoized getters, prototype-shape preservation for V8, and compile-time function composition to keep hot paths branch-free are transferable performance patterns.
