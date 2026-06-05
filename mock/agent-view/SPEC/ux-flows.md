# Agent View — UX Flow Specs

Step-by-step interaction flows for a **non-functional mock** of Claude Code's Agent View. Each flow is an ordered sequence of (key pressed → UI shows → state transition). Every behavior is grounded in `SPEC/_raw-inventory.md` (cited as `inv §N`) and `RESEARCH/web-behavior.md` / `competitive-ux.md`. Line cites into the docs file are passed through from the inventory.

**Mock scope convention.** Because this is a non-functional mock, each flow ends with a **SCRIPT vs FAKE** note:
- **SCRIPT** = deterministic, pre-authored state the mock must move through on a fixed trigger (keypress or timer). Real-looking but hard-coded.
- **FAKE** = surface that only needs to *look* right; no real backend, no real model, no real process. Static or canned.

Global facts that hold across all flows:
- Agent view takes over the full terminal; `Esc` returns to shell; sessions "keep running" while away (inv §0, entry). In the mock, "keep running" is faked — nothing actually runs.
- Two orthogonal row signals: **color/animation = task state** (Working animated, Needs input yellow, Idle dimmed, Completed green, Failed red, Stopped grey) and **icon shape = process liveness** (`✻` alive / `✽` animated-alive / `∙` exited / `✢` `/loop` sleeping) (inv §1–2).
- Rows are grouped and priority-sorted: Pinned, Ready for review, Needs input above Working, Completed; `… N more` fold at the bottom (inv §3, §11).
- Bottom dispatch input + keyboard-hint footer; footer shows active defaults (permission mode, model, effort) (inv §4).

---

## Flow 1 — Open + onboarding-empty

| # | Key | UI shows | State transition |
|---|-----|----------|------------------|
| 1.1 | (shell) `claude agents` ↵ | Full-terminal takeover. Header line: `Claude Code v2.1.140` · model · cwd · summary count `0 sessions`. Bottom dispatch input (empty, focused). Footer of keyboard hints + active defaults. | shell → agent-view, empty roster |
| 1.2 | — | In place of a session list: a short **onboarding hint** with example prompts (e.g. "Try: fix the flaky test", "@docs update the README") (inv §5, §12; L505). Tab title reads `claude agents` (no awaiting count) (inv §4). | onboarding-empty state rendered |
| 1.3 | begins typing a prompt | Onboarding hint stays; characters appear in dispatch input. No row yet. | input-focused, pre-dispatch |
| 1.4 | `?` (from empty input) | Help overlay listing every shortcut in context (inv §7; L216). | overlay open |
| 1.5 | `Esc` | Help overlay closes; if input non-empty, `Esc` clears it; if empty, `Esc` exits to shell (inv §7). | overlay → onboarding-empty (or → shell) |

**Mock SCRIPT vs FAKE:**
- SCRIPT: the takeover transition (shell prompt → full-screen view) on the `claude agents` trigger; the `?` overlay open/close.
- FAKE: the onboarding hint text and example prompts (static copy); the header version/model/cwd/count (hard-coded strings, count starts at `0`); the footer defaults.

---

## Flow 2 — Dispatch a session

Covers plain dispatch plus `@agent`, `@repo`, `/command`, `! bash`, and `Shift+Enter` dispatch-and-attach (inv §6).

| # | Key | UI shows | State transition |
|---|-----|----------|------------------|
| 2.1 | type `fix the flaky test` | Text in dispatch input. (≥4 chars, so no rejection.) | composing |
| 2.2 | `Enter` | Onboarding hint disappears; a **new row** appears under **Working** named auto from the prompt (`flaky-test-fix`), icon `✽` animated, summary placeholder, time-ago `now`. Input clears. Header count → `1 session`. | dispatch → new background Working session; input cleared (inv: every prompt spawns a *new* session, never a follow-up) |
| 2.3 | type `@` | Suggestion popover lists custom subagents (and, when text follows, sibling repos). `Tab` on empty input browses all subagents; otherwise `Tab` applies the highlighted suggestion (inv §7). | input + suggestion mode |
| 2.4 | `@docs update the readme` ↵ | First-word/`@`-matched subagent (`docs`) runs as the session's **main agent**. Row appears named for the agent/prompt. (If `@name` matches both a subagent and a sibling repo, **subagent wins**; use `@` to be explicit) (inv §6; L263). | dispatch → session whose main agent = `docs` |
| 2.5 | `@my-app build the parser` ↵ | `@my-app` matched a **repo** under the opened directory → session runs *in that repo* (inv §6). | dispatch → session scoped to sibling repo |
| 2.6 | type `/` | Skill/command suggestions appear. `/exit`,`/quit` would close agent view, `/logout` signs out; **every other** command is sent as a new session's first prompt (inv §6; L259). | command-suggestion mode |
| 2.7 | `/review-pr` ↵ | New background session dispatched with `/review-pr` as its first prompt (not run in-view). | dispatch → session |
| 2.8 | type `! pytest -x` | `!` renders as a **prefix**; everything after is the command. No model is invoked (inv §6; L324–340). | bash-job compose mode |
| 2.9 | `Enter` | A **PTY-backed job row** appears (not a Claude session). Status = most recent line of output. Output kept in memory only; row + output **auto-clean ~5 min after exit** (inv §6; L338–340). | dispatch → background shell job row |
| 2.10 | type `improve error copy` then `Shift+Enter` | View is **replaced** by the full attached session immediately after dispatch (dispatch-and-attach) (inv §6–7). | dispatch → attach (see Flow 5) |
| 2.11 | (edge) type `fix` ↵ | Rejected with inline `Too short` hint (prompt < 4 chars) (inv §4; L513). | no dispatch; input retained |

**Mock SCRIPT vs FAKE:**
- SCRIPT: row creation + group placement on `Enter`; input-clear; header count increment; the `@`/`/`/`!` prefix-detection that switches the input into suggestion/command/bash mode; the `Shift+Enter` jump straight to the attached view; the `Too short` rejection on <4 chars.
- FAKE: the auto-generated session name; the suggestion lists (canned subagent names + sibling repo names, static); the bash job's "output" (a scripted fake line); the fact that nothing real is dispatched, scoped, or executed.

---

## Flow 3 — Watch a row update

How a Working row animates and refreshes (inv §1, §4; web-behavior timing).

| # | Trigger | UI shows | State transition |
|---|---------|----------|------------------|
| 3.1 | row enters Working | Icon `✽` animates (shimmer). Color/animation = state; shape = liveness. Animations honor "Reduce motion" (web-behavior). | Working |
| 3.2 | summary refresh tick | One-line summary (Haiku-class) **refreshes at most once / 15 s while working, plus once when each turn ends** (inv §4; L134–140). Text swaps e.g. `Edit src/physics/CollisionSystem.ts`. | summary updated in place |
| 3.3 | parallel work items ≥2 | A **`done/total` counter** (e.g. `2/5`) appears **before** the summary text (v2.1.161) (inv §4; L138). | fan-out counter shown |
| 3.4 | time passes | Right-edge **time-ago** updates (`now → 1m → 2m …`); `/loop` rows show a countdown (`in 4m`) and run count (`run 12 · …`) instead (inv §2, §4; L97). | time-ago / countdown advances |
| 3.5 | turn ends successfully | Icon turns **green** (Completed); animation stops; row re-sorts into the **Completed** group; summary becomes `result: …`. Older completed rows fold into `… N more` (failures + open-PR rows always stay visible) (inv §3). | Working → Completed; re-grouped |
| 3.6 | turn needs you | Icon turns **yellow** (Needs input); row floats to the **Needs input** group near top; summary `needs input: …?`. Tab title gains `N awaiting input ·` (inv §3–4). | Working → Needs input; re-sorted up |

**Mock SCRIPT vs FAKE:**
- SCRIPT: the timed state machine for one or two demo rows — a fixed timeline that flips `✽`→green at a scripted moment, swaps the summary string on a 15 s-ish interval, increments time-ago, advances a `/loop` countdown, and re-sorts the row into its new group; the tab-title awaiting-count update.
- FAKE: the summary text itself (pre-written strings, no Haiku call); the `done/total` numbers (canned); the shimmer animation (pure CSS/render, not tied to real work).

---

## Flow 4 — Peek + reply

Peek panel is the primary triage/approval surface (inv §8; competitive-ux pattern #3).

| # | Key | UI shows | State transition |
|---|-----|----------|------------------|
| 4.1 | `↑`/`↓` | Selection moves between rows. | row selection |
| 4.2 | `Space` (on selected row) | **Peek panel** opens: shows what the session needs, its **most recent output** (or the pending question), and any PRs it opened — **not** the full transcript (inv §8; L57,160). For parallel work, panel names the **longest-running** item + elapsed time (L163). | row → peek open |
| 4.3 | (multiple-choice question) press a **number key** `1`/`2`/… | Numbered options render; pressing the number **picks** that option and sends it to the session (inv §8; L165). | reply sent; session leaves Needs input → Working |
| 4.4 | `Tab` (other blocked session) | Input is **prefilled with a suggested reply** you can edit before sending (inv §8; L165). | suggested-reply drafted |
| 4.5 | type reply + `Enter` | Free-form reply sent to that session inline, without leaving the view (inv §8; L165). | reply sent → Working |
| 4.6 | `! <command>` in reply | Prefixing the reply with `!` sends a **Bash command** to that session instead of a chat message (inv §8; L165). | bash reply sent |
| 4.7 | `↑`/`↓` (panel open) | **Peek adjacent sessions** without closing the panel — the panel re-populates for the neighbor row (inv §8; L169). | peek target changes; panel stays open |
| 4.8 | `→` | **Attaches** to the peeked session (full transcript) (inv §8; L169). | peek → attached (Flow 5) |
| 4.9 | `Esc` or `Space` | Closes the peek panel (inv §5; L222,233). | peek → roster |

**Mock SCRIPT vs FAKE:**
- SCRIPT: open/close on `Space`/`Esc`; number-key option selection that visibly removes the row from Needs input and re-animates it as Working; `Tab` prefill; adjacent `↑`/`↓` re-populating the panel for the next row; `→` handoff to the attached view.
- FAKE: the "recent output" body and the multiple-choice option text (canned per demo row); the "longest-running item" label; reply text never reaches any real session — the post-reply Working state is scripted, not computed.

---

## Flow 5 — Attach + recap + detach

Attach is full-screen; detach never stops the session (inv §9).

| # | Key | UI shows | State transition |
|---|-----|----------|------------------|
| 5.1 | `Enter` or `→` (on a row) | Agent view is **replaced** by the full interactive session, **always fullscreen** regardless of `tui` setting (background session has no scrollback) (inv §9; L172–177). | roster → attached |
| 5.2 | (on attach) | Claude posts a short **recap** of what happened while you were away (inv §9; L173). | recap rendered at top of session |
| 5.3 | `PgUp`/`PgDn`/wheel | Scroll the attached session. `Ctrl+O` enters transcript mode (inv §9; L177). | scroll / transcript mode |
| 5.4 | `←` (on empty prompt) | **Detaches** and returns to agent view with that row selected. Session **keeps running** (inv §9; L62,179). Works from *any* session, even a fresh one with no history (L185). | attached → roster; session still alive |
| 5.5 | `Ctrl+Z` | Detach **immediately** when a dialog has focus and isn't responding to `←` (inv §9; L179,183). | attached → roster |
| 5.6 | `Ctrl+C` (running response or `!` shell cmd) | Standard interrupt: **cancels the running response / shell command**, does *not* detach (inv §9; L181). | response cancelled, still attached |
| 5.7 | `Ctrl+C` ×2 (empty prompt) | **Detaches** (same as any session). Detaching never stops the session — `←`, `Ctrl+Z`, `/exit`, double `Ctrl+C`/`Ctrl+D` all leave it running; only `/stop` ends it (inv §9; L181–183). | attached → roster; session still alive |

**Mock SCRIPT vs FAKE:**
- SCRIPT: the full-screen takeover on attach and the return-to-roster on `←`/`Ctrl+Z`/double-`Ctrl+C`; the `Ctrl+C` single-press "cancel not detach" vs double-press "detach" distinction.
- FAKE: the attached transcript content and the **recap** text (pre-written canned recap); there is no live session, so scroll/transcript-mode show static canned content; "keeps running" is purely conceptual.

---

## Flow 6 — Organize

Pin, reorder, rename, collapse group, group-by toggle (inv §3, §5, §7).

| # | Key | UI shows | State transition |
|---|-----|----------|------------------|
| 6.1 | `Ctrl+T` (on row) | **Pin / unpin**. Pinned rows move to the **Pinned** group at top; pinning keeps the process running while idle (exempt from idle GC) (inv §3,§7; L193). | row → Pinned (or unpinned back) |
| 6.2 | `Shift+↑` / `Shift+↓` | **Reorder** the selected session within its group (inv §7). | row position changes |
| 6.3 | `Ctrl+R` | **Rename** the selected session (inline edit field) (inv §5,§7; L195). | rename mode → new name committed on `Enter` |
| 6.4 | `Enter` (on a **group header**) | **Collapses** that group (rows hide; header shows collapsed indicator). `Enter` again expands (inv §3,§7; L196). | group collapsed / expanded |
| 6.5 | `Ctrl+S` | Toggles grouping **between state and directory**; choice **persists across runs**. When grouped by directory, the highlighted row's directory becomes the **dispatch target** (inv §3; L189,228,273). | grouping mode toggled; re-render |

**Mock SCRIPT vs FAKE:**
- SCRIPT: pin re-grouping on `Ctrl+T`; row reordering on `Shift+arrows`; inline rename field on `Ctrl+R` committing a new label; group collapse/expand on header `Enter`; the by-state ↔ by-directory re-layout on `Ctrl+S`.
- FAKE: persistence "across runs" (the mock resets); the directory grouping uses canned directory names; pinning's idle-GC exemption is conceptual only.

---

## Flow 7 — Filter

Typing in the dispatch input filters instead of dispatching when it starts with a filter token (inv §6).

| # | Key | UI shows | State transition |
|---|-----|----------|------------------|
| 7.1 | type `a:docs` | Roster filters to **sessions running the named agent** `docs` (inv §6; L208). | filtered view |
| 7.2 | type `s:working` | Filters to sessions in that **state**. Also accepts `s:blocked` for everything waiting on you (inv §6). | filtered view |
| 7.3 | type `#2048` (or a PR URL) | Selects the session **working on that pull request** (inv §6). | jumps to / selects matching session |
| 7.4 | `Esc` or clear input | Filter cleared; full roster restored (inv §7). | filtered → full roster |

Note: a leading `#<number>`/PR URL during dispatch *selects an existing PR session instead of dispatching* (inv §6) — same token, dispatch-vs-filter resolves by context.

**Mock SCRIPT vs FAKE:**
- SCRIPT: token detection (`a:`, `s:`, `#`) flipping the input into filter mode; the roster visibly narrowing to matching demo rows; restore on clear.
- FAKE: the matching is against canned row metadata (agent name, state label, PR number baked into each demo row), not a real query.

---

## Flow 8 — Delete (armed)

`Ctrl+X` is two-stage; deleting destroys the auto-created worktree (inv §5; web-behavior write-isolation).

| # | Key | UI shows | State transition |
|---|-----|----------|------------------|
| 8.1 | `Ctrl+X` (on row) | **First press stops** the session and **arms delete**: row shows a `Stopped` (grey) / "press again to delete" confirm state, with a **worktree warning** if the session has an auto-created worktree (deleting removes uncommitted changes) (inv §5; L198,231; web-behavior: `Ctrl+X` twice deletes the Claude-created worktree incl. uncommitted changes). | row → Stopped + armed |
| 8.2 | `Ctrl+X` again **within 2 s** | **Deletes** the session (and its `.claude/worktrees/` worktree, including uncommitted changes). Row removed. | armed → deleted |
| 8.3 | (no second press within 2 s) | Arming **expires**; row stays Stopped, not deleted. | armed → Stopped |
| 8.4 | `Ctrl+X` (on a **group header**) | Deletes **every session in that group after confirmation** (inv §3,§5; L198). | group delete confirm → all rows removed |

Contrast surfaced in the warning copy: `claude rm` from the shell *keeps* a dirty worktree and prints its path; deleting in agent view does not (web-behavior). The mock should show this caution in the confirm UI.

**Mock SCRIPT vs FAKE:**
- SCRIPT: the two-stage arm/confirm with a real ~2 s timeout that visibly disarms; the row→Stopped→removed transitions; group-header delete confirmation.
- FAKE: the worktree warning copy (static); no real worktree or uncommitted changes exist — the data-loss hazard is represented in text only.

---

## Flow 9 — Ready-for-review / PR status

PR label and the Ready-for-review group (inv §3, §4).

| # | Trigger | UI shows | State transition |
|---|---------|----------|------------------|
| 9.1 | session opens a PR | Row gains a **`PR #N`** label at the **right edge**, hyperlinked in capable terminals. Session **moves to the `Ready for review` group** (above Working/Completed) (inv §3,§4; L126,142,189). | session → Ready for review |
| 9.2 | check/review state changes | PR label **color-codes** status: **Yellow** = waiting on checks/review or checks failed; **Green** = checks passed, nothing blocking; **Purple** = merged; **Grey** = draft/closed (inv §4; L148–156). Guidance: "review and merge when its number turns green." | label color updates |
| 9.3 | session opens >1 PR | Label shows a **count** like `3 PRs`, colored by the **open PR that most needs attention**; open peek to see them all (inv §4; L142–147). | multi-PR label |
| 9.4 | follow-up sent to the row | **PR stays visible** while the row reverts to live progress (label persists through follow-ups) (inv §4). | Ready-for-review row shows progress + PR label |
| 9.5 | row in Completed group | Open-PR rows + failures **always stay visible** (never fold into `… N more`) (inv §3; L202). | exempt from fold |

**Mock SCRIPT vs FAKE:**
- SCRIPT: the row's move into `Ready for review` when a PR "opens"; the label color cycling through yellow→green→purple/grey on a scripted timeline; the multi-PR `3 PRs` count; the fold-exemption.
- FAKE: the PR number and hyperlink target (canned `#2048`, link is decorative or to a placeholder); check/review status is a scripted sequence, not polled from GitHub.

---

## Flow 10 — Turn off agent view

Disable / exit paths (inv §5, §10).

| # | Key / setting | UI shows | State transition |
|---|---------------|----------|------------------|
| 10.1 | `Esc` (empty input, no overlay) | Exits agent view, **returns to shell**; sessions keep running in the background (inv §0,§5). | agent-view → shell |
| 10.2 | `Ctrl+C` ×2 | Clears input on first press; **exits** on second (inv §7). | → shell |
| 10.3 | `/exit` or `/quit` (in dispatch input) | **Closes agent view** (these run in-view, unlike other commands) (inv §6; L259). | → shell |
| 10.4 | shell echo after exit | Backgrounded-session help block printed: `claude agents` (list), `claude attach <id>`, `claude logs <id>`, `claude stop <id>` (inv §12; L316–322). | shell with hint block |
| 10.5 | `disableAgentView: true` **or** `CLAUDE_CODE_DISABLE_AGENT_VIEW` env | Agent view (and background agents) **disabled**; enforceable via managed settings by admins (inv §10; L491–493). | feature off |
| 10.6 | (blocked exit) | If background tasks are running, opening/exit may show `Cannot open agents — N background task(s) running` (inv §12; L508). | error hint |

**Mock SCRIPT vs FAKE:**
- SCRIPT: the `Esc` / double-`Ctrl+C` / `/exit` transition back to a shell-like screen; the printed backgrounded-session hint block.
- FAKE: the settings/env kill-switch (represented as a static "disabled" screen or copy, not wired to real config); the `Cannot open agents` error (canned string); the shell itself is a mock surface, not a real terminal.

---

## Cross-flow mock-fidelity summary

- **Always real (SCRIPT):** keypress → state-transition wiring, group re-sorting, the two-stage `Ctrl+X` timeout, peek open/close, attach/detach takeover, filter token detection, the timed Working→Completed/Needs-input demo timeline.
- **Always faked:** all model output (summaries, recaps, replies, multiple-choice text) since no Haiku/main model runs; all process liveness, worktrees, PRs, GitHub status, daemon, and quota; cross-run persistence; hyperlinks. These are canned strings driven by a scripted timeline.
- **Accessibility:** redundant encoding (color **and** icon shape) is mandatory; honor Reduce-motion for the working shimmer (web-behavior; competitive-ux #2).
