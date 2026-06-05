// HelpOverlay — centered modal listing every shortcut (visual-spec §7).
// Renders the FULL keyboard-shortcut table verbatim from the raw inventory
// (_raw-inventory §7 / ux-flows), grouped sensibly, as a two-column key→action
// table: keys in `fg` (bold), actions in `fgDim`. The dismiss hint
// `esc or ? to close` is centered in the bottom border.
//
// Pure render: dismiss is wired in the keymap (Esc / ? -> help toggle).

import { TextAttributes } from "@opentui/core"
import { theme } from "../theme/theme"

export interface HelpOverlayProps {
  width: number
  height: number
}

// Grouped shortcut rows. Each group has a bold sub-header and its key→action
// rows. Verbatim from _raw-inventory §7 (the full table) plus the context-
// specific shortcuts mentioned in prose right below it.
type Section = { title: string; rows: Array<[string, string]> }

const SECTIONS: Section[] = [
  {
    title: "Navigate",
    rows: [
      ["↑ / ↓", "Move between rows"],
      ["Shift+↑ / Shift+↓", "Reorder the selected session"],
      ["Enter", "Attach to the selected session, or dispatch if there's text in the input"],
      ["→", "Attach to the selected session"],
      ["Alt+1 .. Alt+9", "Attach to session 1–9 in the focused session's directory"],
    ],
  },
  {
    title: "Dispatch & peek",
    rows: [
      ["Space", "Open or close the peek panel for the selected session"],
      ["Shift+Enter", "Dispatch and attach immediately"],
      ["Tab", "On empty input, browse all subagents; otherwise apply the suggestion"],
      ["Ctrl+G", "Open the dispatch prompt in your $VISUAL or $EDITOR"],
    ],
  },
  {
    title: "Manage sessions",
    rows: [
      ["Ctrl+S", "Switch grouping between state and directory"],
      ["Ctrl+T", "Pin or unpin the selected session"],
      ["Ctrl+R", "Rename the selected session"],
      ["Ctrl+X", "Stop the session; press again within two seconds to delete it"],
    ],
  },
  {
    title: "Dismiss",
    rows: [
      ["Esc", "Close the peek panel, clear the input, or exit"],
      ["Ctrl+C", "Clear the input; press twice to exit"],
      ["?", "Show all shortcuts"],
    ],
  },
]

const FOOTER = "esc or ? to close"

export function HelpOverlay({ width, height }: HelpOverlayProps) {
  const c = theme.colors

  // Fixed-width key column so action descriptions align across all sections.
  const KEY_COL = SECTIONS.reduce(
    (m, s) => s.rows.reduce((mm, [key]) => Math.max(mm, key.length), m),
    0,
  )

  const totalRows = SECTIONS.reduce((n, s) => n + s.rows.length, 0)

  // Box width: wide enough for the longest "key + action" line, capped to the
  // terminal. Inner padding is 2 each side; +2 for the border.
  const longestLine = SECTIONS.reduce(
    (m, s) => s.rows.reduce((mm, [, action]) => Math.max(mm, KEY_COL + 3 + action.length), m),
    0,
  )
  const TITLE = "Keyboard shortcuts"
  const innerWidth = Math.max(longestLine, TITLE.length + 4, FOOTER.length + 4)
  const boxWidth = Math.min(width - 4, innerWidth + 6)

  // Height: title row + blank lines around section blocks + group headers + rows,
  // plus top/bottom border. Roughly: each section = 1 header + rows + 1 trailing blank.
  const contentLines = totalRows + SECTIONS.length * 2 // header + trailing blank per section
  const boxHeight = Math.min(height - 2, contentLines + 4)

  const left = Math.max(0, Math.floor((width - boxWidth) / 2))
  const top = Math.max(0, Math.floor((height - boxHeight) / 2))

  return (
    <box
      position="absolute"
      left={left}
      top={top}
      width={boxWidth}
      height={boxHeight}
      border
      borderStyle="rounded"
      borderColor={c.separator}
      backgroundColor={c.bg}
      title={TITLE}
      titleAlignment="left"
      bottomTitle={FOOTER}
      bottomTitleAlignment="center"
      flexDirection="column"
      paddingTop={1}
      paddingBottom={0}
      paddingLeft={2}
      paddingRight={2}
    >
      {SECTIONS.map((section, si) => (
        <box key={section.title} flexDirection="column">
          <text fg={c.claude} attributes={TextAttributes.BOLD} wrapMode="none">
            {section.title}
          </text>
          {section.rows.map(([key, action], ri) => (
            <text key={ri} wrapMode="none">
              <span fg={c.fg} attributes={TextAttributes.BOLD}>
                {"  " + key.padEnd(KEY_COL)}
              </span>
              <span fg={c.fgDim}>{"   " + action}</span>
            </text>
          ))}
          {si < SECTIONS.length - 1 ? <text> </text> : null}
        </box>
      ))}
    </box>
  )
}
