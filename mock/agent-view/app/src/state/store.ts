// Central state store for the Agent View mock.
//
// Two cooperating layers (SPEC/state-machine.md):
//   Part A — per-session lifecycle reducer (applySessionEvent)
//   Part B — app/UI-mode statechart (UiMode + transitions)
//
// Exposed to React via `useStore()`, which returns the current AppState plus a
// stable `dispatch(action)` callback. Components READ from the snapshot and
// SEND high-level FsmAction values (produced by the keymap, see state/keymap.ts).
//
// Everything is keyboard-driven / scripted. The ONLY timer is the 2s
// deleteConfirm arm window (see DELETE_ARM_MS), wired in App via setTimeout.

import { useCallback, useReducer } from "react"
import { seedSessions } from "../data/seed"
import { scenarioEvents } from "../data/scenario"
import type { Session, SessionGroup, SessionState } from "../data/types"
import { GROUP_ORDER, setThemeMode } from "../theme/theme"

// ───────────────────────── UI modes (Part B.1) ─────────────────────────

export type UiMode =
  | "onboardingEmpty" // pre-first-dispatch hint + example prompts
  | "tableView" // default grouped session list, one row selected
  | "peekPanel" // peek overlay for the selected row
  | "attachedSession" // fullscreen interactive session (agent view replaced)
  | "helpOverlay" // all shortcuts in context
  | "renameInput" // inline rename of selected session
  | "deleteConfirm" // armed-for-2s delete confirmation
  | "dispatchInput" // dispatch input has a (non-filter) prompt
  | "filterMode" // dispatch input holds a filter (a:/s:/#/PR)

export const DELETE_ARM_MS = 2000

// Selection can target a session row OR a group header (changes Enter/Ctrl+X
// semantics, spec U30/U31). The flat list interleaves headers and rows so
// ↑/↓ moves linearly through whatever is visible.
export type SelectableKind = "header" | "row"
export interface Selectable {
  kind: SelectableKind
  group: SessionGroup
  /** session id when kind==="row"; undefined for headers */
  sessionId?: string
}

export interface DispatchState {
  text: string
  /** true => filterMode (a:/s:/#/PR prefix); false => dispatchInput */
  isFilter: boolean
}

export interface AppState {
  mode: UiMode
  /** Mode to return to when an overlay/input closes (usually tableView). */
  prevMode: UiMode
  sessions: Session[]
  /** Collapsed group headers (Enter on a header toggles). */
  collapsedGroups: SessionGroup[]
  /** Index into the flat selectable list (headers + rows). */
  selectedIndex: number
  /** Grouping axis: by state-group (default) or by directory (Ctrl+S). */
  grouping: "state" | "directory"
  /** Dispatch / filter input contents. */
  input: DispatchState
  /** Rename editor buffer (renameInput mode). */
  renameBuffer: string
  /** Peek reply editor buffer (peekPanel mode). */
  replyBuffer: string
  /** Session id armed for delete (deleteConfirm mode), or null. */
  deleteArmedId: string | null
  /** Whether deleteConfirm targets a whole group header. */
  deleteArmedGroup: SessionGroup | null
  /** Index of the next scenario event to apply (manual scenarioStep). */
  scenarioCursor: number
  /** Ephemeral status line for the demo HUD (last scenario label / error). */
  hud: string
  /** When attached, the session id we're attached to. */
  attachedId: string | null
  /** Ctrl+O transcript view inside the attached session. */
  transcriptMode: boolean
  /** Active theme palette (Ctrl+L toggles). */
  themeMode: "light" | "dark"
  /** Whether the app has requested exit-to-shell. */
  exited: boolean
}

// ───────────────────────── Filter grammar (U2/U3) ─────────────────────────

/** A prompt becomes a *filter* (not a dispatch) when it matches this grammar. */
export function isFilterText(text: string): boolean {
  const t = text.trimStart()
  if (t.startsWith("a:")) return true // agent filter
  if (t.startsWith("s:")) return true // state filter
  if (t.startsWith("#")) return true // session number / id
  if (/^https?:\/\/\S*\/pull\/\d+/.test(t)) return true // PR url
  return false
}

/** Does a session match the active filter text (a:<name>, s:<state>, #<n>, PR url)? */
export function matchesFilter(sess: Session, text: string): boolean {
  const t = text.trim().toLowerCase()
  if (t.startsWith("a:")) {
    const n = t.slice(2).trim()
    return n.length === 0 || sess.agent.toLowerCase().includes(n)
  }
  if (t.startsWith("s:")) {
    const q = t.slice(2).trim()
    if (q === "blocked") return sess.state === "needsInput"
    return sess.state.toLowerCase() === q
  }
  if (t.startsWith("#")) {
    const n = Number(t.slice(1))
    return !Number.isNaN(n) && sess.pr?.number === n
  }
  const m = t.match(/\/pull\/(\d+)/)
  if (m) return sess.pr?.number === Number(m[1])
  return true
}

// ───────────────────── Part A: session lifecycle reducer ─────────────────────

export type SessionEvent =
  | { type: "dispatch"; session: Session }
  | { type: "tick"; id: string; summary?: string }
  | { type: "askQuestion"; id: string; question: Session["question"] }
  | { type: "answer"; id: string }
  | { type: "finish"; id: string; outcome: "success" | "fail" | "idle" }
  | { type: "stop"; id: string }
  | { type: "delete"; id: string }
  | { type: "deleteGroup"; group: SessionGroup }
  | { type: "respawn"; id: string }
  | { type: "procRestart"; id: string }
  | { type: "pin"; id: string }
  | { type: "loopTick"; id: string }
  | { type: "patch"; id: string; patch: Partial<Session> }

const stateToGroup = (s: SessionState): SessionGroup => {
  switch (s) {
    case "needsInput":
      return "needsInput"
    case "working":
      return "working"
    default:
      return "completed" // completed + failed + stopped + idle fold here
  }
}

/** Resolve the group for a session: pinned floats; an open PR -> readyForReview. */
export function resolveGroup(s: Session): SessionGroup {
  if (s.pinned) return "pinned"
  if (s.pr) return "readyForReview"
  return stateToGroup(s.state)
}

/** Apply one session-lifecycle event, returning a new sessions array. */
export function applySessionEvent(sessions: Session[], ev: SessionEvent): Session[] {
  const map = (fn: (s: Session) => Session, id: string) =>
    sessions.map((s) => (s.id === id ? fn(s) : s))

  switch (ev.type) {
    case "dispatch":
      return [...sessions, ev.session]
    case "tick":
      return map((s) => ({ ...s, ...(ev.summary ? { summary: ev.summary } : {}), lastChangedAgo: "now" }), ev.id)
    case "askQuestion":
      return map((s) => {
        const next = { ...s, state: "needsInput" as SessionState, question: ev.question }
        return { ...next, group: resolveGroup(next) }
      }, ev.id)
    case "answer":
      return map((s) => {
        const next: Session = { ...s, state: "working", question: undefined }
        return { ...next, group: resolveGroup(next) }
      }, ev.id)
    case "finish":
      return map((s) => {
        const state: SessionState = ev.outcome === "success" ? "completed" : ev.outcome === "fail" ? "failed" : "idle"
        const next: Session = { ...s, state, processAlive: ev.outcome === "fail" ? false : s.processAlive }
        return { ...next, group: resolveGroup(next) }
      }, ev.id)
    case "stop":
      return map((s) => {
        const next: Session = { ...s, state: "stopped", processAlive: false }
        return { ...next, group: resolveGroup(next) }
      }, ev.id)
    case "delete":
      return sessions.filter((s) => s.id !== ev.id)
    case "deleteGroup":
      return sessions.filter((s) => resolveGroup(s) !== ev.group)
    case "respawn":
      return map((s) => {
        const next: Session = { ...s, state: "working", processAlive: true }
        return { ...next, group: resolveGroup(next) }
      }, ev.id)
    case "procRestart":
      return map((s) => ({ ...s, processAlive: true }), ev.id)
    case "pin":
      return map((s) => {
        const next: Session = { ...s, pinned: !s.pinned }
        return { ...next, group: resolveGroup(next) }
      }, ev.id)
    case "loopTick":
      return map((s) => ({ ...s, loopRun: (s.loopRun ?? 0) + 1, lastChangedAgo: "now" }), ev.id)
    case "patch": {
      // patch-as-upsert: if id is unknown, append it as a new session.
      const exists = sessions.some((s) => s.id === ev.id)
      if (!exists) return [...sessions, { ...(ev.patch as Session) }]
      return map((s) => {
        const merged: Session = { ...s, ...ev.patch }
        return { ...merged, group: ev.patch.group ?? resolveGroup(merged) }
      }, ev.id)
    }
  }
}

// ─────────────────── Flat selectable list (headers + rows) ───────────────────

/** Fold rule: in `completed`, keep `failed` + any PR-bearing rows visible;
 *  collapse the rest beyond the first two into a synthetic `… N more`. */
export interface RenderGroup {
  group: SessionGroup
  collapsed: boolean
  rows: Session[]
  foldedCount: number // rows hidden behind "… N more"
}

export function buildRenderGroups(state: AppState): RenderGroup[] {
  const groups: RenderGroup[] = []
  // Apply the active filter (a:/s:/#/PR) to the visible set (U3) before grouping.
  const active =
    state.input.isFilter && state.input.text.trim().length > 0
      ? state.sessions.filter((s) => matchesFilter(s, state.input.text))
      : state.sessions
  for (const g of GROUP_ORDER) {
    const inGroup = active.filter((s) => resolveGroup(s) === g)
    if (inGroup.length === 0) continue
    const collapsed = state.collapsedGroups.includes(g)
    let rows = inGroup
    let foldedCount = 0
    if (g === "completed" && !collapsed) {
      const visible: Session[] = []
      const rest: Session[] = []
      for (const s of inGroup) {
        if (s.state === "failed" || s.pr) visible.push(s)
        else rest.push(s)
      }
      const keep = rest.slice(0, Math.max(0, 2 - visible.length))
      foldedCount = rest.length - keep.length
      rows = [...visible, ...keep]
    }
    groups.push({ group: g, collapsed, rows: collapsed ? [] : rows, foldedCount })
  }
  return groups
}

/** Flatten render groups into the ↑/↓ selectable sequence. */
export function buildSelectables(state: AppState): Selectable[] {
  const out: Selectable[] = []
  for (const rg of buildRenderGroups(state)) {
    out.push({ kind: "header", group: rg.group })
    for (const row of rg.rows) out.push({ kind: "row", group: rg.group, sessionId: row.id })
  }
  return out
}

export function selectedSelectable(state: AppState): Selectable | undefined {
  const list = buildSelectables(state)
  return list[Math.max(0, Math.min(state.selectedIndex, list.length - 1))]
}

export function selectedSession(state: AppState): Session | undefined {
  const sel = selectedSelectable(state)
  if (!sel || sel.kind !== "row") return undefined
  return state.sessions.find((s) => s.id === sel.sessionId)
}

export function sessionById(state: AppState, id: string | null): Session | undefined {
  if (!id) return undefined
  return state.sessions.find((s) => s.id === id)
}

/** Stable key for a selectable: survives reordering/regrouping. */
export function selectionKey(state: AppState): string {
  const sel = selectedSelectable(state)
  if (!sel) return ""
  return sel.kind === "row" ? `row:${sel.sessionId}` : `header:${sel.group}`
}

function keyForSelectable(sel: Selectable): string {
  return sel.kind === "row" ? `row:${sel.sessionId}` : `header:${sel.group}`
}

/** Re-point `next.selectedIndex` at whatever selectable `prev` had selected,
 *  by stable key — so pinning/regrouping/deleting never silently moves the
 *  selection onto a different row. Falls back to the nearest position. */
function keepSelection(prev: AppState, next: AppState): AppState {
  const key = selectionKey(prev)
  const list = buildSelectables(next)
  let idx = list.findIndex((s) => keyForSelectable(s) === key)
  if (idx < 0) idx = Math.max(0, Math.min(prev.selectedIndex, Math.max(0, list.length - 1)))
  return { ...next, selectedIndex: idx }
}

// ─────────────────────── Part B: high-level FSM actions ───────────────────────
// The keymap (state/keymap.ts) translates raw key events into these actions.

export type FsmAction =
  | { type: "moveSelection"; delta: number }
  | { type: "reorderSelection"; delta: number } // Shift+↑/↓
  | { type: "peekToggle" } // Space
  | { type: "peekAdjacent"; delta: number } // ↑/↓ inside peek
  | { type: "pickOption"; n: number } // number key in peek
  | { type: "suggestReply" } // Tab in peek
  | { type: "attach" } // Enter / → on a row, or → in peek
  | { type: "detach" } // ← / Ctrl+Z / Ctrl+C×2 in attached
  | { type: "back" } // Esc — layered back
  | { type: "help" } // ?
  | { type: "renameStart" } // Ctrl+R
  | { type: "renameCommit" } // Enter in renameInput
  | { type: "deleteArm" } // Ctrl+X (1st) on row, or Ctrl+X on header
  | { type: "deleteConfirm" } // Ctrl+X (2nd) within 2s
  | { type: "deleteDisarm" } // 2s timeout / Esc
  | { type: "groupToggleAxis" } // Ctrl+S grouping state<->directory
  | { type: "pinToggle" } // Ctrl+T
  | { type: "headerToggle" } // Enter on a group header (collapse/expand)
  | { type: "inputChar"; ch: string } // typing into dispatch/filter/rename/reply
  | { type: "inputBackspace" }
  | { type: "inputClear" } // Esc/Ctrl+C clears input
  | { type: "dispatchSubmit" } // Enter in dispatchInput
  | { type: "dispatchAndAttach" } // Shift+Enter
  | { type: "sendReply" } // Enter in peek when reply present
  | { type: "scenarioStep" } // `n` — advance the scripted timeline by one event
  | { type: "attachIndex"; n: number } // Alt+1..9 quick-attach
  | { type: "transcriptToggle" } // Ctrl+O in attached
  | { type: "themeToggle" } // Ctrl+L light/dark
  | { type: "exit" } // Esc to shell

// ───────────────────────── Initial state ─────────────────────────

export function initialState(): AppState {
  const sessions = seedSessions.map((s) => ({ ...s }))
  return {
    mode: sessions.length === 0 ? "onboardingEmpty" : "tableView",
    prevMode: "tableView",
    sessions,
    collapsedGroups: [],
    selectedIndex: 1, // skip the first header onto the first row
    grouping: "state",
    input: { text: "", isFilter: false },
    renameBuffer: "",
    replyBuffer: "",
    deleteArmedId: null,
    deleteArmedGroup: null,
    scenarioCursor: 0,
    hud: "ready · press n to advance scenario · ? for shortcuts",
    attachedId: null,
    transcriptMode: false,
    themeMode: "dark",
    exited: false,
  }
}

// ───────────────────────── Reducer ─────────────────────────

function clampIndex(state: AppState, idx: number): number {
  const len = buildSelectables(state).length
  if (len === 0) return 0
  return Math.max(0, Math.min(idx, len - 1))
}

function withInput(state: AppState, text: string): AppState {
  const filter = isFilterText(text)
  const mode: UiMode = text.length === 0 ? (state.sessions.length === 0 ? "onboardingEmpty" : "tableView") : filter ? "filterMode" : "dispatchInput"
  return { ...state, input: { text, isFilter: filter }, mode }
}

function makeDispatchedSession(text: string): Session {
  const short = Math.random().toString(16).slice(2, 10)
  const isShell = text.startsWith("!")
  const cmd = isShell ? text.slice(1).trim() : text
  return {
    id: `${short}-dispatched`,
    shortId: short,
    name: isShell ? `! ${cmd}`.slice(0, 28).trim() : text.slice(0, 28).trim() || "new session",
    agent: isShell ? "shell" : "default",
    cwd: "~/games/clawd-jumps",
    state: "working",
    processAlive: true,
    isLoop: false,
    isShell,
    summary: isShell ? `$ ${cmd}` : text,
    lastChangedAgo: "now",
    pinned: false,
    group: "working",
    peekOutput: isShell ? [`$ ${cmd}`, "running as a background shell job…"] : [`Dispatched: ${text}`],
    transcript: [{ role: isShell ? "tool" : "user", t: 0, text: isShell ? `$ ${cmd}` : text }],
  }
}

export function reducer(state: AppState, action: FsmAction): AppState {
  switch (action.type) {
    // ── selection ──
    case "moveSelection":
      return { ...state, selectedIndex: clampIndex(state, state.selectedIndex + action.delta) }
    case "reorderSelection": {
      const s = selectedSession(state)
      if (!s) return { ...state, selectedIndex: clampIndex(state, state.selectedIndex + action.delta) }
      const list = buildSelectables(state)
      const curIdx = list.findIndex((x) => x.kind === "row" && x.sessionId === s.id)
      if (curIdx < 0) return state
      let j = curIdx + action.delta
      while (j >= 0 && j < list.length && list[j]!.kind !== "row") j += action.delta
      const target = list[j]
      if (!target || target.kind !== "row" || target.group !== list[curIdx]!.group) return state // can't reorder across groups
      const sessions = [...state.sessions]
      const si = sessions.findIndex((x) => x.id === s.id)
      const ti = sessions.findIndex((x) => x.id === target.sessionId)
      ;[sessions[si], sessions[ti]] = [sessions[ti]!, sessions[si]!]
      return keepSelection(state, { ...state, sessions, hud: `reordered "${s.name}"` })
    }

    // ── peek ──
    case "peekToggle": {
      if (state.mode === "peekPanel") return { ...state, mode: "tableView", replyBuffer: "" }
      const sel = selectedSelectable(state)
      if (!sel || sel.kind !== "row") return state // Space only on a row
      return { ...state, prevMode: "tableView", mode: "peekPanel", replyBuffer: "" }
    }
    case "peekAdjacent": {
      if (state.mode !== "peekPanel") return state
      // move selection to the adjacent ROW, staying in peek
      let idx = state.selectedIndex
      const list = buildSelectables(state)
      for (let step = 0; step < list.length; step++) {
        idx = clampIndex(state, idx + action.delta)
        if (list[idx]?.kind === "row") break
      }
      return { ...state, selectedIndex: idx, replyBuffer: "" }
    }
    case "pickOption": {
      const s = selectedSession(state)
      if (!s) return state
      const sessions = applySessionEvent(state.sessions, { type: "answer", id: s.id })
      return keepSelection(state, { ...state, sessions, hud: `picked option ${action.n} for "${s.name}"`, replyBuffer: "" })
    }
    case "suggestReply": {
      const s = selectedSession(state)
      const suggestion = s?.question?.options?.[0] ?? "Sounds good — proceed."
      return { ...state, replyBuffer: suggestion }
    }
    case "sendReply": {
      const s = selectedSession(state)
      if (!s || state.replyBuffer.trim().length === 0) return state
      const sessions = applySessionEvent(state.sessions, { type: "answer", id: s.id })
      return keepSelection(state, { ...state, sessions, replyBuffer: "", hud: `replied to "${s.name}"` })
    }

    // ── attach / detach ──
    case "attach": {
      const s = selectedSession(state)
      if (!s) return state
      // procRestart on attach for exited / failed sessions (S11/S14)
      let sessions = state.sessions
      if (!s.processAlive || s.state === "failed") {
        sessions = applySessionEvent(sessions, s.state === "failed" ? { type: "respawn", id: s.id } : { type: "procRestart", id: s.id })
      }
      return { ...state, sessions, prevMode: "tableView", mode: "attachedSession", attachedId: s.id, replyBuffer: "" }
    }
    case "detach":
      return { ...state, mode: "tableView", attachedId: null, transcriptMode: false }
    case "attachIndex": {
      const rows = buildSelectables(state).filter((x) => x.kind === "row")
      const target = rows[action.n - 1]
      if (!target || target.kind !== "row") return state
      const s = state.sessions.find((x) => x.id === target.sessionId)
      if (!s) return state
      let sessions = state.sessions
      if (!s.processAlive || s.state === "failed") {
        sessions = applySessionEvent(sessions, s.state === "failed" ? { type: "respawn", id: s.id } : { type: "procRestart", id: s.id })
      }
      const all = buildSelectables(state)
      const idx = all.findIndex((x) => x.kind === "row" && x.sessionId === s.id)
      return { ...state, sessions, selectedIndex: idx >= 0 ? idx : state.selectedIndex, prevMode: "tableView", mode: "attachedSession", attachedId: s.id, hud: `attached to ${action.n}` }
    }
    case "transcriptToggle":
      if (state.mode !== "attachedSession") return state
      return { ...state, transcriptMode: !state.transcriptMode }
    case "themeToggle": {
      const themeMode = state.themeMode === "dark" ? "light" : "dark"
      setThemeMode(themeMode)
      return { ...state, themeMode, hud: `theme: ${themeMode}` }
    }

    // ── overlays / layered back ──
    case "back": {
      switch (state.mode) {
        case "peekPanel":
          return { ...state, mode: "tableView", replyBuffer: "" }
        case "helpOverlay":
          return { ...state, mode: "tableView" }
        case "renameInput":
          return { ...state, mode: "tableView", renameBuffer: "" }
        case "deleteConfirm":
          return { ...state, mode: "tableView", deleteArmedId: null, deleteArmedGroup: null, hud: "delete disarmed" }
        case "attachedSession":
          return { ...state, mode: "tableView", attachedId: null }
        case "dispatchInput":
        case "filterMode":
          return withInput(state, "")
        case "tableView":
          return { ...state, exited: true, hud: "exited to shell" }
        default:
          return state
      }
    }
    case "exit":
      return { ...state, exited: true, hud: "exited to shell" }

    case "help":
      if (state.mode === "helpOverlay") return { ...state, mode: state.prevMode }
      return { ...state, prevMode: state.mode, mode: "helpOverlay" }

    // ── rename ──
    case "renameStart": {
      const s = selectedSession(state)
      if (!s) return state
      return { ...state, prevMode: "tableView", mode: "renameInput", renameBuffer: s.name }
    }
    case "renameCommit": {
      const s = selectedSession(state)
      if (!s || state.renameBuffer.trim().length === 0) return { ...state, mode: "tableView", renameBuffer: "" }
      const sessions = applySessionEvent(state.sessions, { type: "patch", id: s.id, patch: { name: state.renameBuffer.trim() } })
      return { ...state, sessions, mode: "tableView", renameBuffer: "", hud: `renamed to "${state.renameBuffer.trim()}"` }
    }

    // ── delete chord ──
    case "deleteArm": {
      const sel = selectedSelectable(state)
      if (!sel) return state
      if (sel.kind === "header") {
        return { ...state, prevMode: "tableView", mode: "deleteConfirm", deleteArmedGroup: sel.group, deleteArmedId: null, hud: `delete all in ${sel.group}? Ctrl+X again within 2s` }
      }
      const s = selectedSession(state)
      if (!s) return state
      // first Ctrl+X stops the session (S8) and arms the window
      const sessions = applySessionEvent(state.sessions, { type: "stop", id: s.id })
      return { ...state, sessions, prevMode: "tableView", mode: "deleteConfirm", deleteArmedId: s.id, deleteArmedGroup: null, hud: "stopped · Ctrl+X again within 2s to delete" }
    }
    case "deleteConfirm": {
      if (state.deleteArmedGroup) {
        const sessions = applySessionEvent(state.sessions, { type: "deleteGroup", group: state.deleteArmedGroup })
        return keepSelection(state, { ...state, sessions, mode: "tableView", deleteArmedGroup: null, hud: "group deleted" })
      }
      if (state.deleteArmedId) {
        const sessions = applySessionEvent(state.sessions, { type: "delete", id: state.deleteArmedId })
        return keepSelection(state, { ...state, sessions, mode: "tableView" as UiMode, deleteArmedId: null, hud: "session deleted" })
      }
      return { ...state, mode: "tableView" }
    }
    case "deleteDisarm":
      return { ...state, mode: "tableView", deleteArmedId: null, deleteArmedGroup: null, hud: "delete disarmed · session stays stopped" }

    // ── grouping / pin / header ──
    case "groupToggleAxis":
      return { ...state, grouping: state.grouping === "state" ? "directory" : "state", hud: `grouping by ${state.grouping === "state" ? "directory" : "state"}` }
    case "pinToggle": {
      const s = selectedSession(state)
      if (!s) return state
      const sessions = applySessionEvent(state.sessions, { type: "pin", id: s.id })
      return keepSelection(state, { ...state, sessions, hud: s.pinned ? `unpinned "${s.name}"` : `pinned "${s.name}"` })
    }
    case "headerToggle": {
      const sel = selectedSelectable(state)
      if (!sel || sel.kind !== "header") return state
      const collapsed = state.collapsedGroups.includes(sel.group)
      const collapsedGroups = collapsed ? state.collapsedGroups.filter((g) => g !== sel.group) : [...state.collapsedGroups, sel.group]
      return keepSelection(state, { ...state, collapsedGroups })
    }

    // ── input editing ──
    case "inputChar": {
      if (state.mode === "renameInput") return { ...state, renameBuffer: state.renameBuffer + action.ch }
      if (state.mode === "peekPanel") return { ...state, replyBuffer: state.replyBuffer + action.ch }
      return withInput(state, state.input.text + action.ch)
    }
    case "inputBackspace": {
      if (state.mode === "renameInput") return { ...state, renameBuffer: state.renameBuffer.slice(0, -1) }
      if (state.mode === "peekPanel") return { ...state, replyBuffer: state.replyBuffer.slice(0, -1) }
      return withInput(state, state.input.text.slice(0, -1))
    }
    case "inputClear":
      if (state.mode === "renameInput") return { ...state, mode: "tableView", renameBuffer: "" }
      if (state.mode === "peekPanel") return { ...state, replyBuffer: "" }
      return withInput(state, "")

    // ── dispatch ──
    case "dispatchSubmit": {
      const text = state.input.text.trim()
      if (state.input.isFilter) {
        // U7: a filter Enter selects a matching session instead of dispatching.
        return { ...withInput(state, ""), hud: `filter applied: ${text}` }
      }
      if (!text.startsWith("!") && text.length < 4) return { ...state, hud: "Too short — describe a task in at least 4 chars" }
      const session = makeDispatchedSession(text)
      const sessions = applySessionEvent(state.sessions, { type: "dispatch", session })
      const next: AppState = { ...withInput(state, ""), sessions, mode: "tableView", hud: session.isShell ? `started shell job "${session.name}"` : `dispatched "${session.name}"` }
      const list = buildSelectables(next)
      const idx = list.findIndex((x) => x.kind === "row" && x.sessionId === session.id)
      return { ...next, selectedIndex: idx >= 0 ? idx : clampIndex(next, 1) }
    }
    case "dispatchAndAttach": {
      const text = state.input.text.trim()
      if (text.length < 4) return { ...state, hud: "Too short — describe a task in at least 4 chars" }
      const session = makeDispatchedSession(text)
      const sessions = applySessionEvent(state.sessions, { type: "dispatch", session })
      return { ...withInput(state, ""), sessions, mode: "attachedSession", attachedId: session.id, hud: `dispatched & attached "${session.name}"` }
    }

    // ── scenario timeline (manual, keyboard-driven) ──
    case "scenarioStep": {
      if (state.scenarioCursor >= scenarioEvents.length) return { ...state, hud: "scenario complete (no more events)" }
      const ev = scenarioEvents[state.scenarioCursor]!
      let sessions = applySessionEvent(state.sessions, { type: "patch", id: ev.sessionId, patch: ev.patch })
      if (ev.appendPeek) {
        sessions = sessions.map((s) => (s.id === ev.sessionId ? { ...s, peekOutput: [...s.peekOutput, ev.appendPeek!] } : s))
      }
      if (ev.appendTranscript) {
        sessions = sessions.map((s) => (s.id === ev.sessionId ? { ...s, transcript: [...s.transcript, ev.appendTranscript!] } : s))
      }
      return keepSelection(state, { ...state, sessions, scenarioCursor: state.scenarioCursor + 1, hud: `[${state.scenarioCursor + 1}/${scenarioEvents.length}] ${ev.label}` })
    }

    default:
      return state
  }
}

// ───────────────────────── React binding ─────────────────────────

export interface Store {
  state: AppState
  dispatch: (action: FsmAction) => void
}

export function useStore(): Store {
  const [state, rawDispatch] = useReducer(reducer, undefined, initialState)
  const dispatch = useCallback((action: FsmAction) => rawDispatch(action), [])
  return { state, dispatch }
}
