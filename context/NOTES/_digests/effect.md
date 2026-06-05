# effect

## What it is (1-2 lines)
The Effect monorepo's text/CLI stack: `@effect/printer` (a Wadler/Leijen pretty-printer document algebra + layout engine), `@effect/printer-ansi` (annotates docs with ANSI styling/cursor commands and renders to escape sequences), `@effect/platform` `Terminal` service (raw-mode stdin + keypress events + stdout), and `@effect/cli` (declarative args/commands plus interactive prompts built as a render/update loop over the Terminal). These are not a full TUI framework but the *primitives* a TUI is built from: a layout-aware document model, an ANSI renderer, and an input/output service.

## Architecture (how the pieces fit; key files with paths)
Pipeline: `Doc<A>` (lazy document tree) → `Layout` algorithm picks line breaks → `DocStream<A>` (flat, already-laid-out token stream) → renderer walks the stream into a `string`. Annotations `A` are generic; printer-ansi instantiates `A = Ansi`.

- `packages/printer/src/internal/doc.ts` — the document algebra (13 node constructors), plus all combinators (`group`, `nest`, `align`, `vsep`, `hsep`, reactive `column`/`nesting`/`pageWidth`).
- `packages/printer/src/internal/layout.ts` — the core layout engine: `wadlerLeijen`, `pretty`, `smart`, `compact`, `unbounded` and the `fits` predicates. **This is the hard part.**
- `packages/printer/src/internal/layoutPipeline.ts` — `LayoutPipeline` = a cons-list of `(indent, Doc)` work items + an `UndoAnnotation` marker; the explicit work stack the layout loop consumes.
- `packages/printer/src/internal/docStream.ts` — `DocStream` model: `Char/Text/Line/PushAnnotation/PopAnnotation/Empty/Failed` stream nodes.
- `packages/printer/src/internal/render.ts` — plain renderer (drops annotations).
- `packages/printer/src/internal/optimize.ts` — fuses adjacent `Char`/`Text`/`Cat`/`Nest` nodes before layout.
- `packages/printer-ansi/src/internal/ansi.ts` — `Ansi` = a monoid of style fields (fg/bg/bold/...) + a `commands` array (cursor/erase escape sequences). `cursorTo`, `eraseLines`, etc.
- `packages/printer-ansi/src/internal/sgr.ts` — SGR (Select Graphic Rendition) model → numeric codes → `[…m`.
- `packages/printer-ansi/src/internal/ansiRender.ts` — renders `DocStream<Ansi>` maintaining a **stack of active styles** so Push/Pop emit the right SGR sequences.
- `packages/platform/src/Terminal.ts` + `packages/platform-node-shared/src/internal/terminal.ts` — the `Terminal` service interface and Node implementation (raw mode, keypress mailbox, `display`).
- `packages/cli/src/internal/prompt.ts` — the interactive prompt **render/update loop** (the closest thing here to a TUI event loop).
- `packages/cli/src/internal/prompt/select.ts`, `text.ts`, `ansi-utils.ts` — concrete widgets (list selection, text input) and the clear/redraw logic.
- `packages/cli/src/internal/{args,options,primitive,command,commandDescriptor,cliApp}.ts` — declarative arg/option/command model and the parser.

## Core techniques

### 1. The document algebra (doc.ts)
A `Doc<A>` is a tagged tree. The 13 constructors (`doc.ts:160-456`):
`Fail`, `Empty`, `Char`, `Text`, `Line` (hard newline), `FlatAlt(left,right)` (render `left` normally, `right` when flattened), `Cat(l,r)` (concatenation), `Nest(indent,doc)` (add indentation), `Union(long,short)` (layout chooses; invariant: every first line of `long` is ≥ every first line of `short`), and three *reactive* nodes whose content depends on layout position: `Column(pos => Doc)`, `Nesting(level => Doc)`, `WithPageWidth(pw => Doc)`, plus `Annotated(annotation, doc)`.

Derived semantics worth noting (`doc.ts:234-243`):
- `line   = flatAlt(hardLine, char(" "))`  — newline, or a space when flattened.
- `lineBreak = flatAlt(hardLine, empty)`   — newline, or nothing when flattened.
- `softLine = union(char(" "), hardLine)`  — space if it fits, else newline.

`align`, `hang`, `indent` are *not primitives* — they're built from the reactive nodes (`doc.ts:459-466`):
```ts
align(self) = column(pos => nesting(level => nest(self, pos - level)))
```
i.e. "set indentation to the current cursor column." `width(self, f)` measures rendered width by sampling the column before and after.

### 2. `group` — the choice operator (doc.ts:381-405)
`group(x)` says "try to render `x` on a single line; if it doesn't fit, use the multi-line version." Implemented by *flattening* `x` and wrapping in a `Union(flattened, x)`. Flattening uses the `Flatten` ADT (`flatten.ts`): `Flattened(v)` / `AlreadyFlat` / `NeverFlat`. `NeverFlat` (a hard line is present) means group does nothing. This is the whole mechanism behind "compact when it fits, expand when it doesn't."

### 3. The Wadler/Leijen layout loop (layout.ts:41-135) — the clever part
`best(pipeline, nestingLevel, currentColumn)` walks the `LayoutPipeline` work-stack and produces a `DocStream`. Key moves:
- `Cat(l,r)` pushes `r` then `l` onto the pipeline (explicit stack instead of recursion → constant-ish stack, trampolined via `Effect.gen`).
- `Nest` adds to the per-item indent carried in the `Cons` node.
- `Line` emits a `LineStream` whose indentation is the current item's indent — but **suppresses indentation if the next stream is empty or another line**, to avoid trailing whitespace (`layout.ts:78-82`).
- `Annotated` pushes the annotation onto the stream and inserts an `UndoAnnotation` sentinel into the pipeline so the matching pop is emitted later (`layout.ts:120-131`).
- `Union(long, short)` is the decision point: lay out **both** and call `selectNicer` (`layout.ts:137-154`), which evaluates the `long` branch and asks the `fits` predicate whether it fits; the `short` branch is computed **lazily** (only forced if needed). This laziness is what keeps the algorithm near-linear despite the branching.

### 4. The `fits` predicates — pretty vs smart (layout.ts:248-385)
- `fitsPretty` (`:248`): scan the candidate stream consuming `remainingWidth`; succeed at the first `LineStream` or `EmptyStream`, fail if width goes negative. Only looks at the *current* line.
- `fitsSmart` (`:305`): looks ahead across *multiple* lines until the indentation drops back below the line's nesting level, so it correctly handles deeply-nested constructs that `pretty` would mis-break. It computes a `minNestingLevel` from the alternative's initial indentation to decide whether the layout is "hanging."
- `remainingWidth` uses a *ribbon fraction* (`pageWidth.ts`): the usable width is `min(pageWidth - column, ribbon)` so text doesn't sprawl the full terminal.

### 5. DocStream + annotation stack rendering (docStream.ts, ansiRender.ts)
`DocStream` is the flattened result: a linked list of `CharStream/TextStream/LineStream(indentation)/PushAnnotationStream(a)/PopAnnotationStream`. The plain renderer (`render.ts`) just concatenates and turns `LineStream(n)` into `"\n" + n spaces`. The ANSI renderer (`ansiRender.ts:61-114`) keeps a **stack of `Ansi` styles**: on Push it combines the new style with the current top and emits the full SGR sequence; on Pop it re-emits the style now at the top of the stack. Because every emitted SGR sequence starts with `reset` (`ansi.ts:354-363`), styles are absolute, not differential — simpler but more verbose output.

### 6. ANSI model as a monoid (ansi.ts)
`Ansi` is a struct of `Option<SGR>` fields (foreground/background/bold/italic/strike/underline) plus a `commands: string[]`. Combination is a `Semigroup.struct` where each style field uses "first `Some` wins" and `commands` concatenate (`ansi.ts:45-75`). This makes `Ansi.combine(Ansi.bold, Ansi.red)` and annotation nesting compose cleanly. Cursor/erase helpers (`cursorTo`, `cursorUp`, `eraseLines`, `cursorHide`) build raw CSI strings into `commands` (`ansi.ts:228-328`).

### 7. The prompt render/update loop (prompt.ts:208-245) — the TUI event loop
A `Prompt` is a small free-monad-ish program: `Loop{initialState, render, process, clear}`, `OnSuccess` (flatMap), `Succeed`. `runLoop`:
```
state ← initialState
action ← NextFrame{state}
loop:
  msg ← render(state, action);  terminal.display(msg)
  event ← input.take                 // blocks on keypress mailbox
  action ← process(event, state)
  match action:
    Beep      → continue (terminal already rang)
    NextFrame → display(clear(state)); state = action.state; continue
    Submit    → display(clear(state)); display(render(Submit)); return value
```
Crucial detail: it does **not** diff frames. Each frame it (a) renders the new frame, then (b) on the *next* iteration emits a `clear` document (cursor moves + `eraseLines`) computed from the *previous* output's line count, then redraws. The finalizer always re-emits `cursorShow` so the cursor is restored even on Ctrl-C (`prompt.ts:238-244`).

### 8. Clearing = computing how many rows the last frame occupied (ansi-utils.ts:51-72)
There is no screen buffer. To erase, `eraseText(text, columns)` counts wrapped rows: for each `\n`-split line, `rows += 1 + floor(max(len-1,0)/columns)`, then emits `Doc.eraseLines(rows)`. `eraseLines(n)` (`ansi.ts:301-310`) is `n` × (`ESC 2K` erase-line + `ESC 1A` cursor-up) then `ESC G` to column 0. This is the standard "redraw in place" trick used by inquirer-style prompts. Note: width counting uses `string.length` (UTF-16 code units), so it does **not** handle wide/CJK or combining characters correctly.

### 9. Input handling (terminal.ts)
Node impl uses `readline.emitKeypressEvents(stdin)` + `stdin.setRawMode(true)` inside an `acquireRelease` scope (auto-restores on exit). Keypresses are pushed into a `Mailbox<UserInput>` (`{input: Option<string>, key: {name, ctrl, meta, shift}}`). `shouldQuit` (default Ctrl-C / Ctrl-D) marks the mailbox done with `Exit.void`, which surfaces as a `QuitException`. `escapeCodeTimeout: 50` disambiguates a lone ESC from an escape sequence.

### 10. CLI declarative model (args.ts, command.ts)
`Args`, `Options`, `Primitive`, `Command` are all tagged ADTs with applicative-style combinators (`Empty/Single/Map/Both/Variadic/WithDefault`). `Command.parse` returns a `CommandDirective` = `UserDefined{value, leftover}` | `BuiltIn` (help/wizard/completions). Subcommands parse by consuming a leading token then recursing with the `leftover` (`commandDescriptor.ts:738-806`). `cliApp.ts` is the entry: strips the executable, prefixes the command name, parses, and on a help `ValidationError` renders usage via the `HelpDoc` (which is itself built on `@effect/printer`).

## Code patterns worth stealing

Document algebra → layout → flat stream → render. Separating "what to draw" (`Doc`) from "where the breaks go" (`DocStream`) from "bytes" (renderer) lets you swap renderers (plain vs ANSI vs HTML) for free.

`group` via flatten+union:
```ts
group(x) = isNeverFlat(flatten(x)) ? x : union(flatten(x), x)
```

Explicit work-stack instead of recursion for the layout walk (`Cat` → push right then left). Trampolined through `Effect.gen` to avoid blowing the JS stack on deep docs.

Lazy second branch in the choice operator:
```ts
let right; // computed only if left doesn't fit
return fits(left, ...) ? left : (right ??= run(rightThunk))
```

Annotations as a monoid + a render-time stack so nested styles push/pop correctly without recomputing.

Redraw-in-place without a buffer: render frame, then next tick emit `eraseLines(rowsOfPreviousFrame)` computed from text length and terminal columns.

Prompt as a tiny interpreter (`Loop/OnSuccess/Succeed`) so prompts compose with `map`/`flatMap`/`all`.

Raw-mode setup as a scoped resource (`acquireRelease`) — TTY mode is always restored, even on interrupt.

## Gotchas / non-obvious decisions
- **No frame diffing.** Each redraw fully clears and reprints; fine for small prompts, would flicker / be slow for a full-screen TUI.
- **Width = `string.length`.** Wide (CJK/emoji) and zero-width/combining characters break clearing math and `fits` calculations. There is no `wcwidth`-style handling anywhere in these packages.
- **ANSI output is absolute, not differential** — every style change re-emits a full `reset;…m` sequence, so output is larger than necessary but state-independent.
- `selectNicer` calls `Effect.runSync` to force the (already-pure) layout effects — the `Effect` wrapping is purely for trampolining/stack-safety, not async.
- `Union`'s correctness depends on an unenforced invariant (first lines of the left are never shorter than the right); breaking it via raw `union` produces garbage layout. Always go through `group`.
- `Line` indentation is suppressed before empty/line streams to avoid trailing whitespace — easy to forget when writing a renderer.
- Windows gets a different glyph set (`ansi-utils.ts:23-38`): no fancy Unicode figures.

## Relevance
- **rendering-pipeline**: the Doc→Layout→DocStream→string pipeline is a clean, swappable rendering pipeline model.
- **layout**: Wadler/Leijen line-breaking, `group`, `nest`/`align`, ribbon width, pretty vs smart `fits` — a complete reflowable-text layout engine.
- **ansi-escapes**: SGR construction, cursor movement, erase-line/lines, hide/show cursor; how to model ANSI as a composable monoid.
- **input-keyboard-mouse**: raw-mode stdin, keypress decoding into structured key events via a mailbox, quit handling.
- **app-architecture**: the prompt render/update/clear loop is a minimal Elm-style event loop (state + render + process(event)→action).
- **effect-cli**: declarative Args/Options/Command ADTs, the parser, CommandDirective, help generation on top of the printer.
- **widgets-rich-content**: select/multi-select/text/confirm widgets show concrete styled-widget construction with the Doc algebra.
- **unicode-text-width**: relevant as a *cautionary* example — shows where naive `length`-based width math fails.
