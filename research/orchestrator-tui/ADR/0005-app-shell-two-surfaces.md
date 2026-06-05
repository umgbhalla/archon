# ADR-0005: One app, two surfaces (fleet grid + workflow run-inspector)

- **Status:** proposed
- **Date:** 2026-06-05
- **Deciders:** archon
- **Tier:** 1 surfaces

## Context
The tool must answer both "which agent needs me?" (fleet/session grid) and "what is this
orchestrated job doing, phase by phase?" (workflow run-inspector). These are orthogonal
views over the same daemon (ADR-0004).

## Options considered
1. **One app, mode switch** — a shared shell (header/footer/keymap) hosting Grid and Inspector
   as switchable top-level modes (plus an Attached-session fullscreen, like the mock). Simplest mental model; one keymap.
2. **Split panes** — grid + inspector side by side. Richer but cramped in a terminal; harder layout.
3. **Two binaries** — clean but fragments UX and duplicates the shell.

## Decision (leaning)
**One app, mode switch** (Grid ⇄ Inspector ⇄ Attached), reusing the `mock/agent-view` shell.
A run-inspector opens when you drill into a workflow session from the grid. Revisit split-panes
once the single-mode UX is solid.

## References
`mock/agent-view/SPEC/state-machine.md`, `../RESEARCH/06-dynamic-workflows.md`
