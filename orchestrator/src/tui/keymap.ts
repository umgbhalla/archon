/**
 * Keymap — maps raw @opentui/core KeyEvents to UiActions, per mode.
 *
 * PORTED from mock/agent-view/app/src/state/keymap.ts, simplified to the real
 * surface: a session grid with a dispatch input, an attached view with its own
 * prompt input, a filter-to-waiting toggle, a Ctrl+X stop/delete chord, and a
 * ? help overlay.
 *
 * The HELP_SECTIONS table below is the single source of truth for the keymap:
 * the ? overlay (HelpOverlay) is *generated* from it, and the bindings here are
 * the same set. Keep the two in sync by editing only this file.
 *
 * grid mode:
 *   ↑/↓        moveSelection
 *   Enter / →  attach (row selected) OR dispatch (dispatch buffer set)
 *   w          toggle filter-to-waiting (only needs-input sessions)
 *   Ctrl+X     stop the selected session; press again within 2s to delete it
 *   ?          toggle the help overlay
 *   q          exit (when dispatch empty)
 *   Esc        disarm delete · clear dispatch · else exit
 *   Ctrl+C     clear dispatch input, else exit
 *   <printable> type into dispatch buffer; Backspace edits
 *
 * attached mode:
 *   Enter      send the attachInput buffer as a prompt
 *   ? (empty)  toggle help; Esc / Ctrl+C / Ctrl+Z / ←  detach back to grid
 *   <printable> type into attachInput; Backspace edits
 *
 * help mode:
 *   ? / Esc    dismiss
 */
import type { KeyEvent } from "@opentui/core";
import type { UiAction } from "./store.ts";
import type { SessionSnapshot } from "../core/session-manager.ts";
import { selectedSelectable, type UiState } from "./store.ts";

/** A documented binding: the keys label + what it does. Drives the help overlay. */
export interface KeyBinding {
  keys: string;
  action: string;
}
export interface KeySection {
  title: string;
  rows: KeyBinding[];
}

/** Single source of truth for bindings — the help overlay is generated from this. */
export const HELP_SECTIONS: KeySection[] = [
  {
    title: "Navigate",
    rows: [
      ["↑ / ↓", "Move between sessions"],
      ["Enter / →", "Attach to the selected session"],
      ["Enter", "Dispatch a new session when the input has text"],
    ].map(([keys, action]) => ({ keys: keys!, action: action! })),
  },
  {
    title: "Fleet",
    rows: [
      ["w", "Filter to sessions that need input (toggle)"],
      ["Ctrl+X", "Stop the selected session; press again within 2s to delete"],
      ["Esc", "Disarm a pending delete"],
    ].map(([keys, action]) => ({ keys: keys!, action: action! })),
  },
  {
    title: "Attached view",
    rows: [
      ["Enter", "Send the typed prompt to the attached session"],
      ["PgUp / PgDn", "Scroll back through the transcript"],
      ["1-9 / ↑↓ / Enter", "Answer a permission prompt (Esc denies)"],
      ["← / Esc / Ctrl+Z", "Detach back to the grid"],
    ].map(([keys, action]) => ({ keys: keys!, action: action! })),
  },
  {
    title: "General",
    rows: [
      ["?", "Toggle this help"],
      ["q / Esc", "Exit to the shell (when the input is empty)"],
      ["Ctrl+C", "Clear the input, else exit"],
    ].map(([keys, action]) => ({ keys: keys!, action: action! })),
  },
];

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

  // ── help mode ── (overlays grid/attached; only dismiss keys matter)
  if (state.mode === "help") {
    if (name === "escape" || key.sequence === "?" || name === "q") return { type: "toggleHelp" };
    if (key.ctrl && name === "c") return { type: "toggleHelp" };
    return null;
  }

  // ── attached mode ──
  if (state.mode === "attached") {
    // ? opens help only when not mid-typed (so a literal '?' can be sent).
    if (key.sequence === "?" && state.attachInput.length === 0) return { type: "toggleHelp" };
    if (name === "escape" || name === "left") return { type: "detach" };
    if (key.ctrl && (name === "z" || name === "c")) return { type: "detach" };
    // Scrollback through the transcript (a page ≈ 10 lines).
    if (name === "pageup") return { type: "scrollUp", lines: 10 };
    if (name === "pagedown") return { type: "scrollDown", lines: 10 };
    if (name === "return") return null; // handled by host (async prompt send)
    if (name === "backspace") return { type: "attachBackspace" };
    const ch = printableChar(key);
    if (ch) return { type: "attachChar", ch };
    return null;
  }

  // ── grid mode ──
  const hasDispatch = state.dispatch.length > 0;

  // Ctrl+X stop/delete chord is stateful + async → handled by the host.
  if (key.ctrl && name === "x") return null;

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

  // Single-key commands only when not typing a task into the dispatch buffer.
  if (!hasDispatch) {
    if (key.sequence === "?") return { type: "toggleHelp" };
    if (name === "w" || key.sequence === "w") return { type: "toggleFilter" };
    if (name === "q" || key.sequence === "q") return { type: "exit" };
  }

  if (name === "escape") return { type: "back", sessions };
  if (name === "backspace") return { type: "dispatchBackspace" };

  const ch = printableChar(key);
  if (ch) return { type: "dispatchChar", ch };

  return null;
}
