# ADR-0007: Selection tracked by stable key, not index

- **Status:** accepted (superseded the original index approach)
- **Date:** 2026-06-05
- **Tier:** mock

## Context
**Bug found:** selection was a flat index into headers+rows. After a mutation that regroups (pin moves a row to Pinned), the index pointed at a *different* row, so rename/delete hit the wrong target — a real footgun.

## Decision
Track selection by **stable key** (`row:<sessionId>` / `header:<group>`). `keepSelection(prev,next)` re-points the index to the same selectable after any mutation; falls back to nearest.

## Consequences
- Pin/regroup/delete/scenario keep the same row selected; regression-tested.
- Carry this into the orchestrator from day one (→ orchestrator ADR-0008).

## References
`../app/src/state/store.ts` (`keepSelection`/`selectionKey`), `../TEST-REPORT.md`
