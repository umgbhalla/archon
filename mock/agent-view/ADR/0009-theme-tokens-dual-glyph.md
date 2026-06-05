# ADR-0009: Theme tokens + dual-channel state glyph

- **Status:** accepted
- **Date:** 2026-06-05
- **Tier:** mock

## Context
State must be readable at a glance; Agent View encodes two axes in one icon.

## Decision
Central `theme.ts` with light/dark palettes; encode **color = logical state**, **shape = process liveness** (`✻ ✽ ∙ ✢`). `Ctrl+L` toggles theme.

## Consequences
- One glance answers "needs me?" + "running?"; the single highest-value primitive (→ orchestrator ADR-0006).

## References
`../SPEC/visual-spec.md`, `../app/src/theme/theme.ts`
