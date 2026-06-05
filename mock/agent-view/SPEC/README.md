# Agent View Mock — Master Index

This is the entry point for the **Agent View mock spec**. It indexes every SPEC and
RESEARCH file, consolidates the state/mode model, and lists exactly what a build of the
mock must demonstrate. The mock is a faithful, **non-functional** reproduction of Claude
Code's Agent View TUI (`claude agents`) — it looks and behaves like the real thing on a
scripted timeline, but runs no model and spawns no process.

---

## 1. What Agent View is (in 5 bullets)

- **One screen for every background session.** `claude agents` takes over the full
  terminal and shows an inbox-style table of all background Claude Code sessions across
  projects — what's working, what needs you, what's done — instead of scrolling
  transcripts. `Esc` returns to the shell; sessions keep running while you're away.
- **Each row is an independent full Claude Code conversation** run by a per-user
  supervisor process, not tied to any terminal. Every dispatched prompt starts its own
  new session (never a follow-up); sessions burn quota independently.
- **Two orthogonal per-row signals.** Icon **color/animation = task state** (Working
  animated, Needs input yellow, Idle dimmed, Completed green, Failed red, Stopped grey);
  icon **shape = process liveness** (`✻`/`✽` alive, `∙` exited-but-usable, `✢` `/loop`
  sleeping). Rows auto-sort by priority so the sessions needing you float to the top.
- **Triage loop: dispatch → watch → peek → attach.** Dispatch a task from the bottom
  input; watch its row's one-line (Haiku-generated) summary refresh; `Space` to peek
  (reply, pick a numbered option, or see PRs without opening the transcript); `Enter`/`→`
  to attach to the full fullscreen session, with a recap of what happened while away.
- **Keyboard-first, with a PR-status column.** Pin/rename/reorder/group/delete/filter all
  via shortcuts (`?` for the full list); a `PR #N` label (color-coded yellow/green/
  purple/grey) at the right edge is where you pick up most results — "merge when green."

---

## 2. File map (SPEC/ and RESEARCH/)

### SPEC/ — the buildable specification

| File | One-line |
| :--- | :------- |
| `README.md` | This master index: what Agent View is, file map, consolidated state/mode model, the demonstration checklist, scope note, open questions. |
| `_raw-inventory.md` | Verbatim extraction from the official docs (every fact cited as `L#` into `RESEARCH/agent-view-docs.md`) — states, icons, groups, regions, modes, shortcuts, peek/attach behaviors, the canonical sample table; the source of truth nothing else may contradict. |
| `state-machine.md` | The two formal FSMs: per-session lifecycle (states + sub-flags + S1–S18 transition table) and the app/UI-mode statechart (modes + U1–U37 transition table), with Mermaid diagrams and a scripted-vs-user-driven classification. |
| `ux-flows.md` | Ten step-by-step interaction flows (open/onboarding, dispatch, watch-update, peek+reply, attach+detach, organize, filter, delete, PR/review, turn-off), each as key→UI→transition rows with a per-flow SCRIPT-vs-FAKE note. |
| `visual-spec.md` | The visual/component spec: screen-region layout + ASCII wireframe, color-token tables (dark/light/daltonized/ANSI), icon + spinner set, row anatomy, and peek/attached/help-overlay layouts, plus typography. |
| `mock-data-and-scenario.md` | TypeScript types, a 13-session seed roster covering every state/group/shape/PR-color, a scripted t=0–70s event timeline, sample attached transcripts and peek question, and the assembled `mockScenario` export with a coverage checklist. |

### RESEARCH/ — the grounding evidence (read-only inputs)

| File | One-line |
| :--- | :------- |
| `agent-view-docs.md` | The full official Anthropic docs page for agent view (the primary source; all `L#` citations point here). |
| `web-behavior.md` | How it behaves in practice: documented behaviors (entry, dispatch, peek, attach, hosting, idle GC, write isolation), timing/animation facts, and skeptically-flagged anecdotal quirks. |
| `visual-references.md` | Color palette + semantic tokens, icon/spinner reverse-engineering, typography/spacing, header/footer, light-vs-dark, and reference screenshot URLs. |
| `competitive-ux.md` | Multi-agent/multi-session tool teardown (claude-squad, Vibe Kanban, Conductor, Cursor, Devin, Warp, etc.) and the 11 "patterns worth adopting." |

---

## 3. Consolidated mode + session-state model

### 3a. Session task-states (color/animation axis) — 6 states

| State | Visual | Meaning |
| :--- | :--- | :--- |
| `working` | animated orange icon | actively running tools / generating |
| `needsInput` | yellow | waiting on a question or permission decision |
| `idle` | dimmed | nothing to do, ready for the next prompt |
| `completed` | green | finished successfully |
| `failed` | red | ended with an error (also the state after machine shutdown) |
| `stopped` | grey | stopped via `Ctrl+X` / `claude stop` |

Two orthogonal **sub-flags** layer on top of task-state (they are not states):

- **processAlive**: `✻` static-alive / `✽` animated-alive / `∙` exited-but-usable (peek/reply/attach restarts it).
- **loopSleeping**: `✢` — a `/loop` session sleeping between iterations; row shows run count + countdown.

### 3b. Groups (separate axis — names do NOT map 1:1 to states) — 5 groups

`pinned` (Ctrl+T, floats to top) · `readyForReview` (has an open PR) · `needsInput` ·
`working` · `completed` (collects completed + failed + stopped; older rows fold into
`… N more`, but failures and open-PR rows always stay visible). Priority order top→bottom:
Pinned, Ready for review, Needs input, Working, Completed.

### 3c. UI modes (the whole screen is in exactly one) — 9 modes

`onboardingEmpty` (pre-first-dispatch hint) · `tableView` (default grouped list; root) ·
`peekPanel` (`Space`) · `attachedSession` (fullscreen, `Enter`/`→`) · `helpOverlay` (`?`) ·
`renameInput` (`Ctrl+R`) · `deleteConfirm` (armed 2s after first `Ctrl+X`) ·
`dispatchInput` (typed prompt) · `filterMode` (`a:`/`s:`/`#`/PR prefix). Most modes return
to `tableView` on `Esc`; `Esc` from `tableView` with empty input exits to shell.

*(Full transition tables: session S1–S18 and UI U1–U37 in `state-machine.md`.)*

### 3d. PR-label colors — 4

`yellow` (waiting on checks/review, or checks failed) · `green` (passed, nothing blocking —
"merge when green") · `purple` (merged) · `grey` (draft or closed).

---

## 4. What the mock must demonstrate (checklist)

### Every session state (all 6, simultaneously visible on load)
- [ ] `working` — animated `✽` icon + shimmer spinner.
- [ ] `needsInput` — yellow icon, surfaces a question/permission in summary, bumps tab-title awaiting count.
- [ ] `idle` — dimmed icon, "ready for next prompt".
- [ ] `completed` — green icon, `result: …` summary.
- [ ] `failed` — red icon, always visible (never folded).
- [ ] `stopped` — grey icon.

### Every process-shape sub-flag
- [ ] `✻` static-alive, [ ] `✽` animated-alive, [ ] `∙` exited-but-usable, [ ] `✢` `/loop` sleeping (run count + countdown).

### Every group + grouping behaviors
- [ ] All 5 groups render in priority order; [ ] `… N more` fold with failures/open-PR rows exempt; [ ] `Ctrl+S` toggles state↔directory grouping; [ ] `Enter` on a header collapses/expands.

### Every mode transition (per `state-machine.md` U1–U37)
- [ ] `onboardingEmpty` → `dispatchInput` → `tableView` (first dispatch).
- [ ] `tableView` ↔ `peekPanel` (`Space`/`Esc`); peek-adjacent `↑`/`↓`; `→` to attach.
- [ ] `tableView` ↔ `attachedSession` (`Enter`/`→`/`Alt+1..9`/`Shift+Enter`; detach via `←`/`Ctrl+Z`/`Ctrl+C`×2).
- [ ] `tableView` ↔ `helpOverlay` (`?`).
- [ ] `tableView` ↔ `renameInput` (`Ctrl+R`).
- [ ] `tableView` → `deleteConfirm` → delete or 2s-disarm (`Ctrl+X`, `Ctrl+X` again).
- [ ] `dispatchInput` ↔ `filterMode` (prefix grammar); `Enter` dispatches; `Too short` (<4 chars).
- [ ] `tableView` → shell (`Esc` / `Ctrl+C`×2 / `/exit`).

### The inbuilt terminal / attached view
- [ ] Agent view is **replaced** by the fullscreen session; [ ] on-attach **recap** block renders; [ ] scrollback hints (`PgUp`/`PgDn`/`Ctrl+O`); [ ] standard session prompt (`>`), not the `❯` dispatch chevron; [ ] detach returns to the row without "stopping" it.

### Peek + reply
- [ ] Panel shows recent output **or** pending question + PRs (not full transcript); [ ] multiple-choice numbered options pickable by number key; [ ] `Tab` fills a suggested editable reply; [ ] free-form reply + `Enter`; [ ] answering visibly flips the row out of Needs input into Working.

### Dispatch
- [ ] Plain prompt + `Enter` creates a new Working row, auto-named, input cleared, header count increments; [ ] `@agent` / `@repo` / `/command` / `! bash` prefix detection switches input mode; [ ] `Shift+Enter` dispatch-and-attach; [ ] `#N`/PR URL selects an existing PR session; [ ] `Too short` rejection.

### Organize
- [ ] `Ctrl+T` pin/unpin re-groups to Pinned; [ ] `Shift+↑`/`Shift+↓` reorder; [ ] `Ctrl+R` inline rename; [ ] header `Enter` collapse; [ ] `Ctrl+S` regroup.

### PR / Ready-for-review
- [ ] Row moves to Ready for review on PR open; [ ] label cycles yellow→green→purple/grey; [ ] multi-PR `3 PRs` count; [ ] PR label persists through follow-ups; [ ] failures + open-PR rows exempt from fold.

### Turn-off
- [ ] `Esc` / `Ctrl+C`×2 / `/exit` returns to a shell-like screen with the backgrounded-session hint block; [ ] a represented `disableAgentView` / `CLAUDE_CODE_DISABLE_AGENT_VIEW` "disabled" state; [ ] the `Cannot open agents — N background task(s) running` hint.

### Scripted timeline beats (drives the live feel — see `mock-data-and-scenario.md`)
- [ ] Working summary refresh; [ ] `done/total` advance (2/5→3/5); [ ] new Needs-input session appears; [ ] Working→Completed arrival; [ ] PR yellow→green; [ ] `/loop` tick (run count + countdown); [ ] needsInput answered→Working; [ ] permission denied→idle; [ ] failed row stays red/visible.

### Cross-cutting fidelity
- [ ] Redundant encoding (color **and** icon shape) everywhere; [ ] honor "Reduce motion" for the working shimmer; [ ] light + dark themes (invert bg/fg, keep accents); [ ] tab-title awaiting-input count updates live.

---

## 5. Scope note — NON-FUNCTIONAL: scripted, no real model / no real PTY

This mock is **explicitly non-functional**. It must *look* and *feel* like Agent View, but:

- **No model is ever called.** All summaries, recaps, replies, multiple-choice options, and
  the "longest-running item" labels are **pre-written canned strings**, never Haiku-class
  (or any) LLM output.
- **No process / PTY / daemon exists.** "Sessions keep running" is conceptual only; there
  is no supervisor, no `~/.claude/jobs`, no `! bash` execution, no real subagents. The
  bash-job row's "output" is a scripted fake line.
- **No real git / GitHub.** Worktrees, PRs, check/review status, and hyperlinks are canned
  data; PR colors advance on a scripted timeline, never polled. The worktree-deletion
  data-loss warning is **copy only** — no real worktree or uncommitted changes exist.
- **No persistence.** "Persists across runs" (grouping choice, etc.) resets each load.
- **What is genuinely real (the "SCRIPT" layer):** keypress→state-transition wiring, group
  re-sorting, mode switching, the two-stage `Ctrl+X` 2s timeout, peek open/close, attach/
  detach takeover, filter-token detection, and the timed demo timeline that flips states.
- The mock is a **demo / design artifact**, not a tool. It must never imply real work is
  dispatched, edited, executed, or sent anywhere.

---

## 6. Open questions / build-stack decision (placeholder)

> **DECIDE BEFORE BUILD — fill in here.**

- **Build stack:** _TBD._ Candidates to evaluate: (a) **web/React** rendering an
  xterm.js-style faux-terminal canvas; (b) a **real TUI** (e.g. Ink / Bubble Tea) driven by
  the scripted timeline; (c) **static HTML/CSS** styled as a terminal. Trade-off: real
  keyboard fidelity vs. ease of sharing/embedding the mock.
- **Timeline driver:** _TBD._ How are `mockScenario.events` replayed — wall-clock timers,
  a step/scrubber control for demos, or both? Should the demo expose a visible HUD of the
  current event `label`?
- **Theme coverage:** _TBD._ Ship dark only, or dark + light (and daltonized/ANSI
  fallbacks)? How is theme switching exposed?
- **Reduce-motion:** _TBD._ Source the preference from the OS/`prefers-reduced-motion`, or a
  mock toggle, or both?
- **Time-compression constants:** _TBD._ Confirm the compressed cadences from
  `state-machine.md` §C (summary refresh ~3–5s for 15s; `procExit` ~30–60s for ~1h idle GC;
  empty-row cleanup ~30s for ~5min; `deleteConfirm` real 2s window).
- **Interaction surface:** _TBD._ Keyboard-only (faithful), or also mouse/click affordances
  for a non-terminal audience?
- **Out-of-scope confirmations:** _TBD._ Are split-pane/tmux mode, voice dictation, image
  paste, and the `--cwd`/`--json`/shell-management commands in or out of the mock's first
  cut?
- **Fidelity ceiling:** _TBD._ How far do OSC-8 hyperlinks, truecolor→256→16-color
  downgrade, and VT100 ASCII box-drawing fallback need to be reproduced vs. faked?
