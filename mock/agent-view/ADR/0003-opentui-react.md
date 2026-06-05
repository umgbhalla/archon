# ADR-0003: OpenTUI + @opentui/react binding

- **Status:** accepted
- **Date:** 2026-06-05
- **Tier:** mock

## Context
Need a real layout + component model for an overlay-heavy TUI; OpenTUI is the repo anchor.

## Decision
**OpenTUI with `@opentui/react`** (over solid/core), referencing `context/ghui`.

## Consequences
- Clean component/overlay model; matches the orchestrator's chosen stack (→ orchestrator ADR-0001).
- Hit OpenTUI vertical-layout gotcha: consecutive `<text>` collapse — wrap rows in explicit `height={1}` boxes; assume ≥30 rows.

## References
`../app`, `context/opentui`, `context/ghui`, `context/NOTES/opentui-deep.md`
