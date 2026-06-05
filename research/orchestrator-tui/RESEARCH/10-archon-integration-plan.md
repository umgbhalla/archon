# 10 — ACP integration plan for archon

> **Date:** 2026-06-05. **Synthesizes:** [`07-acp-agents.md`](./07-acp-agents.md) (who archon can drive), [`08-acp-sdk-client.md`](./08-acp-sdk-client.md) (the client SDK + the package rename), [`09-codex-and-nonacp.md`](./09-codex-and-nonacp.md) (Codex, which has no native ACP). **Target code:** `orchestrator/src/backend/registry.ts`, `orchestrator/src/acp/*`, `orchestrator/src/cli.ts`.
>
> **Why now:** archon already implements the *client half* of ACP (`src/acp/transport.ts` -> `ClientSideConnection` + `ndJsonStream`; `src/backend/acp-backend.ts` -> `AgentBackend`). The registry currently ships **stale package names** (`@zed-industries/claude-code-acp`, SDK `@zed-industries/agent-client-protocol@0.4.5`) that are *deprecated/renamed* on npm. This plan makes the registry canonical, adds a Codex path, and proves a real model reply end-to-end.

---

## 1. Canonical agent registry archon should ship

The whole integration surface is the spawn-command table (07 "How archon drives an ACP agent"): build the client once, point it at any binary. archon's `AgentSpec` already has the right shape (`command: string[]`, `authEnv`, `setupHint`, `runnable`). Ship these built-ins:

| Registry key | Spawn command (verbatim argv) | Package / binary @ version | Native ACP? | Auth env / method | Notes for archon |
|---|---|---|---|---|---|
| `fake` | `bun run <.../testing/fake-acp-agent.ts>` | bundled | n/a (test) | none | `runnable:true`. Deterministic 3-chunk reply `"Hello from the fake ACP agent!"`. The **only** no-setup entry; used to prove the pipe, NOT a real model. |
| `claude` | `npx -y @agentclientprotocol/claude-agent-acp` | npm `@agentclientprotocol/claude-agent-acp` **0.42.0** (bin `claude-agent-acp`) | adapter (official, AAIF/Zed) | `ANTHROPIC_API_KEY` **or** `CLAUDE_CODE_OAUTH_TOKEN` (Pro/Max sub); honors `CLAUDE_CONFIG_DIR` | **RENAMED** - see §2. Rich caps: fs, terminal, permissions, plan, modes, slash commands (07 §1). |
| `gemini` | `gemini --experimental-acp` | npm `@google/gemini-cli` **0.45.1** (bin `gemini`) | native | `oauth-personal` login **or** `GEMINI_API_KEY` | Use `--experimental-acp` (not `--acp`; every real integration uses the experimental flag - 07 §2). Optional `--model <id>`, `--yolo`. ACP v1. |
| `codex` | `npx -y @zed-industries/codex-acp` (or bin `codex-acp`) | npm `@zed-industries/codex-acp` **0.15.0** (bin `codex-acp`) | adapter (official, Zed) | `OPENAI_API_KEY` **or** `CODEX_API_KEY` **or** ChatGPT sub via `codex login` | **Primary** Codex path - reuses archon's ACP client as-is (09 §1a/§3). ChatGPT-sub auth fails in remote/headless -> use an API key there. Codex runs terminal cmds non-PTY in its own process (09 §4). |
| `codex-exec` | (native backend - see §4) `codex exec --json` | npm `@openai/codex` **0.137.x** (installed: 0.136.0) | **no** (JSONL shell-out) | `CODEX_API_KEY` / saved CLI auth | `runnable` only if `codex` on PATH. Fallback for headless/CI where hosting ACP isn't worth it (09 §2a/§3). One-shot; no mid-turn permissions. |
| `goose` | `goose acp` | block/goose Rust bin `goose` | native | provider keys via goose config | Real, native, both agent+client (07 §3). `runnable:false` (needs install + config). |
| `opencode` | `opencode acp` | `opencode` (sst/opencode) | native | provider keys / `opencode auth` | Real, native; already a `context/` submodule (07 §4). `/undo`,`/redo` unsupported over ACP. |
| `copilot` | `copilot --acp` | npm `@github/copilot` **1.0.59** (bin `copilot`) | native (public preview) | GitHub Copilot sub / `gh` auth | Preview since 2026-01-28; actively patched (07 §6). |
| `qwen` | `qwen --acp` | npm `@qwen-code/qwen-code` **0.17.1** (bin `qwen`, Node >= 22) | native | `OPENAI_API_KEY`(+`BASE_URL`/`MODEL`) or Qwen OAuth | `--acp` (legacy `--experimental-acp` deprecated). Starts ACP **v1** - fine, archon is a v1 client (07 §8). |
| `cursor` | `agent acp` (bin `cursor-agent`) | install via `cursor.com/install` | native | `cursor_login` | No `session/load` natively -> archon must not show "resume" for it (07 §7). |
| `amp` | `acp-amp run` (or `npx @superagenticai/acp-amp`) | npm `@superagenticai/acp-amp` **0.1.0** (3rd-party bridge) | **no** (community bridge) | **paid** Amp credits (free rejected) | Tier-2, best-effort. `runnable:false` (07 §9). |
| `generic` | (empty - supply via `--acp-cmd "<argv>"`) | - | any | - | Existing escape hatch; keep as-is. |

**Tiering (from 07 "Bottom line"):** Tier 1 native = gemini, goose, opencode, copilot, cursor, qwen. Tier 1 adapter = claude, codex. Tier 2 bridge = amp (+ aider, omitted - no published binary, partial). `runnable:true` stays reserved for `fake`; everything else needs a separately installed binary + creds, so `launcherAvailable()` + `setupHint` carry the UX (already implemented in registry.ts).

> archon should eventually **consume the machine-readable ACP Agent Registry** (Zed + JetBrains, Jan 2026) rather than hard-code this table (07 "Other agents"). For now, ship the table; the registry-fetch is a follow-up.

---

## 2. SDK / package migrations archon MUST do

Three renames are live on npm and archon is on the *old* names (verified via `npm view` - see §3 "verified versions"):

1. **Client SDK rename + version jump (08 §0):** `@zed-industries/agent-client-protocol@0.4.5` is **deprecated** ("renamed to `@agentclientprotocol/sdk`"). Migrate to **`@agentclientprotocol/sdk@0.25.0`**.
   - `bun remove @zed-industries/agent-client-protocol && bun add @agentclientprotocol/sdk`
   - Change imports in **`src/acp/types.ts`** (2 sites), **`src/acp/transport.ts`** (3 sites), **`src/testing/fake-acp-agent.ts`** (2 sites): `from "@zed-industries/agent-client-protocol"` -> `from "@agentclientprotocol/sdk"`.
   - `ClientSideConnection`, `AgentSideConnection`, `ndJsonStream`, `PROTOCOL_VERSION`, the `Client`/`Agent` interfaces, and the schema types are **stable across the rename** (08 §0) - this is a rename + 0.4.5->0.25.0 bump, *not* a rewrite. `PROTOCOL_VERSION` is still the integer `1` (08 §0). Expect additive surface (terminals, modes, models, elicitation), no breaking renames of the core client API.
2. **Claude adapter rename (07 §1, the one the task flagged):** `@zed-industries/claude-code-acp` -> `@zed-industries/claude-agent-acp` -> **`@agentclientprotocol/claude-agent-acp@0.42.0`** (both old names deprecated). Update the `claude` registry `command` to `["npx","-y","@agentclientprotocol/claude-agent-acp"]`.
3. **Codex adapter is NOT renamed:** stays `@zed-industries/codex-acp@0.15.0` (07 §5, 09 §1a) - still under the `@zed-industries` scope. Do not "fix" it to the `@agentclientprotocol` scope; that package does not exist.

**Gotcha to honor when pinning (07 §1):** the ACP registry has at least once pointed at an *unpublished* claude-agent-acp version (0.25.3 -> install failure). Pin only versions confirmed on npm, or stay on the floating `latest` via `npx -y`.

---

## 3. What is testable end-to-end on THIS machine right now

Probed on this host (2026-06-05):

| Agent | Binary present | ACP-capable | E2E testable now? |
|---|---|---|---|
| `fake` | bundled | yes | **Yes** - proves the transport (no model). |
| `claude` | `claude` 2.1.165 (Claude Code installed) + `npx`/`node` v22.22.0 present | adapter fetched on demand via `npx -y @agentclientprotocol/claude-agent-acp` | **Yes**, if Anthropic auth is present (`ANTHROPIC_API_KEY`/`CLAUDE_CODE_OAUTH_TOKEN`). First run downloads the adapter via npx. |
| `gemini` | `gemini` on PATH (`~/.bun/bin/gemini`, `@google/gemini-cli`) | native `--experimental-acp` | **Yes**, with Google login or `GEMINI_API_KEY`. *Caveat:* `gemini --version` emitted an OpenTelemetry import error on this host - verify the binary actually starts in ACP mode before trusting it; also the macOS subprocess-login prompt (07 §2 gotcha) may fire when spawned from archon vs a TTY. |
| `codex` (ACP adapter) | `codex` 0.136.0 on PATH (`/opt/homebrew/bin/codex`) **but the local `codex` is non-ACP** | the **adapter** `@zed-industries/codex-acp` is fetched via `npx` and supplies ACP itself - it does not require a local ACP-capable `codex` | **Yes (via adapter)**, with `OPENAI_API_KEY`/`CODEX_API_KEY` or `codex login`. The installed `codex` binary alone is **not** ACP - confirms 09's premise. |
| `codex-exec` (native) | `codex` 0.136.0 present | JSONL shell-out, not ACP | **Yes** as a non-ACP fallback once `CodexBackend` exists (§4). |
| goose / opencode / copilot / qwen / cursor / amp | not installed here | native/bridge | No (binary absent) - `launcherAvailable()` returns false; `createBackend` throws the actionable `setupHint`. |

**Verified npm `latest` (via `npm view ... version`):** `@agentclientprotocol/sdk` = **0.25.0**, `@agentclientprotocol/claude-agent-acp` = **0.42.0**, `@zed-industries/codex-acp` = **0.15.0**. **Installed CLIs:** claude 2.1.165, codex 0.136.0, node/npx v22.22.0, gemini present (version probe noisy).

**Practical test order on this machine:** `fake` (always) -> `claude` (most likely to have working creds, real model) -> `codex` via the `@zed-industries/codex-acp` adapter (if OpenAI/ChatGPT auth) -> `gemini` (verify it starts in ACP mode first).

---

## 4. Concrete code changes

### 4a. `package.json` - swap the SDK dependency
```jsonc
// remove:  "@zed-industries/agent-client-protocol": "^0.4.5"
// add:
"@agentclientprotocol/sdk": "^0.25.0"
```
Then update the 7 import sites in `src/acp/types.ts`, `src/acp/transport.ts`, `src/testing/fake-acp-agent.ts` (§2 item 1). No logic changes - the named exports are identical.

### 4b. `src/backend/registry.ts` - fix names + add agents
- **`claude`** `command`: `["npx","-y","@zed-industries/claude-code-acp"]` -> `["npx","-y","@agentclientprotocol/claude-agent-acp"]`. Update the file header comment (it names the old adapter). `authEnv`/`setupHint` stay (already correct).
- **Add `codex`** (primary ACP path):
  ```ts
  codex: {
    name: "codex",
    description: "OpenAI Codex over ACP (Zed adapter).",
    command: ["npx", "-y", "@zed-industries/codex-acp"],
    runnable: false,
    source: "builtin",
    notes:
      "Codex via the official @zed-industries/codex-acp adapter: streaming text, " +
      "tool calls + permission requests, edit review, session modes, loadSession. " +
      "Terminal commands run non-PTY in Codex's own process.",
    authEnv: ["OPENAI_API_KEY", "CODEX_API_KEY"],
    setupHint:
      "Install Node (npx). Authenticate with OPENAI_API_KEY or CODEX_API_KEY, " +
      "or run `codex login` (ChatGPT subscription; not for remote/headless). " +
      "First run downloads @zed-industries/codex-acp via npx.",
  },
  ```
- **Add native-ACP entries** `gemini` (already present), `goose:["goose","acp"]`, `opencode:["opencode","acp"]`, `copilot:["copilot","--acp"]`, `qwen:["qwen","--acp"]`, `cursor:["cursor-agent","acp"]`, `amp:["acp-amp","run"]` - each `runnable:false`, with `authEnv`/`setupHint` per §1. These need no new code: the existing `AcpBackend` drives any stdio ACP agent (08 §9).
- Add `codex`'s adapter name to any reserved-builtin set so config can't shadow it.
- `registry.test.ts`: assert `claude.command` ends with `@agentclientprotocol/claude-agent-acp`, `codex.command` ends with `@zed-industries/codex-acp`, and that `getAgentSpec("codex")` is defined.

### 4c. A native `CodexBackend` - only as a documented fallback
**Recommendation (09 §3): do NOT lead with a native backend.** The `@zed-industries/codex-acp` adapter speaks full ACP, so the existing `AcpBackend` drives it with zero new code; a native backend re-implements session/permission/streaming archon gets for free. Add `CodexBackend` **only** for headless/CI where hosting an ACP transport isn't wanted. If built, it must satisfy the same `AgentBackend` interface (`src/backend/types.ts`):

```ts
// src/backend/codex-backend.ts  (fallback; key="codex-exec")
// Spawns: codex exec --json --skip-git-repo-check "<prompt>"
// Parses newline-delimited JSONL events (09 §2a):
//   item.* (agent_message)         -> AgentUpdateEvent { kind:"message_chunk", role:"assistant", text }
//   item.* (command_execution / file_change / mcp_tool_call) -> { kind:"tool_call", ... }
//   plan updates                   -> { kind:"plan", entries }
//   turn.completed / turn.failed   -> resolve done with stopReason ("end_turn"/"refusal")
// loadSession: map to `codex exec resume <SESSION_ID>` (flags must be re-specified, 09 §2a).
// capabilities: { loadSession:true, promptImage:false, promptAudio:false, setMode:false }.
// LIMIT: one-shot/turn-based; no live mid-turn permission prompts (sandbox fixed at launch).
```
`createBackend` would special-case `agent === "codex-exec"` to construct `CodexBackend` instead of `AcpBackend`. Prefer `@openai/codex-sdk` over JSONL parsing if going in-process (OpenAI-recommended for CI - 09 §2c), but JSONL keeps the subprocess model uniform with the rest of archon.

---

## 5. Test / verification plan - PROVE a real model reply (not the fake string)

The discriminator is exact: the `fake` agent always streams **`"Hello from the fake ACP agent!"`** (`FAKE_CHUNKS` in `src/testing/fake-acp-agent.ts`). Any other coherent text on stdout through `archon -p` is a real model reply. The `-p` path (`src/cli.ts` -> `runHeadlessPrompt`) writes only `message_chunk` events with `role==="assistant"` to stdout, so a clean stdout assertion is valid.

**Step 0 - migrate + typecheck (no network):**
```
bun add @agentclientprotocol/sdk && bun remove @zed-industries/agent-client-protocol
bunx tsc --noEmit && bun test           # registry + transport + e2e (fake) suites pass
```
Expect `registry.test.ts` to confirm the new package names.

**Step 1 - prove the pipe with `fake` (control, NOT a model):**
```
archon -p "ping" --agent fake --in-process
# stdout MUST equal: Hello from the fake ACP agent!
```
This proves transport + `-p` plumbing end-to-end. Treat this exact string as the **negative** signal in later steps - a real agent must NOT print it.

**Step 2 - REAL model via Claude (highest-confidence on this host):**
```
ANTHROPIC_API_KEY=...  archon -p "Reply with exactly the single word: BANANA" \
  --agent claude --in-process
# PASS iff stdout contains "BANANA" AND does not contain "fake ACP agent"
ARCHON_DEBUG=1 ...   # also prints stopReason=end_turn agent=claude on stderr
```
Use a low-entropy challenge ("reply with exactly BANANA", or "what is 17*23" -> 391) so the assertion is unambiguous and can't be produced by the deterministic fake. A correct, prompt-specific answer = proof the real model ran (the adapter spawned `@agentclientprotocol/claude-agent-acp`, negotiated ACP v1, streamed `agent_message_chunk`).

**Step 3 - REAL model via Codex (adapter path):**
```
OPENAI_API_KEY=...  archon -p "What is 17*23? Reply with only the number." \
  --agent codex --in-process     # spawns npx @zed-industries/codex-acp
# PASS iff stdout contains "391"
```
If only ChatGPT-sub auth is available, run locally (not remote) - sub auth fails in remote/headless (09 §1a).

**Step 4 - REAL model via Gemini (verify ACP-mode start first):**
```
# pre-flight: confirm it actually enters ACP mode, not interactive-hang
gemini --experimental-acp <<<'' &   # should speak JSON-RPC on stdout, not a prompt
GEMINI_API_KEY=...  archon -p "Reply with exactly the word: ORCHID" --agent gemini --in-process
# PASS iff stdout contains "ORCHID"
```
Watch the macOS subprocess-login prompt (07 §2): if archon-spawned `gemini` demands login while a TTY-launched one doesn't, that's the known gotcha, not an archon bug.

**Step 5 - prove it in the TUI (not just `-p`):**
Launch `archon` (interactive, terminal >= 30 rows), create a session against `claude`, send the same "reply with exactly BANANA" prompt, and confirm the streamed assistant text appears in the transcript pane and the session glyph transitions running->idle on `stopReason=end_turn`. This exercises the same `AgentBackend.prompt()` handle the daemon uses, proving the fleet surface (not only the headless path) drives a real model.

**Automated regression (CI-safe):** keep the `fake`-agent e2e test as the always-green pipe check. Gate the Claude/Codex/Gemini real-model tests behind env presence (`if (!process.env.ANTHROPIC_API_KEY) test.skip(...)`) so the suite stays green offline but proves real replies whenever creds exist. Assert both conditions every time: **(a)** output contains the challenge answer, **(b)** output does **not** contain `"fake ACP agent"`.

---

## Executive summary

archon already implements the ACP **client half** (`ClientSideConnection` + `ndJsonStream` in `src/acp/`, fronted by `AgentBackend`), so the entire integration is a spawn-command registry plus a one-time package migration: move off the deprecated `@zed-industries/agent-client-protocol@0.4.5` to **`@agentclientprotocol/sdk@0.25.0`** (same API, just renamed) and off the deprecated `@zed-industries/claude-code-acp` to **`@agentclientprotocol/claude-agent-acp@0.42.0`** for the `claude` entry. Codex has no native ACP, so wire it primarily through the official **`@zed-industries/codex-acp@0.15.0`** adapter (drives via the existing `AcpBackend` with zero new code) and only add a thin native `CodexBackend` (`codex exec --json`) as a headless/CI fallback. On this machine, `fake`, `claude` (Claude Code + npx present), `gemini` (binary present), and `codex` via the npx adapter are all end-to-end testable now - the locally installed `codex` 0.136.0 is itself non-ACP, which is exactly why the adapter is required. Proof of a real model reply (vs. the fake agent's fixed `"Hello from the fake ACP agent!"`) is a low-entropy challenge through `archon -p` - e.g. `archon -p "reply with exactly BANANA" --agent claude --in-process` - asserting the output contains the answer and never the fake string, then repeating it in the TUI transcript.

### Exact registry spawn commands
```
fake       bun run <.../testing/fake-acp-agent.ts>          # bundled, no creds (NOT a model)
claude     npx -y @agentclientprotocol/claude-agent-acp     # 0.42.0 ; ANTHROPIC_API_KEY | CLAUDE_CODE_OAUTH_TOKEN
gemini     gemini --experimental-acp                        # @google/gemini-cli 0.45.1 ; GEMINI_API_KEY | oauth-personal
codex      npx -y @zed-industries/codex-acp                 # 0.15.0 ; OPENAI_API_KEY | CODEX_API_KEY | ChatGPT login
codex-exec codex exec --json "<prompt>"                     # @openai/codex 0.137.x fallback (non-ACP, headless/CI)
goose      goose acp                                         # native ; provider keys via goose config
opencode   opencode acp                                      # native ; opencode auth / provider keys
copilot    copilot --acp                                     # @github/copilot 1.0.59 ; GitHub Copilot sub
qwen       qwen --acp                                         # @qwen-code/qwen-code 0.17.1 (Node>=22) ; OPENAI_API_KEY | Qwen OAuth
cursor     agent acp                                          # bin cursor-agent ; cursor_login (no session/load)
amp        acp-amp run                                        # @superagenticai/acp-amp 0.1.0 bridge ; paid Amp credits
generic    (empty - supplied at runtime via --acp-cmd "<argv>")
```
