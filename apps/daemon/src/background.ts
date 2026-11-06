import type { CommandObserver } from "./command-monitor.ts";
import { randomUUID } from "node:crypto";

const STREAM_LIMIT_BYTES = 256 * 1024;
const MAX_PROCESSES = 16;

interface BackgroundEntry {
  pid: number;
  /// The command as typed, for what a wait says it waited on.
  command: string;
  running: boolean;
  exitCode: number | null;
  timedOut: boolean;
  out: { text: string; dropped: number; decoder: TextDecoder };
  err: { text: string; dropped: number; decoder: TextDecoder };
}

/// Daemon-wide registry for backgrounded run_command processes. Buffers keep
/// only the most recent STREAM_LIMIT_BYTES per stream so chatty servers cannot
/// exhaust memory; offsets account for dropped prefixes.
export class BackgroundProcesses {
  private readonly entries = new Map<string, BackgroundEntry>();

  spawn(argv: string[], cwd: string, env: Record<string, string>, observer?:CommandObserver): { handle: string; pid: number } {
    if (this.entries.size >= MAX_PROCESSES) {
      for (const [handle, entry] of [...this.entries]) {
        if (!entry.running) this.entries.delete(handle);
      }
    }
    if (this.entries.size >= MAX_PROCESSES) {
      const error = new Error("[TOO_MANY_BACKGROUND] 16 processes already running. Hint: command_stop one first.");
      throw error;
    }
    let child: Bun.Subprocess<"ignore","pipe","pipe">;
    try{child=Bun.spawn(argv, { cwd, detached: true, stdin: "ignore", stdout: "pipe", stderr: "pipe", env });}catch(error){observer?.finished(null,false,String(error));throw error;}
    const handle = randomUUID().slice(0, 12);
    const entry: BackgroundEntry = {
      pid: child.pid,
      command: argv.map((part, at) => at === 0 ? part.split(/[\\/]/).at(-1)! : /\s/.test(part) ? JSON.stringify(part) : part).join(" ").slice(0, 200),
      running: true,
      exitCode: null,
      timedOut: false,
      out: { text: "", dropped: 0, decoder: new TextDecoder() },
      err: { text: "", dropped: 0, decoder: new TextDecoder() },
    };
    this.entries.set(handle, entry);
    observer?.started(child.pid,()=>this.stop(handle));
    const output=this.pump(child, child.stdout, entry.out,text=>observer?.output("stdout",text));
    const errors=this.pump(child, child.stderr, entry.err,text=>observer?.output("stderr",text));
    void Promise.all([child.exited,output,errors]).then(([code]) => {
      entry.running = false;
      entry.exitCode = code;
      observer?.finished(code,entry.timedOut);
    }).catch((error) => {
      entry.running = false;
      observer?.finished(null,false,String(error));
    });
    return { handle, pid: child.pid };
  }

  get(handle: string): { pid: number; running: boolean; exitCode: number | null } | null {
    const entry = this.entries.get(handle);
    if (!entry) return null;
    return { pid: entry.pid, running: entry.running, exitCode: entry.exitCode };
  }

  logs(handle: string, fromOut: number, fromErr: number): {
    found: true; running: boolean; exitCode: number | null; timedOut: boolean;
    stdout: string; stderr: string; outOffset: number; errOffset: number;
  } | null {
    const entry = this.entries.get(handle);
    if (!entry) return null;
    const stdout = sliceFrom(entry.out, fromOut);
    const stderr = sliceFrom(entry.err, fromErr);
    return {
      found: true,
      running: entry.running,
      exitCode: entry.exitCode,
      timedOut: entry.timedOut,
      stdout,
      stderr,
      outOffset: entry.out.dropped + entry.out.text.length,
      errOffset: entry.err.dropped + entry.err.text.length,
    };
  }

  stop(handle: string): { stopped: boolean } {
    const entry = this.entries.get(handle);
    if (!entry || !entry.running) return { stopped: false };
    try {
      process.kill(-entry.pid, "SIGTERM");
    } catch {
      try { process.kill(entry.pid, "SIGTERM"); } catch { /* already gone */ }
    }
    setTimeout(() => {
      if (!entry.running) return;
      try { process.kill(-entry.pid, "SIGKILL"); } catch {
        try { process.kill(entry.pid, "SIGKILL"); } catch { /* already gone */ }
      }
    }, 2_000);
    return { stopped: true };
  }

  /// Waits until the command prints a line matching `pattern` (searched from
  /// the start of what it has printed, so a "ready" already printed counts),
  /// exits, or `timeoutMs` passes. Spends no tokens: the turn just sleeps.
  async waitFor(handle: string, pattern: RegExp | null, timeoutMs: number, signal?: AbortSignal, pollMs = 150): Promise<WaitResult | null> {
    const entry = this.entries.get(handle);
    if (!entry) return null;
    const started = Date.now();
    const tail = () => lastLines(`${entry.out.text}${entry.err.text ? `\n${entry.err.text}` : ""}`, 12);
    while (true) {
      if (pattern) {
        const line = matchingLine(entry.out.text, pattern) ?? matchingLine(entry.err.text, pattern);
        if (line !== null) return { command: entry.command, status: "matched", afterMs: Date.now() - started, line, running: entry.running, exitCode: entry.exitCode, tail: tail() };
      }
      if (!entry.running) return { command: entry.command, status: "exited", afterMs: Date.now() - started, line: null, running: false, exitCode: entry.exitCode, tail: tail() };
      if (Date.now() - started >= timeoutMs) return { command: entry.command, status: "timeout", afterMs: Date.now() - started, line: null, running: true, exitCode: null, tail: tail() };
      if (signal?.aborted) throw signal.reason ?? new Error("aborted");
      await Bun.sleep(pollMs);
    }
  }

  markTimedOut(handle: string): void {
    const entry = this.entries.get(handle);
    if (entry) entry.timedOut = true;
  }

  shutdownAll(): void {
    for (const [handle, entry] of this.entries) {
      if (!entry.running) continue;
      try { process.kill(-entry.pid, "SIGKILL"); } catch {
        try { process.kill(entry.pid, "SIGKILL"); } catch { /* already gone */ }
      }
      void handle;
    }
    this.entries.clear();
  }

  private async pump(
    child: Bun.Subprocess<"ignore", "pipe", "pipe">,
    stream: ReadableStream<Uint8Array>,
    sink: { text: string; dropped: number; decoder: TextDecoder },
    onText?:(text:string)=>void,
  ): Promise<void> {
    const reader = stream.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const text=sink.decoder.decode(value,{stream:true});sink.text+=text;onText?.(text);
      if (sink.text.length > STREAM_LIMIT_BYTES) {
        const drop = sink.text.length - STREAM_LIMIT_BYTES;
        sink.dropped += drop;
        sink.text = sink.text.slice(drop);
      }
    }
    const tail=sink.decoder.decode();sink.text+=tail;if(tail)onText?.(tail);
    void child;
  }
}

export interface WaitResult {
  command: string;
  status: "matched" | "exited" | "timeout";
  afterMs: number;
  line: string | null;
  running: boolean;
  exitCode: number | null;
  tail: string;
}

function matchingLine(text: string, pattern: RegExp): string | null {
  for (const line of text.split(/\r?\n/)) if (pattern.test(stripAnsi(line))) return stripAnsi(line).trim().slice(0, 300);
  return null;
}

const stripAnsi = (text: string) => text.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "");

function lastLines(text: string, count: number): string {
  return stripAnsi(text).split(/\r?\n/).filter((line) => line.trim()).slice(-count).join("\n").slice(-2_000);
}

/// A pattern as the model wrote it: a regular expression when it parses, else
/// the literal words; always case-insensitive.
export function waitPattern(source: string): RegExp {
  try { return new RegExp(source, "i"); } catch { return new RegExp(source.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"); }
}

function sliceFrom(stream: { text: string; dropped: number }, from: number): string {
  const start = Math.max(0, from - stream.dropped);
  if (start >= stream.text.length) return "";
  return stream.text.slice(start);
}

export const backgroundProcesses = new BackgroundProcesses();
