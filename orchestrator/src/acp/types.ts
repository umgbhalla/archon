/**
 * ACP (Agent Client Protocol) type surface.
 *
 * We re-export the official SDK's generated schema + connection classes so the rest
 * of the codebase imports ACP types from one place. If the SDK is ever swapped for a
 * hand-rolled transport, only this module changes.
 *
 * Protocol facts honored (see https://agentclientprotocol.com):
 *  - JSON-RPC 2.0 over newline-delimited JSON on the agent subprocess stdio.
 *  - WE are the client; the agent is the subprocess.
 *  - Lifecycle: initialize -> (authenticate?) -> session/new (or session/load)
 *    -> session/prompt (streams session/update notifications) -> prompt response w/ stopReason.
 *  - Agent->client calls: session/request_permission, fs/read_text_file, fs/write_text_file, terminal/*.
 */
export {
  ClientSideConnection,
  AgentSideConnection,
  ndJsonStream,
  RequestError,
  PROTOCOL_VERSION,
} from "@agentclientprotocol/sdk";

export type {
  // connection role interfaces
  Client,
  Agent,
  Stream,
  // lifecycle
  InitializeRequest,
  InitializeResponse,
  AuthenticateRequest,
  AuthenticateResponse,
  NewSessionRequest,
  NewSessionResponse,
  LoadSessionRequest,
  LoadSessionResponse,
  PromptRequest,
  PromptResponse,
  CancelNotification,
  SetSessionModeRequest,
  SetSessionModeResponse,
  // streaming + content
  SessionNotification,
  ContentBlock,
  // client-side handler params
  RequestPermissionRequest,
  RequestPermissionResponse,
  ReadTextFileRequest,
  ReadTextFileResponse,
  WriteTextFileRequest,
  WriteTextFileResponse,
  // capabilities
  ClientCapabilities,
  AgentCapabilities,
} from "@agentclientprotocol/sdk";

/** The `stopReason` values an ACP prompt turn can end with. */
export type StopReason =
  | "end_turn"
  | "max_tokens"
  | "max_turn_requests"
  | "refusal"
  | "cancelled";

/** Convenience: a single text content block (the common prompt/response shape). */
export function textBlock(text: string): { type: "text"; text: string } {
  return { type: "text", text };
}
