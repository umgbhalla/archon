# ADR-0010: Workflow runtime → isolated script + journal resume

- **Status:** proposed
- **Date:** 2026-06-05
- **Deciders:** archon
- **Tier:** 2 execution

## Context
The run-inspector surface needs a workflow-as-code runtime: a script holds the plan;
a runtime executes it, spawns agents, tracks results, and resumes. codex-workflows is the
readable open reference (QuickJS-isolated, durable storage, dashboard).

## Options considered
1. **QuickJS-isolated script** — no ambient fs/shell/network from the script; only agents do I/O;
   pure + replayable; journal of completed agents → resume. (codex-workflows; matches Claude Code's
   model.) Con: QuickJS embedding + a small host API surface to maintain.
2. **Node `vm` / worker** — easier embedding, weaker isolation guarantees.
3. **No script runtime** (hardcoded orchestration) — loses the "save-as-command / read the plan" value.

## Decision (leaning)
**QuickJS-isolated workflow runtime with a journal for resume.** Host API mirrors the
`agent/parallel/pipeline/phase/budget` shape. Study `context/codex-workflows` (+ `quickjs-ng`/`boa`).

## References
`context/codex-workflows`, `context/quickjs-ng`, `context/quickjs-wasi`, `context/boa`, `../RESEARCH/06-dynamic-workflows.md`
