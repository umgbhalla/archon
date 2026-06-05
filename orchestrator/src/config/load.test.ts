import { test, expect } from "bun:test";
import { mergeSettings, envLayer } from "./load.ts";
import { DEFAULT_CONFIG } from "./types.ts";

test("mergeSettings returns defaults with no layers", () => {
  expect(mergeSettings()).toEqual(DEFAULT_CONFIG);
});

test("mergeSettings: later layers override earlier", () => {
  const merged = mergeSettings(
    { defaultAgent: "user-agent", permissionMode: "plan" },
    { defaultAgent: "project-agent" },
    { permissionMode: "bypassPermissions" },
  );
  expect(merged.defaultAgent).toBe("project-agent");
  expect(merged.permissionMode).toBe("bypassPermissions");
});

test("mergeSettings: agents map is shallow-merged across layers", () => {
  const merged = mergeSettings(
    { agents: { a: ["x"] } },
    { agents: { b: ["y"] } },
    { agents: { a: ["z"] } },
  );
  expect(merged.agents).toEqual({ a: ["z"], b: ["y"] });
});

test("envLayer: maps env vars and validates permission mode", () => {
  expect(
    envLayer({
      ARCHON_DEFAULT_AGENT: "gemini",
      ARCHON_DEFAULT_MODEL: "m1",
      ARCHON_PERMISSION_MODE: "acceptEdits",
    }),
  ).toEqual({ defaultAgent: "gemini", defaultModel: "m1", permissionMode: "acceptEdits" });
});

test("envLayer: ignores invalid permission mode", () => {
  const layer = envLayer({ ARCHON_PERMISSION_MODE: "nonsense" });
  expect(layer.permissionMode).toBeUndefined();
});

test("env layer wins over file layers (full precedence)", () => {
  const merged = mergeSettings(
    { defaultAgent: "user", permissionMode: "default" },
    { defaultAgent: "project" },
    {},
    envLayer({ ARCHON_DEFAULT_AGENT: "env-agent" }),
  );
  expect(merged.defaultAgent).toBe("env-agent");
});
