#!/usr/bin/env bun
/**
 * Fake ACP agent (the AGENT side of the protocol) — a tiny standalone server that
 * speaks JSON-RPC-2.0-over-stdio via the SDK's AgentSideConnection.
 *
 * Behavior:
 *  - initialize  -> echoes PROTOCOL_VERSION + advertises minimal capabilities.
 *  - session/new -> returns a generated sessionId.
 *  - session/prompt -> emits 3 agent_message_chunk notifications, then returns
 *    { stopReason: "end_turn" }.
 *  - session/cancel -> sets a flag so an in-flight prompt returns "cancelled".
 *
 * Lets us test the client end-to-end with no external credentials.
 * Run directly:  bun run src/testing/fake-acp-agent.ts   (it then talks ACP on stdio)
 */
import {
  AgentSideConnection,
  ndJsonStream,
  PROTOCOL_VERSION,
} from "@agentclientprotocol/sdk";
import type {
  Agent,
  AgentSideConnection as AgentConn,
  InitializeRequest,
  InitializeResponse,
  NewSessionRequest,
  NewSessionResponse,
  PromptRequest,
  PromptResponse,
  CancelNotification,
  AuthenticateRequest,
  AuthenticateResponse,
} from "@agentclientprotocol/sdk";

/** The reply chunks the fake agent streams for any prompt. */
export const FAKE_CHUNKS = ["Hello", " from", " the fake ACP agent!"] as const;
export const FAKE_REPLY = FAKE_CHUNKS.join("");

class FakeAgent implements Agent {
  private cancelled = new Set<string>();
  private counter = 0;

  constructor(private readonly conn: AgentConn) {}

  async initialize(_params: InitializeRequest): Promise<InitializeResponse> {
    return {
      protocolVersion: PROTOCOL_VERSION,
      agentCapabilities: {
        loadSession: false,
        promptCapabilities: { image: false, audio: false, embeddedContext: false },
      },
      authMethods: [],
    };
  }

  async authenticate(_params: AuthenticateRequest): Promise<AuthenticateResponse> {
    // No auth required for the fake agent.
    return {};
  }

  async newSession(_params: NewSessionRequest): Promise<NewSessionResponse> {
    const sessionId = `fake-session-${++this.counter}`;
    return { sessionId };
  }

  async prompt(params: PromptRequest): Promise<PromptResponse> {
    const { sessionId } = params;
    this.cancelled.delete(sessionId);
    for (const text of FAKE_CHUNKS) {
      if (this.cancelled.has(sessionId)) {
        return { stopReason: "cancelled" };
      }
      await this.conn.sessionUpdate({
        sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text },
        },
      });
      // tiny yield so chunks are observably streamed, not batched.
      await new Promise((r) => setTimeout(r, 1));
    }
    return { stopReason: "end_turn" };
  }

  async cancel(params: CancelNotification): Promise<void> {
    this.cancelled.add(params.sessionId);
  }
}

/** Wire the fake agent to this process's stdio and start serving. */
export function startFakeAgentOnStdio(): void {
  // Bun: process.stdout is a Node stream; convert to WHATWG streams for ndJsonStream.
  const input = Bun.stdin.stream() as unknown as ReadableStream<Uint8Array>;
  const output = new WritableStream<Uint8Array>({
    write(chunk) {
      Bun.write(Bun.stdout, chunk);
    },
  });
  const stream = ndJsonStream(output, input);
  // Constructing the connection starts the receive loop.
  new AgentSideConnection((conn) => new FakeAgent(conn), stream);
}

if (import.meta.main) {
  startFakeAgentOnStdio();
}
