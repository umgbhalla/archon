# archon configuration

archon resolves its configuration the way Claude Code does: a small set of
**layered JSON files** plus **environment-variable overrides**, merged into one
`ArchonConfig`. This document describes every setting, every env var, the
permission modes, and the exact precedence.

> Source of truth: `src/config/types.ts` (`ArchonConfig`, `WorktreeConfig`,
> `PERMISSION_MODES`, `DEFAULT_CONFIG`) and `src/config/load.ts` (`getConfig`,
> `mergeSettings`, `envLayer`). Worktree behavior: `src/core/worktree.ts`
> (ADR-0009).

---

## 1. Where settings live

Each layer is an optional `settings.json` file. Missing or malformed files are
treated as empty (never fatal).

| Layer       | Path                                                                                  | Purpose                                  |
|-------------|---------------------------------------------------------------------------------------|------------------------------------------|
| **defaults**| built-in (`DEFAULT_CONFIG`)                                                            | the baseline shipped with archon         |
| **user**    | `~/.archon/settings.json` (or `$ARCHON_CONFIG_DIR/settings.json`)                      | your personal defaults                   |
| **project** | `<cwd>/.archon/settings.json`                                                         | per-repo settings (commit to share)      |
| **managed** | macOS `/Library/Application Support/Archon/managed-settings.json`; else `/etc/archon/managed-settings.json` | admin-pushed policy (cannot be overridden by files) |
| **env**     | environment variables (see §4)                                                        | last-mile overrides, e.g. CI             |

---

## 2. Precedence

Highest wins. Later layers override earlier ones:

```
defaults  <  user  <  project  <  managed  <  env
```

- Scalars (`defaultAgent`, `defaultModel`, `permissionMode`) are replaced wholesale by the highest layer that sets them.
- Object maps are **shallow-merged** across layers:
  - `agents` — entries union; a later layer's key overrides an earlier one's.
  - `worktree` — fields merge individually (e.g. project may set only `bgIsolation` while keeping the default `dir`).

`getConfig(cwd, env)` performs the merge; `mergeSettings(...layers)` and
`envLayer(env)` are exported and unit-tested.

---

## 3. settings.json schema

All keys are optional in a file; unset keys fall through to the layer below.

```jsonc
{
  // Default agent backend when --agent is not passed.
  // Built-ins: "fake" | "claude" | "gemini" | "generic" (+ any from `agents`).
  "defaultAgent": "fake",

  // Default model id, passed through to backends that accept one.
  "defaultModel": "claude-sonnet-4",

  // Default permission mode for new sessions (see §5).
  "permissionMode": "default",

  // Custom ACP agents, registered by name -> spawn argv.
  // Also writable via `archon agents add <name> -- <argv...>`.
  "agents": {
    "myagent": ["my-agent-bin", "--acp"],
    "zed": ["npx", "-y", "@agentclientprotocol/claude-agent-acp"]
  },

  // Git-worktree isolation (ADR-0009). See §6.
  "worktree": {
    "bgIsolation": "worktree",      // "worktree" (default) | "none"
    "dir": ".archon/worktrees",      // relative to the repo root (or absolute)
    "branchPrefix": "archon/"        // branch = "<prefix><session-id>"
  }
}
```

### Field reference

| Key                      | Type                          | Default              | Meaning                                                                 |
|--------------------------|-------------------------------|----------------------|-------------------------------------------------------------------------|
| `defaultAgent`           | string                        | `"fake"`             | Agent used when `--agent` is omitted.                                   |
| `defaultModel`           | string \| (unset)             | (unset)              | Model id passed through where the backend supports it.                  |
| `permissionMode`         | enum (§5)                     | `"default"`          | How tool-permission requests are handled.                               |
| `agents`                 | `{ [name]: string[] }`        | (unset)              | Extra named agents merged into the registry (name → spawn argv).        |
| `worktree.bgIsolation`   | `"worktree"` \| `"none"`      | `"worktree"`         | Whether to isolate a session's edits in a git worktree.                 |
| `worktree.dir`           | string                        | `".archon/worktrees"`| Worktrees root, relative to the repo root (absolute path also allowed). |
| `worktree.branchPrefix`  | string                        | `"archon/"`          | Prefix for the branch created per worktree.                             |

---

## 4. Environment variables

Env overrides sit at the top of the precedence chain. Invalid values for an
enum are ignored (the lower layer's value stands).

| Variable                 | Maps to / effect                                                             |
|--------------------------|------------------------------------------------------------------------------|
| `ARCHON_CONFIG_DIR`      | Overrides the **user** config dir (default `~/.archon`).                      |
| `ARCHON_DEFAULT_AGENT`   | Sets `defaultAgent`.                                                          |
| `ARCHON_DEFAULT_MODEL`   | Sets `defaultModel`.                                                          |
| `ARCHON_PERMISSION_MODE` | Sets `permissionMode` (must be one of §5; otherwise ignored).                |
| `ARCHON_WORKTREE`        | Sets `worktree.bgIsolation` (`worktree` \| `none`; otherwise ignored).       |

`ARCHON_DEBUG=1` is honored at runtime by the CLI to print diagnostics to
stderr (e.g. `stopReason`), independent of config.

---

## 5. Permission modes

`PERMISSION_MODES` (from `src/config/types.ts`) mirrors Claude Code's modes.
They control how the backend answers ACP `requestPermission` calls (see
`AcpBackend` in `src/backend/acp-backend.ts`).

| Mode                | Behavior                                                                                          |
|---------------------|---------------------------------------------------------------------------------------------------|
| `default`           | Auto-allow non-destructive actions **once**; destructive/unknown requests are denied (headless) or prompted (TUI). |
| `acceptEdits`       | Auto-allow file edits in the session (still prompts/denies for higher-risk actions).              |
| `plan`              | Read/plan only — no edits or commands are auto-allowed; the agent proposes a plan.                |
| `bypassPermissions` | Allow everything without prompting. Use only in trusted/sandboxed contexts.                       |

In **headless** mode (`archon -p`), `default`/`plan` auto-allow safe actions
once or cancel; a TUI should override `requestPermission` to prompt a human.

Set per run with `--permission-mode <mode>`, or as a default via config / env.

---

## 6. Git-worktree isolation (ADR-0009)

To stop parallel agents from clobbering one shared working tree, archon
isolates each session's edits in a dedicated **git worktree** by default.

### How it works

- **Lazy:** the worktree is created on the session's **first edit** (the first
  `tool_call` in the prompt stream), not at session creation — read-only /
  planning sessions never spawn one. The session's `cwd` is then transparently
  redirected to the worktree, and `SessionSnapshot.worktreePath` is populated.
- **Location:** `<repoRoot>/<worktree.dir>/<session-id>` on a new branch
  `<worktree.branchPrefix><session-id>` (the id is slugified to be
  filesystem/branch-safe).
- **Cleanup:** removing a session (`SessionManager.remove` / `dispose`) runs
  `git worktree remove --force` and deletes the branch (best-effort).

### When isolation is skipped (session edits in place)

1. `worktree.bgIsolation` is `"none"` (Claude-style in-place editing).
2. The session `cwd` is **not inside a git repo**.
3. The session `cwd` is **already a linked worktree** (avoid worktree-of-a-worktree).

In all three cases `ensureWorktree` returns no path and the agent edits its
original `cwd`.

### Disabling it

Any of:

```jsonc
// project or user settings.json
{ "worktree": { "bgIsolation": "none" } }
```

```bash
ARCHON_WORKTREE=none archon -p "..."
```

### Tuning the layout

```jsonc
{
  "worktree": {
    "dir": ".worktrees",        // put worktrees elsewhere (relative to repo root)
    "branchPrefix": "agent/"     // branches become agent/<session-id>
  }
}
```

---

## 7. Inspecting the resolved config

- `archon agents [list] [--json]` shows the merged agent registry (built-ins +
  `agents` from config), tagged `[runnable]` / `[needs setup]` and `(config)`.
- `archon agents add <name> -- <argv...>` writes an entry to the user settings
  (or project settings with `--project`).
- `archon agents remove <name>` removes a config-registered agent.

CLI flags (`--agent`, `--model`, `--permission-mode`, `--cwd`, `--acp-cmd`)
override the resolved config for that single invocation.
