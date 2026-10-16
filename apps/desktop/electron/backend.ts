import { EventEmitter } from "node:events";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { DesktopOutput } from "../host-protocol.ts";
import { validateRequest } from "./policy.ts";

/** The daemon remains independent; this process owns only the existing UI host. */
type HostChild = ChildProcessWithoutNullStreams & EventEmitter;
export class Backend {
  private child?: HostChild;
  private sequence = 0;
  private pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private closing = false;
  constructor(private options: {
    executable: string; args: string[]; env: NodeJS.ProcessEnv;
    emit: (channel: string, value: unknown) => void;
    native: (method: string, args: Record<string, unknown>) => Promise<void>;
    log: (message: string) => void;
  }) {}
  private start() {
    if (this.closing) throw new Error("The desktop app is closing");
    if (this.child) return;
    const child = spawn(this.options.executable, this.options.args, { env: this.options.env, stdio: "pipe", windowsHide: true }) as HostChild;
    this.child = child;
    let buffer = Buffer.alloc(0);
    const fail = (message: string) => {
      if (this.child !== child) return;
      this.child = undefined;
      child.kill();
      for (const item of this.pending.values()) { clearTimeout(item.timer); item.reject(new Error(message)); }
      this.pending.clear();
      this.options.log(message);
      if (!this.closing) this.options.emit("demesne:desktop-error", { message });
    };
    child.on("error", (error: Error) => fail(`Desktop backend could not start: ${error.message}`));
    child.on("exit", (code: number | null, signal: string | null) => fail(`Desktop backend exited (${code ?? signal})`));
    child.stdin.on("error", error => fail(`Desktop backend disconnected: ${error.message}`));
    child.stderr.on("data", bytes => this.options.log(String(bytes)));
    child.stdout.on("data", (bytes: Buffer) => {
      buffer = Buffer.concat([buffer, bytes]);
      try {
        let index: number;
        while ((index = buffer.indexOf(10)) >= 0) {
          if (index > 32 * 1024 * 1024) throw new Error("Desktop backend exceeded the message limit");
          const frame = buffer.subarray(0, index); buffer = buffer.subarray(index + 1);
          if (frame.length) this.receive(JSON.parse(frame.toString("utf8")), child);
        }
        if (buffer.length > 32 * 1024 * 1024) throw new Error("Desktop backend exceeded the message limit");
      } catch (error) { fail(`Invalid desktop backend message: ${String(error)}`); }
    });
  }
  private receive(value: DesktopOutput, child: HostChild) {
    switch (value.kind) {
      case "response": {
        const pending = this.pending.get(value.id);
        if (!pending) return;
        clearTimeout(pending.timer); this.pending.delete(value.id);
        if (value.ok) pending.resolve(value.value); else pending.reject(new Error(value.error));
        break;
      }
      case "update": this.options.emit("demesne:update", value.update); break;
      case "command": this.options.emit("demesne:command", value.command); break;
      case "protocol-error": this.options.log(value.error); break;
      case "native": {
        // Correlate against the originating host, even if it fails during a dialog.
        void this.options.native(value.method, value.args).then(
          () => ({ kind: "native-response", id: value.id, ok: true }),
          error => ({ kind: "native-response", id: value.id, ok: false, error: String(error) }),
        ).then(reply => { if (this.child === child && !child.stdin.destroyed) child.stdin.write(JSON.stringify(reply) + "\n"); });
        break;
      }
      default: throw new Error("Unknown desktop backend message");
    }
  }
  request(method: string, args: Record<string, unknown> = {}): Promise<unknown> {
    validateRequest(method, args);
    if (method !== "shutdown") this.start();
    if (!this.child) return Promise.reject(new Error("Desktop backend is not running"));
    if (this.pending.size >= 64) return Promise.reject(new Error("Too many pending desktop requests"));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error("The desktop backend did not respond in time")); }, 120_000);
      this.pending.set(id, { resolve, reject, timer });
      this.child!.stdin.write(JSON.stringify({ kind: "request", id, method, args }) + "\n");
    });
  }
  async close() {
    if (this.closing) return;
    this.closing = true;
    if (this.child) {
      // EOF invokes host.dispose(), including Drive handoff, even if shutdown is busy.
      const child = this.child;
      await new Promise<void>(resolve => {
        const timer = setTimeout(() => { child.kill(); resolve(); }, 2500);
        child.once("exit", () => { clearTimeout(timer); resolve(); });
        child.stdin.end();
      });
    }
    for (const item of this.pending.values()) { clearTimeout(item.timer); item.reject(new Error("Desktop closed")); }
    this.pending.clear();
  }
}
