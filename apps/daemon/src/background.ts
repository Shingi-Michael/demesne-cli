import { randomUUID } from "node:crypto";

const STREAM_LIMIT_BYTES = 256 * 1024;
const MAX_PROCESSES = 16;

interface BackgroundEntry {
  pid: number;
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

  spawn(argv: string[], cwd: string, env: Record<string, string>): { handle: string; pid: number } {
    if (this.entries.size >= MAX_PROCESSES) {
      for (const [handle, entry] of [...this.entries]) {
        if (!entry.running) this.entries.delete(handle);
      }
    }
    if (this.entries.size >= MAX_PROCESSES) {
      const error = new Error("[TOO_MANY_BACKGROUND] 16 processes already running. Hint: command_stop one first.");
      throw error;
    }
    const child = Bun.spawn(argv, { cwd, detached: true, stdin: "ignore", stdout: "pipe", stderr: "pipe", env });
    const handle = randomUUID().slice(0, 12);
    const entry: BackgroundEntry = {
      pid: child.pid,
      running: true,
      exitCode: null,
      timedOut: false,
      out: { text: "", dropped: 0, decoder: new TextDecoder() },
      err: { text: "", dropped: 0, decoder: new TextDecoder() },
    };
    this.entries.set(handle, entry);
    void this.pump(child, child.stdout, entry.out);
    void this.pump(child, child.stderr, entry.err);
    void child.exited.then((code) => {
      entry.running = false;
      entry.exitCode = code;
    }).catch(() => {
      entry.running = false;
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
  ): Promise<void> {
    const reader = stream.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      sink.text += sink.decoder.decode(value, { stream: true });
      if (sink.text.length > STREAM_LIMIT_BYTES) {
        const drop = sink.text.length - STREAM_LIMIT_BYTES;
        sink.dropped += drop;
        sink.text = sink.text.slice(drop);
      }
    }
    void child;
  }
}

function sliceFrom(stream: { text: string; dropped: number }, from: number): string {
  const start = Math.max(0, from - stream.dropped);
  if (start >= stream.text.length) return "";
  return stream.text.slice(start);
}

export const backgroundProcesses = new BackgroundProcesses();
