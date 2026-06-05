/**
 * Keymap — maps raw @opentui/core KeyEvents to UiActions, per mode.
 *
 * PORTED from mock/agent-view/app/src/state/keymap.ts, simplified to the real
 * surface: a session grid with a dispatch input, plus an attached view with its
 * own prompt input.
 *
 * grid mode:
 *   ↑/↓        moveSelection
 *   Enter      attach (if a row is selected) OR dispatch (if dispatch buffer set)
 *   q          exit (when dispatch empty)
 *   Esc        clear dispatch input, else exit
 *   Ctrl+C     clear dispatch input, else exit
 *   <printable> type into dispatch buffer; Backspace edits
 *
 * attached mode:
 *   Enter      send the attachInput buffer as a prompt
 *   Esc / Ctrl+C / Ctrl+Z / ←  detach back to grid
 *   <printable> type into attachInput; Backspace edits
 */
import type { KeyEvent } from "@opentui/core";
import type { UiAction } from "./store.ts";
import type { SessionSnapshot } from "../core/session-manager.ts";
import { selectedSelectable, type UiState } from "./store.ts";

function printableChar(key: KeyEvent): string | null {
  if (key.ctrl || key.meta) return null;
  const seq = key.sequence ?? "";
  if (seq.length === 1 && seq >= " " && seq !== "\x7f") return seq;
  if (key.name === "space") return " ";
  return null;
}

export function keyToAction(
  key: KeyEvent,
  state: UiState,
  sessions: SessionSnapshot[],
): UiAction | null {
  const name = key.name;

  // ── attached mode ──
  if (state.mode === "attached") {
    if (name === "escape" || name === "left") return { type: "detach" };
    if (key.ctrl && (name === "z" || name === "c")) return { type: "detach" };
    if (name === "return") return null; // handled by host (async prompt send)
    if (name === "backspace") return { type: "attachBackspace" };
    const ch = printableChar(key);
    if (ch) return { type: "attachChar", ch };
    return null;
  }

  // ── grid mode ──
  const hasDispatch = state.dispatch.length > 0;

  if (key.ctrl && name === "c") return hasDispatch ? { type: "dispatchClear" } : { type: "exit" };
  if (name === "up") return { type: "moveSelection", delta: -1, sessions };
  if (name === "down") return { type: "moveSelection", delta: 1, sessions };
  if (name === "right" && !hasDispatch) {
    const sel = selectedSelectable(state, sessions);
    if (sel?.kind === "row") return { type: "attach", sessions };
    return null;
  }

  if (name === "return") {
    if (hasDispatch) return null; // host handles async createSession
    const sel = selectedSelectable(state, sessions);
    if (sel?.kind === "row") return { type: "attach", sessions };
    return null;
  }

  // q exits only when not typing into the dispatch buffer.
  if (!hasDispatch && (name === "q" || key.sequence === "q")) return { type: "exit" };

  if (name === "escape") return { type: "back", sessions };
  if (name === "backspace") return { type: "dispatchBackspace" };

  const ch = printableChar(key);
  if (ch) return { type: "dispatchChar", ch };

  return null;
}
