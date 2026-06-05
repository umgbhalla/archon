/**
 * AgentBackend — the agent-agnostic control plane interface (ADR-0003).
 *
 * The UI / session manager talks ONLY to this interface. Concrete backends
 * (ACP subprocess, future agentapi/HTTP, future direct-PTY) are plugins.
 */
import type { StopReason } from "../acp/types.ts";

export type PermissionMode =
  | "default"
  | "acceptEdits"
  | "plan"
  | "bypassPermissions";

/** Normalized stream event surfaced to callers, mapped from raw ACP session/update. */
export type AgentUpdateEvent =
  | { kind: "message_chunk"; role: "assistant" | "user" | "thought"; text: string }
  | {
      kind: "tool_call";
      toolCallId: string;
      title: string;
      status?: string;
      /** ACP tool kind (read/edit/execute/...), if reported. */
      toolKind?: string;
      /** True on the first tool_call notification, false on tool_call_update. */
      isNew?: boolean;
    }
  | { kind: "plan"; entries: unknown[] }
  | { kind: "mode_changed"; modeId: string }
  | { kind: "raw"; update: unknown };

/** A single permission option offered by the agent (ACP PermissionOption). */
export interface PermissionOption {
  optionId: string;
  name: string;
  kind: "allow_once" | "allow_always" | "reject_once" | "reject_always";
}

/** A pending permission request surfaced to an interactive resolver. */
export interface PermissionRequest {
  toolTitle: string;
  toolKind?: string;
  options: PermissionOption[];
}

/**
 * Interactive permission resolver. When registered on a backend, the ACP
 * `requestPermission` callback delegates to it instead of applying the headless
 * mode policy: it must resolve with a chosen optionId, or null to cancel.
 */
export type PermissionResolver = (req: PermissionRequest) => Promise<string | null>;

/** Result of a completed prompt turn. */
export interface PromptResult {
  stopReason: StopReason;
}

/** Capabilities a backend reports after connecting. */
export interface BackendCapabilities {
  loadSession: boolean;
  promptImage: boolean;
  promptAudio: boolean;
  setMode: boolean;
}

/** Per-prompt handle: an async iterable of update events + a final result promise. */
export interface PromptHandle {
  /** Stream of normalized update events as the turn progresses. */
  updates: AsyncIterable<AgentUpdateEvent>;
  /** Resolves when the turn ends, carrying the stopReason. */
  done: Promise<PromptResult>;
}

export interface NewSessionResult {
  sessionId: string;
  modes?: { currentModeId: string; availableModeIds: string[] } | null;
}

/**
 * The uniform backend contract. One instance fronts one agent connection
 * (which may host multiple ACP sessions).
 */
export interface AgentBackend {
  /** Stable backend/agent name (e.g. "fake", "claude", "gemini"). */
  readonly name: string;
  /** Negotiated capabilities (valid after connect()). */
  readonly capabilities: BackendCapabilities;

  /** Spawn/connect + initialize the agent. Idempotent per instance. */
  connect(): Promise<void>;
  /** Create a new session rooted at cwd. */
  newSession(cwd: string): Promise<NewSessionResult>;
  /** Load an existing session (only if capabilities.loadSession). */
  loadSession?(sessionId: string, cwd: string): Promise<void>;
  /** Send a prompt; returns a streaming handle. */
  prompt(sessionId: string, text: string): PromptHandle;
  /**
   * Register (or clear, with undefined) an interactive permission resolver for a
   * session. When set, ACP `requestPermission` calls for that session delegate to
   * the resolver instead of the headless mode policy.
   */
  setPermissionResolver?(sessionId: string, resolver: PermissionResolver | undefined): void;
  /** Cancel the in-flight prompt turn for a session. */
  cancel(sessionId: string): Promise<void>;
  /** Switch session mode (only if capabilities.setMode). */
  setMode?(sessionId: string, modeId: string): Promise<void>;
  /** Tear down the connection / kill the subprocess. */
  dispose(): Promise<void>;
}
