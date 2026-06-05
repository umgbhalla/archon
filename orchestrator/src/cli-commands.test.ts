import { test, expect, afterEach } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI = new URL("./cli.ts", import.meta.url).pathname;

/** Config dirs created during tests; daemons there are stopped + dirs reused. */
const dirsToClean: string[] = [];

function isolatedDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "archon-cli-"));
  dirsToClean.push(dir);
  return dir;
}

function run(args: string[], env: Record<string, string> = {}) {
  return Bun.spawn(["bun", "run", CLI, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...env },
  });
}

async function out(proc: ReturnType<typeof run>) {
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;
  return { stdout, stderr, code };
}

// Stop any daemons auto-started under isolated config dirs so tests don't leak procs.
afterEach(async () => {
  for (const dir of dirsToClean.splice(0)) {
    await out(run(["daemon", "stop"], { ARCHON_CONFIG_DIR: dir }));
  }
});

test("agents list shows built-in claude/gemini/generic with capability notes", async () => {
  const { stdout, code } = await out(run(["agents"]));
  expect(code).toBe(0);
  for (const n of ["claude", "gemini", "generic", "fake"]) expect(stdout).toContain(n);
  expect(stdout).toContain("session modes"); // claude note
});

test("agents --json emits structured registry", async () => {
  const { stdout, code } = await out(run(["agents", "--json"]));
  expect(code).toBe(0);
  const parsed = JSON.parse(stdout);
  expect(Array.isArray(parsed)).toBe(true);
  expect(parsed.find((a: { name: string }) => a.name === "claude")).toBeTruthy();
});

test("agents add then list shows the config agent; remove drops it", async () => {
  const dir = isolatedDir();
  const env = { ARCHON_CONFIG_DIR: dir };

  const add = await out(run(["agents", "add", "zed", "--", "npx", "@zed-industries/claude-code-acp"], env));
  expect(add.code).toBe(0);
  expect(add.stdout).toContain('Added agent "zed"');

  const list = await out(run(["agents"], env));
  expect(list.stdout).toContain("zed");
  expect(list.stdout).toContain("(config)");

  const rm = await out(run(["agents", "remove", "zed"], env));
  expect(rm.code).toBe(0);
  const list2 = await out(run(["agents"], env));
  expect(list2.stdout).not.toContain("zed ");
});

test("ls --json returns an empty sessions array on a fresh daemon", async () => {
  const env = { ARCHON_CONFIG_DIR: isolatedDir() };
  const { stdout, code } = await out(run(["ls", "--json"], env));
  expect(code).toBe(0);
  expect(JSON.parse(stdout)).toEqual({ sessions: [] });
});

test("attach/stop require an id and report unknown sessions", async () => {
  const env = { ARCHON_CONFIG_DIR: isolatedDir() };
  const noId = await out(run(["attach"], env));
  expect(noId.code).toBe(2);
  expect(noId.stderr).toContain("usage: archon attach <id>");

  const withId = await out(run(["stop", "sess-123"], env));
  expect(withId.code).toBe(1);
  expect(withId.stderr).toContain("sess-123");
});
