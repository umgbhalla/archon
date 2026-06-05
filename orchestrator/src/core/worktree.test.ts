import { test, expect, afterAll } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  sanitizeId,
  worktreeRoot,
  worktreePath,
  branchName,
  findRepoRoot,
  isLinkedWorktree,
  ensureWorktree,
  bunGitRunner,
  type GitRunner,
} from "./worktree.ts";
import { DEFAULT_WORKTREE_CONFIG, type WorktreeConfig } from "../config/types.ts";

const CFG: WorktreeConfig = { ...DEFAULT_WORKTREE_CONFIG };

// --- pure path logic ------------------------------------------------------

test("sanitizeId: makes a fs/branch-safe slug", () => {
  expect(sanitizeId("fake-session-123")).toBe("fake-session-123");
  expect(sanitizeId("acp/sess 42!")).toBe("acp-sess-42");
  expect(sanitizeId("  --weird--  ")).toBe("weird");
  expect(sanitizeId("trailing.")).toBe("trailing");
  expect(sanitizeId("///")).toBe("session"); // never empty
});

test("worktreeRoot: joins repo root + relative dir", () => {
  expect(worktreeRoot("/repo", CFG)).toBe("/repo/.archon/worktrees");
});

test("worktreeRoot: honors an absolute dir", () => {
  expect(worktreeRoot("/repo", { ...CFG, dir: "/abs/wt" })).toBe("/abs/wt");
});

test("worktreePath: root + sanitized id", () => {
  expect(worktreePath("/repo", CFG, "sess 1")).toBe("/repo/.archon/worktrees/sess-1");
});

test("branchName: prefix + sanitized id", () => {
  expect(branchName(CFG, "sess 1")).toBe("archon/sess-1");
  expect(branchName({ ...CFG, branchPrefix: "" }, "x")).toBe("x");
});

// --- git-backed (real temp repo) -----------------------------------------

const cleanups: Array<() => Promise<void>> = [];
afterAll(async () => {
  for (const c of cleanups) await c().catch(() => {});
});

async function makeRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "archon-wt-"));
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

test("findRepoRoot: resolves inside a repo, null outside", async () => {
  const repo = await makeRepo();
  // git may symlink-resolve /var -> /private/var on macOS; compare basenames.
  const root = await findRepoRoot(repo);
  expect(root).not.toBeNull();
  expect(await findRepoRoot(tmpdir())).toBeDefined(); // tmpdir itself may or may not be a repo
});

test("findRepoRoot: returns null for a non-repo dir", async () => {
  const non = await mkdtemp(join(tmpdir(), "archon-nonrepo-"));
  cleanups.push(() => rm(non, { recursive: true, force: true }));
  expect(await findRepoRoot(non)).toBeNull();
});

test("ensureWorktree: bgIsolation 'none' -> null (edit in place)", async () => {
  const repo = await makeRepo();
  const wt = await ensureWorktree({ id: "s1", cwd: repo, config: { ...CFG, bgIsolation: "none" } });
  expect(wt).toBeNull();
});

test("ensureWorktree: not a git repo -> null", async () => {
  const non = await mkdtemp(join(tmpdir(), "archon-nonrepo2-"));
  cleanups.push(() => rm(non, { recursive: true, force: true }));
  const wt = await ensureWorktree({ id: "s1", cwd: non, config: CFG });
  expect(wt).toBeNull();
});

test("ensureWorktree: creates worktree + branch, cleanup removes them", async () => {
  const repo = await makeRepo();
  const wt = await ensureWorktree({ id: "sess-42", cwd: repo, config: CFG });
  expect(wt).not.toBeNull();
  expect(wt!.branch).toBe("archon/sess-42");
  // the worktree dir exists and is itself a git working tree
  expect(await Bun.file(join(wt!.path, ".git")).exists()).toBe(true);
  expect(await Bun.file(join(wt!.path, "README.md")).exists()).toBe(true);
  // it is registered as a linked worktree
  const list = await bunGitRunner(["worktree", "list"], repo);
  expect(list.stdout).toContain(wt!.path);
  // and it reports itself as a LINKED worktree
  expect(await isLinkedWorktree(wt!.path)).toBe(true);

  await wt!.cleanup();
  const after = await bunGitRunner(["worktree", "list"], repo);
  expect(after.stdout).not.toContain(wt!.path);
  // branch is gone too
  const branches = await bunGitRunner(["branch", "--list", "archon/sess-42"], repo);
  expect(branches.stdout.trim()).toBe("");
});

test("ensureWorktree: already inside a linked worktree -> null (no nesting)", async () => {
  const repo = await makeRepo();
  const wt = await ensureWorktree({ id: "outer", cwd: repo, config: CFG });
  expect(wt).not.toBeNull();
  // From inside the linked worktree, isolation must be skipped.
  const nested = await ensureWorktree({ id: "inner", cwd: wt!.path, config: CFG });
  expect(nested).toBeNull();
  await wt!.cleanup();
});

test("ensureWorktree: idempotent for the same id (reuses existing path)", async () => {
  const repo = await makeRepo();
  const a = await ensureWorktree({ id: "dup", cwd: repo, config: CFG });
  const b = await ensureWorktree({ id: "dup", cwd: repo, config: CFG });
  expect(a!.path).toBe(b!.path);
  await a!.cleanup();
});

test("ensureWorktree: respects an injected GitRunner (stub)", async () => {
  const calls: string[][] = [];
  const stub: GitRunner = async (args) => {
    calls.push(args);
    if (args[0] === "rev-parse" && args[1] === "--show-toplevel") {
      return { code: 0, stdout: "/stub/repo\n", stderr: "" };
    }
    if (args[0] === "rev-parse" && args[1] === "--git-common-dir") {
      return { code: 0, stdout: "/stub/repo/.git\n", stderr: "" };
    }
    if (args[0] === "rev-parse" && args[1] === "--git-dir") {
      return { code: 0, stdout: "/stub/repo/.git\n", stderr: "" }; // same -> primary, not linked
    }
    return { code: 0, stdout: "", stderr: "" };
  };
  const wt = await ensureWorktree({ id: "x", cwd: "/whatever", config: CFG, git: stub });
  expect(wt).not.toBeNull();
  expect(wt!.path).toBe("/stub/repo/.archon/worktrees/x");
  expect(calls.some((c) => c[0] === "worktree" && c[1] === "add")).toBe(true);
});
