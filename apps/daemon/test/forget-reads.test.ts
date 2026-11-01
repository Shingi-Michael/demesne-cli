import { expect, test } from "bun:test";
import type { ModelMessage } from "@demesne/protocol";
import { forgetOldReads, KEEP_UNDER } from "../src/forget-reads.ts";

const big = (path: string) => JSON.stringify({ path, content: `${"export const line = 1;\n".repeat(200)}` });

test("an earlier turn keeps a note of its long reads, and everything else whole", () => {
  const command = `${"compiling…\n".repeat(300)}1178 pass\n0 fail\nexit 0`;
  const messages: ModelMessage[] = [
    { role: "user", content: "Fix the greeting" },
    { role: "assistant", content: null, toolCalls: [
      { id: "r", name: "read_files", arguments: "{}" }, { id: "s", name: "read_file", arguments: "{}" },
      { id: "e", name: "edit_file", arguments: "{}" }, { id: "c", name: "run_command", arguments: "{}" }] },
    { role: "tool", toolCallId: "r", content: JSON.stringify({ files: [JSON.parse(big("src/a.ts")), JSON.parse(big("src/b.ts"))] }) },
    { role: "tool", toolCallId: "s", content: "short" },
    { role: "tool", toolCallId: "e", content: "x".repeat(KEEP_UNDER * 3) },
    { role: "tool", toolCallId: "c", content: command },
    { role: "assistant", content: "Done." },
  ];
  const out = forgetOldReads(messages);
  expect(out).toHaveLength(messages.length);
  const read = out[2] as { content: string };
  expect(read.content.length).toBeLessThan(800);
  expect(read.content).toContain("(src/a.ts, src/b.ts)");
  expect(read.content).toContain("Call read_files again if you need it");
  expect(out[3]).toBe(messages[3]!); // short results stay whole
  expect(out[4]).toBe(messages[4]!); // an edit's result is not something to read again
  const ran = (out[5] as { content: string }).content;
  expect(ran).toContain("exit 0");
  expect(ran).toContain("compiling…");
  expect(ran.length).toBeLessThan(900);
  expect(out[0]).toBe(messages[0]!);
  expect(out[6]).toBe(messages[6]!);
  // The same input always gives the same note, so a cached prefix stays valid.
  expect(forgetOldReads(messages)).toEqual(out);
});

test("the next turn's request carries the note; the turn that read it saw it whole", async () => {
  const { DemesneStore } = await import("@demesne/storage");
  const { AgentEngine } = await import("../src/engine.ts");
  const { InferenceScheduler, InferenceSchedulers } = await import("../src/inference-scheduler.ts");
  const { PermissionBroker } = await import("../src/permissions.ts");
  const { ToolRegistry } = await import("../src/tools.ts");
  const { mkdtempSync, realpathSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const workspace = realpathSync(mkdtempSync(join(tmpdir(), "demesne-forget-")));
  const store = new DemesneStore(":memory:");
  const { session } = store.createSession("Reads", workspace);
  const text = big("src/greeting.ts");
  const tools = new ToolRegistry([{ definition: { name: "read_file", description: "read", inputSchema: { type: "object" } }, permission: () => null, async execute() { return text; } }]);
  const schedulers = new InferenceSchedulers(new InferenceScheduler(1), "test");
  const engine = new AgentEngine(store, tools, new PermissionBroker(), schedulers);
  const seen: string[][] = [];
  const inference = { providerId: "test", modelId: "test", profile: null, thinkingEnabled: undefined, preservesPromptCache: false,
    async *stream(messages: { role: string; content?: string | null }[]) {
      seen.push(messages.filter((message) => message.role === "tool").map((message) => String(message.content)));
      if (!messages.some((message) => message.role === "tool") && messages.filter((message) => message.role === "user").length === 1)
        yield { type: "tool_call_delta" as const, index: 0, idDelta: "read", nameDelta: "read_file", argumentsDelta: JSON.stringify({ path: "src/greeting.ts" }) };
      else yield { type: "text_delta" as const, delta: "Done." };
    } };
  try {
    const first = store.createTurn(session.id, "What does greeting.ts say?", "deny").turn;
    await engine.run(first.id, inference as never, new AbortController().signal);
    const second = store.createTurn(session.id, "Thanks", "deny").turn;
    await engine.run(second.id, inference as never, new AbortController().signal);
    expect(seen[1]).toEqual([text]);
    expect(seen.at(-1)).toHaveLength(1);
    expect(seen.at(-1)![0]).toContain("[From an earlier turn:");
    expect(seen.at(-1)![0]).toContain("src/greeting.ts");
    expect(seen.at(-1)![0]!.length).toBeLessThan(text.length / 4);
  } finally { await schedulers.close(); store.close(); rmSync(workspace, { recursive: true, force: true }); }
});
