// RenameInput — inline rename editor opened with Ctrl+R (spec U24-U26).
//
// Renders an inline edit field that sits over the selected row: a selection-band
// row showing a pencil glyph, the live `renameBuffer` with a block caret, and a
// trailing "Enter commit · Esc cancel" hint. A dim context line below shows the
// original name. Pure render only — the store holds the buffer; typing,
// backspace, commit (Enter, U25) and cancel (Esc, U26) are wired in keymap+store.

import { TextAttributes } from "@opentui/core"
import { theme } from "../theme/theme"

export interface RenameInputProps {
  /** The session name being edited (live buffer). */
  renameBuffer: string
  /** The original session name, for context. */
  originalName: string
  width: number
}

export function RenameInput({ renameBuffer, originalName, width }: RenameInputProps) {
  const c = theme.colors
  const bg = c.selectionBg

  // Match SessionRow's left inset (icon column) so the editor reads as the row.
  const PENCIL = "✎ "
  const HINT = " Enter commit · Esc cancel"

  // Caret blink would require a timer; a steady block caret keeps this pure-render.
  const buffer = renameBuffer.length > 0 ? renameBuffer : ""
  const empty = buffer.length === 0

  // Reserve space for the trailing hint so it stays visible on the band.
  const inner = Math.max(10, width - 4)

  return (
    <box position="absolute" left={2} top={5} width={Math.min(inner, width - 4)} flexDirection="column">
      {/* The inline edit row — full-width selection band, like the selected row. */}
      <box height={1} paddingLeft={2} paddingRight={2} backgroundColor={bg}>
        <text wrapMode="none" bg={bg}>
          <span fg={c.claude} bg={bg} attributes={TextAttributes.BOLD}>{PENCIL}</span>
          {empty ? (
            <span fg={c.fgDim} bg={bg}>{originalName}</span>
          ) : (
            <span fg={c.fg} bg={bg} attributes={TextAttributes.BOLD}>{buffer}</span>
          )}
          <span fg={c.claudeShimmer} bg={bg}>█</span>
          <span fg={c.fgDim} bg={bg}>{HINT}</span>
        </text>
      </box>

      {/* Context line: what we're renaming from. */}
      <box paddingLeft={4}>
        <text wrapMode="none">
          <span fg={c.fgDim}>{"renaming "}</span>
          <span fg={c.fgDim} attributes={TextAttributes.ITALIC}>{`"${originalName}"`}</span>
        </text>
      </box>
    </box>
  )
}
