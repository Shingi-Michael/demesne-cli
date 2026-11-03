import type { AgentProcess } from "../src/agent-cli.ts";

/// A stand-in agent tool run, and a Claude Code run's JSON lines.
export function fakeProcess(lines: unknown[], code = 0, stderr = ""): AgentProcess {
  const stream = (text: string) => new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode(text)); controller.close(); } });
  return { stdout: stream(lines.map((line) => JSON.stringify(line)).join("\n") + "\n"), stderr: stream(stderr), exited: Promise.resolve(code), kill() {} };
}

export const claudeRun = (session: string, answer: string) => [
  { type: "system", subtype: "init", session_id: session },
  { type: "assistant", message: { content: [{ type: "text", text: "Looking at the file." }, { type: "tool_use", name: "Read", input: { file_path: "/w/src/a.ts" } }] } },
  { type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", input: { command: "bun test" } }] } },
  { type: "assistant", message: { content: [{ type: "text", text: answer }] } },
  { type: "result", subtype: "success", is_error: false, result: answer, session_id: session },
];
