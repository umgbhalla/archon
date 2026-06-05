# ADR-0006: Single reducer + central keymap; pure components

- **Status:** accepted
- **Date:** 2026-06-05
- **Tier:** mock

## Context
Need predictable state and one place to reason about key handling.

## Decision
One `reducer(state, FsmAction)`; a central `keymap.ts` maps raw key events → `FsmAction`s; components are **pure render** (read snapshot, emit nothing). App owns the only timer.

## Consequences
- Easy to unit-test (15 `bun test` cases over the reducer).
- Learned: the key handler must resolve action-vs-current-state in the reducer, not in a stale closure — rapid chords (Ctrl+X×2) otherwise misread mode.

## References
`../app/src/state/`, `../TEST-REPORT.md`
