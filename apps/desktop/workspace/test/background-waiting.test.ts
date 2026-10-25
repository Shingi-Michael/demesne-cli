import { test } from "bun:test";
import { WorkspaceHost } from "../host.ts";
import { fixture, eventually } from "./fixture.ts";

test("a chat that asks for approval in the background is marked waiting until it is answered", async () => {
  const prompt = "Write a file from the background";
  let round = 0;
  const f = await fixture({
    providerId: "test", modelId: "test", async listModels() { return []; },
    async *stream(messages) {
      if (messages.findLast(message => message.role === "user")?.content !== prompt) {
        yield { type: "text_delta", delta: '{"proposals":[]}' };
        yield { type: "finish", reason: "stop" }; return;
      }
      if (++round === 1) {
        yield { type: "tool_call_delta", index: 0, idDelta: "write", nameDelta: "write_file",
          argumentsDelta: JSON.stringify({ path: "background.txt", content: "From the background.\n" }) };
        yield { type: "finish", reason: "tool_calls" };
      } else {
        yield { type: "text_delta", delta: "Wrote it." };
        yield { type: "finish", reason: "stop" };
      }
    },
  });
  const host = new WorkspaceHost({ workspace: f.workspace, settings: f.settings, client: f.client, changed: () => {} });
  try {
    await host.connect();
    const asking = host.current!.session.id;
    await host.submit(prompt);
    await eventually(() => host.current!.approvals.size === 1);
    // Move to another chat: the first keeps waiting on its approval there.
    await host.newSession();
    await host.refreshSessions();
    await eventually(() => host.snapshot().sessions.find(item => item.id === asking)?.waiting === true);
    const permission = (await f.client.getSessionState(asking)).pendingPermissions[0]!;
    await f.client.resolvePermission(permission.id, "allow_once");
    await eventually(() => host.snapshot().sessions.find(item => item.id === asking)?.waiting === false, 15_000);
  } finally { host.dispose(); await f.close(); }
});
