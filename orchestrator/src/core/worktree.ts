/**
 * Git-worktree isolation (ADR-0009, default).
 *
 * Goal: before a session makes its FIRST edit, transparently move it into a
 * dedicated git worktree under <repo>/.archon/worktrees/<id> on a fresh branch,
 * so parallel agents never clobber each other's working tree. This mirrors the
 * "isolate background work in a worktree" pattern but is opt-OUT, not opt-in.
 *
 * Behavior:
 *   - Lazy: a worktree is only materialized on the first edit (ensure()), so
 *     read-only / planning sessions never create one.
 *   - Skipped when: bgIsolation === "none" (Claude-style in-place editing),
 *     the cwd is not inside a git repo, or the cwd is already a LINKED worktree
 *     (avoid worktree-of-a-worktree; we use the existing isolation).
 *   - cleanup() removes the worktree (and prunes the branch) via `git worktree remove`.
 *
 * The git surface area is intentionally small (`git` argv via Bun.spawn) and is
 * injectable (`GitRunner`) so unit tests can drive a temp repo or a stub.
 *
 * NOTE: the *pure path* logic (worktreeRoot/worktreePath/branchName/sanitizeId)
 * is exported separately and has no git dependency — that's what the unit tests
 * pin down, alongside a real temp-repo integration test.
 */
import { isAbsolute, join, resolve } from "node:path";
import type { WorktreeConfig } from "../config/types.ts";

/** Minimal git executor: run argv in cwd, return {code, stdout, stderr}. */
export interface GitRunner {
  (args: string[], cwd: string): Promise<{ code: number; stdout: string; stderr: string }>;
}

/** Default GitRunner backed by Bun.spawn("git", ...). */
export const bunGitRunner: GitRunner = async (args, cwd) => {
  const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
};

// --- pure path logic (no git; unit-tested) -------------------------------

/** Sanitize a session id into a filesystem/branch-safe slug. */
export function sanitizeId(id: string): string {
  const slug = id
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "-") // collapse unsafe runs to a single dash
    .replace(/^-+|-+$/g, "") // trim leading/trailing dashes
    .replace(/\.+$/g, ""); // no trailing dots (git refs disallow)
  return slug.length > 0 ? slug : "session";
}

/** Absolute worktrees root for a repo: <repoRoot>/<config.dir> (config.dir may be absolute). */
export function worktreeRoot(repoRoot: string, config: WorktreeConfig): string {
  return isAbsolute(config.dir) ? config.dir : resolve(repoRoot, config.dir);
}

/** Absolute path of a session's worktree. */
export function worktreePath(repoRoot: string, config: WorktreeConfig, id: string): string {
  return join(worktreeRoot(repoRoot, config), sanitizeId(id));
}

/** Branch name for a session's worktree: "<prefix><id>". */
export function branchName(config: WorktreeConfig, id: string): string {
  const prefix = config.branchPrefix ?? "";
  return `${prefix}${sanitizeId(id)}`;
}

// --- git-backed helpers ---------------------------------------------------

/** Resolve the top-level repo root for `cwd`, or null if not in a git repo. */
export async function findRepoRoot(cwd: string, git: GitRunner = bunGitRunner): Promise<string | null> {
  const r = await git(["rev-parse", "--show-toplevel"], cwd);
  if (r.code !== 0) return null;
  const root = r.stdout.trim();
  return root.length > 0 ? root : null;
}

/**
 * Is `cwd` inside a LINKED worktree (not the primary working tree)?
 * `git rev-parse --git-dir` points into ".git/worktrees/<name>" for a linked
 * worktree, vs "<repo>/.git" (or "--is-inside-work-tree" w/ a plain .git) for
 * the primary one.
 */
export async function isLinkedWorktree(cwd: string, git: GitRunner = bunGitRunner): Promise<boolean> {
  const common = await git(["rev-parse", "--git-common-dir"], cwd);
  const gitDir = await git(["rev-parse", "--git-dir"], cwd);
  if (common.code !== 0 || gitDir.code !== 0) return false;
  // In a linked worktree, --git-dir (.../worktrees/<n>) differs from --git-common-dir (.../.git).
  return common.stdout.trim() !== gitDir.stdout.trim();
}

/** A materialized session worktree. */
export interface SessionWorktree {
  /** Absolute path to the worktree's working directory. */
  path: string;
  /** Branch checked out in the worktree. */
  branch: string;
  /** Remove the worktree (and its branch). Idempotent. */
  cleanup(): Promise<void>;
}

export interface EnsureWorktreeOptions {
  /** Session id (becomes the worktree dir + branch suffix). */
  id: string;
  /** The session's original working directory. */
  cwd: string;
  /** Worktree config (bgIsolation / dir / branchPrefix). */
  config: WorktreeConfig;
  /** Injectable git runner (defaults to Bun.spawn git). */
  git?: GitRunner;
}

/**
 * Ensure a worktree exists for the session, creating it on first call.
 * Returns null when isolation is skipped (none / not-a-repo / already-linked),
 * meaning the caller should keep editing in place.
 *
 * Safe to call repeatedly: if the target path already exists it is reused.
 */
export async function ensureWorktree(
  opts: EnsureWorktreeOptions,
): Promise<SessionWorktree | null> {
  const git = opts.git ?? bunGitRunner;
  if (opts.config.bgIsolation === "none") return null;

  const repoRoot = await findRepoRoot(opts.cwd, git);
  if (!repoRoot) return null; // not a git repo -> edit in place
  if (await isLinkedWorktree(opts.cwd, git)) return null; // already isolated

  const path = worktreePath(repoRoot, opts.config, opts.id);
  const branch = branchName(opts.config, opts.id);

  const exists = await dirExists(path);
  if (!exists) {
    // Create a new branch + worktree off the current HEAD.
    const add = await git(["worktree", "add", "-b", branch, path], repoRoot);
    if (add.code !== 0) {
      // Branch may already exist (e.g. retried run) — try checking it out instead.
      const retry = await git(["worktree", "add", path, branch], repoRoot);
      if (retry.code !== 0) {
        throw new Error(
          `git worktree add failed for "${opts.id}": ${add.stderr.trim() || retry.stderr.trim()}`,
        );
      }
    }
  }

  let cleaned = false;
  return {
    path,
    branch,
    cleanup: async () => {
      if (cleaned) return;
      cleaned = true;
      // --force: drop even with uncommitted changes (the session owns this tree).
      await git(["worktree", "remove", "--force", path], repoRoot);
      // Best-effort branch delete; ignore failure (e.g. merged/checked-out elsewhere).
      await git(["branch", "-D", branch], repoRoot);
    },
  };
}

async function dirExists(path: string): Promise<boolean> {
  try {
    const st = await Bun.file(join(path, ".git")).exists();
    if (st) return true;
    // A worktree dir contains a ".git" file; if the dir exists but no .git, treat as absent.
    return false;
  } catch {
    return false;
  }
}
