# ADR-0010: Verify via termctrl recording + bun test

- **Status:** accepted
- **Date:** 2026-06-05
- **Tier:** mock

## Context
A TUI needs both logic tests and real-render verification.

## Decision
**`bun test`** for the reducer/FSM (15 tests); **terminal-control (`termctrl --host opentui`)** to drive the real app in a PTY, recording a timeline and reading frames at markers.

## Consequences
- Found the filter-not-applied bug + confirmed every mode renders.
- **Key lesson:** read recording `--at-marker` frames, NOT live `show` — live reads race sub-2s states (the 2s delete arm window). Carried into the repo guide (→ `CLAUDE.md` §6/§7).

## References
`../TEST-REPORT.md`, `../captures/`, `context/terminal-control`
