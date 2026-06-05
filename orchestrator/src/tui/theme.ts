/**
 * Theme tokens for the archon session-grid TUI.
 *
 * Ported from mock/agent-view/app/src/theme/theme.ts but remapped onto the REAL
 * SessionState enum from the session manager (busy|waiting|idle|completed|
 * failed|stopped, ADR-0006) instead of the mock's vocabulary.
 *
 * Dual-channel glyph (north star, LANDSCAPE.md):
 *   - color  = logical state  (colorForState)
 *   - shape  = process liveness (iconForLiveness)
 */
import type { SessionState } from "../core/session-manager.ts";

export interface ThemeColors {
  bg: string;
  fg: string;
  fgDim: string;
  accent: string;
  selectionBg: string;
  busy: string;
  waiting: string;
  success: string;
  error: string;
  stopped: string;
  separator: string;
}

export const colors: ThemeColors = {
  bg: "#161616",
  fg: "#e6e6e6",
  fgDim: "#8a8a8a",
  accent: "#d77757",
  selectionBg: "#264f78",
  busy: "#d77757", // working / in-flight turn
  waiting: "#e5c07b", // awaiting input (warning)
  success: "#4eba65", // completed
  error: "#ff6b80", // failed
  stopped: "#8a8a8a", // stopped / idle (dim)
  separator: "#3a3a3a",
};

// Liveness shapes (process channel): alive+working / alive+static / exited.
export const icons = {
  aliveWorking: "✽", // ✽
  aliveStatic: "✻", // ✻
  exited: "∙", // ∙
} as const;

/** Liveness glyph: working sessions show ✽, live idle ✻, gone ∙. */
export function iconForLiveness(opts: { alive: boolean; state: SessionState }): string {
  if (!opts.alive) return icons.exited;
  if (opts.state === "busy") return icons.aliveWorking;
  return icons.aliveStatic;
}

/** Logical-state color (the color channel of the dual glyph). */
export function colorForState(state: SessionState, c: ThemeColors = colors): string {
  switch (state) {
    case "busy":
      return c.busy;
    case "waiting":
      return c.waiting;
    case "completed":
      return c.success;
    case "failed":
      return c.error;
    case "idle":
      return c.fgDim;
    case "stopped":
      return c.stopped;
  }
}

// Group ordering (top->bottom priority). "which agent needs me?" first.
export const GROUP_ORDER = [
  "waiting",
  "busy",
  "completed",
  "failed",
  "idle",
  "stopped",
] as const;
export type SessionGroup = (typeof GROUP_ORDER)[number];

export const GROUP_TITLES: Record<SessionGroup, string> = {
  waiting: "Needs input",
  busy: "Working",
  completed: "Completed",
  failed: "Failed",
  idle: "Idle",
  stopped: "Stopped",
};

/** A session's group is its logical state (1:1 here). */
export function groupForState(state: SessionState): SessionGroup {
  return state;
}
