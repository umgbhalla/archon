# ADR-0007: Run-inspector → phase→agent tree + span timeline

- **Status:** proposed
- **Date:** 2026-06-05
- **Deciders:** archon
- **Tier:** 1 surfaces

## Context
Filling the "terminal-native run inspection" gap. The `/workflows` view is the UX spec:
phase → agent tree with token/time, drill into an agent's prompt + tool calls + result,
live pause/resume/stop/restart, save-as-command.

## Options considered
1. **Tree (causality) + span timeline (timing) duality** — collapsible phase→agent tree
   toggling to a horizontal span timeline (x-axis = elapsed). Spans not raw events; color=status.
   Render with OpenTUI tree + Braille/Canvas markers. (LangSmith/Temporal pattern.)
2. **Flat log stream** — easy, loses structure/causality.
3. **Full node-graph DAG first** — richest but hard in a terminal; deferred to ADR-0013.

## Decision (leaning)
**Tree + span timeline duality** as the v1 inspector; DAG view later (ADR-0013). Data model:
`Run → Phase[] → Agent[]` where each Agent carries {prompt, toolCalls[], result, tokens,
startedAt, endedAt, status}; spans derived from timestamps.

## References
`../RESEARCH/06-dynamic-workflows.md`, `../RESEARCH/04-dag-workflow-viz.md`, `context/rivet`, `context/langflow`
