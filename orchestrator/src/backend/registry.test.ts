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
    "@zed-industries/claude-code-acp",
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
