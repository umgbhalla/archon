# ADR-0001: Rendering framework → OpenTUI + React binding

- **Status:** accepted
- **Date:** 2026-06-05
- **Deciders:** archon
- **Tier:** 0 foundational

## Context

The orchestrator TUI is a dense, overlay-heavy terminal app (grouped lists, panels,
trees, diffs, modals). We need a rendering layer with real layout, a component model,
and proven production use. archon's whole study corpus is built around picking this.

## Decision drivers

- Real flexbox layout + component composition (not manual cursor math).
- Production-proven at scale; native-core performance for frequent redraws.
- A reconciler/binding we already understand and have a worked example for.
- Keyboard + overlay ergonomics; framebuffer access for future DAG/Braille rendering.

## Options considered

1. **OpenTUI (`@opentui/react`)** — native Zig core + C-ABI + TS bindings; powers
   opencode + terminal.shop in production; Yoga flexbox; React reconciler. We have a
   full tested mock (`mock/agent-view`) and deep notes (`context/NOTES/opentui-deep.md`,
   `ghui` as a clean reference). Con: research-stage vertical-layout gotchas (height-1
   boxes), native-build dependency.
2. **Rezi** — TS framework, own engine, batteries (routing/forms/tests). Less proven; not the anchor.
3. **glyph** — from-scratch React→Yoga→framebuffer reconciler. Best for *learning* the pipeline, not for shipping.
4. **Effect-CLI / @effect/printer** — great for line-mode CLIs, not fullscreen overlay-heavy TUIs.

## Decision

**OpenTUI with the `@opentui/react` binding.** It is the project anchor, production-proven,
and we already have a tested reproduction of the exact surface we are building. Solid
binding stays a fallback if the React reconciler fights us on the run-inspector tree.

## Consequences

- Inherit OpenTUI's layout model: stack rows in explicit `height={1}` boxes; assume ≥30
  terminal rows; framebuffer half-block available for ADR-0013's DAG view.
- Native core must build/install in target environments (CI, users' machines).
- Reuse `mock/agent-view` component + theme patterns directly.

## References

- `context/opentui`, `context/ghui`, `context/opentui-ui`, `context/NOTES/opentui-deep.md`
- `mock/agent-view/SPEC/visual-spec.md`, `mock/agent-view/app`
