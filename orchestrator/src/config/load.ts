/**
 * Config loader (Claude-Code-like layering).
 *
 * Precedence (highest wins):
 *   env vars > managed > project (.archon/settings.json) > user (~/.archon/settings.json) > defaults
 *
 * Env vars honored:
 *   ARCHON_CONFIG_DIR        — overrides the user config dir (default ~/.archon)
 *   ARCHON_DEFAULT_AGENT     — default agent name
 *   ARCHON_DEFAULT_MODEL     — default model id
 *   ARCHON_PERMISSION_MODE   — default | acceptEdits | plan | bypassPermissions
 *   ARCHON_WORKTREE          — worktree | none (background-isolation mode, ADR-0009)
 *
 * Managed path mirrors Claude Code's system-managed settings location convention.
 */
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  DEFAULT_CONFIG,
  DEFAULT_WORKTREE_CONFIG,
  PERMISSION_MODES,
  WORKTREE_ISOLATION_MODES,
  type ArchonConfig,
  type SettingsFile,
  type WorktreeIsolation,
} from "./types.ts";
import type { PermissionMode } from "../backend/types.ts";

export interface LoadConfigEnv {
  ARCHON_CONFIG_DIR?: string;
  ARCHON_DEFAULT_AGENT?: string;
  ARCHON_DEFAULT_MODEL?: string;
  ARCHON_PERMISSION_MODE?: string;
  ARCHON_WORKTREE?: string;
}

function userConfigDir(env: LoadConfigEnv): string {
  return env.ARCHON_CONFIG_DIR ?? join(homedir(), ".archon");
}

function managedConfigPath(): string {
  // System-managed location (admin-pushed policy), mirroring Claude Code's pattern.
  return process.platform === "darwin"
    ? "/Library/Application Support/Archon/managed-settings.json"
    : "/etc/archon/managed-settings.json";
}

async function readSettings(path: string): Promise<SettingsFile> {
  try {
    const file = Bun.file(path);
    if (!(await file.exists())) return {};
    const parsed = (await file.json()) as unknown;
    return isSettings(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function isSettings(v: unknown): v is SettingsFile {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isPermissionMode(v: string | undefined): v is PermissionMode {
  return v !== undefined && (PERMISSION_MODES as string[]).includes(v);
}

function isWorktreeIsolation(v: string | undefined): v is WorktreeIsolation {
  return v !== undefined && (WORKTREE_ISOLATION_MODES as string[]).includes(v);
}

/** Merge layers; later args override earlier. Objects (agents, worktree) are shallow-merged. */
export function mergeSettings(...layers: SettingsFile[]): ArchonConfig {
  const out: ArchonConfig = {
    ...DEFAULT_CONFIG,
    worktree: { ...DEFAULT_WORKTREE_CONFIG },
  };
  for (const layer of layers) {
    if (layer.defaultAgent !== undefined) out.defaultAgent = layer.defaultAgent;
    if (layer.defaultModel !== undefined) out.defaultModel = layer.defaultModel;
    if (layer.permissionMode !== undefined) out.permissionMode = layer.permissionMode;
    if (layer.agents) out.agents = { ...(out.agents ?? {}), ...layer.agents };
    if (layer.worktree) out.worktree = { ...out.worktree, ...layer.worktree };
  }
  return out;
}

/** Build the env-derived settings layer (highest precedence). */
export function envLayer(env: LoadConfigEnv): SettingsFile {
  const layer: SettingsFile = {};
  if (env.ARCHON_DEFAULT_AGENT) layer.defaultAgent = env.ARCHON_DEFAULT_AGENT;
  if (env.ARCHON_DEFAULT_MODEL) layer.defaultModel = env.ARCHON_DEFAULT_MODEL;
  if (isPermissionMode(env.ARCHON_PERMISSION_MODE)) {
    layer.permissionMode = env.ARCHON_PERMISSION_MODE;
  }
  if (isWorktreeIsolation(env.ARCHON_WORKTREE)) {
    layer.worktree = { bgIsolation: env.ARCHON_WORKTREE };
  }
  return layer;
}

/**
 * Load and merge config for a given working directory.
 * `env` defaults to process.env (injectable for tests).
 */
export async function getConfig(
  cwd: string = process.cwd(),
  env: LoadConfigEnv = process.env as LoadConfigEnv,
): Promise<ArchonConfig> {
  const user = await readSettings(join(userConfigDir(env), "settings.json"));
  const project = await readSettings(join(resolve(cwd), ".archon", "settings.json"));
  const managed = await readSettings(managedConfigPath());
  // precedence: defaults < user < project < managed < env
  return mergeSettings(user, project, managed, envLayer(env));
}
