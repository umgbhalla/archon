import { describe, expect, test } from "bun:test"
import {
  applySessionEvent,
  buildRenderGroups,
  buildSelectables,
  initialState,
  matchesFilter,
  reducer,
  selectedSession,
  selectionKey,
  type AppState,
  type FsmAction,
} from "./store"
import type { Session } from "../data/types"

const run = (st: AppState, ...as: FsmAction[]) => as.reduce((s, a) => reducer(s, a), st)
const rowOf = (st: AppState, name: string) => st.sessions.find((s) => s.name === name)!
const selectRow = (st: AppState, name: string): AppState => {
  const list = buildSelectables(st)
  const idx = list.findIndex((x) => x.kind === "row" && x.sessionId === rowOf(st, name).id)
  return { ...st, selectedIndex: idx }
}

describe("filter", () => {
  test("matchesFilter s:/a:/#", () => {
    const s: Session = { ...rowOf(initialState(), "collision detection") }
    expect(matchesFilter(s, "s:working")).toBe(true)
    expect(matchesFilter(s, "s:failed")).toBe(false)
    expect(matchesFilter(s, "a:default")).toBe(true)
    expect(matchesFilter({ ...s, state: "needsInput" }, "s:blocked")).toBe(true)
  })
  test("buildRenderGroups applies active filter", () => {
    let st = initialState()
    st = run(st, ...[..."s:working"].map((ch) => ({ type: "inputChar", ch }) as FsmAction))
    const groups = buildRenderGroups(st).map((g) => g.group)
    expect(groups).toContain("working")
    expect(groups).not.toContain("needsInput")
    expect(groups).not.toContain("completed")
  })
})

describe("dispatch", () => {
  test("too short rejected", () => {
    let st = initialState()
    st = run(st, ...[..."abc"].map((ch) => ({ type: "inputChar", ch }) as FsmAction), { type: "dispatchSubmit" })
    expect(st.hud).toContain("Too short")
    expect(st.sessions.length).toBe(initialState().sessions.length)
  })
  test("dispatch adds a working row and selects it", () => {
    let st = initialState()
    const n0 = st.sessions.length
    st = run(st, ...[..."fix the build"].map((ch) => ({ type: "inputChar", ch }) as FsmAction), { type: "dispatchSubmit" })
    expect(st.sessions.length).toBe(n0 + 1)
    expect(selectedSession(st)?.summary).toBe("fix the build")
  })
  test("! starts a shell job (exempt from min length)", () => {
    let st = initialState()
    st = run(st, ...[..."!ls"].map((ch) => ({ type: "inputChar", ch }) as FsmAction), { type: "dispatchSubmit" })
    const job = st.sessions.find((s) => s.isShell)
    expect(job).toBeTruthy()
    expect(job!.agent).toBe("shell")
    expect(st.hud).toContain("shell job")
  })
})

describe("delete chord", () => {
  test("arm then confirm removes the row", () => {
    let st = selectRow(initialState(), "title screen")
    const id = rowOf(st, "title screen").id
    st = reducer(st, { type: "deleteArm" })
    expect(st.mode).toBe("deleteConfirm")
    expect(st.deleteArmedId).toBe(id)
    st = reducer(st, { type: "deleteConfirm" })
    expect(st.sessions.some((s) => s.id === id)).toBe(false)
    expect(st.hud).toContain("deleted")
  })
  test("disarm keeps the (stopped) row", () => {
    let st = selectRow(initialState(), "title screen")
    st = reducer(st, { type: "deleteArm" })
    st = reducer(st, { type: "deleteDisarm" })
    expect(st.mode).toBe("tableView")
    expect(st.deleteArmedId).toBe(null)
  })
})

describe("selection stability (the drift bug)", () => {
  test("pin keeps selection on the same session, so rename hits it", () => {
    let st = selectRow(initialState(), "collision detection")
    const id = rowOf(st, "collision detection").id
    st = reducer(st, { type: "pinToggle" }) // moves it to Pinned group
    expect(selectedSession(st)?.id).toBe(id) // selection followed the row
    st = reducer(st, { type: "renameStart" })
    st = run(st, ...[..." X"].map((ch) => ({ type: "inputChar", ch }) as FsmAction), { type: "renameCommit" })
    expect(st.sessions.find((s) => s.id === id)!.name).toBe("collision detection X")
  })
})

describe("reorder is real", () => {
  test("Shift+Down swaps order within the group", () => {
    let st = selectRow(initialState(), "collision detection")
    const before = buildSelectables(st).filter((x) => x.kind === "row").map((x) => x.sessionId)
    const id = rowOf(st, "collision detection").id
    st = reducer(st, { type: "reorderSelection", delta: 1 })
    const after = buildSelectables(st).filter((x) => x.kind === "row").map((x) => x.sessionId)
    expect(after).not.toEqual(before)
    expect(selectedSession(st)?.id).toBe(id) // selection follows the moved row
    expect(st.hud).toContain("reordered")
  })
})

describe("answer + attach + theme", () => {
  test("pickOption flips a needsInput session to working", () => {
    let st = selectRow(initialState(), "power-up design")
    st = reducer(st, { type: "peekToggle" })
    st = reducer(st, { type: "pickOption", n: 1 })
    expect(st.sessions.find((s) => s.name === "power-up design")!.state).toBe("working")
  })
  test("attach enters attachedSession", () => {
    let st = selectRow(initialState(), "title screen")
    st = reducer(st, { type: "attach" })
    expect(st.mode).toBe("attachedSession")
    expect(st.attachedId).toBe(rowOf(initialState(), "title screen").id)
  })
  test("themeToggle flips mode", () => {
    let st = initialState()
    expect(st.themeMode).toBe("dark")
    st = reducer(st, { type: "themeToggle" })
    expect(st.themeMode).toBe("light")
  })
})

describe("scenario stepping", () => {
  test("each step advances the cursor and mutates", () => {
    let st = initialState()
    st = reducer(st, { type: "scenarioStep" })
    expect(st.scenarioCursor).toBe(1)
    expect(st.hud).toContain("[1/")
  })
})

describe("session lifecycle reducer", () => {
  test("answer/stop/respawn transitions", () => {
    const seed = initialState().sessions
    const q = seed.find((s) => s.state === "needsInput")!
    expect(applySessionEvent(seed, { type: "answer", id: q.id }).find((s) => s.id === q.id)!.state).toBe("working")
    expect(applySessionEvent(seed, { type: "stop", id: q.id }).find((s) => s.id === q.id)!.state).toBe("stopped")
  })
})

test("selectionKey is stable across a pin", () => {
  let st = selectRow(initialState(), "collision detection")
  const k = selectionKey(st)
  st = reducer(st, { type: "pinToggle" })
  expect(selectionKey(st)).toBe(k)
})
