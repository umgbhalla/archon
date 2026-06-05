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
  input to spawn new sessions, an attached view that streams an agent's ACP
  updates live, filter-to-needs-input, and a Ctrl+X stop/delete chord.
- a **chat surface** inside the attached view — the session's ACP stream is
  folded into a structured conversation (`src/core/conversation.ts`) and rendered
  as a Claude-Code-like log: user / assistant turns (live streaming spinner +
  caret), `thought` entries, `tool_call` status cards, and `plan` checklists, with
  PgUp/PgDn scrollback. When a turn needs approval, an interactive **permission
  modal** surfaces the request and the user picks an option (number keys / arrows /
  Enter); the answer resolves back to the agent and the turn resumes.

A per-user **supervisor daemon** owns the sessions (auto-started on demand) so
they survive across CLI/TUI invocations and across daemon restarts; the CLI and
TUI are thin clients over it (ADR-0004).

Built with **Bun + TypeScript**. Strict typecheck, 79 unit/integration/e2e tests
green (2 real-agent tests skipped unless `ARCHON_TEST_REAL=1`). The end-to-end path is exercised in CI against a bundled credential-free
**fake ACP agent**. Real agents — `claude`, `codex`, `gemini`, `goose`,
`opencode`, `copilot`, `qwen`, `cursor`, `amp` — are wired by their known ACP
spawn specs but require their binaries + credentials and are not run in CI
(`claude` → "BANANA" and `codex` → "391" were verified by hand on the dev host;
see the gated `src/real-integration.test.ts`).

---

## Demo

A keyboard-only walkthrough of the fleet TUI driven in a real PTY with
[`termctrl`](../../context/terminal-control) (`--host opentui`) against the
bundled `fake` agent. Stills are extracted deterministically from the recording
(`termctrl save --recording … --at-marker`), not raced live `show` calls.

- [`captures/archon-demo.mp4`](./captures/archon-demo.mp4) — captioned walkthrough
  (dispatch → complete → attach + stream → help → filter → stop/delete → quit).
- `captures/demo.termctrl` — recorded timeline (11 markers).
- `captures/demo-edit.json` — marker-range edit plan (captions, holds).
- `captures/NN-*.png` / `NN-*.txt` — one still per beat.

Re-export the video:

```bash
termctrl video captures/demo.termctrl --edit captures/demo-edit.json \
  --footer --hide-cursor --out captures/archon-demo.mp4
```

---

## Install

```bash
bun install
```

Requires [Bun](https://bun.sh) (developed on 1.3.x). No build step — the CLI runs
straight from TypeScript via Bun.

```bash
bunx tsc --noEmit   # typecheck (strict, clean)
bun test            # 70 tests (68 pass, 2 real-agent skipped without ARCHON_TEST_REAL)
```

### Run it as `archon` (global install)

`package.json` declares a `bin` (`archon` → `src/cli.ts`, with a `#!/usr/bin/env bun`
shebang). Link it once to get a global `archon` command backed by this checkout:

```bash
bun link            # from this directory: registers the package
bun link archon     # adds the `archon` bin to your global bin (~/.bun/bin)
# ensure ~/.bun/bin is on your PATH, then:
archon --help
archon -p "hello" --agent fake
archon              # opens the fleet TUI in an interactive terminal
```

`bun link` symlinks back to this source tree, so edits take effect immediately —
no rebuild. To remove it later: `bun unlink archon` (and `bun unlink` here).

Everything below uses the linked `archon …` form; without a link the equivalent
is `bun run src/cli.ts …`.

---

## CLI

```
archon                          Open the fleet TUI (interactive TTY); prints help when piped/headless
archon -p "<prompt>" [flags]    Run one prompt headless against an agent, stream the reply
archon daemon                   Run the persistent supervisor daemon in the foreground
archon daemon status            Report whether the daemon is running (pid + socket)
archon daemon stop              Stop the running daemon
archon agents [list]            List registered agent backends (use --json for machine output)
archon agents add <name> -- <argv...>   Register a custom ACP agent in config
archon agents remove <name>     Remove a config-registered agent (alias: rm)
archon ls [--json]              List live sessions (via the daemon)
archon attach <id>              Attach to a running session and stream its updates
archon stop <id>                Stop / cancel a running session
archon logs <id>                Print a session's persisted transcript
archon --version                Print version
archon --help, -h               Show help
```

### Prompt flags (`-p` / `--prompt`)

| flag | meaning |
|------|---------|
| `--agent <name>` | Agent backend to use (default from config; `fake`, `claude`, `codex`, `gemini`, `goose`, `opencode`, `copilot`, `qwen`, `cursor`, `amp`, `generic`, or a config-registered name) |
| `--acp-cmd "<argv>"` | Spawn command for the `generic`/custom agent, e.g. `--acp-cmd "my-agent --acp"` (tokenized, honors quotes) |
| `--model <id>` | Model id, passed through where the backend supports it |
| `--cwd <path>` | Working directory for the session (default: process cwd) |
| `--permission-mode <mode>` | `default` \| `acceptEdits` \| `plan` \| `bypassPermissions` |
| `--in-process` | Run the one-shot without the daemon (no persistence) — used by tests |

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
bun run src/cli.ts agents add zed -- npx -y @agentclientprotocol/claude-agent-acp
bun run src/cli.ts -p "hi" --agent zed

# list agents (human / JSON):
bun run src/cli.ts agents
bun run src/cli.ts agents --json

# daemon lifecycle (auto-started by ls/attach/stop/-p; explicit control too):
bun run src/cli.ts daemon status
bun run src/cli.ts ls                              # live sessions (via the daemon)
bun run src/cli.ts logs <id>                       # persisted transcript
bun run src/cli.ts daemon stop

# open the fleet TUI (interactive terminal, >= ~24 rows):
bun run src/cli.ts
```

When stdout is not a TTY (piped, redirected, in tests) bare `archon` prints help
instead of opening the TUI, so scripts get deterministic text. Set `ARCHON_TUI=1`
to force the TUI path.

### Fleet TUI keys

The `?` overlay is generated from the keymap (`src/tui/keymap.ts`), so it never
drifts. The bindings:

| key | action |
|-----|--------|
| `↑` / `↓` | Move selection between sessions |
| type + `Enter` | Dispatch a new session (when the input has text) |
| `Enter` / `→` | Attach to the selected session (when the input is empty) |
| `w` | Toggle filter to sessions that need input |
| `Ctrl+X` | Stop the selected session; press again within 2s to delete it |
| `Esc` | Disarm a pending delete · clear the input · else exit |
| `?` | Toggle the help overlay |
| `q` | Exit to the shell (when the input is empty) |
| `Ctrl+C` | Clear the input, else exit |

In the **attached view** (the chat surface):

| key | action |
|-----|--------|
| type + `Enter` | Send the typed prompt to the attached session |
| `PgUp` / `PgDn` | Scroll back / forward through the transcript (auto-pins to the tail while a turn streams) |
| `←` / `Esc` / `Ctrl+Z` | Detach back to the grid |
| `?` | Toggle help (only when the input is empty) |

When a session is awaiting permission, the **permission modal** captures keys:

| key | action |
|-----|--------|
| `1`–`9` | Pick that numbered option |
| `↑` / `↓` | Move the highlight |
| `Enter` | Confirm the highlighted option |
| `Esc` | Deny (cancel the request) |

The attached view sets the session **interactive** before each prompt, so the
agent's `session/request_permission` is routed to the modal instead of being
answered by the headless permission-mode policy.

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
    "zed": ["npx", "-y", "@agentclientprotocol/claude-agent-acp"]
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

How archon answers the agent's `session/request_permission` requests **when a
session is non-interactive** (headless `-p`, or a grid-dispatched session before
you attach):

- **default** — allow a non-destructive `allow_once`/`allow_always` option if the
  agent offers one, otherwise cancel.
- **plan** — reject (read-only planning), so the agent never acts.
- **acceptEdits** / **bypassPermissions** — auto-select the allow option (or the
  first offered) so edits proceed unattended.

When you **attach** in the TUI, the session is flipped interactive and the request
is instead surfaced to the live **permission modal** (see the attached-view keys
above) — the headless policy no longer applies for that turn.

---

## Supported ACP agents

`archon agents` prints the merged registry. Only **fake** runs with no setup;
the others need a separately installed binary + credentials. archon does not
require them to be installed — it knows the correct spawn spec and fails with a
clear, hinted error if the launcher binary is missing from `PATH`.

| name | spawn command | runnable here | notes |
|------|---------------|---------------|-------|
| `fake` | `bun run src/testing/fake-acp-agent.ts` | yes | Bundled standalone ACP test agent. Deterministic 3-chunk reply + `end_turn`; supports cancel. No model/network. Used by e2e + smokes. |
| `claude` | `npx -y @agentclientprotocol/claude-agent-acp` | needs setup | Claude Code over ACP (official adapter): streaming text + thoughts, tool calls, fs read/write, plan, session modes. Needs Node/npx + Anthropic auth. |
| `codex` | `npx -y @zed-industries/codex-acp` | needs setup | OpenAI Codex over ACP via Zed's adapter (the local `codex` binary is not ACP; the adapter supplies it). ChatGPT subscription / `codex login`. |
| `gemini` | `gemini --experimental-acp` | needs setup | Gemini CLI in experimental ACP mode over stdio. Streaming text + tool calls; ACP support is experimental. |
| `goose` | `goose acp` | needs setup | Block's Goose in native ACP mode (configure providers via `goose configure`). |
| `opencode` | `opencode acp` | needs setup | opencode (sst) in native ACP mode (`/undo`, `/redo` unsupported over ACP). |
| `copilot` | `copilot --acp` | needs setup | GitHub Copilot CLI in native ACP mode (public preview; needs a Copilot subscription). |
| `qwen` | `qwen --acp` | needs setup | Qwen Code in native ACP mode (Node ≥ 22; legacy `--experimental-acp` deprecated). |
| `cursor` | `cursor-agent acp` | needs setup | Cursor agent CLI in native ACP mode (no `session/load` — resume unavailable). |
| `amp` | `npx -y @superagenticai/acp-amp run` | needs setup | Sourcegraph Amp via the community `acp-amp` bridge (tier-2; needs paid Amp credits; best-effort). |
| `generic` | *(supplied via `--acp-cmd`)* | needs setup | Escape hatch — any ACP-over-stdio agent. Supply the launch argv with `--acp-cmd`. |

Run `archon agents` (or `agents --json`) for the live registry, exact commands, and the auth env each agent reads.

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
  core/       supervisor + isolation
    session-manager.ts   SessionManager: createSession / prompt / cancel / setMode /
                         remove / snapshot() + EventEmitter; logical state model;
                         setInteractive() + answerPermission() drive the modal;
                         restore() recovers persisted sessions on daemon start
    conversation.ts      structured ConversationEntry model: folds ACP updates into
                         user/assistant/thought/tool_call/plan entries (snapshot.entries)
    worktree.ts          git-worktree isolation (lazy, per-session, opt-out)
  daemon/     per-user supervisor daemon (ADR-0004)
    server.ts       DaemonServer: owns the SessionManager, serves a 0600 unix socket,
                    broadcasts session events to attached clients
    client.ts       connectDaemon(): start-on-demand + reconnect; in-process fallback
    protocol.ts     line-delimited JSON request/response + event frames + handshake
    persistence.ts  FilePersistence: roster.json + per-session meta.json + transcript.log
                    (atomic tmp+rename); roster recovery across restarts (ADR-0011)
  tui/        the fleet TUI (OpenTUI + React)
    index.tsx       runTui(): mount the renderer against a live SessionManager
    App.tsx         session grid (grouped by state, dual-channel glyph), dispatch
                    input, attached chat view; owns keymap->action + permission wiring
    ChatView.tsx    chat substrate: renders snapshot.entries as a session log
                    (turns, thought, tool_call cards, plan checklists) + scrollback
    PermissionModal.tsx  interactive permission prompt overlay (numbered options)
    store.ts        UI reducer + render-group builder (selection tracked by session id;
                    attachScroll scrollback offset)
    keymap.ts       key -> action mapping (grid / attached / help; PgUp/PgDn scroll)
    theme.ts        colors + state/liveness glyph mapping
  testing/
    fake-acp-agent.ts   standalone ACP server (AgentSideConnection) for credential-free e2e
  cli.ts        archon CLI entry (bin) — arg parsing, headless prompt, subcommands, TUI launch
```

**Control plane (`backend/`).** `AgentBackend` is the single contract:
`connect -> newSession -> prompt (streaming handle) -> cancel / setMode -> dispose`.
`AcpBackend` is the only concrete backend today; the interface leaves room for
future HTTP (coder/agentapi) or direct-PTY backends without touching the UI.

**Supervisor (`core/session-manager.ts` + `daemon/`).** The `SessionManager` owns
sessions, normalizes the prompt stream, tracks logical state (`busy | waiting |
idle | completed | failed | stopped`), and emits daemon-shaped events
(`session_created` / `session_updated` / `session_chunk` / `session_removed`,
plus a catch-all `event`). It now runs **inside a per-user daemon** (`daemon/`,
ADR-0004): the CLI and TUI connect over a `0600` unix socket (auto-starting the
daemon on demand) and stream observed state. Sessions + transcripts are persisted
(`daemon/persistence.ts`, ADR-0011) and recovered on daemon restart, so work
survives the UI closing. An in-process fallback keeps tests + `--in-process` fast.

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

Relevant ADRs: 0001 (Bun/TS), 0003 (AgentBackend control plane), 0004
(supervisor daemon — implemented), 0006 (session state model), 0008 (keymap),
0009 (git-worktree isolation), 0011 (persistence — JSON-files variant).

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
- **Persistent supervisor daemon (ADR-0004)** — a per-user daemon over a `0600`
  unix socket owns sessions; the CLI auto-starts it and reconnects. `archon ls`,
  `attach`, `stop`, `logs`, `daemon status/stop` all work against it. Sessions +
  transcripts persist to disk (`roster.json` + per-session files) and are
  recovered on daemon restart — verified by a stop/start round-trip.
- Fleet TUI mounts and renders against a live `SessionManager`: dispatch input,
  attached streaming view, **filter-to-needs-input (`w`)**, the **Ctrl+X
  stop-then-delete chord** (2s confirm), and a `?` help overlay generated from
  the keymap — all wired to the backend. See the captioned demo below.
- Strict typecheck clean; 70 tests across 11 files (68 pass; 2 real-agent
  integration tests skip unless `ARCHON_TEST_REAL=1`): config, agents, transport,
  registry incl. agent-startup-error cases, worktree, session-manager, daemon
  round-trip + persistence-reload, tui, cli, e2e, real-integration.

**Stubbed / not done yet**

- **Only the `fake` agent is exercised in CI.** The real agents (`claude`,
  `codex`, `gemini`, `goose`, `opencode`, `copilot`, `qwen`, `cursor`, `amp`)
  share the generic-ACP client handshake and are wired by their spawn specs, but
  need real binaries + credentials. `claude` and `codex` were verified by hand
  (gated `src/real-integration.test.ts`, `ARCHON_TEST_REAL=1`).
- **Permission handling is headless-policy only** — the TUI does not yet prompt a
  human for `session/request_permission`; the configured mode decides.
- **`--model` is passed through only where a backend supports it**; the fake agent
  ignores it.
- **The workflow run-inspector surface is the next milestone (ADR-0005/0007).**
  Today archon ships only the fleet/session-grid surface; the phase→agent tree
  with per-span token/time metrics and live pause/resume/restart is not built.
- **Review-before-merge** (inline diff-comments routed back to the agent,
  ADR-0012) is not built yet.
- **Persistence is the JSON-files variant** (`roster.json` + per-session
  `meta.json`/`transcript.log`); the SQLite/relational store (ADR-0011) is
  deferred behind the same `Persistence` interface.
- Distributed as source, not a prebuilt binary — install with `bun link` (see [Install](#install)) or run via `bun run src/cli.ts`.

---

## Run commands (quick reference)

```bash
bun install
bunx tsc --noEmit                                 # typecheck
bun test                                          # 70 tests
bun run src/cli.ts -p "hello" --agent fake        # headless e2e: "Hello from the fake ACP agent!"
ARCHON_TUI=1 bun run src/cli.ts                   # force the fleet TUI
bun run src/cli.ts agents --json                  # registry
```


## Verified real integrations (2026-06-05)

Proven end-to-end through `archon -p` (a real model reply, not the fake control string):

| Agent | Command | Result | Auth used |
|-------|---------|--------|-----------|
| `claude` | `archon -p "reply with exactly BANANA" --agent claude` | `BANANA` | `ANTHROPIC_API_KEY` |
| `codex` | `archon -p "what is 17*23? number only" --agent codex` | `391` | `codex login` (ChatGPT sub) |
| `fake` | `archon -p "ping" --agent fake` | `Hello from the fake ACP agent!` | none (control) |

`gemini --experimental-acp` is wired but the local gemini binary crashes on import (Node ESM/telemetry bug) — archon surfaces the actionable setup hint rather than failing opaquely.

Regression test: `ARCHON_TEST_REAL=1 ANTHROPIC_API_KEY=... bun test real-integration` (gated; default `bun test` skips it and stays green offline).
