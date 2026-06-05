/**
 * TUI entry — creates the OpenTUI renderer and mounts the session grid against
 * a live SessionManager. Called from the CLI (archon / archon agents).
 *
 * Headless-smoke safe: if stdin is not a TTY (e.g. `… </dev/null`), we still
 * mount, but a closed stdin simply yields no key events — the app renders the
 * empty grid and idles without crashing.
 */
import { createCliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";
import { SessionManager } from "../core/session-manager.ts";
import { App } from "./App.tsx";

export interface RunTuiOptions {
  agent: string;
  cwd: string;
  /** Extra named agents from config, merged into the registry for resolution. */
  configAgents?: Record<string, string[]>;
  manager?: SessionManager;
}

export async function runTui(opts: RunTuiOptions): Promise<void> {
  const manager = opts.manager ?? new SessionManager();
  const renderer = await createCliRenderer({ exitOnCtrlC: false });
  createRoot(renderer).render(
    <App manager={manager} agent={opts.agent} cwd={opts.cwd} configAgents={opts.configAgents} />,
  );
}
