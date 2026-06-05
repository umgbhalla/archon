# ADR-0013: Terminal-native DAG view + deterministic scheduler

- **Status:** proposed
- **Date:** 2026-06-05
- **Deciders:** archon
- **Tier:** 3 differentiator

## Context
A named open gap: nobody renders a real hard-dependency DAG of an agent workflow *in the
terminal*, nor schedules on explicit deps. This is a differentiator, built after the tree+span
inspector (ADR-0007) works.

## Options considered
1. **Terminal node-graph (Braille/Canvas) + a deterministic DAG scheduler** with hard deps
   (topo order, parallel where independent). Renderer study: rivet (auto-layout), beautiful-mermaid,
   graphs-tui (Mermaid→ASCII). Scheduler beyond `parallel`/`pipeline` fan-out.
2. **Tree-only** (ADR-0007) — ships first; lacks cross-branch dependency edges.
3. **Web companion for the DAG** (agent-of-empires bridge) — punts the hard terminal-rendering problem.

## Decision (leaning)
**Design now, build after core.** Start with the tree+span inspector; add a Braille/Canvas DAG
overlay + dep-aware scheduler as the headline differentiator. Prototype the renderer against rivet/beautiful-mermaid.

## References
`context/rivet`, `context/beautiful-mermaid`, `context/langflow`, `../LANDSCAPE.md` (gaps)
