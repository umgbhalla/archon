// AttachedSession — fullscreen interactive session that REPLACES the agent view
// when you Enter/→ attach (visual-spec §6). This is the "inbuilt terminal":
// a full-fidelity, terminal-style Claude Code session log rendered fullscreen.
//
// Layout (visual-spec §6):
//   ▟▙  <name> · <cwd dim>                              attached <state-icon>
//   ──────────────────────────────────────────────────────────────────────────
//   Recap — while you were away
//     · <recap line>            (derived from peekOutput / closing question)
//   <transcript replay, role-colored, monospace, scrolled to the tail>
//   > █                         (standard session prompt, not the ❯ dispatch)
//   ──────────────────────────────────────────────────────────────────────────
//   ← detach · ctrl+o transcript · ctrl+c×2 detach · /stop end session
//
// Detach (← / Ctrl+Z / Ctrl+C) and exit (Esc) are wired in the keymap — this
// component only RENDERS. Stays pure: no store access, no key handling.

import { TextAttributes } from "@opentui/core"
import type { Session, TranscriptEntry } from "../data/types"
import { colorForState, iconForShape, theme } from "../theme/theme"

export interface AttachedSessionProps {
  /** The session we are attached to. */
  session: Session
  width: number
  height: number
}

type Role = TranscriptEntry["role"]

/** Foreground color per transcript role (terminal-log styling). */
const roleColor = (role: Role): string => {
  const c = theme.colors
  switch (role) {
    case "user":
      return c.fg // your prompts — bright foreground
    case "assistant":
      return c.claude // Claude — accent orange
    case "tool":
      return c.fgDim // tool calls — dim, like a shell echo
    case "system":
      return c.warning // permission/system notices — yellow
  }
}

/**
 * Leading glyph per role, mimicking a real Claude Code session log:
 *  - user prompts open with the prompt chevron `>`
 *  - assistant turns open with the reply marker `⏵`
 *  - tool calls open with a dim bullet `⎿`
 *  - system notices open with `●`
 */
const roleGlyph = (role: Role): string => {
  switch (role) {
    case "user":
      return ">"
    case "assistant":
      return "⏵"
    case "tool":
      return "⎿"
    case "system":
      return "●"
  }
}

/** mm:ss timestamp from seconds-since-start, for the dim left gutter. */
const fmtTime = (t: number): string => {
  const m = Math.floor(t / 60)
  const s = Math.floor(t % 60)
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`
}

export function AttachedSession({ session, width, height }: AttachedSessionProps) {
  const c = theme.colors
  const icon = iconForShape({
    processAlive: session.processAlive,
    isLoop: session.isLoop,
    state: session.state,
  })
  const stateColor = colorForState(session.state)

  // Padding is 1 on each side; usable inner width for rules / truncation.
  const innerWidth = Math.max(8, width - 2)
  const rule = "─".repeat(innerWidth)

  // ── Top line: name + dim cwd on the left, "attached <icon>" pinned right ──
  // Build the left run, then pad so "attached ✻" sits at the right edge.
  const left = `▟▙  ${session.name} · ${session.cwd}`
  const attachedLabel = `attached ${icon}`
  const gap = Math.max(2, innerWidth - left.length - attachedLabel.length)

  // ── Recap block: what happened while you were away ──
  // Derive bullets from the session's recent peekOutput; if it's waiting on a
  // question, append that as the trailing "Now waiting" line.
  const recapLines: string[] = [...session.peekOutput]
  if (session.state === "needsInput" && session.question) {
    recapLines.push(`Now waiting: ${session.question.text}`)
  }

  // ── Transcript scrollback ──
  // Budget: total height minus top line (1), rule (1), recap header (1),
  // recap bullets, blank spacers (~3), prompt line (1), bottom rule (1),
  // footer (1), and the box padding (2). Show the tail (latest) entries so it
  // reads like a live terminal scrolled to the bottom.
  const chrome = 1 + 1 + 1 + recapLines.length + 3 + 1 + 1 + 1 + 2
  const transcriptBudget = Math.max(3, height - chrome)
  const entries = session.transcript
  const hidden = Math.max(0, entries.length - transcriptBudget)
  const shown = hidden > 0 ? entries.slice(hidden) : entries

  return (
    <box width={width} height={height} flexDirection="column" backgroundColor={c.bg} padding={1}>
      {/* Top line */}
      <text wrapMode="none">
        <span fg={c.claude} attributes={TextAttributes.BOLD}>{"▟▙  "}</span>
        <span fg={c.fg} attributes={TextAttributes.BOLD}>{session.name}</span>
        <span fg={c.fgDim}>{` · ${session.cwd}`}</span>
        <span fg={c.fgDim}>{" ".repeat(gap)}</span>
        <span fg={stateColor} attributes={TextAttributes.BOLD}>{"attached "}</span>
        <span fg={stateColor}>{icon}</span>
      </text>

      <text fg={c.separator} wrapMode="none">{rule}</text>

      {/* Recap block */}
      <box flexDirection="column" marginTop={1}>
        <text fg={c.fgDim} attributes={TextAttributes.BOLD} wrapMode="none">
          Recap — while you were away
        </text>
        {recapLines.map((line, i) => (
          <text key={`recap-${i}`} wrapMode="none">
            <span fg={c.claude}>{"    · "}</span>
            <span fg={c.fg}>{line}</span>
          </text>
        ))}
      </box>

      {/* Transcript replay (scrolled to the tail) */}
      <box flexDirection="column" marginTop={1} flexGrow={1}>
        {hidden > 0 && (
          <text fg={c.fgDim} wrapMode="none">{`    ⋮ ${hidden} earlier ${hidden === 1 ? "line" : "lines"}`}</text>
        )}
        {shown.map((entry, i) => (
          <text key={`tx-${hidden + i}`} wrapMode="none">
            <span fg={c.separator}>{`${fmtTime(entry.t)}  `}</span>
            <span
              fg={roleColor(entry.role)}
              attributes={entry.role === "user" ? TextAttributes.BOLD : undefined}
            >
              {`${roleGlyph(entry.role)} ${entry.text}`}
            </span>
          </text>
        ))}
      </box>

      {/* Standard session prompt (not the ❯ dispatch chevron) */}
      <text wrapMode="none">
        <span fg={c.fg} attributes={TextAttributes.BOLD}>{"> "}</span>
        <span fg={c.claudeShimmer} attributes={TextAttributes.BOLD}>{"█"}</span>
      </text>

      <text fg={c.separator} wrapMode="none">{rule}</text>

      {/* Detach-hint footer */}
      <text wrapMode="none">
        <span fg={c.claude} attributes={TextAttributes.BOLD}>{"←"}</span>
        <span fg={c.fgDim}>{" detach · "}</span>
        <span fg={c.fgDim} attributes={TextAttributes.BOLD}>{"ctrl+o"}</span>
        <span fg={c.fgDim}>{" transcript · "}</span>
        <span fg={c.fgDim} attributes={TextAttributes.BOLD}>{"ctrl+c×2"}</span>
        <span fg={c.fgDim}>{" detach · "}</span>
        <span fg={c.fgDim} attributes={TextAttributes.BOLD}>{"/stop"}</span>
        <span fg={c.fgDim}>{" end session"}</span>
      </text>
    </box>
  )
}
