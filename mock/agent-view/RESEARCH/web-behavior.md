# Claude Code Agent View — Web Behavior Research

Scope: How Claude Code's "Agent View" (`claude agents`, research preview, shipped v2.1.139, May 11 2026) **behaves in practice** and what people say about it. Skeptical separation of documented facts vs. user anecdote. Versions noted where relevant. Every claim cites a source URL inline.

Research date: 2026-06-05. Feature is in active research preview, so UI and shortcuts are explicitly stated as subject to change.

---

## Documented behaviors (from official docs / blog / changelog)

These come from Anthropic's own docs ([code.claude.com/docs/en/agent-view](https://code.claude.com/docs/en/agent-view)), the launch blog ([claude.com/blog/agent-view-in-claude-code](https://claude.com/blog/agent-view-in-claude-code)), and the GitHub changelog/releases. Treat as authoritative.

**Entry / core loop.** `claude agents` opens a full-terminal, inbox-style table of every background session across all projects, with a dispatch input at the bottom and a keyboard-hint footer. The documented core loop is: dispatch a task → watch its row update → peek to check/reply → attach for the full conversation. `Esc` returns to the shell; sessions keep running while you're away. ([docs](https://code.claude.com/docs/en/agent-view), [blog](https://claude.com/blog/agent-view-in-claude-code))

**Dispatch.** Typing a prompt + `Enter` starts a *new* background session as a row — every prompt spawns its own session, never a follow-up to an existing one. Sessions are auto-named from the prompt. Prompts under 4 characters are rejected with a `Too short` hint to avoid stray-keystroke launches. Prefixes/mentions modify dispatch: `@<agent-name>` or first-word match runs a custom subagent as the main agent; `@<repo>` targets a sibling repo; `! <command>` runs a shell command as a PTY-backed background job (no model invoked, output kept in memory, row auto-cleaned ~5 min after exit); `#<number>`/PR URL selects an existing session on that PR. `/exit`, `/quit`, `/logout` run in agent view itself; every other slash command is dispatched as a session's first prompt. ([docs](https://code.claude.com/docs/en/agent-view))

**Peek.** `Space` on a selected row opens a peek panel showing the last output or the pending question (not the full transcript). You can reply inline with `Enter` without leaving the view; multiple-choice questions show numbered options (press a number to pick); `Tab` fills a suggested reply for blocked sessions; `!` prefix sends a Bash command. `↑`/`↓` peek adjacent sessions without closing the panel; `→` attaches. ([docs](https://code.claude.com/docs/en/agent-view))

**Attach / detach.** `Enter` or `→` attaches — agent view is *replaced* by the full interactive session, and **Claude posts a short recap of what happened while you were away.** Attached sessions **always render in fullscreen mode regardless of your `tui` setting**, because a background session has no terminal scrollback to append to (`Ctrl+O` for transcript mode, `PgUp`/`PgDn`/wheel to scroll). Detach with `←` on an empty prompt (or `Ctrl+Z` if a dialog has focus and ignores `←`). Detaching *never* stops a session — `←`, `Ctrl+Z`, `/exit`, double `Ctrl+C`/`Ctrl+D` all leave it running; only `/stop` (or `Ctrl+X`/`claude stop`) ends it. ([docs](https://code.claude.com/docs/en/agent-view))

**`←` as universal switcher.** Pressing `←` on an empty prompt in *any* Claude session backgrounds it and opens agent view with that row selected — works even from a fresh session with no history. Toggle via `leftArrowOpensAgents` in `/config`. ([docs](https://code.claude.com/docs/en/agent-view))

**Row state model — two orthogonal signals (documented).**
- *Color/animation = task state:* Working (animated), Needs input (yellow), Idle (dimmed), Completed (green), Failed (red), Stopped (grey).
- *Icon shape = process liveness:* `✻`/animated `✽` = process alive, replies immediately; `∙` = process exited but can still peek/reply/attach (restarts from where it left off); `✢` = a `/loop` session sleeping between iterations, showing run count + countdown.
Rows are grouped `Ready for review` / `Needs input` above `Working` / `Completed`; `Ctrl+S` toggles grouping by directory. A `PR #1234` label (or `3 PRs` count) appears at the right edge, color-coded by PR status (yellow=checks/review pending or failed, green=passed, purple=merged, grey=draft/closed). ([docs](https://code.claude.com/docs/en/agent-view))

**Hosting model (documented).** Background sessions are full Claude Code conversations run by a **per-user supervisor process** (the "daemon"), not tied to any terminal. It auto-starts on first background/`claude agents`. State persists on disk under `~/.claude/` (`daemon.log`, `daemon/roster.json`, `jobs/<id>/state.json`). Sessions survive sleep (supervisor reconnects on wake) but **shutdown stops them and they show as Failed** — recoverable by peek/reply/attach, which restarts from the last point. Shell management: `claude attach/logs/stop/respawn/rm`, `claude respawn --all` (move all onto an updated binary), `claude daemon status/stop`. The supervisor watches the binary on disk (local file watch, not network) and restarts into new versions automatically. ([docs](https://code.claude.com/docs/en/agent-view))

**Idle GC (documented timing).** A finished, unattached session has its **process stopped after ~1 hour** to free resources; transcript/state stay on disk and the next attach/peek/reply restarts a fresh process (causing a noticeable startup delay). Pin with `Ctrl+T` to exempt it. Empty rows from a stray `←` are removed after **~5 minutes**. Under memory pressure the supervisor stops idle non-pinned sessions first. ([docs](https://code.claude.com/docs/en/agent-view))

**Write isolation (documented).** Before its first file edit, a session auto-moves into a git worktree under `.claude/worktrees/` so parallel sessions read the same checkout but write separately. Skipped if already in a linked worktree, not a git repo (no `WorktreeCreate` hook), or writing outside cwd. Configurable via `worktree.bgIsolation: "none"` (v2.1.143+). **Deleting a session in agent view (`Ctrl+X` twice) deletes the Claude-created worktree including uncommitted changes** — `claude rm` from the shell instead *keeps* a dirty worktree and prints its path. ([docs](https://code.claude.com/docs/en/agent-view))

**Comparison framing (documented).** vs **subagents**: subagents run inside one session and report back; agent-view sessions are independent processes each with their own conversation and quota — subagents/teammates a session spawns are *not* listed as rows. vs **agent teams**: teams coordinate via shared mailbox/task list and message each other; agent-view sessions are siblings, not collaborators. vs **Claude Code on web**: web runs in Anthropic's cloud and survives sleep; agent view is local-only. ([docs](https://code.claude.com/docs/en/agent-view), [/en/agents](https://code.claude.com/docs/en/agents))

**Admin kill switch.** `disableAgentView: true` or `CLAUDE_CODE_DISABLE_AGENT_VIEW` env var disables both agent view and background agents; enforceable via managed settings. ([docs](https://code.claude.com/docs/en/agent-view))

---

## Timing & animation details

- **Row summaries are LLM-generated, refreshed at most once every 15 seconds while working, plus once at each turn end.** The one-line summary is produced by a **Haiku-class model** (one short request per refresh, billed under normal terms; falls back to the session's main model on Bedrock/Vertex/Foundry/gateways with no Haiku, or `ANTHROPIC_DEFAULT_HAIKU_MODEL`). This is the headline timing fact: every working row costs a Haiku call about every 15s. (documented: [docs §Row summaries](https://code.claude.com/docs/en/agent-view))
- **`done/total` fan-out counter** (e.g. `2/5`) appears before the summary when a session runs ≥2 parallel work items (subagents, background shells, monitors). Added **v2.1.161**; peek also names the longest-running item and its elapsed time. ([CHANGELOG / v2.1.161 release](https://github.com/anthropics/claude-code/releases/tag/v2.1.161))
- **Animations honor "Reduce motion."** v2.1.161 fixed the `/effort` dialog, workflow animations, and prompt keyword shimmer to respect the Reduce-motion setting — confirming agent view uses animated working icons and shimmer effects by default. ([v2.1.161 release](https://github.com/anthropics/claude-code/releases/tag/v2.1.161))
- **Terminal tab title updates live:** `2 awaiting input · claude agents` vs `claude agents`. ([docs](https://code.claude.com/docs/en/agent-view))
- Idle process GC ~1 hour; empty-row cleanup ~5 min; shell-job row cleanup ~5 min after exit (above).

---

## Real-world observations & quirks (anecdotal — treat with skepticism)

These come from third-party blogs and aggregated community reports, **not** Anthropic. Several "user reports" are relayed by analyst-style blog posts rather than primary first-person posts, so confidence is medium at best; I could not retrieve raw Reddit/HN threads directly (search returned no Reddit links; the Medium hands-on review was paywalled/truncated). Flagged accordingly.

- **"tmux for Claude Code" is the universal mental model.** An Anthropic Claude Code team member reportedly described it as "like tmux built for CC," and nearly every reviewer adopts that framing. ([pasqualepillitteri.it](https://pasqualepillitteri.it/en/news/2384/claude-code-agent-view-cli-dashboard-sessions-2026), [dsebastien.net](https://www.dsebastien.net/claude-code-agent-view/))
- **The genuine wins over a manual tmux grid** (analyst synthesis): semantic state awareness (rows know working vs. waiting; tmux panes are dumb shells), disk-backed persistence across reboot, and automatic write-isolation into worktrees. ([findskill.ai vs-tmux](https://findskill.ai/blog/claude-code-agent-view-vs-tmux/))
- **"It did not kill your tmux grid. It killed part of it."** A widely cited skeptical take pushing back on a YouTube title "Anthropic Just Killed Your tmux Grid": split-pane mode still needs tmux/iTerm2 and is **not supported in VS Code's integrated terminal, Windows Terminal, or Ghostty**; advice is local-only teams can standardize on agent view, remote-dev teams keep tmux as the base layer. ([findskill.ai vs-tmux](https://findskill.ai/blog/claude-code-agent-view-vs-tmux/))
- **Async-by-default psychological shift.** Reviewers' most-repeated qualitative insight: agent view flips Claude Code "from synchronous-by-default to async-by-default — you show up only when the agent needs you," and you "stop treating each session as a one-on-one conversation and start treating them as workers you supervise." Claimed (unquantified) "measurably more output per hour." ([timesofai.com](https://www.timesofai.com/industry-insights/agent-view-in-claude-code/))

### Reported failure modes (week-1, anecdotal — lower confidence)
Aggregated by findskill.ai's "10 parallel agents, week 1" post; these are relayed user reports, not reproduced by Anthropic docs:
- **Desktop + `/bg` crash:** `Claude Code process exited with code 1` when combining `/bg` backgrounding with the desktop app attached (supervisor handoff instability).
- **Switch deadlock:** 30–60s freezes switching between agents; one user: "switching between agents also hang for like a minute… seems like a deadlock." Attributed to supervisor bottlenecking.
- **Thread-limit wall ~5–7 sessions:** `did not spawn because the thread limit is reached` on consumer plans — a concurrency dispatch cap, distinct from quota exhaustion. One user reported a hard 2-agent ceiling tied to environment limits (`ulimit -n`, macOS `kern.maxproc`).
- **Silent token burn:** sessions entering long thinking loops that "fly away" consuming budget invisibly; one alarming claim of an `auto`-mode SQL `DELETE` agent wiping 24,000 production rows (supervisor can't gate destructive actions in auto mode). **Unverified, high-severity — treat as cautionary anecdote.**
- A single-session week-long run was claimed at **781,000 tokens**; suggested realistic ceilings: Pro 1–2 sessions, Max/small-team 3–5, Enterprise 5–10.
([findskill.ai 10-parallel](https://findskill.ai/blog/claude-code-10-parallel-agents-week-1/))

### Related-feature spillover (Agent Teams, not agent view itself)
A hands-on tester of the adjacent **Agent Teams** experimental feature reported teammates not receiving team-lead messages, sub-tasks getting stuck, and the team lead spawning extra teammates — "way more tmux panes than necessary… got cluttered real fast," plus unwieldy permission requests. Relevant because users conflate the two, but these are *Agent Teams* quirks, not agent view. ([claudefa.st teams best-practices](https://claudefa.st/blog/guide/agents/agent-teams-best-practices), [findskill.ai vs-tmux](https://findskill.ai/blog/claude-code-agent-view-vs-tmux/))

---

## Sentiment & critique

**Praise (consistent across sources):** removes the "workflow tax" of remembering which tmux pane runs what; the at-a-glance Needs-input/Working/Completed grouping is the most-praised affordance; peek-and-reply-without-attaching is called the feature that means "you never need to open the full transcript"; persistence-through-reboot and auto worktree isolation are seen as real engineering wins over DIY tmux. Described as "the easiest entry point" to parallelism among subagents/teams/web. ([dsebastien.net](https://www.dsebastien.net/claude-code-agent-view/), [timesofai.com](https://www.timesofai.com/industry-insights/agent-view-in-claude-code/), [pasqualepillitteri.it](https://pasqualepillitteri.it/en/news/2384/claude-code-agent-view-cli-dashboard-sessions-2026))

**Critique / cautions:**
1. **Quota multiplication is the #1 complaint** — documented (10 agents ≈ 10× burn) and amplified by reviewers who note the *ease* of dispatch makes it trivial to saturate a Pro/Max plan in hours. ([docs §Limitations](https://code.claude.com/docs/en/agent-view), [findskill.ai 10-parallel](https://findskill.ai/blog/claude-code-10-parallel-agents-week-1/))
2. **Local-only / dies on sleep-shutdown** — repeatedly flagged as making it unsuitable for overnight/always-on work; reviewers suggest a VPS for that. ([dsebastien.net](https://www.dsebastien.net/claude-code-agent-view/))
3. **Worktree-deletion data-loss footgun** — "push/merge first" warning treated as a real hazard. ([docs](https://code.claude.com/docs/en/agent-view), [dsebastien.net](https://www.dsebastien.net/claude-code-agent-view/))
4. **Research-preview roughness** — supervisor crashes, switch hangs, concurrency walls reported in week 1; consensus is "powerful tool with rough edges," polish expected. ([findskill.ai 10-parallel](https://findskill.ai/blog/claude-code-10-parallel-agents-week-1/))

**Skeptic's bottom line:** documented behaviors are detailed and internally consistent; the loudest *anecdotal* claims (deadlocks, prod-data wipe, hard 2-agent caps) come from relayed week-1 reports I could not trace to primary posts — directionally plausible for a preview but unverified.

---

## Sources

Official (authoritative):
- Agent view docs — https://code.claude.com/docs/en/agent-view
- Run agents in parallel (comparison) — https://code.claude.com/docs/en/agents
- Launch blog "Agent view in Claude Code" — https://claude.com/blog/agent-view-in-claude-code
- Official YouTube "Introducing agent view in Claude Code" — https://www.youtube.com/watch?v=-INveHwbRz4
- GitHub releases (v2.1.139 intro, v2.1.145 `--json`/agent_id, v2.1.161 done/total + reduce-motion) — https://github.com/anthropics/claude-code/releases ; https://github.com/anthropics/claude-code/releases/tag/v2.1.139 ; https://github.com/anthropics/claude-code/releases/tag/v2.1.145 ; https://github.com/anthropics/claude-code/releases/tag/v2.1.161
- CHANGELOG.md — https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md

Third-party / analyst / anecdotal (medium-low confidence):
- Sébastien Dubois, hands-on framing — https://www.dsebastien.net/claude-code-agent-view/ and https://www.dsebastien.net/claude-code-agent-view-one-screen-for-every-background-session/
- FindSkill "Agent View vs tmux" — https://findskill.ai/blog/claude-code-agent-view-vs-tmux/
- FindSkill "10 Parallel Agents: Week 1 Failure Modes" — https://findskill.ai/blog/claude-code-10-parallel-agents-week-1/
- Pasquale Pillitteri analysis — https://pasqualepillitteri.it/en/news/2384/claude-code-agent-view-cli-dashboard-sessions-2026
- TimesOfAI step-by-step + impressions — https://www.timesofai.com/industry-insights/agent-view-in-claude-code/
- ClaudeFast guide + Agent Teams best practices — https://claudefa.st/blog/guide/agents/agent-view ; https://claudefa.st/blog/guide/agents/agent-teams-best-practices
- CloudZero cost analysis — https://www.cloudzero.com/blog/claude-code-agents/
- Joe Njenga, Medium "I Tried Claude Code Agent View" (truncated/paywalled, not fully retrievable) — https://medium.com/@joe.njenga/i-tried-claude-code-agent-view-new-way-to-see-your-agents-working-e8c132aea112
- ClaudeWorld v2.1.139 release writeup — https://claude-world.com/articles/claude-code-21139-release/

Not retrievable: direct Reddit (r/ClaudeAI, r/ClaudeCode) and Hacker News threads did not surface in search; community failure-mode claims are sourced via the analyst posts above rather than primary threads.
