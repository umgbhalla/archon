import { test, expect } from "bun:test";
import {
  emptyConversation,
  foldEvent,
  endTurn,
  pushUserEntry,
  assistantText,
  type TextEntry,
  type ToolCallEntry,
} from "./conversation.ts";
import type { AgentUpdateEvent } from "../backend/types.ts";

test("assistant chunks grow ONE streaming entry until the turn ends", () => {
  const conv = emptyConversation();
  pushUserEntry(conv, "hi");
  const chunks: AgentUpdateEvent[] = [
    { kind: "message_chunk", role: "assistant", text: "Hello" },
    { kind: "message_chunk", role: "assistant", text: " world" },
  ];
  for (const c of chunks) foldEvent(conv, c);

  // user + one assistant entry (chunks merged).
  expect(conv.entries.map((e) => e.kind)).toEqual(["user", "assistant"]);
  const asst = conv.entries[1] as TextEntry;
  expect(asst.text).toBe("Hello world");
  expect(asst.streaming).toBe(true);

  endTurn(conv);
  expect((conv.entries[1] as TextEntry).streaming).toBe(false);
  expect(assistantText(conv)).toBe("Hello world");
});

test("thought chunks open a separate entry from assistant chunks", () => {
  const conv = emptyConversation();
  foldEvent(conv, { kind: "message_chunk", role: "thought", text: "thinking" });
  foldEvent(conv, { kind: "message_chunk", role: "assistant", text: "answer" });
  expect(conv.entries.map((e) => e.kind)).toEqual(["thought", "assistant"]);
});

test("tool_call entry is created then UPDATED in place by toolCallId", () => {
  const conv = emptyConversation();
  foldEvent(conv, {
    kind: "tool_call",
    toolCallId: "t1",
    title: "Edit file",
    status: "pending",
    toolKind: "edit",
    isNew: true,
  });
  expect(conv.entries).toHaveLength(1);
  const tc = conv.entries[0] as ToolCallEntry;
  expect(tc.status).toBe("pending");

  foldEvent(conv, {
    kind: "tool_call",
    toolCallId: "t1",
    title: "",
    status: "completed",
    isNew: false,
  });
  // still ONE entry, updated in place.
  expect(conv.entries).toHaveLength(1);
  expect((conv.entries[0] as ToolCallEntry).status).toBe("completed");
  expect((conv.entries[0] as ToolCallEntry).title).toBe("Edit file"); // preserved
});

test("a new assistant turn after endTurn opens a fresh entry", () => {
  const conv = emptyConversation();
  foldEvent(conv, { kind: "message_chunk", role: "assistant", text: "one" });
  endTurn(conv);
  foldEvent(conv, { kind: "message_chunk", role: "assistant", text: "two" });
  const asst = conv.entries.filter((e) => e.kind === "assistant");
  expect(asst).toHaveLength(2);
});
