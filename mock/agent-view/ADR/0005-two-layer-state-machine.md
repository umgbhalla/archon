# ADR-0005: Two-layer state machine

- **Status:** accepted
- **Date:** 2026-06-05
- **Tier:** mock

## Context
Session lifecycle (per row) and screen mode (whole UI) are independent concerns; conflating them tangles logic.

## Decision
Two cooperating machines: **per-session lifecycle FSM** (`applySessionEvent`: working/needsInput/idle/completed/failed/stopped + process-alive/loop sub-flags) and an **app/UI-mode statechart** (tableView/peek/attached/help/rename/deleteConfirm/dispatch/filter/onboarding).

## Consequences
- Clean separation; directly portable to the orchestrator (→ orchestrator ADR-0006/0007).

## References
`../SPEC/state-machine.md`, `../app/src/state/store.ts`
