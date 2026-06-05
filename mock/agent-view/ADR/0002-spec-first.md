# ADR-0002: Spec-first — SPEC/ drives the build

- **Status:** accepted
- **Date:** 2026-06-05
- **Tier:** mock

## Context
Agent View is intricate (6 states, 4 process shapes, 5 groups, ~9 modes, 37 transitions). Building straight to code risks missing cases.

## Decision
Write `SPEC/` first (formal state-machine, ux-flows, visual-spec, mock-data) from the official docs + web research, then implement against it.

## Consequences
- The build matched the docs faithfully; the SPEC doubles as the orchestrator's design source.
- SPEC and code can drift — `TEST-REPORT.md` re-grounds against the SPEC.

## References
`../SPEC/`, `../RESEARCH/agent-view-docs.md`
