# ADR-0008: Seed roster + scripted scenario as data

- **Status:** accepted
- **Date:** 2026-06-05
- **Tier:** mock

## Context
The mock needs to feel alive and cover every state/group/icon without a backend.

## Decision
Data-driven: a 13-session **seed roster** spanning all 6 states / 5 groups / 4 process shapes / every PR color, plus a **scenario timeline** of patch events replayed one-per-`n`.

## Consequences
- Full visual coverage on launch; the timeline exercises transitions on demand.
- The `ScenarioEvent` patch model previews the orchestrator's event-stream shape.

## References
`../SPEC/mock-data-and-scenario.md`, `../app/src/data/`
