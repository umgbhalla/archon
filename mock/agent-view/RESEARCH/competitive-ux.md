# Competitive UX Research: Multi-Agent / Multi-Session Management Tools

Research conducted 2026-06-05 to inform the Agent View mock. Each tool is broken down by:
**List UI** (how sessions + state are shown) / **Attached terminal** (how a live terminal/conversation is embedded) / **Needs-input handling** (approvals, blocked sessions) / **Notable UX** (keyboard vs mouse, what works/poorly).

A consolidated **Patterns worth adopting** summary is at the end.

---

## Claude Code Agent View (Anthropic)

The first-party reference. Built-in CLI dashboard (`claude agents`), Research Preview launched May 2026, requires v2.1.139+.

- **List UI:** A "roster" table, one row per background session. Each row shows: session name, a colored state icon, a summary of the last action, and how long ago status last changed. Crucially, **rows auto-sort by priority** — sessions that need you (blocked on permission or a multiple-choice question) rise to the top, then working, then completed, then failed. Six states with colors: Working, Needs input (yellow), Idle, Completed (green), Failed (red), Stopped (gray). Icon *shape* encodes process liveness: filled = alive/repliable now, dotted = process terminated but responsive, special symbol = `/loop` session sleeping between iterations.
- **Attached terminal:** Two tiers. A lightweight **peek panel** (Space on a row) shows what the session needs, recent output, and any PRs it opened — enough to act without attaching. Pressing Enter *attaches* to the full transcript; Esc detaches and sessions keep running. Left-arrow from a session also opens the view.
- **Needs-input handling:** The peek panel is the approval surface. Reply inline (type + Enter). For multiple-choice questions, the options render and you press a **number key** to pick. For other blocked sessions, **Tab fills a suggested reply** you can edit before sending. You rarely open the full transcript.
- **Notable UX:** Keyboard-first throughout. `/bg` backgrounds an existing session; `claude --bg [task]` launches headless. Strong "triage" mental model: reply to who's waiting, check successes, handle errors. Caveat surfaced prominently: N parallel sessions burn quota N× faster.
- Sources: https://code.claude.com/docs/en/agent-view , https://claude.com/blog/agent-view-in-claude-code , https://pasqualepillitteri.it/en/news/2384/claude-code-agent-view-cli-dashboard-sessions-2026

---

## claude-squad (smtg-ai)

Open-source Go TUI (`cs`), ~5.8k stars, the largest community among open multi-agent tools. Multi-vendor (Claude Code, Codex, OpenCode, Aider, Amp). tmux + git worktrees under the hood.

- **List UI:** Vertical list of instances/tasks in one terminal window, navigated with `↑/j` `↓/k`. A command menu sits at the bottom of the screen. State is functional but basic — no kanban, no tagging.
- **Attached terminal:** `↵/o` attaches to a session for re-prompting; `ctrl-q` detaches. A right-hand area has **preview and diff tabs**, switched with `tab`; `shift-↑/↓` scrolls the diff. So you get a live preview pane without fully attaching.
- **Needs-input handling:** Supports background completion including a **yolo / auto-accept mode** (no approval prompts). Review-oriented flow instead of inline approvals: `s` commit+push to GitHub, `c` checkout (commits + pauses), `r` resume. Approvals are handled by attaching, not a dedicated peek surface.
- **Notable UX:** Pure keyboard (`n` new, `N` new-with-prompt, `D` kill, `?` help, `q` quit). Worktree-first isolation is the safety story. Weakness: terminal-only, no visual diff beyond the text tab, no notifications; tmux + gh CLI prerequisites raise the barrier for non-terminal users.
- Sources: https://github.com/smtg-ai/claude-squad

---

## Vibe Kanban (BloopAI)

Open-source web app (`npx vibe-kanban`, localhost:3000), Rust orchestration + Node UI. Multi-agent (Claude Code, Codex, Gemini, Amp, Opencode, Copilot, Droid, Cursor Agent, Qwen). Note: announced sunsetting, continuing community-maintained.

- **List UI:** A literal **Kanban board** — To Do → In Progress → Review → Done — with cards as tasks. State is conveyed by column position rather than a status badge. A newer beta "Workspaces" mode adds an IDE-like layout with Repositories (multiple repos per workspace) and Sessions (multiple conversation threads per workspace, to work around token limits).
- **Attached terminal:** Each workspace spawns a full dev environment: dedicated branch, persistent terminal session, and hot-reloading dev server. Multiple sessions (threads) live inside one workspace.
- **Needs-input handling:** Review happens **inline in the UI** — leave comments on specific diff lines, request changes, and the structured feedback goes straight back to the agent, which iterates in the same workspace. No chat copy-paste. Implements MCP both directions (other agents can create/move cards).
- **Notable UX:** Mouse-first board metaphor maps well to "planning/reviewing > writing." When finished, open a GitHub PR or merge the branch locally. Multiple workspaces can attach to one issue for parallel attempts. Weakness: board ceremony can be heavy for quick one-off questions (they added unattached workspaces for exactly that).
- Sources: https://github.com/BloopAI/vibe-kanban , https://vibekanban.com/ , https://vibekanban.com/docs/getting-started , https://news.ycombinator.com/item?id=44533004

---

## Conductor (Melty Labs)

Free native macOS app (Apple Silicon). Claude Code + Codex, each in an isolated git worktree. Praised primarily for UI quality.

- **List UI:** A dashboard showing what every agent is doing and where it's stuck. "New Workspace" runs `git worktree add` on a fresh branch behind the scenes. Emphasis on clear visual design so you can run ~5 agents without cognitive overload — thread progress, diff previews, and test results shown without clutter.
- **Attached terminal:** Each workspace is a worktree on its own branch; you start Claude Code inside it using your existing login. Only git-tracked files are copied, so node_modules/.env don't duplicate (fast workspace creation).
- **Needs-input handling:** **Diff-first review** — you review only what changed regardless of repo size, then ship the PR from inside Conductor.
- **Notable UX:** Mouse-driven, polished native feel is the differentiator; users report multi-day sequential work compressed to hours. Supports BYO providers (OpenRouter, Bedrock, Vertex, Vercel AI Gateway). Weaknesses: Apple-Silicon-only (excludes Windows/Linux), early-stage rough edges, parallel runs burn quota fast (Max recommended over Pro).
- Sources: https://www.conductor.build/ , https://chatgate.ai/post/conductor , https://codepick.dev/en/guides/conductor-build-intro

---

## Crystal / Nimbalyst (Stravu)

Desktop app, the original "Integrated Vibe Environment (IVE)." Deprecated Feb 2026, succeeded by Nimbalyst (adds side-by-side Claude Code + Codex).

- **List UI:** Unified panel monitoring all sessions in real time, each in its own git worktree. **Explicit status indicators**: initializing, running, waiting for input, completed. Session Templates create multiple numbered sessions with one click (built for the "run the same prompt N times, pick the winner" workflow). Prompt History for quick reuse.
- **Attached terminal:** Conversation continuity — resume any session with full history intact. Integrated git ops (rebase, squash, view diffs) without leaving the app.
- **Needs-input handling:** "Waiting for input" is a first-class status; review via integrated diff viewer before merging.
- **Notable UX:** The "competing attempts" pattern (numbered parallel sessions of one prompt) is its signature contribution. Auto-handles repo init + worktree creation + instance management. Weakness: deprecated; much of its concept is now native in Claude Code's own desktop app.
- Sources: https://github.com/stravu/crystal , https://nimbalyst.com/blog/crystal-supercharge-your-development-with-multi-session-claude-code-management/

---

## uzi (devflowinc)

CLI for running *large numbers* of agents in parallel. Git worktree + tmux, per-agent dev server with assigned ports. Multi-agent (claude, codex, cursor, aider).

- **List UI:** `uzi ls -w` shows real-time progress and diffs across all agents in a watch view (no persistent GUI). Configured via `uzi.yaml` (a `devCommand` with `$PORT` placeholder; setup steps run per-worktree).
- **Attached terminal:** tmux-managed sessions; each agent gets an isolated worktree + its own dev server for live preview on a unique port.
- **Needs-input handling:** `uzi auto` automatically confirms tool calls (auto-approve). `uzi broadcast "..."` sends one message to *all* agents at once. `uzi checkpoint` rebases + commits selected agent branches back with one command.
- **Notable UX:** Optimized for *high fan-out* experimentation (`uzi prompt --agents claude:2,codex:1 "..."` spawns a fleet). Pure CLI, scriptable. Weakness: no rich GUI; cost scales with agent count (docs suggest starting at 2-3).
- Sources: https://github.com/devflowinc/uzi , https://www.vibesparking.com/en/blog/ai/claude-code/uzi/2025-08-23-uzi-parallel-ai-coders-git-worktrees-tmux/

---

## Sculptor (Imbue)

Desktop app (macOS Apple Silicon + Linux). Distinguishing bet: each agent runs in its own **Docker container** (not worktrees), so agents execute code safely in parallel without permission prompts and without polluting your machine.

- **List UI:** Spin up multiple agents to explore different approaches and jump between them; the container model means agents never collide and don't reinstall deps per worktree.
- **Attached terminal:** **Pairing Mode** — one click bidirectionally syncs an agent's containerized code into your local IDE / git state, so you can test and edit together in real time (or pull/push manually). This is the standout: bridges sandboxed agents to your real dev loop.
- **Needs-input handling:** **Instruction audits / Suggestions** — write rules in plain English ("never use eval", "always use NumPy") and Sculptor reviews each agent's work for violations, plus flags misleading behavior ("tests passed" with no real tests) and CLAUDE.md non-compliance. This is a *proactive* review layer rather than blocking approvals.
- **Notable UX:** Container isolation removes the tool-permission-prompt friction entirely (you don't have to approve because it's sandboxed). BYO Dockerfile or auto-generated from repo. Claude Code + Codex. Weakness: Docker overhead; Mac-Intel/Windows still pending.
- Sources: https://imbue.com/sculptor-announce/ , https://imbue.com/sculptor/ , https://github.com/imbue-ai/sculptor

---

## Terragon (Terragon Labs) — shut down Feb 2026, OSS snapshot

Cloud orchestrator: agents run in remote sandboxed containers; control from browser, terminal, GitHub comments, or phone.

- **List UI:** Real-time web dashboard — task status and agent progress stream live to the browser; **browser notifications** on completion. Multi-input UI (text, voice, images).
- **Attached terminal:** Sessions run remotely; the `terry` CLI clones a cloud session + its branch locally and `claude resume` continues a cloud session on your machine — a notable "cloud → local handoff."
- **Needs-input handling:** Async by design — agents create branches, run tests, and open PRs; you "view diffs" and review/merge via a triple-dot menu → "view pull request." @-mention Terragon in Slack/GitHub to kick off work where context lives.
- **Notable UX:** "Offload and come back to PRs" model; works across browser/terminal/mobile. Each agent in its own sandbox with its own repo copy. Weakness: service is dead (code remains as terragon-labs/terragon-oss).
- Sources: https://www.terragonlabs.com/ , https://docs.terragonlabs.com/docs , https://github.com/terragon-labs/terragon-oss

---

## Cursor Background Agents

Cloud agents managed from inside the Cursor IDE plus web/mobile companions.

- **List UI:** A dedicated background-agent **control panel** (⌘B / Ctrl+Shift+B) lists agents, spawns new ones, and shows status. Run multiple in parallel to compare models. API exposes a `status` field (e.g. RUNNING), target branch, PR URL, change summary.
- **Attached terminal:** Monitor an agent's progress, reasoning, and to-do list; send follow-up instructions or **"take over"** the agent's work mid-run; stop/correct a stray agent.
- **Needs-input handling:** Two layers. (1) **Action-level approval gating**: Settings → Agent → "Require approval for destructive commands" forces click-through on `rm -rf`, `DROP TABLE`, `git push --force`; tests/builds/read-only auto-approve; everything else goes to a *classifier subagent* that decides allow / try-different / ask-you. Configurable Run Mode. (2) **PR-level review**: Cursor 3's tabbed review (Reviews / Commits / Changes) with inline threads, reviewer-status indicators, pending-review banners, and **quick-action pills**.
- **Notable UX:** Cross-surface — iOS/Android + cursor.com/app let you monitor, chat, queue, and approve PR drafts from anywhere (no remote file editing). The classifier-based approval (vs binary allow-list) is sophisticated. Built-in diff viewer for every suggestion.
- Sources: https://docs.cursor.com/background-agent , https://cursor.com/docs/cloud-agent/automations , https://cursor.com/changelog

---

## Devin (Cognition)

Cloud AI software engineer; sessions list at app.devin.ai/sessions.

- **List UI:** Redesigned (Devin 2.2) sessions list with **inline PR previews, message snippets, and status indicators** in each row. Status enums via API (`status: running`, `status_enum: working`, etc.). Filters: a **Sub-Devin filter** for child sessions (parent+child combined views), filter by repo name and archive status.
- **Attached terminal:** New UI "connects every step of the dev lifecycle" — start sessions from anywhere, review output in Devin, jump back into a session from code review.
- **Needs-input handling:** PR review status surfaced directly in GitHub (Commit Statuses / Checks) linking to full Devin Review analysis. **Session Insights** (post-completion, on-demand) analyzes what happened and recommends improvements — a retrospective rather than live-blocking surface.
- **Notable UX:** Strong session-list ergonomics (snippets + inline PR preview let you triage without opening). Mobile: pull-to-refresh, share-session, "Ask Devin" opens chat on a comment. Parent/child (Sub-Devin) hierarchy is a useful org primitive for fan-out.
- Sources: https://docs.devin.ai/release-notes/overview , https://docs.devin.ai/product-guides/session-insights , https://app.devin.ai/sessions

---

## OpenCode (sst)

Open-source terminal agent (TUI + CLI + server). Thin-client TUI (SolidJS / @opentui) talks to a server over HTTP + SSE.

- **List UI:** TUI splits into four zones — **messages, input, status, sidebar**. Sidebar shows session metadata + navigation (including child sessions), and optionally a file explorer / tool list as a right panel. `opencode session list` (CLI) and `/new` start sessions; SQLite persistence.
- **Attached terminal:** It *is* the conversation surface; the sidebar header provides navigation between parent and **child (sub-agent) sessions** — `session_child_first` (Leader+Down) enters the first child created by the task tool. Nested-session navigation is the differentiator.
- **Needs-input handling:** Inline in the conversation; no separate approval dashboard.
- **Notable UX:** Fully keyboard-driven, keybinds categorized and customizable via `tui.json`; mouse supported via the rendering library. Server/client split means the same sessions can be driven from multiple surfaces (IDE, desktop). Third-party **Agent Deck** wraps OpenCode + Claude/Gemini/Codex into one session-manager TUI ("mission control").
- Sources: https://opencode.ai/docs/tui/ , https://deepwiki.com/sst/opencode/6.2-terminal-user-interface-(tui) , https://github.com/asheshgoplani/agent-deck

---

## Warp (Agent panes / Agent Management Panel)

Terminal that runs its own SOTA agent + Claude Code / Codex / Gemini CLI, with multi-agent management baked into the terminal UI.

- **List UI:** **Vertical tabs** for terminal sessions, each annotatable with metadata (git branch, worktree, PR). Vertical tabs give at-a-glance "what's each agent doing / is it blocked." The **Agent Management Panel** is a centralized dashboard of all active agents across tabs (running / waiting / finished); a separate Agent Management *view* lists cloud-agent runs with **filter-by-status** and click-a-row-to-open-conversation.
- **Attached terminal:** Conversations are tied to terminal sessions; run many simultaneously across windows/tabs/panes. A conversation-details side panel (info button in pane header) shows run details for both local and cloud agents.
- **Needs-input handling:** Agents **notify you when they need attention** — approve a command, review a plan, or confirm completion — surfaced via the vertical-tab status. A **Code Review panel** shows the combined diff across all files / "Changes vs. main" before committing.
- **Notable UX:** **Color-code tabs** to visually distinguish agents in the sidebar. Rich input editor (Ctrl+G) for click-to-edit prompt composition instead of raw-CLI arrow-key editing. One-click built-in worktree creation (random branch + dir). New-sessions-default-to-agent-view setting. Open gap: no true workspace tab grouping multiple sessions (Claude Code + dev server + shell) under one project tab yet.
- Sources: https://docs.warp.dev/agent-platform/local-agents/interacting-with-agents/terminal-and-agent-modes/ , https://docs.warp.dev/guides/agent-workflows/how-to-run-multiple-ai-coding-agents/ , https://docs.warp.dev/changelog/2026/ , https://www.warp.dev/agents

---

## Patterns Worth Adopting

Synthesized recommendations for the Agent View mock, strongest-signal first:

1. **Priority-sorted roster, not a flat list.** Auto-float "needs input" to the top, then working → completed → failed/stopped (Claude Code Agent View). This mirrors real triage order and means the most urgent row is always at the top without filtering.

2. **Rich status vocabulary with redundant encoding.** Use color *and* icon shape — color = state (working/needs-input/idle/done/failed/stopped), shape/fill = process liveness (alive vs terminated-but-responsive vs sleeping). Don't rely on color alone (accessibility + glanceability). (Claude Code; Crystal's explicit "waiting for input" status.)

3. **Two-tier inspection: peek before attach.** A lightweight peek/preview panel (Space) showing the blocking question, last output, and any PR — resolve most interactions there — with full attach (Enter) only when needed (Claude Code peek panel; claude-squad preview tab; Devin's inline PR-preview + snippets in rows). This is the single highest-leverage interaction pattern.

4. **Inline, structured approvals — including number-key multiple-choice and Tab-to-suggest.** For blocked sessions, render choices and let the user press a number; for free-form, prefill an editable suggested reply (Claude Code). For risky commands, gate by *type* (auto-approve safe ops, block destructive, classifier-decide the gray area) rather than a binary allow-list (Cursor).

5. **Diff-first review scoped to changes, with line-level comments routed back to the agent.** Review only what changed; let comments on specific lines become structured feedback the agent iterates on in-place (Conductor diff-first; Vibe Kanban inline line comments; Warp combined "Changes vs. main"). Avoid forcing copy-paste into chat.

6. **Keyboard-first with consistent verbs.** Single-key list nav + actions (n new, D kill, Enter attach, Space peek, s ship/push, r resume) and an always-visible bottom command menu / `?` help (claude-squad, Claude Code, OpenCode). Mouse should be additive, not required.

7. **Per-row context metadata.** Surface git branch, worktree, PR link, last-action summary, and time-since-status-change directly on the row so triage needs no drill-down (Warp vertical-tab metadata; Devin inline PR previews; Claude Code last-action + age).

8. **Notifications / attention pulls.** Agents should actively signal "I need you" (browser/OS notifications, tab badges, color-coded tabs) rather than requiring you to poll the dashboard (Terragon notifications; Warp attention signals + tab color-coding).

9. **Fan-out + "competing attempts" affordance.** One-click "spawn N sessions of this prompt" / numbered templates for running parallel approaches and picking a winner (Crystal templates; uzi `--agents claude:2,codex:1`; Vibe Kanban multiple workspaces per issue).

10. **Parent/child session hierarchy.** Represent sub-agent / child sessions as a navigable hierarchy with filtering (Devin Sub-Devin filter; OpenCode child-session nav) — important once sessions spawn their own sub-tasks.

11. **Surface the quota cost.** Every parallel-agent tool warns that N sessions burn quota N× — show a running cost/quota indicator so users self-regulate fan-out (Claude Code, Conductor, uzi all flag this).
