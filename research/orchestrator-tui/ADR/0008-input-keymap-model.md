# ADR-0008: Keyboard-first input; selection-by-stable-key

- **Status:** proposed
- **Date:** 2026-06-05
- **Deciders:** archon
- **Tier:** 1 surfaces

## Context
Terminal orchestrators are keyboard-driven. The mock surfaced concrete pitfalls: selection
drifting after a list mutation, header-vs-row action ambiguity, Esc-exits-on-empty, 2-stroke chords.

## Options considered
1. **Central keymap → FSM actions; selection tracked by stable key** (not index), reducer-resolved.
   Layered Esc (innermost overlay first). One keymap module per the mock.
2. **Per-component key handlers** — scattered, hard to keep consistent / discoverable.

## Decision (leaning)
**Central keymap + reducer FSM + selection-by-key** (port `keepSelection`/`selectionKey`).
Surface a `?` help overlay generated from the keymap. Guard chord/mutation interactions
(send chord atoms in separate frames; resolve action vs current reducer state, not a stale closure).

## References
`mock/agent-view/app/src/state/keymap.ts`, `mock/agent-view/TEST-REPORT.md`
