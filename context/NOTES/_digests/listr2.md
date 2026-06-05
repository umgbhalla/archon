# listr2

## What it is (1-2 lines)
A concurrent terminal task-list renderer (the spinner-y "running tasks" UI you see in CLIs). It drives a tree of stateful tasks running with bounded concurrency, captures stray stdout/stderr, and re-renders an in-place updating block via `log-update`, with a pluggable renderer abstraction (default/simple/verbose/test/silent).

## Architecture (how the pieces fit; key files with paths)
Monorepo; the real library is `packages/listr2/src`. Three layers:

1. **Orchestration** — `listr.ts` (`Listr` class). Builds the `Task[]` tree, picks a renderer, runs tasks under a `Concurrency` limiter, owns the single shared `ListrEventManager` (event bus) and SIGINT cleanup.
2. **Task model / state machine** — `lib/task.ts` (`Task`), `lib/task-wrapper.ts` (the `task` object handed to user fns). `Task` extends an `EventEmitter` (`lib/listr-task-event-manager.ts`). It has setter-based "channels" (`state$`, `output$`, `title$`, `message$`, `promptOutput$`) that mutate state AND emit events.
3. **Renderers** — `renderer/*/renderer.ts`, each implementing `interfaces/renderer.interface.ts` (`render()`, `end()`, static `nonTTY`, static option bags). Renderers are passive observers of task events; they never drive task execution.

Supporting utils: `utils/ui/renderer.ts` (renderer selection + TTY fallback), `utils/ui/spinner.ts` (frame ticker), `utils/process-output/*` (stdout/stderr hijack + ring buffers), `utils/format/cleanse-ansi.ts` (strip control sequences), `utils/concurrency.ts` (promise pool), `utils/logger/logger.ts` (icon/suffix/level formatting), `utils/environment/is-unicode-supported.ts`.

Data flow: user code mutates a task via `task-wrapper` -> `Task` setter emits a task event AND fires `ListrEventType.SHOULD_REFRESH_RENDER` on the shared bus -> `DefaultRenderer` listens and calls `update()` -> recomputes the whole frame string and hands it to `log-update`.

## Core techniques (the actual TUI engineering)

### Two render triggers: timer tick + event-driven invalidation
`DefaultRenderer.render()` (`renderer/default/renderer.ts:88`) does two things: (a) starts a `Spinner` whose 100ms interval callback calls `this.update()` so animated frames advance, and (b) subscribes to `SHOULD_REFRESH_RENDER` to re-render immediately on any state change. `update()` is just `this.updater(this.create())` (`:111`) — it builds the entire frame as one string and lets `log-update` diff/erase. There is no manual cursor math in the renderer; `log-update` owns the "erase N previous lines, reprint" logic. This is the key simplification: **render the full frame every time, delegate the in-place update to a line-counting library.**

### Frame assembly is a recursive tree walk producing a string[]
`create()` (`:130`) concatenates three regions joined by EOL: tasks, bottom bar, prompt — inserting a blank line between non-empty regions. `renderer(tasks, level)` (`:269`) is a recursive `flatMap` over the task tree. Indentation = `level * indentation`. Subtasks recurse with `level+1` (or same level if the parent has no title, `:415`). Whether subtasks render at all is a large boolean (`:396-413`): show if pending, or any subtask failed/rolled-back, or collapse options say so. This is the "nesting" logic.

### Per-task render cache + completed-task freezing
A finished+closed task's rendered lines are frozen: `if (this.cache.render.has(task.id)) return this.cache.render.get(task.id)` (`:277`). When a task `isClosed()`, its output is stored in `cache.render` and its transient state (`rendererOptions`, output buffers) is reset (`:432`, `reset()` `:534`). So completed tasks stop being recomputed every tick — only active tasks re-render. This caps per-frame work even with thousands of done tasks.

### Output capture by monkeypatching stream.write (the clever/hard part)
`utils/process-output/process-output-stream.ts` saves the original `stream.write`, then on `hijack()` replaces `stream.write` with a buffer's `write` (`:31`). Any rogue `console.log` during the run is captured into a timestamped ring buffer instead of corrupting the live frame. `release()` restores the original method and returns the buffer. `get out()` returns a `Proxy` over the stream that only overrides `write` — so the renderer writes through a controlled handle while everything else passes through. Credited to keindev/stdout-update. `ProcessOutput.hijack()` (`process-output.ts:44`) also emits `CURSOR_HIDE`; `release()` flushes buffered output sorted by timestamp, cleansed, then `CURSOR_SHOW`.

### Ring-buffer output bars with StringDecoder
`ProcessOutputBuffer` (`process-output-buffer.ts`) stores `{time, stream, entry}` records and, with a `limit`, keeps only the last N via `buffer.slice(-limit)` (`:33`) — that's the "output bar" / "bottom bar" showing the last few lines of a task's output. It uses `StringDecoder` to safely decode partial multibyte chunks across writes (`:7`, `:29`) — important for UTF-8 boundaries in streamed output. The default renderer lazily creates one buffer per task in `setupBuffer()` (`renderer/default/renderer.ts:490`), wiring `OUTPUT` events into it. Bottom-bar entries from all tasks are merged and re-sorted by time at render (`renderBottomBar()` `:451`).

### ANSI cleansing instead of full parsing
`cleanseAnsi()` (`utils/format/cleanse-ansi.ts`) strips cursor/clear-line control sequences and BEL with two regexes (`cleanse-ansi.constants.ts`), then trims. listr2 does NOT emulate a terminal — it removes sequences that would move the cursor or clear lines (which would fight `log-update`) while leaving color SGR codes intact. Captured/prompt output is run through this before being placed into the managed frame.

### Layout/width handling
`format()` (`:216`) computes usable width as `(process.stdout.columns ?? 80) - level*indentation - 2`, then either `cli-truncate` or `wrap-ansi` (`{hard:true, trim:false}`) per the `formatOutput` option, re-indenting each wrapped line. `removeEmptyLines` filters blanks. So wrapping is ANSI-aware and indentation-aware; width is recomputed each render to respond to terminal resize.

### Spinner
`utils/ui/spinner.ts`: braille frames `['⠋','⠙',...]` (ASCII `-\|/` fallback if no unicode), `spin()` advances `pos = ++pos % len`, `fetch()` returns current frame. A single `setInterval(100ms)` ticks it and calls back into `update()`. `isUnicodeSupported()` gates the frame set (Windows + env sniffing: `CI`, `WT_SESSION`, `TERM_PROGRAM=vscode`, etc).

### Renderer selection + TTY fallback
`getRenderer()` (`utils/ui/renderer.ts:26`): silent-condition wins first; else primary renderer unless `!isTTY && !renderer.nonTTY` (or fallback condition) -> use fallback (default `simple`). `isRendererSupported` = `process.stdout.isTTY || renderer.nonTTY` (`:14`). This is how the same task tree renders as an animated block interactively but degrades to line-by-line logging when piped to a file/CI.

### Simple renderer = event-to-log translation (no frame, no cursor)
`renderer/simple/renderer.ts` has `nonTTY = true` and just subscribes to task events, emitting one log line per state transition/output via `ListrLogger`. No buffering, no `log-update`. Good contrast: the same Task model feeds a stateful TUI renderer and a dumb append-only logger.

## Code patterns worth stealing

**Setter "channels" that mutate + emit + request render (the reactive core):**
```ts
set state$(state: ListrTaskState) {
  this.state = state
  this.emit(ListrTaskEventType.STATE, state)
  if (this.hasSubtasks() && this.hasFailed())   // cascade-cancel children
    for (const s of this.subtasks)
      if (s.state === STARTED) s.state$ = FAILED
  this.listr.events.emit(ListrEventType.SHOULD_REFRESH_RENDER)  // invalidate
}
```
Every public state change is one assignment; observers stay decoupled via the bus. Two-tier events: per-task `EventEmitter` (renderers wire output/bottom bars per task) + one global render-invalidation signal.

**Monkeypatch stream.write to capture, Proxy to expose a safe handle:**
```ts
hijack() { this.stream.write = this.buffer.write.bind(this.buffer) }
release() { this.stream.write = this.method; const b = [...this.buffer.all]; this.buffer.reset(); return b }
get out() { return new Proxy(this.stream, { get: (t,p,r) =>
  p === 'write' ? self.write.bind(self) : Reflect.get(t,p,r) }) }
```

**Cache + freeze finished subtrees so only live tasks recompute:**
```ts
if (this.cache.render.has(task.id)) return this.cache.render.get(task.id)
...
if (task.isClosed()) { this.cache.render.set(task.id, output); this.reset(task) }
```

**Concurrency limiter that aborts the queue on first failure** (`utils/concurrency.ts`):
```ts
add(fn) { return this.count < this.concurrency ? this.run(fn)
  : new Promise(res => this.queue.add(() => res(this.run(fn)))) }
run(fn) { this.count++; const p = fn()
  p.then(() => { this.count--; this.flush() }, () => this.queue.clear())  // fail-fast: drop pending
  return p }
```

**Heterogeneous task results normalized to a Promise** (`lib/task.ts:146`): a returned nested `Listr` becomes subtasks (and is switched to the `silent` renderer because the parent already renders), a Promise is chained, a `Readable`/Observable is subscribed and each chunk piped to `output$`. One `handleResult` recursion unifies four return shapes.

**Width recomputed per render** with ANSI-aware wrap and re-indent: `(columns ?? 80) - level*indent - 2`, `wrap-ansi(msg, cols, {hard:true})`.

## Gotchas / non-obvious decisions
- **Nested Listr gets forced to the silent renderer** (`task.ts:153`) so only the root renderer touches the screen; subtasks feed the root via the shared event bus and shared `errors` array.
- **Single shared `ListrEventManager`** across the whole tree — the constructor reuses the parent's bus (`listr.ts:77`). One render loop for the entire nested structure.
- **Only one prompt active at a time**, enforced by throwing if a second prompt task appears (`renderer/default/renderer.ts:291`); prompt text is cleansed and there's a comment that double-output appears without cleansing on cancel (`task.ts:118`).
- **`end()` deliberately bypasses log-update for the final frame**: it calls `updater.clear()` + `updater.done()`, then writes the final render straight to stdout via `logger.process.toStdout` (`:124`) — log-update only tracks "seen height", so the persisted output must be written raw.
- **`forceTTY`/`forceUnicode` mutate `process.stdout.isTTY` and env** (`listr.ts:84-92`) to make piped/CI output still animate or use unicode.
- **`concurrent: true` -> `Infinity`**, `false`/non-number -> `1` (`listr.ts:63`).
- **SIGINT handler** marks pending tasks failed, ends the renderer, and `process.exit(127)` only from root (`listr.ts:216`); `setMaxListeners(0)` to avoid warnings with deep trees.
- `StringDecoder` per buffer specifically to not split multibyte chars across writes.
- The big render conditional (`:315`, `:396`) is genuinely hard to follow and flagged `eslint complexity` — the collapse/show matrix for skips/errors/subtasks is the real product complexity.

## Relevance (which advanced-TUI topics this teaches)
- **rendering-pipeline**: full-frame rebuild + delegate in-place update to a line-counting lib; timer-tick + event-invalidation dual triggers; per-node render cache freezing finished subtrees.
- **app-architecture**: reactive setter "channels", two-tier event bus, passive pluggable renderers over one shared task state machine, TTY-aware renderer selection/fallback.
- **ansi-escapes**: cursor hide/show, cleansing control sequences without full terminal emulation, ANSI-aware wrapping/truncation.
- **unicode-text-width**: unicode-support detection for spinner frames; `StringDecoder` for multibyte-safe streamed output; wrap-ansi/cli-truncate for width.
- **layout**: indentation-based tree layout, terminal-width-responsive wrapping, multi-region composition (tasks/bottom-bar/prompt).
- **widgets-rich-content**: spinners, ring-buffered output bars / bottom bars, timers, skip/error/retry decorations via logger suffix/icon system.
