# 08 — ACP TypeScript SDK: building a CLIENT

> Research date: **2026-06-05**. Scope: the Agent Client Protocol (ACP) TypeScript SDK as a **control plane for an orchestrator** that *drives* coding agents (Claude/Gemini/Codex/etc) over stdio. We are the **client/editor side**; the agent is the subprocess.

---

## 0. TL;DR / migration

- **The package was renamed.** `@zed-industries/agent-client-protocol` (our pinned `0.4.5`) is **deprecated on npm** with the message: *"This package has been renamed to `@agentclientprotocol/sdk`. Please migrate to continue receiving updates."*
- **Current package: `@agentclientprotocol/sdk`**, **latest `0.25.0`** (published 2026-06-05; `dist-tags.latest = 0.25.0`). Repo moved from `zed-industries/agent-client-protocol` -> **`agentclientprotocol/typescript-sdk`**. Docs: <https://agentclientprotocol.com>, typedoc <https://agentclientprotocol.github.io/typescript-sdk/>.
- **Action for us:** `npm rm @zed-industries/agent-client-protocol && npm i @agentclientprotocol/sdk`, change imports to `@agentclientprotocol/sdk`. The class names (`ClientSideConnection`, `ndJsonStream`) and shapes are stable across the rename — this is a rename + version jump, not a rewrite. We jump 0.4.5 -> 0.25.0; expect additive changes (terminals, modes, models, elicitation) rather than breaking renames of the core client API.
- **Protocol version constant: `PROTOCOL_VERSION = 1`** (exported; `acp.PROTOCOL_VERSION`). The integer protocol version is still `1` even at SDK 0.25.0 — SDK semver != wire protocol version.
- Related publishable agents (spawnable as the subprocess): `@agentclientprotocol/claude-agent-acp` (v0.40.0, depends on `@anthropic-ai/claude-agent-sdk`), `@zed-industries/codex-acp`, `@zed-industries/claude-code-acp`.

---

## 1. Mental model

ACP is **JSON-RPC 2.0 over stdio**, newline-delimited JSON (ndjson). Two roles, both implemented by the SDK:

- **Agent** = the coding agent subprocess. Build with `AgentSideConnection`.
- **Client** = the editor / **our orchestrator**. Build with `ClientSideConnection`.

The connection is **bidirectional**: the client calls *agent methods* (`initialize`, `newSession`, `prompt`, `cancel`, ...); the agent calls *client methods* back (`session/request_permission`, `fs/read_text_file`, `fs/write_text_file`, `terminal/*`) and streams `session/update` notifications. So the *one* `ClientSideConnection` object is both how we send requests **and** (via the `toClient` handler we pass) how we receive the agent's callbacks.

```
orchestrator (Client)                         agent subprocess (Agent)
 connection.initialize()  -- initialize -------->
 connection.newSession()  -- session/new ------->
 connection.prompt()      -- session/prompt ---->
                          <-- session/update --- (notifications: message_chunk, tool_call, plan...)
                          <-- session/request_permission --- (request -> we answer)
                          <-- fs/read_text_file / fs/write_text_file
                          <-- terminal/create | output | wait_for_exit | kill | release
 (resolves) stopReason    <-- PromptResponse ---
```

---

## 2. Package / install / imports

```bash
npm install @agentclientprotocol/sdk   # 0.25.0
```

```ts
import * as acp from "@agentclientprotocol/sdk";
// named exports you'll use: ClientSideConnection, ndJsonStream, PROTOCOL_VERSION,
// Client (interface), and all schema types (RequestPermissionRequest, SessionNotification, ...)
```

`acp.ts` re-exports: `export * from "./schema/index.js"`, `export * from "./stream.js"`, and `export type * from "./schema/types.gen.js"`. Schemas are validated at the boundary with **Zod v4** (`zod/v4`) — incoming params are `.parse()`d before reaching your handlers.

---

## 3. The client API surface

### 3.1 `ClientSideConnection` (we instantiate this)

```ts
constructor(toClient: (agent: Agent) => Client, stream: Stream)
```

- `toClient` receives the connection itself (typed as `Agent` — the thing you send requests *to*) and must return **your `Client` handler object**. Classic pattern: `new acp.ClientSideConnection((agent) => new MyClient(agent), stream)` so your handler can call back into the agent.
- `stream` is a `Stream` — make it with `ndJsonStream(input, output)`.

It `implements Agent`, so the **methods we call on the agent** live on the connection instance:

| Method | Params -> Response | Purpose |
|---|---|---|
| `initialize(InitializeRequest)` | -> `InitializeResponse` | version + capability negotiation (call once, first) |
| `authenticate(AuthenticateRequest)` | -> `AuthenticateResponse` | if agent advertises auth methods |
| `newSession(NewSessionRequest)` | -> `NewSessionResponse` (`sessionId`) | start a session (`cwd`, `mcpServers`) |
| `loadSession(LoadSessionRequest)` | -> ... | resume (only if `agentCapabilities.loadSession`) |
| `setSessionMode(...)` | | switch agent mode (e.g. ask/code) |
| `prompt(PromptRequest)` | -> `PromptResponse` (`stopReason`) | send a user turn; resolves when the turn ends |
| `cancel(CancelNotification)` | (notification) | interrupt the current prompt turn |

### 3.2 `ndJsonStream(input, output)`

```ts
export function ndJsonStream(
  input: WritableStream<Uint8Array>,
  output: ReadableStream<Uint8Array>,
): Stream
```

Wraps web streams. For a spawned subprocess convert node streams: `Writable.toWeb(child.stdin)` / `Readable.toWeb(child.stdout)`.

### 3.3 `Client` interface — handlers WE implement (verbatim signatures)

```ts
interface Client {
  // REQUIRED
  requestPermission(params: RequestPermissionRequest): Promise<RequestPermissionResponse>;
  sessionUpdate(params: SessionNotification): Promise<void>;   // notification, returns void

  // OPTIONAL — gated by the capabilities we advertise in initialize()
  writeTextFile?(params: WriteTextFileRequest): Promise<WriteTextFileResponse>;
  readTextFile?(params: ReadTextFileRequest): Promise<ReadTextFileResponse>;

  // OPTIONAL terminal/* — gated by clientCapabilities.terminal === true
  createTerminal?(params: CreateTerminalRequest): Promise<CreateTerminalResponse>;
  terminalOutput?(params: TerminalOutputRequest): Promise<TerminalOutputResponse>;
  releaseTerminal?(params: ReleaseTerminalRequest): Promise<ReleaseTerminalResponse | void>;
  waitForTerminalExit?(params: WaitForTerminalExitRequest): Promise<WaitForTerminalExitResponse>;
  killTerminal?(params: KillTerminalRequest): Promise<KillTerminalResponse | void>;

  // UNSTABLE (not in spec yet — may change/disappear)
  unstable_createElicitation?(params: CreateElicitationRequest): Promise<CreateElicitationResponse>;
  unstable_completeElicitation?(params: CompleteElicitationNotification): Promise<void>;

  // Escape hatch for non-spec messages
  extMethod?(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>>;
  extNotification?(method: string, params: Record<string, unknown>): Promise<void>;
}
```

Wire method names (from `CLIENT_METHODS`, dispatched inside the SDK): `fs/write_text_file`, `fs/read_text_file`, `session/request_permission`, `session/update` (notification), `terminal/create`, `terminal/output`, `terminal/release`, `terminal/wait_for_exit`, `terminal/kill`, plus `elicitation/create` + `elicitation/complete` (unstable). Optional handlers that are `undefined` cause the SDK to throw `RequestError.methodNotFound` — so only omit them if you also *don't* advertise the matching capability.

---

## 4. Capability negotiation (`initialize`)

`InitializeRequest`:
- `protocolVersion: ProtocolVersion` (use `acp.PROTOCOL_VERSION` = `1`)
- `clientInfo?: Implementation` (name/version)
- `clientCapabilities: ClientCapabilities`
  - `fs: { readTextFile: boolean; writeTextFile: boolean }`
  - `terminal: boolean`

`InitializeResponse`:
- `protocolVersion` (the **negotiated** version — agent may downgrade)
- `agentInfo?: Implementation`
- `agentCapabilities: AgentCapabilities`
  - `loadSession: boolean` (can we resume sessions?)
  - `promptCapabilities: { audio, image, embeddedContext }` (what content blocks the agent accepts in a prompt)
  - `mcpCapabilities: { http, sse }`
  - `auth`, `sessionCapabilities`
- `authMethods: AuthMethod[]`

**Orchestrator rule:** read `agentCapabilities` after `initialize` and gate UI/affordances — only show "resume" if `loadSession`, only allow image/file mentions if `promptCapabilities.image`/`embeddedContext`, etc. Advertise `terminal: true` and `fs` only if we can actually service those callbacks.

---

## 5. `session/update` notification kinds

`sessionUpdate(params: SessionNotification)` — `params.update.sessionUpdate` is the discriminant of the `SessionUpdate` union. `params` also carries `sessionId`.

| `sessionUpdate` | Payload type | Shape highlights |
|---|---|---|
| `agent_message_chunk` | `ContentChunk` | `content: ContentBlock`, optional `messageId` — the streaming assistant text/image/etc |
| `agent_thought_chunk` | `ContentChunk` | reasoning/thinking stream |
| `user_message_chunk` | `ContentChunk` | echoes user content |
| `tool_call` | `ToolCallUpdate` | new tool call: `toolCallId`, `title`, `kind`, `status` (`pending`/`in_progress`/`completed`/`failed`), `content`, `locations`, `rawInput` |
| `tool_call_update` | `ToolCallUpdate` (partial) | progress on an existing `toolCallId` (status/content deltas) |
| `plan` | `Plan` | `entries: PlanEntry[]` — the agent's todo plan (each entry has content/priority/status) |
| `available_commands_update` | `AvailableCommandsUpdate` | `availableCommands[]` — slash commands the agent now offers |
| `current_mode_update` | `CurrentModeUpdate` | `currentModeId` — agent switched mode |

`ContentBlock` is a tagged union by `type`: `text` (`{ type:"text", text }`), `image`, `audio`, `resource_link`, `resource` (embedded context). The mock client checks `update.content.type === "text"` before reading `.text`.

This union **is the render model for the run-inspector north star** (RESEARCH/06): `tool_call`/`tool_call_update` -> the tree of tool spans; `plan` -> the phase list; `agent_message_chunk`/`agent_thought_chunk` -> the transcript; `current_mode_update`/`available_commands_update` -> header chrome.

---

## 6. Callback request shapes (agent -> us)

- **`session/request_permission`** — `RequestPermissionRequest { sessionId, toolCall: ToolCallUpdate, options: PermissionOption[] }`. We respond `RequestPermissionResponse { outcome }` where `outcome` is `{ outcome: "selected", optionId }` or `{ outcome: "cancelled" }`. **This is the review-gate hook** for the fleet surface. (If the client cancels the turn via `session/cancel`, it MUST answer outstanding permission requests with `cancelled`.)
- **`fs/read_text_file`** — `ReadTextFileRequest { sessionId, path, line?, limit? }` -> `{ content: string }`.
- **`fs/write_text_file`** — `WriteTextFileRequest { sessionId, path, content }` -> `{}`.
- **`terminal/create`** — `CreateTerminalRequest { sessionId, command, args?, env?, cwd?, outputByteLimit? }` -> `{ terminalId }`.
- **`terminal/output`** — `{ sessionId, terminalId }` -> `{ output: string, truncated: boolean, exitStatus? }`.
- **`terminal/wait_for_exit`**, **`terminal/kill`**, **`terminal/release`** complete the terminal lifecycle. Agent must `release` when done.

> Note: clients SHOULD keep accepting `tool_call_update` notifications even after sending `session/cancel`, since the agent may emit final updates before returning the `cancelled` stop reason.

---

## 7. Minimal working client (verbatim, from `src/examples/client.ts`, SDK main)

```ts
#!/usr/bin/env node
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Writable, Readable } from "node:stream";
import readline from "node:readline/promises";
import * as acp from "../acp.js"; // -> "@agentclientprotocol/sdk" in your project

class ExampleClient implements acp.Client {
  async requestPermission(
    params: acp.RequestPermissionRequest,
  ): Promise<acp.RequestPermissionResponse> {
    console.log(`\nPermission requested: ${params.toolCall.title}`);
    params.options.forEach((o, i) => console.log(`   ${i + 1}. ${o.name} (${o.kind})`));
    while (true) {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      const answer = (await rl.question("\nChoose an option: ")).trim();
      const idx = parseInt(answer) - 1;
      if (idx >= 0 && idx < params.options.length) {
        return { outcome: { outcome: "selected", optionId: params.options[idx].optionId } };
      }
      console.log("Invalid option. Please try again.");
    }
  }

  async sessionUpdate(params: acp.SessionNotification): Promise<void> {
    const update = params.update;
    switch (update.sessionUpdate) {
      case "agent_message_chunk":
        console.log(update.content.type === "text" ? update.content.text : `[${update.content.type}]`);
        break;
      case "tool_call":
        console.log(`\nTool: ${update.title} (${update.status})`);
        break;
      case "tool_call_update":
        console.log(`\nTool call \`${update.toolCallId}\` updated: ${update.status}\n`);
        break;
      case "plan":
      case "agent_thought_chunk":
      case "user_message_chunk":
        console.log(`[${update.sessionUpdate}]`);
        break;
      default:
        break;
    }
  }

  async writeTextFile(params: acp.WriteTextFileRequest): Promise<acp.WriteTextFileResponse> {
    console.error("[Client] Write text file:", JSON.stringify(params, null, 2));
    return {};
  }

  async readTextFile(params: acp.ReadTextFileRequest): Promise<acp.ReadTextFileResponse> {
    console.error("[Client] Read text file:", JSON.stringify(params, null, 2));
    return { content: "Mock file content" };
  }
}

async function main() {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const agentPath = join(__dirname, "agent.ts");

  // Spawn the agent subprocess (here: a tsx script; in prod: npx @agentclientprotocol/claude-agent-acp, etc.)
  const npxCmd = process.platform === "win32" ? "npx.cmd" : "npx";
  const agentProcess = spawn(npxCmd, ["tsx", agentPath], { stdio: ["pipe", "pipe", "inherit"] });

  const input = Writable.toWeb(agentProcess.stdin!);
  const output = Readable.toWeb(agentProcess.stdout!) as ReadableStream<Uint8Array>;

  const client = new ExampleClient();
  const stream = acp.ndJsonStream(input, output);
  const connection = new acp.ClientSideConnection((_agent) => client, stream);

  try {
    const initResult = await connection.initialize({
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
    });
    console.log(`Connected to agent (protocol v${initResult.protocolVersion})`);

    const sessionResult = await connection.newSession({ cwd: process.cwd(), mcpServers: [] });
    console.log(`Created session: ${sessionResult.sessionId}`);

    const promptResult = await connection.prompt({
      sessionId: sessionResult.sessionId,
      prompt: [{ type: "text", text: "Hello, agent!" }],
    });
    console.log(`\n\nAgent completed with: ${promptResult.stopReason}`);
  } catch (error) {
    console.error("[Client] Error:", error);
  } finally {
    agentProcess.kill();
    process.exit(0);
  }
}
main().catch(console.error);
```

`stdio: ["pipe","pipe","inherit"]` keeps the agent's **stderr** flowing to our terminal (useful for debugging) while stdin/stdout carry the JSON-RPC. `prompt()` resolves only when the whole turn ends; `stopReason` is one of `end_turn | max_tokens | max_turn_requests | refusal | cancelled` (and similar).

---

## 8. 2026 protocol/SDK notes & deltas vs our 0.4.5

- **Rename + big version jump** (0.4.5 -> 0.25.0) is the headline change. Core client API (`ClientSideConnection`, `ndJsonStream`, `initialize/newSession/prompt/cancel`, `Client` handlers) is intact.
- **Terminal subsystem** is now a first-class client capability (`terminal/create|output|wait_for_exit|kill|release`) — the orchestrator can host **interactive + background terminals** for the agent. Advertise `clientCapabilities.terminal = true` to enable.
- **Session modes & models**: `setSessionMode` / `selectSessionModel` + `current_mode_update` / `available_commands_update` notifications — agents expose mode (ask/code) and slash commands at runtime; surface these in chrome.
- **Elicitation** (`unstable_createElicitation` / `unstable_completeElicitation`, wire `elicitation/*`) — experimental, **not yet in spec**; don't depend on it.
- **`extMethod`/`extNotification`** escape hatches let us carry orchestrator-specific messages over the same channel without forking the protocol.
- Zod v4 validation at the boundary: malformed params throw before hitting handlers — fine for us, but means our handler types must match the schema exactly.

---

## 9. Recommendation for archon

Adopt **`@agentclientprotocol/sdk@0.25.0`** as the orchestrator's agent-agnostic control plane (CLAUDE.md sec 3 "build against ACP / agentapi"). Implement one `Client` handler that fans `session/update` into the run-inspector tree model and routes `session/request_permission` into the fleet review-gate. Spawn backends as subprocesses (`@agentclientprotocol/claude-agent-acp`, `@zed-industries/codex-acp`, gemini-cli) over `ndJsonStream` — same code, different `spawn` target — which directly realizes the "CLI-agnostic from day one" goal.

---

## Sources

- [npm: @agentclientprotocol/sdk](https://www.npmjs.com/package/@agentclientprotocol/sdk) (latest 0.25.0, verified via `npm view`)
- [npm: @zed-industries/agent-client-protocol](https://www.npmjs.com/package/@zed-industries/agent-client-protocol) (deprecated, 0.4.5; rename notice verified via `npm view ... deprecated`)
- [GitHub: agentclientprotocol/typescript-sdk](https://github.com/agentclientprotocol/typescript-sdk) — `src/acp.ts`, `src/examples/client.ts`, `src/schema/index.ts` (read verbatim)
- [agentclientprotocol.com — TypeScript library](https://agentclientprotocol.com/libraries/typescript) and [protocol schema](https://agentclientprotocol.com/protocol/schema)
- [Typedoc: agentclientprotocol.github.io/typescript-sdk](https://agentclientprotocol.github.io/typescript-sdk/)
- [npm: @agentclientprotocol/claude-agent-acp](https://www.npmjs.com/package/@agentclientprotocol/claude-agent-acp) (v0.40.0)
