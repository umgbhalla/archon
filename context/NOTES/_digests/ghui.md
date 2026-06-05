# ghui

## What it is (1-2 lines)
A keyboard-driven terminal UI for reviewing GitHub PRs across repos, built on `@opentui/core` + `@opentui/react` (React 19 reconciler over a terminal renderer) with Effect for services/state. The standout artifact is `@ghui/keymap`: a tiny algebraic keybinding library where bindings are composable values and dispatch is a pure function — a genuinely clean reference for input handling in advanced TUIs.

## Architecture (how the pieces fit; key files with paths)
- **Entry / bootstrap**: `src/index.tsx`. Creates the renderer with `createCliRenderer({ screenMode: "alternate-screen", externalOutputMode: "passthrough", exitOnCtrlC: false })`, mounts via `createRoot(renderer).render(...)` (opentui/react). A two-phase boot: a synchronous `StartupLogo` paints immediately, then a `setTimeout(…, 0)` lazily `import()`s the heavy `App` + tree-sitter parsers and swaps the bundle in. ANSI control written directly to stdout for focus reporting (`\x1b[?1004h/l`) and forced full repaint (`\x1b[2J\x1b[3J\x1b[H`).
- **App shell**: `src/App.tsx` (~2800 lines) — the orchestrator. Wires Effect atoms (`@effect/atom-react`) to opentui JSX, builds the keymap context, and renders surfaces. Very import-heavy; it composes ~50 atoms + ~15 hooks.
- **Rendering primitives**: `src/ui/primitives.tsx`. Hand-built box-drawing widgets (`ModalFrame`, `StandardModal`, `SearchModalFrame`, `Divider`, `SeparatorColumn`, `TokenLine`, `HintRow`) on top of opentui's `<box>`/`<text>`/`<span>` intrinsics.
- **Diff engine**: `src/ui/diff.ts` (pure patch parsing/layout math), `src/ui/PullRequestDiffPane.tsx` (renders opentui's native `<diff>` renderable), `src/ui/diff/useDiffLineColors.ts` (imperative per-line coloring of comment anchors).
- **Input / keymap library**: `packages/keymap/src/*` — the reusable algebra. App-side bindings live in `src/keymap/*` (one file per context: `listNav.ts`, `diffView.ts`, modals…), composed in `src/keymap/all.ts`. Bridged to opentui in `src/keyboard/opentuiAdapter.ts`; raw text input routed in `src/ui/useTextInputDispatcher.ts`.
- **Commands**: `src/commands/*` — a registry of Effect-backed commands (`dispatch.ts`, `atoms.ts`, `builtins.ts`) for the command palette, decoupled from key bindings (keymap handlers call `runCommandById`).
- **Services**: `src/services/*` — `GitHubService` (shells out to `gh`), `CacheService` (sqlite via `@effect/sql-sqlite-bun`), clipboard, browser opener, all behind an Effect runtime (`runtime.ts`).
- **Theming**: `src/ui/colors.ts` (~1400 lines) — mutable `colors` palette object, ~25 named themes + a "system" theme generated from the terminal's OS palette read at runtime.

## Core techniques

### Keymap algebra (the crown jewel) — `packages/keymap/src/`
A `Keymap<C>` is an immutable list of `Binding<C>` parametric in a context type `C` (`keymap.ts:55`). The combinators form a closed algebra:
- **Monoid** under `union` (identity `Keymap.empty()`), `keymap.ts:70`.
- **Contravariant** in `C`: `contramap(project: C2 => C)` lifts a narrow-context keymap into a wider one (`keymap.ts:78`). `scope(project: C2 => C | null | undefined | false)` is the falsy-friendly partial lift — when the projection is falsy the binding is inactive, letting you write `km.scope(a => a.modalActive && a.modal)` instead of ternaries (`keymap.ts:92`, lift impl `liftBindingScope` at `keymap.ts:12`).
- **`restrict(pred)`** AND-merges a predicate into every binding's `when` (`keymap.ts:101`); **`prefix("g")`** prepends a stroke to every sequence for leader keys (`keymap.ts:108`).
- `context<C>()` returns a callable so command literals infer `s: C` without per-call generics (`context.ts:28`).

**Dispatch is a pure function** — `pureDispatch(keymap, state, stroke, ctx, now, opts) → {state, decision}` (`pure-dispatch.ts:58`). State is just data: `{ pending: ParsedStroke[], timeoutAt: number|null }`. Multi-stroke sequences (e.g. `g g`) are resolved by classifying matches into `exact` vs `continuing` (`findMatches`, `pure-dispatch.ts:26`):
- exact + no continuation → run now;
- continuation present (with or without an exact match) → become `pending` with `timeoutAt = now + 500ms` (disambiguation window);
- no match with pending → drop pending and retry the stroke fresh (`pure-dispatch.ts:75`).
`pureTick` fires the pending exact binding when the timeout elapses, **re-evaluating against the current ctx** (not the ctx captured at keypress) so state changes between strokes stay correct (`pure-dispatch.ts:96`). `createDispatcher` (`dispatcher.ts:47`) is a thin stateful wrapper holding the timer + listeners; it's injected a `Clock` so tests run without fake timers.

### Layered input precedence — `src/keymap/all.ts`
The whole app's bindings are one `appKeymap = App(...)`. Every layer is the same sub-keymap `.scope`d behind its active-flag (`all.ts:89`). Precedence is encoded by ordering: command-palette opener and quit first (gated `when: !textInputActive`), then each modal layer, then full-view layers gated `!modalActive(a)`, then list nav gated `inListMode(a)`. A single flat `AppCtx` (`all.ts:21`) carries both boolean active-flags and the per-layer narrow contexts; `buildAppCtx` (`src/keymap/contexts/appCtx.ts`) assembles it each render.

### opentui bridge & dual input paths — `src/keyboard/opentuiAdapter.ts`, `src/ui/useTextInputDispatcher.ts`
opentui `KeyEvent` → `ParsedStroke` normalization folds `option` into `meta` for cross-platform modifiers and renames `enter`→`return` (`opentuiAdapter.ts:7,17`). A single `useKeyboard` fans out to a `Set` of handlers so multiple subscribers (keymap dispatcher + text-input fallback) don't stack listeners; if any handler returns truthy it calls `event.preventDefault()` (`opentuiAdapter.ts:32`). **Two parallel input systems**: action keys (q, esc, enter, ctrl+*) go through the keymap; raw printable text (query/body accumulation) goes through `useTextInputDispatcher`, which hard-codes a linear modal precedence chain so "who owns typing right now" stays linearizable (`useTextInputDispatcher.ts:55`).

### Diff parsing & layout math — `src/ui/diff.ts` (pure, no React)
- `splitPatchFiles` splits a unified diff on `diff --git` (handles quoted/escaped paths via `readDiffPath`), derives filetype with opentui's `pathToFiletype` (`diff.ts:308`).
- `normalizeHunkLineCounts` recomputes `@@ -a,b +c,d @@` counts after edits so hunks stay valid (`diff.ts:131`).
- **Whitespace-only-change collapsing**: `minimizeWhitespacePatch` runs an LCS over whitespace-stripped lines to merge -/+ pairs that differ only in whitespace into a single context line. It falls back to a linear greedy matcher when the DP grid would exceed `MAX_WHITESPACE_LCS_CELLS = 40_000` to bound cost (`diff.ts:165,195,280`).
- **Render-line accounting**: `buildStackedDiffFiles` precomputes each file's `headerLine`/`diffStartLine`/`diffHeight` to lay files end-to-end in one scrollbox; `stackedDiffFileIndexAtLine` does a binary search for the sticky header (`diff.ts:330,348`). `getDiffCommentAnchors` walks the patch tracking old/new line numbers AND visual render lines for both unified and split views, padding the shorter side so the two columns align (`alignSplitSides`, `diff.ts:429`). Wrapped-line height is estimated with `Bun.stringWidth` (Unicode-aware width) over the content width (`diff.ts:609`).

### Native `<diff>` renderable + imperative line coloring — `PullRequestDiffPane.tsx`, `useDiffLineColors.ts`
opentui ships a `<diff>` intrinsic that does syntax highlighting (tree-sitter, `SyntaxStyle.fromStyles` mapping capture names → colors, `diff.ts:60`) and split/unified rendering. ghui renders one `<diff>` per file inside a `<scrollbox>` with `syncScroll` (`PullRequestDiffPane.tsx:217`). Comment-line highlighting can't go through props (it's per-line state), so `useDiffLineColors` grabs each `DiffRenderable` ref and calls `setLineColor(colorLine, {gutter, content})` imperatively (`useDiffLineColors.ts:73`). It maintains a clear-then-reapply protocol keyed by a `contextKey`, and — because opentui layout settles a frame or two after mount — runs a **retry loop** (`DIFF_LINE_COLOR_REAPPLY_ATTEMPTS = 8` every `16ms`) re-applying colors until the layout stabilizes (`useDiffLineColors.ts:176`). On ref (re)register it re-applies cached colors so remount-then-color stays stable.

### Sticky headers, mouse hit-testing, manual box drawing
- Sticky file header: an absolutely-positioned `<box position="absolute" zIndex={10}>` over the scrollbox, swapping to the incoming file header when its boundary is one row away (`PullRequestDiffPane.tsx:244`).
- Mouse → diff line: `handleDiffMouseDown` converts viewport-relative `event.y`/`event.x` into a scroll line and a LEFT/RIGHT side using `this.viewport` + `this.scrollTop` (`PullRequestDiffPane.tsx:194`).
- All borders are drawn by hand from box-drawing chars. `ModalFrame` builds top/side/bottom rows char-by-char and supports junction chars (`├`/`┤`/`┬`/`┴`) at specified rows/columns so internal dividers connect to the frame (`primitives.tsx:428`). Convention enforced in AGENTS.md: dividers inside modals must thread `junctionRows`.

### Runtime theming from the terminal palette — `src/ui/colors.ts`, `src/index.tsx`
`colors` is a **mutable object**; `setSystemThemeColors` mutates it in place and the next render picks it up (theme swap without prop threading). The "system" theme is generated from the live terminal palette read via `renderer.getPalette({ timeout, size: 16 })` after `clearPaletteCache()` (`index.tsx:82`). A `grayscaleRamp` synthesizes panel/border grays from background luminance, `mixHex` does linear RGB blending for diff backgrounds and hover states, and `lineNumberTextColor` enforces a minimum contrast ratio (`colors.ts:117,129,182`). OS light/dark changes are picked up via a `SIGUSR2` handler that re-reads the palette (`index.tsx:100`).

## Code patterns worth stealing

Pure, testable, composable keybindings:
```ts
const Diff = context<DiffState>()
const diffKeymap = Diff(
  scrollCommands<DiffState>(),                               // reusable vim-scroll keymap, lifted by structural typing
  { id: "diff.close", title: "Close", keys: ["escape"], run: (s) => s.close() },
)
// One app keymap; layers are sub-keymaps scoped behind an active flag:
const appKeymap = App(
  diffKeymap.scope((a) => a.diffFullView && !modalActive(a) && a.diff),
  listNavKeymap.scope((a) => inListMode(a) && a.listNav),
)
// Dispatch is pure: (keymap, state, stroke, ctx, now) -> (state, decision)
```

Single fan-out keyboard listener (avoid stacking `useKeyboard`):
```ts
const handlers = useRef(new Set<Handler>())
useKeyboard((e) => {
  let handled = false
  for (const h of handlers.current) if (h(normalize(e))) handled = true
  if (handled) e.preventDefault()
})
return (h) => { handlers.current.add(h); return () => handlers.current.delete(h) }
```

Imperative per-line color with a layout-settle retry loop (opentui renderables settle async):
```ts
const setDiffRef = (i, diff) => { if (diff) refs.current.set(i, diff); reapply(i) }
// on selection change: clear previous entries, apply new, then retry N times @16ms
```

Precompute layout offsets so a flat scrollbox can host N stacked sub-views + binary-search the sticky header:
```ts
buildStackedDiffFiles(files) // -> { headerLine, diffStartLine, diffHeight } per file
stackedDiffFileIndexAtLine(stacked, scrollTop) // binary search
```

## Gotchas / non-obvious decisions
- **Two input pipelines, ordered by hand.** Keymap (actions) and `useTextInputDispatcher` (raw text) are separate; the text dispatcher's precedence chain is "the load-bearing invariant" — break the order and the wrong modal eats your keystrokes. `textInputActive` gates single-letter action keys (q, ?) off while editing.
- **Disambiguation timeout re-reads ctx.** A pending `g`+timeout fires against *current* ctx via `pureTick`, not the ctx at first keypress — necessary because actions between strokes can change scope.
- **Mutable global `colors`** trades React purity for a zero-prop theme swap; renders rely on re-render being triggered elsewhere (a `themeGeneration` counter bumps `useMemo` deps, e.g. the syntax style at `PullRequestDiffPane.tsx:124`).
- **Diff line coloring needs a retry loop** because opentui `DiffRenderable` line geometry isn't ready on mount; a single apply flickers/misses.
- **`enter`→`return` rename and `option`→`meta` fold** at the adapter boundary keep the keymap cross-platform; all bindings use `return`/`meta`.
- **Lazy bootstrap** keeps first paint instant: tree-sitter wasm + the App module are dynamically imported after the logo renders. `GHUI_FORCE_FULL_REPAINT_ON_START` and a `SIGWINCH` self-kick work around terminals not repainting on alt-screen entry.
- **Effect everywhere off the render path**: commands return Effects run in a `githubRuntime`, dispatched from React via `useAtomSet(dispatchCommandAtom, { mode: "promise" })`; unknown command ids resolve silently (`commands/dispatch.ts`).
- LCS whitespace-collapse has an O(n·m) guard (`MAX_WHITESPACE_LCS_CELLS`) falling back to a linear matcher on huge diffs.

## Relevance (advanced-TUI topics this teaches)
- **input-keyboard-mouse** — the keymap algebra + pure dispatcher + multi-stroke disambiguation + mouse hit-testing is the best-in-class part of this repo.
- **reconciler-component-models** — clean React-19-on-opentui binding: `createRoot(renderer)`, intrinsics (`box`/`text`/`span`/`scrollbox`/`diff`), refs to native renderables, lazy mount.
- **rendering-pipeline** — alternate-screen setup, forced repaint, sticky absolute overlays, imperative per-line coloring with settle retries, syntax highlighting via tree-sitter `SyntaxStyle`.
- **layout** — manual box-drawing frames with junction chars, precomputed stacked-view offsets, split/unified two-column alignment math.
- **ansi-escapes** — direct stdout control sequences for focus reporting and full repaint.
- **unicode-text-width** — `Bun.stringWidth` for wrapped-line height estimation; `fitCell`/`trimCell` truncation with ellipsis.
- **app-architecture** — Effect runtime + atoms for state/services, command registry decoupled from key bindings, flat-context layered keymap.
- **widgets-rich-content** — diff viewer, command palette, modal system, themable palette generated from terminal colors.
