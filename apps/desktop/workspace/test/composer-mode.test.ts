import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { WorkspaceHost } from "../host.ts";
import { fixture, eventually } from "./fixture.ts";

const hostFor = (f: Awaited<ReturnType<typeof fixture>>) => new WorkspaceHost({
  workspace: f.workspace, settings: f.settings, client: f.client, changed: () => {},
});

test("Accept edits lets a file edit through and still asks before a command", async () => {
  let round = 0;
  const prompt = "Write a file, then run a command";
  const f = await fixture({
    providerId: "test", modelId: "test", async listModels() { return []; },
    async *stream(messages) {
      if (messages.findLast(message => message.role === "user")?.content !== prompt) {
        yield { type: "text_delta", delta: '{"proposals":[]}' };
        yield { type: "finish", reason: "stop" }; return;
      }
      round++;
      if (round === 1) {
        yield { type: "tool_call_delta", index: 0, idDelta: "write", nameDelta: "write_file",
          argumentsDelta: JSON.stringify({ path: "edited.txt", content: "Accepted.\n" }) };
        yield { type: "finish", reason: "tool_calls" };
      } else if (round === 2) {
        yield { type: "tool_call_delta", index: 0, idDelta: "cmd", nameDelta: "run_command",
          argumentsDelta: JSON.stringify({ argv: ["true"] }) };
        yield { type: "finish", reason: "tool_calls" };
      } else {
        yield { type: "text_delta", delta: "Done." };
        yield { type: "finish", reason: "stop" };
      }
    },
  });
  const host = hostFor(f);
  try {
    await host.connect();
    const id = host.current!.session.id;
    await host.handle("permission-mode", { sessionId: id, mode: "edits" });
    expect(host.snapshot().session?.acceptEdits).toBe(true);
    expect((await f.client.getSessionState(id)).session.acceptEdits).toBe(true);
    await host.submit(prompt);
    await eventually(() => host.current!.approvals.size === 1);
    expect(readFileSync(join(f.workspace, "edited.txt"), "utf8")).toBe("Accepted.\n");
    expect([...host.current!.approvals.values()][0]?.name).toBe("run_command");
  } finally { host.dispose(); await f.close(); }
});

test("the mode belongs to the chat and each step sets exactly one policy", async () => {
  const f = await fixture(), host = hostFor(f);
  try {
    await host.connect();
    const first = host.current!.session.id;
    await host.handle("permission-mode", { sessionId: first, mode: "auto" });
    expect(host.snapshot().session).toMatchObject({ autoApprove: true, acceptEdits: false });
    await host.handle("permission-mode", { sessionId: first, mode: "plan" });
    expect(host.snapshot().planOnly).toBe(true);
    expect(host.snapshot().session).toMatchObject({ autoApprove: false, acceptEdits: false });
    const second = await host.newSession();
    expect(host.snapshot().planOnly).toBe(false);
    await host.handle("permission-mode", { sessionId: second, mode: "edits" });
    await host.select(first);
    expect(host.snapshot().planOnly).toBe(true);
    await host.select(second);
    expect(host.snapshot().planOnly).toBe(false);
    expect(host.snapshot().session?.acceptEdits).toBe(true);
    await host.handle("permission-mode", { sessionId: second, mode: "ask" });
    expect(host.snapshot().session).toMatchObject({ autoApprove: false, acceptEdits: false });
    await expect(host.handle("permission-mode", { sessionId: second, mode: "yolo" })).rejects.toThrow("Invalid mode");
    expect(existsSync(join(f.workspace, "edited.txt"))).toBe(false);
  } finally { host.dispose(); await f.close(); }
});
