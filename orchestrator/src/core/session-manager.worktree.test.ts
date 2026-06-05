import { test, expect, afterAll } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "./session-manager.ts";
import { bunGitRunner } from "./worktree.ts";
import { DEFAULT_WORKTREE_CONFIG } from "../config/types.ts";

const cleanups: Array<() => Promise<void>> = [];
afterAll(async () => {
  for (const c of cleanups) await c().catch(() => {});
});

async function makeRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "archon-mgr-wt-"));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  const run = async (args: string[]) => {
    const r = await bunGitRunner(args, dir);
    if (r.code !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  };
  await run(["init", "-q", "-b", "main"]);
  await run(["config", "user.email", "t@t.test"]);
  await run(["config", "user.name", "Test"]);
  await Bun.write(join(dir, "README.md"), "# temp\n");
  await run(["add", "."]);
  await run(["commit", "-q", "-m", "init"]);
  return dir;
}

test("SessionManager.ensureWorktree: creates worktree, swaps cwd, snapshot exposes path, remove cleans up", async () => {
  const repo = await makeRepo();
  const mgr = new SessionManager(); // default worktree config (ADR-0009)
  const id = await mgr.createSession({ agent: "fake", cwd: repo });

  expect(mgr.get(id)?.cwd).toBe(repo);
  expect(mgr.get(id)?.worktreePath).toBeUndefined();

  const wtPath = await mgr.ensureWorktree(id);
  expect(wtPath).toBeDefined();
  expect(wtPath).toContain(join(".archon", "worktrees"));
  // session cwd now points at the worktree; snapshot reflects it
  expect(mgr.get(id)?.cwd).toBe(wtPath!);
  expect(mgr.get(id)?.worktreePath).toBe(wtPath!);

  // idempotent: second call returns the same path, no error
  expect(await mgr.ensureWorktree(id)).toBe(wtPath!);

  const listed = await bunGitRunner(["worktree", "list"], repo);
  expect(listed.stdout).toContain(wtPath!);

  await mgr.remove(id);
  const after = await bunGitRunner(["worktree", "list"], repo);
  expect(after.stdout).not.toContain(wtPath!);
});

test("SessionManager: worktree.bgIsolation 'none' disables isolation (Claude-style)", async () => {
  const repo = await makeRepo();
  const mgr = new SessionManager({
    worktree: { ...DEFAULT_WORKTREE_CONFIG, bgIsolation: "none" },
  });
  const id = await mgr.createSession({ agent: "fake", cwd: repo });
  const wtPath = await mgr.ensureWorktree(id);
  expect(wtPath).toBeUndefined();
  expect(mgr.get(id)?.cwd).toBe(repo); // unchanged
  await mgr.remove(id);
});

test("SessionManager: per-session worktree config overrides manager default", async () => {
  const repo = await makeRepo();
  const mgr = new SessionManager(); // default = worktree on
  const id = await mgr.createSession({
    agent: "fake",
    cwd: repo,
    worktree: { ...DEFAULT_WORKTREE_CONFIG, bgIsolation: "none" },
  });
  expect(await mgr.ensureWorktree(id)).toBeUndefined();
  await mgr.remove(id);
});

test("SessionManager: not a git repo -> no worktree, edits in place", async () => {
  const non = await mkdtemp(join(tmpdir(), "archon-mgr-nonrepo-"));
  cleanups.push(() => rm(non, { recursive: true, force: true }));
  const mgr = new SessionManager();
  const id = await mgr.createSession({ agent: "fake", cwd: non });
  expect(await mgr.ensureWorktree(id)).toBeUndefined();
  expect(mgr.get(id)?.cwd).toBe(non);
  await mgr.remove(id);
});
