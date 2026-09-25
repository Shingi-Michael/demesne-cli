import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { DemesneStore } from "@demesne/storage";
import { serializeMessages, type ProviderMessage } from "@demesne/providers";
import { ingestImage } from "../src/artifacts.ts";
import { hydrateImageInputs } from "../src/image-inputs.ts";
import { viewImageTool } from "../src/tools.ts";
import { createDaemonApp } from "../src/app.ts";

test("workspace screenshots become artifacts and vision inputs without persisting pixels", async () => {
  const root = mkdtempSync(join(tmpdir(), "demesne-vision-"));
  let store = new DemesneStore(join(root, "state.sqlite"));
  try {
    const png = await sharp({ create: { width: 80, height: 40, channels: 3, background: "cyan" } }).png().toBuffer();
    writeFileSync(join(root, "screenshot.png"), png);
    const { session } = store.createSession("Screenshots", root);
    const { turn } = store.createTurn(session.id, "Inspect screenshots");
    store.startTurn(turn.id);
    const context = { workspaceRoot: root, sessionId: session.id, signal: new AbortController().signal };
    const tool = viewImageTool();
    const output = await tool.executeWithArtifacts!({ path: "screenshot.png" }, context);
    if (typeof output === "string") throw new Error("Expected image");
    const messages: ProviderMessage[] = [];
    for (let i = 0; i < 3; i++) {
      const artifact = await ingestImage(store, output.images[0]!, { sessionId: session.id, turnId: turn.id, toolCallId: `call-${i}`, name: "view_image" }, 0);
      const message: ProviderMessage = { role: "tool", content: "Screenshot captured", toolCallId: `call-${i}`, imageArtifactIds: [artifact.id] };
      store.appendModelMessage(turn.id, message); messages.push(message);
    }
    const hydrated = await hydrateImageInputs(store, session.id, messages, context.signal);
    expect(hydrated[0]!.imageInputs).toBeUndefined();
    expect(hydrated[1]!.imageInputs?.[0]!.url).toStartWith("data:image/png;base64,");
    expect(JSON.stringify(messages)).not.toContain("base64");
    const wire = serializeMessages(hydrated);
    expect(wire.map((message) => message.role)).toEqual(["tool", "tool", "tool", "user"]);
    expect(JSON.stringify(wire)).not.toContain("imageArtifactIds");
    expect((wire[3]!.content as unknown[]).length).toBe(4);
    const foreign = await hydrateImageInputs(store, "another-session", messages, context.signal);
    expect(foreign.every((message) => !message.imageInputs)).toBe(true);
    store.completeTurn(turn.id);
    store.close(); store = new DemesneStore(join(root, "state.sqlite"));
    const stored = store.getCompletedModelTranscript(session.id).map((entry) => entry.message);
    expect(stored).toEqual(messages);
    const replay = await hydrateImageInputs(store, session.id, stored, context.signal);
    expect(replay[2]!.imageInputs).toEqual(hydrated[2]!.imageInputs);
    await expect(tool.executeWithArtifacts!({ path: "../outside.png" }, context)).rejects.toThrow();
    symlinkSync("/etc/hosts", join(root, "escape.png"));
    await expect(tool.executeWithArtifacts!({ path: "escape.png" }, context)).rejects.toThrow();
    await expect(hydrateImageInputs(store, session.id, messages, AbortSignal.abort())).rejects.toThrow();
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("the agent receives screenshot pixels after a tool call and on replay", async () => {
  const root = mkdtempSync(join(tmpdir(), "demesne-vision-loop-"));
  mkdirSync(join(root, "data")); mkdirSync(join(root, "workspace"));
  writeFileSync(join(root, "workspace/screen.png"), await sharp({ create: { width: 40, height: 40, channels: 3, background: "red" } }).png().toBuffer());
  let round = 0;
  let resolve!: () => void;
  let completed = new Promise<void>((done) => { resolve = done; });
  const options = { databasePath: join(root, "data/state.sqlite"), providerVision: true, processor: {
    providerId: "test", modelId: "vision-test", contextCapacity: 32768, maxOutputTokens: 1024,
    async listModels() { return []; },
    async *stream(messages: ProviderMessage[]) {
      if (++round === 1) yield { type: "tool_call_delta" as const, index: 0, idDelta: "capture", nameDelta: "view_image", argumentsDelta: '{"path":"screen.png"}' };
      else {
        expect(messages.some((message) => message.imageInputs?.[0]?.url.startsWith("data:image/png;base64,"))).toBe(true);
        yield { type: "text_delta" as const, delta: "Screenshot inspected" }; resolve();
      }
    },
  } };
  let app = createDaemonApp(options);
  const post = (path: string, body: unknown) => app.fetch(new Request(`http://localhost${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
  try {
    const { session } = await (await post("/v1/sessions", { title: "Inspect", workspacePath: join(root, "workspace") })).json();
    await post(`/v1/sessions/${session.id}/turns`, { content: "Inspect screen.png" });
    await completed;
    for (let i = 0; i < 100; i++) {
      const state = await (await app.fetch(new Request(`http://localhost/v1/sessions/${session.id}`))).json();
      if (state.session.turns[0].status === "completed") break;
      await Bun.sleep(1);
    }
    await app.close();
    app = createDaemonApp(options);
    completed = new Promise<void>((done) => { resolve = done; });
    await post(`/v1/sessions/${session.id}/turns`, { content: "Describe that screenshot again" });
    await completed;
  } finally { await app.close(); rmSync(root, { recursive: true, force: true }); }
});
