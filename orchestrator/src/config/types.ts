import type { PermissionMode } from "../backend/types.ts";

/** How sessions isolate filesystem writes (ADR-0009). */
export type WorktreeIsolation =
  /** Create a git worktree under .archon/worktrees/<id> before the first edit. */
  | "worktree"
  /** Never create a worktree; sessions edit the cwd in place (Claude-style). */
  | "none";

export const WORKTREE_ISOLATION_MODES: WorktreeIsolation[] = ["worktree", "none"];

/** Git-worktree isolation settings (ADR-0009). */
export interface WorktreeConfig {
  /**
   * Background-isolation mode. "worktree" (default) lazily creates a linked
   * git worktree per session before its first edit; "none" disables it
   * (sessions then edit the cwd in place, Claude-style).
   */
  bgIsolation: WorktreeIsolation;
  /** Worktrees root, relative to the repo root. Default ".archon/worktrees". */
  dir: string;
  /** Branch-name prefix for created worktrees. Default "archon/". */
  branchPrefix: string;
}

/** Resolved archon settings (Claude-Code-like). */
export interface ArchonConfig {
  defaultAgent: string;
  defaultModel?: string;
  permissionMode: PermissionMode;
  /** Extra named agent commands merged into the registry, keyed by name -> argv. */
  agents?: Record<string, string[]>;
  /** Git-worktree isolation (ADR-0009). */
  worktree: WorktreeConfig;
}

/** A partial settings file (any layer). */
export type SettingsFile = Partial<Omit<ArchonConfig, "worktree">> & {
  /** Worktree settings may be partially specified in any layer. */
  worktree?: Partial<WorktreeConfig>;
};

export const PERMISSION_MODES: PermissionMode[] = [
  "default",
  "acceptEdits",
  "plan",
  "bypassPermissions",
];

export const DEFAULT_WORKTREE_CONFIG: WorktreeConfig = {
  bgIsolation: "worktree",
  dir: ".archon/worktrees",
  branchPrefix: "archon/",
};

export const DEFAULT_CONFIG: ArchonConfig = {
  defaultAgent: "fake",
  permissionMode: "default",
  worktree: { ...DEFAULT_WORKTREE_CONFIG },
};
