/**
 * Real-agent integration tests — PROVE a genuine model reply (not the fake
 * agent's fixed "Hello from the fake ACP agent!") flows through archon's ACP
 * client + AgentBackend.
 *
 * Gated behind ARCHON_TEST_REAL=1 (and the relevant auth env) so the default
 * `bun test` stays fast + green offline. Run real checks with:
 *   ARCHON_TEST_REAL=1 ANTHROPIC_API_KEY=... bun test real-integration
 *
 * Verified manually on 2026-06-05 on this host:
 *   claude → "BANANA"   (ANTHROPIC_API_KEY)
 *   codex  → "391"      (@zed-industries/codex-acp via `codex login`)
 */
import { test, expect } from "bun:test";
import { createBackend } from "./backend/registry.ts";

const REAL = process.env.ARCHON_TEST_REAL === "1";

async function ask(agent: string, prompt: string): Promise<string> {
  const be = await createBackend({ agent, cwd: process.cwd() });
  let out = "";
  try {
    await be.connect();
    const { sessionId } = await be.newSession(process.cwd());
    const handle = be.prompt(sessionId, prompt);
    for await (const ev of handle.updates) {
      if (ev.kind === "message_chunk" && ev.role === "assistant") out += ev.text;
    }
    await handle.done;
  } finally {
    await be.dispose();
  }
  return out;
}

const claudeReady = REAL && (!!process.env.ANTHROPIC_API_KEY || !!process.env.CLAUDE_CODE_OAUTH_TOKEN);
test.if(claudeReady)("claude returns a real model reply (not the fake string)", async () => {
  const out = await ask("claude", "Reply with exactly the single word: BANANA");
  expect(out).toContain("BANANA");
  expect(out).not.toContain("fake ACP agent");
}, 180_000);

const codexReady = REAL && (!!process.env.OPENAI_API_KEY || !!process.env.CODEX_API_KEY || process.env.ARCHON_TEST_CODEX === "1");
test.if(codexReady)("codex returns a real model reply via the ACP adapter", async () => {
  const out = await ask("codex", "What is 17*23? Reply with only the number.");
  expect(out).toContain("391");
  expect(out).not.toContain("fake ACP agent");
}, 180_000);

test("fake agent still streams the deterministic control string", async () => {
  const out = await ask("fake", "ping");
  expect(out).toContain("Hello from the fake ACP agent!");
});
