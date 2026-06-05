/**
 * ACP stdio transport: spawn an agent subprocess and wire its stdin/stdout to an
 * ACP ClientSideConnection over newline-delimited JSON (the SDK's ndJsonStream).
 *
 * This is the bridge between a child process and the protocol layer. The caller
 * supplies a `Client` handler factory (how to answer session/update,
 * session/request_permission, fs/read|write). We own the process lifecycle.
 */
import { spawn, type Subprocess } from "bun";
import { ClientSideConnection, ndJsonStream } from "@zed-industries/agent-client-protocol";
import type { Client } from "@zed-industries/agent-client-protocol";

export interface SpawnAgentOptions {
  /** Executable + args, e.g. ["bun", "run", "fake-acp-agent.ts"] or ["gemini", "--experimental-acp"]. */
  command: string[];
  cwd?: string;
  env?: Record<string, string>;
}

export interface AgentProcess {
  /** The client-side ACP connection (call initialize/newSession/prompt/... on it). */
  connection: ClientSideConnection;
  /** The underlying child process. */
  proc: Subprocess<"pipe", "pipe", "pipe">;
  /** Resolves with the process exit code. */
  exited: Promise<number>;
  /** Kill the subprocess. */
  kill(): void;
}

/**
 * Convert a Node/Bun WritableStream-less stdin (a FileSink) into a WHATWG
 * WritableStream<Uint8Array> that ndJsonStream can write framed messages to.
 */
function sinkToWritable(stdin: import("bun").FileSink): WritableStream<Uint8Array> {
  return new WritableStream<Uint8Array>({
    write(chunk) {
      stdin.write(chunk);
      void stdin.flush();
    },
    close() {
      void stdin.end();
    },
    abort() {
      void stdin.end();
    },
  });
}

/**
 * Spawn an ACP agent subprocess and return a connected ClientSideConnection.
 * `toClient` receives the Agent proxy and must return the Client handler.
 */
export function spawnAcpAgent(
  opts: SpawnAgentOptions,
  toClient: (agent: import("@zed-industries/agent-client-protocol").Agent) => Client,
): AgentProcess {
  const [cmd, ...args] = opts.command;
  if (!cmd) throw new Error("spawnAcpAgent: empty command");

  const proc = spawn([cmd, ...args], {
    cwd: opts.cwd,
    env: opts.env ? { ...process.env, ...opts.env } : process.env,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  }) as Subprocess<"pipe", "pipe", "pipe">;

  // agent stdout -> client readable; client writable -> agent stdin.
  const input: ReadableStream<Uint8Array> = proc.stdout;
  const output: WritableStream<Uint8Array> = sinkToWritable(proc.stdin);

  const stream = ndJsonStream(output, input);
  const connection = new ClientSideConnection(toClient, stream);

  return {
    connection,
    proc,
    exited: proc.exited,
    kill() {
      try {
        proc.kill();
      } catch {
        /* already dead */
      }
    },
  };
}
