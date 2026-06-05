# Agent View — OpenTUI Mock

A **scripted, non-functional mock** of Claude Code's Agent View TUI (`claude agents`),
built with [OpenTUI](https://github.com/) (`@opentui/react` + `@opentui/core`) on Bun.

It reproduces the look and the interaction model of the Agent View — the grouped
session list, the peek panel, the attached fullscreen session, help/rename/delete
overlays — driven entirely by a **seeded roster** and a **manually-advanced scripted
timeline**. There is no daemon, no LLM, and no real sessions behind it. Every state
transition fires either on a real keystroke or when you step the scenario with `n`.

Specs it implements:
- `../SPEC/state-machine.md` — the UI-mode statechart (Part B) and per-session FSM (Part A)
- `../SPEC/visual-spec.md` — colors, icons, layout, row anatomy, panel/overlay layouts

---

## Install & run

Requires [Bun](https://bun.sh). From this directory (`app/`):

```sh
bun install
bun run start        # launch the TUI (interactive)
# or
bun run dev          # same, with --watch reload
```

It is an interactive terminal UI: run it in a real terminal. `Esc` (from the table,
empty input) or `Ctrl+C` twice exits to the shell.

Typecheck:

```sh
bunx tsc --noEmit    # clean, no errors
```

---

## Keymap

The single source of truth is `src/state/keymap.ts` (`keyToAction`), which maps raw
keys to high-level actions per the U-transition table in `SPEC/state-machine.md §B.3`.
The reducer in `src/state/store.ts` applies them.

### Table view (default)

| Key | Action |
| :-- | :----- |
| `↑` / `↓` | Move selection between rows and group headers |
| `Shift+↑` / `Shift+↓` | Reorder (mock: moves selection) |
| `Space` | Open the peek panel for the selected **row** → `peekPanel` |
| `Enter` / `→` | Attach to selected row (empty input) → `attachedSession`; on a **header**, `Enter` collapses/expands it |
| `Shift+Enter` | Dispatch the input text **and** attach → `attachedSession` |
| `?` | Help overlay → `helpOverlay` |
| `Ctrl+R` | Rename selected session → `renameInput` |
| `Ctrl+X` | Stop + arm delete (1st press) → `deleteConfirm`; on a header arms a group delete |
| `Ctrl+S` | Toggle grouping axis state ↔ directory (HUD only in the mock) |
| `Ctrl+T` | Pin / unpin selected session |
| `Ctrl+C` | Clear input; with empty input, exit to shell |
| `Esc` | Layered back: clear input, else exit to shell |
| `n` | **Mock-only:** advance the scripted scenario by one event |
| any printable | Type into the dispatch input (`a:`/`s:`/`#`/PR-URL prefix → `filterMode`, else `dispatchInput`) |
| `Enter` (with text) | Dispatch a new session (≥4 chars, else "Too short") → back to `tableView` |

### Peek panel (`peekPanel`)

| Key | Action |
| :-- | :----- |
| `Space` / `Esc` | Close the panel |
| `↑` / `↓` | Peek the adjacent row without closing |
| `→` | Attach to the peeked session → `attachedSession` |
| `1`..`9` | Pick a numbered option (when no reply text typed) |
| `Tab` | Fill a suggested reply |
| `Enter` | Send the typed reply |
| printable / `Backspace` | Edit the reply buffer |

### Attached session (`attachedSession`)

| Key | Action |
| :-- | :----- |
| `←` / `Ctrl+Z` / `Ctrl+C` | Detach → `tableView` (session keeps running) |
| `Esc` | Exit to shell |

### Help (`helpOverlay`)

| Key | Action |
| :-- | :----- |
| `Esc` / `?` | Close → back to previous mode |

### Rename (`renameInput`)

| Key | Action |
| :-- | :----- |
| `Enter` | Commit the new name |
| `Esc` | Cancel |
| printable / `Backspace` | Edit the name buffer |

### Delete confirm (`deleteConfirm`)

| Key | Action |
| :-- | :----- |
| `Ctrl+X` (2nd, within 2s) | Delete the row (or whole group if a header was armed) |
| `Esc` | Disarm (session stays stopped) |
| (2s timeout) | Auto-disarm — the only timer-driven UI transition |

---

## Which key reaches which mode

| Mode | Reached by | Component |
| :--- | :--------- | :-------- |
| `tableView` | initial / `Esc` / `Space` close / `detach` / commit / disarm | `App.tsx` (inline) |
| `dispatchInput` | typing a non-filter prompt | `App.tsx` (input echo) |
| `filterMode` | typing `a:` / `s:` / `#` / a PR URL | `App.tsx` (input echo, yellow) |
| `peekPanel` | `Space` on a row | `PeekPanel.tsx` |
| `attachedSession` | `Enter` / `→` on a row, `→` in peek, `Shift+Enter` | `AttachedSession.tsx` |
| `helpOverlay` | `?` | `HelpOverlay.tsx` |
| `renameInput` | `Ctrl+R` | `RenameInput.tsx` |
| `deleteConfirm` | `Ctrl+X` (1st) | `DeleteConfirm.tsx` |
| `onboardingEmpty` | roster empties (state-driven; the seeded roster is never empty, so not reached in normal use) | `App.tsx` |

---

## What is faked vs real

**Real (genuinely implemented):**
- The full UI-mode statechart and per-session lifecycle reducer (`store.ts`).
- All keyboard wiring and mode switching (`keymap.ts` → `store.ts` → `App.tsx`).
- Grouping (Pinned → Ready for review → Needs input → Working → Completed), the
  `… N more` fold (failures and PR rows always stay visible), selection band,
  state colors, the 4 icon shapes, PR labels, peek/attached/help/rename/delete layouts.
- The 2s delete-arm window (the only app-level timer), and dispatch/rename/answer/
  pin/delete state mutations.

**Faked / scripted:**
- **No backend, no LLM, no real sessions.** The roster is hardcoded in `data/seed.ts`.
- The "live" timeline is **manual** — there is no background clock advancing sessions.
  Press `n` to apply the next scripted event from `data/scenario.ts` (summary refresh,
  a new needs-input session appearing, a PR going green, a loop tick, an answer, etc.).
- Dispatching a prompt creates a stub `working` row; it never actually does work.
- Answering / picking an option just flips the session to `working` (no scripted follow-up).
- `Ctrl+S` (grouping by directory), `Shift+↑/↓` reorder, `Alt+1..9`, `Ctrl+G` editor
  handoff, and OSC-8 PR hyperlinks are stubbed or HUD-only.
- The working spinner is a static `✽` glyph (no per-frame shimmer animation); spinner
  frame/shimmer tables exist in `theme.ts` but are not animated.
- Time-ago strings (`3m`, `2h`, `in 4m`) are static text, not computed from a clock.
- A demo **HUD** line at the bottom (not part of the real product) shows the last
  action and the scenario cursor `(N/total)`.

---

## Known gaps

- **Manual timeline only:** the scenario advances on `n`, not on a wall-clock timer, so
  the screen does not animate on its own (deliberate, for deterministic demoing).
- **No spinner animation:** working rows show a steady `✽` rather than the eased
  6-frame orange shimmer described in `visual-spec §3b`.
- **`onboardingEmpty` is unreachable in normal use** because the seeded roster is never
  empty; deleting every row would reach it.
- **`Ctrl+S` / `Shift`-reorder / `Alt+1..9` / `Ctrl+G`** are acknowledged in the keymap
  and HUD but do not perform their full real-product behavior.
- **Light theme** tokens exist (`theme.ts`) and `setThemeMode("light")` works, but there
  is no key bound to switch themes at runtime.
- **Piped/headless key input** is not honored — OpenTUI needs a real TTY, so automated
  key-sequence smoke tests only confirm a clean start + exit, not scripted navigation.

## Test

`bun test` runs the reducer/state-machine suite (`src/state/store.test.ts`).
