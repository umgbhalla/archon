// Central KEYMAP — the single place that maps raw keyboard events to high-level
// FsmActions (state/store.ts), per the U-transition table in
// SPEC/state-machine.md §B.3. The App calls `keyToAction(key, state)` for every
// keypress and dispatches the returned action (if any).
//
// KeyEvent fields used (from @opentui/core): name, ctrl, meta, shift, sequence.
// Arrow keys -> name "up"/"down"/"left"/"right"; Enter -> "return";
// Esc -> "escape"; Space -> "space"; Tab -> "tab"; Backspace -> "backspace".

import type { KeyEvent } from "@opentui/core"
import { selectedSelectable, type AppState, type FsmAction } from "./store"

const DIGITS = new Set(["1", "2", "3", "4", "5", "6", "7", "8", "9"])

/** Is this a plain printable character (for typing into inputs)? */
function printableChar(key: KeyEvent): string | null {
  if (key.ctrl || key.meta) return null
  const seq = key.sequence ?? ""
  if (seq.length === 1 && seq >= " " && seq !== "\x7f") return seq
  // space arrives as name "space"
  if (key.name === "space") return " "
  return null
}

/**
 * Translate a raw key into an FsmAction, given the current mode.
 * Returns null when the key has no binding in the current mode.
 *
 * NOTE: the 2s deleteConfirm timeout (U29) is NOT here — it is a timer the App
 * arms with setTimeout and resolves by dispatching { type: "deleteDisarm" }.
 * The `n` scenario-advance key is mock-only (Part C) and only active outside text input.
 */
export function keyToAction(key: KeyEvent, state: AppState): FsmAction | null {
  const name = key.name
  const mode = state.mode

  // ───────────────── attachedSession ─────────────────
  if (mode === "attachedSession") {
    if (name === "left") return { type: "detach" } // U18
    if (name === "escape") return { type: "exit" } // U21 — to shell
    if (key.ctrl && name === "z") return { type: "detach" } // U19
    if (key.ctrl && name === "c") return { type: "detach" } // U20 (mock: single press detaches)
    return null
  }

  // ───────────────── helpOverlay ─────────────────
  if (mode === "helpOverlay") {
    if (name === "escape" || name === "?" || key.sequence === "?") return { type: "help" } // U23 toggles back
    return null
  }

  // ───────────────── renameInput ─────────────────
  if (mode === "renameInput") {
    if (name === "return") return { type: "renameCommit" } // U25
    if (name === "escape") return { type: "back" } // U26
    if (name === "backspace") return { type: "inputBackspace" }
    const ch = printableChar(key)
    if (ch) return { type: "inputChar", ch }
    return null
  }

  // ───────────────── deleteConfirm ─────────────────
  if (mode === "deleteConfirm") {
    if (key.ctrl && name === "x") return { type: "deleteConfirm" } // U28 / U30 confirm
    if (name === "escape") return { type: "deleteDisarm" } // U29
    return null
  }

  // ───────────────── peekPanel ─────────────────
  if (mode === "peekPanel") {
    if (name === "space") return { type: "peekToggle" } // U10 close
    if (name === "escape") return { type: "back" } // U10 close (or clear reply)
    if (name === "up") return { type: "peekAdjacent", delta: -1 } // U11
    if (name === "down") return { type: "peekAdjacent", delta: 1 } // U11
    if (name === "right") return { type: "attach" } // U15
    if (name === "tab") return { type: "suggestReply" } // U13
    if (name === "return") return { type: "sendReply" } // U14
    if (name === "backspace") return { type: "inputBackspace" }
    // number key picks an option (U12) ONLY when no reply text is being typed
    if (state.replyBuffer.length === 0 && key.sequence && DIGITS.has(key.sequence)) {
      return { type: "pickOption", n: Number(key.sequence) }
    }
    const ch = printableChar(key)
    if (ch) return { type: "inputChar", ch } // type a reply
    return null
  }

  // ───────────────── tableView / dispatchInput / filterMode / onboardingEmpty ─────────────────
  const hasInput = state.input.text.length > 0

  // Global table-mode chords (work regardless of input contents) ──
  if (key.ctrl && name === "r") return { type: "renameStart" } // U24
  if (key.ctrl && name === "x") return { type: "deleteArm" } // U27 / U30
  if (key.ctrl && name === "s") return { type: "groupToggleAxis" } // U32
  if (key.ctrl && name === "t") return { type: "pinToggle" } // U33
  if (key.ctrl && name === "c") return hasInput ? { type: "inputClear" } : { type: "exit" } // U8 / U36

  // Enter — overloaded (spec note B.4) ──
  if (name === "return") {
    if (key.shift) return { type: "dispatchAndAttach" } // U6
    if (hasInput) return { type: "dispatchSubmit" } // U5 / U7
    // empty input: Enter on a header collapses; on a row attaches
    const sel = selFor(state)
    if (sel === "header") return { type: "headerToggle" } // U31
    return { type: "attach" } // U16
  }

  // Right arrow — attach (U16) ──
  if (name === "right" && !hasInput) return { type: "attach" }

  // Selection movement (only meaningful when not mid-type, but harmless) ──
  if (name === "up") return key.shift ? { type: "reorderSelection", delta: -1 } : { type: "moveSelection", delta: -1 }
  if (name === "down") return key.shift ? { type: "reorderSelection", delta: 1 } : { type: "moveSelection", delta: 1 }

  // Space — peek (only when input empty; otherwise it's a typed space) ──
  if (name === "space" && !hasInput) return { type: "peekToggle" } // U9

  // ? — help (only when input empty) ──
  if ((name === "?" || key.sequence === "?") && !hasInput) return { type: "help" } // U22

  // Esc — layered back / clear / exit ──
  if (name === "escape") return { type: "back" } // U8 / U35

  // Backspace — edit input ──
  if (name === "backspace") return { type: "inputBackspace" }

  // `n` — mock-only: advance the scripted scenario (Part C) when input empty ──
  if (!hasInput && key.sequence === "n" && !key.ctrl && !key.meta) return { type: "scenarioStep" }

  // Any other printable char -> type into dispatch/filter input (U2/U3) ──
  const ch = printableChar(key)
  if (ch) return { type: "inputChar", ch }

  return null
}

/** Selection kind helper used by the keymap to disambiguate Enter (U16 vs U31). */
function selFor(state: AppState): "header" | "row" | "none" {
  const sel = selectedSelectable(state)
  if (!sel) return "none"
  return sel.kind
}
