# Third-Party Coding-Agent Orchestrators & Visualizers

Research snapshot: **2026-06-05**. Star counts and dates pulled live from the GitHub API on this date. "Recency flag" marks anything not pushed in ~6 months (i.e. before ~2025-12-05).

This survey covers third-party tools that **orchestrate and/or visualize multiple coding-agent sessions** (Claude Code, Codex, or both). The dominant backend agents are Claude Code and OpenAI Codex; most tools are now explicitly agent-agnostic. Grouped below by **UI paradigm**.

---

## Landscape at a glance

| Tool | Repo | Stars | Last push | Paradigm | Backend |
|------|------|------:|-----------|----------|---------|
| Claude Squad | smtg-ai/claude-squad | ~7.7k | 2026-05-18 | TUI list (tmux) | CC, Codex, Gemini, Aider, Amp |
| ccmanager | kbwo/ccmanager | ~1.1k | 2026-05-31 | TUI list | CC, Codex, Gemini, Cursor, Copilot, Cline, OpenCode, Kimi |
| agent-deck | asheshgoplani/agent-deck | ~2.6k | 2026-06-05 | TUI list | CC, Codex, Gemini, OpenCode + |
| lunemis/mux | lunemis/mux | ~67 | 2026-05-04 | TUI list (tmux) | agnostic (auto-detect) |
| workmux | raine/workmux | ~1.6k | 2026-05-27 | TUI + tmux | agnostic |
| uzi | devflowinc/uzi | ~579 | **2025-06-04** ⚠️ | CLI fleet (tmux/worktree) | agnostic |
| claude-swarm (parruda/swarm) | parruda/swarm | ~1.5k | active | YAML supervisor tree | CC v1 / multi-LLM v2 |
| claude-flow | ruvnet/claude-flow (now `ruflo`) | ~58k | 2026-06-05 | swarm/hive CLI + memory | CC, Codex |
| Vibe Kanban | BloopAI/vibe-kanban | ~26.8k | 2026-04-24 | Kanban board (web) | 10+ agents (agnostic) |
| Backlog.md | MrLesk/Backlog.md | ~5.7k | 2026-05-30 | Kanban (TUI + web) + MCP | agnostic via MCP |
| Conductor | conductor.build (closed src) | — | active (Mac app) | Web/native 3-panel | CC, Codex |
| Crystal → Nimbalyst | stravu/crystal | ~3.1k | 2026-02-26 | Desktop multi-session | CC, Codex |
| Sculptor | imbue-ai/sculptor | ~171 | 2026-05-16 | Desktop, container-per-agent | CC, Codex |
| coder/mux | coder/mux | ~1.8k | 2026-06-05 | Desktop + browser | multi-model loop |
| Omnara | omnara-ai/omnara | ~2.6k | 2026-01-19 | Web + mobile dashboard | CC, Codex, n8n + |
| Happy | slopus/happy | ~21.6k | 2026-06-01 | Mobile + web client | CC, Codex |
| Terragon | terragon-labs/terragon-oss | ~238 | 2026-02-10 | Cloud web dashboard | CC, Codex, Amp, Gemini — **SHUT DOWN** ⚠️ |
| container-use | dagger/container-use | ~3.8k | 2026-02-23 | MCP + CLI (env isolation) | agnostic (MCP) |
| AgentAPI | coder/agentapi | ~1.4k | 2026-05-27 | HTTP API (headless) | CC, Goose, Aider, Gemini, Amp, Codex |
| claude-code-router | musistudio/claude-code-router | ~34.7k | 2026-03-04 | Router/proxy (no UI) | CC frontend, any model backend |
| CCSeva | Iamshankhadeep/ccseva | ~795 | 2026-03-07 | macOS menu bar | CC usage monitor |
| claude-powerline | Owloops/claude-powerline | ~1.1k | 2026-05-31 | Statusline | CC monitor |

⚠️ = stale or dead (see notes).

---

## 1. TUI list / tmux-multiplexer paradigm

The most mature paradigm for an orchestrator TUI. A list of sessions on the left, attach into the live agent terminal on selection. Each session = an isolated git worktree + branch.

### Claude Squad — smtg-ai/claude-squad
- URL: https://github.com/smtg-ai/claude-squad — ~7.7k stars, Go, last push 2026-05-18 (active).
- **Paradigm:** terminal TUI (Bubble Tea) that wraps **tmux** sessions; binary installs as `cs`.
- **Visualizes:** list of agent instances, live terminal output of the selected instance, and a diff view of changes before applying. Status per instance.
- **Orchestration:** one isolated **git worktree + branch per task**; run many in parallel; background/auto-accept ("yolo") mode; review-then-apply/push gate.
- **Backend:** Claude Code, Codex, Gemini, Aider, Amp, OpenCode — any local CLI agent.
- **Steal:** (1) the "background task with auto-accept, surface only when it needs you" model; (2) the review-diff-before-push gate baked into the TUI so you never blind-merge. Source: README at https://github.com/smtg-ai/claude-squad.

### ccmanager — kbwo/ccmanager
- URL: https://github.com/kbwo/ccmanager — ~1.1k stars, TypeScript, last push 2026-05-31 (very active).
- **Paradigm:** TUI session manager (no tmux dependency — manages PTYs directly).
- **Visualizes:** session list with per-session **state badges** (Busy / Waiting-for-input / Idle), so you see at a glance which agents need attention.
- **Orchestration:** worktree-per-session; status-change hooks/commands; devcontainer support.
- **Backend:** the broadest in the survey — CC, Codex, Gemini CLI, Cursor Agent, Copilot CLI, Cline, OpenCode, Kimi CLI.
- **Steal:** the explicit **three-state status model (busy / waiting / idle)** per session is the single most useful primitive for an orchestrator TUI — it turns "which of my 8 agents is blocked on me?" into a glance. Source: https://github.com/kbwo/ccmanager.

### agent-deck — asheshgoplani/agent-deck
- URL: https://github.com/asheshgoplani/agent-deck — ~2.6k stars, Go, last push 2026-06-05 (very active).
- **Paradigm:** terminal "deck" — one TUI fronting many agent sessions.
- **Visualizes:** session cards/deck with live status; switch between Claude, Gemini, OpenCode, Codex.
- **Orchestration:** session manager across heterogeneous agents.
- **Steal:** the "deck of cards you flip through" mental model for many live terminals. Source: https://github.com/asheshgoplani/agent-deck.

### lunemis/mux
- URL: https://github.com/lunemis/mux — ~67 stars, Go, last push 2026-05-04.
- **Paradigm:** **tmux** session manager TUI with **live preview** of each pane.
- **Visualizes:** every session's live output at a glance; auto-detects and **badges** `claude`/`codex`/`aider`/`gemini`; shows each session's git branch; visually distinguishes linked worktrees.
- **Steal:** the **live-preview grid** (see all panes' output simultaneously without attaching) + **agent-type auto-detection badges** + per-session branch label. Source: https://github.com/lunemis/mux.

### workmux — raine/workmux
- URL: https://github.com/raine/workmux — ~1.6k stars, Rust, last push 2026-05-27 (active).
- **Paradigm:** git worktrees + tmux windows; opinionated zero-friction parallel dev; includes a **TUI dashboard** showing all active AI agents across all tmux sessions.
- **Steal:** dashboard that aggregates agents across *all* tmux sessions (not just ones it spawned) — meets users where their terminals already are. Source: https://github.com/raine/workmux.

### uzi — devflowinc/uzi  ⚠️ STALE
- URL: https://github.com/devflowinc/uzi — ~579 stars, Go, **last push 2025-06-04 (~12 months stale — flag)**.
- **Paradigm:** CLI for running *large numbers* of agents in parallel via git worktrees + tmux; emphasis on fleets (10s of agents).
- **Orchestration:** spawn N agents on the same prompt, each in its own worktree, then compare/pick the best — a "run many, keep the winner" race model.
- **Steal:** the **fan-out-then-select race** (N agents, same task, pick best diff) is a distinct orchestration mode worth offering. Note: appears abandoned; verify before depending on it. Source: https://github.com/devflowinc/uzi.

### claude-swarm — parruda/swarm
- URL: https://github.com/parruda/swarm (formerly `parruda/claude-swarm`) — ~1.5k stars, Ruby, active.
- **Paradigm:** **supervisor tree** defined in YAML; v2 (SwarmSDK) is single-process, multi-LLM; ships **SwarmCLI** (TTY toolkit) and a separate browser UI (`parruda/swarm-ui`).
- **Visualizes:** agent topology / hierarchy; tree of specialized roles delegating via (v1) MCP or (v2) direct calls; persistent memory with semantic search.
- **Orchestration:** **hierarchical teams** — a lead agent delegates to specialized sub-agents with their own tools and directory scope. Node workflows + hooks.
- **Backend:** v1 Claude Code; v2 model-agnostic (Claude, OpenAI, Gemini).
- **Steal:** **YAML-declared agent topology** (roles, tools, directory scope per agent) as a reproducible swarm spec; the supervisor/delegation tree. Source: https://github.com/parruda/swarm.

### claude-flow — ruvnet/claude-flow (now `ruvnet/ruflo`)
- URL: https://github.com/ruvnet/claude-flow (repo renamed to `ruflo`) — **~58k stars** (largest in survey), TypeScript, last push 2026-06-05, latest release v3.10.34 (2026-06-02). Extremely active.
- **Paradigm:** CLI "meta-harness" / **swarm + hive-mind** orchestrator; not primarily a visual TUI but coordinates large multi-agent swarms.
- **Visualizes/Orchestrates:** swarm topologies, adaptive shared memory, self-learning coordination, RAG; queen/worker "hive-mind" model.
- **Backend:** Claude Code + Codex native integration.
- **Steal:** **persistent cross-session shared memory** + a coordinator ("queen") that routes work to workers. (Caveat: marketing-heavy; star count is inflated relative to depth — treat ideas, not claims, as the takeaway.) Source: https://github.com/ruvnet/claude-flow.

---

## 2. Kanban board paradigm

Tasks as cards moving through columns (To Do → In Progress → Review → Done). Human is an "agent manager" planning and reviewing rather than typing in a terminal.

### Vibe Kanban — BloopAI/vibe-kanban
- URL: https://github.com/BloopAI/vibe-kanban — **~26.8k stars**, Rust + Node, last push 2026-04-24 (release v0.1.44, 2026-04-24). Note: **vendor announced sunsetting**, continuing as community open source.
- **Paradigm:** **web Kanban board**; `npx vibe-kanban`, no account.
- **Visualizes:** task cards across columns; **line-by-line diff review with inline comments** that feed back to the agent; built-in browser preview with devtools/device emulation; logs/terminal per task.
- **Orchestration:** **task → isolated git worktree + branch + dev server**; agent-agnostic "Executor" plugin model; "**Attempts**" — re-run a rejected card with a different agent/prompt; auto PR creation + one-click rebase/merge/cleanup.
- **Backend:** 10+ agents — CC, Codex, Gemini CLI, Copilot, Amp, Cursor, OpenCode, Droid, CCR, Qwen.
- **Architecture:** local-first; **code state in Git, workflow state in SQLite** (board lives in `db.sqlite`, not committed).
- **Steal:** (1) **"Attempts"** — first-class re-roll of a task with a different agent, keeping history; (2) **inline diff comments routed back to the agent as feedback**; (3) the clean split of *code state = Git, workflow state = local DB*. Sources: https://github.com/BloopAI/vibe-kanban, https://vibekanban.com/.

### Backlog.md — MrLesk/Backlog.md
- URL: https://github.com/MrLesk/Backlog.md — ~5.7k stars, TypeScript, last push 2026-05-30 (active).
- **Paradigm:** markdown-file task system usable as **TUI board, web board, or CLI**; integrates with agents via **MCP**.
- **Visualizes:** Kanban board over tasks defined as markdown files committed in the repo; acceptance criteria per task.
- **Orchestration:** "**one task per agent session, one PR per task**" discipline; task-splitting workflow so sessions don't conflict. Git-native (tasks are tracked files).
- **Backend:** agnostic via MCP (CC, Codex, Gemini, Kiro).
- **Steal:** **tasks-as-committed-markdown** (board state versioned in the repo, diffable, no external DB) + the enforced "one task ↔ one session ↔ one PR" unit of work. Source: https://github.com/MrLesk/Backlog.md.

---

## 3. Web dashboard / desktop GUI paradigm

Native apps or web UIs, typically a 3-panel layout (sessions | chat | diff+terminal). Worktree- or container-isolated.

### Conductor — conductor.build (Melty Labs)
- URL: https://www.conductor.build/ — closed-source native **Mac app** (Apple Silicon), YC S24, free (BYO subscription). Actively shipping; Windows on waitlist.
- **Paradigm:** native macOS app, **three-panel UI**: left = workspaces (each named after a city); middle = Claude-Code-style chat with `@file` + slash commands; right = live git diff view + integrated terminal.
- **Visualizes:** per-workspace chat, live file changes/diffs, terminal.
- **Orchestration:** **git worktree + branch per workspace**, copies only git-tracked files (no node_modules dup); merge + PR handling built in; recommends 3–5 parallel workspaces.
- **Backend:** Claude Code + Codex; also OpenRouter/Bedrock/Vertex/Vercel Gateway for the model.
- **Steal:** memorable **human-friendly workspace names** (cities) instead of branch hashes; the right-panel **always-on diff + terminal** beside chat. Source: https://www.conductor.build/, https://docs.conductor.build/.

### Crystal → Nimbalyst — stravu/crystal
- URL: https://github.com/stravu/crystal — ~3.1k stars, TypeScript, last push 2026-02-26. **Rebranded to "Nimbalyst"** (repo notes the rename; verify continued dev under new name).
- **Paradigm:** desktop app (Electron) for running multiple CC/Codex sessions in **parallel git worktrees**.
- **Visualizes:** parallel sessions; **diff comparison across approaches** (test/compare multiple agent attempts side by side).
- **Orchestration:** worktree-per-session; compare approaches and pick.
- **Steal:** **side-by-side comparison of competing approaches** to the same task as a primary UI surface. Source: https://github.com/stravu/crystal.

### Sculptor — imbue-ai/sculptor (Imbue)
- URL: https://github.com/imbue-ai/sculptor — ~171 stars (small repo; product is the desktop app), last push 2026-05-16. Mac (Apple Silicon) + Linux; **requires Docker**. Free beta.
- **Paradigm:** desktop UI; **one Docker container per agent** (not worktrees) so agents run/test code in true isolation in parallel.
- **Visualizes:** per-agent sessions with **full preserved history** (plans, chats, tool calls, code changes); a **visual merge-conflict resolver** for when parallel agents touch the same files.
- **Orchestration:** parallel container-isolated agents; **"Pairing Mode"** = one-click bidirectional sync of an agent's container work into your local IDE/git for live testing, then commit what you like; roadmap: forking an agent from any point in history.
- **Backend:** Claude Code + Codex.
- **Steal:** (1) **container-per-agent** (no dependency-reinstall pain of worktrees; agents can safely run tests); (2) **Pairing Mode** bidirectional sync to local IDE; (3) **fork-from-any-point-in-session-history**. Sources: https://imbue.com/sculptor/, https://github.com/imbue-ai/sculptor.

### coder/mux
- URL: https://github.com/coder/mux — ~1.8k stars, TypeScript, last push 2026-06-05 (very active).
- **Paradigm:** **desktop *and* browser** app for isolated parallel agentic development.
- **Visualizes/Orchestrates:** plan + execute tasks across multiple agents on **local, worktree, or SSH-backed remote compute**; multi-model agent loop (not a single-CLI wrapper). Worktrees stored at `~/.mux/src/<project>/<workspace>`, shared `.git` so commits are instantly visible across worktrees; agent may switch/create branches freely.
- **Steal:** **pluggable runtime (local / worktree / remote SSH)** behind the same UI — lets agents run on servers, not just the laptop; browser access to a desktop-class orchestrator. Sources: https://github.com/coder/mux, https://mux.coder.com/runtime/worktree.

### Omnara — omnara-ai/omnara
- URL: https://github.com/omnara-ai/omnara — ~2.6k stars, TypeScript, YC S25, last push 2026-01-19 (open-source backend; commercial apps newer).
- **Paradigm:** **web + native mobile (iOS/Android, Apple Watch)** command center.
- **Visualizes:** real-time agent activity; agent messages streamed via **SSE**; approve changes with one tap; push notifications when an agent needs you.
- **Orchestration:** **remote launch** of CC/Codex from phone/web; GitHub Actions dispatch; **cloud session migration** (move a live session off your laptop to the cloud keeping uncommitted state). Built as a CLI wrapper that parses `~/.claude/projects` session files + terminal output (no shell access).
- **Backend:** Claude Code, Codex CLI, n8n.
- **Steal:** (1) **approval/permission prompts as the core mobile interaction** (one-tap Allow/Deny while away); (2) **session migration laptop→cloud** without losing uncommitted state. Sources: https://github.com/omnara-ai/omnara, https://www.omnara.com/.

### Happy — slopus/happy
- URL: https://github.com/slopus/happy — **~21.6k stars**, TypeScript, last push 2026-06-01 (very active).
- **Paradigm:** **mobile + web client** for CC/Codex; run `happy` instead of `claude` to wrap the session.
- **Visualizes:** multiple concurrent sessions each with own context/history; per-session state; encrypted multi-device sync.
- **Orchestration:** **cross-device handoff** — capture full terminal state on desktop, reconstruct on phone within ms; press any local key to reclaim. **End-to-end encrypted relay** (server sees only opaque blobs). Real-time **permission interception** (Allow/Deny on mobile). Access to slash commands + `~/.claude/agents/`.
- **Backend:** Claude Code, Codex.
- **Steal:** (1) **zero-knowledge encrypted relay** for multi-device session sync; (2) **seamless desktop↔mobile handoff with instant local reclaim**; (3) **heuristic notifications** (only ping on permission/error/completion, not every line). Sources: https://github.com/slopus/happy, https://happy.engineering/.

### Terragon — terragon-labs/terragon-oss  ⚠️ DEAD
- URL: https://github.com/terragon-labs/terragon-oss — ~238 stars, TypeScript, **company SHUT DOWN 2026-02-09**, code open-sourced (last push 2026-02-10).
- **Paradigm (historical):** cloud **web dashboard** + CLI + mobile for **remote background agents**.
- **Visualized/Orchestrated:** parallel async cloud tasks, each in a **sandboxed container with its own repo copy**; real-time task status streamed to browser; spawned branches/tests/PRs automatically; **scheduled multi-hour automations** (e.g. run at 9am & 5pm); GitHub/Slack delegation; pull a cloud task local when it needs you.
- **Backend:** CC, Codex, Amp, Gemini.
- **Steal:** **scheduled/recurring background agent runs** and **delegate-from-Slack/GitHub-issue** ingestion — even though the product is dead, the OSS code documents the pattern. Source: https://github.com/terragon-labs/terragon-oss, https://www.terragonlabs.com/.

---

## 4. Infrastructure / supporting layers (not visualizers, but relevant primitives)

### container-use — dagger/container-use
- URL: https://github.com/dagger/container-use — ~3.8k stars, Go, last push 2026-02-23.
- **Paradigm:** **MCP server + CLI**; gives each agent an isolated containerized dev environment with branch tracking; you can inspect/log/diff each agent's environment.
- **Steal:** **environment-per-agent via MCP** with full command logs you can replay — strong isolation + auditability primitive for an orchestrator backend. Source: https://github.com/dagger/container-use.

### AgentAPI — coder/agentapi
- URL: https://github.com/coder/agentapi — ~1.4k stars, Go, last push 2026-05-27.
- **Paradigm:** **HTTP API** that fronts headless agent CLIs (CC, Goose, Aider, Gemini, Amp, Codex) with a unified message/status interface.
- **Steal:** a **uniform HTTP control plane** (send message, read status, stream output) is exactly the backend an orchestrator TUI should drive — decouples UI from any specific CLI. Source: https://github.com/coder/agentapi.

### claude-code-router — musistudio/claude-code-router
- URL: https://github.com/musistudio/claude-code-router — **~34.7k stars**, TypeScript, last push 2026-03-04.
- **Paradigm:** **router/proxy** (no UI) — use the CC frontend but route requests to any model backend (OpenRouter, local, etc.) with per-task model rules.
- **Steal:** **per-task model routing** (cheap model for grunt work, frontier model for hard tasks) as an orchestration cost-control lever. Source: https://github.com/musistudio/claude-code-router.

### CCSeva — Iamshankhadeep/ccseva
- URL: https://github.com/Iamshankhadeep/ccseva — ~795 stars, last push 2026-03-07.
- **Paradigm:** macOS **menu-bar** usage monitor (tokens, cost, burn rate, plan detection, 70/90% alerts).
- **Steal:** **quota/burn-rate awareness surfaced ambiently** — critical when running many parallel agents that burn plan limits fast. Source: https://github.com/Iamshankhadeep/ccseva.

### claude-powerline — Owloops/claude-powerline
- URL: https://github.com/Owloops/claude-powerline — ~1.1k stars, last push 2026-05-31.
- **Paradigm:** vim-style **statusline** for CC (git, usage, cost, context %).
- **Steal:** dense single-line **status segment design** (branch + cost + context-remaining) reusable as a per-session status row in a TUI. Source: https://github.com/Owloops/claude-powerline.

---

## Cross-cutting patterns worth stealing for an orchestrator TUI

1. **Worktree-per-task is the de-facto isolation standard** (Squad, Conductor, Vibe Kanban, Crystal, coder/mux). Sculptor's **container-per-agent** is the more isolated alternative (safe `run tests`, no dep reinstall) — pick based on whether agents need to execute code.
2. **Explicit per-session status (busy / waiting-for-input / idle)** is the highest-value glance primitive (ccmanager, lunemis/mux badges). An orchestrator's job is surfacing *which agent is blocked on me*.
3. **Review-before-merge with inline-comment feedback loop** (Vibe Kanban, Claude Squad). Diff review and "comment routed back to agent" should be first-class, not a side trip to GitHub.
4. **Re-roll / fan-out / compare** modes: Vibe Kanban "Attempts", uzi fan-out race, Crystal side-by-side. The unit isn't "a run", it's "attempts at a task".
5. **Decouple UI from agent CLI** via a control plane (AgentAPI HTTP, container-use MCP) and **route models per task** (claude-code-router) for cost control.
6. **Ambient quota/cost awareness** (CCSeva, powerline) matters once you run 5+ parallel agents.
7. **Notify only on actionable events** (Happy/Omnara heuristics: permission, error, completion) rather than streaming every line.

---

## Recency flags
- **DEAD:** Terragon (company shut 2026-02-09, code OSS only).
- **STALE (~12 mo):** uzi (last push 2025-06-04) — verify before relying on it.
- **REBRANDED — verify continuation:** Crystal → Nimbalyst (last push under `stravu/crystal` 2026-02-26); claude-flow repo renamed `ruvnet/ruflo`.
- **VENDOR SUNSETTING (still OSS):** Vibe Kanban (announced sunset, community-maintained going forward).
- Everything else was pushed within the last ~6 months as of 2026-06-05; the TUI-list and desktop categories are the most actively developed.
