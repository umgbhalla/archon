# ADR-0001: Scope — a non-functional, scripted mock

- **Status:** accepted
- **Date:** 2026-06-05
- **Tier:** mock

## Context
Goal was to learn Claude Code's Agent View *state machine + UX*, not to ship a working agent manager. A real model/PTY/network backend would dominate effort and obscure the UI study.

## Decision
Build a **scripted, non-functional** mock: seeded roster + a manual scenario timeline; no model, PTY, or network. Every transition is either user-driven (keys) or scripted (the `n` step).

## Consequences
- Fast to build and fully deterministic → testable + termctrl-drivable.
- The state machine, visuals, and keymap are reusable for the real orchestrator (→ `research/orchestrator-tui/ADR/0006`).
- Does not prove backend integration (that is ACP, a separate build).

## References
`../SPEC/state-machine.md`, `../SPEC/mock-data-and-scenario.md`
