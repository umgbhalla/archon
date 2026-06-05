// Theme tokens for the Agent View mock. Values transcribed from
// SPEC/visual-spec.md §2 (color tokens) and §3 (icons + spinner).
//
// Usage: `import { theme } from "../theme/theme"` then read `theme.colors.*`.
// Switch palette with `setThemeMode("light" | "dark")` (defaults to dark).

import type { PrStatus, SessionState } from "../data/types"

export interface ThemeColors {
  // surface / text (visual-spec §2a)
  bg: string
  fg: string
  fgDim: string
  // primary accent (visual-spec §2a)
  claude: string
  claudeShimmer: string // lighter gradient step for the working shimmer
  selectionBg: string
  diffAdded: string
  // semantic (visual-spec §2b / §2c) — same hues in both themes
  warning: string // needsInput + PR yellow
  success: string // completed + PR green
  error: string // failed
  autoAccept: string // PR purple (merged)
  // separators / rules
  separator: string
}

export const darkColors: ThemeColors = {
  bg: "#161616",
  fg: "#e6e6e6",
  fgDim: "#8a8a8a",
  claude: "#d77757",
  claudeShimmer: "#ffaf87",
  selectionBg: "#264f78",
  diffAdded: "#225c2b",
  warning: "#e5c07b",
  success: "#4eba65",
  error: "#ff6b80",
  autoAccept: "#af87ff",
  separator: "#3a3a3a",
}

export const lightColors: ThemeColors = {
  bg: "#fafafa",
  fg: "#1a1a1a",
  fgDim: "#6b6b6b",
  claude: "#d77757",
  claudeShimmer: "#ffaf87",
  selectionBg: "#dcdcdc",
  diffAdded: "#a6e3b0",
  warning: "#e5c07b",
  success: "#4eba65",
  error: "#ff6b80",
  autoAccept: "#af87ff",
  separator: "#cfcfcf",
}

export type ThemeMode = "light" | "dark"

export const theme: { mode: ThemeMode; colors: ThemeColors } = {
  mode: "dark",
  colors: darkColors,
}

export const setThemeMode = (mode: ThemeMode): void => {
  theme.mode = mode
  theme.colors = mode === "dark" ? darkColors : lightColors
}

// ───────────── Row leading icons (shape = process liveness) — §3a ─────────────
export const icons = {
  aliveStatic: "✻", // U+273B  process alive, replies immediately
  aliveWorking: "✽", // U+273D  alive AND working (animates)
  exited: "∙", // U+2219  process exited; still peek/reply/attach
  loopSleeping: "✢", // U+2722  /loop session sleeping
} as const

// "Working" spinner frames (visual-spec §3b). Frame 0 and 5 hold slightly longer.
export const spinnerFrames = ["·", "✻", "✽", "✶", "✳", "✢"] as const
// Eased timing (ms): first/last hold ~140ms, middle ~80ms.
export const spinnerFrameDurations = [140, 80, 80, 80, 80, 140] as const
// ANSI-256 orange shimmer gradient stepped per frame.
export const spinnerShimmer = ["#d75f5f", "#e07a4e", "#d77757", "#f0935f", "#ffaf87", "#ffc9a3"] as const

/** Pick the leading-icon glyph for a session's liveness/loop shape. */
export function iconForShape(opts: {
  processAlive: boolean
  isLoop: boolean
  state: SessionState
}): string {
  if (opts.isLoop) return icons.loopSleeping
  if (!opts.processAlive) return icons.exited
  if (opts.state === "working") return icons.aliveWorking
  return icons.aliveStatic
}

/** Foreground color for a session's leading icon, by state (§2b). */
export function colorForState(state: SessionState, c: ThemeColors = theme.colors): string {
  switch (state) {
    case "working":
      return c.claude
    case "needsInput":
      return c.warning
    case "idle":
      return c.fgDim
    case "completed":
      return c.success
    case "failed":
      return c.error
    case "stopped":
      return c.fgDim
  }
}

/** Foreground color for a PR label, by PR status (§2c). */
export function colorForPr(status: PrStatus, c: ThemeColors = theme.colors): string {
  switch (status) {
    case "yellow":
      return c.warning
    case "green":
      return c.success
    case "purple":
      return c.autoAccept
    case "grey":
      return c.fgDim
  }
}

// Human-readable group titles, in top→bottom priority order (visual-spec §1).
export const GROUP_ORDER = ["pinned", "readyForReview", "needsInput", "working", "completed"] as const
export const GROUP_TITLES: Record<(typeof GROUP_ORDER)[number], string> = {
  pinned: "Pinned",
  readyForReview: "Ready for review",
  needsInput: "Needs input",
  working: "Working",
  completed: "Completed",
}
