# ADR-0006: Session state model → dual-channel glyph

- **Status:** accepted (implemented)
- **Date:** 2026-06-05
- **Deciders:** archon
- **Tier:** 1 surfaces
- **Implementation:** `orchestrator/src/core/session-manager.ts` (logical states busy|waiting|idle|completed|failed|stopped) + `orchestrator/src/tui/theme.ts` (dual-channel glyph: color=state, shape=liveness).

## Context
The single highest-value glance primitive is "does it need me? is it even running?".
The mock already implements a worked two-layer model.

## Options considered
1. **Dual-channel glyph** — color = logical state (working/needsInput/idle/completed/failed/stopped),
   shape = process liveness (alive/exited/loop-sleeping). Grouped Pinned/Ready/NeedsInput/Working/Completed.
   Proven in Agent View + our mock.
2. **Single status label/color** — simpler, loses the liveness axis (can't tell "exited but resumable").
3. **Affect/Tamagotchi layer** (recon) — fun, low information density; optional cosmetic add-on.

## Decision (leaning)
**Dual-channel glyph + state groups, reusing the mock's FSM** (`keepSelection`/`selectionKey`,
the 6-state lifecycle, group resolution). Backends map their raw status into this model via
ADR-0003; `recon`'s detection fills gaps for CLIs without a status stream.

## References
`mock/agent-view/SPEC/state-machine.md`, `context/ccmanager`, `context/recon`
