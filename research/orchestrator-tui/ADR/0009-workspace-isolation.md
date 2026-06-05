# ADR-0009: Workspace isolation → git-worktree default, pluggable

- **Status:** proposed
- **Date:** 2026-06-05
- **Deciders:** archon
- **Tier:** 2 execution

## Context
Parallel agents editing the same checkout collide. Isolation is table stakes; options trade
off speed vs safety (can the agent run tests / installs safely?).

## Options considered
1. **git worktree per task** — fast, shared `.git`, commits visible across worktrees (coder/mux);
   the default across the field. Con: shared deps/host; not a true sandbox.
2. **Container per agent** (sculptor) — true isolation, safe `run tests`, no dep reinstall; visual
   merge-conflict resolver. Con: heavier, Docker dep.
3. **MCP env-per-agent** (dagger/container-use) — replayable command logs + branch tracking. Con: MCP-bound.

## Decision (leaning)
**Worktree-per-task as default; isolation strategy is a pluggable interface** (worktree |
container | mcp-env) chosen per task/runtime. Mirrors ADR-0003's runtime-agnostic stance.

## References
`context/mux`, `context/sculptor`, `context/container-use`, `../RESEARCH/03-thirdparty-orchestrators.md`
