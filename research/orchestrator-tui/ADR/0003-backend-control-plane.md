# ADR-0003: Agent-agnostic backend control plane

- **Status:** accepted
- **Date:** 2026-06-05
- **Deciders:** archon
- **Tier:** 0 foundational

## Context

The TUI must drive coding agents (Claude Code, Codex, Aider, Goose, Gemini, Amp…). If the
UI couples to one CLI's flags/output, every backend change breaks us and adding a backend
is a rewrite. The LANDSCAPE shows the winning move is a uniform control plane.

## Decision drivers

- CLI-agnostic from day one (the differentiator named in `../LANDSCAPE.md`).
- One uniform interface: send message · read status (busy/waiting/idle) · stream output · stop/restart.
- Reuse existing control planes rather than reinventing.

## Options considered

1. **Uniform control-plane adapter** behind one interface, fronting headless agent CLIs.
   Reference: `coder/agentapi` (HTTP over CC/Codex/Aider/Goose/Gemini/Amp), ACP (agent-of-empires,
   agent-kanban), `claude agents --json` for the first-party fleet. Pro: backends are plugins.
   Con: an abstraction layer to maintain; lowest-common-denominator features.
2. **Direct PTY drive per CLI** (ccmanager/claude-squad style). Pro: full fidelity, simple start.
   Con: bespoke parsing per agent; brittle; no clean multi-backend story.
3. **First-party only** (`claude agents --json`). Pro: richest data. Con: locks out Codex et al.

## Decision

**Define one internal `AgentBackend` interface** (`send`, `status`, `stream`, `stop`,
`restart`, `attach`) and implement it via adapters — `agentapi`/ACP where available,
`claude agents --json` for the Claude fleet, and a **direct-PTY adapter** as the universal
fallback. The UI talks only to the interface.

## Consequences

- New backend = new adapter, not a UI change.
- Status detection may need `recon`'s zero-instrumentation technique (read agent JSONL +
  PTY text) for CLIs without a JSON status stream.
- Feature surface is the interface's union; per-adapter capabilities flagged.

## References

- `context/agentapi`, `context/recon`, `context/agent-of-empires`, `context/agent-kanban`
- `../RESEARCH/01-claude-firstparty.md`, `../RESEARCH/03-thirdparty-orchestrators.md`
