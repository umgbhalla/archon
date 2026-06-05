/**
 * Agent registry — named agent specs mapping to a spawn command.
 *
 * Built-in entries cover the real ACP agents people actually run:
 *   - "fake"    — bundled standalone ACP test agent (the only no-setup entry).
 *   - "claude"  — Claude Code over ACP via Zed's adapter (npx @zed-industries/claude-code-acp).
 *   - "gemini"  — Gemini CLI in experimental ACP mode (gemini --experimental-acp).
 *   - "generic" — any ACP agent; the command is supplied at runtime via --acp-cmd.
 *
 * Built-ins are intentionally NOT "runnable" (they need a separately installed
 * binary + credentials). createBackend resolves a spec into an AcpBackend and
 * (best-effort) checks the launcher binary is on PATH so we fail with a clear
 * message instead of a cryptic spawn error.
 *
 * User/project config can register additional agents (config.agents: name -> argv);
 * merge them in via mergeRegistry() before resolving.
 */
import { AcpBackend } from "./acp-backend.ts";
import type { AgentBackend, PermissionMode } from "./types.ts";

export interface AgentSpec {
  /** Registry key, e.g. "claude". */
  name: string;
  /** Human description. */
  description: string;
  /** Spawn command (argv). Empty for "generic" (must be supplied at runtime). */
  command: string[];
  /** True if this entry is known to run with no external setup. */
  runnable: boolean;
  /** Where this spec came from. */
  source: "builtin" | "config";
  /** Short capability / behaviour notes shown by `archon agents`. */
  notes?: string;
  /**
   * Env var names this agent reads for auth/config. Present vars in the parent
   * process are passed through to the subprocess (see authEnv()).
   */
  authEnv?: string[];
  /** Human-facing install/auth hint shown when the launcher binary is missing. */
  setupHint?: string;
}

/** Absolute path to the bundled fake agent (resolved relative to this module). */
const FAKE_AGENT_PATH = new URL("../testing/fake-acp-agent.ts", import.meta.url).pathname;

export const AGENT_REGISTRY: Record<string, AgentSpec> = {
  fake: {
    name: "fake",
    description: "Bundled standalone ACP test agent (no creds; used by e2e tests).",
    command: ["bun", "run", FAKE_AGENT_PATH],
    runnable: true,
    source: "builtin",
    notes: "Deterministic 3-chunk reply; supports cancel. No real model/network.",
  },
  claude: {
    name: "claude",
    description: "Claude Code over ACP (Zed adapter).",
    command: ["npx", "-y", "@zed-industries/claude-code-acp"],
    runnable: false,
    source: "builtin",
    notes:
      "Full agent: streaming text + thoughts, tool calls, fs read/write, plan, session modes. " +
      "Needs Node/npx and Anthropic auth.",
    authEnv: ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN"],
    setupHint:
      "Install Node.js (provides npx). Authenticate with ANTHROPIC_API_KEY " +
      "(or CLAUDE_CODE_OAUTH_TOKEN). First run downloads @zed-industries/claude-code-acp via npx.",
  },
  gemini: {
    name: "gemini",
    description: "Gemini CLI in experimental ACP mode.",
    command: ["gemini", "--experimental-acp"],
    runnable: false,
    source: "builtin",
    notes:
      "Google's Gemini CLI speaking ACP over stdio. Streaming text + tool calls; " +
      "ACP support is experimental and may change.",
    authEnv: ["GEMINI_API_KEY", "GOOGLE_API_KEY", "GOOGLE_GENAI_USE_VERTEXAI"],
    setupHint:
      "Install the Gemini CLI (npm i -g @google/gemini-cli) so `gemini` is on PATH, " +
      "then authenticate (GEMINI_API_KEY, or `gemini` interactive login).",
  },
  generic: {
    name: "generic",
    description: "Any ACP agent; supply the command via --acp-cmd.",
    command: [],
    runnable: false,
    source: "builtin",
    notes:
      "Escape hatch for any agent that speaks ACP over stdio. " +
      'Pass the launch argv with --acp-cmd "<argv>".',
    setupHint:
      'Provide the agent command, e.g. --acp-cmd "my-agent --acp". ' +
      "Whatever you name will be spawned and driven over stdio.",
  },
};

/**
 * Build a registry view that includes user/project config agents.
 * Config agents are tagged source:"config" and runnable:false
 * (we can't know if their binary is installed). Reserved built-in names cannot
 * be shadowed by config; any other name from config is added.
 */
export function mergeRegistry(
  configAgents?: Record<string, string[]>,
): Record<string, AgentSpec> {
  const merged: Record<string, AgentSpec> = { ...AGENT_REGISTRY };
  if (!configAgents) return merged;
  for (const [name, command] of Object.entries(configAgents)) {
    if (name in AGENT_REGISTRY) continue; // don't let config shadow built-ins
    if (!Array.isArray(command) || command.length === 0) continue;
    merged[name] = {
      name,
      description: `User-defined ACP agent (from config): ${command.join(" ")}`,
      command: [...command],
      runnable: false,
      source: "config",
      notes: "Registered via ~/.archon/settings.json or .archon/settings.json (agents).",
    };
  }
  return merged;
}

export function listAgents(
  configAgents?: Record<string, string[]>,
): AgentSpec[] {
  return Object.values(mergeRegistry(configAgents));
}

export function getAgentSpec(
  name: string,
  configAgents?: Record<string, string[]>,
): AgentSpec | undefined {
  return mergeRegistry(configAgents)[name];
}

/** Collect auth/config env vars this spec declares that are present in `env`. */
export function authEnv(
  spec: AgentSpec,
  env: Record<string, string | undefined> = process.env,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of spec.authEnv ?? []) {
    const v = env[key];
    if (typeof v === "string" && v.length > 0) out[key] = v;
  }
  return out;
}

/**
 * Best-effort check that the launcher binary (argv[0]) is resolvable on PATH.
 * Absolute/relative paths are assumed OK (let spawn surface errors). Returns
 * false only when we are confident the binary is missing.
 */
export function launcherAvailable(command: string[]): boolean {
  const bin = command[0];
  if (!bin) return false;
  if (bin.includes("/")) return true; // explicit path; let spawn surface errors
  const which = Bun.spawnSync(["sh", "-c", `command -v ${bin} >/dev/null 2>&1`]);
  return which.exitCode === 0;
}

export interface CreateBackendOptions {
  agent: string;
  /** Overrides the spec command (required for "generic", from --acp-cmd). */
  acpCmd?: string[];
  cwd?: string;
  env?: Record<string, string>;
  permissionMode?: PermissionMode;
  /** Extra named agents from config (merged into the registry). */
  configAgents?: Record<string, string[]>;
  /** Skip the PATH check for the launcher binary (tests / advanced use). */
  skipLauncherCheck?: boolean;
}

/**
 * Resolve a named agent (+ optional overrides) into a concrete AgentBackend.
 * Throws with an actionable message if the agent is unknown, has no command,
 * or its launcher binary is not installed.
 */
export function createBackend(opts: CreateBackendOptions): AgentBackend {
  const registry = mergeRegistry(opts.configAgents);
  const spec = registry[opts.agent];
  if (!spec) {
    throw new Error(
      `Unknown agent "${opts.agent}". Known: ${Object.keys(registry).join(", ")}. ` +
        `Add one with \`archon agents add <name> -- <argv>\` or pass --acp-cmd.`,
    );
  }
  const command = opts.acpCmd && opts.acpCmd.length > 0 ? opts.acpCmd : spec.command;
  if (command.length === 0) {
    throw new Error(
      `Agent "${opts.agent}" has no command; pass --acp-cmd "<argv>".` +
        (spec.setupHint ? `\n  hint: ${spec.setupHint}` : ""),
    );
  }
  if (!opts.skipLauncherCheck && !spec.runnable && !launcherAvailable(command)) {
    const hint = spec.setupHint ? `\n  hint: ${spec.setupHint}` : "";
    throw new Error(
      `Agent "${opts.agent}" launcher "${command[0]}" was not found on PATH.${hint}`,
    );
  }

  // Forward only the auth env keys the spec declares (don't leak unrelated env);
  // explicit opts.env wins on conflict.
  const passthrough = authEnv(spec);
  const env = { ...passthrough, ...(opts.env ?? {}) };

  return new AcpBackend({
    name: spec.name,
    command,
    cwd: opts.cwd,
    env: Object.keys(env).length > 0 ? env : undefined,
    permissionMode: opts.permissionMode,
  });
}
