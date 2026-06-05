import { test, expect, afterEach } from "bun:test";
import { mkdtempSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DaemonServer } from "./server.ts";
import { connectDaemon, type DaemonClient } from "./client.ts";
import { FilePersistence, daemonPaths } from "./persistence.ts";
import { SessionManager } from "../core/session-manager.ts";
import { FAKE_REPLY, FAKE_ALLOW_OPTION } from "../testing/fake-acp-agent.ts";
import type { PromptStreamEvent } from "./protocol.ts";
import type { SessionSnapshot } from "../core/session-manager.ts";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

function tmpConfigDir(): string {
  return mkdtempSync(join(tmpdir(), "archon-daemon-"));
}

async function startServer(configDir: string, manager?: SessionManager): Promise<DaemonServer> {
  const server = new DaemonServer({ configDir, manager });
  await server.start();
  cleanups.push(() => server.stop());
  return server;
}

test("daemon round-trip: start -> createSession(fake) -> prompt -> stream -> stop", async () => {
  const configDir = tmpConfigDir();
  const server = await startServer(configDir);

  const client = await connectDaemon({ configDir });
  cleanups.push(() => client.close());

  const hs = await client.handshake();
  expect(hs.protocolVersion).toBeGreaterThan(0);

  const id = await client.createSession({ agent: "fake", cwd: configDir });
  expect(id).toMatch(/^fake-session-/);

  // session shows up cross-"invocation" (a fresh listSessions call).
  const list = await client.listSessions();
  expect(list.some((s) => s.id === id)).toBe(true);

  const chunks: string[] = [];
  let finalState = "";
  const res = await client.prompt(id, "hello", (ev: PromptStreamEvent) => {
    if (ev.kind === "chunk" && ev.update.kind === "message_chunk" && ev.update.role === "assistant") {
      chunks.push(ev.update.text);
    } else if (ev.kind === "state") {
      finalState = ev.session.state;
    }
  });

  expect(chunks.length).toBeGreaterThanOrEqual(2); // streamed, not one blob
  expect(chunks.join("")).toBe(FAKE_REPLY);
  expect(res.message).toBe(FAKE_REPLY);
  expect(res.stopReason).toBe("end_turn");
  expect(finalState).toBe("completed");

  // logs returns the persisted transcript.
  const logs = await client.logs(id);
  expect(logs.transcript).toBe(FAKE_REPLY);

  // stop (remove) drops it from the roster.
  await client.stop(id, true);
  const after = await client.listSessions();
  expect(after.some((s) => s.id === id)).toBe(false);

  void server;
});

test("daemon round-trip: entries + pendingPermission travel over the wire; answerPermission resolves", async () => {
  const configDir = tmpConfigDir();
  await startServer(configDir);

  const client = await connectDaemon({ configDir });
  cleanups.push(() => client.close());

  const id = await client.createSession({ agent: "fake", cwd: configDir });

  // attach: live snapshots (with entries + pendingPermission) stream over the wire.
  let latest: SessionSnapshot | undefined;
  let sawPending = false;
  await client.attach((ev) => {
    if (ev.type === "permission_requested" && ev.id === id) {
      sawPending = true;
      latest = ev.session;
      // the snapshot carried the pending permission over the wire.
      expect(ev.session.pendingPermission?.options.some((o) => o.optionId === FAKE_ALLOW_OPTION)).toBe(true);
      // answer it remotely.
      void client.answerPermission(id, FAKE_ALLOW_OPTION);
    } else if (ev.type === "session_updated" && ev.session.id === id) {
      latest = ev.session;
    }
  });

  // enable interactive handling on the daemon, then prompt with the edit trigger.
  await client.setInteractive(id, true);
  const res = await client.prompt(id, "please edit something");
  // let the trailing attach updates flush.
  await new Promise((r) => setTimeout(r, 50));

  expect(sawPending).toBe(true);
  expect(res.stopReason).toBe("end_turn");
  // entries arrived over the wire and include a completed tool_call.
  expect(latest?.entries.some((e) => e.kind === "user")).toBe(true);
  const tc = latest?.entries.find((e) => e.kind === "tool_call") as { status?: string } | undefined;
  expect(tc?.status).toBe("completed");
}, 20000);

test("socket is owner-only (0600)", async () => {
  const configDir = tmpConfigDir();
  const server = await startServer(configDir);
  const { socketPath } = daemonPaths(configDir);
  const st = await stat(socketPath);
  // mask perm bits; expect rw for owner only.
  expect(st.mode & 0o777).toBe(0o600);
  void server;
});

test("client auto-start: connectDaemon spawns a daemon when none is running", async () => {
  const configDir = tmpConfigDir();
  const client = await connectDaemon({ configDir, startTimeoutMs: 8000 });
  cleanups.push(async () => {
    await client.shutdownDaemon();
    client.close();
  });

  const hs = await client.handshake();
  // a real spawned daemon has a non-"in-process" version + a live pid file.
  expect(hs.daemonVersion).not.toBe("in-process");
  const pid = await readFile(daemonPaths(configDir).pidPath, "utf8");
  expect(Number(pid.trim())).toBe(hs.pid);

  const id = await client.createSession({ agent: "fake", cwd: configDir });
  const res = await client.prompt(id, "hi");
  expect(res.message).toBe(FAKE_REPLY);
}, 20000);

test("persistence reload: a fresh manager.restore() recovers the roster from disk", async () => {
  const configDir = tmpConfigDir();
  const { stateDir } = daemonPaths(configDir);

  // First "daemon": create a session + prompt it (writes roster.json + transcript),
  // then shut down WITHOUT purging persistence (what DaemonServer.stop does).
  const mgr1 = new SessionManager({ persistence: new FilePersistence(stateDir) });
  const id = await mgr1.createSession({ agent: "fake", cwd: configDir });
  await mgr1.prompt(id, "hello");
  await mgr1.dispose({ purge: false });

  // roster.json survived with the session.
  const roster = JSON.parse(await readFile(join(stateDir, "roster.json"), "utf8"));
  expect(roster.sessions.some((s: { snapshot: { id: string } }) => s.snapshot.id === id)).toBe(true);

  // New manager (simulated restart) recovers the session from disk.
  const mgr2 = new SessionManager({ persistence: new FilePersistence(stateDir) });
  const recovered = await mgr2.restore();
  expect(recovered).toContain(id);
  const snap = mgr2.get(id);
  expect(snap).toBeTruthy();
  expect(snap?.lastMessage).toBe(FAKE_REPLY);
  // transcript persisted across the restart.
  expect(await mgr2.transcript(id)).toBe(FAKE_REPLY);
  // recovered session is re-promptable.
  const res = await mgr2.prompt(id, "again");
  expect(res.message).toBe(FAKE_REPLY);
  await mgr2.dispose();
}, 20000);

test("in-process fallback client works without a socket", async () => {
  const configDir = tmpConfigDir();
  const mgr = new SessionManager();
  const client: DaemonClient = await connectDaemon({ inProcess: true, manager: mgr, configDir });
  const hs = await client.handshake();
  expect(hs.daemonVersion).toBe("in-process");
  const id = await client.createSession({ agent: "fake", cwd: configDir });
  const res = await client.prompt(id, "hi");
  expect(res.message).toBe(FAKE_REPLY);
  await mgr.dispose();
});

test("attach streams session events to a connected client", async () => {
  const configDir = tmpConfigDir();
  await startServer(configDir);
  const client = await connectDaemon({ configDir });
  cleanups.push(() => client.close());

  const events: string[] = [];
  await client.attach((ev) => events.push(ev.type));

  const id = await client.createSession({ agent: "fake", cwd: configDir });
  await client.prompt(id, "hi");
  // give the stream a tick to flush.
  await new Promise((r) => setTimeout(r, 50));

  expect(events).toContain("session_created");
  expect(events).toContain("session_chunk");
  expect(events).toContain("session_updated");
});
