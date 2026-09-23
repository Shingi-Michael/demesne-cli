import type { EventEnvelope } from "@demesne/protocol";
import type { ToolState } from "./entries.ts";

export function toolCompletion(event: EventEnvelope): {
  toolCallId: string; name: string; state: ToolState; durationMs?: number;
  exitCode?: number; message?: string; created?: boolean;
} {
  const payload = event.payload;
  const output = [typeof payload.stdout === "string" ? payload.stdout : "", typeof payload.stderr === "string" && payload.stderr ? `stderr:\n${payload.stderr}` : ""].filter(Boolean);
  if (payload.outputTruncated) output.push("[Recorded output truncated]");
  const message = output.length ? output.join("\n") : typeof payload.message === "string" ? payload.message : undefined;
  return {
    toolCallId: String(payload.toolCallId ?? ""), name: String(payload.name ?? "tool"),
    state: event.type === "tool.call_completed" && payload.timedOut !== true && (typeof payload.exitCode !== "number" || payload.exitCode === 0)
      ? "done" : event.type === "tool.call_denied" ? "denied"
        : event.type === "tool.call_cancelled" || event.type === "tool.call_interrupted" ? "stopped" : "failed",
    ...(typeof payload.exitCode === "number" ? { exitCode: payload.exitCode } : {}),
    ...(typeof payload.durationMs === "number" ? { durationMs: payload.durationMs } : {}),
    ...(typeof payload.created === "boolean" ? { created: payload.created } : {}),
    ...(message !== undefined ? { message } : {}),
  };
}
