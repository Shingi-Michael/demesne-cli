import { expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DemesneStore } from "@demesne/storage";
import { AgentEngine } from "../src/engine.ts";
import type { TurnInference } from "../src/processor.ts";
import { InferenceScheduler, InferenceSchedulers } from "../src/inference-scheduler.ts";
import { PermissionBroker } from "../src/permissions.ts";
import { ToolRegistry, type AgentTool } from "../src/tools.ts";

// Parallel tool calls are on, so a model may ask for many reads at once: the
// first eight run together, the rest come back "not run" and the turn goes on.
test("a round runs at most eight tool calls and answers the rest not run", async () => {
  const store = new DemesneStore(":memory:");
  const workspace = realpathSync(mkdtempSync(join(tmpdir(), "demesne-round-")));
  const { session } = store.createSession("Many reads", workspace);
  let running = 0, most = 0;
  const executed: number[] = [];
  const tools = new ToolRegistry([{
    definition: { name: "peek", description: "peek", inputSchema: { type: "object" } },
    permission: () => null,
    async execute(input) { running += 1; most = Math.max(most, running); await Bun.sleep(5); running -= 1; executed.push((input as { n: number }).n); return "ok"; },
  } satisfies AgentTool]);
  const schedulers = new InferenceSchedulers(new InferenceScheduler(1), "test");
  const engine = new AgentEngine(store, tools, new PermissionBroker(), schedulers);
  const { turn } = store.createTurn(session.id, "Read all", "deny");
  const seen: string[] = [];
  let round = 0;
  const inference: TurnInference = { providerId: "test", modelId: "test", profile: null, thinkingEnabled: undefined, preservesPromptCache: false,
    async *stream(messages) {
      if (round++ === 0) {
        for (let n = 0; n < 10; n++) yield { type: "tool_call_delta", index: n, idDelta: `c${n}`, nameDelta: "peek", argumentsDelta: JSON.stringify({ n }) };
      } else {
        seen.push(...messages.filter((message) => message.role === "tool").map((message) => String(message.content)));
        yield { type: "text_delta", delta: "Done." };
      }
    } };
  try {
    await engine.run(turn.id, inference, new AbortController().signal);
    expect(executed.sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(most).toBeGreaterThan(1);
    expect(seen).toHaveLength(10);
    expect(seen.filter((text) => text.startsWith("Not run: at most 8"))).toHaveLength(2);
  } finally { await schedulers.close(); store.close(); rmSync(workspace, { recursive: true, force: true }); }
});
