# ADR-0014: Aggregate cost/quota across parallel agents

- **Status:** proposed
- **Date:** 2026-06-05
- **Deciders:** archon
- **Tier:** 3 differentiator

## Context
Running N agents burns quota ~N× as fast; no tool gives a unified live cost/quota view.
Another named gap and differentiator.

## Options considered
1. **Aggregate token/cost meter** across all sessions + workflow runs, live in the shell, with
   per-phase/per-agent breakdown and a budget ceiling (the `budget` global concept from Dynamic Workflows).
2. **Per-session only** — what most tools show; misses the fleet total.
3. **None** — accept the blind spot (rejected; it is a stated differentiator).

## Decision (leaning)
**Fleet-wide cost/quota aggregation** surfaced in the shell + inspector, fed by adapter token
counts (ADR-0003), with optional per-run budget caps that stop spawning when exceeded.

## References
`../RESEARCH/06-dynamic-workflows.md` (budget), `../LANDSCAPE.md` (gaps)
