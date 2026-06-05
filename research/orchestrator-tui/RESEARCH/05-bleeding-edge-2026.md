# Bleeding-Edge Multi-Agent Orchestration / Visualization Tools (Late 2025 – mid 2026)

Research date: 2026-06-05. Bias: tools with activity in 2025-H2 and 2026. Recency flags noted per tool. Star counts are approximate (GitHub at time of fetch).

---

## TL;DR trends (newest, 2026)

1. **The category exploded and bifurcated.** Multiple Show HN posts within weeks of each other in early 2026. The split: (a) **tmux-native + Claude-Code-specific** monitors vs (b) **agent-agnostic** control panes supporting Claude Code + Codex + Gemini CLI + Copilot + OpenCode + Hermes + ACP-compliant runtimes.
2. **Git worktree isolation is now table stakes** — near-universal by ~April 2026. Even Claude Code (`--worktree`) and Cursor 2.0 (8 concurrent agents) ship it natively. Anthropic also shipped **Agent View** (session manager, v2.1.139) and **Agent Teams** (experimental orchestrator) and Managed Agents (beta).
3. **Novel visual metaphors are emerging** as a differentiator: Tamagotchi pixel-creatures (Recon), RTS/game canvas (vibecraft), bee-hive "Queen + drones" (swarm), WhatsApp-chat-list (clideck), cryptographic agent identities w/ identicons (agent-kanban).

---

## TERMINAL-TUI tools

### Recon — `gavraz/recon`
- URL: https://github.com/gavraz/recon
- Stars: small/new (not surfaced; MIT, Rust). **Announced 2026-03-14** — very fresh.
- UI paradigm: **terminal-TUI**, tmux-native, popup overlay workflow. Dual-view.
- Visualizes: table view (session name, git branch, cwd, status, model Opus/Sonnet/Haiku, context-window token usage, last-activity time) **and a "Tamagotchi" view** — agents as pixel-art creatures with state animations (green blob = Working, orange pulsing = Input-needed, sleeping blue-grey = Idle, cream egg = New).
- Orchestration model: **passive monitoring/aggregation** (not active orchestration). Reads Claude Code's own internal files; PID-linked JSON + project JSONL; detects status by parsing tmux pane status-bar text. Zero modifications to Claude Code.
- Backend: **Claude Code only**.
- KEY IDEAS TO STEAL: (1) **Zero-instrumentation status detection** by reading CC's own JSONL + tmux pane status text — no wrapper/hook needed. (2) **Tamagotchi affect layer** — emotional/at-a-glance agent state that makes "needs input" instantly legible. Source: https://agent-wars.com/news/2026-03-14-recon-tmux-tui-claude-code-sessions

### VibeMux — `UgOrange/vibemux`
- URL: https://github.com/UgOrange/vibemux
- Stars: ~53. Release v0.1.0 **2026-01-09** (fresh, early-stage).
- UI paradigm: **terminal-TUI**, Bubble Tea / Elm architecture; **configurable grid up to 3×3 (9 panes)**.
- Visualizes: live terminal output of parallel CC/Codex instances in a tiled grid.
- Orchestration: multi-session pane orchestration with unified navigation.
- Backend: **Claude Code + Codex** (+ CCR), profile-based per-project driver config.
- KEY IDEAS: (1) **Non-intrusive env injection** (no global config edits). (2) Configurable **auto-approval safety levels** per prompt + desktop alerts/webhooks.

### Agent Deck — `asheshgoplani` (Agent Deck)
- Keyboard-driven tmux session manager. Out-of-box: Claude Code, Gemini CLI, Codex, OpenCode; custom detection patterns via `config.toml`.
- UI paradigm: **terminal-TUI** over tmux; instant switching. Shortcuts: `n` new, Enter attach, `Ctrl+Q` detach, `M` MCP manager, `f` fork session, `/` search, `@` filter waiting sessions.
- KEY IDEA TO STEAL: **`@` filter-to-waiting** — one keystroke to show only agents needing human input (the core triage problem). Source: https://dev.to/asheshgoplani/how-to-manage-multiple-claude-code-gemini-and-codex-sessions-in-one-terminal-1dci

### Operator — `untra/operator`
- URL: https://github.com/untra/operator
- UI paradigm: **TUI kanban**, **ticket-first**. Wraps tmux / cmux / Zellij session multiplexers.
- Orchestration: launches LLM agents keyed off **markdown stories from a ticketing provider** across multi-project workspaces.
- KEY IDEA: ticket/markdown-story as the unit of work that spawns an agent (spec → agent binding).

### claude-swarm — `birdythedev/claude-swarm`
- URL: https://birdythedev.github.io/claude-swarm/ — Rust TUI.
- UI paradigm: **terminal-TUI** with multiple dedicated views: Dashboard, Agent Detail, Tasks, Logs, **Office**, Settings, Performance.
- Orchestration: multi-agent Claude orchestrator; **Telegram bot remote control** (send tasks, check status, notifications from phone).
- Backend: Claude Code.
- KEY IDEA: **"Office" view** metaphor + **Telegram remote control** as a mobile companion without building a web app.

### ntm (Named Tmux Manager), amux, openkanban, gwq
- `ntm`: spawn/tile/coordinate Claude+Codex+Gemini across tmux panes with a **TUI command palette**.
- `amux`: TUI for parallel coding agents.
- `openkanban`: **TUI kanban** board for orchestrating agents.
- `gwq`: status **dashboard of all active worktrees across repositories** + tmux integration. KEY IDEA: cross-repo worktree dashboard (most tools are single-repo).
- Catalog: https://github.com/andyrewlee/awesome-agent-orchestrators (~674 stars) and https://github.com/bradAGI/awesome-cli-coding-agents

---

## TUI + WEB HYBRID (mobile-companion)

### Agent of Empires (AoE) — `agent-of-empires/agent-of-empires`
- URL: https://github.com/agent-of-empires/agent-of-empires
- Stars: ~2.5k. **v1.10.0 on 2026-06-03** — very actively maintained (best-in-class recency).
- UI paradigm: **dual TUI + web dashboard (PWA)**, mobile-first.
- Visualizes: session status (running/waiting/idle/error), diff view, tmux terminal output, and **agent state via Agent Client Protocol (ACP) with plan panels + tool-call cards**; swipe-to-approve on mobile.
- Orchestration: sessions persist as background tmux instances; create/monitor/control many parallel agents across branches/repos. Git worktrees + multi-repo workspaces + Docker sandboxing.
- Backend: **huge agnostic list** — Claude Code, OpenCode, Mistral Vibe, Codex CLI, Gemini CLI, Antigravity CLI, Cursor CLI, Copilot CLI, Pi.dev, Factory Droid, Hermes, Kiro CLI, Qwen Code.
- KEY IDEAS TO STEAL: (1) **Press `R` in TUI to expose a web dashboard over HTTPS** with QR + passphrase auth via Tailscale Funnel / Cloudflare Tunnel — instant secure mobile companion. (2) **Render ACP plan panels + tool-call cards + swipe-to-approve** as the structured-output layer above raw terminal.

### clideck — `rustykuntz/clideck`
- URL: https://github.com/rustykuntz/clideck
- UI paradigm: **web dashboard, WhatsApp-like chat-list metaphor** in one browser window; phone-capable.
- Visualizes: live status, session resume; **autopilot routing between agents**.
- Backend: Claude Code, Codex, Gemini CLI, OpenCode.
- KEY IDEA: **chat-list mental model** (each agent = a chat thread) — extremely familiar triage UX for "which agent pinged me."

### Conduit — getconduit.sh
- URL: https://getconduit.sh/ (site 403'd to fetch; via search) — **purpose-built multi-agent TUI**.
- UI paradigm: **terminal-TUI**, tab-based session management, real-time streaming, token tracking; switch agents with one keystroke.
- Backend: Claude Code + Codex CLI + Gemini CLI side-by-side.
- KEY IDEA: single-keystroke agent switching + per-tab token meters.

---

## KANBAN-BOARD tools

### Agent Kanban — `saltbo/agent-kanban`
- URL: https://github.com/saltbo/agent-kanban — site https://agent-kanban.dev/
- Stars: ~327. **v1.13.4 on 2026-05-19** — fresh, fast-moving. License FSL-1.1-ALv2. Deploys on **Cloudflare Pages + D1**, serverless.
- UI paradigm: **kanban board** (Todo → In Progress → In Review → Done), real-time SSE.
- Visualizes: tasks, agent lifecycle (idle → working → offline), per-agent **identicon**, PR review chains.
- Orchestration: **leader-worker model** — leader decomposes goal, assigns to workers; workers self-organize into teams, claim tasks, each in own worktree, open PRs; leader reviews/merges; daemon auto-completes on merge. Agents have **roles** (architect/frontend/backend/reviewer) loading different **skills**.
- Backend: Claude Code, Codex CLI, Gemini CLI, GitHub Copilot, Hermes, **any ACP-compliant agent**.
- KEY IDEAS TO STEAL: (1) **Cryptographic agent identity** — Ed25519 keypair + JWT + identicon that follows an agent across tasks/commits/PRs (provenance + trust). (2) **Agent-reviews-agent**: one agent's PR gated by another agent before human sign-off.

### ai-agent-board — `DanWahlin/ai-agent-board`
- URL: https://github.com/DanWahlin/ai-agent-board
- Stars: ~22. No tagged releases; active main (~199 commits) — new (2026).
- UI paradigm: **drag-and-drop kanban** (Backlog / In Progress / Review / Done); xterm.js ANSI event viewers per card.
- Orchestration: provider pattern via `@codewithdan/agent-sdk-core`; **Task Groups** — batch 2–20 child tasks, each with own agent type + worktree toggle, **parallelism slider** (1..N). Worktree isolation + auto-cleanup; local-merge or auto-PR.
- Backend: GitHub Copilot, Claude Code, OpenAI Codex, OpenCode, Hermes (auto-detected at startup).
- KEY IDEA TO STEAL: **parallelism slider on a task group** — declaratively cap concurrent agents on a batch of related tasks.

### Vibe Kanban — vibekanban.com
- Cross-platform CLI + web kanban; plan tasks, run agents in parallel, visual code review. **Now community-maintained** (Bloop shut down) — flag: maintenance status uncertain. Limitation: no hard task dependencies (no DAG). Source: https://vibekanban.com/

### dorothy — `Charlie85270/Dorothy`, agentsmesh — `AgentsMesh/AgentsMesh`, Spec-Kitty
- dorothy: **desktop app**, automations + Kanban + MCP servers. URL: https://github.com/Charlie85270/Dorothy
- agentsmesh: "AI Agent Workforce Platform" — remote workstations w/ **PTY sandboxes** + worktree isolation + built-in Kanban. URL: https://github.com/AgentsMesh/AgentsMesh
- Spec-Kitty: spec-driven dev across Claude/Cursor/Gemini/Codex + Kanban + worktrees + auto-merge.

---

## WEB-DASHBOARD tools

### swarm — `bschleifer/swarm`
- URL: https://github.com/bschleifer/swarm
- Stars: ~4 (very new). ~1,190 commits, no dated releases — actively built 2026.
- UI paradigm: **web dashboard (PWA)** at localhost:9090, interactive terminal attach + task board, WebSocket live updates.
- Visualizes: worker state with bee-hive states **BUZZING / RESTING / WAITING / STUNG**, live PTY output, task assignments, inter-worker messages, **Queen/drone decision proposals**.
- Orchestration: **bee-hive metaphor** — multi-layer decision stack: hooks (instant approvals) → background **drones** (poll at intervals, auto-approve/escalate, revive crashed workers) → headless Claude **"Queen"** (cross-worker coordination, task matching, drafts email replies). MCP server exposing 12 coordination tools (file claims, learnings, messages). **Verifier drone** = adversarial post-completion check.
- Backend: Claude Code (prod, powers Queen), Gemini CLI + Codex (experimental).
- KEY IDEAS TO STEAL: (1) **Tiered autonomy stack** (hook → drone → Queen) so routine approvals never stall agents but risky ones escalate. (2) **Adversarial verifier drone** that re-checks "done" work. (3) **File-claim coordination** via MCP to prevent two agents touching the same file.

### Claude-Code-Agent-Monitor — `hoangsonww/Claude-Code-Agent-Monitor`
- URL: https://github.com/hoangsonww/Claude-Code-Agent-Monitor
- UI paradigm: **web dashboard + macOS native app**; React/Vite/Tailwind + WebSockets + SQLite.
- Visualizes: sessions, agent activity, tool usage, **subagent orchestration**, live analytics, **Kanban status board**, status notifications, and **a "cute buddy"** affect widget.
- Backend: Claude Code. Featured in a 2026 "Show HN: Real-time dashboard for Claude Code agent teams". Note from author: **background/fire-and-forget hooks** measurably improved CC performance vs synchronous hooks. Source: https://news.ycombinator.com/item?id=47602986

### claude-code-dashboard — `Stargx/claude-code-dashboard`
- URL: https://github.com/Stargx/claude-code-dashboard
- UI paradigm: lightweight **localhost web dashboard**, monitoring-only.
- Visualizes: token usage, costs, active tools, subagents, session status across all terminals at a glance.
- Backend: Claude Code only. KEY IDEA: solves the "no cross-session token/cost view" gap minimally.

### Composio Agent Orchestrator (AO) — `ComposioHQ/agent-orchestrator`
- URL: https://github.com/ComposioHQ/agent-orchestrator
- UI paradigm: **single web dashboard** supervising a fleet.
- Orchestration: **most autonomous** — each agent gets own worktree + branch + PR; **fixes CI failures, responds to review comments, manages own PR lifecycle** without per-edit approval. Agent-agnostic (Claude Code, Codex, Aider, OpenCode), runtime-agnostic (tmux / ConPTY / Docker), tracker-agnostic (GitHub, Linear).
- KEY IDEA TO STEAL: **autonomous PR-lifecycle loop** (CI-fix + review-response) as a first-class agent capability surfaced in the UI.

### Agentrooms — claudecode.run
- URL: https://claudecode.run/ — multi-agent workspace; **@mention routing to specific agents** or auto-decompose across agents. Gained ~300 stars in 3 days (2026). KEY IDEA: `@agent` mention-based task routing.

---

## DESKTOP APPS (parallel sessions + worktrees)

### mux — `coder/mux`
- URL: https://github.com/coder/mux
- Stars: ~1.8k. **v0.26.1 on 2026-05-31** — very active, by Coder.
- UI paradigm: **desktop + browser (responsive mobile)** + VS Code extension.
- Visualizes: **git divergence UI** (changes + potential conflicts) across distributed workspaces, agent-status sidebar, integrated code review, **Mermaid diagrams for complex proposals**, token/cost table, context-management dialog.
- Orchestration: parallel isolated workspaces with three runtimes — **local / git worktree / SSH remote**. Plan/Exec mode.
- Backend: model-agnostic — Claude Sonnet-4 / Opus-4, Grok, GPT-5, Ollama (local), OpenRouter.
- KEY IDEAS TO STEAL: (1) **Central git-divergence visualization** across all workspaces (see conflicts before merge). (2) **"Opportunistic compaction"** for context mgmt. (3) **Mermaid-rendered agent proposals** in-UI.

### jean — `coollabsio/jean`
- URL: https://github.com/coollabsio/jean
- Stars: ~1.0k. **v0.1.53 on 2026-06-03** — extremely fresh, by coolLabs.
- UI paradigm: **native desktop (Tauri v2 / React 19) + web** via built-in HTTP server; **multi-dock terminal** (floating/left/right/bottom) + command palette.
- Visualizes: project workflows, git worktrees, chat sessions, GitHub/Linear, unified + side-by-side diffs, file trees, AI conversation histories across sessions.
- Orchestration: local-first; **Plan / Build / Yolo** execution modes with plan-approval flows; multi-agent collaboration.
- Backend: Claude (Opus 4.5/4.6, Sonnet 4.6, Haiku), Codex CLI, Cursor CLI, OpenCode; per-prompt model/backend/effort selection.
- KEY IDEAS TO STEAL: (1) **Per-prompt model + effort picker**. (2) **Magic Commands** (investigate issue/PR, code-review with finding tracking, AI commit gen). (3) **Session recap/digest** AI summaries + archiving — solves "what did this abandoned session do?"

### Crystal → Nimbalyst — `stravu/crystal`
- URL: https://github.com/stravu/crystal — Stars ~3.1k. **v0.3.5 2026-02-26, now DEPRECATED**, succeeded by Nimbalyst (https://nimbalyst.com/). FLAG: original repo stale, but successor active.
- UI paradigm: Electron multi-editor (Monaco + RevoGrid spreadsheets + Excalidraw diagrams). Real-time **agent edit streaming directly into open editors**; worktree isolation.
- KEY IDEA: stream agent edits live into the editor, not just a terminal.

### vibecraft — `rayzhudev/vibecraft`  ← most novel metaphor
- URL: https://github.com/rayzhudev/vibecraft
- Stars: ~26. **v0.5.5 on 2026-03-02** — fresh, niche.
- UI paradigm: **RTS game canvas** — infinite pannable canvas; agents/folders/terminals/browsers are spatial "units."
- Visualizes: agent units with status colors (gray/yellow/green/orange/red); spawn AI "units," attach to folder entities, run tasks via terminal panels; embedded browser panels; **"Hero" command-center entity** as anchor.
- Orchestration: canvas-based; selecting an entity triggers context "abilities"; worktree actions built into folder entities; multi-agent parallel execution with simultaneous terminal visibility.
- Backend: Claude Code CLI + Codex CLI.
- KEY IDEAS TO STEAL: (1) **Spatial/RTS unit metaphor** — agents as movable units on a canvas, "abilities" = context actions. (2) Status as **unit color/affect** for at-a-glance fleet legibility.

### Other desktop: constellagent (`owengretzinger/constellagent`, macOS, per-agent terminal+editor+worktree), cmux (`manaflow-ai/cmux`, parallel agents), emdash (Electron, Linear/GitHub/Jira intake + inline diff + PR), FleetCode (`built-by-as/FleetCode`, ~415 stars, **v1.0.1-beta.8 2025-10-26 — FLAG ~7.5mo old, getting stale**, worktree isolation + session persistence + MCP + terminal themes), dorothy.

---

## DAG / GRAPH visualizers (thinner category)
- **AI-Agents-Orchestrator** (`hoangsonww/AI-Agents-Orchestrator`): REPL or **Vue/Nuxt UI**; **graph-based context memory** (Graphify 22-language code analysis, queryable knowledge graphs, interactive viz); role-based agent runtime with lead-gated responses. URL: https://github.com/hoangsonww/AI-Agents-Orchestrator
- **Bernstein**: deterministic Goal → LLM Planner → **Task Graph** → Orchestrator → parallel Agents → Janitor (verify) → merge. KEY IDEA: **orchestrator scheduling is pure Python code (no LLM calls)** — deterministic, zero coordination tokens.
- **ccswarm** (`nwiizo/ccswarm`): Rust; specialized pools (Frontend/Backend/DevOps/QA) in worktrees + terminal UI. URL: https://github.com/nwiizo/ccswarm
- Note: true hard-dependency DAGs are rare; most "kanban" tools lack "task B waits for task A." A real DAG view + Bernstein-style deterministic scheduler is an open gap. Source: https://www.augmentcode.com/tools/open-source-agent-orchestrators

---

## RECENCY FLAGS
- **Very fresh (May–Jun 2026):** AoE v1.10.0 (Jun 3), jean v0.1.53 (Jun 3), mux v0.26.1 (May 31), agent-kanban v1.13.4 (May 19). Agentrooms + swarm + Claude-Code-Agent-Monitor actively built 2026.
- **Fresh (Jan–Mar 2026):** Recon (Mar 14), vibecraft v0.5.5 (Mar 2), VibeMux v0.1.0 (Jan 9).
- **Getting stale / deprecated (flag):** FleetCode v1.0.1-beta.8 (2025-10-26, ~7.5mo). Crystal deprecated Feb 2026 (use Nimbalyst). Vibe Kanban now community-maintained after Bloop shutdown.

## Top "steal-worthy" ideas for an orchestrator TUI
1. Recon's **zero-instrumentation status detection** (read CC's JSONL + tmux pane text) — works with unmodified agents.
2. swarm's **tiered autonomy** (hook → drone → Queen) + **adversarial verifier** + **MCP file-claims**.
3. AoE's **press-R → secure web/mobile companion** (Tailscale/Cloudflare tunnel + QR) and **ACP plan/tool-call cards**.
4. agent-kanban's **Ed25519 agent identity + agent-reviews-agent** gating.
5. mux's **cross-workspace git-divergence view**; jean's **session recap/digest** for abandoned sessions; Agent Deck's **`@` filter-to-waiting** triage; vibecraft's **spatial RTS unit** metaphor; Recon's **Tamagotchi affect** layer.
