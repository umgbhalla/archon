# ADR-0004: Persistent supervisor daemon; the TUI is a thin observer

- **Status:** accepted (implemented)
- **Date:** 2026-06-05
- **Deciders:** archon
- **Tier:** 0 foundational
- **Implementation:** `orchestrator/src/daemon/` — per-user supervisor over a 0600 unix socket (`server.ts`, `protocol.ts`), start-on-demand + reconnect client (`client.ts`), JSON-file persistence + roster recovery on restart (`persistence.ts`, ADR-0011). CLI: `archon daemon [stop|status]`, `ls`, `attach`, `stop`, `logs`. Verified: a session survives a full daemon stop/start (roster + transcript recovered).

## Context

Agents and workflows are long-running; users open/close the TUI freely. State must survive
the UI closing, machine sleep, and reattachment. Both first parties and the best third
parties run a separate supervisor and make the UI a thin client.

## Decision drivers

- Sessions/runs keep going with no UI attached (Claude Code's supervisor; `claude agents --json`).
- Multiple/observer clients (TUI now, web/mobile companion later — agent-of-empires pattern).
- Crash isolation: a TUI crash must not kill running agents.

## Options considered

1. **Separate per-user daemon** that owns sessions/workflows + a persistent socket/IPC; the
   TUI attaches and streams live updates. References: Claude Code supervisor, Rivet remote
   live-debugger, codex-workflows durable storage under `$CODEX_HOME`. Con: lifecycle/IPC
   complexity (start-on-demand, reconnect, versioning).
2. **In-process** (everything dies with the TUI; ccmanager-ish). Pro: simplest. Con: closing
   the UI kills work; no companion clients; fails the core requirement.

## Decision

**Run a persistent supervisor daemon.** It owns agent sessions and workflow runs, persists
state to disk (ADR-0011), and exposes a stream the TUI (and future clients) attach to. The
TUI renders observed state and sends commands; it holds no authoritative state.

## Consequences

- Need start-on-demand, reconnect-after-restart, and protocol/version handshake (Agent View does this).
- Enables ADR-0010 journal resume and a future web/mobile companion.
- Clear client/server split in the codebase from day one.

## References

- `../RESEARCH/01-claude-firstparty.md` (supervisor), `context/rivet` (remote debugger),
  `context/codex-workflows` (durable storage), `context/agentapi`
