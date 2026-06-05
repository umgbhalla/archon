/**
 * Archon supervisor daemon (ADR-0004).
 *
 * A per-user process that owns a SessionManager and serves it over a local
 * Unix-domain socket under the config dir (default ~/.archon/daemon.sock; honors
 * ARCHON_CONFIG_DIR). The CLI/TUI connect as thin clients (src/daemon/client.ts)
 * and stream live session updates; sessions survive across CLI/TUI invocations.
 *
 * Wire protocol: newline-delimited JSON-RPC-ish (src/daemon/protocol.ts).
 * Persistence: FilePersistence (roster.json + per-session dirs) so a daemon
 * restart recovers the roster via SessionManager.restore().
 *
 * Security: the socket is created with owner-only perms (0700 dir + 0600 socket).
 */
import { chmod, mkdir, rm, writeFile, readFile, stat } from "node:fs/promises";
import type { Socket } from "bun";
import { SessionManager, type ManagerEvent } from "../core/session-manager.ts";
import { FilePersistence, daemonPaths } from "./persistence.ts";
import {
  encode,
  LineDecoder,
  PROTOCOL_VERSION,
  isRequest,
  type RpcRequest,
  type StreamEvent,
  type CreateSessionParams,
  type PromptParams,
  type StopParams,
  type LogsParams,
} from "./protocol.ts";

const DAEMON_VERSION = "0.1.0";

interface ConnState {
  decoder: LineDecoder;
  /** Active attach stream subscriptions for this connection: request id -> listener. */
  attachStreams: Map<number, (ev: ManagerEvent) => void>;
}

export interface DaemonServerOptions {
  configDir: string;
  /** Injected manager (tests); otherwise built with FilePersistence on configDir. */
  manager?: SessionManager;
  /** Called once the socket is listening (tests). */
  onListening?: (info: { socketPath: string }) => void;
}

export class DaemonServer {
  private manager: SessionManager;
  private socketPath: string;
  private pidPath: string;
  private stateDir: string;
  private configDir: string;
  private server?: ReturnType<typeof Bun.listen>;
  private conns = new WeakMap<Socket<ConnState>, ConnState>();
  private closing = false;

  constructor(private readonly opts: DaemonServerOptions) {
    const paths = daemonPaths(opts.configDir);
    this.socketPath = paths.socketPath;
    this.pidPath = paths.pidPath;
    this.stateDir = paths.stateDir;
    this.configDir = opts.configDir;
    this.manager =
      opts.manager ??
      new SessionManager({ persistence: new FilePersistence(this.stateDir) });
  }

  getManager(): SessionManager {
    return this.manager;
  }
  getSocketPath(): string {
    return this.socketPath;
  }

  /** Start listening + recover persisted sessions. Throws if already running. */
  async start(): Promise<void> {
    await mkdir(this.configDir, { recursive: true });
    // owner-only on the config dir (best-effort; ignore on platforms w/o chmod).
    await chmod(this.configDir, 0o700).catch(() => {});

    // Stale-socket guard: if a socket file exists but no daemon answers, clear it.
    if (await this.pathExists(this.socketPath)) {
      const alive = await this.probe();
      if (alive) throw new Error(`daemon already running at ${this.socketPath}`);
      await rm(this.socketPath, { force: true }).catch(() => {});
    }

    // Recover roster from disk before accepting connections.
    await this.manager.restore().catch(() => {});

    const self = this;
    this.server = Bun.listen<ConnState>({
      unix: this.socketPath,
      socket: {
        open(socket) {
          const state: ConnState = { decoder: new LineDecoder(), attachStreams: new Map() };
          socket.data = state;
          self.conns.set(socket, state);
        },
        data(socket, data) {
          const state = socket.data;
          for (const msg of state.decoder.push(data.toString())) {
            if (isRequest(msg)) void self.handle(socket, msg);
          }
        },
        close(socket) {
          self.teardownConn(socket);
        },
        error(socket) {
          self.teardownConn(socket);
        },
      },
    });

    await chmod(this.socketPath, 0o600).catch(() => {});
    await writeFile(this.pidPath, String(process.pid)).catch(() => {});
    this.opts.onListening?.({ socketPath: this.socketPath });
  }

  /** Stop the server: dispose sessions, unlink socket + pid file. */
  async stop(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    try {
      // keep persisted metadata so a restart recovers the roster (ADR-0011).
      await this.manager.dispose({ purge: false });
    } catch {
      /* best effort */
    }
    this.server?.stop(true);
    await rm(this.socketPath, { force: true }).catch(() => {});
    await rm(this.pidPath, { force: true }).catch(() => {});
  }

  // --- request handling ---

  private async handle(socket: Socket<ConnState>, req: RpcRequest): Promise<void> {
    try {
      const result = await this.dispatch(socket, req);
      this.send(socket, { id: req.id, result });
    } catch (err) {
      this.send(socket, { id: req.id, error: { message: (err as Error).message } });
    }
  }

  private async dispatch(socket: Socket<ConnState>, req: RpcRequest): Promise<unknown> {
    switch (req.method) {
      case "ping":
        return { ok: true };

      case "handshake":
        return {
          protocolVersion: PROTOCOL_VERSION,
          daemonVersion: DAEMON_VERSION,
          pid: process.pid,
        };

      case "listSessions":
        return { sessions: this.manager.snapshot().sessions };

      case "createSession": {
        const p = req.params as CreateSessionParams;
        const id = await this.manager.createSession({
          agent: p.agent,
          cwd: p.cwd,
          acpCmd: p.acpCmd,
          permissionMode: p.permissionMode,
          env: p.env,
          configAgents: p.configAgents,
          skipLauncherCheck: p.skipLauncherCheck,
        });
        return { id };
      }

      case "prompt": {
        const p = req.params as PromptParams;
        // stream chunks for THIS session as PromptStreamEvent updates.
        const onChunk = (ev: { id: string; update: unknown }) => {
          if (ev.id !== p.id) return;
          this.stream(socket, req.id, {
            kind: "chunk",
            update: ev.update as never,
          });
        };
        this.manager.on("session_chunk", onChunk);
        try {
          const res = await this.manager.prompt(p.id, p.text);
          const snap = this.manager.get(p.id);
          if (snap) this.stream(socket, req.id, { kind: "state", session: snap });
          return res;
        } finally {
          this.manager.off("session_chunk", onChunk);
        }
      }

      case "attach": {
        // subscribe this connection to the full manager event stream until close.
        const state = socket.data;
        const listener = (ev: ManagerEvent) => this.stream(socket, req.id, ev);
        state.attachStreams.set(req.id, listener);
        this.manager.on("event", listener);
        // prime with current roster as session_created events.
        for (const s of this.manager.snapshot().sessions) {
          this.stream(socket, req.id, { type: "session_created", session: s });
        }
        return { attached: true };
      }

      case "stop": {
        const p = req.params as StopParams;
        if (p.remove) {
          await this.manager.remove(p.id);
        } else {
          await this.manager.cancel(p.id);
        }
        return { ok: true };
      }

      case "logs": {
        const p = req.params as LogsParams;
        const transcript = await this.manager.transcript(p.id);
        return { session: this.manager.get(p.id), transcript };
      }

      case "shutdown":
        // ack first, then stop on the next tick so the client gets a response.
        queueMicrotask(() => void this.stop().then(() => process.exit?.(0)));
        return { ok: true };

      default:
        throw new Error(`unknown method "${(req as RpcRequest).method}"`);
    }
  }

  private stream(socket: Socket<ConnState>, streamId: number, event: StreamEvent): void {
    this.write(socket, encode({ stream: streamId, event }));
  }

  private send(socket: Socket<ConnState>, msg: { id: number; result?: unknown; error?: { message: string } }): void {
    this.write(socket, encode(msg as never));
  }

  private write(socket: Socket<ConnState>, s: string): void {
    try {
      socket.write(s);
    } catch {
      /* peer gone */
    }
  }

  private teardownConn(socket: Socket<ConnState>): void {
    const state = this.conns.get(socket) ?? socket.data;
    if (!state) return;
    for (const listener of state.attachStreams.values()) {
      this.manager.off("event", listener);
    }
    state.attachStreams.clear();
  }

  // --- helpers ---

  private async pathExists(p: string): Promise<boolean> {
    try {
      await stat(p);
      return true;
    } catch {
      return false;
    }
  }

  /** Best-effort liveness probe of an existing socket (returns true if it answers). */
  private async probe(): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      let settled = false;
      const done = (v: boolean) => {
        if (!settled) {
          settled = true;
          resolve(v);
        }
      };
      const timer = setTimeout(() => done(false), 250);
      try {
        void Bun.connect({
          unix: this.socketPath,
          socket: {
            open(s) {
              clearTimeout(timer);
              s.end();
              done(true);
            },
            data() {},
            error() {
              clearTimeout(timer);
              done(false);
            },
          },
        }).catch(() => {
          clearTimeout(timer);
          done(false);
        });
      } catch {
        clearTimeout(timer);
        done(false);
      }
    });
  }
}

/** Read the daemon pid (if any) recorded under the config dir. */
export async function readDaemonPid(configDir: string): Promise<number | undefined> {
  try {
    const { pidPath } = daemonPaths(configDir);
    const raw = await readFile(pidPath, "utf8");
    const pid = Number(raw.trim());
    return Number.isFinite(pid) ? pid : undefined;
  } catch {
    return undefined;
  }
}

/** Entry point used by `archon daemon` (foreground). Resolves when the daemon stops. */
export async function runDaemon(configDir: string): Promise<void> {
  const server = new DaemonServer({ configDir });
  await server.start();
  process.stderr.write(`[archon-daemon] listening on ${server.getSocketPath()} (pid ${process.pid})\n`);
  const shutdown = () => void server.stop().then(() => process.exit(0));
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  // keep alive until stop()/signal.
  await new Promise<void>(() => {});
}
