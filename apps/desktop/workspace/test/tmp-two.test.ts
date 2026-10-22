import { test } from "bun:test";
import { WorkspaceHost } from "../host.ts";
import { fixture, eventually } from "./fixture.ts";

test("probe", async () => {
  const f = await fixture({ providerId: "test", modelId: "test", contextCapacity: 262144, async listModels() { return []; },
    async *stream() { yield { type: "text_delta", delta: "Thinking it over." }; yield { type: "finish", reason: "stop" }; } });
  for (const args of [["init", "-q", "-b", "main"], ["add", "-A"], ["-c", "user.name=t", "-c", "user.email=a@b", "commit", "-qm", "init"]])
    Bun.spawnSync(["git", ...args], { cwd: f.workspace });
  const host = new WorkspaceHost({ workspace: f.workspace, settings: f.settings, client: f.client, changed: () => {}, drive: true });
  await host.connect();
  await eventually(() => Boolean(host.current), 5000);
  await eventually(() => !host.nextQueue.loading, 5000);
  const dump = async (label: string) => console.log(label, JSON.stringify((await f.client.listSessions()).map((s: any) => [s.id.slice(0, 6), s.title, s.turns.length])), host.current?.session.id.slice(0,6), host.driveSession?.session.id.slice(0,6));
  const proposal = (id: string) => ({ id, kind: "tidy" as const, title: `Tidy ${id}`, why: "It's untidy.", evidence: [], minutes: 5, confidence: "high" as const, coders: 1, urgent: false, value: 1, cost: 1 });
  host.nextQueue = { ...host.nextQueue, proposals: [proposal("A")] as never };
  await dump("start");
  console.log(await host.handle("next-plan", { id: "A", sessionId: host.current!.session.id }));
  await new Promise((r) => setTimeout(r, 3000));
  await dump("after plan");
  host.dispose(); await f.close();
}, 30000);
