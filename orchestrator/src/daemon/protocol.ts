/**
 * Daemon wire protocol (ADR-0004).
 *
 * A tiny JSON-RPC-ish framing over a Unix-domain socket. Each message is a single
 * line of JSON terminated by "\n" (newline-delimited JSON, like ACP's ndJsonStream).
 *
 * Three message shapes travel the wire:
 *   - request   { id, method, params }            client -> daemon
 *   - response  { id, result }   | { id, error }  daemon -> client (terminal)
 *   - update    { stream, event }                 daemon -> client (0..n, for streaming methods)
 *
 * `stream` ties an update to the request id that opened it, so a client can fan
 * many concurrent streaming calls over one connection.
 */
import type { AgentUpdateEvent, PermissionMode } from "../backend/types.ts";
import type { SessionSnapshot, ManagerEvent } from "../core/session-manager.ts";

/** Bumped when the wire contract changes; client + daemon must agree. */
export const PROTOCOL_VERSION = 1;

export type DaemonMethod =
  | "ping"
  | "handshake"
  | "listSessions"
  | "createSession"
  | "prompt"
  | "attach"
  | "answerPermission"
  | "setInteractive"
  | "stop"
  | "logs"
  | "shutdown";

export interface RpcRequest {
  id: number;
  method: DaemonMethod;
  params?: unknown;
}

export interface RpcResponseOk {
  id: number;
  result: unknown;
}

export interface RpcResponseErr {
  id: number;
  error: { message: string; code?: string };
}

export type RpcResponse = RpcResponseOk | RpcResponseErr;

/** Out-of-band streaming payload tied to the request id that opened the stream. */
export interface RpcUpdate {
  /** Request id this update belongs to. */
  stream: number;
  event: StreamEvent;
}

export type WireMessage = RpcRequest | RpcResponse | RpcUpdate;

// -- Streaming event payloads --------------------------------------------------

/** prompt() streams these as the turn progresses, then the response resolves. */
export type PromptStreamEvent =
  | { kind: "chunk"; update: AgentUpdateEvent }
  | { kind: "state"; session: SessionSnapshot };

/** attach() streams full manager events (session_created/updated/chunk/removed). */
export type AttachStreamEvent = ManagerEvent;

export type StreamEvent = PromptStreamEvent | AttachStreamEvent;

// -- Method param/result shapes ------------------------------------------------

export interface HandshakeResult {
  protocolVersion: number;
  daemonVersion: string;
  pid: number;
}

export interface ListSessionsResult {
  sessions: SessionSnapshot[];
}

export interface CreateSessionParams {
  agent: string;
  cwd: string;
  acpCmd?: string[];
  permissionMode?: PermissionMode;
  env?: Record<string, string>;
  configAgents?: Record<string, string[]>;
  skipLauncherCheck?: boolean;
}
export interface CreateSessionResult {
  id: string;
}

export interface PromptParams {
  id: string;
  text: string;
}
export interface PromptResult {
  message: string;
  stopReason: string;
}

export interface AnswerPermissionParams {
  id: string;
  /** Chosen optionId, or null to cancel the request. */
  optionId: string | null;
}

export interface SetInteractiveParams {
  id: string;
  on: boolean;
}

export interface StopParams {
  id: string;
  /** When true, dispose+remove the session; otherwise just cancel the turn. */
  remove?: boolean;
}

export interface LogsParams {
  id: string;
}
export interface LogsResult {
  session: SessionSnapshot | undefined;
  /** Accumulated transcript text (assistant chunks joined). */
  transcript: string;
}

// -- Framing helpers -----------------------------------------------------------

export function encode(msg: WireMessage): string {
  return JSON.stringify(msg) + "\n";
}

/**
 * Stateful newline-delimited JSON decoder. Feed it raw socket chunks; it yields
 * complete parsed messages and buffers any partial trailing line.
 */
export class LineDecoder {
  private buf = "";

  push(chunk: string): WireMessage[] {
    this.buf += chunk;
    const out: WireMessage[] = [];
    let nl: number;
    while ((nl = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, nl);
      this.buf = this.buf.slice(nl + 1);
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        out.push(JSON.parse(trimmed) as WireMessage);
      } catch {
        // drop malformed frame; keep the stream alive.
      }
    }
    return out;
  }
}

export function isRequest(m: WireMessage): m is RpcRequest {
  return "method" in m && "id" in m;
}
export function isUpdate(m: WireMessage): m is RpcUpdate {
  return "stream" in m;
}
export function isResponse(m: WireMessage): m is RpcResponse {
  return "id" in m && !("method" in m) && !("stream" in m);
}
