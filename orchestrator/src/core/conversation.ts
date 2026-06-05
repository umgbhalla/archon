/**
 * Structured conversation model (the chat substrate).
 *
 * A session's transcript is an ordered list of ConversationEntry. Unlike the old
 * flat assistant-text dump, entries are typed and STATEFUL:
 *
 *   - user / assistant / thought: text entries. Assistant + thought GROW as ACP
 *     message_chunk / agent_thought_chunk events stream (streaming:true until the
 *     turn ends); a user entry is pushed verbatim when prompt() is called.
 *   - tool_call: carries {toolCallId, title, status, kind} and is UPDATED IN PLACE
 *     when a tool_call_update arrives for the same toolCallId.
 *   - plan: the agent's plan entries (replaced wholesale on each plan update).
 *
 * The fold helpers below are pure so they can be unit-tested + reused by the
 * SessionManager (live) and persistence-recovery (rehydrate from disk).
 */
import type { AgentUpdateEvent } from "../backend/types.ts";

export type ConversationEntryKind =
  | "user"
  | "assistant"
  | "thought"
  | "tool_call"
  | "plan";

interface BaseEntry {
  /** Stable per-session monotonic id (assignment order). */
  id: string;
  kind: ConversationEntryKind;
  createdAt: number;
  updatedAt: number;
}

export interface TextEntry extends BaseEntry {
  kind: "user" | "assistant" | "thought";
  text: string;
  /** True while the entry is still accreting chunks; false once the turn ends. */
  streaming: boolean;
}

export interface ToolCallEntry extends BaseEntry {
  kind: "tool_call";
  toolCallId: string;
  title: string;
  status?: string;
  toolKind?: string;
}

export interface PlanEntry extends BaseEntry {
  kind: "plan";
  entries: unknown[];
}

export type ConversationEntry = TextEntry | ToolCallEntry | PlanEntry;

/** Mutable accumulator threaded through a turn (and persisted). */
export interface Conversation {
  entries: ConversationEntry[];
  /** Counter backing entry ids. */
  seq: number;
}

export function emptyConversation(): Conversation {
  return { entries: [], seq: 0 };
}

function nextId(conv: Conversation): string {
  return `e${conv.seq++}`;
}

/** Push a user entry (called when prompt() is invoked). Returns the new entry. */
export function pushUserEntry(conv: Conversation, text: string): TextEntry {
  const now = Date.now();
  const entry: TextEntry = {
    id: nextId(conv),
    kind: "user",
    text,
    streaming: false,
    createdAt: now,
    updatedAt: now,
  };
  conv.entries.push(entry);
  return entry;
}

/**
 * Fold one stream event into the conversation, mutating it in place. Returns the
 * entry that was created/updated (so callers can react), or undefined for events
 * that don't map to an entry (mode_changed / raw).
 *
 * Streaming text rule: consecutive assistant/thought chunks append to the LAST
 * entry of that kind while it is still streaming; otherwise a fresh entry opens.
 */
export function foldEvent(
  conv: Conversation,
  ev: AgentUpdateEvent,
): ConversationEntry | undefined {
  const now = Date.now();
  switch (ev.kind) {
    case "message_chunk": {
      const kind = ev.role; // user | assistant | thought
      const last = conv.entries[conv.entries.length - 1];
      if (
        last &&
        (last.kind === "assistant" || last.kind === "thought" || last.kind === "user") &&
        last.kind === kind &&
        (last as TextEntry).streaming
      ) {
        const t = last as TextEntry;
        t.text += ev.text;
        t.updatedAt = now;
        return t;
      }
      const entry: TextEntry = {
        id: nextId(conv),
        kind,
        text: ev.text,
        // user chunks aren't streamed by us, but treat consistently.
        streaming: kind !== "user",
        createdAt: now,
        updatedAt: now,
      };
      conv.entries.push(entry);
      return entry;
    }
    case "tool_call": {
      const existing = conv.entries.find(
        (e): e is ToolCallEntry => e.kind === "tool_call" && e.toolCallId === ev.toolCallId,
      );
      if (existing) {
        if (ev.title) existing.title = ev.title;
        if (ev.status !== undefined) existing.status = ev.status;
        if (ev.toolKind !== undefined) existing.toolKind = ev.toolKind;
        existing.updatedAt = now;
        return existing;
      }
      const entry: ToolCallEntry = {
        id: nextId(conv),
        kind: "tool_call",
        toolCallId: ev.toolCallId,
        title: ev.title,
        status: ev.status,
        toolKind: ev.toolKind,
        createdAt: now,
        updatedAt: now,
      };
      conv.entries.push(entry);
      return entry;
    }
    case "plan": {
      const entry: PlanEntry = {
        id: nextId(conv),
        kind: "plan",
        entries: ev.entries,
        createdAt: now,
        updatedAt: now,
      };
      conv.entries.push(entry);
      return entry;
    }
    default:
      return undefined;
  }
}

/** Mark all streaming text entries as finalized (called when a turn ends). */
export function endTurn(conv: Conversation): void {
  const now = Date.now();
  for (const e of conv.entries) {
    if ((e.kind === "assistant" || e.kind === "thought") && (e as TextEntry).streaming) {
      (e as TextEntry).streaming = false;
      e.updatedAt = now;
    }
  }
}

/** Accumulated assistant text across all turns (for the durable transcript). */
export function assistantText(conv: Conversation): string {
  return conv.entries
    .filter((e): e is TextEntry => e.kind === "assistant")
    .map((e) => e.text)
    .join("");
}
