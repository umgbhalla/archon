// Onboarding — shown when the roster is empty (mode "onboardingEmpty", L505).
// Replaces the session list with a hint + example prompts until the first
// dispatch. Pure render; the dispatch input + footer come from App.

import { TextAttributes } from "@opentui/core"
import { theme } from "../theme/theme"

const EXAMPLES = [
  "investigate the flaky checkout test",
  "review PR #2048 and address comments",
  "add a water shader to the lava biome",
  "! pytest -x        (run a shell job)",
]

export function Onboarding({ width }: { width: number; height: number }) {
  const c = theme.colors
  const rule = "─".repeat(Math.max(8, width - 4))
  return (
    <box flexDirection="column" paddingLeft={2} paddingTop={2} flexGrow={1}>
      <text fg={c.fg} attributes={TextAttributes.BOLD} wrapMode="none">
        No background sessions yet.
      </text>
      <text fg={c.fgDim} wrapMode="none">
        Describe a task below and press Enter to dispatch your first session.
      </text>
      <box marginTop={1} />
      <text fg={c.fgDim} attributes={TextAttributes.BOLD} wrapMode="none">Try:</text>
      {EXAMPLES.map((ex, i) => (
        <text key={i} wrapMode="none">
          <span fg={c.claude}>{"  ❯ "}</span>
          <span fg={c.fg}>{ex}</span>
        </text>
      ))}
      <box marginTop={1} />
      <text fg={c.separator} wrapMode="none">{rule}</text>
    </box>
  )
}
