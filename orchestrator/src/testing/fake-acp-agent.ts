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
 *  - session/prompt with a prompt CONTAINING "edit" -> first emits a thought chunk +
 *    a tool_call (pending) update, then calls session/request_permission and BLOCKS;
 *    once the client selects an option it emits a tool_call_update (completed) and
 *    the normal reply chunks. If the client cancels (or session/cancel arrives) it
 *    returns { stopReason: "cancelled" }. This drives the interactive flow with no
 *    real model.
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

/** A prompt containing this word triggers the interactive tool-call + permission flow. */
export const FAKE_EDIT_TRIGGER = "edit";
/** The tool-call id + permission option ids the fake agent uses (deterministic). */
export const FAKE_TOOL_CALL_ID = "fake-tool-1";
export const FAKE_TOOL_TITLE = "Edit src/example.txt";
export const FAKE_ALLOW_OPTION = "allow";
export const FAKE_REJECT_OPTION = "reject";

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

    // Detect the interactive trigger from the prompt text content blocks.
    const promptText = (params.prompt ?? [])
      .map((b) => (b.type === "text" ? b.text : ""))
      .join(" ")
      .toLowerCase();

    if (promptText.includes(FAKE_EDIT_TRIGGER)) {
      const cancelled = await this.runInteractiveEdit(sessionId);
      if (cancelled) return { stopReason: "cancelled" };
    }

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

  /**
   * The interactive edit flow: thought chunk -> pending tool_call -> request
   * permission (BLOCKS) -> on allow, tool_call_update completed; on reject/cancel,
   * tool_call_update failed. Returns true if the turn was cancelled.
   */
  private async runInteractiveEdit(sessionId: string): Promise<boolean> {
    await this.conn.sessionUpdate({
      sessionId,
      update: {
        sessionUpdate: "agent_thought_chunk",
        content: { type: "text", text: "I should edit the file." },
      },
    });
    await this.conn.sessionUpdate({
      sessionId,
      update: {
        sessionUpdate: "tool_call",
        toolCallId: FAKE_TOOL_CALL_ID,
        title: FAKE_TOOL_TITLE,
        kind: "edit",
        status: "pending",
      },
    });

    const res = await this.conn.requestPermission({
      sessionId,
      toolCall: {
        toolCallId: FAKE_TOOL_CALL_ID,
        title: FAKE_TOOL_TITLE,
        kind: "edit",
      },
      options: [
        { optionId: FAKE_ALLOW_OPTION, name: "Allow", kind: "allow_once" },
        { optionId: FAKE_REJECT_OPTION, name: "Reject", kind: "reject_once" },
      ],
    });

    const outcome = res.outcome;
    const allowed =
      outcome.outcome === "selected" && outcome.optionId === FAKE_ALLOW_OPTION;

    await this.conn.sessionUpdate({
      sessionId,
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: FAKE_TOOL_CALL_ID,
        status: allowed ? "completed" : "failed",
      },
    });

    if (outcome.outcome === "cancelled" || this.cancelled.has(sessionId)) {
      return true;
    }
    return false;
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
