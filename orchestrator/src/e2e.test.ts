import { test, expect } from "bun:test";
import { createBackend } from "./backend/registry.ts";
import { SessionManager } from "./core/session-manager.ts";
import { FAKE_REPLY } from "./testing/fake-acp-agent.ts";
import type { AgentUpdateEvent } from "./backend/types.ts";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI = new URL("./cli.ts", import.meta.url).pathname;

test("e2e: client drives the fake ACP agent initialize -> session/new -> prompt -> stream -> stopReason", async () => {
  const backend = createBackend({ agent: "fake", cwd: process.cwd() });
  await backend.connect();
  expect(backend.capabilities.loadSession).toBe(false);

  const { sessionId } = await backend.newSession(process.cwd());
  expect(sessionId).toMatch(/^fake-session-/);

  const handle = backend.prompt(sessionId, "hello");
  const chunks: string[] = [];
  for await (const ev of handle.updates) {
    if (ev.kind === "message_chunk" && ev.role === "assistant") chunks.push(ev.text);
  }
  const result = await handle.done;

  expect(chunks.length).toBeGreaterThanOrEqual(2); // streamed, not one blob
  expect(chunks.join("")).toBe(FAKE_REPLY);
  expect(result.stopReason).toBe("end_turn");

  await backend.dispose();
});

test("e2e: SessionManager tracks state busy -> completed and emits chunk events", async () => {
  const mgr = new SessionManager();
  const events: AgentUpdateEvent[] = [];
  mgr.on("session_chunk", (ev: { update: AgentUpdateEvent }) => events.push(ev.update));

  const id = await mgr.createSession({ agent: "fake", cwd: process.cwd() });
  expect(mgr.get(id)?.state).toBe("idle");

  const { message, stopReason } = await mgr.prompt(id, "hi");
  expect(message).toBe(FAKE_REPLY);
  expect(stopReason).toBe("end_turn");
  expect(mgr.get(id)?.state).toBe("completed");
  expect(mgr.get(id)?.lastMessage).toBe(FAKE_REPLY);
  expect(events.some((e) => e.kind === "message_chunk")).toBe(true);

  await mgr.dispose();
});

test("e2e: CLI headless `-p` path streams the assistant text to stdout", async () => {
  // --in-process keeps this hermetic: exercises the headless streaming path
  // without spawning a daemon; an isolated ARCHON_CONFIG_DIR keeps persistence
  // out of the real ~/.archon.
  const cfg = mkdtempSync(join(tmpdir(), "archon-e2e-"));
  const proc = Bun.spawn(["bun", "run", CLI, "-p", "hello", "--agent", "fake", "--in-process"], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ARCHON_CONFIG_DIR: cfg },
  });
  const out = await new Response(proc.stdout).text();
  const code = await proc.exited;
  expect(code).toBe(0);
  expect(out).toContain(FAKE_REPLY);
});

test("e2e: CLI `agents` lists the fake agent as runnable", async () => {
  const proc = Bun.spawn(["bun", "run", CLI, "agents"], { stdout: "pipe" });
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  expect(out).toContain("fake");
  expect(out).toContain("[runnable]");
});

test("e2e: CLI --version", async () => {
  const proc = Bun.spawn(["bun", "run", CLI, "--version"], { stdout: "pipe" });
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  expect(out.trim()).toBe("0.1.0");
});
