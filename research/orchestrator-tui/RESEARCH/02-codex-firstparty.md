# Codex First-Party: Multi-Agent, Orchestration & Visualization Surfaces

_Research date: 2026-06-05. Focus: OpenAI Codex CLI, Codex app, Codex cloud/web, IDE extension, AGENTS.md._

## Executive Summary

OpenAI Codex has converged from a cloud-only async batch agent (May 2025) into a **multi-surface "command center" platform** spanning one shared agent across CLI, IDE, cloud, and a dedicated desktop app. The orchestration thesis is explicit in OpenAI's own framing: "the core challenge has shifted from _what_ agents can do to _how_ people can direct, supervise, and collaborate with them **at scale**" — and they argue IDEs/terminals are not built for this, hence the Codex desktop app. The dominant orchestration primitives are **threads** (parallel conversations organized by project), **git worktrees** (isolation so multiple agents touch the same repo without conflict), **cloud sandboxes** (parallel background execution + best-of-N attempts), **subagents** (explicit, opt-in fan-out, with v2 lineage tracking), and **automations** (scheduled background runs landing in a review queue). The platform is extremely active — multiple releases per week, last release v0.137.0 on **2026-06-04**, nothing stale.

---

## Surface-by-Surface Capture

### 1. Codex CLI (`codex`, `codex exec`, `codex resume`)
- **Name / repo:** OpenAI Codex CLI — `openai/codex` — https://github.com/openai/codex
- **Stars:** ~88.9k (2026-06-05)
- **Last release / commit:** **v0.137.0, 2026-06-04**; ~813 releases, ~7,164 commits. VERY ACTIVE (multiple releases/week). Primary language Rust (96%).
- **UI paradigm:** Full-screen **terminal TUI**. Real-time syntax-highlighted diffs, `@` fuzzy file search in composer, `/theme`, Ctrl+R prompt-history search, arrow-key draft history, F13–F24 keybindings (v0.137). Supports **remote TUI over WebSocket** (terminal on one machine, app-server elsewhere).
- **What it visualizes:** Live agent turn output, syntax-highlighted code/diffs, reasoning-only compact status/title items, plan/status. Stable identicons for background subagents (v26.527).
- **Orchestration model:**
  - `codex exec` = non-interactive/headless; `codex exec resume --last` or `resume <SESSION_ID>` continues a prior session (e.g. 2-stage "review then fix" pipelines). `--all` searches sessions outside cwd. `--json` (JSON Lines) for scripting, `--ephemeral` to skip persisting rollout files.
  - `codex resume --last` / `codex resume <SESSION_ID>` for interactive sessions; conversations stored locally.
  - **Subagents:** opt-in only — "Codex only spawns subagents when you explicitly ask it to." Each subagent independently consumes tokens/tools. Pattern: GPT-5.x plans/coordinates, mini subagents do narrow parallel subtasks (search, file review).
  - **Multi-root / worktrees:** `--add-dir` exposes additional writable roots (frontend+backend+shared lib in sync). Experimental multi-agent on isolated git worktrees for large refactors/migrations.
  - **MCP server mode:** Codex can run AS an MCP server inside other agent systems (STDIO or streaming HTTP) — integrates with OpenAI Agents SDK for auditable handoffs with full traces.
  - **Cloud from terminal:** `codex cloud exec --env ENV_ID --attempts N "..."` requests best-of-N (1–4) parallel cloud runs.
- **Backend agent:** Codex (GPT-5.x-Codex family; default ~GPT-5.2/5.4-Codex). Not model-agnostic.
- **Sources:** https://developers.openai.com/codex/cli , https://developers.openai.com/codex/cli/features , https://developers.openai.com/codex/cli/reference , https://developers.openai.com/codex/noninteractive

### 2. Codex App (desktop — macOS + Windows) — THE FLAGSHIP ORCHESTRATION SURFACE
- **Name / repo:** Codex app — distributed via `openai/codex` repo (`codex app` launches it). https://github.com/openai/codex
- **Released:** macOS **~2026-02-02** ("Introducing the Codex app", https://openai.com/index/introducing-the-codex-app/); **Windows 2026-03-04** (native PowerShell sandbox, no WSL). App version stream e.g. **v26.602 (June 2026)**, v26.527 (May 2026). VERY ACTIVE.
- **UI paradigm:** **Web/Electron-style desktop dashboard** — sidebar project/thread manager + main thread panel + diff viewer + task sidebar + integrated terminal (Cmd+J). Floating pop-out thread windows. NOT a kanban board and NOT a DAG; it's a **multi-thread workspace** (closest to a tabbed/list "command center"). Automation results land in a **review queue**.
- **What it visualizes:**
  - **Threads** — active conversations organized by project, run side-by-side, switchable without losing context; can pin/archive, continue, or find related thread.
  - **Inline diffs / git changes** — review agent changes in-thread, comment on the diff, open in editor for manual edits; diff = git diff of local project or worktree checkout.
  - **Task sidebar** — agent's plan, sources, generated artifacts, task summary.
  - **Artifacts** — preview PDFs, spreadsheets, presentations, docs.
  - **Integrated terminal** scoped to current project/worktree.
- **Orchestration model:** Three per-thread runtime modes — **Local** (current dir), **Worktree** (isolated git worktree, "multiple agents on same repo without conflict"; check out changes locally or let it progress without touching local git state), **Cloud** (remote configured env). Multi-project in one window. **Automations** (standalone scheduled tasks e.g. triage telemetry errors → submit fixes; + thread automations = recurring "wake-up calls" preserving thread context for heartbeat polling) run in dedicated background worktrees → review queue. **Skills** reusable across projects. **Computer Use** (GUI/browser automation). **Remote control:** start work from ChatGPT iOS/Android or Mac and track progress (Windows supported v26.527; pairing/grant RPCs v0.137).
- **Backend agent:** Codex. Shares config + agent with CLI; auto IDE-sync with Codex IDE extension.
- **Sources:** https://openai.com/index/introducing-the-codex-app/ , https://developers.openai.com/codex/app , https://developers.openai.com/codex/app/features , https://developers.openai.com/codex/changelog

### 3. Codex Cloud / Web (codex.openai.com, chatgpt.com/codex)
- **Name:** Codex cloud / Codex web. Access: https://chatgpt.com/codex (formerly the original 2025 launch surface). Part of ChatGPT Plus/Pro/Business/Edu/Enterprise.
- **Recency:** Original cloud agent launched **May 2025** ("Introducing Codex"); "work from anywhere" expansion **~2026-05-15**; continuously updated via changelog.
- **UI paradigm:** **Web dashboard** — task list with real-time progress monitoring; review/diff + PR proposal flow.
- **What it visualizes:** Background/parallel tasks each in its own preloaded cloud sandbox; **verifiable evidence** = citations of terminal logs + test outputs (traceable step-by-step); diffs; PRs. Best-of-N attempt comparison.
- **Orchestration model:** Built around **parallel, asynchronous** work — many tasks in parallel, each in isolated sandbox preloaded with repo (network off by default, restricted/full on demand). **Best-of-N attempts** (1–4) generate multiple candidate solutions. **GitHub `@codex`** mentions on issues/PRs spin up tasks and propose changes. Cloud environments configured (repo, setup steps, tools, internet access). Tasks typically 1–30 min. **Automations roadmap:** cloud-based triggers so Codex runs continuously in background (not only when computer is open).
- **Backend agent:** Codex.
- **Sources:** https://developers.openai.com/codex/cloud , https://developers.openai.com/codex/cloud/environments , https://openai.com/index/introducing-codex/ , https://openai.com/codex/

### 4. Codex IDE Extension (VS Code, Cursor, Windsurf, JetBrains)
- **Name:** Codex IDE extension. VS Code Marketplace (~4.9M installs, 3.4★ as of Feb 2026 — trails Claude Code's 5.2M/4.0★).
- **Recency:** Active; updates frequently. JetBrains + hybrid cloud-local workflow noted ~2026-04.
- **UI paradigm:** **IDE-embedded** panel (right sidebar by default, draggable to left). Chat + edit + preview.
- **What it visualizes:** Chat thread, file/selection context tags, model + reasoning-effort switcher, previewed edits/diffs, cloud-task progress + applied diffs.
- **Orchestration model:** **Cloud delegation is the headline** — offload longer jobs to cloud env, monitor + review **without leaving editor**, apply resulting diffs locally; **context preserved bidirectionally** across local↔cloud handoff. Autonomy modes: **Chat / Agent / Agent (Full Access)**. Same agent + config as CLI (caveat: `--profile` is CLI-only). First-party web search (cached index default + live mode), image gen ($imagegen), command palette bindings.
- **Backend agent:** Codex.
- **Sources:** https://developers.openai.com/codex/ide , https://developers.openai.com/codex/ide/features , https://codex.danielvaughan.com/2026/04/01/codex-ide-extension-vs-code-jetbrains/

### 5. AGENTS.md (cross-tool standard)
- **Name / site:** AGENTS.md — https://agents.md/ — open Markdown format for guiding coding agents.
- **Governance:** Stewarded by the **Agentic AI Foundation under the Linux Foundation**; co-created across OpenAI Codex, Amp, Google Jules, Cursor, Factory. **20+ agents** support it (Codex, Jules, Copilot, Cursor, Aider, VS Code, Devin...). **60,000+** OSS projects use it.
- **Relevance:** Per-project (and nested per-subproject in monorepos; closest file wins) instruction file — build steps, tests, conventions. The de-facto config substrate any orchestrator should honor.
- **Source:** https://agents.md/

---

## Recency / Staleness Flags
- Nothing stale. `openai/codex` ships multiple releases/week; last release **v0.137.0 (2026-06-04)**. App stream **v26.602 (June 2026)**. Cloud + IDE continuously updated. All five surfaces touched within the last month.

## Key Changelog Signals (2026)
- **v0.137.0 (Jun 2026):** Multi-agent v2 — runtime choice retained per thread, cleaner follow-up/metadata defaults for spawned agents, safer agent-close (rejects self-targeted close). Remote-control pairing/grant RPCs. TUI F13–F24 + compact reasoning-only status item.
- **v0.136.0 (May 2026):** Agent **lineage tracking** — `parent_thread_id` + `forked_from_thread_id` turn metadata across agent hierarchies.
- **v26.527 (May 2026):** Thread coordination for local projects/worktrees (separate background threads on request); search over conversation content + git branch names; stable identicons for background subagents; Computer Use + remote control on Windows.

---

## Key Ideas Worth Stealing for an Orchestrator TUI

1. **Threads-as-tasks with per-thread runtime selector (Local / Worktree / Cloud).** The single most portable idea: a list of parallel agent threads where _each one_ independently picks its execution context, and worktree isolation is first-class so N agents hit the same repo without conflict. Map directly to a TUI list/tabs where each row carries a runtime badge + worktree path.

2. **Verifiable-evidence + review-queue pattern.** Codex surfaces cited terminal logs and test outputs as traceable proof of each step, and automations dump finished work into a **review queue** rather than auto-merging. A supervisor TUI should make "agent claims X" inspectable (logs/test citations inline with the diff) and gate completed background runs behind a human review lane.

3. **(Bonus) Agent lineage metadata** (`parent_thread_id` / `forked_from_thread_id`) — cheap to store, enables rendering a real fork/spawn tree of subagents in a TUI, which is the missing visualization most multi-agent tools lack.

---

## Sources
- https://github.com/openai/codex
- https://developers.openai.com/codex , /cli , /cli/features , /cli/reference , /noninteractive , /sdk , /changelog
- https://developers.openai.com/codex/cloud , /cloud/environments
- https://developers.openai.com/codex/app , /app/features
- https://developers.openai.com/codex/ide , /ide/features
- https://openai.com/index/introducing-the-codex-app/ , https://openai.com/index/introducing-codex/ , https://openai.com/codex/
- https://agents.md/
- https://codex.danielvaughan.com/2026/04/01/codex-ide-extension-vs-code-jetbrains/
