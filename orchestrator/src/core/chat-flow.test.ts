import { test, expect } from "bun:test";
import { SessionManager } from "./session-manager.ts";
import {
  FAKE_REPLY,
  FAKE_ALLOW_OPTION,
  FAKE_REJECT_OPTION,
  FAKE_TOOL_CALL_ID,
} from "../testing/fake-acp-agent.ts";

test("structured entries grow + stream over a normal turn", async () => {
  const mgr = new SessionManager();
  const id = await mgr.createSession({ agent: "fake", cwd: process.cwd() });

  await mgr.prompt(id, "hello");
  const snap = mgr.get(id)!;
  // user entry + assistant entry.
  const kinds = snap.entries.map((e) => e.kind);
  expect(kinds).toContain("user");
  expect(kinds).toContain("assistant");
  const asst = snap.entries.find((e) => e.kind === "assistant") as { text: string; streaming: boolean };
  expect(asst.text).toBe(FAKE_REPLY);
  expect(asst.streaming).toBe(false); // finalized at turn end

  await mgr.dispose();
});

test("multi-turn appends user+assistant turns to the same conversation", async () => {
  const mgr = new SessionManager();
  const id = await mgr.createSession({ agent: "fake", cwd: process.cwd() });

  await mgr.prompt(id, "first");
  await mgr.prompt(id, "second");

  const snap = mgr.get(id)!;
  const users = snap.entries.filter((e) => e.kind === "user") as { text: string }[];
  const assts = snap.entries.filter((e) => e.kind === "assistant");
  expect(users.map((u) => u.text)).toEqual(["first", "second"]);
  expect(assts).toHaveLength(2);

  await mgr.dispose();
});

test("interactive permission: resolver fires, snapshot exposes pendingPermission, allow lets the turn complete", async () => {
  const mgr = new SessionManager();
  const id = await mgr.createSession({ agent: "fake", cwd: process.cwd() });
  mgr.setInteractive(id, true);

  let sawPending = false;
  mgr.on("permission_requested", (ev: { id: string; session: { pendingPermission?: unknown } }) => {
    if (ev.id !== id) return;
    sawPending = true;
    const pending = mgr.get(id)!.pendingPermission!;
    expect(pending.toolTitle).toContain("Edit");
    expect(pending.options.map((o) => o.optionId)).toContain(FAKE_ALLOW_OPTION);
    // session is waiting while the answer is pending.
    expect(mgr.get(id)!.state).toBe("waiting");
    // answer on the next tick (simulates the UI).
    queueMicrotask(() => mgr.answerPermission(id, FAKE_ALLOW_OPTION));
  });

  const res = await mgr.prompt(id, "please edit the file");
  expect(sawPending).toBe(true);
  expect(res.stopReason).toBe("end_turn");
  expect(res.message).toBe(FAKE_REPLY);

  const snap = mgr.get(id)!;
  expect(snap.pendingPermission).toBeUndefined();
  // tool_call entry exists and completed.
  const tc = snap.entries.find((e) => e.kind === "tool_call") as { toolCallId: string; status?: string };
  expect(tc.toolCallId).toBe(FAKE_TOOL_CALL_ID);
  expect(tc.status).toBe("completed");

  await mgr.dispose();
});

test("interactive permission: rejecting marks the tool_call failed", async () => {
  const mgr = new SessionManager();
  const id = await mgr.createSession({ agent: "fake", cwd: process.cwd() });
  mgr.setInteractive(id, true);

  mgr.on("permission_requested", (ev: { id: string }) => {
    if (ev.id === id) queueMicrotask(() => mgr.answerPermission(id, FAKE_REJECT_OPTION));
  });

  await mgr.prompt(id, "edit it");
  const tc = mgr.get(id)!.entries.find((e) => e.kind === "tool_call") as { status?: string };
  expect(tc.status).toBe("failed");

  await mgr.dispose();
});

test("without an interactive resolver, the headless mode policy auto-resolves", async () => {
  // acceptEdits picks the first allow option -> tool completes, no waiting state.
  const mgr = new SessionManager();
  const id = await mgr.createSession({
    agent: "fake",
    cwd: process.cwd(),
    permissionMode: "acceptEdits",
  });

  let waited = false;
  mgr.on("session_updated", (ev: { session: { id: string; state: string } }) => {
    if (ev.session.id === id && ev.session.state === "waiting") waited = true;
  });

  const res = await mgr.prompt(id, "edit it");
  expect(res.stopReason).toBe("end_turn");
  expect(waited).toBe(false); // never blocked on a human
  const tc = mgr.get(id)!.entries.find((e) => e.kind === "tool_call") as { status?: string };
  expect(tc.status).toBe("completed");

  await mgr.dispose();
});
