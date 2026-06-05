# effect-cli

The Effect-TS terminal stack: a layout-aware document model (`@effect/printer`), an
ANSI annotator/renderer (`@effect/printer-ansi`), a `Terminal` service abstraction
(`@effect/platform`), and a declarative command/arg model plus interactive prompts
(`@effect/cli`). These are **primitives**, not a TUI framework — but together they are a
complete reflowable-text layout engine, a composable ANSI styling monoid, a scoped
raw-mode input service, and a tiny Elm-style render/update loop. All paths below are under
`/Users/umang/hub/zonko/archon/context/effect/packages/`.

## TL;DR (the mental model in 3-5 bullets)

- **One pipeline, four stages:** `Doc<A>` (lazy document tree) → `Layout` algorithm
  decides line breaks → `DocStream<A>` (flat, laid-out token stream) → renderer walks the
  stream into a `string`. The annotation type `A` is generic; `printer-ansi` instantiates
  `A = Ansi`. Swapping renderers (plain vs ANSI vs HTML) is free because layout is separate
  from byte-emission.
- **`group` is the only choice you need.** `group(x)` = "render `x` on one line if it fits,
  else use the multi-line version." It is implemented by *flattening* `x` and wrapping in a
  `Union(flat, x)`; the layout loop picks the branch using a `fits` predicate. `align`,
  `hang`, `indent` are *not* primitives — they are built from three *reactive* nodes
  (`Column`, `Nesting`, `WithPageWidth`) whose content depends on the current cursor column.
- **ANSI is a monoid.** `Ansi` is a struct of `Option<SGR>` style fields + a `commands:
  string[]` array (cursor/erase escapes). Combination is "first `Some` wins" per field,
  commands concatenate. Annotations nest via a render-time **stack of styles**. Output is
  *absolute* (every change re-emits `reset;…m`), not differential.
- **The prompt loop has no frame diffing and no screen buffer.** Each frame it renders, then
  on the next tick emits a `clear` doc (`eraseLines(rowsOfPreviousFrame)` computed from text
  length ÷ terminal columns) and redraws. Fine for inline prompts; would flicker for a
  full-screen TUI.
- **`Terminal` is a 6-method service.** `columns/rows/isTTY/readInput/readLine/display`.
  Raw-mode setup is a scoped `acquireRelease` resource (TTY always restored, even on Ctrl-C),
  keypresses land in a `Mailbox<UserInput>`, and Ctrl-C/Ctrl-D close the mailbox → surfaces
  as `QuitException`.

## How it actually works (the mechanism, step by step)

### 1. The document algebra — 13 tagged constructors (`printer/src/internal/doc.ts`)

A `Doc<A>` is a tagged tree built with `Object.create(proto)` + a `_tag`. The leaf/structural
nodes (`doc.ts:160-231`): `Char`, `Text`, `Empty`, `Fail`, `Line` (hard newline, `hardLine`),
`FlatAlt(left, right)`, `Cat(left, right)`, `Union(left, right)`, `Nest(indent, doc)`. The
three **reactive** nodes (`doc.ts:411-439`) are the clever part: `Column(pos => Doc)`,
`Nesting(level => Doc)`, `WithPageWidth(pw => Doc)` — their subtree is a *function* of the
layout state at render time. Plus `Annotated(annotation, doc)`.

Derived line semantics (`doc.ts:234-243`):

```ts
line          = flatAlt(hardLine, char(" "))   // newline normally, space when flattened
lineBreak     = flatAlt(hardLine, empty)       // newline normally, nothing when flattened
softLine      = union(char(" "), hardLine)     // space if it fits, else newline
softLineBreak = union(empty, hardLine)
```

`align` is literally "set indent to the current cursor column" (`doc.ts:459-460`):

```ts
align(self) = column(pos => nesting(level => nest(self, pos - level)))
hang(self, i) = align(nest(self, i))                          // doc.ts:463-466
width(self, f) = column(c0 => cat(self, column(c1 => f(c1 - c0))))  // doc.ts:428-431
```

Concatenation combinators all funnel through `concatWith` (`doc.ts:336-348`): `hsep`
(space-join), `vsep` (`line`-join), `vcat` (`lineBreak`-join), `hcat`, `fillSep`/`fillCat`
(soft-line). `seps`/`cats` wrap a `vsep`/`vcat` in `group` (`doc.ts:303,378`).

### 2. `group` — the choice operator (`doc.ts:381-405`)

```ts
group(self) = match self._tag {
  FlatAlt  => match changesUponFlattening(self.right) {
    Flattened(v)  => union(v, self.left),
    AlreadyFlat   => union(self.right, self.left),
    NeverFlat     => self.left,          // a hard line is present → group does nothing
  },
  Union    => self,                       // already a choice
  _        => flattened = changesUponFlattening(self);
              isFlattened(flattened) ? union(flattened.value, self) : self
}
```

`Union`'s correctness depends on an **unenforced invariant**: every first line of `left`
(the flat branch) must be ≥ every first line of `right`. Always go through `group`, never
raw `union`, or you get garbage layout.

### 3. The Wadler/Leijen layout loop (`printer/src/internal/layout.ts:41-135`)

`wadlerLeijen(doc, fits, options)` runs `best(pipeline, nestingLevel, currentColumn)` which
consumes a `LayoutPipeline` — a cons-list work-stack of `(indent, Doc)` items
(`layoutPipeline.ts`) — and produces a `DocStream`. It is trampolined through `Effect.gen`
purely for JS-stack safety (`Effect.runSync` at `layout.ts:38` forces the pure result). Key
transitions in the `Cons` switch:

- `Cat(l, r)` (`layout.ts:88-92`): push `r` then `l` onto the pipeline (explicit stack, no
  recursion on the document).
- `Nest` (`:93-97`): add `document.indent` to the per-item `indent` carried in the `Cons`.
- `Line` (`:75-83`): emit a `LineStream` at the current item's indent, **but suppress the
  indentation if the next stream is empty or another line** to avoid trailing whitespace.
- `Column`/`Nesting`/`WithPageWidth` (`:105-119`): call `react(cc)` / `react(self.indent)` /
  `react(options.pageWidth)` and continue with the produced doc.
- `Annotated` (`:120-125`): push an `UndoAnnotation` sentinel into the pipeline (so the pop
  is emitted at the right point), recurse, then `pushAnnotation` onto the stream.
- `Union(l, r)` (`:98-104`): the decision point. Lay out **both** branches and call
  `selectNicer`.

`selectNicer` (`layout.ts:137-154`) is where the near-linearity comes from:

```ts
const leftStream = Effect.runSync(left)
let rightStream
return fits(leftStream, lineIndent, currentColumn,
            () => rightStream ??= Effect.runSync(right))   // right forced lazily
  ? leftStream
  : (rightStream ?? Effect.runSync(right))
```

The `short`/right branch is only forced if `fits` actually asks for it.

### 4. `fits` predicates — pretty vs smart (`layout.ts:248-385`)

- `fitsPretty` (`:248-283`): scan the candidate stream consuming `remainingWidth`; **succeed
  at the first `LineStream` or `EmptyStream`**, fail if width goes negative. It only looks at
  the *current* line.
- `fitsSmart` (`:305-385`): looks ahead across *multiple* lines. It computes a
  `minNestingLevel` from the alternative's initial indentation (`getInitialIndentation`,
  `:387-400`) and keeps scanning until indentation drops back below that level — so deeply
  nested constructs that `pretty` mis-breaks are handled correctly (`if (minNestingLevel <
  stream.indentation) return false`).
- Both use `remainingWidth(lineWidth, ribbonFraction, indentation, currentColumn)` from
  `pageWidth.ts` — a **ribbon fraction** caps usable width to `min(pageWidth - column,
  ribbon)` so text doesn't sprawl the full terminal.

`render(doc, {style})` picks the layout: `compact` (drops all unions, `layout.ts:161`),
`pretty`, or `smart` (`printer-ansi/src/internal/ansiRender.ts:19-33`).

### 5. DocStream + annotation-stack rendering (`ansiRender.ts:61-114`)

`DocStream` is the flattened linked list: `CharStream / TextStream / LineStream(indentation)
/ PushAnnotationStream(a) / PopAnnotationStream / EmptyStream / FailedStream`. The plain
renderer concatenates and turns `LineStream(n)` into `"\n" + n spaces`. The ANSI renderer
keeps a **`List<Ansi>` stack** seeded with `none` (`ansiRender.ts:37`):

```ts
case "PushAnnotationStream":
  nextStyle = InternalAnsi.combine(self.annotation, unsafePeek(stack))   // :97-104
  // push annotation, emit full SGR for nextStyle
case "PopAnnotationStream":
  [, styles] = unsafePop(stack); nextStyle = unsafePeek(styles)          // :105-112
  // re-emit the SGR now at the top of the stack
```

Because `stringify` always prepends `SGR.reset` (`ansi.ts:353-366`), every emitted sequence
is **absolute, not differential** — simpler and state-independent, but more verbose output.

### 6. The ANSI model as a monoid (`printer-ansi/src/internal/ansi.ts`)

```ts
interface AnsiImpl {
  commands: ReadonlyArray<string>     // raw CSI escape strings (cursor/erase)
  foreground, background, bold, italicized, strikethrough, underlined: Option<SGR>
}
```

Combination is a `Semigroup.struct` (`ansi.ts:51-60`): each style field uses
`getFirstSomeSemigroup` ("first `Some` wins"), `commands` use `Semigroup.array` (concatenate).
So `Ansi.combine(Ansi.bold, Ansi.cyanBright)` and nested annotations compose cleanly. Cursor
and erase helpers build raw CSI strings into `commands` (`ansi.ts:228-328`), e.g.:

```ts
cursorTo(col, row?)  => `${ESC}${col+1}G`  or  `${ESC}${row+1};${col+1}H`
cursorHide           => `${ESC}?25l`        // ESC = "["
eraseLines(rows)     => rows × (`${ESC}2K` + `${ESC}1A`) then `${ESC}G`   // :301-310
```

### 7. The prompt render/update loop (`cli/src/internal/prompt.ts:208-245`)

A `Prompt` is a tiny free-monad: `Loop{initialState, render, process, clear}`, `OnSuccess`
(flatMap), `Succeed` (`prompt.ts:40-65`). `map`/`flatMap`/`all` compose prompts
(`:137-166, 91-120`). `runLoop` is the event loop:

```ts
state  = initialState
action = NextFrame{state}
loop:
  msg = render(state, action); terminal.display(msg)
  event = input.take                          // blocks on the keypress mailbox
  action = process(event, state)
  match action:
    Beep      -> continue                       // terminal already rang the BEL
    NextFrame -> display(clear(state)); state = action.state; continue
    Submit    -> display(clear(state)); display(render(Submit)); return value
```

Crucial finalizer (`prompt.ts:238-244`): `Effect.ensuring` always re-emits
`Doc.render(Doc.cursorShow)` so the cursor is restored even on interrupt/Ctrl-C. `run`
(`:169-183`) acquires `terminal.readInput`, runs scoped, and maps any failure to
`QuitException`.

### 8. Clearing = counting rows of the last frame (`cli/src/internal/prompt/ansi-utils.ts`)

There is no screen buffer. `eraseText(text, columns)` (`ansi-utils.ts:51-61`) counts wrapped
rows:

```ts
for (const line of text.split(/\r?\n/))
  rows += 1 + Math.floor(Math.max(line.length - 1, 0) / columns)
return Doc.eraseLines(rows)
```

Note: width uses `string.length` (UTF-16 code units) — **no wide/CJK or combining-character
handling anywhere**. This is the standard inquirer-style "redraw in place" trick and breaks
on emoji/CJK. The `select` widget's `handleClear` (`select.ts:178-191`) builds the clear doc
then runs `Optimize.optimize(Optimize.Deep)` (fuses adjacent Char/Text/Cat/Nest) before
rendering.

### 9. Concrete widget: select (`cli/src/internal/prompt/select.ts`)

State is just `number` (the cursor index). `renderNextFrame` (`:114-130`) builds the doc:
`cursorHide` + prompt message + `hardLine` + the choice list, rendered with `{style:
"pretty", options: {lineWidth: columns}}`. Choices are styled purely with the Doc algebra:
the pointer `❯` is `Doc.annotate(figures.pointer, Ansi.cyanBright)` (`:62`), selected titles
get `Ansi.combine(Ansi.underlined, Ansi.cyanBright)` (`:74`), disabled get
`Ansi.strikethrough` (`:77`). Input handling (`:193-220`): `j`/`down` and `k`/`up` move (with
wraparound via `processCursorUp/Down`), `tab` cycles, `enter`/`return` submits (or `Beep` if
disabled), anything else beeps. Platform-aware glyphs: `defaultFigures` vs `windowsFigures`
(`ansi-utils.ts:6-44`) — Windows gets `(*)`/`[ ]`/`>` ASCII instead of Unicode figures.

### 10. The Terminal service (`platform/src/Terminal.ts` + `platform-node-shared/.../terminal.ts`)

The interface (`Terminal.ts:20-45`) is 6 members: `columns`, `rows`, `isTTY` (all
`Effect<number/boolean>`), `readInput: Effect<ReadonlyMailbox<UserInput>, never, Scope>`,
`readLine: Effect<string, QuitException>`, `display: (text) => Effect<void, PlatformError>`.
`UserInput = { input: Option<string>, key: { name, ctrl, meta, shift } }` (`:74-83`).

The Node impl (`platform-node-shared/src/internal/terminal.ts`):
- Raw mode as a scoped resource (`:22-41`): `acquireRelease` creates a `readline` interface
  with `escapeCodeTimeout: 50` (disambiguates a lone ESC from an escape sequence), calls
  `emitKeypressEvents` + `setRawMode(true)`, and **always** `setRawMode(false)` + `rl.close()`
  on release. Wrapped in an `RcRef` so multiple readers share one interface.
- `readInput` (`:47-63`): makes a `Mailbox<UserInput>`, registers a `keypress` handler that
  `unsafeOffer`s each input and, if `shouldQuit` (default Ctrl-C/Ctrl-D, `:11-12`), calls
  `mailbox.unsafeDone(Exit.void)`. The finalizer removes the listener.
- `display` (`:76-91`): `Effect.uninterruptible` async write to `stdout` — uninterruptible so
  a half-written escape sequence can't be torn.

### 11. CLI declarative model (`cli/src/internal/{args,options,command,commandDescriptor}.ts`)

`Args`, `Options`, `Command` are applicative ADTs. `Args` instructions (`args.ts:55-122`):
`Empty | Single | Map | Both | Variadic | WithDefault | WithFallbackConfig`. A `Single`
(`:70-77`) carries `name`, `primitiveType: Primitive<unknown>`, and a `HelpDoc` description.
A `Command` descriptor (`commandDescriptor.ts:64-104`) is `Standard{name, options, args} |
GetUserInput | Map | Subcommands{parent, children}`.

`parse` (`commandDescriptor.ts:233-251, 502+`) returns a `CommandDirective<A>` =
`UserDefined{value, leftover}` | `BuiltIn` (help/wizard/completions). It first tries
`parseBuiltInArgs` (`--help`/`--wizard`/`--version`), then `parseUserDefinedArgs`
(`:621-622`). Subcommands consume a leading token then recurse with the `leftover`
(`:655-695`). `cliApp.run` (`cliApp.ts:55-130`) strips the executable
(`splitExecutable`, `:137-145`), prefixes the command name (`prefixCommand`), parses, and on
`UserDefined` checks `leftover` is empty (else "Received unknown argument"). Help is rendered
via `HelpDoc.toAnsiText` (`:147`) — which is itself built on `@effect/printer`.

## Cross-repo comparison

The task is rooted in the `effect` repo; the second digest (`terminal-control` /
`termctrl`, Rust) is the **testing/observability** counterpart. They sit on opposite ends of
the same pipeline.

| Concern | effect (`@effect/*`) | termctrl (`terminal-control`) |
| --- | --- | --- |
| Role | **Produces** ANSI for prompts/CLIs | **Consumes/emulates** ANSI to capture real TUIs |
| Layout | Wadler/Leijen `Doc`→`DocStream`→string; `group`/`fits`/ribbon | None — feeds bytes into the `vt100` crate's `Parser` |
| ANSI model | Composable `Ansi` monoid + render-time style stack; absolute SGR | Parses SGR into cell attributes; resolves truecolor/256/16 in `frame.rs` |
| Cursor/erase | `eraseLines(n)` from text length ÷ columns (no buffer) | Full `vt100::Screen` cell grid as source of truth |
| Input | `readline` keypress → `Mailbox<UserInput>`; Ctrl-C closes mailbox | `key_bytes` named-key → escape-sequence encoder (`driver.rs:478`), paced typing |
| Unicode width | **`string.length`** — wrong for CJK/emoji | `cell.is_wide()`, clears the trailing cell (`frame.rs:85`) — **correct** |
| Capability probes | None (assumes a real TTY) | `Host` answers OSC 10/11, kitty graphics probes so apps don't hang |
| Redraw model | Render full frame + clear-and-reprint, no diffing | Settle loop: assert on *stable* visible state, reports `CaptureReason` |

**Where they agree:** ANSI is the lingua franca; both treat cursor/erase escapes as the
mechanism for in-place updates; both encode named keys → escape sequences.

**Where they differ / who's better:**
- **Unicode width:** termctrl is correct (wide-char continuation + trailing-cell clear);
  effect's `string.length`-based math is a known bug for CJK/emoji. If you build on effect's
  prompts, you must add `wcwidth`-style measurement yourself.
- **Screen model:** termctrl owns a real cell grid (`vt100`), so it can resize-by-reparse and
  dedupe frames; effect has no buffer, which is *simpler* and adequate for inline prompts but
  unsuitable for full-screen TUIs (would flicker, can't diff).
- **Robustness:** termctrl's `Host` capability-probe responder is the kind of thing a
  *driver* needs and a *producer* doesn't — but it's a reminder that real terminals are
  interrogated, and effect's prompts simply assume a cooperative TTY.

## Pitfalls & hard parts

- **`string.length` width math** (`ansi-utils.ts:58`, `layout.ts:73,265`). UTF-16 code units,
  not display columns. Wide/CJK/emoji and zero-width/combining characters break both the
  clear-row math and the `fits` calculation. There is no `wcwidth` anywhere in these packages.
- **No frame diffing, no buffer.** Each redraw fully clears (`eraseLines`) and reprints. Fine
  for a one-line prompt; flickers and is O(frame) for anything large.
- **Absolute SGR output.** Every style change re-emits `reset;…m` (`ansi.ts:354-363`). Larger
  output, but state-independent — you can splice fragments without tracking prior state.
- **`Union` invariant is unenforced.** First lines of the flat branch must be ≥ the
  multi-line branch. Hand-rolling `union` instead of `group` silently produces garbage.
- **`Line` indentation suppression** (`layout.ts:78-82`). Easy to forget when writing your own
  renderer: a `LineStream` before another line/empty must emit `indentation = 0` or you get
  trailing whitespace.
- **`Effect.runSync` inside `selectNicer`** (`layout.ts:144,150,153`). The `Effect` wrapping is
  *only* for trampolining/stack-safety — the layout is pure. Don't mistake it for async.
- **`display` must be uninterruptible** (`terminal.ts:77`). Otherwise an interrupt mid-write
  can tear an escape sequence and corrupt the terminal.
- **Raw mode must be a scoped resource.** If you set raw mode without `acquireRelease`, a
  crash leaves the user's terminal in raw mode (no echo, no line editing).
- **Windows glyph fallback** (`ansi-utils.ts:23-38`). The Unicode figures (`❯ ◉ ☒ ✔`) are
  swapped for ASCII (`> (*) [*] √`) on `win32` — don't hard-code the fancy glyphs.

## If you were building this from scratch (recommended approach + pseudocode)

Steal the **four-stage pipeline** and the **monoid annotations**, but fix the width bug.

```ts
// 1. Document algebra — tagged tree, reactive nodes for position-dependent layout
type Doc<A> =
  | Char | Text | Empty | Fail | Line
  | FlatAlt<A> | Cat<A> | Union<A> | Nest<A>
  | Column<A> | Nesting<A> | WithPageWidth<A>   // react: (state) => Doc<A>
  | Annotated<A>

const group = (d: Doc<A>): Doc<A> => {           // the ONE choice combinator
  const flat = flatten(d)
  return isNeverFlat(flat) ? d : union(flat.value, d)
}

// 2. Layout: explicit work-stack, lazy right branch, swappable `fits`
function best(pipeline, nl, col): DocStream<A> {
  // Cat(l,r) => push r then l; Nest adds indent; Line emits LineStream(indent)
  // Union(l,r) => fits(layout(l)) ? layout(l) : layout(r)   // r forced lazily
}
const fits = (stream, remaining) => /* scan to first Line/Empty; fail if <0 */

// 3. Render: walk DocStream, maintain a STACK of annotations
function render(stream, stack=[NONE]): string {
  Push(a): emit sgr(combine(a, peek(stack))); render(rest, [a, ...stack])
  Pop():   emit sgr(peek(tail(stack)));        render(rest, tail(stack))
  Line(n): "\n" + measureIndent(n)
}
// Annotation = monoid: per-field "first Some wins" + commands array concatenates

// 4. Terminal service — scoped raw mode, mailbox input, uninterruptible display
const Terminal = {
  readInput: acquireRelease(setRawMode(true), () => setRawMode(false))
    .pipe(then => mailbox of keypress events; Ctrl-C => close mailbox),
  display: (s) => uninterruptible(write(stdout, s)),
}

// 5. Render/update loop (Elm-style), restore cursor in finalizer
async function runLoop({initial, render, process, clear}) {
  let state = initial, action = NextFrame(state)
  try {
    while (true) {
      display(render(state, action))
      action = process(await input.take(), state)
      if (action == Beep) continue
      display(clear(state))                       // erase prior frame
      if (action == Submit) { display(render(Submit)); return action.value }
      state = action.state
    }
  } finally { display(cursorShow) }
}
```

**Improvements over effect:** (a) replace `string.length` with a real `wcwidth`/grapheme
measure (see the `string-width`/`get-east-asian-width` repos in this context dir) so clearing
and `fits` are column-correct; (b) for a full-screen app, keep a previous-frame cell buffer
and diff instead of clear-and-reprint (the termctrl `Frame`/`==` model shows the data
structure); (c) optionally emit *differential* SGR to shrink output. Keep effect's choices
that are genuinely good: the four-stage separation, `group`/`fits`, the annotation monoid +
render-time stack, and scoped raw mode.

## Source map

`@effect/printer` (the layout engine — the hard part):
- `printer/src/internal/doc.ts` — 13 constructors + all combinators; `group` at `:381`,
  reactive nodes `:411-439`, `align/hang/width` `:428-466`, line defs `:234-243`.
- `printer/src/internal/layout.ts` — `wadlerLeijen`/`best` `:41-135`, `selectNicer` `:137`,
  `fitsPretty` `:248`, `fitsSmart` `:305`, `compact` `:161`, `unbounded` `:407`.
- `printer/src/internal/layoutPipeline.ts` — the cons-list work-stack + `UndoAnnotation`.
- `printer/src/internal/docStream.ts` — the flat stream node model.
- `printer/src/internal/optimize.ts` — node fusion before layout.
- `printer/src/internal/pageWidth.ts` — `remainingWidth` / ribbon fraction.

`@effect/printer-ansi`:
- `printer-ansi/src/internal/ansi.ts` — `Ansi` monoid `:45-78`, cursor/erase helpers
  `:228-328`, `stringify` (always-reset) `:353-366`.
- `printer-ansi/src/internal/ansiRender.ts` — style-stack renderer `:61-114`, `render`
  style dispatch `:16-33`.
- `printer-ansi/src/internal/sgr.ts` — SGR → numeric codes → `…m`.

`@effect/platform` Terminal service:
- `platform/src/Terminal.ts` — the interface `:20-45`, `UserInput`/`Key` `:51-83`,
  `QuitException` `:92`.
- `platform-node-shared/src/internal/terminal.ts` — Node impl: scoped raw mode `:22-41`,
  `readInput` mailbox `:47-63`, `display` `:76-91`.

`@effect/cli`:
- `cli/src/internal/prompt.ts` — the `Loop/OnSuccess/Succeed` interpreter + `runLoop`
  `:208-245`.
- `cli/src/internal/prompt/select.ts` — concrete select widget (render/process/clear).
- `cli/src/internal/prompt/ansi-utils.ts` — `eraseText`/`lines` row counting, platform figures.
- `cli/src/internal/{args,options,primitive}.ts` — declarative arg/option ADTs.
- `cli/src/internal/{command,commandDescriptor}.ts` — command model, `parse`,
  `CommandDirective` (`commandDescriptor.ts:233`, `:502+`).
- `cli/src/internal/cliApp.ts` — entry point `run` `:55-130`, executable stripping `:137`.

Cross-reference (testing side): `terminal-control/src/{frame.rs,render.rs,driver.rs,shot.rs}`
for correct wide-char handling, ANSI parsing, key encoding, and capability-probe emulation.
