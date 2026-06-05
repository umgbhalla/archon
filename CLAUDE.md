# archon — agent working guide

> Private repo `umgbhalla/archon`. A **research + context-aggregation workspace for learning to build advanced terminal UIs (TUIs) in TypeScript**, with a concrete north star: an **agent orchestrator TUI** — a terminal command-center that runs and observes many coding-agent sessions in parallel and inspects workflow-as-code runs.
>
> This file is the map. Read it first. `AGENTS.md` is a symlink to this file.

---

## 0. What this repo is (and is not)

- **Is:** a curated library of *other people's* code (as git submodules under `context/`), distilled study notes, a faithful UI mock, and a design-research corpus — all aimed at mastering TUI engineering and designing an orchestrator TUI.
- **Is not:** a published product. There is no single app to ship yet. The only runnable code we authored lives in `mock/agent-view/app` (a scripted, non-functional mock).
- **Anchor framework:** **OpenTUI** (`context/opentui`) — native Zig core + C-ABI + TS bindings (React/Solid), powers OpenCode. When building TUIs here, default to OpenTUI.

---

## 1. Repo map

```
archon/
├── CLAUDE.md / AGENTS.md      ← you are here (AGENTS.md → CLAUDE.md symlink)
├── context/                   ← 88 git submodules: study material (shallow clones)
│   └── NOTES/                 ← distilled learning: 40 source digests + 12 topic notes + README
├── mock/agent-view/           ← scripted OpenTUI mock of Claude Code's Agent View
│   ├── SPEC/                  ← formal state machine, ux-flows, visual-spec, mock-data
│   ├── RESEARCH/              ← agent-view docs + web/visual/competitive research
│   ├── app/                  ← runnable: Bun + @opentui/react (keyboard-driven, non-functional)
│   ├── captures/             ← termctrl evidence: stills, recording, captioned MP4
│   └── TEST-REPORT.md
└── research/orchestrator-tui/ ← 2025H2–2026 orchestration/visualization landscape
    ├── LANDSCAPE.md           ← taxonomy, patterns-to-steal, gaps (START HERE for design)
    ├── SUBMODULE-CANDIDATES.md
    ├── README.md
    └── RESEARCH/01..06.md
```

**Three things to read before doing design work:**
1. `context/NOTES/README.md` — how advanced TUIs work end-to-end + learning path.
2. `mock/agent-view/SPEC/state-machine.md` — a worked two-layer state machine (session lifecycle + UI modes).
3. `research/orchestrator-tui/LANDSCAPE.md` — the orchestrator design space + what to build.

---

## 2. `context/` submodules, by purpose

All are `--depth 1` shallow clones, study-only. Curation rule below. Categories:

**TUI frameworks / renderers** — `opentui` (ANCHOR), `glyph` (from-scratch React→Yoga→framebuffer reconciler — read this to understand the pipeline), `rezi`, `termui`, `react-curse`, `melker`, `termcast`, `nberlette-tui`.

**OpenTUI ecosystem (apps + libs to learn the anchor)** — `create-tui`, `opentui-examples`, `opentui-ui`, `opentui-spinner`, `ghui` (clean @opentui/react reference), `critique`, `hunk`, `gloomberb`, `termdraw`, `opentui-doom` (framebuffer/half-block).

**Terminal primitives** — `xterm` (VT parser/emulator + addons), `node-pty` (PTY), `yoga` (flexbox layout engine), `node-sixel`, `unicode-segmenter`, `string-width`, `get-east-asian-width`, `anser`, `ansi-up`, `ansi-escapes`, `cli-spinners`.

**Components / widgets / rich content** — `inquirer`, `clack`, `listr2`, `cli-table3`, `marked-terminal`, `shiki` (syntax highlight → ANSI), `cli-highlight`, `asciichart`, `boxen`, `ansis`, `log-update`.

**Effect ecosystem** — `effect` (@effect/cli, printer, platform Terminal), `effect-smol`, `alchemy-effect`.

**Orchestrators / session managers** (study for the north star) — `ccmanager` (cleanest readable session-list TUI; busy/waiting/idle model), `mux` (coder/mux: runtime abstraction local/worktree/SSH), `claude-squad` (tmux session-list + diff-gate), `cmux`, `vibe-kanban`, `ai-agent-board`, `agent-kanban`, `agent-of-empires` (ACP plan panels + TUI↔web), `agent-orchestrator` (autonomous PR loop), `jean`, `sculptor` (container-per-agent + merge resolver), `recon` (zero-instrumentation status detection), `vibecraft` (agents-as-RTS-units).

**Control plane / isolation** — `agentapi` (coder: uniform HTTP control plane over CC/Codex/Aider/etc — drive backends agnostically), `container-use` (env-per-agent via MCP).

**Workflow-as-code / run inspectors** — `codex-workflows` (MCP server + QuickJS-isolated runtime + dashboard; the open run-inspector to study), `opencode` (production OpenTUI app).

**DAG / graph viz** — `rivet` (node-graph IDE + remote live debugger), `langflow` (DAG builder + live run inspector), `beautiful-mermaid`.

**Isolated-runtime / sandbox study** (for a safe workflow runtime) — `quickjs-ng`, `quickjs-wasi`, `boa`, `rustpython`, `wizer`, `workers-rs`, `sandbox-sdk`, `dynos`, `rivetkit`, `perry`.

**Agent/app building blocks & misc** — `scout`, `prompt-kit`, `ai-elements`, `heroui`, `kimiflare`, `flue`, `fast-rlm`, `agents` (cloudflare/agents SDK), `claw-nano-claw`/`claw-nanoclaw`/`claw-tinyclaw`/`claw-microclaw` (minimal agent CLIs).

**Sibling-project mirrors** — `engram`, `thinkx` (and their own context submodules nest similarly).

> To inspect: `git config -f .gitmodules --get-regexp path`. To populate a submodule's code: `git submodule update --init --depth 1 context/<name>`.

---

## 3. North star — the orchestrator TUI

Two **orthogonal surfaces** the tool should host (see `research/orchestrator-tui/LANDSCAPE.md` + `RESEARCH/06`):

1. **Fleet / session grid** — *"which of my parallel agents needs me?"* The Agent-View paradigm: sessions grouped by state, a dual-channel state glyph (**color = logical state**, **shape = process liveness**), one-key filter-to-waiting, review-before-merge with inline diff-comments routed back to the agent.
2. **Workflow run-inspector** — *"what is this orchestrated job doing, phase by phase?"* The Dynamic-Workflows paradigm: a **phase → agent tree** with token/time metrics, drill into an agent's prompt + tool calls + result, live pause/resume/stop/restart, save-as-command, journal resume.

**Build against an agent-agnostic control plane** (ACP / `claude agents --json` / `coder/agentapi`) so it is CLI-agnostic from day one. **Open gaps = the differentiators:** terminal-native DAG view + deterministic scheduler, tree+span run inspector, cross-repo/cross-runtime fleet view, aggregate cost/quota.

**Reference implementations already mocked/owned:** `mock/agent-view` is a full, tested OpenTUI reproduction of the session-grid surface (state machine + visuals + keyboard model) — reuse its SPEC and patterns when building the real thing.

---

## 4. Curation rules (for adding to `context/`)

- **Only LIVE repos** — activity within ~12 months. Reject stale (>9mo), archived, deprecated, or closed-source (can't clone).
- **Exclude legacy TUI libs** — ink, blessed, neo-blessed, terminal-kit.
- **Prefer TS/JS**; keep Go/Rust only when the orchestration/rendering model is the load-bearing thing to study.
- **Add shallow:** `git submodule add --depth 1 <url> context/<name>`.
- One repo per paradigm — avoid redundant picks (e.g. Langflow over Flowise).
- Record the rationale in `research/orchestrator-tui/SUBMODULE-CANDIDATES.md` if it's an orchestrator pick.

---

## 5. Working conventions

- **Git:** branch off / commit / push **only when asked**. Conventional-commit style; end commit bodies with the Co-Authored-By trailer. The repo's `.gitignore` already covers `node_modules`, build output, `.env`, etc.
- **Submodules:** shallow. Adding many → script it and run in the background (clones are slow).
- **The mock app** (`mock/agent-view/app`): Bun + `@opentui/react`, keyboard-driven, **scripted/non-functional** (no real model/PTY/network).
  - Run: `cd mock/agent-view/app && bun install && bun run start` (needs a terminal ≥ ~30 rows).
  - Test: `bun test` (reducer/state-machine suite in `src/state/store.test.ts`).
  - Typecheck: `bunx tsc --noEmit`.
  - Architecture: `src/data` (types/seed/scenario) · `src/state` (store FSM + keymap) · `src/theme` · `src/components` · `App.tsx`. Selection is tracked **by stable key** (not index) — see `keepSelection`/`selectionKey`.
- **New research** → `research/<topic>/` with a `README.md` index + `RESEARCH/NN-*.md` dossiers. **New distilled study** → `context/NOTES/`.

---

## 6. Tooling

- **terminal-control** (`context/terminal-control`, binary `termctrl`) — drive/inspect/capture real TUIs via PTY. For OpenTUI apps pass `--host opentui`. **Always verify via the recording + `--at-marker` frames, not live `show`** — live reads race sub-2s states (e.g. a 2s delete-confirm window) and report stale frames. Workflow: `start --record` → `mark` per beat → `markers` → `show/save --recording --at-marker` → `video --edit <plan.json> --footer`.
- **Dynamic Workflows** (`/workflows`, triggered by `ultracode`) — the runtime that orchestrates subagents from a script. Used here for the deep-study, agent-view research, build, and orchestrator-landscape research. The `/workflows` progress view is itself the run-inspector UX spec for the north star.

---

## 7. Gotchas & hard-won learnings

- **OpenTUI vertical layout:** stack rows in explicit `height={1}` boxes; bare consecutive `<text>` can collapse onto one row. Content that exceeds the terminal height flex-shrinks and overlaps — assume ≥30 rows.
- **Agent-View state machine** (mock): `Esc` on an empty table **exits to shell** (U35) — don't use it to "snap" selection in scripts. Headers are navigable selectables, so Ctrl+R/Ctrl+X **no-op when a header is selected** — guard on a row. Bugs already found+fixed: filter detected-but-not-applied; selection-index drift after regroup (now key-based).
- **Driving a TUI from a script:** select rows deterministically via peek-adjacent (rows only); for a 2-stroke chord (Ctrl+X×2) send both atoms close together but in separate frames.

---

## 8. Pointers (read these, don't re-derive)

| Want | Read |
|------|------|
| How TUIs render/layout/input | `context/NOTES/README.md` + the 12 topic notes |
| A worked TUI state machine | `mock/agent-view/SPEC/state-machine.md` |
| Orchestrator design space | `research/orchestrator-tui/LANDSCAPE.md` |
| Which repos to study first | `research/orchestrator-tui/SUBMODULE-CANDIDATES.md` (top: ccmanager, mux, vibe-kanban, agent-of-empires, rivet) |
| Workflow-as-code paradigm | `research/orchestrator-tui/RESEARCH/06-dynamic-workflows.md` |
| What was tested + how | `mock/agent-view/TEST-REPORT.md` |
