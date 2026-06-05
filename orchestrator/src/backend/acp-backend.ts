/**
 * AcpBackend — drives an ACP agent subprocess via the stdio transport (ADR-0003).
 *
 * Routing model: ACP delivers session/update as connection-level NOTIFICATIONS
 * carrying a sessionId. We fan those out to per-session async queues so each
 * prompt() call can `for await` only its own session's updates.
 */
import { spawnAcpAgent, type AgentProcess } from "../acp/transport.ts";
import {
  PROTOCOL_VERSION,
  textBlock,
} from "../acp/types.ts";
import type {
  Agent,
  Client,
  SessionNotification,
  RequestPermissionRequest,
  RequestPermissionResponse,
  ReadTextFileRequest,
  ReadTextFileResponse,
  WriteTextFileRequest,
  WriteTextFileResponse,
} from "../acp/types.ts";
import type {
  AgentBackend,
  AgentUpdateEvent,
  BackendCapabilities,
  NewSessionResult,
  PermissionMode,
  PromptHandle,
  PromptResult,
} from "./types.ts";

/** Minimal single-producer async queue used to bridge notifications -> async iterator. */
class UpdateQueue {
  private queue: AgentUpdateEvent[] = [];
  private resolvers: ((r: IteratorResult<AgentUpdateEvent>) => void)[] = [];
  private closed = false;

  push(ev: AgentUpdateEvent): void {
    if (this.closed) return;
    const r = this.resolvers.shift();
    if (r) r({ value: ev, done: false });
    else this.queue.push(ev);
  }

  close(): void {
    this.closed = true;
    for (const r of this.resolvers) r({ value: undefined as never, done: true });
    this.resolvers = [];
  }

  iterator(): AsyncIterableIterator<AgentUpdateEvent> {
    const self = this;
    return {
      [Symbol.asyncIterator]() {
        return this;
      },
      next(): Promise<IteratorResult<AgentUpdateEvent>> {
        const ev = self.queue.shift();
        if (ev) return Promise.resolve({ value: ev, done: false });
        if (self.closed) return Promise.resolve({ value: undefined as never, done: true });
        return new Promise((resolve) => self.resolvers.push(resolve));
      },
    };
  }
}

function mapUpdate(n: SessionNotification): AgentUpdateEvent {
  const u = n.update;
  switch (u.sessionUpdate) {
    case "agent_message_chunk":
      return { kind: "message_chunk", role: "assistant", text: textOf(u.content) };
    case "user_message_chunk":
      return { kind: "message_chunk", role: "user", text: textOf(u.content) };
    case "agent_thought_chunk":
      return { kind: "message_chunk", role: "thought", text: textOf(u.content) };
    case "tool_call":
      return {
        kind: "tool_call",
        toolCallId: u.toolCallId,
        title: u.title,
        status: u.status,
      };
    case "tool_call_update":
      return {
        kind: "tool_call",
        toolCallId: u.toolCallId,
        title: u.title ?? "",
        status: u.status ?? undefined,
      };
    case "plan":
      return { kind: "plan", entries: u.entries };
    case "current_mode_update":
      return { kind: "mode_changed", modeId: u.currentModeId };
    default:
      return { kind: "raw", update: u };
  }
}

function textOf(content: { type: string; text?: string }): string {
  return content.type === "text" && typeof content.text === "string" ? content.text : "";
}

export interface AcpBackendOptions {
  name: string;
  command: string[];
  cwd?: string;
  env?: Record<string, string>;
  permissionMode?: PermissionMode;
}

export class AcpBackend implements AgentBackend {
  readonly name: string;
  capabilities: BackendCapabilities = {
    loadSession: false,
    promptImage: false,
    promptAudio: false,
    setMode: false,
  };

  private readonly opts: AcpBackendOptions;
  private agentProc?: AgentProcess;
  private connected = false;
  /** Per-session live update queues (only present while a prompt is in flight). */
  private sessionQueues = new Map<string, UpdateQueue>();

  constructor(opts: AcpBackendOptions) {
    this.name = opts.name;
    this.opts = opts;
  }

  private makeClient = (_agent: Agent): Client => {
    const backend = this;
    return {
      async sessionUpdate(params: SessionNotification): Promise<void> {
        const q = backend.sessionQueues.get(params.sessionId);
        if (q) q.push(mapUpdate(params));
      },
      async requestPermission(
        params: RequestPermissionRequest,
      ): Promise<RequestPermissionResponse> {
        // Headless policy mirrors Claude Code permission modes. ACP options carry a
        // `kind` discriminator (allow_once/allow_always/reject_once/reject_always).
        const mode = backend.opts.permissionMode ?? "default";
        const allowAlways = params.options.find((o) => o.kind === "allow_always");
        const allowOnce = params.options.find((o) => o.kind === "allow_once");
        const allow = allowOnce ?? allowAlways;
        if (mode === "bypassPermissions" || mode === "acceptEdits") {
          const opt = allow ?? params.options[0];
          if (opt) return { outcome: { outcome: "selected", optionId: opt.optionId } };
        }
        // default / plan: allow non-destructive once if offered, else cancel and let
        // a human decide (the TUI in Breadth will surface this instead).
        if (allow) return { outcome: { outcome: "selected", optionId: allow.optionId } };
        return { outcome: { outcome: "cancelled" } };
      },
      async readTextFile(params: ReadTextFileRequest): Promise<ReadTextFileResponse> {
        const file = Bun.file(params.path);
        let content = await file.text();
        if (typeof params.line === "number" || typeof params.limit === "number") {
          const lines = content.split("\n");
          const start = params.line ? params.line - 1 : 0;
          const end = params.limit ? start + params.limit : lines.length;
          content = lines.slice(start, end).join("\n");
        }
        return { content };
      },
      async writeTextFile(params: WriteTextFileRequest): Promise<WriteTextFileResponse> {
        await Bun.write(params.path, params.content);
        return {};
      },
    };
  };

  async connect(): Promise<void> {
    if (this.connected) return;
    this.agentProc = spawnAcpAgent(
      { command: this.opts.command, cwd: this.opts.cwd, env: this.opts.env },
      this.makeClient,
    );
    const res = await this.agentProc.connection.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {
        fs: { readTextFile: true, writeTextFile: true },
        terminal: false,
      },
    });
    const caps = res.agentCapabilities;
    this.capabilities = {
      loadSession: caps?.loadSession ?? false,
      promptImage: caps?.promptCapabilities?.image ?? false,
      promptAudio: caps?.promptCapabilities?.audio ?? false,
      setMode: true,
    };
    this.connected = true;
  }

  async newSession(cwd: string): Promise<NewSessionResult> {
    this.assertConnected();
    const res = await this.agentProc!.connection.newSession({ cwd, mcpServers: [] });
    const modes = res.modes
      ? {
          currentModeId: res.modes.currentModeId,
          availableModeIds: res.modes.availableModes.map((m) => m.id),
        }
      : null;
    return { sessionId: res.sessionId, modes };
  }

  async loadSession(sessionId: string, cwd: string): Promise<void> {
    this.assertConnected();
    await this.agentProc!.connection.loadSession({ sessionId, cwd, mcpServers: [] });
  }

  prompt(sessionId: string, text: string): PromptHandle {
    this.assertConnected();
    const queue = new UpdateQueue();
    this.sessionQueues.set(sessionId, queue);

    const done: Promise<PromptResult> = this.agentProc!.connection
      .prompt({ sessionId, prompt: [textBlock(text)] })
      .then((res) => ({ stopReason: res.stopReason }))
      .finally(() => {
        queue.close();
        this.sessionQueues.delete(sessionId);
      });

    return { updates: { [Symbol.asyncIterator]: () => queue.iterator() }, done };
  }

  async cancel(sessionId: string): Promise<void> {
    this.assertConnected();
    await this.agentProc!.connection.cancel({ sessionId });
  }

  async setMode(sessionId: string, modeId: string): Promise<void> {
    this.assertConnected();
    await this.agentProc!.connection.setSessionMode({ sessionId, modeId });
  }

  async dispose(): Promise<void> {
    for (const q of this.sessionQueues.values()) q.close();
    this.sessionQueues.clear();
    this.agentProc?.kill();
    this.connected = false;
  }

  private assertConnected(): void {
    if (!this.connected || !this.agentProc) {
      throw new Error(`AcpBackend("${this.name}") not connected; call connect() first`);
    }
  }
}
