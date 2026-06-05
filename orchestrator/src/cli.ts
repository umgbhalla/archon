#!/usr/bin/env bun
/**
 * archon CLI (Claude-Code-like).
 *
 *   archon                          -> opens the TUI (interactive) / prints help (piped)
 *   archon -p "<prompt>" [flags]    -> run ONE prompt headless, stream assistant text
 *   archon daemon                   -> run the persistent supervisor daemon (foreground)
 *   archon daemon stop              -> stop the running daemon
 *   archon daemon status            -> report whether a daemon is running
 *   archon agents                   -> list registered agents (alias: agents list)
 *   archon agents add <name> -- <argv...>  -> register an agent in config
 *   archon agents remove <name>     -> unregister a config agent
 *   archon ls [--json]              -> list sessions (live, via the daemon)
 *   archon attach <id>             -> attach to a running session (streams updates)
 *   archon stop <id>               -> stop/cancel a running session
 *   archon logs <id>               -> print a session's persisted transcript
 *   archon --version
 *   archon --help
 *
 * Sessions are owned by a per-user supervisor daemon (ADR-0004): they survive
 * across CLI/TUI invocations. The CLI auto-starts the daemon on demand and falls
 * back to an in-process manager when a socket can't be used (e.g. tests).
 *
 * Flags for -p: --agent <name> --acp-cmd "<argv>" --model <m> --cwd <path>
 *               --permission-mode <default|acceptEdits|plan|bypassPermissions>
 *               --in-process (run headless without the daemon)
 * agents add flags: --project (write project .archon/settings.json instead of user)
 */
import { resolve } from "node:path";
import { getConfig } from "./config/load.ts";
import { addAgent, removeAgent } from "./config/agents.ts";
import { PERMISSION_MODES } from "./config/types.ts";
import { listAgents } from "./backend/registry.ts";
import type { PermissionMode } from "./backend/types.ts";
import { connectDaemon, userConfigDir, type DaemonClient } from "./daemon/client.ts";
import { runDaemon, readDaemonPid } from "./daemon/server.ts";
import { daemonPaths } from "./daemon/persistence.ts";

const VERSION = "0.1.0";

interface ParsedArgs {
  command?: string;
  rest: string[];
  prompt?: string;
  agent?: string;
  acpCmd?: string;
  model?: string;
  cwd?: string;
  permissionMode?: string;
  json: boolean;
  project: boolean;
  inProcess: boolean;
  version: boolean;
  help: boolean;
}

function parseArgs(argv: string[]): ParsedArgs {
  const out: ParsedArgs = {
    rest: [],
    json: false,
    project: false,
    inProcess: false,
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
      case "--in-process":
        out.inProcess = true;
        break;
      case "--":
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
  archon                          Open the orchestrator TUI (interactive); prints this when piped
  archon -p "<prompt>" [flags]    Run one prompt headless against an agent, stream the reply
  archon daemon                   Run the persistent supervisor daemon (foreground)
  archon daemon stop              Stop the running daemon
  archon daemon status            Report whether the daemon is running
  archon agents [list]            List registered agent backends
  archon agents add <name> -- <argv...>   Register a custom ACP agent in config
  archon agents remove <name>     Remove a config-registered agent
  archon ls [--json]              List active sessions (live, via the daemon)
  archon attach <id>              Attach to a running session (streams updates)
  archon stop <id>                Stop / cancel a running session
  archon logs <id>                Print a session's persisted transcript
  archon --version                Print version
  archon --help                   Show this help

PROMPT FLAGS
  --agent <name>            Agent backend (default from config; e.g. fake, claude, gemini, generic)
  --acp-cmd "<argv>"        Spawn command for a generic/custom ACP agent (e.g. "my-agent --acp")
  --model <id>              Model id (passed through where supported)
  --cwd <path>              Working directory for the session (default: process cwd)
  --permission-mode <mode>  ${PERMISSION_MODES.join(" | ")}
  --in-process              Run headless without the daemon (one-shot, no persistence)

AGENTS ADD FLAGS
  --project                 Write project (.archon/settings.json) instead of user (~/.archon)

CONFIG (precedence: env > managed > project .archon/settings.json > user ~/.archon/settings.json)
  ARCHON_CONFIG_DIR  ARCHON_DEFAULT_AGENT  ARCHON_DEFAULT_MODEL  ARCHON_PERMISSION_MODE
`;

function isPermissionMode(v: string | undefined): v is PermissionMode {
  return v !== undefined && (PERMISSION_MODES as string[]).includes(v);
}

/** Tokenize an --acp-cmd string into argv (simple whitespace split with quotes). */
function tokenize(s: string): string[] {
  const m = s.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [];
  return m.map((t) => t.replace(/^["']|["']$/g, ""));
}

/** Run one prompt and exit. Uses the daemon by default; --in-process opts out. */
async function runHeadlessPrompt(args: ParsedArgs): Promise<number> {
  const cwd = resolve(args.cwd ?? process.cwd());
  const config = await getConfig(cwd);
  const agent = args.agent ?? config.defaultAgent;
  const permissionMode: PermissionMode = isPermissionMode(args.permissionMode)
    ? args.permissionMode
    : config.permissionMode;
  const acpCmd = args.acpCmd ? tokenize(args.acpCmd) : undefined;

  const client = await connectDaemon({ inProcess: args.inProcess });
  let id: string | undefined;
  try {
    id = await client.createSession({
      agent,
      cwd,
      acpCmd,
      permissionMode,
      configAgents: config.agents,
    });
    const { stopReason } = await client.prompt(id, args.prompt!, (ev) => {
      if (ev.kind === "chunk" && ev.update.kind === "message_chunk" && ev.update.role === "assistant") {
        process.stdout.write(ev.update.text);
      }
    });
    process.stdout.write("\n");
    if (process.env.ARCHON_DEBUG) {
      process.stderr.write(`[archon] stopReason=${stopReason} agent=${agent}\n`);
    }
    return stopReason === "refusal" ? 1 : 0;
  } finally {
    // In-process: tear the session down (one-shot). Daemon: leave it running but
    // remove the headless one-shot session so `ls` stays meaningful.
    try {
      if (id) await client.stop(id, /* remove */ true);
    } catch {
      /* ignore */
    }
    client.close();
  }
}

/** archon daemon [stop|status] */
async function runDaemonCommand(args: ParsedArgs): Promise<number> {
  const sub = args.rest[0];
  const configDir = userConfigDir();

  if (sub === "stop") {
    try {
      const client = await connectDaemon({ noAutoStart: true });
      await client.shutdownDaemon();
      client.close();
      process.stdout.write("Stopped archon daemon.\n");
      return 0;
    } catch {
      process.stdout.write("No archon daemon running.\n");
      return 0;
    }
  }

  if (sub === "status") {
    const { socketPath } = daemonPaths(configDir);
    try {
      const client = await connectDaemon({ noAutoStart: true });
      const hs = await client.handshake();
      client.close();
      process.stdout.write(`daemon running: pid ${hs.pid}, protocol ${hs.protocolVersion}\n  socket ${socketPath}\n`);
      return 0;
    } catch {
      const pid = await readDaemonPid(configDir);
      process.stdout.write(`daemon not reachable${pid ? ` (stale pid ${pid})` : ""}.\n  socket ${socketPath}\n`);
      return 1;
    }
  }

  // foreground daemon
  await runDaemon(configDir);
  return 0;
}

async function launchTui(args: ParsedArgs): Promise<number> {
  const cwd = resolve(args.cwd ?? process.cwd());
  const config = await getConfig(cwd);
  const agent = args.agent ?? config.defaultAgent;
  const { runTui } = await import("./tui/index.tsx");
  await runTui({ agent, cwd, configAgents: config.agents });
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

  if (!sub && !args.json && (process.stdout.isTTY || process.env.ARCHON_TUI === "1")) {
    return launchTui(args);
  }

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

/** Connect to the daemon (auto-start), do something, then release the connection. */
async function withDaemon<T>(fn: (c: DaemonClient) => Promise<T>): Promise<T> {
  const client = await connectDaemon({});
  try {
    return await fn(client);
  } finally {
    client.close();
  }
}

async function runLs(args: ParsedArgs): Promise<number> {
  return withDaemon(async (client) => {
    const sessions = await client.listSessions();
    if (args.json) {
      process.stdout.write(JSON.stringify({ sessions }, null, 2) + "\n");
      return 0;
    }
    if (sessions.length === 0) {
      process.stdout.write("No active sessions.\n");
      return 0;
    }
    for (const s of sessions) {
      const msg = (s.lastMessage || s.lastStopReason || "—").replace(/\s+/g, " ").trim().slice(0, 60);
      process.stdout.write(`${s.id.padEnd(20)} ${s.state.padEnd(10)} ${s.agent.padEnd(8)} ${msg}\n`);
    }
    return 0;
  });
}

async function runAttach(args: ParsedArgs): Promise<number> {
  const id = args.rest[0];
  if (!id) {
    process.stderr.write("usage: archon attach <id>\n");
    return 2;
  }
  return withDaemon(async (client) => {
    const sessions = await client.listSessions();
    if (!sessions.some((s) => s.id === id)) {
      process.stderr.write(`No running session "${id}".\n`);
      return 1;
    }
    process.stdout.write(`Attached to ${id}. Streaming updates (Ctrl-C to detach)...\n`);
    await client.attach((ev) => {
      if (ev.type === "session_chunk" && ev.id === id) {
        if (ev.update.kind === "message_chunk" && ev.update.role === "assistant") {
          process.stdout.write(ev.update.text);
        }
      } else if (ev.type === "session_updated" && ev.session.id === id) {
        process.stderr.write(`\n[${id}] state=${ev.session.state}\n`);
      } else if (ev.type === "session_removed" && ev.id === id) {
        process.stderr.write(`\n[${id}] removed\n`);
      }
    });
    // stay attached until interrupted.
    await new Promise<void>(() => {});
    return 0;
  });
}

async function runStop(args: ParsedArgs): Promise<number> {
  const id = args.rest[0];
  if (!id) {
    process.stderr.write("usage: archon stop <id>\n");
    return 2;
  }
  return withDaemon(async (client) => {
    const sessions = await client.listSessions();
    if (!sessions.some((s) => s.id === id)) {
      process.stderr.write(`No running session "${id}".\n`);
      return 1;
    }
    await client.stop(id, /* remove */ true);
    process.stdout.write(`Stopped session ${id}.\n`);
    return 0;
  });
}

async function runLogs(args: ParsedArgs): Promise<number> {
  const id = args.rest[0];
  if (!id) {
    process.stderr.write("usage: archon logs <id>\n");
    return 2;
  }
  return withDaemon(async (client) => {
    const { session, transcript } = await client.logs(id);
    if (!session && !transcript) {
      process.stderr.write(`No session "${id}".\n`);
      return 1;
    }
    process.stdout.write(transcript);
    if (!transcript.endsWith("\n")) process.stdout.write("\n");
    return 0;
  });
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
    case "daemon":
      return runDaemonCommand(args);
    case "agents":
      return runAgentsCommand(args);
    case "ls":
      return runLs(args);
    case "attach":
      return runAttach(args);
    case "stop":
      return runStop(args);
    case "logs":
      return runLogs(args);
  }

  if (args.prompt !== undefined) {
    return runHeadlessPrompt(args);
  }

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
