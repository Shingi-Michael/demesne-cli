import { expect, test } from "bun:test";
import sharp from "sharp";
import { WorkspaceHost } from "../host.ts";
import { fixture, eventually } from "./fixture.ts";

const hostFor = (f: Awaited<ReturnType<typeof fixture>>) => new WorkspaceHost({
  workspace: f.workspace, settings: f.settings, client: f.client, changed: () => {},
});
type ProviderMessage = { role: string; content: string | null; imageInputs?: { url: string; label?: string }[] };
const png = () => sharp({ create: { width: 40, height: 30, channels: 3, background: "#3366cc" } }).png().toBuffer();

test("an attached image goes to the model with the next message and stays on the turn", async () => {
  const seen: ProviderMessage[][] = [];
  const f = await fixture({
    providerId: "test", modelId: "test", vision: true, async listModels() { return []; },
    async *stream(messages) {
      seen.push(messages);
      yield { type: "text_delta", delta: "A blue rectangle." };
      yield { type: "finish", reason: "stop" };
    },
  });
  const host = hostFor(f);
  try {
    await host.connect();
    const sessionId = host.current!.session.id;
    const image = await host.handle("attach", { sessionId, name: "shot.png", mimeType: "image/png", data: (await png()).toString("base64") }) as { id: string };
    expect(host.snapshot().attachments).toEqual([{ id: image.id, filename: "shot.png", width: 40, height: 30 }]);
    await host.submit("");
    await eventually(() => host.current!.runs().at(-1)?.status === "completed");
    expect(host.snapshot().attachments).toEqual([]);
    const turn = (await f.client.getSessionState(sessionId)).session.turns.at(-1)!;
    expect(turn.content).toBe("Take a look at the attached image.");
    expect(turn.attachments).toEqual([{ id: image.id, filename: "shot.png", width: 40, height: 30 }]);
    expect(host.current!.runs().at(-1)?.attachments?.[0]?.filename).toBe("shot.png");
    const user = seen.flat().find((message) => message.role === "user" && message.imageInputs?.length)!;
    expect(user.content).toContain("[Attached image shot.png, 40×30]");
    expect(user.imageInputs![0]!.label).toBe("Image the user attached: shot.png");
    expect(user.imageInputs![0]!.url.startsWith("data:image/png;base64,")).toBe(true);
  } finally { host.dispose(); await f.close(); }
});

test("only images attach, a model without vision gets the names only, and a stale id is refused", async () => {
  const seen: ProviderMessage[][] = [];
  const f = await fixture({
    providerId: "test", modelId: "test", async listModels() { return []; },
    async *stream(messages) {
      seen.push(messages);
      yield { type: "text_delta", delta: "Noted." };
      yield { type: "finish", reason: "stop" };
    },
  });
  const host = hostFor(f);
  try {
    await host.connect();
    const sessionId = host.current!.session.id;
    await expect(host.handle("attach", { sessionId, name: "notes.txt", mimeType: "text/plain", data: Buffer.from("hi").toString("base64") })).rejects.toThrow("PNG, JPEG or WebP");
    await expect(host.handle("attach", { sessionId, name: "fake.png", mimeType: "image/png", data: Buffer.from("not a png").toString("base64") })).rejects.toThrow();
    await host.handle("attach", { sessionId, name: "shot.png", mimeType: "image/png", data: (await png()).toString("base64") });
    await host.submit("What is this?");
    await eventually(() => host.current!.runs().at(-1)?.status === "completed");
    const user = seen.flat().findLast((message) => message.role === "user")!;
    expect(user.content).toBe("What is this?\n\n[Attached image shot.png, 40×30]");
    expect(user.imageInputs).toBeUndefined();
    await expect(f.client.submitTurn(sessionId, { content: "Again", attachmentIds: ["missing"] })).rejects.toThrow("attach it again");
  } finally { host.dispose(); await f.close(); }
});
