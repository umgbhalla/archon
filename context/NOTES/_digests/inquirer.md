# inquirer

## What it is (1-2 lines)
`@inquirer/prompts` is a CLI prompt library built on a tiny React-like hooks runtime (`@inquirer/core`). Each prompt is a pure-ish render function that returns a string; the core re-runs it on state change and diffs/redraws lines over a Node `readline` interface.

## Architecture (how the pieces fit; key files with paths)
Monorepo under `packages/`. The interesting engineering is almost entirely in `@inquirer/core`; individual prompts (`select`, `checkbox`, `input`, ...) are thin view functions composed from core hooks.

- `packages/core/src/lib/create-prompt.ts` — the entry point / runtime host. Wires up readline, mute stream, signal handling, the render cycle, and resolves the answer promise.
- `packages/core/src/lib/hook-engine.ts` — the React-like hooks engine: index-based hook storage in `AsyncLocalStorage`, the render `cycle`, batched updates (`withUpdates`), and the `effectScheduler`.
- `packages/core/src/lib/screen-manager.ts` — the actual TUI renderer: line counting, cursor repositioning, erase-and-redraw.
- `packages/core/src/lib/use-state.ts`, `use-ref.ts`, `use-memo.ts`, `use-effect.ts`, `use-keypress.ts`, `use-prefix.ts` — the hooks.
- `packages/core/src/lib/pagination/use-pagination.ts` — viewport/scroll logic for long lists.
- `packages/core/src/lib/utils.ts` — `breakLines` (ANSI-aware wrap) and `readlineWidth` (terminal width).
- `packages/ansi/src/index.ts` — the entire ANSI escape vocabulary used (cursor move/show/hide, erase lines). Tiny and worth reading in full.
- `packages/core/src/lib/key.ts` — keypress normalization + vim/emacs keybinding predicates.
- `packages/select/src/index.ts` — a complete, representative prompt; best example of how hooks + pagination + keypress + theme compose.

Data flow: `createPrompt(view)` returns a callable prompt. Calling it sets up readline + `ScreenManager`, then `withHooks` runs the view inside an `AsyncLocalStorage` store. State changes call `handleChange` → re-run view → `screen.render(content, bottomContent)`. The view signals completion via the injected `done(value)` callback.

## Core techniques

### The render cycle is a "re-run the whole function" model, not a diff tree
There is no virtual DOM. The view function returns either a `string` or `[mainContent, bottomContent]`. On every state change the entire view re-runs and produces a fresh full string; the diffing happens at the *terminal line* level inside `ScreenManager`, not at a component level. This is the key simplification that makes the whole thing ~120 lines of renderer.

### Erase-and-redraw line accounting (`screen-manager.ts`)
The renderer never tries to compute a minimal text diff. Instead it tracks how many lines it printed last time (`this.height`) and how many lines sit below the cursor (`this.extraLinesUnderPrompt`), then on each render:
1. `cursorDown(extraLinesUnderPrompt)` to get to the bottom of what was drawn.
2. `eraseLines(this.height)` to wipe the whole previous frame.
3. Write the new frame.
4. Reposition the cursor back up to the input line and over to the right column.

See `screen-manager.ts:88`:
```
this.write(cursorDown(this.extraLinesUnderPrompt) + eraseLines(this.height) + output);
this.extraLinesUnderPrompt = bottomContentHeight;
this.height = height(output);
```
`eraseLines(n)` (`ansi/src/index.ts:31`) is `(ESC 2K + cursorUp(1)).repeat(n-1) + ESC 2K + cursorLeft` — erase current line and walk up, line by line. This is the canonical "redraw the whole frame each tick" TUI strategy.

### Cooperating with readline's own cursor instead of fighting it
The prompt's *input line* is managed by Node `readline`, not by inquirer. The renderer extracts the last visual line of `content`, strips ANSI (`stripVTControlCharacters`), removes the user-typed portion by length (`rl.line.length`), and feeds the remainder to `rl.setPrompt()` (`screen-manager.ts:39-50`). This lets backspace, left/right arrows, and the readline cursor "just work" while inquirer owns everything above/below. Comment notes it can't trust `rl.line` *content* (password prompt masks it) so it only uses its *length*.

### Width, wrapping and the wrap-edge cursor bug
`breakLines` (`utils.ts:12`) splits on `\n`, wraps each line to terminal width with `fast-wrap-ansi` (ANSI-aware so escape codes don't count toward width), and `trimEnd`s. Terminal width comes from `cli-width` with an 80 fallback (`utils.ts:27`). A subtle fix at `screen-manager.ts:62`: if the prompt line length is an exact multiple of width, it appends a `\n` so the cursor doesn't render at column 0 of the same line (terminals don't auto-wrap until a char is printed past the edge).

### Cursor-position re-sync on keypress (`create-prompt.ts:114`, `screen-manager.ts:94`)
Because output is muted, moving the readline cursor (arrow keys) wouldn't visually update. So a `keypress` listener calls `screen.checkCursorPos()`, which compares `rl.getCursorPos().cols` to the stored column and emits a `cursorTo` only when it actually changed — a cheap manual cursor sync that avoids a full re-render.

### Output muting to suppress readline echo
`create-prompt.ts:53-68` pipes a `MuteStream` to stdout and mutes it. readline still does its setup writes, but all subsequent echo is suppressed; `ScreenManager.write()` (`screen-manager.ts:31`) unmutes only for the duration of its own controlled write, then re-mutes. This gives inquirer exclusive, deterministic control of the screen.

### The hooks engine (`hook-engine.ts`)
A faithful miniature of React hooks:
- Per-prompt store kept in `AsyncLocalStorage` (`hookStorage`), so hooks can be called as free functions yet resolve to the right prompt instance — crucial for concurrency and for `AsyncResource.bind` keeping async callbacks attached to the right store.
- Hooks are stored in a flat array indexed by call order. `withPointer` (`hook-engine.ts:101`) returns a `{get,set,initialized}` view over `store.hooks[index]` and increments `store.index`. This is why hook call order must be stable (same rule as React).
- `cycle` resets `store.index = 0` then calls `render()` (`hook-engine.ts:37`); each render walks the same hook indices.
- `useState` (`use-state.ts`) compares with `!==`, no-ops if unchanged, else `handleChange()` triggers re-render. `setState` is `AsyncResource.bind`-ed so it works from async contexts.
- `useRef` is literally `useState({current})[0]` (`use-ref.ts:6`) — clever reuse: a ref is mutable state that never triggers re-render.
- `useEffect` (`use-effect.ts`) does `Object.is` dependency comparison and queues the effect into `effectScheduler`; effects run *after* render (`create-prompt.ts:151` calls `effectScheduler.run()`), with prior cleanup invoked first.

### Update batching (`withUpdates`, `hook-engine.ts:66`)
Wraps an event handler so multiple `setState` calls inside it cause exactly one render: it temporarily swaps `handleChange` for a flag-setter, runs the function, then fires the real `handleChange` once if anything changed. `useKeypress` wraps its handler in `withUpdates` (`use-keypress.ts:15`) so a key that flips several states redraws once.

### Pagination / viewport scrolling (`use-pagination.ts`)
The hard, clever part. It renders every item to its own array of wrapped lines, then builds a fixed-height `pageBuffer` of `pageSize` lines:
- `usePointerPosition` decides where in the viewport the active row sits, using saved `lastPointer`/`lastActive` in a ref. Goal: ease the cursor toward the *middle* of the page as you scroll, then pin it there; near list bounds, let it drift to top/bottom.
- Separate loop vs non-loop math; multi-line items are supported (a choice can occupy several rows).
- It places the active item first, then fills lines below (`bound(active+1)` forward) and above (`active-1` backward), slicing partial multi-line items to fit the page edges, tracking `itemVisited` to avoid double-draw in looping lists.

### Loading spinner without flicker (`use-prefix.ts`)
On `status === 'loading'`, it waits 300ms *before* showing a spinner (avoids flicker for fast ops), then `setInterval` ticks frames. The effect's cleanup clears both timers. Demonstrates timer-driven animation inside the hooks model — the interval's `setTick` just drives re-renders.

## Code patterns worth stealing

Index-based hook storage keyed by async context:
```ts
const hookStorage = new AsyncLocalStorage<HookStore>();
// store.hooks[index] holds state; cycle resets index to 0 each render
function withPointer(cb) {
  const store = getStore();
  const { index } = store;
  const pointer = {
    get: () => store.hooks[index],
    set: (v) => { store.hooks[index] = v; },
    initialized: index in store.hooks,
  };
  const r = cb(pointer);
  store.index++;
  return r;
}
```

Batch many setStates into one render:
```ts
function withUpdates(fn) {
  return (...args) => {
    const store = getStore();
    let shouldUpdate = false;
    const old = store.handleChange;
    store.handleChange = () => { shouldUpdate = true; };
    const r = fn(...args);
    if (shouldUpdate) old();   // single render
    store.handleChange = old;
    return r;
  };
}
```

Full-frame erase-and-redraw:
```ts
write(cursorDown(extraLinesUnderPrompt) + eraseLines(prevHeight) + newFrame);
prevHeight = countLines(newFrame);
```

Let readline own the editable line; you own everything else:
```ts
let prompt = stripVTControlCharacters(lastLine(content));
if (rl.line.length > 0) prompt = prompt.slice(0, -rl.line.length); // remove user input by length
rl.setPrompt(prompt);
```

Prompt as a pure-ish view returning a string + optional bottom content:
```ts
createPrompt((config, done) => {
  const [active, setActive] = useState(0);
  useKeypress((key, rl) => { if (isEnterKey(key)) done(items[active].value); });
  return `${message}\n${page}`; // re-runs whole fn on every setState
});
```

## Gotchas / non-obvious decisions
- **No diffing of text** — every frame is fully erased and rewritten. Cheap to implement, but every state change repaints the whole prompt block. Works because prompts are small.
- **Hook call order must be stable** — same rule as React; conditional hooks break the index mapping.
- **First-render is deferred by a `setImmediate`** for real Readable streams (`create-prompt.ts:175`) so OS-buffered stdin bytes flush harmlessly while output is muted and no keypress handlers exist yet (issue #1303). Old-style streams render immediately.
- **`nativeSetImmediate` captured at module load** (`create-prompt.ts:15`) so fake-timer test frameworks can't break the scheduling.
- **SIGINT handled explicitly** (`create-prompt.ts:95`) plus `signal-exit` — needed because otherwise the prompt promise may never settle (issue #1741). Two distinct cleanup paths: `rl 'close'` clears active timeouts immediately; `signal-exit` fires after process teardown.
- **Wrap-edge `\n` insertion** (`screen-manager.ts:62`) prevents the cursor sitting at column 0 of a full line.
- **`cursorLeft` on done** (`screen-manager.ts:111`) — Windows `\n` moves down without resetting column when wrapped; explicit column reset fixes subsequent output offset.
- **`done()` timing** — if the view calls `done` synchronously during render it's deferred (`pendingDone`) until after effects settle; async-validation paths resolve immediately. Avoids resolving before the final frame flushes (`create-prompt.ts:118-161`).
- **`useRef` is just non-rendering state** — refs and state share the same backing array slot mechanism.
- **`cursorHide` appended to view output** in `select` (`select/src/index.ts:297`) rather than tracked as terminal state — escape codes are embedded directly in the rendered string.

## Relevance (which advanced-TUI topics this teaches)
- rendering-pipeline — the full re-run + erase-and-redraw frame model, batched updates, deferred-first-render.
- reconciler-component-models — a minimal React-hooks reconciler (`AsyncLocalStorage` store, index-based hooks, effect scheduler) without a vdom.
- input-keyboard-mouse — readline keypress normalization, vim/emacs predicates, type-ahead search, batched key handling.
- ansi-escapes — compact, complete cursor/erase escape vocabulary and how `eraseLines` walks the frame.
- unicode-text-width — ANSI-aware wrapping (`fast-wrap-ansi`), `stripVTControlCharacters`, `cli-width` for terminal width.
- layout — pagination/viewport scrolling with multi-line items and a middle-anchored cursor.
- app-architecture — prompt-as-pure-function, promise-resolving host, signal/cleanup lifecycle, theming layer.
