# archon — ACP-based multi-agent orchestrator

archon is a terminal command-center for running and observing many coding-agent
sessions in parallel. It drives **any agent that speaks the [Agent Client
Protocol (ACP)](https://agentclientprotocol.com)** — Claude Code (via Zed's
adapter), Gemini CLI, or your own — over JSON-RPC 2.0 on the agent subprocess's
stdio, behind a single **agent-agnostic control plane**.

It ships two surfaces:

- a **Claude-Code-like CLI** — `archon -p "<prompt>"` runs one prompt headless
  and streams the reply; subcommands manage agents and sessions.
- a **fleet TUI** (OpenTUI/React) — a session grid grouped by logical state with
  a dual-channel status glyph (color = state, shape = liveness), a dispatch
  input to spawn new sessions, and an attached view that streams an agent's ACP
  updates live.

Built with **Bun + TypeScript**. Strict typecheck, 50 unit/integration/e2e tests
green. The end-to-end path is exercised in CI against a bundled credential-free
**fake ACP agent**; real agents (`claude`, `gemini`) are wired by their known
spawn specs but require their binaries + credentials and are not run in CI.

---

## Install

```bash
bun install
```

Requires [Bun](https://bun.sh) (developed on 1.3.x). No build step — the CLI runs
straight from TypeScript via Bun.

```bash
bunx tsc --noEmit   # typecheck (strict, clean)
bun test            # 50 tests across 9 files
```

The `bin` is `archon` → `src/cli.ts`. The commands below use
`bun run src/cli.ts …`; after a global link they are just `archon …`.

---

## CLI

```
archon                          Open the fleet TUI (interactive TTY); prints help when piped/headless
archon -p "<prompt>" [flags]    Run one prompt headless against an agent, stream the reply
archon agents [list]            List registered agent backends (use --json for machine output)
archon agents add <name> -- <argv...>   Register a custom ACP agent in config
archon agents remove <name>     Remove a config-registered agent (alias: rm)
archon ls [--json]              List active sessions
archon attach <id>              Attach to a running session
archon stop <id>                Stop / cancel a running session
archon logs <id>                Print a session's accumulated transcript
archon --version                Print version
archon --help, -h               Show help
```

### Prompt flags (`-p` / `--prompt`)

| flag | meaning |
|------|---------|
| `--agent <name>` | Agent backend to use (default from config; `fake`, `claude`, `gemini`, `generic`, or a config-registered name) |
| `--acp-cmd "<argv>"` | Spawn command for the `generic`/custom agent, e.g. `--acp-cmd "my-agent --acp"` (tokenized, honors quotes) |
| `--model <id>` | Model id, passed through where the backend supports it |
| `--cwd <path>` | Working directory for the session (default: process cwd) |
| `--permission-mode <mode>` | `default` \| `acceptEdits` \| `plan` \| `bypassPermissions` |

`agents add` also takes `--project` to write the project config
(`.archon/settings.json`) instead of the user config (`~/.archon/settings.json`).

### Examples

```bash
# headless one-shot against the bundled fake agent (the e2e path):
bun run src/cli.ts -p "hello" --agent fake
# -> Hello from the fake ACP agent!

# headless against real Claude Code (needs Node + ANTHROPIC_API_KEY):
bun run src/cli.ts -p "summarize README.md" --agent claude

# any ACP agent by raw command:
bun run src/cli.ts -p "hi" --agent generic --acp-cmd "my-agent --acp"

# register a custom agent in user config, then use it by name:
bun run src/cli.ts agents add zed -- npx -y @zed-industries/claude-code-acp
bun run src/cli.ts -p "hi" --agent zed

# list agents (human / JSON):
bun run src/cli.ts agents
bun run src/cli.ts agents --json

# open the fleet TUI (interactive terminal, >= ~24 rows):
bun run src/cli.ts
```

When stdout is not a TTY (piped, redirected, in tests) bare `archon` prints help
instead of opening the TUI, so scripts get deterministic text. Set `ARCHON_TUI=1`
to force the TUI path.

---

## Config

Layered, Claude-Code-style. Settings files are JSON; precedence (highest wins):

```
env vars  >  managed  >  project (.archon/settings.json)  >  user (~/.archon/settings.json)  >  defaults
```

- **user**: `~/.archon/settings.json` (override the dir with `ARCHON_CONFIG_DIR`)
- **project**: `<cwd>/.archon/settings.json`
- **managed** (admin policy): `/Library/Application Support/Archon/managed-settings.json` (macOS)
  or `/etc/archon/managed-settings.json` (Linux)

### settings.json keys

```jsonc
{
  "defaultAgent": "claude",            // default agent name
  "defaultModel": "claude-sonnet-4",   // optional model id
  "permissionMode": "default",         // default | acceptEdits | plan | bypassPermissions
  "agents": {                          // extra named ACP agents: name -> argv
    "zed": ["npx", "-y", "@zed-industries/claude-code-acp"]
  },
  "worktree": {                        // git-worktree isolation (ADR-0009)
    "bgIsolation": "worktree",         // "worktree" (default) | "none"
    "dir": ".archon/worktrees",        // worktrees root (relative to repo root)
    "branchPrefix": "archon/"          // branch-name prefix
  }
}
```

Built-in agent names (`fake`, `claude`, `gemini`, `generic`) are reserved and
cannot be shadowed by config.

### Environment variables

| var | effect |
|-----|--------|
| `ARCHON_CONFIG_DIR` | override the user config dir (default `~/.archon`) |
| `ARCHON_DEFAULT_AGENT` | default agent name |
| `ARCHON_DEFAULT_MODEL` | default model id |
| `ARCHON_PERMISSION_MODE` | `default` \| `acceptEdits` \| `plan` \| `bypassPermissions` |
| `ARCHON_WORKTREE` | `worktree` \| `none` — background-isolation mode |
| `ARCHON_TUI=1` | force the TUI even without a TTY |
| `ARCHON_DEBUG=1` | print `stopReason`/agent diagnostics to stderr |

Plus the per-agent auth env that each agent reads (passed through to the
subprocess only if present): `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` /
`CLAUDE_CODE_OAUTH_TOKEN` for `claude`; `GEMINI_API_KEY` / `GOOGLE_API_KEY` /
`GOOGLE_GENAI_USE_VERTEXAI` for `gemini`.

### Permission modes

How archon answers the agent's `session/request_permission` requests headlessly:

- **default** / **plan** — allow a non-destructive option if the agent offers one,
  otherwise cancel and (in the TUI, future) surface to a human.
- **acceptEdits** / **bypassPermissions** — auto-select the allow option (or the
  first offered) so edits proceed unattended.

---

## Supported ACP agents

`archon agents` prints the merged registry. Only **fake** runs with no setup;
the others need a separately installed binary + credentials. archon does not
require them to be installed — it knows the correct spawn spec and fails with a
clear, hinted error if the launcher binary is missing from `PATH`.

| name | spawn command | runnable here | notes |
|------|---------------|---------------|-------|
| `fake` | `bun run src/testing/fake-acp-agent.ts` | yes | Deterministic 3-chunk reply + `end_turn`; supports cancel. No model/network. Used by e2e + smokes. |
| `claude` | `npx -y @zed-industries/claude-code-acp` | needs setup | Full Claude Code over ACP (Zed adapter): streaming text + thoughts, tool calls, fs read/write, plan, session modes. Needs Node/npx + Anthropic auth. |
| `gemini` | `gemini --experimental-acp` | needs setup | Gemini CLI in experimental ACP mode over stdio. Streaming text + tool calls. ACP support is experimental. |
| `generic` | *(supplied via `--acp-cmd`)* | needs setup | Escape hatch — any ACP-over-stdio agent. Supply the launch argv with `--acp-cmd`. |

See `docs/agents.md` for capability detail and `docs/config.md` for the full
config reference.

---

## Architecture

archon is a layered stack; the UI and supervisor talk only to the
agent-agnostic `AgentBackend` interface, so backends are pluggable.

```
src/
  acp/        ACP protocol + transport
    types.ts        SDK re-export + StopReason / textBlock helpers / PROTOCOL_VERSION
    transport.ts    spawn an agent subprocess, wire stdin/stdout to a
                    ClientSideConnection over ndJsonStream (newline-delimited JSON)
  backend/    the agent-agnostic control plane
    types.ts        AgentBackend interface, normalized AgentUpdateEvent, capabilities
    acp-backend.ts  AcpBackend: drives one ACP agent; fans session/update notifications
                    out to per-session async queues; implements fs read/write + permission
                    policy as the ACP client
    registry.ts     named agent specs (fake/claude/gemini/generic) + config merge,
                    PATH check for the launcher, auth-env passthrough, createBackend()
  config/     layered Claude-Code-style settings
    types.ts        ArchonConfig / SettingsFile / permission + worktree modes + defaults
    load.ts         getConfig(): env > managed > project > user > defaults
    agents.ts       addAgent / removeAgent (write user or project settings.json)
  core/       in-process supervisor + isolation
    session-manager.ts   SessionManager: createSession / prompt / cancel / setMode /
                         remove / snapshot() + EventEmitter; logical state model
    worktree.ts          git-worktree isolation (lazy, per-session, opt-out)
  tui/        the fleet TUI (OpenTUI + React)
    index.tsx       runTui(): mount the renderer against a live SessionManager
    App.tsx         session grid (grouped by state, dual-channel glyph), dispatch
                    input, attached streaming view
    store.ts        UI reducer + render-group builder (selection tracked by session id)
    keymap.ts       key -> action mapping
    theme.ts        colors + state/liveness glyph mapping
  testing/
    fake-acp-agent.ts   standalone ACP server (AgentSideConnection) for credential-free e2e
  cli.ts        archon CLI entry (bin) — arg parsing, headless prompt, subcommands, TUI launch
```

**Control plane (`backend/`).** `AgentBackend` is the single contract:
`connect -> newSession -> prompt (streaming handle) -> cancel / setMode -> dispose`.
`AcpBackend` is the only concrete backend today; the interface leaves room for
future HTTP (coder/agentapi) or direct-PTY backends without touching the UI.

**Supervisor (`core/session-manager.ts`).** Owns sessions, normalizes the prompt
stream, tracks logical state (`busy | waiting | idle | completed | failed |
stopped`), and emits daemon-shaped events (`session_created` / `session_updated`
/ `session_chunk` / `session_removed`, plus a catch-all `event`). The snapshot +
event API is intentionally shaped so it can become an out-of-process daemon
later without changing the TUI contract.

**Worktree isolation (`core/worktree.ts`, ADR-0009).** By default, before a
session's *first edit* (detected from the first `tool_call` in the stream),
archon transparently creates a linked git worktree under
`.archon/worktrees/<id>` on a fresh branch, so parallel agents don't clobber each
other's working tree. It is lazy (read-only/planning sessions never create one),
opt-out (`worktree.bgIsolation: "none"`), and skipped when the cwd is not a git
repo or is already a linked worktree.

**TUI (`tui/`).** OpenTUI + React. Binds to a live `SessionManager` (no seed
data), renders sessions grouped by state with the dual-channel glyph, tracks
selection by stable session id, and dispatches new sessions from the prompt
input. Layout patterns are ported from the `mock/agent-view` reproduction.

Relevant ADRs: 0001 (Bun/TS), 0002, 0003 (AgentBackend control plane), 0004
(supervisor — in-process v1, daemon-shaped API), 0006 (session state model),
0009 (git-worktree isolation).

---

## Status & known gaps

**Works today**

- Headless one-shot prompt (`-p`) end-to-end over real ACP against the fake
  agent — streams assistant text chunk-by-chunk, honors `stopReason`.
- Agent registry + config layering; `agents add/remove`, `agents list --json`.
- `AcpBackend` implements the full client side: `session/update` fan-out,
  `fs/read_text_file` + `fs/write_text_file`, and a permission policy mapped to
  the four permission modes.
- `SessionManager` lifecycle, state model, events, and lazy git-worktree
  isolation (real temp-repo integration test).
- Fleet TUI mounts and renders against a live `SessionManager`; dispatch input
  and attached streaming view are wired to the backend.
- Strict typecheck clean; 50 tests green (config 6 + agents 5 + transport 2 +
  registry 8 + worktree 13 + session-manager/worktree 4 + tui 2 + cli 5 + e2e 5).

**Stubbed / not done yet**

- **Daemon is in-process (v1, ADR-0004).** There is no background supervisor, so
  sessions do not persist across CLI invocations. `archon ls` always reports no
  active sessions, and `attach` / `stop` / `logs` explain this and exit non-zero.
  These commands exist as the stable shape the daemon will back later.
- **Only the `fake` agent is exercised in CI.** `claude` / `gemini` are wired by
  their spawn specs and the client handshake is generic ACP, but they require the
  real binaries + credentials and are not run automatically.
- **Permission handling is headless-policy only** — the TUI does not yet prompt a
  human for `session/request_permission`; the configured mode decides.
- **`--model` is passed through only where a backend supports it**; the fake agent
  ignores it.
- **TUI is observe + dispatch + attach**; richer fleet operations (filter-to-
  waiting, review-before-merge with inline diff comments, the workflow
  run-inspector surface) are future work.
- No published binary / global install yet — run via `bun run src/cli.ts`.

---

## Run commands (quick reference)

```bash
bun install
bunx tsc --noEmit                                 # typecheck
bun test                                          # 50 tests
bun run src/cli.ts -p "hello" --agent fake        # headless e2e: "Hello from the fake ACP agent!"
ARCHON_TUI=1 bun run src/cli.ts                   # force the fleet TUI
bun run src/cli.ts agents --json                  # registry
```
