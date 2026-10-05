import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { CodexClient, type CodexClientOptions } from "../src/index.ts";

export type Frame = { id?: string | number; method?: string; params?: unknown; result?: unknown; error?: { code: number; message: string } };

class Process extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  exitCode: number | null = null;
  signalCode: string | null = null;
  pid = 123;
  kill() { this.exitCode = 0; queueMicrotask(() => this.emit("close", 0)); return true; }
}

/** In-memory protocol peer: no credentials, network or installed Codex runtime involved. */
export async function harness(options: Partial<CodexClientOptions> = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), "demesne-codex-test-"));
  const frames: Frame[] = [];
  let child: Process;
  let spawnOptions: { cwd: string; env: NodeJS.ProcessEnv };
  let args: string[] = [];
  let route: (frame: Frame) => void = () => {};
  let config: Record<string, unknown> = { mcp_servers: {}, features: { skip_host_skill_discovery: true }, project_doc_max_bytes: 0 };
  const client = new CodexClient({ dataDir, binary: "fixture", ...options, spawn(_bin, argv, opts) {
    child = new Process(); args = argv; spawnOptions = opts;
    let buffer = "";
    child.stdin.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
      let newline: number;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        const frame: Frame = JSON.parse(buffer.slice(0, newline)); buffer = buffer.slice(newline + 1);
        frames.push(frame);
        if (frame.method === "initialize") queueMicrotask(() => send({ id: frame.id, result: { userAgent: "fixture" } }));
        else if (frame.method === "config/read") queueMicrotask(() => send({ id: frame.id, result: { config } }));
        else if (frame.method && frame.id !== undefined) route(frame);
      }
    });
    return child as unknown as ChildProcessWithoutNullStreams;
  } });
  function send(frame: Frame) { child.stdout.write(JSON.stringify(frame) + "\n"); }
  return { dataDir, client, frames, send, get args() { return args; }, get spawnOptions() { return spawnOptions; },
    raw(bytes: Buffer | string) { child.stdout.write(bytes); },
    route(callback: (frame: Frame) => void) { route = callback; },
    configure(value: Record<string, unknown>) { config = { ...config, ...value }; },
    exit() { child.kill(); },
    async close() { await client.close(); await rm(dataDir, { recursive: true, force: true }); },
  };
}
