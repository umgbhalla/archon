# ADR-0011: Persistence → Git for code state, SQLite for metadata

- **Status:** accepted (JSON-files variant implemented; SQLite deferred)
- **Date:** 2026-06-05
- **Deciders:** archon
- **Tier:** 2 execution
- **Implementation:** `orchestrator/src/daemon/persistence.ts` — `FilePersistence` (roster.json index + per-session meta.json + append-only transcript.log, atomic tmp+rename). SQLite/relational store remains the eventual target behind the same `Persistence` interface.

## Context
The daemon (ADR-0004) must persist sessions, runs, and journals across restarts/sleep.
vibe-kanban's clean split — code state = Git, workflow state = SQLite — is the reference.

## Options considered
1. **SQLite for session/run/journal metadata + Git for code state** — queryable, transactional,
   single file; code stays in worktrees/branches. (vibe-kanban.)
2. **JSON files per run** (codex-workflows under `$CODEX_HOME`) — dead simple, weak querying/concurrency.
3. **Embedded KV** — middle ground; less ergonomic for the relational queries the grid/inspector need.

## Decision (leaning)
**SQLite for metadata, Git for code.** Store roster, session state, run journals, PR/diff
pointers in SQLite; never duplicate code state outside Git.

## References
`context/vibe-kanban`, `context/codex-workflows`
