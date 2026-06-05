/**
 * Session manager / supervisor core (ADR-0004).
 *
 * Owns agent sessions (each = a backend connection + cwd + lifecycle state),
 * tracks them, exposes a snapshot + an EventEmitter. The snapshot/event API is
 * the stable contract the TUI consumes; the daemon (src/daemon) wraps an instance
 * of this class out-of-process. Run in-process (tests / headless -p) or behind the
 * daemon socket — the API is identical.
 *
 * Persistence (ADR-0011, JSON-files variant): an optional Persistence sink mirrors
 * session metadata + transcripts to disk so a daemon restart can recover the roster
 * via restore(). Persistence is best-effort and never blocks the live path.
 *
 * Session state model (ADR-0006): logical state used for the dual-channel glyph.
 *
 * Worktree isolation (ADR-0009): before a session's FIRST edit we transparently
 * create a git worktree under .archon/worktrees/<id> (see ./worktree.ts), unless
 * disabled (worktree.bgIsolation === "none"), not a git repo, or already a linked
 * worktree. The first edit is detected from the prompt stream's tool_call updates.
 */
import { EventEmitter } from "node:events";
import type { AgentBackend, AgentUpdateEvent, PermissionMode } from "../backend/types.ts";
import { createBackend, type CreateBackendOptions } from "../backend/registry.ts";
import {
  DEFAULT_WORKTREE_CONFIG,
  type WorktreeConfig,
} from "../config/types.ts";
import {
  ensureWorktree,
  type GitRunner,
  type SessionWorktree,
} from "./worktree.ts";
import type { Persistence, PersistedSession } from "../daemon/persistence.ts";
import { NullPersistence } from "../daemon/persistence.ts";

export type SessionState =
  | "busy" // a prompt turn is in flight
  | "waiting" // awaiting user input (e.g. permission)
  | "idle" // connected, no active turn
  | "completed" // last turn ended end_turn
  | "failed" // error / refusal
  | "stopped"; // cancelled / disposed

export interface SessionSnapshot {
  id: string;
  agent: string;
  cwd: string;
  state: SessionState;
  /** Accumulated assistant text from the latest turn. */
  lastMessage: string;
  /** Last stopReason, if any. */
  lastStopReason?: string;
  /** Absolute worktree path once isolation has materialized (ADR-0009); else undefined. */
  worktreePath?: string;
  createdAt: number;
  updatedAt: number;
}

interface SessionRecord extends SessionSnapshot {
  backend: AgentBackend;
  /** The session's original cwd (worktree, if any, is derived from this). */
  rootCwd: string;
  /** Worktree handle once created; undefined until the first edit (or if skipped). */
  worktree?: SessionWorktree;
  /** True once we've attempted worktree creation for this session (lazy, once). */
  worktreeResolved: boolean;
  /** The options used to create the session (persisted for restart recovery). */
  createOptions: CreateSessionOptions;
}

export interface ManagerSnapshot {
  sessions: SessionSnapshot[];
}

/** Events emitted (typed via the helper methods below). */
export type ManagerEvent =
  | { type: "session_created"; session: SessionSnapshot }
  | { type: "session_updated"; session: SessionSnapshot }
  | { type: "session_chunk"; id: string; update: AgentUpdateEvent }
  | { type: "session_removed"; id: string };

export interface CreateSessionOptions {
  agent: string;
  cwd: string;
  acpCmd?: string[];
  permissionMode?: PermissionMode;
  env?: Record<string, string>;
  /** Extra named agents from config, merged into the registry for resolution. */
  configAgents?: Record<string, string[]>;
  /** Skip the launcher PATH check (tests / advanced use). */
  skipLauncherCheck?: boolean;
  /** Worktree-isolation config for this session (defaults to ADR-0009 default). */
  worktree?: WorktreeConfig;
}

export interface SessionManagerOptions {
  /** Default worktree config applied to sessions that don't pass their own. */
  worktree?: WorktreeConfig;
  /** Injectable git runner for worktree ops (tests pass a temp-repo runner). */
  git?: GitRunner;
  /** Optional persistence sink (daemon passes FilePersistence; defaults to none). */
  persistence?: Persistence;
}

export class SessionManager extends EventEmitter {
  private sessions = new Map<string, SessionRecord>();
  private defaultWorktree: WorktreeConfig;
  private git?: GitRunner;
  private store: Persistence;

  constructor(opts: SessionManagerOptions = {}) {
    super();
    this.defaultWorktree = opts.worktree ?? { ...DEFAULT_WORKTREE_CONFIG };
    this.git = opts.git;
    this.store = opts.persistence ?? new NullPersistence();
  }

  /** Spawn+connect a backend and open one session; returns the session id. */
  async createSession(opts: CreateSessionOptions): Promise<string> {
    const backendOpts: CreateBackendOptions = {
      agent: opts.agent,
      acpCmd: opts.acpCmd,
      cwd: opts.cwd,
      env: opts.env,
      permissionMode: opts.permissionMode,
      configAgents: opts.configAgents,
      skipLauncherCheck: opts.skipLauncherCheck,
    };
    const backend = createBackend(backendOpts);
    await backend.connect();
    const { sessionId } = await backend.newSession(opts.cwd);

    const now = Date.now();
    const rec: SessionRecord = {
      id: sessionId,
      agent: opts.agent,
      cwd: opts.cwd,
      rootCwd: opts.cwd,
      state: "idle",
      lastMessage: "",
      createdAt: now,
      updatedAt: now,
      worktreeResolved: this.worktreeCfg(opts).bgIsolation === "none",
      backend,
      createOptions: opts,
    };
    // Stash the resolved config on the record via a closure map (kept off the snapshot).
    this.cfgs.set(sessionId, this.worktreeCfg(opts));
    this.sessions.set(sessionId, rec);
    this.persist(rec);
    this.emitEvent({ type: "session_created", session: this.toSnapshot(rec) });
    return sessionId;
  }

  private cfgs = new Map<string, WorktreeConfig>();

  private worktreeCfg(opts: CreateSessionOptions): WorktreeConfig {
    return opts.worktree ?? this.defaultWorktree;
  }

  /**
   * Materialize the session's git worktree if isolation applies and it hasn't
   * been created yet. Returns the worktree path, or undefined when isolation is
   * skipped (none / not-a-repo / already-linked). Idempotent.
   *
   * Called lazily on the first edit, but also public so a caller can pre-create.
   */
  async ensureWorktree(id: string): Promise<string | undefined> {
    const rec = this.require(id);
    if (rec.worktreeResolved) return rec.worktree?.path;
    rec.worktreeResolved = true;
    const config = this.cfgs.get(id) ?? this.defaultWorktree;
    const wt = await ensureWorktree({ id, cwd: rec.rootCwd, config, git: this.git });
    if (wt) {
      rec.worktree = wt;
      rec.cwd = wt.path;
      rec.worktreePath = wt.path;
      rec.updatedAt = Date.now();
      this.persist(rec);
      this.emitEvent({ type: "session_updated", session: this.toSnapshot(rec) });
    }
    return wt?.path;
  }

  /**
   * Run a prompt against a session. Returns the accumulated assistant text +
   * stopReason; also streams chunks via the "session_chunk" event for observers.
   *
   * On the first tool_call update of the session (the first-edit signal), the
   * worktree is created lazily (ADR-0009).
   */
  async prompt(
    id: string,
    text: string,
  ): Promise<{ message: string; stopReason: string }> {
    const rec = this.require(id);
    this.setState(rec, "busy");
    const handle = rec.backend.prompt(id, text);
    let message = "";
    try {
      for await (const update of handle.updates) {
        if (update.kind === "message_chunk" && update.role === "assistant") {
          message += update.text;
          rec.lastMessage = message;
          rec.updatedAt = Date.now();
          // mirror assistant text to the durable transcript (best-effort).
          void this.store.appendTranscript(id, update.text).catch(() => {});
        }
        // First edit signal: a tool call implies the agent may touch the FS.
        if (update.kind === "tool_call" && !rec.worktreeResolved) {
          await this.ensureWorktree(id);
        }
        this.emitEvent({ type: "session_chunk", id, update });
      }
      const { stopReason } = await handle.done;
      rec.lastStopReason = stopReason;
      this.setState(
        rec,
        stopReason === "end_turn"
          ? "completed"
          : stopReason === "cancelled"
            ? "stopped"
            : stopReason === "refusal"
              ? "failed"
              : "idle",
      );
      return { message, stopReason };
    } catch (err) {
      rec.lastStopReason = `error: ${(err as Error).message}`;
      this.setState(rec, "failed");
      throw err;
    }
  }

  async cancel(id: string): Promise<void> {
    const rec = this.require(id);
    await rec.backend.cancel(id);
    this.setState(rec, "stopped");
  }

  async setMode(id: string, modeId: string): Promise<void> {
    const rec = this.require(id);
    if (!rec.backend.setMode) throw new Error("backend does not support setMode");
    await rec.backend.setMode(id, modeId);
  }

  /**
   * Dispose one session (kills its backend + removes its worktree).
   *
   * By default this also purges the session from persistence (a user-initiated
   * `archon stop <id>`). Pass { purge: false } to drop the in-memory session
   * without deleting its on-disk metadata — used by daemon shutdown so a restart
   * can recover the roster (ADR-0011).
   */
  async remove(id: string, opts: { purge?: boolean } = {}): Promise<void> {
    const purge = opts.purge ?? true;
    const rec = this.sessions.get(id);
    if (!rec) return;
    await rec.backend.dispose();
    if (rec.worktree) {
      try {
        await rec.worktree.cleanup();
      } catch {
        // best-effort: don't let worktree cleanup failure block teardown.
      }
    }
    this.cfgs.delete(id);
    this.sessions.delete(id);
    if (purge) void this.store.removeSession(id).catch(() => {});
    this.emitEvent({ type: "session_removed", id });
  }

  /**
   * Dispose all sessions. Default PURGES persistence (clean user teardown / tests).
   * The daemon calls dispose({ purge: false }) on shutdown so persisted metadata
   * survives for restart recovery.
   */
  async dispose(opts: { purge?: boolean } = {}): Promise<void> {
    const purge = opts.purge ?? true;
    await Promise.all([...this.sessions.keys()].map((id) => this.remove(id, { purge })));
    // ensure any in-flight (void-fired) persistence writes land before we return.
    await this.store.flush().catch(() => {});
  }

  /**
   * Recover sessions from the persistence sink after a (daemon) restart.
   *
   * For each persisted session we respawn its backend + open a FRESH ACP session
   * (the agent subprocess died with the old daemon, so the old sessionId is gone),
   * but keep the session under its ORIGINAL id so the roster/TUI selection are
   * stable, and seed lastMessage/state from disk. Recovered sessions are placed in
   * "idle" so the user can re-prompt; the durable transcript is preserved.
   *
   * Best-effort: a backend that can't be respawned (missing binary) is skipped.
   * Returns the ids successfully recovered.
   */
  async restore(): Promise<string[]> {
    const persisted = await this.store.loadRoster();
    const recovered: string[] = [];
    for (const p of persisted) {
      if (this.sessions.has(p.snapshot.id)) continue;
      try {
        await this.recoverOne(p);
        recovered.push(p.snapshot.id);
      } catch {
        // skip un-recoverable sessions (e.g. agent binary no longer installed).
      }
    }
    return recovered;
  }

  private async recoverOne(p: PersistedSession): Promise<void> {
    const opts = p.createOptions as CreateSessionOptions;
    const backend = createBackend({
      agent: opts.agent,
      acpCmd: opts.acpCmd,
      cwd: opts.cwd,
      env: opts.env,
      permissionMode: opts.permissionMode,
      configAgents: opts.configAgents,
      skipLauncherCheck: opts.skipLauncherCheck,
    });
    await backend.connect();
    // open a fresh underlying session; we keep the persisted id as our key.
    await backend.newSession(opts.cwd);
    const snap = p.snapshot;
    const rec: SessionRecord = {
      id: snap.id,
      agent: snap.agent,
      cwd: snap.cwd,
      rootCwd: opts.cwd,
      state: "idle",
      lastMessage: snap.lastMessage,
      lastStopReason: snap.lastStopReason,
      worktreePath: snap.worktreePath,
      createdAt: snap.createdAt,
      updatedAt: Date.now(),
      // recovered sessions skip lazy worktree creation (already resolved on disk).
      worktreeResolved: true,
      backend,
      createOptions: opts,
    };
    this.cfgs.set(snap.id, this.worktreeCfg(opts));
    this.sessions.set(snap.id, rec);
    this.persist(rec);
    this.emitEvent({ type: "session_created", session: this.toSnapshot(rec) });
  }

  /** Immutable snapshot for a renderer/TUI. */
  snapshot(): ManagerSnapshot {
    return { sessions: [...this.sessions.values()].map((r) => this.toSnapshot(r)) };
  }

  get(id: string): SessionSnapshot | undefined {
    const rec = this.sessions.get(id);
    return rec ? this.toSnapshot(rec) : undefined;
  }

  /** Durable transcript for a session (assistant text accumulated across turns). */
  async transcript(id: string): Promise<string> {
    const fromDisk = await this.store.readTranscript(id);
    if (fromDisk) return fromDisk;
    // fall back to the live record's lastMessage (e.g. NullPersistence in-process).
    return this.sessions.get(id)?.lastMessage ?? "";
  }

  // --- internals ---

  private require(id: string): SessionRecord {
    const rec = this.sessions.get(id);
    if (!rec) throw new Error(`Unknown session "${id}"`);
    return rec;
  }

  private setState(rec: SessionRecord, state: SessionState): void {
    rec.state = state;
    rec.updatedAt = Date.now();
    this.persist(rec);
    this.emitEvent({ type: "session_updated", session: this.toSnapshot(rec) });
  }

  /** Mirror a record's metadata to the persistence sink (best-effort, async). */
  private persist(rec: SessionRecord): void {
    void this.store
      .saveSession({ snapshot: this.toSnapshot(rec), createOptions: rec.createOptions })
      .catch(() => {});
  }

  private toSnapshot(rec: SessionRecord): SessionSnapshot {
    const {
      backend: _backend,
      rootCwd: _rootCwd,
      worktree: _worktree,
      worktreeResolved: _wr,
      createOptions: _co,
      ...snap
    } = rec;
    return { ...snap };
  }

  private emitEvent(ev: ManagerEvent): void {
    this.emit(ev.type, ev);
    this.emit("event", ev);
  }
}
