#!/usr/bin/env bun
/**
 * archon CLI (Claude-Code-like).
 *
 *   archon                          -> prints help (TUI comes in Breadth)
 *   archon -p "<prompt>" [flags]    -> run ONE prompt headless, stream assistant text
 *   archon agents                   -> list registered agents (alias: agents list)
 *   archon agents add <name> -- <argv...>  -> register an agent in config
 *   archon agents remove <name>     -> unregister a config agent
 *   archon ls [--json]              -> list sessions (in-process; see note)
 *   archon attach <id>             -> attach to a running session (in-process note)
 *   archon stop <id>               -> stop/cancel a running session
 *   archon logs <id>               -> print a session's accumulated transcript
 *   archon --version
 *   archon --help
 *
 * Flags for -p: --agent <name> --acp-cmd "<argv>" --model <m> --cwd <path>
 *               --permission-mode <default|acceptEdits|plan|bypassPermissions>
 * agents add flags: --project (write project .archon/settings.json instead of user)
 */
import { resolve } from "node:path";
import { getConfig } from "./config/load.ts";
import { addAgent, removeAgent } from "./config/agents.ts";
import { PERMISSION_MODES } from "./config/types.ts";
import { listAgents } from "./backend/registry.ts";
import { SessionManager } from "./core/session-manager.ts";
import type { PermissionMode } from "./backend/types.ts";

const VERSION = "0.1.0";

interface ParsedArgs {
  command?: string;
  /** Positional args after the subcommand (e.g. agent name + argv, session id). */
  rest: string[];
  prompt?: string;
  agent?: string;
  acpCmd?: string;
  model?: string;
  cwd?: string;
  permissionMode?: string;
  json: boolean;
  project: boolean;
  version: boolean;
  help: boolean;
}

function parseArgs(argv: string[]): ParsedArgs {
  const out: ParsedArgs = {
    rest: [],
    json: false,
    project: false,
    version: false,
    help: false,
  };
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = (): string => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`Flag ${a} requires a value`);
      return v;
    };
    switch (a) {
      case "-p":
      case "--prompt":
        out.prompt = next();
        break;
      case "--agent":
        out.agent = next();
        break;
      case "--acp-cmd":
        out.acpCmd = next();
        break;
      case "--model":
        out.model = next();
        break;
      case "--cwd":
        out.cwd = next();
        break;
      case "--permission-mode":
        out.permissionMode = next();
        break;
      case "--json":
        out.json = true;
        break;
      case "--project":
        out.project = true;
        break;
      case "--":
        // everything after `--` is a literal argv for `agents add`
        for (let j = i + 1; j < argv.length; j++) positional.push(argv[j]!);
        i = argv.length;
        break;
      case "-v":
      case "--version":
        out.version = true;
        break;
      case "-h":
      case "--help":
        out.help = true;
        break;
      default:
        if (a && !a.startsWith("-")) positional.push(a);
        else throw new Error(`Unknown flag: ${a}`);
    }
  }
  if (positional.length > 0) {
    out.command = positional[0];
    out.rest = positional.slice(1);
  }
  return out;
}

const HELP = `archon ${VERSION} — ACP multi-agent orchestrator

USAGE
  archon                          Open the orchestrator TUI (coming in Breadth; prints this for now)
  archon -p "<prompt>" [flags]    Run one prompt headless against an agent, stream the reply
  archon agents [list]            List registered agent backends
  archon agents add <name> -- <argv...>   Register a custom ACP agent in config
  archon agents remove <name>     Remove a config-registered agent
  archon ls [--json]              List active sessions
  archon attach <id>              Attach to a running session
  archon stop <id>                Stop / cancel a running session
  archon logs <id>                Print a session's accumulated transcript
  archon --version                Print version
  archon --help                   Show this help

PROMPT FLAGS
  --agent <name>            Agent backend (default from config; e.g. fake, claude, gemini, generic)
  --acp-cmd "<argv>"        Spawn command for a generic/custom ACP agent (e.g. "my-agent --acp")
  --model <id>              Model id (passed through where supported)
  --cwd <path>              Working directory for the session (default: process cwd)
  --permission-mode <mode>  ${PERMISSION_MODES.join(" | ")}

AGENTS ADD FLAGS
  --project                 Write project (.archon/settings.json) instead of user (~/.archon)

CONFIG (precedence: env > managed > project .archon/settings.json > user ~/.archon/settings.json)
  ARCHON_CONFIG_DIR  ARCHON_DEFAULT_AGENT  ARCHON_DEFAULT_MODEL  ARCHON_PERMISSION_MODE
`;

/** In-process v1 (ADR-0004): no daemon, so sessions don't persist across CLI invocations. */
const DAEMON_NOTE =
  "archon v1 runs an in-process supervisor (no daemon yet, ADR-0004): sessions live only " +
  "for the duration of a single command, so there are no cross-invocation sessions to manage. " +
  "This command is the stable shape the daemon will back in Breadth.";

function isPermissionMode(v: string | undefined): v is PermissionMode {
  return v !== undefined && (PERMISSION_MODES as string[]).includes(v);
}

/** Tokenize an --acp-cmd string into argv (simple whitespace split with quotes). */
function tokenize(s: string): string[] {
  const m = s.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [];
  return m.map((t) => t.replace(/^["']|["']$/g, ""));
}

async function runHeadlessPrompt(args: ParsedArgs): Promise<number> {
  const cwd = resolve(args.cwd ?? process.cwd());
  const config = await getConfig(cwd);
  const agent = args.agent ?? config.defaultAgent;
  const permissionMode: PermissionMode = isPermissionMode(args.permissionMode)
    ? args.permissionMode
    : config.permissionMode;
  const acpCmd = args.acpCmd ? tokenize(args.acpCmd) : undefined;

  const manager = new SessionManager();
  try {
    const id = await manager.createSession({
      agent,
      cwd,
      acpCmd,
      permissionMode,
      configAgents: config.agents,
    });
    manager.on(
      "session_chunk",
      (ev: { id: string; update: { kind: string; role?: string; text?: string } }) => {
        if (
          ev.id === id &&
          ev.update.kind === "message_chunk" &&
          ev.update.role === "assistant"
        ) {
          process.stdout.write(ev.update.text ?? "");
        }
      },
    );
    const { stopReason } = await manager.prompt(id, args.prompt!);
    process.stdout.write("\n");
    if (process.env.ARCHON_DEBUG) {
      process.stderr.write(`[archon] stopReason=${stopReason} agent=${agent}\n`);
    }
    return stopReason === "refusal" ? 1 : 0;
  } finally {
    await manager.dispose();
  }
}

/**
 * Launch the session-grid TUI (the fleet surface). Reads/subscribes to a live
 * SessionManager; dispatch input creates real sessions via the backend.
 *
 * Only meaningful with an interactive TTY. Callers gate on `process.stdout.isTTY`
 * so piped/headless invocations (and the e2e tests) keep their text behavior.
 */
async function launchTui(args: ParsedArgs): Promise<number> {
  const cwd = resolve(args.cwd ?? process.cwd());
  const config = await getConfig(cwd);
  const agent = args.agent ?? config.defaultAgent;
  const { runTui } = await import("./tui/index.tsx");
  await runTui({ agent, cwd, configAgents: config.agents });
  // runTui mounts the renderer and never returns until the app calls
  // process.exit on quit; keep the process alive.
  await new Promise<void>(() => {});
  return 0;
}

async function runAgentsCommand(args: ParsedArgs): Promise<number> {
  const sub = args.rest[0];
  const cwd = resolve(args.cwd ?? process.cwd());

  if (sub === "add") {
    const name = args.rest[1];
    const command = args.rest.slice(2);
    if (!name || command.length === 0) {
      process.stderr.write(
        'usage: archon agents add <name> -- <argv...>  (e.g. archon agents add zed -- npx -y @zed-industries/claude-code-acp)\n',
      );
      return 2;
    }
    try {
      const path = await addAgent(name, command, {
        scope: args.project ? "project" : "user",
        cwd,
      });
      process.stdout.write(`Added agent "${name}" -> ${command.join(" ")}\n  wrote ${path}\n`);
      return 0;
    } catch (e) {
      process.stderr.write(`${(e as Error).message}\n`);
      return 2;
    }
  }

  if (sub === "remove" || sub === "rm") {
    const name = args.rest[1];
    if (!name) {
      process.stderr.write("usage: archon agents remove <name>\n");
      return 2;
    }
    const path = await removeAgent(name, {
      scope: args.project ? "project" : "user",
      cwd,
    });
    if (path) {
      process.stdout.write(`Removed agent "${name}"\n  wrote ${path}\n`);
      return 0;
    }
    process.stderr.write(`No config agent named "${name}".\n`);
    return 1;
  }

  // Interactive `archon agents` (no subcommand, TTY, not --json) opens the TUI.
  if (!sub && !args.json && (process.stdout.isTTY || process.env.ARCHON_TUI === "1")) {
    return launchTui(args);
  }

  // default / "list": print the merged registry.
  const config = await getConfig(cwd);
  const agents = listAgents(config.agents);
  if (args.json) {
    process.stdout.write(JSON.stringify(agents, null, 2) + "\n");
    return 0;
  }
  for (const a of agents) {
    const tag = a.runnable ? "[runnable]" : "[needs setup]";
    const src = a.source === "config" ? "(config)" : "";
    process.stdout.write(`${a.name.padEnd(10)} ${tag.padEnd(14)} ${src.padEnd(9)} ${a.description}\n`);
    if (a.notes) process.stdout.write(`${" ".repeat(11)}${a.notes}\n`);
  }
  return 0;
}

async function runLs(args: ParsedArgs): Promise<number> {
  // In-process v1: no persistent daemon, so the live snapshot is always empty here.
  const snapshot = { sessions: [] as unknown[] };
  if (args.json) {
    process.stdout.write(JSON.stringify(snapshot, null, 2) + "\n");
    return 0;
  }
  process.stdout.write("No active sessions.\n");
  process.stdout.write(`${DAEMON_NOTE}\n`);
  return 0;
}

/** attach/stop/logs are thin wrappers; with no daemon they explain + exit non-zero. */
function runSessionCommand(verb: string, args: ParsedArgs): number {
  const id = args.rest[0];
  if (!id) {
    process.stderr.write(`usage: archon ${verb} <id>\n`);
    return 2;
  }
  process.stderr.write(`No running session "${id}".\n${DAEMON_NOTE}\n`);
  return 1;
}

async function main(): Promise<number> {
  let args: ParsedArgs;
  try {
    args = parseArgs(Bun.argv.slice(2));
  } catch (e) {
    process.stderr.write(`${(e as Error).message}\n`);
    return 2;
  }

  if (args.version) {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }
  if (args.help) {
    process.stdout.write(HELP);
    return 0;
  }

  switch (args.command) {
    case "agents":
      return runAgentsCommand(args);
    case "ls":
      return runLs(args);
    case "attach":
      return runSessionCommand("attach", args);
    case "stop":
      return runSessionCommand("stop", args);
    case "logs":
      return runSessionCommand("logs", args);
  }

  if (args.prompt !== undefined) {
    return runHeadlessPrompt(args);
  }

  // Default (no args): open the session-grid TUI when interactive; otherwise
  // (piped / headless) print help so scripts and tests get deterministic text.
  if (process.stdout.isTTY || process.env.ARCHON_TUI === "1") {
    return launchTui(args);
  }
  process.stdout.write(HELP);
  process.stdout.write(
    '\n(No TTY detected — run `archon` in an interactive terminal to open the fleet TUI, or use `archon -p "..."`.)\n',
  );
  return 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    process.stderr.write(`archon: ${(err as Error).message}\n`);
    process.exit(1);
  },
);
