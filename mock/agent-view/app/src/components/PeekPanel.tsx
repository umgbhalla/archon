// PeekPanel — overlay shown with Space on a selected row (visual-spec §5).
//
// Renders the selected session's recent output OR its pending question:
//   · rounded title bar: name (bold, left) + state icon & label (right)
//   · "Most recent output" section (bold sub-header + dim underline rule)
//     drawn from session.peekOutput
//   · numbered question options (1..n) when session.question.options exist,
//     under a "Choose an option:" prompt — a number key picks one (keymap-wired)
//   · "Pull requests" section listing session.pr (colored per §2c)
//   · a reply input line (`❯`) showing replyBuffer, with the
//     "type a reply, or press 1–n · tab fills a suggested reply" hint
//   · a nav-hint line BELOW the panel: ↑/↓ peek adjacent · → attach · space/esc close
//
// Pure render only: number-key pick / Tab-fills / Enter-sends / ↑↓ adjacent-peek /
// → attach are already wired in keymap + store. This component never touches the store.

import { TextAttributes } from "@opentui/core"
import type { PrStatus, Session, SessionState } from "../data/types"
import { colorForPr, colorForState, iconForShape, theme } from "../theme/theme"

export interface PeekPanelProps {
  /** The session currently being peeked (the selected row). */
  session: Session
  /** Live reply-editor buffer (Tab fills a suggestion, typing edits it). */
  replyBuffer: string
  /** Terminal width, for sizing the rounded box. */
  width: number
  /** Terminal height available below the table. */
  height: number
}

// Human-readable state labels for the title bar (e.g. "✻ needs input").
const STATE_LABELS: Record<SessionState, string> = {
  working: "working",
  needsInput: "needs input",
  idle: "idle",
  completed: "completed",
  failed: "failed",
  stopped: "stopped",
}

// Short status phrase for a PR row (visual-spec §2c semantics).
const PR_STATUS_TEXT: Record<PrStatus, string> = {
  yellow: "waiting on checks",
  green: "checks passed — ready to merge",
  purple: "merged",
  grey: "draft",
}

export function PeekPanel({ session, replyBuffer, width }: PeekPanelProps) {
  const c = theme.colors

  // Box geometry — leave a 2-col margin each side, cap so it reads like the spec.
  const boxWidth = Math.max(40, Math.min(width - 4, 94))
  const inner = boxWidth - 4 // minus border (2) + padding (2)

  const icon = iconForShape({ processAlive: session.processAlive, isLoop: session.isLoop, state: session.state })
  const stateColor = colorForState(session.state)
  const stateLabel = `${icon} ${STATE_LABELS[session.state]}`

  const question = session.question
  const hasOptions = !!question?.options && question.options.length > 0
  const optionCount = question?.options?.length ?? 0

  // Title bar: name bold-left, state icon+label right, gap filler between.
  const titleGap = Math.max(1, inner - session.name.length - stateLabel.length)

  // Dim underline rule sized to the sub-header label.
  const rule = (label: string) => "─".repeat(label.length)

  // Reply hint adapts to whether numbered options are available.
  const replyHint = hasOptions
    ? `type a reply, or press 1–${optionCount} to choose · tab fills a suggested reply`
    : "type a reply · tab fills a suggested reply · ! to run a bash command"

  const replyText = replyBuffer.length > 0 ? replyBuffer : replyHint
  const replyColor = replyBuffer.length > 0 ? c.fg : c.fgDim

  return (
    <box
      position="absolute"
      left={2}
      top={4}
      width={boxWidth}
      border
      borderStyle="rounded"
      borderColor={c.separator}
      backgroundColor={c.bg}
      flexDirection="column"
      paddingLeft={1}
      paddingRight={1}
    >
      {/* ── Title bar: name (bold) … state icon + label ── */}
      <text wrapMode="none">
        <span fg={c.fg} attributes={TextAttributes.BOLD}>{session.name}</span>
        <span fg={c.fgDim}>{" ".repeat(titleGap)}</span>
        <span fg={stateColor}>{stateLabel}</span>
      </text>

      <box height={1} />

      {/* ── Most recent output ── */}
      <text fg={c.fg} attributes={TextAttributes.BOLD}>Most recent output</text>
      <text fg={c.fgDim}>{rule("Most recent output")}</text>
      {session.peekOutput.map((line, i) => (
        <text key={`peek-${i}`} fg={c.fg} wrapMode="word">{line}</text>
      ))}

      {/* ── Pending question + numbered options ── */}
      {question ? (
        <box flexDirection="column">
          <box height={1} />
          <text fg={c.fg} wrapMode="word">{question.text}</text>
          {hasOptions ? (
            <box flexDirection="column">
              <box height={1} />
              <text fg={c.fg} attributes={TextAttributes.BOLD}>Choose an option:</text>
              {question.options!.map((opt, i) => (
                <text key={`opt-${i}`} wrapMode="none">
                  <span fg={c.warning} attributes={TextAttributes.BOLD}>{`  ${i + 1}. `}</span>
                  <span fg={c.fg}>{opt}</span>
                </text>
              ))}
            </box>
          ) : null}
        </box>
      ) : null}

      {/* ── Pull requests ── */}
      {session.pr ? (
        <box flexDirection="column">
          <box height={1} />
          <text fg={c.fg} attributes={TextAttributes.BOLD}>Pull requests</text>
          <text fg={c.fgDim}>{rule("Pull requests")}</text>
          <text wrapMode="none">
            <span fg={colorForPr(session.pr.status)} attributes={TextAttributes.BOLD}>{`  PR #${session.pr.number}`}</span>
            <span fg={c.fgDim}>{`   ${PR_STATUS_TEXT[session.pr.status]}`}</span>
          </text>
        </box>
      ) : null}

      {/* ── Divider above the reply input (a thin dim rule, full inner width) ── */}
      <box height={1} />
      <text fg={c.separator} wrapMode="none">{"─".repeat(Math.max(1, inner))}</text>

      {/* ── Reply input line ── */}
      <text wrapMode="none">
        <span fg={c.claude}>{"❯ "}</span>
        <span fg={replyColor}>{replyText}</span>
        {replyBuffer.length > 0 ? <span fg={c.claude}>{"▏"}</span> : null}
      </text>

      {/* ── Nav-hint line (inside the panel's bottom, dim) ── */}
      <box height={1} />
      <text fg={c.fgDim} wrapMode="none">↑/↓ peek adjacent · → attach · space/esc close</text>
    </box>
  )
}
