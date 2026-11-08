/// Wait and watch (pass 174): a wait_for step in the turn. While it waits:
/// "Waiting for “ready” · bun run dev", shimmering. Then "Ready after 0:06"
/// with the line it saw, or in red "Exited 1 after 0:04" with the command's
/// last lines under it, or "Gave up after 1:00".

export interface WaitOutcome { command: string; status: "matched" | "exited" | "timeout"; afterMs: number; line: string | null; exitCode: number | null; tail: string }

const h = (value: unknown) =>
  String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);

/// The result the daemon recorded for a finished wait, or null.
export function waitOutcome(message: string | undefined): WaitOutcome | null {
  if (!message) return null;
  try {
    const value = JSON.parse(message) as Partial<WaitOutcome>;
    if (value.status !== "matched" && value.status !== "exited" && value.status !== "timeout") return null;
    return { command: String(value.command ?? ""), status: value.status, afterMs: Number(value.afterMs) || 0, line: typeof value.line === "string" ? value.line : null,
      exitCode: typeof value.exitCode === "number" ? value.exitCode : null, tail: typeof value.tail === "string" ? value.tail : "" };
  } catch { return null; }
}

export const clockWords = (ms: number) => { const s = Math.max(0, Math.round(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; };

/// What it waits for, in the row's words: “ready” or “ready” or “Local:”.
export function waitingFor(pattern: unknown): string {
  if (typeof pattern !== "string" || !pattern.trim()) return "it to finish";
  const parts = pattern.split("|").map((part) => part.replace(/\\(.)/g, "$1").trim()).filter(Boolean).slice(0, 3);
  return parts.map((part) => `“${part.length > 24 ? `${part.slice(0, 23)}…` : part}”`).join(" or ");
}

export interface WaitRowInput { state: string; pattern: unknown; command: string; message?: string; durationMs?: number; icon: string }

/// The row's words: verb, target and meta, with its tone, and the tail to show under it.
export function waitRow(input: WaitRowInput): { verb: string; target: string; meta: string; tone: "" | "running" | "failed"; tail: string } {
  const outcome = input.state === "done" ? waitOutcome(input.message) : null;
  const command = outcome?.command || input.command;
  if (input.state === "running") return { verb: "Waiting for", target: h(waitingFor(input.pattern)), meta: h(command), tone: "running", tail: "" };
  if (!outcome) return { verb: "Waited", target: h(waitingFor(input.pattern)), meta: input.state === "done" ? "" : `<span class="danger">×</span> ${h(input.state)}`, tone: input.state === "done" ? "" : "failed", tail: "" };
  const after = clockWords(outcome.afterMs);
  if (outcome.status === "matched") return { verb: `Ready after ${after}`, target: h(shortLine(outcome.line ?? "", outcome.tail)), meta: `<span class="success">✓</span> ${h(command)}`, tone: "", tail: "" };
  if (outcome.status === "exited" && outcome.exitCode === 0) return { verb: `Finished after ${after}`, target: h(command), meta: '<span class="success">✓</span> exit 0', tone: "", tail: "" };
  const verb = outcome.status === "exited" ? `Exited ${outcome.exitCode ?? ""} after ${after}`.replace("  ", " ") : `Gave up after ${after}`;
  return { verb, target: h(command), meta: `<span class="danger">×</span> ${outcome.status === "exited" ? "stopped first" : `no ${h(waitingFor(input.pattern))}`}`, tone: "failed",
    tail: outcome.tail ? `<pre class="wait-tail">${h(outcome.tail.split("\n").slice(-6).join("\n"))}</pre>` : "" };
}

/// A server's ready line, without the arrows and padding it prints around it;
/// the address it serves when it printed one (in that line or just after).
function shortLine(line: string, tail = "") {
  const clean = line.replace(/^[\s➜>→•*-]+/, "").replace(/\s+/g, " ").trim();
  const url = clean.match(/https?:\/\/[^\s]+/)?.[0] ?? tail.match(/https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)[^\s]*/)?.[0];
  if (url) return url.replace(/^https?:\/\//, "").replace(/\/$/, "");
  return clean.length > 60 ? `${clean.slice(0, 59)}…` : clean;
}
