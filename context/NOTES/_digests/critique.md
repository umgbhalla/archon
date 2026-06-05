# critique

A Bun-only terminal UI (`bunx critique`) for reviewing git diffs: syntax-highlighted split/unified diff with word-level highlight, directory tree, theme picker, fuzzy file jump, watch mode, plus headless render-to-ANSI / render-to-HTML / render-to-image / web-share paths. Built on `@opentuah/core` + `@opentuah/react` (an opentui fork) driving React 19.

## What it is (1-2 lines)
React-on-opentui git diff viewer. The opentui library supplies the actual `<diff>` renderable (split view, word-diff, tree-sitter highlighting); critique's value is everything *around* it: git plumbing, diff preprocessing to keep tree-sitter sane, theme system, layout/scroll UX, and three off-screen capture pipelines (ANSI, HTML, PNG).

## Architecture (how the pieces fit; key files with paths)
All TUI code lives under `cli/src/`. The `<diff>`, `<scrollbox>`, `<box>`, `<text>` JSX intrinsics are opentui renderables; critique never implements its own grid/buffer.

- `cli/src/cli.tsx` (2.8k lines) — CLI command tree (uses a `goke`/cac-style builder), all run-modes (interactive `App`, `--watch`, `--web`, `--pdf`, `--image`, scrollback, resume, pick). The interactive `App` component (line 1503) is the heart: state, keyboard, scroll, layout tree.
- `cli/src/diff-utils.ts` — git command builder + diff parsing/enrichment. Builds `git diff` invocations (`buildGitCommand`, line 304), preprocesses raw diff for rename/copy (`preprocessDiff`, line 74), parses via the `diff` npm package's `parsePatch`, detects file status, maps extension→tree-sitter language (`detectFiletype`, line 586).
- `cli/src/components/diff-view.tsx` — thin `<diff>` wrapper: converts a resolved theme to the ~15 color props opentui's diff needs, computes word-highlight backgrounds, calls `balanceDelimiters` before passing the patch in.
- `cli/src/balance-delimiters.ts` — the cleverest module: repairs unbalanced multi-line delimiters per-hunk so tree-sitter doesn't mis-highlight.
- `cli/src/directory-tree.ts` — builds the file tree, collapses single-child dirs, and (critically) defines deterministic file *order* used everywhere.
- `cli/src/themes.ts` — 30+ OpenCode JSON themes, lazily loaded, ref-resolved, exposed as both UI `RGBA`s and a tree-sitter `SyntaxStyle`.
- `cli/src/ansi-output.ts` — `CapturedFrame` → ANSI escapes with truecolor/256/16/none fallback (scrollback mode).
- `cli/src/web-utils.tsx` — headless render of the same React tree to a `CapturedFrame` using opentui's `createTestRenderer`, then to HTML; includes the highlight-stabilization wait loop.
- `cli/src/opentui-image.ts` — `CapturedFrame` → PNG via takumi.
- `cli/src/dropdown.tsx` — reusable fuzzy-search overlay (file jump + theme picker).
- `cli/src/patch-terminal-dimensions.ts` — Bun `--compile` workaround for `stdout.columns === 0`.
- `cli/src/store.ts` — zustand store (persisted theme name).

Data flow (interactive): git → raw diff string → `stripSubmoduleHeaders` → `parseGitDiffFiles` (rename-aware `parsePatch`) → `processFiles` (filter lockfiles/huge files, reorder by tree, attach `rawDiff` via `formatPatch`) → `App` maps each file to a `<DiffView>` whose `diff` prop is run through `balanceDelimiters` → opentui `<diff>` renderable does tree-sitter highlighting + split/unified layout. The headless modes reuse the *same component tree* via `createTestRenderer`.

## Core techniques (the actual TUI engineering)

### Don't reinvent the diff renderable — feed it correctly
The hard rendering (split view, word-level intra-line diff, line numbers, tree-sitter spans) is opentui's `<diff>`. Critique's job is preprocessing the patch and theming. The two genuinely hard preprocessing problems are tree-sitter boundary state and theme-correct highlight colors.

### Delimiter balancing for per-hunk tree-sitter (`balance-delimiters.ts`)
Tree-sitter highlights each hunk's text in isolation, but a hunk can begin or end *inside* a multi-line construct (template literal, `"""`docstring, `/* */`, markdown ``` fence). An unmatched delimiter makes tree-sitter treat the rest of the hunk as string/comment and kills highlighting. The fix (per hunk, per language rule in `LANGUAGE_DELIMITERS`, line 55):
- **Tokenize** content lines (strip the `+`/`-`/` ` prefix), counting unescaped delimiter occurrences. `findDelimiterColumns` (line 78) walks char-by-char, `\\` skips next char, and special-cases `` `'`'`` (quoted backtick) so it isn't counted.
- **Symmetric delimiters** (`` ` ``, `"""`): if count is odd, classify the lone boundary token as opener vs closer using surrounding-char heuristics (`classifyOccurrence`, line 216 — looks at prev/next non-whitespace char, whether content exists before/after in the hunk). If it's a stray closer, *prepend* a synthetic opener to an earlier content line; if a stray opener, *append* a closer to the last content line. Crucially it keeps the real boundary token intact and synthesizes its partner inline (no new lines → patch `@@` line counts stay valid).
- **Asymmetric delimiters** (`/* */`, `<!-- -->`): `getUnclosedTokenCount` (line 483) walks open/close depth from both possible start states, picks fewer conflicts, appends N closers so the *next* hunk starts clean (hunk isolation).
- **Markdown fences** are context-dependent (`` ``` `` opens if it has an info string, closes if bare). `repairContextualFences` (line 399) simulates a depth walk from both start states (`walkFences`), picks the lower-conflict / fewer-repair one, and tie-breaks on whether content precedes the first fence. Avoids creating a fake info string by preferring a blank line for the synthetic opener (`prependOpeningTokenToFirstContentLine`, line 555).

### Rename/copy preprocessing the `diff` package can't do (`preprocessDiff`, diff-utils.ts:74)
`parsePatch` silently drops git's `rename from`/`rename to`/`similarity index` headers and produces broken entries for *pure* renames (100% similarity has no `---`/`+++`/`@@`). Critique splits the raw diff at `diff --git` boundaries, extracts rename metadata into a `Map<sectionIndex, RenameInfo>`, and **injects synthetic `--- old` / `+++ new` headers** for pure renames so `parsePatch` yields a proper entry, then re-attaches the metadata (`parseGitDiffFiles`, line 181). Note `--no-prefix` is used so "different old/new name" alone signals a rename.

### git command construction (`buildGitCommand`, diff-utils.ts:304)
Always `-M` (rename detection), `--submodule=diff`, `-U<context>`, `--no-prefix`. Range syntax is disambiguated: two refs or `A...B` → three-dot merge-base diff (GitHub-PR semantics); `A..B` → two-dot. A `--commit` containing `..` is rerouted to base handling because `git show` with ranges interleaves unparseable commit metadata. Default (no args) does `git add -N .` so untracked files appear, and `--ignore-submodules=all` because dirty submodule diffs are fetched separately (`getDirtySubmodulePaths` via `git submodule foreach` checking `git status --porcelain`).

### Deterministic file ordering driven by the tree (directory-tree.ts + processFiles)
Both interactive and headless paths order files by walking the *rendered* directory tree, not git's emission order: `buildDirectoryTree` sorts every level alphabetically (`sortInternalTree`, line 123) and collapses single-child directories (`collapseNode`, line 135, building paths like `src/components`). `processFiles` (diff-utils.ts:520) then reorders the parsed files to match `treeFileOrder`, with a defensive fallback that appends any unmatched file. So the tree at the top and the diff sections below are guaranteed to be in the same order — important because scroll-to-file maps tree clicks to section refs.

### Theme-aware word-highlight color computation (diff-view.tsx:35)
opentui's default word-diff highlight is `base.brighten(1.1)` — imperceptible on near-black diff backgrounds. `getWordHighlightBg` computes luminance; for light bg it darkens (`brighten(0.9)`), for dark bg it escalates `brighten(2.4 → 3.0 → 3.6)` until luminance delta ≥ 0.09, and for pure-black bg falls back to an *additive* lift (multiplicative brighten can't move black). The `<diff>` receives ~15 explicit color props (added/removed/context bg, line-number bgs, word bgs, selection colors) so light themes don't inherit dark defaults.

### Headless render with highlight stabilization (web-utils.tsx)
`--web`/`--image`/`--pdf` render the *same React component tree* off-screen via `@opentuah/core/testing`'s `createTestRenderer` → `CapturedFrame` (a structured `lines[].spans[]` with fg/bg/attributes). Two non-obvious problems solved:
- **Content fitting**: render at an initial height, measure real content via `getContentHeight` (sums child `getComputedLayout().top + height`, line 82), `resize` to exact height, render again. Avoids allocating a huge buffer.
- **Async highlight race** (`waitForHighlightAndRenderStabilization`, line 134): tree-sitter highlighting is async, and opentui's `DiffRenderable` schedules a split-view rebuild via `queueMicrotask` *after* `isHighlighting` goes false. Phase 1 polls `DiffRenderable.isHighlighting` (found by `instanceof` tree walk) until all false; Phase 2 monkey-patches `renderer.root.requestRender` to timestamp each call and waits for an 80ms idle gap. Without phase 2 the captured frame can show un-highlighted content on one split side.

### CapturedFrame → ANSI fallback ladder (ansi-output.ts)
`getColorLevel()` uses `supports-color` (non-TTY → 0 → plain text; respects FORCE_COLOR/NO_COLOR). Spans render to `38;2;r;g;b` (truecolor), `38;5;idx` (256, via 6×6×6 cube + grayscale ramp in `rgbTo256`), or `3N`/`9N` (16-color). Since terminals have no alpha, colors are pre-blended against the theme bg (`blendWithBackground`). Trailing empty lines are trimmed. Text attributes map opentui's `TextAttributes` bitflags to SGR codes.

### Input & scroll UX (cli.tsx App)
- Single `useKeyboard` handler with a modal guard: if dropdown/theme-picker is open, only Escape is handled. `q`/Escape → `renderer.destroy()`.
- Vim navigation: `gg` via a `lastKeyRef` double-tap within 300ms → `scrollbox.scrollTo(0)`; `Ctrl+D`/`Ctrl+U` → `scrollBy(±0.5, "viewport")`.
- `option` key (held) sets a scroll multiplier of 10 on a `ScrollAcceleration` wrapper (around opentui's `MacOSScrollAccel`), reset on `eventType === "release"` — leverages keyboard release events.
- Scroll-to-file: `scrollToFile` (line 1646) reads a file section's `BoxRenderable.y` minus `scrollbox.content.y` and calls `scrollTo`, using refs collected in `fileRefs: Map<number, BoxRenderable>`.

### Layout (cli.tsx:1744)
Flexbox via opentui yoga: outer `flexDirection: column, height: "100%"`. Overlays (dropdown/theme picker) are `flexShrink: 0, maxHeight: 15` boxes rendered *above* a single always-mounted `<scrollbox flexGrow:1>` (comment at line 1743: scrollbox is never remounted so scroll position survives theme changes — the `<box key={themeName}>` remount is pushed down into `DiffView`). Footer is `flexShrink: 0` with a `<box flexGrow={1}/>` spacer for right-alignment. Split-vs-unified is per-file: `getViewMode` (diff-utils.ts:502) forces unified for pure-add/pure-delete files (one side would be empty) and otherwise switches on `cols >= splitThreshold` (100 TUI, 150 web).

## Code patterns worth stealing

Synthesize a delimiter's partner inline rather than rewriting hunk headers (keeps `@@` counts valid):
```ts
// append closer to last content line of the hunk
const lastIdx = [...lines].findLastIndex(isDiffContentLine)
lines[lastIdx] = `${lines[lastIdx]} ${closeToken}`
// prepend opener, preferring a blank line so tree-sitter doesn't read a fake info string
```

Dual-start-state walk to pick the interpretation with fewest conflicts:
```ts
const walk0 = walkFences(fences, 0) // assume start outside a block
const walk1 = walkFences(fences, 1) // assume start inside
const chosen = walk0.conflicts !== walk1.conflicts
  ? (walk0.conflicts < walk1.conflicts ? walk0 : walk1)
  : tieBreakByRepairsThenContentPosition()
```

Wait for an async renderable to quiesce by monkey-patching requestRender:
```ts
const orig = renderer.root.requestRender.bind(renderer.root)
renderer.root.requestRender = () => { lastRenderTime = Date.now(); orig() }
// then poll until (now - lastRenderTime) >= idleMs
```

Inject synthetic patch headers so a strict parser accepts pure renames:
```ts
if (!hasFileHeaders && renameFrom && renameTo)
  out.push([...sectionLines, `--- ${renameFrom}`, `+++ ${renameTo}`].join("\n"))
```

Pre-blend alpha against theme bg because terminals have no transparency:
```ts
const [r,g,b] = [c.r*c.a + bg.r*(1-c.a), c.g*c.a + bg.g*(1-c.a), c.b*c.a + bg.b*(1-c.a)]
```

Keep scroll state across re-themes by never remounting the scroll container; remount only the colored leaf (`<box key={themeName}>` inside DiffView).

## Gotchas / non-obvious decisions
- **Bun-only.** `Bun.Glob` for file filters, `bun --compile` binaries, lazy dynamic `import()` everywhere for startup speed (only the default `github` theme is statically imported).
- **`stdout.columns === 0` in compiled Bun binaries** even when `isTTY` — patched at module load via `tput cols/lines` *before* importing opentui, because opentui reads dimensions at init and `?? fallback` doesn't catch `0`. Re-patched on SIGWINCH (patch-terminal-dimensions.ts).
- **Lockfiles and huge files are dropped** (`IGNORED_FILES`, `.lock`, and any file with >6000 hunk lines) in `processFiles`.
- **`--no-prefix` semantics**: with no `a/`/`b/` prefixes, "old name ≠ new name" is itself the rename signal (`getFileStatus`/`getFileName`).
- **Submodules**: stripped of git's status header lines (`stripSubmoduleHeaders`) that `parsePatch` can't parse; dirty submodule content is diffed in a *separate* pass and appended, then re-filtered by glob (git pathspec no longer applies after concatenation).
- ErrorBoundary class needs `@ts-ignore` against `@opentuah/react`'s `ElementClass` / React 19 type mismatch (works at runtime).
- The microtask-deferred split-view rebuild in opentui is the reason the headless capture needs *two* wait phases, not one — a subtle source of half-unhighlighted screenshots.

## Relevance (advanced-TUI topics this teaches)
- **reconciler-component-models** — React 19 on a custom opentui reconciler; same component tree reused for interactive *and* headless (testRenderer) rendering; ErrorBoundary, refs to `BoxRenderable`/`ScrollBoxRenderable`.
- **widgets-rich-content** — driving a rich `<diff>` widget (split/unified, word-diff, line numbers) and a fuzzy-search dropdown; the real lesson is *preparing data* (delimiter balancing, theming) for a third-party widget.
- **rendering-pipeline** — `CapturedFrame` (lines→spans) as an intermediate representation feeding three backends (ANSI, HTML, PNG); content-fit measure-resize-rerender loop; quiescence detection for async highlighting.
- **ansi-escapes** — full SGR truecolor/256/16/none fallback ladder with 6×6×6 cube + grayscale quantization and alpha pre-blending.
- **layout** — yoga/flexbox column layout, always-mounted scrollbox to preserve state, per-file split/unified decision keyed on terminal width, spacer-box right alignment, tree collapse.
- **input-keyboard-mouse** — modal keyboard routing, vim `gg`/`Ctrl+D`/`Ctrl+U`, key *release* events for held-modifier scroll acceleration, mouse-up clipboard copy, click-to-scroll via measured renderable positions.
- **app-architecture** — zustand persisted store, lazy dynamic imports for startup, multi-mode CLI sharing one component tree, git plumbing isolated in diff-utils.
