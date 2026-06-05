# ADR-0012: Review gate → inline diff-comments routed back to the agent

- **Status:** proposed
- **Date:** 2026-06-05
- **Deciders:** archon
- **Tier:** 2 execution

## Context
Never blind-merge autonomous agent output. The strongest pattern keeps the review loop
*inside* the tool: review the diff, comment inline, route comments back as agent feedback.

## Options considered
1. **In-TUI diff review + inline comments → agent feedback** (vibe-kanban, claude-squad diff-gate).
   Plus "Attempts": re-roll a task with a different agent/model. Keeps the loop in-tool.
2. **GitHub PR only** — offloads review but breaks flow with a side-trip; loses comment→agent routing.
3. **Auto-merge on green CI** — fast, unsafe as a default; offer as an opt-in per task.

## Decision (leaning)
**In-TUI review-before-merge with inline diff-comments fed back to the agent**, plus
re-roll/Attempts. Optional auto-merge-on-green as a per-task opt-in (agent-orchestrator pattern).

## References
`context/vibe-kanban`, `context/claude-squad`, `context/agent-orchestrator`, `context/critique`, `context/hunk`
