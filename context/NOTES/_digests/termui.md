# termui

## What it is (1-2 lines)
A TypeScript/React terminal-UI framework built **on top of Ink** (it does not write its own renderer/reconciler — Ink + Yoga do layout/diffing). Its value-add is a large themed component library (100+), capability-aware ANSI utilities, AI-streaming hooks/components, and two non-React "imperative prompt" APIs (clack-style) that mount/unmount Ink under the hood.

## Architecture (how the pieces fit; key files with paths)
pnpm monorepo. Root `src/*.ts` are thin re-export shims (`src/index.ts` = `export * from '@termui/core'` + `'@termui/components'`). Real code lives in `packages/`:

- `packages/core` — terminal primitives + hooks + theming. No Ink-renderer code; it wraps/extends Ink.
  - `core/src/terminal/` — `ansi.ts` (escape codes, color downsampling), `capabilities.ts` (env-based feature detection, cached), `borders.ts` (Unicode↔ASCII box chars).
  - `core/src/hooks/` — `useInput.ts` (wraps Ink), `useMouse.ts` (raw SGR mouse parsing — NOT via Ink), `useVirtualScroll.ts` (windowing math), `useKeymap.ts` (declarative bindings), `usePushToTalk.ts`, `useUnicode.ts`, `useFocus*`, `useMotion.ts`.
  - `core/src/styling/` — `ThemeProvider.tsx` (+ `AutoThemeProvider` light/dark detection), `tokens.ts`, 8 themes under `themes/`.
- `packages/components` — pure presentational React/Ink components grouped by domain: `ai/`, `charts/`, `data/`, `forms/`, `input/`, `layout/`, `navigation/`, `overlays/`, `selection/`, `typography/`, etc. AI ones: `ChatThread`, `ThinkingBlock`, `ToolCall`, `ToolApproval`, `TokenUsage`, `ModelSelector`, `ConversationHistory`, `FileChange`, `ErrorRetry`.
- `packages/adapters` — wrappers around popular CLI libs as optional peers, each a folder: `ai/` (provider streaming hooks), `imperative/` (readline-based prompts), `clack-ink/` (Ink-mount prompts), `pty/` (node-pty), `voice/`, `chalk/`, `clack/`, `ora/`, `commander/`, `meow/`, etc.
- `packages/cli` — shadcn-style `termui add <component>` codegen; `packages/testing` — `createTestRenderer`.

The "hybrid" model: components are React/Ink; imperative APIs (`adapters/imperative`, `adapters/clack-ink`) expose `await text()/select()/confirm()` for non-React CLI flows.

## Core techniques

**Capability detection (`core/src/terminal/capabilities.ts`)** — single cached `getTerminalCapabilities()` reads env to flag Unicode, 256/truecolor, mouse, OSC-8 hyperlinks, ConPTY, WSL, VS Code, tmux, CI.
- Terminal ID via env precedence: `WT_SESSION`→windows-terminal, `TERM_PROGRAM`→vscode/iterm/hyper/apple, `TMUX`, `TERM=xterm-kitty`, `ALACRITTY_*`, `WEZTERM_EXECUTABLE`, `MSYSTEM`→git-bash (`:43`).
- Truecolor = `COLORTERM=truecolor|24bit` OR WT/vscode/iTerm; respects `NO_COLOR` and `FORCE_COLOR` 1/2/3 levels (`:79`).
- Unicode: `NO_UNICODE=1` forces ASCII; classic cmd.exe and MSYS2 return false (`:60`).

**Color depth downsampling (`ansi.ts:172-271`)** — the genuinely clever part. `downsampleColor(hex, depth)` maps a hex color to truecolor/256/16/none:
- `nearestAnsi256`: maps RGB into the xterm 6×6×6 cube (`16 + 36r + 6g + b`) AND the 24-step grayscale ramp (232–255), then picks whichever has smaller squared RGB distance — so near-grays snap to the gray ramp instead of muddy cube cells.
- `nearestAnsi16`: brute-force nearest over a hand-tuned 16-color palette; emits `\x1b[3Nm` for 0-7, `\x1b[9(N-8)m` for bright.
- Distance uses squared Euclidean (no sqrt — comparison only).

**Mouse input (`core/src/hooks/useMouse.ts`)** — bypasses Ink. On mount writes `\x1b[?1000h` (basic) + `?1002h` (button-event tracking) + `?1006h` (SGR extended coords); on unmount writes the `l` disables. Parses raw stdin with `/\x1b\[<(\d+);(\d+);(\d+)([Mm])/`: trailing `M`=press, `m`=release; modifier bits ctrl=`cb&16`, meta=`cb&8`, shift=`cb&4`; scroll detected via `cb&64` (`buttonCode 0`=up else down); button = `cb&3` → left/middle/right. No-op when `!isTTY`.

**Virtual scroll windowing (`core/src/hooks/useVirtualScroll.ts`)** — pure, testable arithmetic separated from the hook:
- `adjustScrollOffset`: only moves offset when the focused item is above/below the viewport (sticky scrolling).
- `computeRanges`: `visibleStart = floor(offset/itemSize)`, then expands by `overscan` (default 2) on both sides, clamped to `[0, itemCount-1]`.
- Hook layers `useInput` for ↑/↓/PgUp/PgDn/Home/End with optional `loop` wrap; only renders `items.slice(startIndex, endIndex+1)`.

**Borders / Unicode fallback (`borders.ts`, `useUnicode.ts`)** — `getBorderChars('auto')` returns Unicode box-drawing or ASCII `+|-` based on caps. `resolveBoxBorder` maps to Ink's `'classic'` style when ASCII. `UnicodeContext` (React) is seeded by ThemeProvider from `isNoUnicode()`; components call `useUnicode()` to pick glyph vs ASCII (e.g. spinner frame).

**Imperative prompts — two strategies:**
- `adapters/imperative/index.ts` — does NOT use React. Uses Node `readline` + raw ANSI string constants (`BOLD`, `DIM`, etc.). `text/select/multiselect/confirm` re-prompt recursively on validation failure (`tryPrompt()`). `spinner()` is a manual `setInterval` braille-frame loop that writes `\r\x1b[K` (CR + clear-line) each tick. Simple, dependency-light, works without a React tree.
- `adapters/clack-ink/index.tsx` — the React bridge. Each prompt returns a Promise; inside, `render(<ThemeProvider><Select onSubmit={v => { resolve(v); unmount(); }}/></ThemeProvider>)` then `waitUntilExit()`. Mount → await submit → unmount per call. Fully themed.

**OSC sequences (`ansi.ts:141`)** — OSC-8 hyperlinks `\x1b]8;;url\x1b\\text\x1b]8;;\x1b\\`, OSC-52 clipboard write (base64 + BEL), OSC-0 window title.

**ANSI stripping/width (`ansi.ts:159`)** — inline regex stripper (`visibleWidth` = stripped `.length`). Note: this is naive `.length`, NOT grapheme/east-asian-width aware (see Gotchas).

## Code patterns worth stealing

**Streaming AI hook — ref-as-source-of-truth to dodge React batching (`adapters/ai/index.ts:47`):**
```ts
const messagesRef = useRef<Message[]>([]);   // source of truth, synchronous
const [messages, setMessages] = useState([]); // only to trigger re-renders
async function sendMessage(text) {
  messagesRef.current = [...messagesRef.current, {role:'user',content:text}];
  setMessages(messagesRef.current);          // history correct BEFORE any await
  const controller = new AbortController();
  // push empty assistant placeholder, then mutate it per chunk:
  for await (const chunk of stream) {
    if (controller.signal.aborted) break;
    const updated = messagesRef.current.slice();
    updated[updated.length-1] = {role:'assistant', content: acc += chunk};
    messagesRef.current = updated; setMessages(updated);
  }
}
```
Key idea: a stale React-state closure would corrupt multi-turn history; the ref is read synchronously so `sendMessage` always sees current messages. `optionsRef.current = options` every render keeps the `useCallback([])` stable yet fresh.

**Provider abstraction = async generators (`ai/index.ts:201`):** `createStream` dispatches to `streamAnthropic`/`streamOpenAI`/`streamOllama`, each an `async function*` that `yield`s text deltas and calls `onUsage` once at the end. Custom providers just supply `fetchFn: (msgs) => AsyncIterable<string>`. The hook is provider-agnostic — it only consumes `for await`.

**Optional-peer dynamic import that dodges tsc (`ai/index.ts:247`):**
```ts
const sdkId = '@anthropic-ai/sdk';            // variable, not literal → no TS2307
const { default: Anthropic } = await (import(sdkId) as Promise<any>)
  .catch(() => { throw new Error('Install @anthropic-ai/sdk'); });
```
Ollama path uses plain `fetch` + `getReader()` + `TextDecoder`, splitting NDJSON on `\n` and skipping malformed lines.

**Declarative keymap with conflict detection (`useKeymap.ts`):** bindings array `{key,ctrl?,shift?,meta?,action}`; one mount-time pass warns on duplicate `key:ctrl:shift:meta` ids; matching is "undefined modifier = don't care".

**Collapsible streaming block (`ai/ThinkingBlock.tsx`):** header shows `Thinking… · N tokens · 2.3s` while `streaming`, toggles collapsed on Enter/Space; uses `wrap="wrap"` for content.

**Auto-deny timeout with ref (`ai/ToolApproval.tsx`):** `setInterval` countdown; `onDenyRef` kept fresh in an effect so the interval (set up once) always calls the latest callback — classic stale-closure fix.

**PTY output buffering (`adapters/pty/index.ts`):** `usePtyOutput` appends `onData` into a ref buffer, truncates to `maxBytes` (default 500KB) tail to bound memory, cancels + `kill()` on unmount.

## Gotchas / non-obvious decisions
- **No custom renderer.** All layout/diffing is Ink + Yoga flexbox. This repo's "advanced TUI" is component composition + ANSI utils, not a render loop.
- `visibleWidth`/`stripAnsi` use naive `.length` — wrong for CJK/wide chars and emoji/ZWJ. The code itself comments that consumers should prefer the `strip-ansi` package; there's no east-asian-width handling in core.
- **Two different `select`/`confirm` implementations** (`imperative` readline-based vs `clack-ink` React-based) with different UX (numbered list typed input vs arrow-key navigation). They are not interchangeable.
- `enableWindowsVT()` is a stub — it just sets `TERM=xterm-256color`; the comment admits real ConPTY VT enabling would need `koffi`/`ffi-napi` to call `SetConsoleMode`. So Windows VT "support" is aspirational.
- `useMouse` mutates the global terminal mode via raw stdout writes and attaches a `stdin 'data'` listener — multiple `useMouse` mounts will each enable/disable, and it competes with Ink's own input reading.
- `getTerminalCapabilities()` is cached for the process; resize/columns won't refresh `columns/rows` unless `resetCapabilitiesCache()` is called (use `useResize` for live size).
- Imperative `spinner` writes `\r\x1b[K` only when `isTTY` — under pipes it accumulates nothing/garbage.
- AI hooks: abort only breaks the `for await` loop on the next chunk; an in-flight network read isn't force-cancelled for SDK providers (Ollama passes `signal` to fetch, so it is).

## Relevance (which advanced-TUI topics this teaches)
- **ansi-escapes** — comprehensive escape-code module + 24-bit→256→16 color downsampling with nearest-palette math (the standout).
- **input-keyboard-mouse** — raw SGR mouse-protocol enable/parse, declarative keymap, push-to-talk space-repeat detection.
- **app-architecture** — hybrid React-component + imperative-prompt design; provider-agnostic streaming via async generators; ref-as-source-of-truth for streaming state.
- **reconciler-component-models** — shows the *consumer* side of Ink (mount/unmount-per-prompt bridge) rather than building a reconciler.
- **unicode-text-width** — capability-gated Unicode↔ASCII border/glyph fallback (but note the naive width measurement gap).
- **widgets-rich-content** — AI chat widgets (thinking block, tool-approval w/ timeout, token usage, file-change diff).
- **layout** — virtual-scroll windowing math (overscan, sticky offset) for large lists; Yoga flexbox via Ink otherwise.
- **pty-emulation** — node-pty spawn + bounded output buffering hook.
