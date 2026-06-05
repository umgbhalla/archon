/**
 * Daemon client (ADR-0004) — what the CLI/TUI use to talk to the supervisor.
 *
 * Responsibilities:
 *   - connect to the per-user daemon socket (under ARCHON_CONFIG_DIR/.archon);
 *   - AUTO-START the daemon on demand if nothing is listening, then connect;
 *   - reconnect transparently if the connection drops;
 *   - expose the same shape the SessionManager offers (list/create/prompt/attach/
 *     stop/logs) but over the wire, streaming updates via callbacks/async-iter;
 *   - fall back to an IN-PROCESS SessionManager when the socket is unavailable
 *     (tests, environments where spawning a daemon isn't wanted).
 *
 * The CLI uses connectDaemon() (real cross-invocation sessions). Tests can pass
 * an in-process manager to get the fallback path without a socket.
 */
import type { Socket } from "bun";
import { join } from "node:path";
import { homedir } from "node:os";
import { SessionManager } from "../core/session-manager.ts";
import { FilePersistence, daemonPaths } from "./persistence.ts";
import {
  encode,
  LineDecoder,
  PROTOCOL_VERSION,
  isUpdate,
  isResponse,
  type StreamEvent,
  type PromptStreamEvent,
  type AttachStreamEvent,
  type CreateSessionParams,
  type HandshakeResult,
  type ListSessionsResult,
  type LogsResult,
  type DaemonMethod,
} from "./protocol.ts";
import type { SessionSnapshot } from "../core/session-manager.ts";

/** The capability surface both the socket client and the in-process fallback expose. */
export interface DaemonClient {
  /** Identifies the daemon (or "in-process" for the fallback). */
  handshake(): Promise<HandshakeResult>;
  listSessions(): Promise<SessionSnapshot[]>;
  createSession(params: CreateSessionParams): Promise<string>;
  /** Prompt; onChunk fires per assistant chunk as it streams. */
  prompt(
    id: string,
    text: string,
    onChunk?: (ev: PromptStreamEvent) => void,
  ): Promise<{ message: string; stopReason: string }>;
  /** Subscribe to the full manager event stream. Returns an unsubscribe fn. */
  attach(onEvent: (ev: AttachStreamEvent) => void): Promise<() => void>;
  stop(id: string, remove?: boolean): Promise<void>;
  logs(id: string): Promise<LogsResult>;
  /** Ask the daemon to shut down (no-op for the in-process fallback). */
  shutdownDaemon(): Promise<void>;
  /** Release the connection (does NOT stop the daemon). */
  close(): void;
}

export function userConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.ARCHON_CONFIG_DIR ?? join(homedir(), ".archon");
}

// ── Socket-backed client ──────────────────────────────────────────────────────

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
}

class SocketClient implements DaemonClient {
  private socket!: Socket<undefined>;
  private decoder = new LineDecoder();
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private streamHandlers = new Map<number, (ev: StreamEvent) => void>();

  private constructor(private readonly socketPath: string) {}

  static async connect(socketPath: string): Promise<SocketClient> {
    const c = new SocketClient(socketPath);
    await c.open();
    return c;
  }

  private open(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let opened = false;
      Bun.connect<undefined>({
        unix: this.socketPath,
        socket: {
          open: (socket) => {
            this.socket = socket;
            opened = true;
            resolve();
          },
          data: (_socket, data) => {
            for (const msg of this.decoder.push(data.toString())) {
              if (isUpdate(msg)) {
                this.streamHandlers.get(msg.stream)?.(msg.event);
              } else if (isResponse(msg)) {
                const p = this.pending.get(msg.id);
                if (!p) continue;
                this.pending.delete(msg.id);
                if ("error" in msg) p.reject(new Error(msg.error.message));
                else p.resolve(msg.result);
              }
            }
          },
          close: () => this.failAll(new Error("daemon connection closed")),
          error: (_s, err) => {
            if (!opened) reject(err);
            this.failAll(err);
          },
        },
      }).catch((err) => {
        if (!opened) reject(err as Error);
      });
    });
  }

  private failAll(err: Error): void {
    for (const p of this.pending.values()) p.reject(err);
    this.pending.clear();
  }

  private call(
    method: DaemonMethod,
    params?: unknown,
    onStream?: (ev: StreamEvent) => void,
  ): Promise<unknown> {
    const id = this.nextId++;
    if (onStream) this.streamHandlers.set(id, onStream);
    const promise = new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
    this.socket.write(encode({ id, method, params }));
    return promise;
  }

  async handshake(): Promise<HandshakeResult> {
    const r = (await this.call("handshake")) as HandshakeResult;
    if (r.protocolVersion !== PROTOCOL_VERSION) {
      throw new Error(
        `daemon protocol mismatch: client ${PROTOCOL_VERSION}, daemon ${r.protocolVersion}. Restart the daemon (archon daemon stop).`,
      );
    }
    return r;
  }

  async listSessions(): Promise<SessionSnapshot[]> {
    return ((await this.call("listSessions")) as ListSessionsResult).sessions;
  }

  async createSession(params: CreateSessionParams): Promise<string> {
    return ((await this.call("createSession", params)) as { id: string }).id;
  }

  async prompt(
    id: string,
    text: string,
    onChunk?: (ev: PromptStreamEvent) => void,
  ): Promise<{ message: string; stopReason: string }> {
    const res = await this.call(
      "prompt",
      { id, text },
      onChunk ? (ev) => onChunk(ev as PromptStreamEvent) : undefined,
    );
    return res as { message: string; stopReason: string };
  }

  async attach(onEvent: (ev: AttachStreamEvent) => void): Promise<() => void> {
    const id = this.nextId; // call() will consume this id next
    await this.call("attach", undefined, (ev) => onEvent(ev as AttachStreamEvent));
    return () => this.streamHandlers.delete(id);
  }

  async stop(id: string, remove?: boolean): Promise<void> {
    await this.call("stop", { id, remove });
  }

  async logs(id: string): Promise<LogsResult> {
    return (await this.call("logs", { id })) as LogsResult;
  }

  async shutdownDaemon(): Promise<void> {
    try {
      await this.call("shutdown");
    } catch {
      // the daemon may close the socket before/while replying; that's fine.
    }
  }

  close(): void {
    try {
      this.socket.end();
    } catch {
      /* already gone */
    }
  }
}

// ── In-process fallback ────────────────────────────────────────────────────────

/**
 * Wraps a real SessionManager in the DaemonClient shape (no socket). Used when
 * the socket is unavailable (tests / opt-out). Sessions live only for the life of
 * the process — same semantics as the old in-process v1.
 */
export class InProcessClient implements DaemonClient {
  constructor(private readonly manager: SessionManager) {}

  async handshake(): Promise<HandshakeResult> {
    return { protocolVersion: PROTOCOL_VERSION, daemonVersion: "in-process", pid: process.pid };
  }
  async listSessions(): Promise<SessionSnapshot[]> {
    return this.manager.snapshot().sessions;
  }
  async createSession(params: CreateSessionParams): Promise<string> {
    return this.manager.createSession(params);
  }
  async prompt(
    id: string,
    text: string,
    onChunk?: (ev: PromptStreamEvent) => void,
  ): Promise<{ message: string; stopReason: string }> {
    const handler = (ev: { id: string; update: unknown }) => {
      if (ev.id === id && onChunk) onChunk({ kind: "chunk", update: ev.update as never });
    };
    if (onChunk) this.manager.on("session_chunk", handler);
    try {
      return await this.manager.prompt(id, text);
    } finally {
      if (onChunk) this.manager.off("session_chunk", handler);
    }
  }
  async attach(onEvent: (ev: AttachStreamEvent) => void): Promise<() => void> {
    this.manager.on("event", onEvent);
    for (const s of this.manager.snapshot().sessions) {
      onEvent({ type: "session_created", session: s });
    }
    return () => this.manager.off("event", onEvent);
  }
  async stop(id: string, remove?: boolean): Promise<void> {
    if (remove) await this.manager.remove(id);
    else await this.manager.cancel(id);
  }
  async logs(id: string): Promise<LogsResult> {
    return { session: this.manager.get(id), transcript: await this.manager.transcript(id) };
  }
  async shutdownDaemon(): Promise<void> {
    await this.manager.dispose();
  }
  close(): void {
    /* nothing to release */
  }
}

// ── Connect with auto-start ─────────────────────────────────────────────────────

export interface ConnectOptions {
  configDir?: string;
  /** Don't auto-start the daemon; if not running, throw. */
  noAutoStart?: boolean;
  /** Force the in-process fallback (tests). */
  inProcess?: boolean;
  /** Manager for the in-process fallback (tests); else one is built. */
  manager?: SessionManager;
  /** Max ms to wait for an auto-started daemon to come up. */
  startTimeoutMs?: number;
}

/**
 * Connect to the daemon, auto-starting it if needed. On any failure to reach a
 * socket-backed daemon (and when not explicitly required), falls back to an
 * in-process client so the caller always gets a working DaemonClient.
 */
export async function connectDaemon(opts: ConnectOptions = {}): Promise<DaemonClient> {
  const configDir = opts.configDir ?? userConfigDir();

  if (opts.inProcess) {
    return new InProcessClient(
      opts.manager ??
        new SessionManager({ persistence: new FilePersistence(daemonPaths(configDir).stateDir) }),
    );
  }

  const { socketPath } = daemonPaths(configDir);

  // 1) try an existing daemon.
  const existing = await trySocket(socketPath);
  if (existing) return existing;

  if (opts.noAutoStart) {
    throw new Error(`no archon daemon running at ${socketPath} (start one with \`archon daemon\`)`);
  }

  // 2) auto-start, then connect with a short retry loop.
  try {
    await spawnDaemon(configDir);
    const c = await waitForSocket(socketPath, opts.startTimeoutMs ?? 5000);
    if (c) return c;
  } catch {
    // fall through to in-process.
  }

  // 3) fallback: in-process manager (tests / restricted environments).
  return new InProcessClient(
    opts.manager ??
      new SessionManager({ persistence: new FilePersistence(daemonPaths(configDir).stateDir) }),
  );
}

async function trySocket(socketPath: string): Promise<SocketClient | undefined> {
  try {
    const c = await SocketClient.connect(socketPath);
    await c.handshake();
    return c;
  } catch {
    return undefined;
  }
}

async function waitForSocket(socketPath: string, timeoutMs: number): Promise<SocketClient | undefined> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const c = await trySocket(socketPath);
    if (c) return c;
    await new Promise((r) => setTimeout(r, 50));
  }
  return undefined;
}

/** Spawn `archon daemon` detached so it outlives this process. */
async function spawnDaemon(configDir: string): Promise<void> {
  const cliPath = new URL("../cli.ts", import.meta.url).pathname;
  const proc = Bun.spawn(["bun", "run", cliPath, "daemon"], {
    env: { ...process.env, ARCHON_CONFIG_DIR: configDir },
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  });
  proc.unref?.();
}
