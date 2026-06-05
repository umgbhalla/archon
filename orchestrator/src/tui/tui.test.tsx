/**
 * TUI integration test — drives the session-grid against a REAL SessionManager
 * + the bundled fake ACP agent (no creds). Proves the dispatch path: type a
 * task, Enter creates a real session, the fake agent's chunks stream into the
 * grid, and attach/detach navigate the fullscreen view.
 *
 * Mount/step pattern adapted from context/ghui/test/scrolling.test.tsx:
 * IS_REACT_ACT_ENVIRONMENT + act() + repeated renderOnce() passes.
 */
import { afterEach, beforeAll, expect, test } from "bun:test";
import { act } from "react";
import { createTestRenderer } from "@opentui/core/testing";
import { createRoot } from "@opentui/react";
import { SessionManager } from "../core/session-manager.ts";
import { App } from "./App.tsx";
import { buildRenderGroups } from "./store.ts";

beforeAll(() => {
  // @ts-expect-error — React test-env flag
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  // Async manager events (ACP stream) fire setState outside our act() windows;
  // that "not wrapped in act" warning is benign here (correctness is asserted on
  // captured frames). Suppress just that one message (ghui does the same).
  const orig = console.error;
  console.error = (...args: unknown[]) => {
    if (typeof args[0] === "string" && args[0].includes("was not wrapped in act")) return;
    orig(...args);
  };
});

let live: SessionManager | null = null;
afterEach(async () => {
  if (live) await live.dispose();
  live = null;
});

type Setup = Awaited<ReturnType<typeof createTestRenderer>>;

async function step(setup: Setup): Promise<void> {
  await act(async () => {
    await setup.renderOnce();
    await new Promise<void>((r) => setTimeout(r, 2));
  });
}

async function settle(setup: Setup, predicate: () => boolean, attempts = 120): Promise<boolean> {
  for (let i = 0; i < attempts; i++) {
    await step(setup);
    if (predicate()) return true;
  }
  return false;
}

async function mount(manager: SessionManager): Promise<Setup> {
  const setup = await createTestRenderer({ width: 100, height: 30 });
  act(() => {
    createRoot(setup.renderer).render(<App manager={manager} agent="fake" cwd={process.cwd()} />);
  });
  await settle(setup, () => setup.captureCharFrame().includes("archon"));
  return setup;
}

test("dispatch creates a real session and streams the fake agent reply into the grid", async () => {
  const manager = new SessionManager();
  live = manager;
  const setup = await mount(manager);

  expect(setup.captureCharFrame()).toContain("No sessions yet");

  await act(async () => {
    await setup.mockInput.typeText("hello");
  });
  await settle(setup, () => setup.captureCharFrame().includes("hello"));
  expect(setup.captureCharFrame()).toContain("hello");

  await act(async () => {
    await setup.mockInput.pressKeys(["RETURN"]);
  });

  const done = await settle(
    setup,
    () => setup.captureCharFrame().includes("Completed"),
  );
  expect(done).toBe(true);

  const session = manager.snapshot().sessions[0]!;
  expect(session.agent).toBe("fake");
  expect(session.lastMessage).toContain("Hello from the fake ACP agent!");

  const groups = buildRenderGroups(manager.snapshot().sessions);
  expect(groups.length).toBe(1);
  expect(groups[0]!.group).toBe("completed");

  const frame = setup.captureCharFrame();
  expect(frame).toContain("Completed");
  expect(frame).not.toContain("No sessions yet");
});

test("attach shows the fullscreen view; detach returns to the grid", async () => {
  const manager = new SessionManager();
  live = manager;
  const setup = await mount(manager);

  await act(async () => {
    await setup.mockInput.typeText("hi");
  });
  await settle(setup, () => setup.captureCharFrame().includes("hi"));
  await act(async () => {
    await setup.mockInput.pressKeys(["RETURN"]);
  });
  const created = await settle(setup, () => manager.snapshot().sessions[0]?.state === "completed");
  expect(created).toBe(true);

  // move selection onto the row (past the group header) and let it commit ...
  await act(async () => {
    await setup.mockInput.pressKeys(["ARROW_DOWN"]);
  });
  for (let i = 0; i < 4; i++) await step(setup);
  // ... then attach in a separate frame so the selection update has committed.
  await act(async () => {
    await setup.mockInput.pressKeys(["RETURN"]);
  });
  await settle(setup, () => setup.captureCharFrame().includes("attached"));

  const attached = setup.captureCharFrame();
  expect(attached).toContain("attached");
  expect(attached).toContain("send a prompt to this session");

  // detach with Escape -> back to the grid
  await act(async () => {
    await setup.mockInput.pressKeys(["ESCAPE"]);
  });
  await settle(setup, () => setup.captureCharFrame().includes("Completed"));
  expect(setup.captureCharFrame()).toContain("Completed");
});

// ── store unit tests (pure, no renderer) ──────────────────────────────────────
import {
  applyFilter,
  initialUiState,
  reducer,
  selectedSelectable,
} from "./store.ts";
import { HELP_SECTIONS } from "./keymap.ts";
import type { SessionSnapshot } from "../core/session-manager.ts";

function snap(id: string, state: SessionSnapshot["state"]): SessionSnapshot {
  const now = Date.now();
  return { id, agent: "fake", cwd: "/tmp", state, lastMessage: "", createdAt: now, updatedAt: now };
}

test("applyFilter keeps only waiting sessions when filterWaiting is on", () => {
  const sessions = [snap("a", "completed"), snap("b", "waiting"), snap("c", "busy")];
  expect(applyFilter(sessions, false)).toHaveLength(3);
  const filtered = applyFilter(sessions, true);
  expect(filtered).toHaveLength(1);
  expect(filtered[0]!.id).toBe("b");
});

test("toggleFilter flips filterWaiting and clears a pending delete-arm", () => {
  let s = initialUiState();
  s = reducer(s, { type: "stopArm", id: "x" });
  expect(s.deleteArmedId).toBe("x");
  s = reducer(s, { type: "toggleFilter" });
  expect(s.filterWaiting).toBe(true);
  expect(s.deleteArmedId).toBeNull();
  s = reducer(s, { type: "toggleFilter" });
  expect(s.filterWaiting).toBe(false);
});

test("toggleHelp round-trips and remembers the mode it overlaid", () => {
  let s = initialUiState();
  s = { ...s, mode: "attached", attachedId: "z" };
  s = reducer(s, { type: "toggleHelp" });
  expect(s.mode).toBe("help");
  expect(s.helpReturnMode).toBe("attached");
  s = reducer(s, { type: "toggleHelp" });
  expect(s.mode).toBe("attached");
});

test("stopArm then reconcileSelection disarms when the armed session vanishes", () => {
  const before = [snap("a", "completed"), snap("b", "stopped")];
  let s = initialUiState();
  s = reducer(s, { type: "stopArm", id: "b" });
  // session b removed → reconcile should disarm
  s = reducer(s, { type: "reconcileSelection", sessions: [snap("a", "completed")] });
  expect(s.deleteArmedId).toBeNull();
});

test("HELP_SECTIONS is non-empty and documents the core fleet keys", () => {
  const flat = HELP_SECTIONS.flatMap((sec) => sec.rows.map((r) => `${r.keys} ${r.action}`)).join(" | ");
  expect(HELP_SECTIONS.length).toBeGreaterThan(0);
  expect(flat).toContain("Ctrl+X");
  expect(flat.toLowerCase()).toContain("need input");
  expect(flat).toContain("?");
});

// ── interaction tests (renderer) ──────────────────────────────────────────────

async function dispatchOne(setup: Setup, text: string): Promise<void> {
  await act(async () => {
    await setup.mockInput.typeText(text);
  });
  await settle(setup, () => setup.captureCharFrame().includes(text));
  await act(async () => {
    await setup.mockInput.pressKeys(["RETURN"]);
  });
}

test("? opens the help overlay and Esc dismisses it", async () => {
  const manager = new SessionManager();
  live = manager;
  const setup = await mount(manager);

  await act(async () => {
    await setup.mockInput.typeText("?");
  });
  const shown = await settle(setup, () => setup.captureCharFrame().includes("Keyboard shortcuts"));
  expect(shown).toBe(true);
  const help = setup.captureCharFrame();
  expect(help).toContain("Keyboard shortcuts");
  expect(help).toContain("Ctrl+X");

  await act(async () => {
    await setup.mockInput.pressKeys(["ESCAPE"]);
  });
  const closed = await settle(setup, () => !setup.captureCharFrame().includes("Keyboard shortcuts"));
  expect(closed).toBe(true);
});

test("w toggles the needs-input filter badge", async () => {
  const manager = new SessionManager();
  live = manager;
  const setup = await mount(manager);

  await act(async () => {
    await setup.mockInput.typeText("w");
  });
  const on = await settle(setup, () => setup.captureCharFrame().includes("filter: needs-input"));
  expect(on).toBe(true);
  // empty filtered grid copy
  expect(setup.captureCharFrame()).toContain("No sessions need input");

  await act(async () => {
    await setup.mockInput.typeText("w");
  });
  const off = await settle(setup, () => !setup.captureCharFrame().includes("filter: needs-input"));
  expect(off).toBe(true);
});

test("Ctrl+X arms a delete on a selected session, second Ctrl+X removes it", async () => {
  const manager = new SessionManager();
  live = manager;
  const setup = await mount(manager);

  await dispatchOne(setup, "hi");
  const created = await settle(setup, () => manager.snapshot().sessions[0]?.state === "completed");
  expect(created).toBe(true);

  // move onto the row (past the group header), let selection commit.
  await act(async () => {
    await setup.mockInput.pressKeys(["ARROW_DOWN"]);
  });
  for (let i = 0; i < 4; i++) await step(setup);

  const id = manager.snapshot().sessions[0]!.id;

  // first Ctrl+X → stop + arm
  await act(async () => {
    setup.mockInput.pressKey("x", { ctrl: true });
  });
  const armed = await settle(setup, () => setup.captureCharFrame().includes("again within 2s to"));
  expect(armed).toBe(true);

  // second Ctrl+X → delete (manager loses the session)
  await act(async () => {
    setup.mockInput.pressKey("x", { ctrl: true });
  });
  const gone = await settle(setup, () => !manager.snapshot().sessions.some((s) => s.id === id));
  expect(gone).toBe(true);
  expect(manager.snapshot().sessions).toHaveLength(0);
});
