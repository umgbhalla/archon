# Agent View mock — termctrl test report

Tested the OpenTUI app in `app/` by driving it through a real pseudo-terminal with
`termctrl` (kitlangton/terminal-control, `--host opentui`), keyboard-only. Method per the
tool's skill: record a marked timeline, then read **recording frames at markers**
(`show/save --recording --at-marker`) rather than live `show` — live reads race sub-2s
states (e.g. the delete arm window) and report stale frames.

## Coverage — every state-machine transition exercised
- Dispatch (new session + auto-name), and the `Too short` (<4 char) rejection.
- Filter `s:working` (and the `a:`/`#`/PR grammar).
- Peek (Space): recent output; adjacent peek (↑/↓); blocked session with numbered options.
- Answer a question with a number key (`pickOption`).
- Attach (Enter/→): the inbuilt session terminal — recap + timestamped transcript; detach (←).
- Help overlay (?), group-by-directory (Ctrl+S), pin (Ctrl+T), reorder (Shift+↑/↓).
- Rename (Ctrl+R → edit → Enter commit).
- Delete chord: Ctrl+X arms a 2s confirm banner (with worktree warning); Ctrl+X again removes the row.
- Scenario stepping (n) and responsive resize (74→120 cols).
- Esc layered-back / exit-to-shell.

## Bug found and fixed
**Filter was detected but never applied.** `isFilterText()` flipped the input into
`filterMode` (warning color, HUD) but `buildRenderGroups()` ignored it, so `s:working`
did nothing to the list. Fixed by adding `matchesFilter()` and applying it to the visible
set in `buildRenderGroups` (`a:<agent>`, `s:<state>` incl. `s:blocked`→needsInput,
`#<pr>`, PR-url). Verified: `s:working` now shows only Pinned(working) + Working groups.

## Non-bugs (test-harness artifacts, documented to avoid re-chasing)
- **Delete "always disarmed" via live `show`** — measurement artifact. The recording frame
  at the arm marker shows the `⚠ stopped · Ctrl+X again within 2s` banner, and the confirm
  marker shows `session deleted`. Live `show` round-trips exceeded the 2s window.
- **Ctrl+R / Ctrl+T / Ctrl+X "no-op"** — selection was on a group header (headers are
  navigable, so you can collapse groups), where `selectedSession` is undefined. With a row
  selected, all three work. Driving via peek-adjacent (rows only) avoids it.
- **`Esc` on an empty table exits to shell** — correct (U35); only surprising mid-script.

## Verdict
State machine + rendering verified end-to-end in a real terminal. One real bug (filter) fixed.
