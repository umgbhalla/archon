# Orchestrator TUI — Research Index

**Snapshot:** 2026-06-05 · Research set for designing an advanced multi-agent orchestrator TUI (a terminal-native "command center" that runs and observes many coding-agent sessions in parallel).

## TL;DR

By 2026-H1 the orchestrator-agent space has converged on a clear stack: **worktree-per-task isolation** (table stakes), an **explicit per-session state model** (busy / waiting-for-input / idle) as the core triage primitive, and a **review-before-merge gate with inline comments routed back to the agent**. The first parties are pushing toward supervisor-hosted autonomous fleets — Anthropic's Agent View (grouped session table + Haiku row summaries + dual color/shape state icons + `claude agents --json` control plane), peer-messaging Agent Teams, and machine-generated Dynamic Workflows; OpenAI's Codex desktop "command center" with per-thread Local/Worktree/Cloud runtime selectors and a review queue — while humans drop to a "peek when it needs me" supervisory role. The richest *terminal* paradigm is the TUI session list/grid (ccmanager, Claude Squad, Recon, agent-of-empires); the richest *visualization* ideas live in the web/desktop DAG world (LangGraph/LangSmith, Temporal, Rivet, Langflow) and must be re-rendered with terminal primitives (Ratatui Canvas + Braille, Textual `Tree`). The biggest open gaps — and the differentiation opportunities — are true hard-dependency DAG scheduling, terminal-native run inspection (tree + span timeline), cross-repo/cross-machine fleet views, and unified cost/quota awareness across many parallel agents.

## File map

| File | Contents |
|------|----------|
| [`LANDSCAPE.md`](./LANDSCAPE.md) | Synthesis: UI-paradigm taxonomy, what-gets-visualized matrix, orchestration models, first-party vs third-party value, **32 patterns to steal**, and the gaps/opportunities list. Start here for design. |
| [`SUBMODULE-CANDIDATES.md`](./SUBMODULE-CANDIDATES.md) | 17 vetted repos to clone under `context/` for deep study, with git URLs, stars, recency, and why-study rationale; plus notable rejections (dead/stale/redundant). |
| [`RESEARCH/01-claude-firstparty.md`](./RESEARCH/01-claude-firstparty.md) | Anthropic / Claude Code's own surfaces: Agent View, Agent Teams, Dynamic Workflows, Code on the web, Agent SDK. |
| [`RESEARCH/02-codex-firstparty.md`](./RESEARCH/02-codex-firstparty.md) | OpenAI Codex multi-surface command center: CLI, desktop app, Cloud, IDE extension, AGENTS.md. |
| [`RESEARCH/03-thirdparty-orchestrators.md`](./RESEARCH/03-thirdparty-orchestrators.md) | Third-party orchestrators/visualizers grouped by UI paradigm (TUI-list, kanban, web, IDE, tmux). |
| [`RESEARCH/04-dag-workflow-viz.md`](./RESEARCH/04-dag-workflow-viz.md) | DAG / workflow / graph visualization — how run inspectors show node graphs, timelines, trace trees, swimlanes. |
| [`RESEARCH/05-bleeding-edge-2026.md`](./RESEARCH/05-bleeding-edge-2026.md) | Newest/novel tools (late 2025 – mid 2026): affect layers, cryptographic identity, tiered autonomy, novel metaphors. |

## Top ~8 tools to know

1. [Claude Code Agent View](https://github.com/anthropics/claude-code) — flagship *terminal* orchestrator: grouped session table, dual color+shape state icons, Haiku row summaries, daemon + `claude agents --json` control plane.
2. [OpenAI Codex](https://github.com/openai/codex) — multi-surface command center (CLI + desktop + Cloud) with per-thread Local/Worktree/Cloud runtime selector, best-of-N, verifiable-evidence citations.
3. [kbwo/ccmanager](https://github.com/kbwo/ccmanager) — cleanest readable session-list TUI in our stack (TS, direct PTY, no tmux); canonical busy/waiting/idle three-state model.
4. [BloopAI/vibe-kanban](https://github.com/BloopAI/vibe-kanban) — reference kanban-for-agents: Executor plugin model, Attempts (re-roll with a different agent), inline diff-comments routed back to the agent.
5. [coder/mux](https://github.com/coder/mux) — best study of runtime abstraction: pluggable local / worktree / SSH-remote behind one UI, cross-workspace git-divergence view.
6. [smtg-ai/claude-squad](https://github.com/smtg-ai/claude-squad) — most mature session-list TUI over tmux (Go/Bubble Tea) with a review-diff-before-push gate baked in.
7. [Ironclad/rivet](https://github.com/Ironclad/rivet) — the DAG/graph renderer reference: remote live debugger (attach to a running execution and stream node activity) + Auto Layout.
8. [gavraz/recon](https://github.com/gavraz/recon) — zero-instrumentation status detection (reads agent JSONL + tmux pane text, unmodified agents) plus a Tamagotchi affect layer.

## 5 strongest patterns to steal

1. **Explicit busy / waiting-for-input / idle state, encoded as a dual-channel glyph** (color = logical state, shape = process liveness). One TUI cell answers "does it need me?" and "is it even running?" — the single highest-value glance primitive. *(Agent View, ccmanager)*
2. **`@` / `s:blocked` filter-to-waiting hotkey** — one keystroke collapses the whole fleet to just the agents needing human input, turning triage into a scan. *(agent-deck, Agent View)*
3. **Review-before-merge gate with inline diff comments routed back to the agent** — never blind-merge; comment-as-feedback keeps the loop inside the tool instead of a GitHub side-trip. *(Vibe Kanban, Claude Squad)*
4. **Run-inspection duality: collapsible step/agent tree (causality) toggling to a span timeline (timing)**, spans not raw events, color=status + click=detail, horizontal axis always = elapsed time. Render terminal-native with Textual `Tree` + Ratatui Braille markers. *(LangSmith, Temporal)*
5. **Attach to a separately-running orchestrator daemon and stream live node/session updates** — the TUI is a thin observer over a persistent supervisor, so state survives the TUI closing. *(Agent View daemon + `claude agents --json`, Rivet remote debugger)*

## Recommended next step for archon

Clone the 17 repos in [`SUBMODULE-CANDIDATES.md`](./SUBMODULE-CANDIDATES.md) under `context/` for deep study (TS/JS-first, all live, none stale). The ADD git URLs are listed at the bottom of that file. Prioritize the top tier:

- **ccmanager** (`https://github.com/kbwo/ccmanager.git`) — closest existing thing to what we want to build; the readable session-list-TUI baseline.
- **coder/mux** (`https://github.com/coder/mux.git`) — runtime abstraction + worktree mechanics.
- **vibe-kanban** (`https://github.com/BloopAI/vibe-kanban.git`) — Executor plugin model + Attempts + diff-comment loop.
- **agent-of-empires** (`https://github.com/agent-of-empires/agent-of-empires.git`) — ACP plan-panel/tool-call rendering + TUI↔web bridge.
- **rivet** (`https://github.com/Ironclad/rivet.git`) — DAG renderer + remote live-debugger pattern for terminal run inspection.

Then build the orchestrator TUI against a uniform, agent-agnostic control plane (ACP / `claude agents --json` / coder/agentapi) so it is CLI-agnostic from day one, and target the open gaps — terminal-native DAG view + deterministic scheduler, tree+span run inspector, cross-repo/cross-runtime fleet view, and aggregate cost/quota — as the differentiators.
