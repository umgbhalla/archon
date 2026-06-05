# ADR-0002: Runtime & language → Bun + TypeScript

- **Status:** accepted
- **Date:** 2026-06-05
- **Deciders:** archon
- **Tier:** 0 foundational

## Context

OpenTUI (ADR-0001) targets Bun/Node; the mock already runs on Bun. We need fast startup,
a test runner, PTY access, and a workflow runtime (ADR-0010).

## Decision drivers

- OpenTUI + ecosystem are Bun-first (`bun create tui`, opencode).
- Fast startup/HMR for a TUI; built-in test runner (`bun test`) — already used by the mock.
- Single toolchain (bundler + runner + package manager) reduces moving parts.

## Options considered

1. **Bun + TypeScript** — fastest path with OpenTUI; mock proves it; `bun test` in place. Con: younger ecosystem, some Node-API edge gaps.
2. **Node + TypeScript** — broadest compatibility (node-pty, etc). Con: slower iteration; extra bundler/test wiring; not the OpenTUI default.

## Decision

**Bun + TypeScript.** Matches the anchor framework and the existing mock; keep Node-API
usage portable so a Node fallback stays possible if a dependency (e.g. native PTY) demands it.

## Consequences

- `bun install` / `bun run` / `bun test` as the standard loop (mirrors `mock/agent-view/app`).
- Verify each native dep (node-pty, OpenTUI core) installs under Bun in CI.

## References

- `context/create-tui`, `context/opencode`, `mock/agent-view/app/package.json`
