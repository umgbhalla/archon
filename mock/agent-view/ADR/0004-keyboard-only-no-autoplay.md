# ADR-0004: Keyboard-driven only; manual scenario step

- **Status:** accepted
- **Date:** 2026-06-05
- **Tier:** mock

## Context
Choice between an autoplay demo reel vs a hands-on state-machine study.

## Decision
**Keyboard-driven only.** The user drives every transition; the scripted timeline advances one event per `n` press. The only timer is the 2s delete-confirm arm window.

## Consequences
- Deterministic, scriptable, ideal for studying the FSM; demo built later via termctrl, not autoplay.

## References
`../SPEC/state-machine.md` (Part C), `../app/src/state/keymap.ts`
