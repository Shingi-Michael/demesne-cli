import { expect, test } from "bun:test";
import { WorkspaceHost } from "../host.ts";
import { fixture, eventually } from "./fixture.ts";

const proposal = { id: "fix-parser", kind: "fix" as const, title: "Fix the parser", why: "A check failed.", evidence: [], minutes: 5, confidence: "high" as const, coders: 1, urgent: false, value: 3, cost: 1, score: 3 };

test("failed Run and Plan keep the suggestion; Plan plans read-only in its own chat", async () => {
  const f = await fixture();
  const host = new WorkspaceHost({ workspace: f.workspace, settings: f.settings, client: f.client, changed() {} });
  try {
    await host.connect();
    await eventually(() => !host.nextQueue.loading);
    host.nextQueue.proposals = [proposal];
    const args = { sessionId: host.current!.session.id, id: proposal.id };
    await expect(host.handle("next-run", args)).rejects.toThrow("unavailable");
    expect(host.snapshot().driveNext.proposals).toHaveLength(1);
    host.connection = "offline";
    await expect(host.handle("next-plan", args)).rejects.toThrow("Connect");
    expect(host.snapshot().driveNext.proposals).toHaveLength(1);
    host.connection = "online";
    host.draft = "Keep this unsent message";
    const planned = await host.handle("next-plan", args) as { sessionId: string };
    // Your chat, your draft and its turns are untouched; the plan has its own chat.
    expect(host.current!.session.id).toBe(args.sessionId);
    expect(host.draft).toBe("Keep this unsent message");
    expect((await f.client.getSessionState(args.sessionId)).session.turns).toHaveLength(0);
    expect(planned.sessionId).not.toBe(args.sessionId);
    const plan = await f.client.getSessionState(planned.sessionId);
    expect(plan.session.title).toBe("Fix the parser");
    expect(plan.session.turns.at(-1)?.planOnly).toBe(true);
    expect(host.snapshot().driveNext.proposals).toHaveLength(0);
    await expect(host.handle("next-run", args)).rejects.toThrow("no longer");
  } finally { host.dispose(); await f.close(); }
});

for (const method of ["drive", "drive-control"]) {
  test(`${method} Stop cancels the mission's worker while another chat is selected`, async () => {
    const f = await fixture({
      providerId: "test", modelId: "test", contextCapacity: 262144,
      async listModels() { return []; },
      async *stream(_messages, _tools, signal) {
        yield { type: "text_delta", delta: "Working." };
        await new Promise<void>(resolve => {
          if (signal.aborted) resolve();
          else signal.addEventListener("abort", () => resolve(), { once: true });
        });
        signal.throwIfAborted();
      },
    });
    const host = new WorkspaceHost({ workspace: f.workspace, settings: f.settings, client: f.client, changed() {}, drive: true });
    const turns: string[] = [];
    try {
      await host.connect();
      const home = host.current!.session.id;
      await host.drive!.handle("drive", { text: "--here --bounded Fix the parser", observation: { invalid: "Direct control does not require UI geometry" } });
      await host.drive!.handle("drive-control", { control: "pause", observation: { invalid: "Nor do mission controls" } });
      expect(host.driveState?.status).toBe("paused");
      const missionTurn = await f.client.submitTurn(home, { content: "Mission work", permissionMode: "ask" });
      turns.push(missionTurn.turn.id);
      const other = await f.client.createSession({ workspacePath: f.workspace, trustWorkspace: true });
      const otherTurn = await f.client.submitTurn(other.session.id, { content: "Unrelated work", permissionMode: "ask" });
      turns.push(otherTurn.turn.id);
      await host.select(other.session.id);
      await host.drive!.handle("drive-control", { control: "resume" });
      expect(host.driveState?.status).toBe("running");
      await host.drive!.handle("drive-control", { control: "pause" });
      expect((await f.client.getSessionState(home)).session.turns.at(-1)?.status).not.toBe("cancelled");
      await host.drive!.handle(method, method === "drive" ? { text: "stop" } : { control: "stop" });
      await eventually(async () => (await f.client.getSessionState(home)).session.turns.at(-1)?.status === "cancelled");
      expect(host.driveState?.status).toBe("stopped");
      expect((await f.client.getSessionState(other.session.id)).session.turns.at(-1)?.status).not.toBe("cancelled");
      expect(host.current!.session.id).toBe(other.session.id);
    } finally {
      host.dispose();
      for (const id of turns) await f.client.cancelTurn(id).catch(() => {});
      await f.close();
    }
  });
}
