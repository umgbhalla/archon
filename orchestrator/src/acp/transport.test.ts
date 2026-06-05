import { test, expect } from "bun:test";
import { ndJsonStream } from "./types.ts";

/**
 * Verify newline-delimited JSON framing: messages written to the Stream's
 * writable come out as one JSON object per line on the underlying byte stream,
 * and bytes fed into the readable are parsed back into message objects.
 */
test("ndJsonStream encodes outgoing messages as one JSON object per line", async () => {
  const encoded: Uint8Array[] = [];
  const byteOut = new WritableStream<Uint8Array>({
    write(chunk) {
      encoded.push(chunk);
    },
  });
  const byteIn = new ReadableStream<Uint8Array>({ start(c) { c.close(); } });

  const stream = ndJsonStream(byteOut, byteIn);
  const writer = stream.writable.getWriter();
  await writer.write({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} } as any);
  await writer.write({ jsonrpc: "2.0", id: 2, method: "session/new", params: {} } as any);
  await writer.close();

  const text = new TextDecoder().decode(
    new Uint8Array(encoded.flatMap((c) => [...c])),
  );
  const lines = text.split("\n").filter((l) => l.length > 0);
  expect(lines.length).toBe(2);
  expect(JSON.parse(lines[0]!)).toMatchObject({ jsonrpc: "2.0", id: 1, method: "initialize" });
  expect(JSON.parse(lines[1]!)).toMatchObject({ jsonrpc: "2.0", id: 2, method: "session/new" });
});

test("ndJsonStream decodes incoming newline-delimited JSON into messages", async () => {
  const payload =
    '{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":1}}\n' +
    '{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s1"}}\n';
  const byteIn = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(new TextEncoder().encode(payload));
      c.close();
    },
  });
  const byteOut = new WritableStream<Uint8Array>({ write() {} });

  const stream = ndJsonStream(byteOut, byteIn);
  const reader = stream.readable.getReader();
  const first = await reader.read();
  const second = await reader.read();

  expect(first.value).toMatchObject({ id: 1, result: { protocolVersion: 1 } });
  expect(second.value).toMatchObject({ method: "session/update" });
});
