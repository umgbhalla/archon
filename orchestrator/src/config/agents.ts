/**
 * Config-backed agent registration — the storage behind `archon agents add/remove`.
 *
 * Agents live under the `agents` key of a settings file (name -> spawn argv):
 *   { "agents": { "myagent": ["my-agent", "--acp"] } }
 *
 * By default we write the USER settings file (~/.archon/settings.json, or
 * $ARCHON_CONFIG_DIR/settings.json). Pass scope:"project" to write
 * <cwd>/.archon/settings.json instead. Reads/merges go through getConfig().
 */
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { mkdir } from "node:fs/promises";
import type { LoadConfigEnv } from "./load.ts";
import type { SettingsFile } from "./types.ts";

export type ConfigScope = "user" | "project";

export interface AgentStoreOptions {
  scope?: ConfigScope;
  cwd?: string;
  env?: LoadConfigEnv;
}

function userConfigDir(env: LoadConfigEnv): string {
  return env.ARCHON_CONFIG_DIR ?? join(homedir(), ".archon");
}

/** Resolve the settings.json path for a given scope. */
export function settingsPath(opts: AgentStoreOptions = {}): string {
  const env = opts.env ?? (process.env as LoadConfigEnv);
  if ((opts.scope ?? "user") === "project") {
    return join(resolve(opts.cwd ?? process.cwd()), ".archon", "settings.json");
  }
  return join(userConfigDir(env), "settings.json");
}

async function readFileSettings(path: string): Promise<SettingsFile> {
  try {
    const file = Bun.file(path);
    if (!(await file.exists())) return {};
    const parsed = (await file.json()) as unknown;
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as SettingsFile)
      : {};
  } catch {
    return {};
  }
}

async function writeFileSettings(path: string, settings: SettingsFile): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await Bun.write(path, JSON.stringify(settings, null, 2) + "\n");
}

/**
 * Add (or overwrite) a named agent in the chosen settings file.
 * Returns the path written.
 */
export async function addAgent(
  name: string,
  command: string[],
  opts: AgentStoreOptions = {},
): Promise<string> {
  if (!name || /\s/.test(name)) {
    throw new Error(`Invalid agent name "${name}" (no whitespace; non-empty).`);
  }
  if (!Array.isArray(command) || command.length === 0) {
    throw new Error(`Agent "${name}" needs a non-empty command argv.`);
  }
  const path = settingsPath(opts);
  const settings = await readFileSettings(path);
  settings.agents = { ...(settings.agents ?? {}), [name]: [...command] };
  await writeFileSettings(path, settings);
  return path;
}

/**
 * Remove a named agent from the chosen settings file.
 * Returns the path written, or undefined if the agent wasn't present.
 */
export async function removeAgent(
  name: string,
  opts: AgentStoreOptions = {},
): Promise<string | undefined> {
  const path = settingsPath(opts);
  const settings = await readFileSettings(path);
  if (!settings.agents || !(name in settings.agents)) return undefined;
  delete settings.agents[name];
  await writeFileSettings(path, settings);
  return path;
}
