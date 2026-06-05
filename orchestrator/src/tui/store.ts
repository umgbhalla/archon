/**
 * UI state machine for the session-grid TUI.
 *
 * PORTED from mock/agent-view/app/src/state/store.ts, but with a critical
 * difference: this store does NOT own the session list. The session data is the
 * REAL SessionManager snapshot, fed in from React state. This store owns only
 * *UI* state: current mode, selection (tracked by stable session id, not index,
 * per the mock's keepSelection pattern), the dispatch input buffer, the attach
 * input buffer, a transient HUD/status line, a filter-to-waiting toggle, and the
 * delete-arm window (Ctrl+X twice to delete).
 *
 * Selectables (headers + rows) are derived from the live snapshot via
 * buildSelectables(snapshot, filter), so selection survives regroup/add/remove.
 */
import type { SessionSnapshot } from "../core/session-manager.ts";
import { GROUP_ORDER, GROUP_TITLES, groupForState, type SessionGroup } from "./theme.ts";

export type UiMode = "grid" | "attached" | "help";

export type SelectableKind = "header" | "row";
export interface Selectable {
  kind: SelectableKind;
  /** Group this selectable belongs to. */
  group: SessionGroup;
  /** Stable session id for rows; undefined for headers. */
  sessionId?: string;
}

export interface RenderGroup {
  group: SessionGroup;
  title: string;
  rows: SessionSnapshot[];
}

/** UI-only state. Session data is passed in separately (the live snapshot). */
export interface UiState {
  mode: UiMode;
  /** Stable selection key (header:<group> or row:<id>). Survives regroup. */
  selectionKey: string | null;
  /** Dispatch input buffer (creates a new session on submit). */
  dispatch: string;
  /** Attach input buffer (sends a prompt to the attached session). */
  attachInput: string;
  /** Scrollback offset for the attached ChatView (lines up from the tail; 0 = pinned). */
  attachScroll: number;
  /** Currently attached session id (mode === "attached"). */
  attachedId: string | null;
  /** Transient status/HUD line. */
  hud: string;
  /** When true, only needs-input (waiting) sessions are shown ("which agent needs me?"). */
  filterWaiting: boolean;
  /**
   * Session id armed for deletion. First Ctrl+X stops + arms; a second Ctrl+X
   * within the arm window (host timer) deletes; Esc / timeout disarms.
   */
  deleteArmedId: string | null;
  /** The mode to return to when help is dismissed (help overlays grid or attached). */
  helpReturnMode: UiMode;
  /** Set true to signal the host to tear down + exit. */
  exited: boolean;
}

export function initialUiState(): UiState {
  return {
    mode: "grid",
    selectionKey: null,
    dispatch: "",
    attachInput: "",
    attachScroll: 0,
    attachedId: null,
    hud: "ready",
    filterWaiting: false,
    deleteArmedId: null,
    helpReturnMode: "grid",
    exited: false,
  };
}

// ── Derivation from the live snapshot ─────────────────────────────────────────

/** Apply the filter-to-waiting toggle to a raw session list. */
export function applyFilter(sessions: SessionSnapshot[], filterWaiting: boolean): SessionSnapshot[] {
  if (!filterWaiting) return sessions;
  return sessions.filter((s) => s.state === "waiting");
}

/** Group + order the live sessions into render groups (empty groups dropped). */
export function buildRenderGroups(
  sessions: SessionSnapshot[],
  filterWaiting = false,
): RenderGroup[] {
  const src = applyFilter(sessions, filterWaiting);
  const out: RenderGroup[] = [];
  for (const group of GROUP_ORDER) {
    const rows = src
      .filter((s) => groupForState(s.state) === group)
      .sort((a, b) => b.updatedAt - a.updatedAt);
    if (rows.length > 0) out.push({ group, title: GROUP_TITLES[group], rows });
  }
  return out;
}

/** Flatten render groups into a navigable list of selectables (header, rows...). */
export function buildSelectables(
  sessions: SessionSnapshot[],
  filterWaiting = false,
): Selectable[] {
  const out: Selectable[] = [];
  for (const rg of buildRenderGroups(sessions, filterWaiting)) {
    out.push({ kind: "header", group: rg.group });
    for (const row of rg.rows) {
      out.push({ kind: "row", group: rg.group, sessionId: row.id });
    }
  }
  return out;
}

export function keyForSelectable(sel: Selectable): string {
  return sel.kind === "header" ? `header:${sel.group}` : `row:${sel.sessionId}`;
}

export function selectedSelectable(
  state: UiState,
  sessions: SessionSnapshot[],
): Selectable | undefined {
  const list = buildSelectables(sessions, state.filterWaiting);
  if (list.length === 0) return undefined;
  const found = state.selectionKey
    ? list.find((s) => keyForSelectable(s) === state.selectionKey)
    : undefined;
  return found ?? list[0];
}

export function selectedSession(
  state: UiState,
  sessions: SessionSnapshot[],
): SessionSnapshot | undefined {
  const sel = selectedSelectable(state, sessions);
  if (!sel || sel.kind !== "row" || !sel.sessionId) return undefined;
  return sessions.find((s) => s.id === sel.sessionId);
}

// ── Actions ──────────────────────────────────────────────────────────────────

export type UiAction =
  | { type: "moveSelection"; delta: number; sessions: SessionSnapshot[] }
  | { type: "attach"; sessions: SessionSnapshot[] }
  | { type: "detach" }
  | { type: "exit" }
  | { type: "back"; sessions: SessionSnapshot[] }
  | { type: "dispatchChar"; ch: string }
  | { type: "dispatchBackspace" }
  | { type: "dispatchClear" }
  | { type: "attachChar"; ch: string }
  | { type: "attachBackspace" }
  | { type: "attachClear" }
  | { type: "scrollUp"; lines: number }
  | { type: "scrollDown"; lines: number }
  | { type: "scrollReset" }
  | { type: "setHud"; hud: string }
  | { type: "toggleFilter" }
  | { type: "toggleHelp" }
  | { type: "stopArm"; id: string }
  | { type: "disarmDelete" }
  // The host clamps/repairs the selection after the snapshot changes.
  | { type: "reconcileSelection"; sessions: SessionSnapshot[] };

/** Move selection by delta within the derived selectable list, by stable key. */
function move(state: UiState, sessions: SessionSnapshot[], delta: number): UiState {
  const list = buildSelectables(sessions, state.filterWaiting);
  if (list.length === 0) return state;
  const cur = selectedSelectable(state, sessions);
  const idx = cur ? list.findIndex((s) => keyForSelectable(s) === keyForSelectable(cur)) : 0;
  const base = idx < 0 ? 0 : idx;
  const next = Math.max(0, Math.min(list.length - 1, base + delta));
  const sel = list[next];
  return sel ? { ...state, selectionKey: keyForSelectable(sel) } : state;
}

export function reducer(state: UiState, action: UiAction): UiState {
  switch (action.type) {
    case "moveSelection":
      return move(state, action.sessions, action.delta);

    case "attach": {
      const sess = selectedSession(state, action.sessions);
      if (!sess) return { ...state, hud: "no session selected" };
      return {
        ...state,
        mode: "attached",
        attachedId: sess.id,
        attachInput: "",
        attachScroll: 0,
        deleteArmedId: null,
        hud: `attached ${sess.id}`,
      };
    }

    case "detach":
      return { ...state, mode: "grid", attachedId: null, attachInput: "", attachScroll: 0 };

    case "back":
      // help -> return to underlying mode; attached -> grid; grid w/ input -> clear; else exit.
      if (state.mode === "help") return { ...state, mode: state.helpReturnMode };
      if (state.deleteArmedId) return { ...state, deleteArmedId: null, hud: "delete disarmed" };
      if (state.mode === "attached") return { ...state, mode: "grid", attachedId: null, attachInput: "", attachScroll: 0 };
      if (state.dispatch.length > 0) return { ...state, dispatch: "" };
      return { ...state, exited: true };

    case "exit":
      return { ...state, exited: true };

    case "dispatchChar":
      return { ...state, dispatch: state.dispatch + action.ch };
    case "dispatchBackspace":
      return { ...state, dispatch: state.dispatch.slice(0, -1) };
    case "dispatchClear":
      return { ...state, dispatch: "" };

    case "attachChar":
      return { ...state, attachInput: state.attachInput + action.ch };
    case "attachBackspace":
      return { ...state, attachInput: state.attachInput.slice(0, -1) };
    case "attachClear":
      return { ...state, attachInput: "" };

    case "scrollUp":
      // Lift the window up from the tail; ChatView clamps to the real maxOffset.
      return { ...state, attachScroll: state.attachScroll + action.lines };
    case "scrollDown":
      return { ...state, attachScroll: Math.max(0, state.attachScroll - action.lines) };
    case "scrollReset":
      return { ...state, attachScroll: 0 };

    case "setHud":
      return { ...state, hud: action.hud };

    case "toggleFilter":
      return { ...state, filterWaiting: !state.filterWaiting, deleteArmedId: null };

    case "toggleHelp":
      if (state.mode === "help") return { ...state, mode: state.helpReturnMode };
      return { ...state, mode: "help", helpReturnMode: state.mode };

    case "stopArm":
      return { ...state, deleteArmedId: action.id };

    case "disarmDelete":
      return { ...state, deleteArmedId: null };

    case "reconcileSelection": {
      const list = buildSelectables(action.sessions, state.filterWaiting);
      // If a delete-armed session vanished from the snapshot, disarm.
      const armedGone =
        state.deleteArmedId != null &&
        !action.sessions.some((s) => s.id === state.deleteArmedId);
      const base = armedGone ? { ...state, deleteArmedId: null } : state;
      if (list.length === 0) return { ...base, selectionKey: null };
      const stillThere = base.selectionKey && list.some((s) => keyForSelectable(s) === base.selectionKey);
      if (stillThere) return base;
      const first = list[0];
      return first ? { ...base, selectionKey: keyForSelectable(first) } : base;
    }
  }
}
