# Submodule Candidates — Orchestrator/Visualization Study

Vetted from RESEARCH/01–05 (research snapshot 2026-06-05). Goal: clone the most
instructive orchestrator/visualization codebases under `context/` for deep study
(the archon repo already studies TUIs this way).

**Filters applied**
- Exclude dead/stale: no push in > 9 months (before ~2025-09-05) → **rejected**.
- Exclude ink/blessed-era legacy TUIs.
- Exclude archived/frozen repos (dead even if recently frozen).
- Exclude closed-source (can't clone) — Conductor, Nimbalyst, Codex/Claude binaries.
- Already in `context/` (do NOT re-add): opentui, terminal-control, termcast,
  opencode, plus all other existing `context/` submodules.
- Prefer LIVE + readable (TS/JS first; Go/Rust kept when the orchestration model is
  the load-bearing thing to study).

Star counts / last-activity are live from the GitHub API on 2026-06-05.

Stack target is TS/JS, so TS/JS repos are ranked above equally-relevant Go/Rust ones.

| # | repo | git url | stars | last activity | UI paradigm | why study it | verdict |
|--:|------|---------|------:|---------------|-------------|--------------|:------:|
| 1 | kbwo/ccmanager | https://github.com/kbwo/ccmanager.git | 1.1k | 2026-05-31 | session-list TUI (TS, direct PTY, no tmux) | The cleanest readable reference for an orchestrator TUI in our stack: manages PTYs directly (no tmux dep), worktree-per-session, and the canonical **busy/waiting/idle** three-state status model per session. Closest existing thing to what we want to build. | ADD |
| 2 | coder/mux | https://github.com/coder/mux.git | 1.8k | 2026-06-05 | desktop+browser, pluggable runtime (TS) | Pluggable runtime behind one UI: **local / git-worktree / SSH-remote**; shared `.git` so commits show instantly across worktrees; cross-workspace **git-divergence** view; Mermaid-rendered agent proposals. Best architectural study of runtime abstraction + worktree mechanics. | ADD |
| 3 | BloopAI/vibe-kanban | https://github.com/BloopAI/vibe-kanban.git | 27k | 2026-04-24 | kanban-for-agents (Rust core + Node) | The reference kanban-for-agents: task→worktree→branch→dev-server, agent-agnostic **Executor** plugin model, **Attempts** (re-roll a task with a different agent), inline diff-comments routed back to agent, clean split *code state = Git, workflow state = SQLite*. Community-maintained but very alive. | ADD |
| 4 | agent-of-empires/agent-of-empires | https://github.com/agent-of-empires/agent-of-empires.git | 2.5k | 2026-06-05 | dual TUI + web/PWA (Rust) | Best-recency hybrid: background-tmux sessions, worktrees + multi-repo + Docker sandbox, **ACP plan-panels + tool-call cards** (structured layer above raw terminal), and "press R → secure web/mobile companion" (Tailscale/Cloudflare tunnel + QR). Huge agnostic backend list. Study the ACP rendering + TUI↔web bridge. | ADD |
| 5 | saltbo/agent-kanban | https://github.com/saltbo/agent-kanban.git | 327 | 2026-05-23 | kanban-for-agents (TS, serverless) | Leader-worker orchestration: leader decomposes goal → workers self-organize, claim tasks, each in own worktree, open PRs; leader reviews/merges. **Ed25519 agent identity + identicons** (provenance) and **agent-reviews-agent** gating. ACP-compliant. Compact TS codebase showing autonomous multi-agent lifecycle. | ADD |
| 6 | ComposioHQ/agent-orchestrator | https://github.com/ComposioHQ/agent-orchestrator.git | 7.4k | 2026-06-01 | web dashboard, fleet supervisor (TS) | Most autonomous PR-lifecycle loop: each agent gets worktree+branch+PR, **fixes CI failures, responds to review comments, manages its own PR**. Agent-agnostic, runtime-agnostic (tmux/ConPTY/Docker), tracker-agnostic (GitHub/Linear). Study the autonomous-PR state machine. | ADD |
| 7 | Ironclad/rivet | https://github.com/Ironclad/rivet.git | 4.6k | 2026-05-29 | node-graph DAG IDE + live remote debugger (TS) | The DAG/graph renderer reference, and active again (pushed 2026-05-29). **Remote live debugger** attaches to a separately-running execution and streams node activity (= a TUI attaching to an orchestrator daemon), plus **Auto Layout** and graph-as-library subgraph reuse. Embeddable `rivet-core`/`-node`. | ADD |
| 8 | coollabsio/jean | https://github.com/coollabsio/jean.git | 1.0k | 2026-06-05 | native desktop (Tauri/React) + web (TS) | Extremely fresh local-first orchestrator. **Multi-dock terminal**, Plan/Build/Yolo modes with plan-approval, per-prompt model+effort picker, and **session recap/digest** AI summaries (solves "what did this abandoned session do?"). Good study of session lifecycle + recap UX. | ADD |
| 9 | smtg-ai/claude-squad | https://github.com/smtg-ai/claude-squad.git | 7.7k | 2026-05-18 | session-list TUI over tmux (Go, Bubble Tea) | The most mature session-list TUI: worktree+branch per task, parallel runs, background auto-accept ("yolo"), and a **review-diff-before-push gate** baked into the TUI. Go/Bubble Tea but the orchestration + diff-gate patterns transfer directly. | ADD |
| 10 | DanWahlin/ai-agent-board | https://github.com/DanWahlin/ai-agent-board.git | 22 | 2026-05-31 | drag-drop kanban + xterm.js (TS) | Small, readable TS kanban. **Task Groups** (batch 2–20 child tasks, each own agent type + worktree toggle) with a **parallelism slider (1..N)** — declarative concurrency cap on a batch. Provider pattern via `@codewithdan/agent-sdk-core`. Easiest full-stack TS reference to read end-to-end. | ADD |
| 11 | coder/agentapi | https://github.com/coder/agentapi.git | 1.4k | 2026-05-27 | HTTP control plane (Go, headless) | Uniform HTTP control plane fronting headless agent CLIs (CC, Codex, Aider, Goose, Gemini, Amp) with one message/status/stream interface. Exactly the backend an orchestrator TUI should drive — decouples UI from any specific CLI. Study as the integration layer. | ADD |
| 12 | dagger/container-use | https://github.com/dagger/container-use.git | 3.8k | 2026-02-23 | MCP server + CLI, env isolation (Go) | Environment-per-agent via MCP with full replayable command logs + branch tracking. The strong **isolation + auditability** alternative to worktrees (agents can safely run tests). Study the MCP env-isolation model. | ADD |
| 13 | manaflow-ai/cmux | https://github.com/manaflow-ai/cmux.git | 21k | 2026-06-05 | desktop, parallel agents (Swift core) | Very high-traffic parallel-agent orchestrator. Less readable for our stack (Swift), but the scale of adoption + parallel-session UX makes the patterns worth a look; study selectively. | ADD |
| 14 | langflow-ai/langflow | https://github.com/langflow-ai/langflow.git | 149k | 2026-06-05 | DAG visual builder + live Playground (Python) | Largest live DAG builder. **Playground = build canvas + live run inspector in one surface** with per-node output drill-down; conditional edges/cycles/state; deploy a flow as an MCP server. Python, but the run-inspector + DAG-step-through UX is the model to copy. | ADD |
| 15 | gavraz/recon | https://github.com/gavraz/recon.git | 247 | 2026-04-29 | passive monitor TUI (Rust) | **Zero-instrumentation status detection**: reads CC's own JSONL + parses tmux pane status text — no wrapper/hook, works with unmodified agents. Plus the "Tamagotchi" affect layer for at-a-glance state. Small Rust codebase; study the detection technique. | ADD |
| 16 | imbue-ai/sculptor | https://github.com/imbue-ai/sculptor.git | 171 | 2026-05-16 | desktop, container-per-agent | **Container-per-agent** (true isolation, safe `run tests`, no dep reinstall), **visual merge-conflict resolver** for parallel agents, **Pairing Mode** bidirectional container↔local sync, fork-from-any-point-in-history. Study the container isolation + merge-resolver model. | ADD |
| 17 | rayzhudev/vibecraft | https://github.com/rayzhudev/vibecraft.git | 26 | 2026-04-22 | RTS game canvas (TS) | The most novel visualization metaphor: **agents as spatial RTS units** on an infinite canvas; status = unit color/affect; selecting an entity surfaces context "abilities"; worktree actions on folder entities. TS + niche, but a unique idea source for non-list visualization. | ADD |

---

## Notable rejections (for the record)

- **omnara-ai/omnara** — ARCHIVED (frozen 2026-01); SKIP (dead).
- **stravu/crystal** — DEPRECATED, succeeded by closed-source Nimbalyst; last push 2026-02-26. SKIP.
- **conductor.build / Nimbalyst** — closed-source, can't clone. SKIP.
- **devflowinc/uzi** — last push 2025-06-04 (~12 mo). SKIP (stale > 9 mo).
- **microsoft/autogen** — maintenance mode, last release 2025-09-30 (~8 mo, no features). SKIP (mine ideas from notes only).
- **terragon-labs/terragon-oss** — company shut down 2026-02; OSS-only relic. SKIP.
- **FlowiseAI/Flowise** — live, but redundant with Langflow for the DAG-builder study; Langflow is the richer reference. SKIP to avoid duplication.
- **slopus/happy**, **MrLesk/Backlog.md**, **asheshgoplani/agent-deck**, **raine/workmux**, **AgentsMesh/AgentsMesh**, **hoangsonww/Claude-Code-Agent-Monitor**, **owengretzinger/constellagent**, **parruda/swarm**, **bschleifer/swarm**, **nwiizo/ccswarm**, **lunemis/mux**, **untra/operator**, **decisiongraph/graphs-tui**, **Charlie85270/Dorothy** — all LIVE and interesting, but each overlaps a higher-ranked pick on its core paradigm (session-list TUI / kanban / DAG / control-plane / mobile-companion). Held as second-tier; not adding now to keep `context/` focused. graphs-tui in particular is a tiny Mermaid→ASCII renderer worth revisiting if/when we build the in-terminal DAG view.

---

## ADD git URLs

https://github.com/kbwo/ccmanager.git
https://github.com/coder/mux.git
https://github.com/BloopAI/vibe-kanban.git
https://github.com/agent-of-empires/agent-of-empires.git
https://github.com/saltbo/agent-kanban.git
https://github.com/ComposioHQ/agent-orchestrator.git
https://github.com/Ironclad/rivet.git
https://github.com/coollabsio/jean.git
https://github.com/smtg-ai/claude-squad.git
https://github.com/DanWahlin/ai-agent-board.git
https://github.com/coder/agentapi.git
https://github.com/dagger/container-use.git
https://github.com/manaflow-ai/cmux.git
https://github.com/langflow-ai/langflow.git
https://github.com/gavraz/recon.git
https://github.com/imbue-ai/sculptor.git
https://github.com/rayzhudev/vibecraft.git
