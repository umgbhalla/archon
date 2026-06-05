# Architecture Decision Records — orchestrator TUI

MADR-style decision log for building the orchestrator TUI (the north star in
[`../LANDSCAPE.md`](../LANDSCAPE.md)). One file per decision, append-only;
supersede rather than rewrite. Template: [`_TEMPLATE.md`](./_TEMPLATE.md).

The orchestrator TUI hosts **two surfaces** (see `../RESEARCH/06-dynamic-workflows.md`):
a **fleet/session grid** ("which agent needs me?") and a **workflow run-inspector**
("what is this orchestrated job doing, phase by phase?").

## Status board

| ADR | Title | Tier | Status |
|----:|-------|:----:|--------|
| [0001](./0001-rendering-framework.md) | Rendering framework → OpenTUI + React | 0 | accepted |
| [0002](./0002-runtime-language.md) | Runtime & language → Bun + TypeScript | 0 | accepted |
| [0003](./0003-backend-control-plane.md) | Agent-agnostic control plane | 0 | accepted (implemented) |
| [0004](./0004-supervisor-daemon.md) | Persistent supervisor daemon; thin TUI observer | 0 | accepted (implemented) |
| [0005](./0005-app-shell-two-surfaces.md) | One app, two surfaces (grid + run-inspector) | 1 | proposed |
| [0006](./0006-session-state-model.md) | Session state model → dual-channel glyph | 1 | accepted (implemented) |
| [0007](./0007-run-inspector-data-model.md) | Run-inspector → phase→agent tree + span timeline | 1 | proposed |
| [0008](./0008-input-keymap-model.md) | Keyboard-first input; selection-by-stable-key | 1 | accepted (implemented) |
| [0009](./0009-workspace-isolation.md) | Workspace isolation → worktree default, pluggable | 2 | accepted (implemented) |
| [0010](./0010-workflow-runtime.md) | Workflow runtime → QuickJS-isolated + journal resume | 2 | proposed |
| [0011](./0011-state-persistence.md) | Persistence → Git for code, SQLite for metadata | 2 | accepted (JSON variant impl.) |
| [0012](./0012-review-merge-gate.md) | Review gate → inline diff-comments back to agent | 2 | proposed |
| [0013](./0013-terminal-dag-scheduler.md) | Terminal-native DAG view + deterministic scheduler | 3 | proposed |
| [0014](./0014-cost-quota-aggregation.md) | Aggregate cost/quota across agents | 3 | proposed |
| [0015](./0015-cross-repo-runtime-fleet.md) | Cross-repo / cross-runtime fleet scoping | 3 | proposed |

## How to use

- New decision → copy `_TEMPLATE.md` to `NNNN-kebab-title.md`, add a row above.
- Changed mind → new ADR that supersedes the old (set old to `superseded by ADR-XXXX`).
- Tier 0 must be settled before building; Tier 3 are the differentiators (the open
  gaps in `../LANDSCAPE.md`) — design now, build after the core works.
