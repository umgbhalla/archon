# ADR-0015: Cross-repo / cross-runtime fleet scoping

- **Status:** proposed
- **Date:** 2026-06-05
- **Deciders:** archon
- **Tier:** 3 differentiator

## Context
Real fleets span many repos and runtimes (local worktree, SSH-remote, cloud, container).
Agent View scopes by `--cwd`; coder/mux abstracts local/worktree/SSH. A unified cross-repo,
cross-runtime view is largely missing.

## Options considered
1. **Scope model: repo/workspace + runtime as first-class filters** over one fleet; sessions
   tagged by repo + runtime; group-by either. Runtime abstraction from coder/mux.
2. **Single-repo, single-runtime** — simplest; fails the multi-project reality.

## Decision (leaning)
**First-class repo + runtime tags on every session, with group-by and filter** (extends the
`a:`/`s:`/`#` filter grammar to `repo:`/`runtime:`). Runtime selection per ADR-0003/0009.

## References
`context/mux`, `../RESEARCH/01-claude-firstparty.md` (`claude agents --cwd`), `../LANDSCAPE.md`
