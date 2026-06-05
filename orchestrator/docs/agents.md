# Agents — supported ACP backends & how to add one

archon drives **coding agents over [ACP](https://agentclientprotocol.com)** (the Agent
Client Protocol) using the official `@agentclientprotocol/sdk` SDK. Any
program that speaks ACP over stdio can be an archon backend — archon spawns it, runs the
`initialize → session/new → prompt` handshake, and streams normalized updates back to the
session manager / TUI.

This doc lists the built-in agents, what they can do, the env they read, and how to
register your own.

---

## Built-in agents

`archon agents` (or `archon agents list`, `--json`) prints these. Only **fake** runs with
no external setup; the others need a separately installed binary + credentials. archon does
**not** require them to be installed — it just knows the correct spawn spec and gives a
clear error (with a setup hint) if the launcher binary is missing from `PATH`.

| name      | spawn command                              | runnable | auth env (passed through if set)                                  |
|-----------|--------------------------------------------|----------|-------------------------------------------------------------------|
| `fake`    | `bun run src/testing/fake-acp-agent.ts`    | yes      | —                                                                 |
| `claude`  | `npx -y @agentclientprotocol/claude-agent-acp`   | needs setup | `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN` |
| `gemini`  | `gemini --experimental-acp`                | needs setup | `GEMINI_API_KEY`, `GOOGLE_API_KEY`, `GOOGLE_GENAI_USE_VERTEXAI`   |
| `generic` | *(supplied via `--acp-cmd`)*               | needs setup | —                                                                 |

### `fake`
Bundled standalone ACP **server** (`src/testing/fake-acp-agent.ts`). Emits a deterministic
3-chunk reply then `end_turn`; supports cancel (`cancelled`). No model, no network — used by
the e2e tests and as a smoke target:

```sh
bun run src/cli.ts -p "hello" --agent fake     # -> "Hello from the fake ACP agent!"
```

### `claude` — Claude Code over ACP (Zed adapter)
The full Claude Code agent exposed over ACP by Zed's adapter. Capabilities: streaming
assistant text **and** thoughts, tool calls, filesystem read/write (archon services
`fs/read_text_file` + `fs/write_text_file`), plan updates, and **session modes**
(`setSessionMode`). Requires Node.js (for `npx`) and Anthropic auth.

```sh
export ANTHROPIC_API_KEY=sk-...            # or CLAUDE_CODE_OAUTH_TOKEN
bun run src/cli.ts -p "summarize README" --agent claude --cwd /path/to/repo
```

The first invocation downloads `@agentclientprotocol/claude-agent-acp` via `npx`.

### `gemini` — Gemini CLI in experimental ACP mode
Google's Gemini CLI speaking ACP over stdio (`gemini --experimental-acp`). Streaming text +
tool calls. ACP support is **experimental** and may change between CLI releases. Install the
CLI so `gemini` is on `PATH` and authenticate.

```sh
npm i -g @google/gemini-cli
export GEMINI_API_KEY=...
bun run src/cli.ts -p "explain this file" --agent gemini
```

### `generic` — any ACP agent
Escape hatch: name `generic` and pass the launch argv with `--acp-cmd`. archon spawns
exactly that and drives it over stdio.

```sh
bun run src/cli.ts -p "hi" --agent generic --acp-cmd "my-agent --acp"
```

---

## Permission modes

archon mirrors Claude Code's permission modes; pass `--permission-mode` (or set
`ARCHON_PERMISSION_MODE`). The ACP client uses each option's `kind`
(`allow_once` / `allow_always` / `reject_*`):

- `default` / `plan` — allow a non-destructive option **once** if offered, else cancel and
  defer to a human (the TUI will prompt; headless cancels).
- `acceptEdits` / `bypassPermissions` — auto-select the allow option (allow_once preferred).

> In the in-process v1 there is no interactive human prompt in headless mode; the TUI
> (Breadth) overrides `requestPermission` to ask the operator.

---

## Auth / env passthrough

Each built-in spec declares which env vars it reads (`authEnv`). When archon spawns the
agent it forwards **only those declared keys** that are present in the parent environment
(it does not leak unrelated env). Anything you pass via the backend `env` option wins on
conflict. Set the relevant vars in your shell before running.

---

## Adding your own agent

Three ways, in increasing permanence:

### 1. One-off, no config — `--acp-cmd`
```sh
bun run src/cli.ts -p "hi" --agent generic --acp-cmd "my-agent serve --acp"
```

### 2. Register it in config — `archon agents add`
Persist a named agent to your settings file so you can use `--agent <name>` anywhere:

```sh
# user scope (~/.archon/settings.json, or $ARCHON_CONFIG_DIR/settings.json)
archon agents add zed -- npx -y @agentclientprotocol/claude-agent-acp

# project scope (<cwd>/.archon/settings.json)
archon agents add myteam --project -- my-agent --acp

archon agents              # zed + myteam now appear, tagged (config)
archon agents remove zed   # drop it
```

Everything after `--` is the literal spawn argv. Config agents are **never allowed to shadow
the reserved built-in names** (`fake`/`claude`/`gemini`/`generic`).

Resulting `settings.json`:
```json
{
  "agents": {
    "zed": ["npx", "-y", "@agentclientprotocol/claude-agent-acp"]
  }
}
```

Config precedence (highest wins): `env > managed > project .archon/settings.json >
user ~/.archon/settings.json > defaults`. See `src/config/load.ts`.

### 3. Add a built-in spec (code)
Add an entry to `AGENT_REGISTRY` in `src/backend/registry.ts` with `command`, `notes`,
`authEnv`, and `setupHint`. That's the only place spawn specs live; `createBackend` resolves
a name (or `--acp-cmd` override) into an `AcpBackend`, forwards declared auth env, and runs
a best-effort `PATH` check so a missing binary fails with an actionable message instead of a
cryptic spawn error.

---

## Management subcommands (thin wrappers over the session manager)

| command            | what it does                                                        |
|--------------------|---------------------------------------------------------------------|
| `archon ls`        | list active sessions (human)                                        |
| `archon ls --json` | same, machine-readable (`{ "sessions": [...] }`)                    |
| `archon attach <id>` | attach to a running session                                        |
| `archon stop <id>` | stop / cancel a running session                                     |
| `archon logs <id>` | print a session's accumulated transcript                            |

> **In-process v1 (ADR-0004):** there is no daemon yet, so sessions live only for the
> duration of a single command — there are no cross-invocation sessions to attach/stop/log,
> and `ls` reports none. These commands are the **stable shape** the daemon will back in
> Breadth; the session manager (`src/core/session-manager.ts`) already exposes
> `snapshot()` + events for them to wire onto.

---

## How a backend is driven (for reference)

`src/backend/acp-backend.ts` (`AcpBackend implements AgentBackend`):

1. `connect()` — spawn the subprocess (`src/acp/transport.ts`), negotiate
   `PROTOCOL_VERSION`, read agent capabilities.
2. `newSession(cwd)` — open a session; report available modes.
3. `prompt(sessionId, text)` — returns `{ updates, done }`: an async iterable of normalized
   `AgentUpdateEvent`s and a `Promise<{ stopReason }>`.
4. `cancel` / `setMode` / `dispose`.

The session manager consumes this uniform interface only, so adding an agent never touches
orchestration logic — just the registry spec (or `--acp-cmd`).
