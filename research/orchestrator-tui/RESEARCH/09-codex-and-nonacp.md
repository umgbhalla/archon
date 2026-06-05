# 09 — Integrating OpenAI Codex (and other non-ACP agents) into an ACP-first orchestrator

> **Research date:** 2026-06-05. **Question:** Codex has no *native* ACP — it ships `codex exec` (non-interactive), `codex mcp-server` (Codex as MCP server), `codex app-server` (its real bidirectional protocol), and a TS SDK. How do we add a `codex` backend to an ACP-client orchestrator? Sources are cited inline; commands are quoted verbatim.

---

## TL;DR recommendation

For an ACP-first orchestrator, **wire Codex in via the official `@zed-industries/codex-acp` ACP adapter as the primary path** (`npx @zed-industries/codex-acp`, v0.15.0, May 2026 — production-grade, 800+ stars, used by Zed out of the box). It speaks ACP `session/new|load|prompt|cancel|setMode|setModel` plus permissions/tool-calls, so your existing ACP client code drives it with zero special-casing. **Keep a thin native `CodexBackend` that shells `codex exec --json` as a fallback** for headless/CI contexts where you don't want to host an ACP transport — but do *not* lead with it, because you'd be re-implementing session/permission/streaming semantics the adapter already gives you for free.

---

## 0. The four machine interfaces Codex actually exposes

Codex (`@openai/codex`, **v0.137.0** as of 2026-06-04, Rust binary in an npm wrapper, ships ~weekly; install `npm install -g @openai/codex`) has **no native ACP server**. It exposes four programmatic surfaces ([npm](https://www.npmjs.com/package/@openai/codex), [CLI docs](https://developers.openai.com/codex/cli)):

| Surface | What it is | Transport | Best for |
|---|---|---|---|
| `codex exec` | Non-interactive one-shot / resume | stdout (text or JSONL) | CI, simple shell-out backends |
| `codex mcp-server` (`codex mcp`) | Codex **as** an MCP server (tool-oriented) | stdio JSON-RPC | exposing Codex as a tool to other agents |
| `codex app-server` | The **real** bidirectional protocol powering CLI/VS Code/web/JetBrains/Xcode | stdio / ws / unix JSON-RPC 2.0 | full-fidelity IDE-style integration |
| `@openai/codex-sdk` | TypeScript SDK wrapping the above | in-process Node | programmatic control, CI automation |

Key architectural fact: OpenAI **tried MCP for the VS Code extension and rejected it** — "streaming diffs, approval flows, and thread persistence did not map cleanly onto MCP's tool-oriented model" — and built the **App Server** instead, which now powers every Codex surface ([InfoQ](https://www.infoq.com/news/2026/02/opanai-codex-app-server/), [App Server docs](https://developers.openai.com/codex/app-server)). This is *why* a good ACP bridge targets `app-server` (rich session semantics), not `mcp-server`.

---

## 1. ACP ↔ Codex bridge / adapter projects (community + official shims)

### 1a. `@zed-industries/codex-acp` — **the official bridge (RECOMMENDED)**

- **Name / spawn:** `npx @zed-industries/codex-acp` (or set `OPENAI_API_KEY=sk-... codex-acp`). It's a Rust binary distributed on npm with platform-specific native binaries (macOS/Linux/Windows). ([repo](https://github.com/zed-industries/codex-acp), [Zed blog](https://zed.dev/blog/codex-is-live-in-zed))
- **Package + version:** `@zed-industries/codex-acp`, **v0.15.0 (2026-05-22)**. 56 releases, ~821 stars, actively maintained.
- **Auth/env:** `OPENAI_API_KEY` *or* `CODEX_API_KEY` *or* a ChatGPT subscription (Plus/Pro/Business/Edu/Enterprise include Codex). **Codex owns its own auth/billing** — an OpenAI key configured for the *host* does not auto-configure Codex; `codex login` / `~/.codex/config.toml` remain authoritative ([Zed external-agents docs](https://zed.dev/docs/ai/external-agents)).
- **ACP capabilities:** context mentions + image handling, tool invocation with **permission requests**, session following, edit review, terminal/fs operations (Codex runs terminal commands in **its own process, non-PTY mode** to avoid deadlocks like `git rebase` waiting on an editor — a deliberate divergence from other ACP agents per the Zed blog). Slash commands: `/review`, `/review-branch`, `/review-commit`, `/init`, `/compact`, `/logout`. Client MCP-server integration.
- **Maturity:** production. Zed ships it out of the box; also reachable via the **ACP Registry** (Zed + JetBrains, Jan 2026) ([ACP registry blog](https://zed.dev/blog/acp-registry)).
- **Gotchas:** ChatGPT-subscription auth "doesn't work in remote projects" (use an API key for remote/headless); debug via Zed's `dev: open acp logs` (raw JSON-RPC).

### 1b. `cola-io/codex-acp` — feature-rich Rust alternative

- **Spawn:** the `codex-acp` binary (no flags; configured via env). **v0.4.2 (2026-01-06)**, Rust 2024 / MSRV 1.91+, ~140 stars. ([repo](https://github.com/cola-io/codex-acp))
- **Auth/env:** `OPENAI_API_KEY` (optional), ChatGPT login via `codex login`, or custom provider creds. Logging: `RUST_LOG`, `CODEX_LOG_FILE`, `CODEX_LOG_DIR`, `CODEX_LOG_STDERR`.
- **ACP capabilities (most explicit list of any bridge):** `initialize`, `authenticate`, `session/new`, `session/load` (**loadSession ✓**), `session/prompt`, `session/cancel`, `session/setMode`, `session/setModel`. Bundles an **internal MCP filesystem server (`acp_fs`, via rmcp)** so Codex reads/writes through ACP tooling instead of raw shell. Session modes: `read-only`, `auto` (default), `full-access`. Streams assistant messages, reasoning, token counts, tool calls as `session/update`.
- **Gotchas:** explicitly "under active development — breaking changes likely"; falls back to local disk if client lacks ACP fs support; read-only mode disables write tools; custom-provider model switching is restricted to `{provider}@{model}` format; single-threaded Tokio `LocalSet`; **terminal capability + a formal permissions framework not documented.**

### 1c. `beyond5959/acp-adapter` — Go, multi-backend (Codex / Claude / Pi)

- **Spawn:** `acp-adapter --adapter codex` (default), `acp-adapter --adapter claude`, `acp-adapter --adapter pi --pi-provider openai-codex --pi-model gpt-5.4-mini`. Install: `curl -sSL https://raw.githubusercontent.com/beyond5959/acp-adapter/master/install.sh | sh` → `/usr/local/bin/acp-adapter`. **v0.3.7 (2026-04-09)**, ~86 commits. ([repo](https://github.com/beyond5959/acp-adapter))
- **How it drives Codex:** internally runs **`codex app-server` over stdio JSON-RPC** — "most complete backend, including MCP routing." (Claude backend uses `claude -p ... --output-format stream-json`; Pi uses `pi --mode rpc`.)
- **Auth/env:** Codex accepts `codex_api_key`, `openai_api_key`, or `chatgpt_subscription`.
- **ACP capabilities:** full `initialize`/`authenticate`/`session/*`, partial `fs/read_text_file`; exposes thoughts as chunks, usage, config options, plans, reasoning. **Gap:** neither backend bridges ACP HTTP-MCP or SSE-MCP transports. Can run standalone *or* embedded as a Go library.
- **Why interesting for us:** it's a working reference for a **single adapter fronting multiple non-ACP CLIs** — the exact pattern an orchestrator wants if it standardizes on ACP internally.

### 1d. Adjacent (not a direct orchestrator path, noted for completeness)

- **AI SDK community provider** `@mcpc-tech/acp-ai-provider` — bridges ACP agents (Claude Code, Gemini CLI, Codex CLI, etc.) to the Vercel AI SDK `LanguageModel` interface ([ai-sdk.dev](https://ai-sdk.dev/providers/community-providers/acp)). For web/Node apps, not a TUI orchestrator.
- **OpenACP** (`Open-ACP/OpenACP`) — self-hosted bridge exposing 28+ ACP agents to Telegram/Discord/Slack ([repo](https://github.com/Open-ACP)). Messaging fan-out, not our use case, but proof ACP is the consolidation layer the ecosystem converged on.

---

## 2. Driving Codex WITHOUT ACP (native backend options)

### 2a. `codex exec` — the shell-out path (simplest native backend)

Verbatim flags ([non-interactive docs](https://developers.openai.com/codex/noninteractive)):

- `codex exec --json "summarize the repo structure"` — newline-delimited **JSONL**, one event per state change. Event types: `thread.started`, `turn.started`, `turn.completed`, `turn.failed`, `item.*`, `error`. Item types: agent messages, reasoning, command executions, file changes, MCP tool calls, web searches, plan updates.
- `--output-schema ./schema.json` — enforce a JSON Schema on the final response (stable machine-readable fields).
- `-o, --output-last-message <path>` — write final message to file (also prints to stdout).
- `codex exec resume <SESSION_ID>` / `codex exec resume --last` — resume a session; **flags must be re-specified**, e.g. `codex exec --model gpt-5 --json resume --last "Fix use-after-free issues"`.
- Execution control: `--sandbox <read-only|workspace-write|danger-full-access>`, `--model <name>`, `--ephemeral` (skip persisting rollout), `--skip-git-repo-check`, `--ignore-user-config`, `--ignore-rules`.
- Stdin: `codex exec -` reads the full prompt from stdin; piped input (`cmd | codex exec "instruction"`) is treated as context.
- **Auth:** `CODEX_API_KEY=...` inline (single-run, exec-only) or reuse saved CLI auth.
- **Default (no `--json`):** progress → stderr, only final message → stdout (easy `tee`/pipe).
- Per-session JSONL rollouts are auto-written to `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-*.jsonl` (issue [#2288](https://github.com/openai/codex/issues/2288) requested a merged-trajectory `--json-log`; not yet shipped).

**Orchestrator mapping:** parse `--json` JSONL → map `item.*` (command_execution, file_change, mcp_tool_call) onto your run-inspector's tool/span model; `turn.*` → phase boundaries; persist `thread_id`/`SESSION_ID` for resume. **Limitation: `exec` is one-shot/turn-based — no live bidirectional permission prompts mid-turn** (sandbox level is fixed at launch). Fine for autonomous/CI runs, weak for interactive fleet review.

### 2b. `codex app-server` — the full native protocol (best non-ACP fidelity)

JSON-RPC 2.0, bidirectional (MCP-like) ([app-server docs](https://developers.openai.com/codex/app-server), [README](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md)):

- Start: `codex app-server` (default stdio) · `codex app-server --stdio` · `codex app-server --listen ws://127.0.0.1:4500` (experimental) · `codex app-server --listen unix://` (HTTP Upgrade handshake) · `--listen off`.
- Handshake: `initialize` → `initialized` notification → start thread → start turn → read notifications. Resume a thread with its initial turns page; richer MCP-server status.
- **Generate typed bindings:** `codex app-server generate-ts --out ./schemas` and `codex app-server generate-json-schema --out ./schemas` (output is **version-pinned to the Codex you ran**).

This is what `beyond5959/acp-adapter` drives under the hood. A native `CodexBackend` could target `app-server` directly to get streaming diffs + approval flows + thread persistence — but you'd be **re-implementing the exact ACP-translation the Zed adapter already ships**.

### 2c. `@openai/codex-sdk` — TypeScript SDK (best in-process native control)

- `npm install @openai/codex-sdk`, **Node 18+**, server-side ([SDK docs](https://developers.openai.com/codex/sdk)):
  ```ts
  import { Codex } from "@openai/codex-sdk";
  const codex = new Codex();
  const thread = codex.startThread();
  const result = await thread.run("Make a plan to diagnose and fix the CI failures");
  ```
- `run()` again to continue; `resumeThread(threadId)` to resume. OpenAI **explicitly recommends the SDK over non-interactive mode for automating jobs / running in CI.** For a TS orchestrator this is the most ergonomic native option (no JSONL parsing, no subprocess management).

### 2d. The inverse — driving Codex *via* MCP (`codex mcp-server`)

`codex mcp` / `codex mcp-server` exposes Codex **as an MCP server** so another agent can call it as a tool ([MCP docs](https://developers.openai.com/codex/mcp)). Codex is **also an MCP client** — configure downstream MCP servers in `~/.codex/config.toml` under `[mcp_servers.<name>]` (`command`, `args`, `enabled`). For an *ACP-client* orchestrator this inverse path is the **weakest fit**: it's tool-oriented (the model OpenAI rejected for IDE semantics), so you lose streaming diffs/approvals/thread persistence. Only relevant if the orchestrator already speaks MCP-client and wants Codex as one tool among many.

---

## 3. Decision: ACP adapter vs native `CodexBackend`

| Criterion | `@zed-industries/codex-acp` (ACP adapter) | Native `CodexBackend` (`codex exec`/SDK) |
|---|---|---|
| Orchestrator code reuse | **Reuses ACP client as-is** (no special-case) | New backend interface + mapping layer |
| Session/load/resume | ✓ `session/load` | ✓ (`resume`, `resumeThread`) |
| Live permissions mid-turn | ✓ permission requests | ✗ exec (fixed sandbox) / partial SDK |
| Streaming tool-calls/diffs | ✓ `session/update` | manual JSONL parse / SDK events |
| Modes (read-only/auto/full) | ✓ `setMode` (cola variant explicit) | `--sandbox` at launch only |
| Headless/CI ergonomics | needs ACP transport hosted | **excellent** (SDK is OpenAI-recommended) |
| Maintenance burden | low (Zed maintains) | you maintain the mapping |
| Maturity | production (v0.15.0) | stable CLI/SDK |

**Conclusion:** primary = **ACP adapter**, fallback = **thin native `codex exec --json` (or `@openai/codex-sdk`) backend** for headless contexts. This keeps the orchestrator ACP-first while giving a degraded-but-simple path where hosting an ACP transport isn't worth it.

---

## 4. Reference: ACP-agent spawn commands for the orchestrator's registry

Verbatim launch commands per agent (for an `agent_servers`-style registry):

| Agent | Spawn command (verbatim) | Package + version | Auth/env | ACP support | Maturity |
|---|---|---|---|---|---|
| **Claude (Anthropic)** | `npx @agentclientprotocol/claude-agent-acp` | npm `@agentclientprotocol/claude-agent-acp` | `ANTHROPIC_API_KEY` or Claude subscription | native ACP (fs, terminal, permissions, modes, loadSession) | production (Zed/JetBrains) |
| **Gemini CLI (Google)** | `gemini --experimental-acp` | npm `@google/gemini-cli` | Google auth / `GEMINI_API_KEY` | native ACP (experimental flag) | GA-ish, flag-gated |
| **Codex (OpenAI)** | `npx @zed-industries/codex-acp` (or `codex-acp`) | npm `@zed-industries/codex-acp` **v0.15.0** | `OPENAI_API_KEY`/`CODEX_API_KEY` or ChatGPT sub | bridge: perms, tool-calls, modes, loadSession (`cola` variant: `session/setMode`+`setModel`) | production bridge |
| **Codex (alt bridge)** | `codex-acp` (cola-io) | binary `codex-acp` **v0.4.2** | `OPENAI_API_KEY` / `codex login` | `initialize`,`authenticate`,`session/new\|load\|prompt\|cancel\|setMode\|setModel`, `acp_fs` | active, breaking changes likely |
| **Codex/Claude/Pi (multi)** | `acp-adapter --adapter codex` | binary `acp-adapter` **v0.3.7** (Go) | `openai_api_key`/`codex_api_key`/sub | `initialize`,`authenticate`,`session/*`, partial `fs/read_text_file` | production (Codex); Pi has gaps |

> Codex bridges deliberately run terminal commands **non-PTY in Codex's own process** (deadlock avoidance) — note this if your orchestrator expects PTY-streamed terminal output from ACP agents ([Zed blog](https://zed.dev/blog/codex-is-live-in-zed)).

---

## 5. Sources

- Zed — Codex is Live: https://zed.dev/blog/codex-is-live-in-zed · External Agents: https://zed.dev/docs/ai/external-agents · ACP registry: https://zed.dev/blog/acp-registry · ACP: https://zed.dev/acp
- `zed-industries/codex-acp`: https://github.com/zed-industries/codex-acp
- `cola-io/codex-acp`: https://github.com/cola-io/codex-acp
- `beyond5959/acp-adapter`: https://github.com/beyond5959/acp-adapter
- Codex non-interactive: https://developers.openai.com/codex/noninteractive · CLI ref: https://developers.openai.com/codex/cli/reference · App Server: https://developers.openai.com/codex/app-server · SDK: https://developers.openai.com/codex/sdk · MCP: https://developers.openai.com/codex/mcp
- App Server README: https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md · issue #2288: https://github.com/openai/codex/issues/2288
- InfoQ (App Server architecture / MCP rejection): https://www.infoq.com/news/2026/02/opanai-codex-app-server/
- `@openai/codex` npm: https://www.npmjs.com/package/@openai/codex
- AI SDK ACP provider: https://ai-sdk.dev/providers/community-providers/acp · OpenACP: https://github.com/Open-ACP
