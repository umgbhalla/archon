// DeleteConfirm — the armed-for-2s delete confirmation banner shown after the
// first Ctrl+X (spec U27-U30; ux-flows §8). The session has just been stopped
// (S8) and a 2s delete window is armed. A second Ctrl+X within 2s deletes the
// row + its auto-created worktree (incl. uncommitted changes); Esc / 2s timeout
// disarm and the row stays Stopped.
//
// The authoritative 2s disarm timer lives in App (setTimeout -> deleteDisarm)
// and the confirm/disarm transitions are wired in the keymap. This component is
// pure-render: it only mirrors that window with a local, decorative countdown
// bar (the App timer remains the source of truth — when it fires, App unmounts
// this banner). No store access, no key handling.

import { useEffect, useRef, useState } from "react"
import { TextAttributes } from "@opentui/core"
import { theme } from "../theme/theme"

// Mirror of store's DELETE_ARM_MS (2000). Kept as a local constant so this stub
// stays pure-render and does not import store internals; it only drives the
// decorative countdown — App's timer is what actually disarms.
const ARM_MS = 2000
const TICK_MS = 50
const BAR_CELLS = 28

export interface DeleteConfirmProps {
  /** Name of the session armed for delete, or null when a whole group is armed. */
  targetName: string | null
  /** Group name when a whole group's deletion is armed (Ctrl+X on a header). */
  targetGroup: string | null
  width: number
}

export function DeleteConfirm({ targetName, targetGroup, width }: DeleteConfirmProps) {
  const c = theme.colors
  const isGroup = targetGroup != null

  // Decorative countdown: fraction of the 2s window remaining (1 -> 0). Resets
  // whenever the armed target changes (a re-arm of a different row).
  const armKey = isGroup ? `group:${targetGroup}` : `row:${targetName}`
  const startedAt = useRef<number>(Date.now())
  const [remaining, setRemaining] = useState(1)

  useEffect(() => {
    startedAt.current = Date.now()
    setRemaining(1)
    const id = setInterval(() => {
      const elapsed = Date.now() - startedAt.current
      const frac = Math.max(0, 1 - elapsed / ARM_MS)
      setRemaining(frac)
      if (frac <= 0) clearInterval(id)
    }, TICK_MS)
    return () => clearInterval(id)
  }, [armKey])

  const secondsLeft = Math.max(0, remaining * (ARM_MS / 1000))
  const filled = Math.round(remaining * BAR_CELLS)
  const bar = "█".repeat(filled) + "░".repeat(BAR_CELLS - filled)
  // Bar warms toward red as the window closes (cool warning -> hot error).
  const barColor = remaining > 0.5 ? c.warning : c.error

  const target = isGroup ? `every session in "${targetGroup}"` : `"${targetName ?? "session"}"`
  const headline = isGroup
    ? `stopped · delete ${target}?`
    : `stopped · press Ctrl+X again within 2s to delete`

  const boxWidth = Math.min(Math.max(width - 4, 40), 72)

  return (
    <box
      position="absolute"
      left={2}
      top={5}
      width={boxWidth}
      border
      borderStyle="rounded"
      borderColor={c.error}
      backgroundColor={c.bg}
      padding={1}
      flexDirection="column"
    >
      {/* Headline: the session/group was just stopped (S8) and is armed. */}
      <text fg={c.error} attributes={TextAttributes.BOLD} wrapMode="none">
        <span fg={c.error} attributes={TextAttributes.BOLD}>{"⚠ "}</span>
        <span fg={c.fg} attributes={TextAttributes.BOLD}>{"stopped"}</span>
        <span fg={c.fgDim}>{" · "}</span>
        {isGroup ? (
          <>
            <span fg={c.error} attributes={TextAttributes.BOLD}>{"delete "}</span>
            <span fg={c.fg} attributes={TextAttributes.BOLD}>{target}</span>
            <span fg={c.error} attributes={TextAttributes.BOLD}>{"?"}</span>
          </>
        ) : (
          <>
            <span fg={c.fgDim}>{"press "}</span>
            <span fg={c.error} attributes={TextAttributes.BOLD}>{"Ctrl+X"}</span>
            <span fg={c.fgDim}>{" again within 2s to "}</span>
            <span fg={c.error} attributes={TextAttributes.BOLD}>{"delete"}</span>
          </>
        )}
      </text>

      {/* For a single row, name the target on its own line. */}
      {isGroup ? null : (
        <text fg={c.fgDim} wrapMode="none">
          <span fg={c.fgDim}>{"target: "}</span>
          <span fg={c.fg}>{`"${targetName ?? "session"}"`}</span>
        </text>
      )}

      {/* Countdown bar — decorative mirror of the 2s arm window. */}
      <text fg={barColor} wrapMode="none">
        <span fg={barColor}>{bar}</span>
        <span fg={c.fgDim}>{`  ${secondsLeft.toFixed(1)}s`}</span>
      </text>

      {/* Worktree data-loss warning (ux-flows §8: FAKE/static copy). */}
      <text fg={c.warning} wrapMode="none">
        <span fg={c.warning}>{"⚠ "}</span>
        <span fg={c.fgDim}>{isGroup
          ? "removes each row and its worktree, incl. uncommitted changes"
          : "removes the row and its worktree, incl. uncommitted changes"}</span>
      </text>
      <text fg={c.fgDim} wrapMode="none">
        <span fg={c.fgDim}>{"(use "}</span>
        <span fg={c.fg}>{"claude rm"}</span>
        <span fg={c.fgDim}>{" from the shell to keep the dirty worktree)"}</span>
      </text>

      {/* Disarm hint (U29). */}
      <text fg={c.fgDim} wrapMode="none">
        <span fg={c.fg} attributes={TextAttributes.BOLD}>{"esc"}</span>
        <span fg={c.fgDim}>{" to keep (stays stopped) · auto-disarms in 2s"}</span>
      </text>
    </box>
  )
}
