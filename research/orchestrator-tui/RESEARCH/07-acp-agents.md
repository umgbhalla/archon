# 07 — ACP Agents: who archon can drive

> **Scope:** Every coding agent that implements the **Agent Client Protocol (ACP, [agentclientprotocol.com](https://agentclientprotocol.com))** on the **agent side** as of **2026-06-05**, so that a *client* (archon's orchestrator TUI) can spawn it over stdio and drive it. ACP is the LSP-for-agents standard: editor/client ↔ agent over **JSON-RPC 2.0 on stdio**. Both MCP and ACP now sit under the **Agentic AI Foundation (AAIF)** in the Linux Foundation. Current stable protocol version: **1** (schema paths are `/protocol/v1/...`). Sources: [ACP introduction](https://agentclientprotocol.com/get-started/introduction), [protocol overview](https://agentclientprotocol.com/protocol/overview), [Zed ACP progress report](https://zed.dev/blog/acp-progress-report).

## How archon drives an ACP agent (the model)

An ACP client spawns the agent as a child process and speaks JSON-RPC over its stdin/stdout. Core flow (verified against the [protocol overview](https://agentclientprotocol.com/protocol/overview)):

1. `initialize` (client sends `protocolVersion: 1` + its client capabilities) → agent replies with `agentCapabilities` (incl. `loadSession`, `auth.logout`, prompt content types).
2. `authenticate` (e.g. `method_id: "oauth-personal"` for Gemini, `cursor_login` for Cursor) — only if the agent advertises an auth method.
3. `session/new` (with `cwd`, MCP servers) → `sessionId`. `session/load` if `loadSession` is supported (resume).
4. `session/prompt` → agent streams `session/update` notifications (text, tool calls, plans/TODOs, diffs).
5. Client-served capabilities the agent calls back into: `fs/read_text_file` + `fs/write_text_file`, `terminal/create|output|wait_for_exit|kill|release`, `session/request_permission`, `session/set_mode`.

**Design takeaway for archon:** implement the *client* half — most usefully `fs`, `terminal`, and `session/request_permission` — once, then point it at any binary below. The spawn-command table is the whole integration surface.

---

## Quick reference — spawn commands

| Agent | Spawn command (verbatim) | Package / binary @ version (2026-06-05) | Native ACP? | Auth |
|---|---|---|---|---|
| **Claude (Agent SDK)** | `npx @agentclientprotocol/claude-agent-acp` | npm `@agentclientprotocol/claude-agent-acp` **0.42.0** (bin: `claude-agent-acp`) | adapter (official, Zed/AAIF) | `ANTHROPIC_API_KEY` **or** Claude subscription via `CLAUDE_CODE_OAUTH_TOKEN` / login |
| **Gemini CLI** | `gemini --experimental-acp` | npm `@google/gemini-cli` **0.45.1** (bin: `gemini`) | native | OAuth (`oauth-personal`) or `GEMINI_API_KEY` |
| **Goose** | `goose acp` | block/goose (Rust binary `goose`); also `goose serve` (HTTP) | native | provider keys via goose config |
| **opencode** | `opencode acp` | npm/binary `opencode` (sst/opencode) | native | provider keys / `opencode auth` |
| **Codex CLI** | `npx @zed-industries/codex-acp` or `codex-acp` | npm `@zed-industries/codex-acp` **0.15.0** (bin: `codex-acp`) | adapter (official, Zed) | ChatGPT subscription, `CODEX_API_KEY`, or `OPENAI_API_KEY` |
| **GitHub Copilot CLI** | `copilot --acp` (add `--port 8080` for TCP) | npm `@github/copilot` **1.0.59** (bin: `copilot`) | native (public preview) | GitHub Copilot subscription / `gh` auth |
| **Cursor CLI** | `agent acp` (binary `cursor-agent`) | install `curl https://cursor.com/install -fsSL \| bash` | native | `cursor_login` (Cursor account) |
| **Qwen Code** | `qwen --acp` (legacy: `--experimental-acp`) | npm `@qwen-code/qwen-code` **0.17.1** (bin: `qwen`) | native | OpenAI-compatible env (`OPENAI_API_KEY`/`BASE_URL`/`MODEL`) or Qwen OAuth |
| **Amp (Sourcegraph)** | `acp-amp run` or `npx @superagenticai/acp-amp` | npm `@superagenticai/acp-amp` **0.1.0** (3rd-party bridge) | **no native** — community bridge | paid Amp credits (free credits rejected) |
| **Aider** | community bridge (`aider-acp`), wraps `aider` CLI | jorgejhms/aider-acp (no published binary) | **no native** — bridge, partial | provider keys via aider |
| **Zed's own (Claude/Codex)** | n/a — Zed *is* the client; it bundles the adapters above | — | n/a | per adapter |

---

## 1. Claude — `@agentclientprotocol/claude-agent-acp` (official adapter)

- **Spawn:** `npx @agentclientprotocol/claude-agent-acp` (settings.json-style: `"command": "npx", "args": ["@agentclientprotocol/claude-agent-acp"]`). Binary name when installed globally: `claude-agent-acp`.
- **Package + version:** npm `@agentclientprotocol/claude-agent-acp`, **latest 0.42.0**, published **2026-06-05** (verified against the npm registry). Implements an ACP agent on top of the official **Claude Agent SDK** (`@anthropic-ai/claude-agent-sdk`).
- **RENAME — confirmed (this is the one the task flagged):** the package moved twice. The chain, all verified on npm:
  - `@zed-industries/claude-code-acp` (last 0.16.2, **deprecated**) →
  - `@zed-industries/claude-agent-acp` (last 0.23.1, **deprecated**) →
  - **`@agentclientprotocol/claude-agent-acp` (current, 0.42.0)**.
  Both old packages carry the npm deprecation notice: *"This package has been renamed to @agentclientprotocol/claude-agent-acp. Please migrate to continue receiving updates."* Use the `@agentclientprotocol/...` name. Sources: [npm rename notice](https://www.npmjs.com/package/@zed-industries/claude-code-acp), [agent-shell migration issue #305](https://github.com/xenodium/agent-shell/issues/305), [repo](https://github.com/agentclientprotocol/claude-agent-acp).
- **Auth/env:** either `ANTHROPIC_API_KEY`, **or** a Claude Pro/Max subscription via the Claude Code OAuth login (`CLAUDE_CODE_OAUTH_TOKEN`). Uses `CLAUDE_CONFIG_DIR` to locate config (introduced alongside the SDK switch). ([Zed external-agents docs](https://zed.dev/docs/ai/external-agents) say "add your Anthropic API key".)
- **Capabilities:** rich — context @-mentions, images, tool calls **with permission requests**, "Following", edit review, TODO lists, **interactive + background terminals**, custom slash commands, client MCP servers (from the [README](https://github.com/agentclientprotocol/claude-agent-acp/blob/main/README.md)). Implies `fs`, `terminal`, `permissions`, and session updates.
- **Maturity:** **High.** Official, AAIF-scoped, version churn is steady (0.42 today). The reference Claude integration.
- **Gotcha:** the ACP **registry** has at least once pointed at an unpublished version (`@agentclientprotocol/claude-agent-acp@0.25.3`) → install failures in Zed ([zed#53309](https://github.com/zed-industries/zed/issues/53309)). If pinning a version, confirm it exists on npm first.

## 2. Gemini CLI — native (`gemini --experimental-acp`)

- **Spawn:** `gemini --experimental-acp`. settings.json: `"command": "/path/to/gemini", "args": ["--experimental-acp"]`. Add `--model <id>` (e.g. `--model gemini-2.5-flash`) and `--yolo` to skip confirmations. The very first ACP integration shipped by Zed.
- **Package + version:** npm `@google/gemini-cli`, **latest 0.45.1** (published 2026-06-05), bin `gemini`. ([repo](https://github.com/google-gemini/gemini-cli))
- **Auth/env:** `authenticate` with `method_id: "oauth-personal"` (Google login), or `GEMINI_API_KEY`. ([ACP mode docs](https://geminicli.com/docs/cli/acp-mode/))
- **Capabilities:** `--allowed-mcp-server-names`, `--allowed-tools` (auto-approve), MCP via `use_idea_mcp`. ACP v1.
- **Flag naming gotcha:** official docs mention `--acp`, but **every real integration uses `--experimental-acp`** — use that. ([glaforge IntelliJ guide](https://glaforge.dev/posts/2026/02/01/how-to-integrate-gemini-cli-with-intellij-idea-using-acp/))
- **Spawn gotchas:** (1) Launching from a **subprocess** can trigger a spurious login prompt even with cached creds on macOS, while a TTY does not ([gemini-cli#12042](https://github.com/google-gemini/gemini-cli/issues/12042)). (2) Omitting the flag → CLI starts interactive and **hangs**. (3) `nvm` path must point at the concrete version. (4) A `.gemini/settings.json` with `modelConfigs.customAliases` causes `Internal error` in ACP mode ([#18423](https://github.com/google-gemini/gemini-cli/issues/18423)).
- **Maturity:** **High**, but the flag is still nominally "experimental."

## 3. Goose (Block) — native (`goose acp`)

- **Spawn:** `goose acp` (settings: `"command": "/Users/<you>/.local/bin/goose", "args": ["acp"]`). Also `goose serve` to expose ACP over HTTP/WebSocket.
- **Package/binary:** block/goose Rust binary `goose`. Listed in the ACP Agent Registry, so Zed/JetBrains can auto-install it.
- **Auth/env:** provider keys configured via goose's own config (it is multi-provider).
- **Capabilities:** native ACP **in both directions** — Goose is both an ACP *agent* and an ACP *client* (its "ACP providers" let Goose orchestrate Claude/Codex/Copilot/Gemini/Amp/Pi, passing goose extensions through as MCP servers). Project is consolidating its three Rust binaries onto one ACP-speaking binary. Sources: [Goose ACP discussion #7309](https://github.com/block/goose/discussions/7309), [ACP providers guide](https://goose-docs.ai/docs/guides/acp-providers/).
- **Maturity:** **High.** First-class, native, actively converging on ACP as primary interface.
- **Note for archon:** Goose-as-client is itself a study reference for the orchestrator (it does the fan-out archon wants). The repo is also a `context/` submodule candidate.

## 4. opencode (SST) — native (`opencode acp`)

- **Spawn:** `opencode acp`. settings.json: `"command": "opencode", "args": ["acp"]` (JetBrains wants an absolute path: `/abs/path/bin/opencode`).
- **Package/binary:** `opencode` (sst/opencode); 120K+ stars, 75+ LLM providers.
- **Auth/env:** provider keys / `opencode auth`; no extra ACP-specific auth.
- **Capabilities:** tools, custom commands, MCP servers, project rules, formatters/linters, agents, **permissions**. Gotcha: built-in `/undo` and `/redo` slash commands are **unsupported over ACP**. ([opencode ACP docs](https://opencode.ai/docs/acp/))
- **Maturity:** **High.** Production OpenTUI app; behaves the same over ACP as in the terminal. Already a `context/` submodule.

## 5. Codex CLI — `@zed-industries/codex-acp` (official adapter)

- **Spawn:** `npx @zed-industries/codex-acp`, or run the prebuilt binary `codex-acp` (e.g. `OPENAI_API_KEY=sk-... codex-acp`). Prebuilt binaries on the [releases page](https://github.com/zed-industries/codex-acp/releases).
- **Package + version:** npm `@zed-industries/codex-acp`, **latest 0.15.0** (published 2026-05-22), bin `codex-acp`.
- **Auth/env (three options):** ChatGPT subscription (does **not** work in remote projects), `CODEX_API_KEY`, or `OPENAI_API_KEY`.
- **Capabilities:** @-mentions, images, tool calls + permission requests, edit review, TODO lists, client MCP, "Following"; slash commands `/review`, `/review-branch`, `/review-commit`, `/init`, `/compact`, `/logout`. ([repo](https://github.com/zed-industries/codex-acp))
- **Maturity:** **High** (official Zed adapter, bundled in Zed). This adapter is *not* yet migrated to the `@agentclientprotocol` scope — still under `@zed-industries`.

## 6. GitHub Copilot CLI — native (`copilot --acp`)

- **Spawn:** `copilot --acp` (stdio inferred; `--stdio` to disambiguate). TCP: `copilot --acp --port 8080`.
- **Package + version:** npm `@github/copilot`, **latest 1.0.59** (published 2026-06-04), bin `copilot`.
- **Auth/env:** GitHub Copilot subscription (GitHub auth / `gh`).
- **Capabilities:** sessions with custom cwd, prompts with text/images/context resources, streaming updates, `session/request_permission`, cancel/lifecycle. In ACP mode `--available-tools`/`--excluded-tools` and `--effort`/`--reasoning-effort` apply per session (a June 1 2026 release fixed these + the `allow_all` config). ([changelog 2026-01-28](https://github.blog/changelog/2026-01-28-acp-support-in-copilot-cli-is-now-in-public-preview/), [ACP server docs](https://docs.github.com/en/copilot/reference/copilot-cli-reference/acp-server))
- **Maturity:** **Public preview** (since 2026-01-28), "subject to change," but actively patched and from a first party. Copilot SDK went GA 2026-06-02.

## 7. Cursor CLI — native (`agent acp`)

- **Spawn:** `agent acp` (the binary is also called `cursor-agent`; subcommand `acp` runs the stdio JSON-RPC server). Install: `curl https://cursor.com/install -fsSL | bash`; verify `cursor-agent --version`.
- **Auth/env:** advertises ACP auth method `cursor_login` (Cursor account).
- **Capabilities:** `session/request_permission` (if the client ignores it, tools **block**); MCP via project/user `.cursor/mcp.json` (team-level dashboard MCP **not** supported in ACP). Cursor-specific **extension methods**: blocking `cursor/ask_question`, `cursor/create_plan`; notifications `cursor/update_todos`, `cursor/task`, `cursor/generate_image`. ([Cursor ACP docs](https://cursor.com/docs/cli/acp))
- **Gotcha:** native Cursor ACP on the validated CLI does **not** expose `session/list`, `session/resume`, or `session/set_model` (per the [raphaelluethy/cursor-acp](https://github.com/raphaelluethy/cursor-acp) hybrid adapter notes) — so no loadSession-style resume natively yet.
- **Maturity:** **Medium-High** native; several community adapters exist (roshan-c, blowmage, aLittlecrocodile) for richer tool-call detail.

## 8. Qwen Code — native (`qwen --acp`)

- **Spawn:** `qwen --acp` (preferred). Legacy `qwen --experimental-acp` is **deprecated** ([#1350](https://github.com/QwenLM/qwen-code/issues/1350)). settings: `"command": "npx", "args": ["@qwen-code/qwen-code@latest", "--acp"]`, or `node .../node_modules/@qwen-code/qwen-code/cli.js --acp`. Daemon alternative: `qwen serve` (ACP over HTTP+SSE, shared session).
- **Package + version:** npm `@qwen-code/qwen-code`, **latest 0.17.1** (published 2026-06-05), bin `qwen`. Needs **Node ≥ 22**.
- **Auth/env:** set `auth_method = "openai"` + `OPENAI_API_KEY`/`OPENAI_BASE_URL`/`OPENAI_MODEL`, or Qwen OAuth. ([repo](https://github.com/QwenLM/qwen-code))
- **Gotchas:** (1) `--acp` starts **ACP v1**, which is **incompatible with JetBrains 2025.3+ (expects ACP v2)** → "Method not found" ([#1502](https://github.com/QwenLM/qwen-code/issues/1502)) — *but archon is its own client at v1, so fine.* (2) Windows "program not found" with `command: "qwen"` → use `npx` or full `cli.js` path ([zed#41196](https://github.com/zed-industries/zed/issues/41196)).
- **Maturity:** **High** (native, frequent releases). Note the protocol-version skew is worth watching.

## 9. Amp (Sourcegraph) — **no native ACP**; community bridge only

- **Status:** Amp does **not** ship an `amp acp` / `amp --acp` command. Sourcegraph CEO Quinn Slack has publicly argued adopting ACP now would *"limit our ability to change and improve the product."* So no official support.
- **Bridge spawn:** `acp-amp run`, or `npx @superagenticai/acp-amp`. Install `uv tool install acp-amp` (Python) or `npm install -g @superagenticai/acp-amp` (Node). settings: `"command": "acp-amp", "args": ["run"]`.
- **Package + version:** npm `@superagenticai/acp-amp` **0.1.0** (published 2026-01-30) — early, third-party, single-maintainer.
- **Auth/env:** **paid Amp credits required** — free credits are rejected over ACP. ([acp-amp repo](https://github.com/SuperagenticAI/acp-amp), [intro post](https://dev.to/shashikant86/introducing-acp-bridge-to-amp-code-50kc))
- **Maturity:** **Low / experimental** (bridge, 0.1.0). Drivable, but treat as best-effort.

## 10. Aider — **no native ACP**; partial community bridge

- **Status:** Aider has **no first-party ACP**. Zed's progress report listed an Aider impl as "underway" (Oct 2025); not shipped as a built-in. Practical route is the community **`aider-acp`** bridge ([jorgejhms/aider-acp](https://github.com/jorgejhms/aider-acp)), which spawns `aider` CLI as a subprocess and speaks ACP over stdio.
- **Capabilities (bridge):** basic ACP loop (initialize + session + prompt/response), subprocess file editing, streaming `session/update`. Diff to ACP-edit parsing, model selection, file context, slash commands are **planned, not done**.
- **Maturity:** **Low / partial.** Not a published binary; clone-and-run. Lowest priority for archon.

## 11. Zed's own agents — Zed is the *client*, not an agent

Zed authored ACP and is the canonical **client**. Its "own" agents are exactly the adapters above that it bundles (`@agentclientprotocol/claude-agent-acp`, `@zed-industries/codex-acp`) plus the registry of third-party agents. There is no separate "Zed agent" binary for archon to spawn — archon plays the same role Zed does. Reference: [Zed external agents](https://zed.dev/docs/ai/external-agents), [zed.dev/acp](https://zed.dev/acp).

---

## Other agents in the official directory (breadth, lower priority)

The [official agents page](https://agentclientprotocol.com/overview/agents) also lists, as of 2026-06-05: **AgentPool, Augment Code (Auggie)**, AutoDev, Blackbox AI, **Bub** (via `bub-acp-server`), Cline, Code Assistant, crow-cli, **Docker cagent**, fast-agent, **Factory Droid**, fount, Hermes Agent (Nous), **Junie (JetBrains)**, **Kimi CLI (Moonshot)**, **Kiro CLI (AWS)**, Minion Code, **Mistral Vibe**, **OpenClaw**, **OpenHands**, **Pi** (via `pi-acp`), **Poolside**, Qoder CLI, siGit Code, **Stakpak**, stdio Bus, **VT Code**. The high-signal additions for archon to validate next: **Auggie** (in the Zed/JetBrains registry), **Kiro CLI** (AWS, `kiro.dev/docs/cli/acp`), **OpenHands**, **Mistral Vibe**, and **cagent** (Docker). The **ACP Agent Registry** (co-launched by Zed + JetBrains, Jan 2026) is the machine-readable source of truth for spawn commands — archon should consume it directly rather than hard-coding this table.

---

## Bottom line for archon

- **Build the client half once** (`initialize` -> `session/new` -> `session/prompt` + serve `fs` / `terminal` / `request_permission` / `set_mode`), targeting **protocol v1**.
- **Tier 1 (real, native, drivable today):** Gemini CLI, Goose, opencode, GitHub Copilot CLI (preview), Cursor CLI, Qwen Code.
- **Tier 1 via official adapter:** Claude (`@agentclientprotocol/claude-agent-acp` 0.42.0), Codex (`@zed-industries/codex-acp` 0.15.0).
- **Tier 2 (community bridge, best-effort):** Amp (`acp-amp` 0.1.0), Aider (`aider-acp`).
- **Watch:** Qwen/JetBrains ACP-v1-vs-v2 skew; the registry sometimes pins unpublished versions; Gemini subprocess login prompt; agents that don't honor `request_permission` will **block**.
