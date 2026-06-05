import { test, expect } from "bun:test";
import {
  AGENT_REGISTRY,
  mergeRegistry,
  listAgents,
  getAgentSpec,
  authEnv,
  launcherAvailable,
  createBackend,
} from "./registry.ts";

test("built-in registry has claude/gemini/generic with spawn specs + notes", () => {
  expect(AGENT_REGISTRY.claude!.command).toEqual([
    "npx",
    "-y",
    "@agentclientprotocol/claude-agent-acp",
  ]);
  expect(AGENT_REGISTRY.gemini!.command).toEqual(["gemini", "--experimental-acp"]);
  expect(AGENT_REGISTRY.generic!.command).toEqual([]);
  for (const name of ["claude", "gemini", "generic"]) {
    expect(AGENT_REGISTRY[name]!.runnable).toBe(false);
    expect(AGENT_REGISTRY[name]!.notes).toBeTruthy();
  }
  expect(AGENT_REGISTRY.claude!.authEnv).toContain("ANTHROPIC_API_KEY");
  expect(AGENT_REGISTRY.gemini!.authEnv).toContain("GEMINI_API_KEY");
});

test("mergeRegistry adds config agents but never shadows built-ins", () => {
  const merged = mergeRegistry({
    mycustom: ["my-agent", "--acp"],
    claude: ["evil"], // must be ignored
  });
  expect(merged.mycustom!.command).toEqual(["my-agent", "--acp"]);
  expect(merged.mycustom!.source).toBe("config");
  expect(merged.claude!.command).toEqual(AGENT_REGISTRY.claude!.command);
  expect(listAgents({ mycustom: ["x"] }).some((a) => a.name === "mycustom")).toBe(true);
  expect(getAgentSpec("mycustom", { mycustom: ["x"] })?.source).toBe("config");
});

test("authEnv forwards only declared, present keys", () => {
  const spec = AGENT_REGISTRY.claude!;
  const got = authEnv(spec, { ANTHROPIC_API_KEY: "sk-x", UNRELATED: "y" });
  expect(got).toEqual({ ANTHROPIC_API_KEY: "sk-x" });
  expect(authEnv(spec, {})).toEqual({});
});

test("launcherAvailable: present binary true, bogus binary false, path assumed ok", () => {
  expect(launcherAvailable(["sh"])).toBe(true);
  expect(launcherAvailable(["definitely-not-a-real-binary-zzz"])).toBe(false);
  expect(launcherAvailable(["/some/abs/path"])).toBe(true);
  expect(launcherAvailable([])).toBe(false);
});

test("createBackend gives a clear error for an unknown agent", () => {
  expect(() => createBackend({ agent: "nope" })).toThrow(/Unknown agent "nope"/);
});

test("createBackend errors when generic has no command", () => {
  expect(() => createBackend({ agent: "generic" })).toThrow(/no command/);
});

test("createBackend errors with setup hint when launcher binary missing", () => {
  expect(() =>
    createBackend({ agent: "generic", acpCmd: ["definitely-not-a-real-binary-zzz", "--acp"] }),
  ).toThrow(/not found on PATH/);
});

test("createBackend resolves a config agent by name (skip launcher check)", () => {
  const be = createBackend({
    agent: "mycustom",
    configAgents: { mycustom: ["bun", "--version"] },
    skipLauncherCheck: true,
  });
  expect(be.name).toBe("mycustom");
});

test("AcpBackend.connect surfaces an actionable error when the agent exits during startup", async () => {
  // /usr/bin/false exits immediately with no ACP handshake.
  const be = createBackend({
    agent: "generic",
    acpCmd: ["sh", "-c", "echo BOOM_FROM_AGENT >&2; exit 3"],
    skipLauncherCheck: true,
  });
  let msg = "";
  try {
    await be.connect();
    throw new Error("expected connect() to reject");
  } catch (e) {
    msg = (e as Error).message;
  } finally {
    await be.dispose();
  }
  expect(msg).toMatch(/failed to start/);
  // SDK 0.25 surfaces a closed connection during handshake rather than the raw
  // exit code; the actionable signal is the captured agent stderr + the hint.
  expect(msg).toMatch(/handshake failed|exited|connection closed/i);
  // captured stderr tail is included so the user sees the real cause.
  expect(msg).toMatch(/BOOM_FROM_AGENT/);
  // generic's setup hint is appended.
  expect(msg).toMatch(/hint:/);
});

test("AcpBackend.connect surfaces a clear error when the binary cannot be spawned", async () => {
  const be = createBackend({
    agent: "generic",
    acpCmd: ["/nonexistent/path/to/agent-binary"],
    skipLauncherCheck: true,
  });
  let msg = "";
  try {
    await be.connect();
    throw new Error("expected connect() to reject");
  } catch (e) {
    msg = (e as Error).message;
  } finally {
    await be.dispose();
  }
  expect(msg).toMatch(/failed to start/);
});

test("registry ships renamed claude adapter + codex adapter", () => {
  expect(getAgentSpec("claude")?.command.at(-1)).toBe("@agentclientprotocol/claude-agent-acp");
  expect(getAgentSpec("codex")?.command.at(-1)).toBe("@zed-industries/codex-acp");
  for (const k of ["gemini", "goose", "opencode", "copilot", "qwen", "cursor", "amp"]) {
    expect(getAgentSpec(k)).toBeDefined();
  }
});
