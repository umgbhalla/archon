# ADRs — agent-view mock

Retroactive MADR-style decision log for the scripted OpenTUI mock in `../app`
(see `../SPEC/` and `../TEST-REPORT.md`). These record decisions **already made and
implemented** while building the mock — they are `accepted`, with real consequences and
bugs-found noted. Format follows `../../../research/orchestrator-tui/ADR/_TEMPLATE.md`.

Where these inform the real orchestrator TUI, they map to the forward-looking ADRs in
`research/orchestrator-tui/ADR/` (cross-referenced inline).

## Status board

| ADR | Title | Status |
|----:|-------|--------|
| [0001](./0001-scope-non-functional-mock.md) | Scope: non-functional scripted mock | accepted |
| [0002](./0002-spec-first.md) | Spec-first (SPEC/ drives the build) | accepted |
| [0003](./0003-opentui-react.md) | OpenTUI + @opentui/react binding | accepted |
| [0004](./0004-keyboard-only-no-autoplay.md) | Keyboard-driven only; manual scenario step | accepted |
| [0005](./0005-two-layer-state-machine.md) | Two-layer state machine | accepted |
| [0006](./0006-reducer-keymap-pure-components.md) | Single reducer + central keymap; pure components | accepted |
| [0007](./0007-selection-by-stable-key.md) | Selection tracked by stable key, not index | accepted |
| [0008](./0008-seed-roster-scripted-scenario.md) | Seed roster + scripted scenario as data | accepted |
| [0009](./0009-theme-tokens-dual-glyph.md) | Theme tokens + dual-channel state glyph | accepted |
| [0010](./0010-verification-termctrl-bun-test.md) | Verify via termctrl recording + bun test | accepted |
