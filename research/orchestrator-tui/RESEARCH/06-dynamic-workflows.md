# 06 — Dynamic Workflows (workflow-as-code) + run-inspector TUIs

Snapshot 2026-06-05. A paradigm distinct from the session-list/kanban orchestrators
in 03: here **the plan lives in a script**, a runtime executes it in the background,
and the UI is a **run inspector** (phase → agent tree + metrics), not a session grid.
This is the first-party answer to the "terminal-native run inspection" gap in LANDSCAPE.

## Claude Code — Dynamic Workflows (first-party)
Docs: https://code.claude.com/docs/en/workflows · research preview, v2.1.154+, paid plans.

**What:** a JavaScript script orchestrates [subagents](/en/sub-agents) at scale. Claude
writes the script for the task; a runtime runs it in the background while the session
stays responsive. The plan/loop/branching + intermediate results live in **script
variables**, so Claude's context only holds the final answer.

**Why it differs (the orchestration-ownership table):**
- Subagents → Claude decides turn by turn, results in context.
- Skills → Claude follows instructions.
- Agent teams → a lead agent supervises peers via a shared task list.
- **Workflows → the *script* decides; dozens–hundreds of agents per run; resumable.**

**Authoring (script API):** `agent(prompt, {schema, label, phase, model, isolation, agentType})`,
`parallel(thunks)` (barrier), `pipeline(items, ...stages)` (no barrier, per-item flow),
`phase(title)`, `log(msg)`, plus globals `args`, `budget` ({total, spent(), remaining()}),
and `workflow(name|{scriptPath}, args)` for nested runs. `schema` forces structured
JSON output (validated, retried). Quality patterns: adversarial verify, judge panels,
loop-until-dry, multi-modal sweep, completeness critic.

**Run + monitor — the `/workflows` TUI (the key artifact for us):**
- `/workflows` lists running/completed runs; Enter opens the **progress view**.
- Progress view = **each phase with agent count, token total, elapsed time**; drill into
  a phase → its agents → an agent's **prompt, recent tool calls, and result**.
- Also a one-line summary in the task panel under the input (↓ to focus, Enter expand).
- **Keybindings (steal these for a run inspector):** `↑/↓` select phase/agent · `Enter`/`→`
  drill in · `Esc` back · `j/k` scroll agent detail · `p` pause/resume · `x` stop agent or
  whole run · `r` restart a running agent · `s` save the run's script as a `/command`.

**Runtime model:** script runs isolated (no direct fs/shell/network from the script —
agents do the I/O). Up to **16 concurrent agents**, **1000 total per run**. Each run's
script is written to `~/.claude/projects/<session>/…`; **resumable in-session** (completed
agents return cached results; journal-based). Bundled: `/deep-research`. Saved workflows
become `/<name>` commands (`.claude/workflows/` or `~/.claude/workflows/`); accept `args`.

**Launch/opt-in:** keyword `ultracode` in a prompt, "use a workflow" in natural language,
or `/effort ultracode` (xhigh + auto-orchestrate every task). Approval card shows planned
**phases** + token caution. Disable via `disableWorkflows` / `CLAUDE_CODE_DISABLE_WORKFLOWS`.

## Codex-Workflows (third-party port to OpenAI Codex)
Repo: https://github.com/robzilla1738/Codex-Workflows (context/codex-workflows) ·
~46★, small/new, TS+JS, pnpm monorepo. Brings Claude-Code-style dynamic workflows to
**Codex**, which lacks this natively.

**Architecture (local clone):** `packages/{runtime, mcp-server, cli, codex-adapter, schemas}`,
`workflows/*.workflow.js`, `plugins/codex-workflows` (committed for Marketplace),
`skills/`, `docs/`. Workflows run through an **MCP server** the Codex plugin invokes;
scripts load **isolated through QuickJS** (no fs/shell/network) — mirrors CC's constraint,
implemented explicitly (good to read: see [[pty-emulation]] / quickjs study repos already
in context/: quickjs-ng, quickjs-wasi, boa).

**Scale knobs:** "up to 64 concurrent workers and 2000 total agents"; per-phase/agent model
overrides (`modelMap {"find":"gpt-5.4-mini","synthesize":"gpt-5.5"}`, `reasoning xhigh`).
**Durable storage** under `${CODEX_HOME:-~/.codex}/codex-workflows/projects/` — survives the
TUI closing (the "thin observer over a persistent supervisor" pattern).

**Dashboard TUI:** "phases, agent rows, token/tool/time metrics, recent worker activity,
detail view, **pause/resume/stop/restart/save** controls, and final report path" — i.e. a
near-clone of CC's `/workflows` view, but for Codex. Commands:
`pnpm cwf run workflows/bug-sweep.workflow.js --watch --adapter auto --model gpt-5.4-mini`.
Bundled workflows: `bug-sweep`, `bug-sweep-deep`, `release-diff-review`, `security-auth-review`.

## Why this matters for an orchestrator TUI
The session-list tools (03) answer **"which of my agents needs me?"**. Dynamic-workflow run
inspectors answer **"what is this one big orchestrated job doing, phase by phase, agent by
agent, and what did each find?"** — the tree+metrics+drill-in view the LANDSCAPE gaps call
out. An orchestrator TUI should host **both**: a fleet/session grid AND a workflow
run-inspector (phase→agent tree, per-agent prompt/tool-calls/result, token/time, pause/
resume/restart, save-as-command). Codex-Workflows is the most readable open implementation
of the run-inspector + isolated-script-runtime to study; CC's `/workflows` is the UX spec.

## Patterns to steal (additions to LANDSCAPE)
1. **Phase → agent collapsible tree as the run view**, each node carrying live agent-count /
   token-total / elapsed-time; drill to an agent's prompt + recent tool calls + result.
2. **Per-agent live controls in the inspector:** pause/resume run, stop/restart a single
   agent, save the script as a reusable command (`s`).
3. **Workflow-as-code + journal resume:** completed agents return cached results; the TUI is
   a thin observer over a durable runtime that survives the UI closing.
4. **Isolated script runtime (QuickJS) with no ambient fs/shell/network** — only agents do
   I/O; the orchestration is pure + replayable. (Study quickjs-ng/boa already in context/.)
5. **Per-phase/per-agent model routing + a token budget** surfaced live (cost awareness =
   another LANDSCAPE gap).
