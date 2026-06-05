import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addAgent, removeAgent, settingsPath } from "./agents.ts";
import { getConfig } from "./load.ts";

function tmpEnv() {
  const dir = mkdtempSync(join(tmpdir(), "archon-cfg-"));
  return { ARCHON_CONFIG_DIR: dir } as const;
}

test("addAgent writes to user settings and getConfig reads it back", async () => {
  const env = tmpEnv();
  const path = await addAgent("zed", ["npx", "-y", "@zed-industries/claude-code-acp"], { env });
  expect(path).toBe(settingsPath({ env }));

  const cfg = await getConfig(process.cwd(), env);
  expect(cfg.agents?.zed).toEqual(["npx", "-y", "@zed-industries/claude-code-acp"]);
});

test("addAgent merges (does not clobber) existing agents", async () => {
  const env = tmpEnv();
  await addAgent("a", ["a-cmd"], { env });
  await addAgent("b", ["b-cmd"], { env });
  const cfg = await getConfig(process.cwd(), env);
  expect(cfg.agents?.a).toEqual(["a-cmd"]);
  expect(cfg.agents?.b).toEqual(["b-cmd"]);
});

test("addAgent rejects bad names / empty command", async () => {
  const env = tmpEnv();
  await expect(addAgent("bad name", ["x"], { env })).rejects.toThrow();
  await expect(addAgent("ok", [], { env })).rejects.toThrow();
});

test("removeAgent deletes and returns undefined when absent", async () => {
  const env = tmpEnv();
  await addAgent("gone", ["x"], { env });
  expect(await removeAgent("gone", { env })).toBe(settingsPath({ env }));
  expect((await getConfig(process.cwd(), env)).agents?.gone).toBeUndefined();
  expect(await removeAgent("never", { env })).toBeUndefined();
});

test("project scope writes <cwd>/.archon/settings.json", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "archon-proj-"));
  const path = await addAgent("p", ["p-cmd"], { scope: "project", cwd });
  expect(path).toBe(join(cwd, ".archon", "settings.json"));
});
