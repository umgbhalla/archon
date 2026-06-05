# Orchestrator TUI — Landscape & Design Patterns

**Synthesized:** 2026-06-05 · **Sources:** `RESEARCH/01-claude-firstparty.md`, `02-codex-firstparty.md`, `03-thirdparty-orchestrators.md`, `04-dag-workflow-viz.md`, `05-bleeding-edge-2026.md`

> This report distills five research files into a landscape map and a concrete pattern library for building an advanced multi-agent orchestrator TUI (a terminal-native "command center" that runs/observes many coding-agent sessions in parallel).

---

## Executive summary (3 sentences)

The orchestrator-agent space has, in 2026-H1, converged on a clear stack — **worktree-per-task isolation** (table stakes), **explicit per-session state (busy / waiting-for-input / idle)** as the core triage primitive, and **review-before-merge with inline-comment feedback** — while the first parties (Anthropic's supervisor-hosted Agent View + peer-messaging Agent Teams + machine-generated Dynamic Workflows; OpenAI's Codex desktop "command center" with per-thread Local/Worktree/Cloud runtime selectors) push toward ever-larger autonomous fan-out with humans dropping to a "peek when it needs me" supervisory role. The richest UI paradigm for a terminal is the **TUI session list/grid** (Claude Squad, ccmanager, Recon, agent-deck), which should borrow the **DAG-viz world's run-inspector duality** (collapsible step tree + Temporal-style span timeline, color=status, click=detail) and the **bleeding-edge affect/identity layers** (Tamagotchi state, Ed25519 agent identicons, tiered autonomy). The biggest open gaps are **true hard-dependency DAG scheduling** (almost no "task B waits for task A"), **deterministic non-LLM orchestration**, **cross-repo/cross-machine fleet views**, and **unified cost/quota awareness** across many parallel agents — concrete opportunities for a differentiated tool.

---

## 1. Taxonomy of UI paradigms

Six paradigms recur across the survey. Most mature tools are hybrids, but each has a dominant metaphor.

| Paradigm | Mental model | First-party | Third-party / bleeding-edge | Terminal-native? |
|---|---|---|---|---|
| **Terminal-TUI list/grid** | rows = sessions; attach into one | Claude **Agent View** (`claude agents`), Codex **CLI** TUI | Claude Squad, ccmanager, agent-deck, lunemis/mux, workmux, Recon, VibeMux (3×3 grid), Conduit, ntm, amux | ✅ native |
| **Kanban board** | cards across To-Do → In-Progress → Review → Done | — | Vibe Kanban (web), Backlog.md (TUI+web+MCP), Operator (TUI kanban), openkanban (TUI), Agent Kanban, ai-agent-board | partial (some TUI) |
| **DAG / graph** | nodes = steps/agents, edges = flow/deps | Claude **Dynamic Workflows** (`/workflows view`, no explicit graph) | LangGraph Studio, Langflow, Flowise (AgentFlow V2), CrewAI `flow.plot()`, Rivet, n8n, graphs-tui (Mermaid/D2→ASCII) | ❌ mostly web/desktop |
| **Web dashboard** | browser fleet monitor, often + mobile | Claude **Code on the web**, Codex **Cloud/Web** | Omnara, Happy, clideck, swarm (bee-hive), Composio AO, Agentrooms, Conductor (native), Sculptor, coder/mux | ❌ |
| **IDE-embedded** | panel inside editor | Codex **IDE extension**, Claude Code VS Code ext | Crystal/Nimbalyst (stream edits into Monaco), jean | ❌ |
| **tmux-multiplexer** | sessions = tmux panes/windows | Claude **Agent Teams** (split-panes mode) | Claude Squad, workmux, lunemis/mux, gwq, Agent Deck, AoE | ✅ native |
| *(novel metaphors)* | spatial / game / creature | — | vibecraft (RTS canvas), Recon (Tamagotchi), swarm (bee-hive), claude-swarm "Office" view | varies |

**Where the action is for a TUI:** the **TUI-list + tmux-multiplexer** axis is the most actively developed and the only fully terminal-native paradigm. The **DAG/graph** paradigm is the richest source of *visualization ideas* but lives in web/desktop — its concepts (span timelines, run trees) must be re-rendered with terminal primitives (Ratatui Canvas + Braille markers, Textual `Tree`).

---

## 2. What gets visualized & how

| What | How the best tools show it | Exemplars |
|---|---|---|
| **Session state** | One glyph/row; **dual encoding** (color=logical state, shape=process liveness); 3-state model busy/waiting/idle | Agent View (`✻`/`∙`/`✢` color+shape), ccmanager (busy/waiting/idle badges), Recon (Tamagotchi affect), Conduit (per-tab) |
| **Task queue** | Shared task list with file-locked claiming + auto-unblocking deps; kanban columns | Agent Teams (shared list, dependency blocking), Vibe Kanban / Backlog.md / Agent Kanban (columns), Composio AO |
| **Diffs / PRs** | Inline diff in-pane + **inline comments routed back to agent**; PR-status column (color=PR state, hyperlinked) | Vibe Kanban (line-by-line + comments), Claude Squad (review-before-push gate), Agent View (`PR #2048`, color-coded), Conductor (always-on right-panel diff) |
| **Step DAG / lineage** | Step tree (causality) + span timeline (timing); pre-flight static DAG from code; lineage metadata | LangSmith (tree+waterfall), Temporal (Event-Group span rows), CrewAI `plot()`, Codex `parent_thread_id`/`forked_from_thread_id` |
| **Logs** | Spans not raw events (collapse N events → one labeled duration bar); per-node click→I/O detail; cited terminal logs + test output as proof | Temporal Event Groups, n8n per-node output, Codex "verifiable evidence" citations, container-use replayable logs |
| **Approvals / needs-input** | Distinct **blocking node/row state**; `@`/`s:blocked` filter-to-waiting; one-tap mobile approve; tiered escalation | Flowise HITL gate, LangGraph interrupts, agent-deck `@` filter, Agent View `s:blocked`, Happy/Omnara one-tap, swarm hook→drone→Queen |
| **Resource / cost** | Ambient quota/burn-rate; per-step token+cost accounting; context-% remaining; dense statusline segments | CCSeva (menu-bar burn rate), CrewAI Control Plane (per-step cost), claude-powerline (branch+cost+context%), Recon (context-window tokens), mux (token/cost table) |

**Cross-cutting viz rules (from DAG-viz world, file 04):** (1) two coupled views of one run — structure tree + timeline; (2) spans not raw events; (3) color=status, click=detail; (4) horizontal axis = elapsed time, always (Dagster discipline); (5) auto-layout always (no human positions nodes); (6) attach-to-live-execution and stream; (7) HITL as a visible blocking state.

---

## 3. Orchestration models

| Model | Description | Exemplars |
|---|---|---|
| **Parallel sessions** | N independent agent conversations run side-by-side; human switches/attaches | Agent View (background sessions), Codex threads, Claude Squad, every TUI-list tool |
| **Worktrees (file isolation)** | task → isolated git worktree + branch; near-universal by ~Apr 2026 | Claude `--worktree`/`bgIsolation`, Codex Worktree mode, Vibe Kanban, Conductor, coder/mux, gwq |
| **Container/VM isolation** | per-agent Docker container or managed VM (safe `run tests`, no dep reinstall; true process/network isolation) | Sculptor (container-per-agent), container-use (MCP env-per-agent), Claude Code on web (managed VM), Codex Cloud sandbox, AgentsMesh PTY sandbox |
| **Subagents / teams** | main agent delegates to children. Subagents report *up* only (cheap); teams are *peers* that message each other (mailbox, by name) | Claude subagents vs **Agent Teams** (peer mailbox + shared list); Codex opt-in subagents w/ lineage; claude-swarm YAML tree |
| **Supervisor / leader-worker** | a lead/queen decomposes a goal, assigns to workers, reviews/merges | Agent View daemon (per-user supervisor process); Agent Kanban leader-worker; swarm Queen/drones; claude-flow hive-mind; Composio AO |
| **Queue / scheduler** | tasks dispatched to a pool; scheduled/recurring background runs → review queue | Codex Automations (scheduled → review queue), Terragon (9am/5pm runs), Dynamic Workflows (~16 concurrent of up to 1000), Bernstein (deterministic Python scheduler, zero coordination tokens) |
| **Fan-out / race / attempts** | run N agents on the same task, compare, keep the winner | uzi (fan-out race), Vibe Kanban "Attempts" (re-roll w/ different agent), Crystal side-by-side, Codex best-of-N (1–4), ai-agent-board parallelism slider |

**Trajectory:** manual parallel sessions → worktree isolation → supervisor-hosted fleets → machine-generated orchestration graphs (Dynamic Workflows writes a JS script fanning to ~1000 subagents, keeping only verified results in context).

---

## 4. First-party direction vs where third parties add value

**Anthropic (Claude):** moving from "one terminal, one conversation" to a **supervisor-hosted fleet**.
- **Agent View** (v2.1.139, 2026-05-11) — the flagship *terminal* orchestrator: grouped session table (Pinned / Ready-for-review / Needs-input / Working / Completed), Haiku-generated row summaries, dual color+shape state icons, peek/attach, PR-status column, `claude agents --json` control plane (`{pid, status, waitingFor, ...}`). State on disk in `~/.claude/daemon/roster.json` + `~/.claude/jobs/<id>/`.
- **Agent Teams** (v2.1.32, ~Feb 2026, experimental) — peer agents with a **mailbox** (message by name) + shared task list with dependency blocking; tmux/iTerm2 split-panes or in-process cycling.
- **Dynamic Workflows** (2026-05-28, Opus 4.8) — Claude *writes a JS orchestration script*; `/workflows view` inspects phases/prompts/tool-calls without pausing; caching-backed resumability.
- **Claude Code on the web** + **Agent SDK** (`list_subagents()`, `get_subagent_messages()`, W3C OTel trace propagation) round out cloud + programmatic surfaces.

**OpenAI (Codex):** an explicit **multi-surface "command center"** (CLI + IDE + cloud + desktop app), one shared agent.
- **Codex desktop app** (macOS Feb 2026, Windows Mar 2026) — flagship orchestration surface: sidebar threads + diff viewer + task sidebar + integrated terminal; per-thread **Local / Worktree / Cloud runtime selector**; Automations → **review queue**.
- **Codex Cloud** — parallel async sandboxes, **best-of-N (1–4)**, `@codex` GitHub mentions, **verifiable-evidence** (cited logs/tests). Agent **lineage tracking** (`parent_thread_id`/`forked_from_thread_id`).
- **AGENTS.md** — the cross-tool config substrate (Linux Foundation, 20+ agents, 60k+ projects) any orchestrator must honor.

**Where third parties still add value (first parties don't cover well):**
1. **Agent-agnostic control** — first parties are single-vendor (CC-only or Codex-only). Third parties front *many* CLIs (ccmanager: 8 agents; AoE: 13+; ACP-compliant). A unified **HTTP/MCP control plane** (coder/AgentAPI, container-use) decouples UI from any CLI.
2. **True DAG / hard dependencies** — nobody first-party renders a dependency DAG with "B waits for A"; the DAG-viz frameworks (LangGraph/Temporal) live outside coding-agent UX.
3. **Cross-repo / cross-machine fleet view** — gwq (worktrees across repos), coder/mux + AoE (SSH/remote runtimes). First parties are largely single-repo/local.
4. **Cost/quota aggregation** — CCSeva, powerline, mux token tables solve the "no cross-session cost view" gap.
5. **Mobile companion + notifications** — Happy (E2E-encrypted relay, desktop↔phone handoff), Omnara (one-tap approve), AoE (press-R → tunnel + QR). First parties have web/mobile but not the encrypted-relay/one-tap-approve polish.
6. **Novel triage metaphors** — Recon Tamagotchi, vibecraft RTS canvas, clideck chat-list, Agent Kanban identicons.
7. **Per-task model routing** for cost (claude-code-router: cheap model for grunt work).

---

## 5. PATTERNS TO STEAL (the best ideas)

Each is concrete, attributed, and justified for a *terminal* orchestrator.

**State & triage**
1. **Dual-channel icon encoding** — color = logical state, glyph shape = process liveness (`✻` alive / `∙` exited-resumable / `✢` looping-asleep). *(Agent View)* — one glyph answers "does it need me?" *and* "is it even running?" in a single TUI cell.
2. **Explicit 3-state model: busy / waiting-for-input / idle.** *(ccmanager, lunemis/mux)* — the single highest-value glance primitive; turns "which of 8 agents is blocked on me?" into a scan.
3. **`@` / `s:blocked` filter-to-waiting** — one keystroke shows only agents needing human input. *(agent-deck, Agent View filters)* — collapses the core triage problem to a hotkey.
4. **Haiku-class one-line row summaries** + a `done/total` parallel-work counter. *(Agent View)* — a cheap LLM call turns each session into a scannable status line; peek surfaces the longest-running child without attaching.
5. **Tamagotchi / affect layer** — agent state as a pixel creature (green blob=working, orange pulse=needs-input). *(Recon)* — makes "needs input" instantly legible; cheap to render with Unicode/Braille.

**Isolation & runtime**
6. **Worktree-per-task** (default) with **container-per-agent** as the heavier option for code that must run tests. *(Conductor/Squad vs Sculptor; container-use via MCP)* — pick by whether the agent executes code.
7. **Per-session runtime selector: Local / Worktree / Cloud / SSH-remote** as a row badge. *(Codex threads, coder/mux)* — same UI, pluggable execution; agents can run on servers, not just the laptop.
8. **Teleport / session migration** — verify-repo + fetch-branch + load-history to move a *running* session between environments (local↔cloud) without losing uncommitted state. *(Claude `--teleport`, Omnara, Happy)*.
9. **Zero-instrumentation status detection** — read the agent's own JSONL + tmux pane status text; no wrapper/hook needed. *(Recon)* — works against unmodified agents; lowest integration cost.

**Review & feedback**
10. **Review-before-merge gate with inline diff comments routed back to the agent.** *(Vibe Kanban, Claude Squad)* — never blind-merge; comment-as-feedback keeps the loop inside the tool, not a GitHub side-trip.
11. **PR-status column** — hyperlinked `PR #1234`, color = PR state (pending/passed/merged/draft), count when multiple. *(Agent View)*.
12. **Verifiable-evidence pattern** — cite terminal logs + test outputs inline as proof of each step; gate finished background runs behind a **review queue**. *(Codex)* — makes "agent claims X" inspectable.
13. **Attempts / fan-out-then-select race** — the unit is "attempts at a task," not "a run"; re-roll with a different agent/prompt keeping history; compare side-by-side; best-of-N. *(Vibe Kanban Attempts, uzi, Crystal, Codex best-of-N)*.

**Orchestration logic**
14. **Shared task list with file-locked claiming + automatic dependency unblocking** — a lightweight DAG without a DAG UI; teammates self-claim the next unblocked task. *(Agent Teams)*.
15. **Tiered autonomy stack: hook → drone → Queen** — instant approvals via hooks, polling drones auto-approve/escalate, a headless coordinator handles risky cases. *(swarm)* — routine approvals never stall agents; risky ones escalate.
16. **Adversarial verifier** — a post-completion agent that re-checks "done" work (incl. Dynamic Workflows' convergence refuters). *(swarm verifier drone, Dynamic Workflows)*.
17. **Quality-gate lifecycle hooks** — `TeammateIdle` exit-2 keeps an agent working until tests pass. *(Agent Teams hooks)*.
18. **MCP file-claims** to prevent two agents editing the same file. *(swarm, container-use)*.
19. **Deterministic non-LLM scheduler** — orchestration/scheduling is pure code (zero coordination tokens). *(Bernstein)*.
20. **Move orchestration state out of context** — keep only verified results in the agent's window; intermediate state lives in script variables, with caching-backed resumability. *(Dynamic Workflows)*.

**Run inspection (from the DAG-viz world → terminal)**
21. **Tree + waterfall duality** — one collapsible step/agent tree (causality) toggling to a span timeline (timing). *(LangSmith, Temporal)* — render with Textual `Tree` + Ratatui Canvas.
22. **Spans, not raw events** — collapse N events into one labeled duration bar; root row = total runtime as a scale; show retry/compensation spans inline. *(Temporal Event Groups)* — use **Braille markers (U+2800–U+28FF)** for sub-cell timing precision in a terminal cell.
23. **Color=status + click=detail node** — selecting a node opens an I/O + tokens + cost + error pane; horizontal axis = elapsed time everywhere. *(LangSmith, n8n, Dagster)*.
24. **Pre-flight static DAG preview from the plan** before spending tokens; **auto-layout** mandatory. *(CrewAI `plot()`, Rivet Auto Layout)*.
25. **Attach to a separately-running orchestrator daemon and stream live node updates.** *(Rivet remote debugger; Agent View's daemon + `claude agents --json`)* — the TUI is a thin observer over a persistent supervisor.

**Identity, cost, mobile**
26. **Cryptographic agent identity** — Ed25519 keypair + identicon that follows an agent across tasks/commits/PRs. *(Agent Kanban)* — provenance + at-a-glance per-agent recognition.
27. **Agent-reviews-agent gating** — one agent's PR blocked by a reviewer agent before human sign-off. *(Agent Kanban)*.
28. **Ambient quota/burn-rate + dense statusline segments** (branch + cost + context-% in one line). *(CCSeva, claude-powerline, mux token table)*.
29. **Notify only on actionable events** — permission / error / completion, not every line. *(Happy, Omnara heuristics)*.
30. **Press-R → secure web/mobile companion** over a tunnel (Tailscale/Cloudflare) + QR + passphrase; render **ACP plan panels + tool-call cards + swipe-to-approve**. *(AoE)* — instant mobile reach without building a separate app.
31. **Session recap/digest** AI summary for abandoned/backgrounded sessions ("what did this do?"). *(jean; Agent View posts a recap on re-attach)*.
32. **Human-friendly workspace names** (cities) instead of branch hashes. *(Conductor)*.

---

## 6. Gaps & opportunities (what nobody does well yet)

1. **True hard-dependency DAGs.** Almost every kanban/list tool lacks "task B waits for task A" (explicitly noted for Vibe Kanban). Dynamic Workflows generates them but hides the graph; the rich DAG UIs (LangGraph/Temporal) aren't wired to coding-agent fleets. **Opportunity:** a terminal DAG view (Mermaid/D2→ASCII via graphs-tui, or Braille Gantt) over real task dependencies + a **deterministic Bernstein-style scheduler**.
2. **Run-inspection in the terminal.** The tree+waterfall/span-timeline duality is standard in web tools but absent from terminal orchestrators, which mostly show a flat session list + raw terminal attach. **Opportunity:** Temporal-style span rows + LangSmith-style step tree, terminal-native (Ratatui Braille).
3. **Cross-repo / cross-machine fleet view.** Most tools are single-repo, local. gwq and coder/mux/AoE gesture at it. **Opportunity:** a unified fleet across repos *and* across local/worktree/SSH/cloud runtimes in one TUI.
4. **Unified cost/quota across many parallel agents.** Running 10 agents ≈ 10× quota (Agent View caveat); only standalone monitors (CCSeva, powerline) address it, none integrated into the orchestrator. **Opportunity:** per-session + aggregate burn-rate + per-task model routing (claude-code-router) as a built-in cost-control lever.
5. **Agent-to-agent message visualization (swimlanes).** Agent Teams has a mailbox but no who-talked-to-whom view; AutoGen's message-flow swimlane is the only reference and it's in maintenance mode. **Opportunity:** render the mailbox/lineage (`parent_thread_id`) as a fork/spawn tree + message swimlane.
6. **Standardized, agent-agnostic control plane.** Each tool re-implements PTY/JSONL parsing. AgentAPI (HTTP) + container-use (MCP) + ACP point the way but adoption is partial. **Opportunity:** build the TUI against a uniform control plane (ACP / `claude agents --json` / AgentAPI) so it's CLI-agnostic from day one.
7. **Provenance/trust.** Only Agent Kanban does cryptographic agent identity; nobody else tracks "which agent produced which commit" with verifiable identity. **Opportunity:** Ed25519 identity + agent-reviews-agent gating as a trust layer.
8. **Graceful long-run resumability + recap.** Caching-backed resume (Dynamic Workflows) and session recap (jean, Agent View) exist but aren't combined into a robust "resume an hours-old fleet and tell me what happened" experience.

---

## Key repos cited (for follow-up)

First-party: `anthropics/claude-code` (Agent View, Teams, Dynamic Workflows), `anthropics/claude-agent-sdk-python|typescript`, `openai/codex`, `agents.md`.
TUI-list/tmux: `smtg-ai/claude-squad`, `kbwo/ccmanager`, `asheshgoplani/agent-deck`, `lunemis/mux`, `raine/workmux`, `gavraz/recon`, `UgOrange/vibemux`, `devflowinc/uzi` ⚠️stale.
Kanban: `BloopAI/vibe-kanban` (sunsetting/community), `MrLesk/Backlog.md`, `saltbo/agent-kanban`, `DanWahlin/ai-agent-board`, `untra/operator`.
Desktop/web: `stravu/crystal`→Nimbalyst, `imbue-ai/sculptor`, `coder/mux`, `omnara-ai/omnara`, `slopus/happy`, `terragon-labs/terragon-oss` ⚠️dead, `conductor.build`, `rayzhudev/vibecraft`, `bschleifer/swarm`, `ComposioHQ/agent-orchestrator`, `coollabsio/jean`, `agent-of-empires/agent-of-empires`.
Infra: `dagger/container-use`, `coder/agentapi`, `musistudio/claude-code-router`, `parruda/swarm`, `ruvnet/claude-flow`→ruflo, `Iamshankhadeep/ccseva`, `Owloops/claude-powerline`.
DAG-viz: `langchain-ai/langgraph`(+Studio/LangSmith), `langflow-ai/langflow`, `FlowiseAI/Flowise`, `crewAIInc/crewAI`, `microsoft/autogen` 🔴maint, `n8n-io/n8n`, `temporalio/temporal`, `dagster-io/dagster`, `Ironclad/rivet` 🟡, `decisiongraph/graphs-tui`.
TUI primitives: Ratatui (Canvas + Braille U+2800–U+28FF), Textual (`Tree`), gotui/termui.


---

## Addendum — the workflow-as-code paradigm (see RESEARCH/06)

The taxonomy above covers tools where the human (or a lead agent) drives turn by turn.
A second axis exists: **workflow-as-code**, where the plan is a script and the UI is a
**run inspector** rather than a session grid.

- **Claude Code Dynamic Workflows** (`/workflows`) — first-party. Script (`agent/parallel/
  pipeline/phase/budget`) runs in an isolated background runtime; the TUI shows a
  **phase → agent tree** with agent-count / token-total / elapsed-time, drill-in to each
  agent's prompt + tool calls + result, and live `p` pause/resume · `x` stop · `r` restart ·
  `s` save-as-command. Resumable via a journal (completed agents return cached results).
- **Codex-Workflows** (robzilla1738, `context/codex-workflows`) — open Codex port: MCP server
  + **QuickJS-isolated** script runtime + durable storage under `$CODEX_HOME`, with the same
  dashboard controls (64 concurrent / 2000 agents, per-phase model routing).

**Implication for the orchestrator TUI:** host BOTH surfaces — a fleet/session grid
("which agent needs me?") AND a workflow run-inspector ("what is this orchestrated job
doing, phase by phase?"). The run-inspector tree+metrics+drill-in directly fills the
terminal-native-run-inspection and cost/quota gaps named above; Codex-Workflows is the most
readable open implementation to study, CC's `/workflows` is the UX spec.
