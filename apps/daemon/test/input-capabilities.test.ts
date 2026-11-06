import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { parseSubmitTurnRequest, type SessionInputCapabilities } from "@demesne/protocol";
import type { ProviderMessage } from "@demesne/providers";
import { createDaemonApp, type DaemonApp } from "../src/app.ts";
import type { InferenceOverrides, TurnInference, TurnProcessor } from "../src/processor.ts";

const apps: DaemonApp[] = [];
const roots: string[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

class CapabilityProcessor implements TurnProcessor {
  readonly providerId = "fixture";
  modelId = "text-small";
  readonly received: ProviderMessage[][] = [];

  setModel(model: string) { this.modelId = model; }
  async listModels() {
    return ["text-small", "vision-small"].map(id => ({ id, provider: this.providerId }));
  }
  createTurnInference(thinkingEnabled: boolean | undefined, overrides?: InferenceOverrides): TurnInference {
    const modelId = overrides?.model ?? this.modelId;
    if (!["text-small", "vision-small"].includes(modelId)) throw new Error(`Unknown model: ${modelId}`);
    return Object.freeze({
      providerId: this.providerId, modelId, profile: null, thinkingEnabled,
      preservesPromptCache: false, vision: modelId === "vision-small",
      stream: (messages: ProviderMessage[]) => this.stream(messages),
    });
  }
  async *stream(messages: ProviderMessage[]) {
    this.received.push(messages);
    yield { type: "text_delta" as const, delta: "Fixture reply." };
  }
}

function make(options: { assistantModel?: string; providerVision?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), "demesne-input-capabilities-"));
  roots.push(root);
  const processor = new CapabilityProcessor();
  const app = createDaemonApp({ databasePath: join(root, "state.sqlite"), authToken: "fixture-key", processor, ...options });
  apps.push(app);
  return { app, processor };
}

async function request(app: DaemonApp, path: string, body?: unknown, method = body === undefined ? "GET" : "POST", auth = true) {
  return app.fetch(new Request(`http://localhost${path}`, {
    method,
    headers: { ...(auth ? { authorization: "Bearer fixture-key" } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }));
}

async function chat(app: DaemonApp): Promise<string> {
  const response = await request(app, "/v1/sessions", { title: "Images" });
  expect(response.status).toBe(201);
  return (await response.json()).session.id;
}

async function capability(app: DaemonApp, id: string): Promise<SessionInputCapabilities> {
  const response = await request(app, `/v1/sessions/${id}/input-capabilities`);
  expect(response.status).toBe(200);
  return response.json();
}

async function upload(app: DaemonApp, id: string): Promise<string> {
  const data = await sharp({ create: { width: 4, height: 3, channels: 3, background: "#94b9df" } }).png().toBuffer();
  const response = await app.fetch(new Request(`http://localhost/v1/sessions/${id}/attachments`, {
    method: "POST", headers: { authorization: "Bearer fixture-key", "content-type": "image/png", "x-demesne-filename": "sample.png" },
    body: new Uint8Array(data),
  }));
  expect(response.status).toBe(201);
  return (await response.json()).id;
}

async function waitForCompletion(app: DaemonApp, id: string) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const state = await (await request(app, `/v1/sessions/${id}`)).json();
    if (state.session.turns.at(-1)?.status === "completed") return;
    await Bun.sleep(10);
  }
  throw new Error("Fixture reply did not complete");
}

test("input capabilities report exact limits and current model without creating work or changing configuration", async () => {
  const { app, processor } = make();
  const id = await chat(app);
  const before = await (await request(app, `/v1/sessions/${id}`)).json();
  expect(await capability(app, id)).toEqual({
    sessionId: id, provider: "fixture", model: "text-small",
    images: { enabled: false, mimeTypes: ["image/png", "image/jpeg", "image/webp"], maxBytes: 20 * 1024 * 1024, maxCount: 6 },
  });
  expect(await (await request(app, `/v1/sessions/${id}`)).json()).toEqual(before);
  expect(processor.modelId).toBe("text-small");
  expect(processor.received).toHaveLength(0);
  expect((await (await request(app, "/v1/status")).json()).active).toEqual([]);
});

test("a chat preference can enable image input without changing the daemon model", async () => {
  const { app, processor } = make();
  const id = await chat(app);
  await request(app, `/v1/sessions/${id}`, { preferredModel: "vision-small" }, "PATCH");
  const result = await capability(app, id);
  expect(result.model).toBe("vision-small");
  expect(result.images.enabled).toBe(true);
  expect(processor.modelId).toBe("text-small");
  expect(processor.received).toHaveLength(0);
});

test("Assistant capability follows its pinned model rather than the daemon or ordinary chat preference", async () => {
  const { app, processor } = make({ assistantModel: "vision-small" });
  const assistant = await (await request(app, "/v1/assistant", {})).json();
  await request(app, `/v1/sessions/${assistant.sessionId}`, { preferredModel: "text-small" }, "PATCH");
  const result = await capability(app, assistant.sessionId);
  expect(result.model).toBe("vision-small");
  expect(result.images.enabled).toBe(true);
  expect(processor.modelId).toBe("text-small");
  expect(processor.received).toHaveLength(0);
});

test("the legacy provider vision switch matches pixel hydration but never enables native CLI image input", async () => {
  const { app, processor } = make({ providerVision: true });
  const id = await chat(app);
  expect((await capability(app, id)).images.enabled).toBe(true);
  await request(app, `/v1/sessions/${id}`, { preferredModel: "agent:codex" }, "PATCH");
  const native = await capability(app, id);
  expect(native.model).toBe("agent:codex");
  expect(native.images.enabled).toBe(false);
  expect(processor.received).toHaveLength(0);
});

test("capability reads require authentication, reject missing chats and report unavailable routes without mutation", async () => {
  const { app, processor } = make();
  const id = await chat(app);
  expect((await request(app, `/v1/sessions/${id}/input-capabilities`, undefined, "GET", false)).status).toBe(401);
  expect((await request(app, "/v1/sessions/missing/input-capabilities")).status).toBe(404);
  await request(app, `/v1/sessions/${id}`, { preferredModel: "missing-model" }, "PATCH");
  const before = await (await request(app, `/v1/sessions/${id}`)).json();
  const response = await request(app, `/v1/sessions/${id}/input-capabilities`);
  expect(response.status).toBe(400);
  expect((await response.json()).error.code).toBe("not_supported");
  expect(await (await request(app, `/v1/sessions/${id}`)).json()).toEqual(before);
  expect(processor.modelId).toBe("text-small");
  expect(processor.received).toHaveLength(0);
});

test("the opt-in guard rechecks image support and retains uploads when the model changes before Send", async () => {
  const { app, processor } = make();
  const id = await chat(app);
  await request(app, "/v1/model", { model: "vision-small" });
  expect((await capability(app, id)).images.enabled).toBe(true);
  const attachment = await upload(app, id);
  await request(app, "/v1/model", { model: "text-small" });
  const before = await (await request(app, `/v1/sessions/${id}`)).json();
  const rejected = await request(app, `/v1/sessions/${id}/turns`, {
    content: "Describe this image", attachmentIds: [attachment], requireImageInput: true,
  });
  expect(rejected.status).toBe(400);
  expect((await rejected.json()).error.code).toBe("image_input_unavailable");
  expect(await (await request(app, `/v1/sessions/${id}`)).json()).toEqual(before);
  expect(processor.received).toHaveLength(0);
  await request(app, "/v1/model", { model: "vision-small" });
  const sent = await request(app, `/v1/sessions/${id}/turns`, {
    content: "Describe this image", attachmentIds: [attachment], requireImageInput: true,
  });
  expect(sent.status).toBe(202);
  expect((await sent.json()).turn.attachments[0].id).toBe(attachment);
  await waitForCompletion(app, id);
  expect(processor.received.some(messages => messages.some(message => message.imageInputs?.length))).toBe(true);
});

test("legacy attachment sends keep names-only behavior and guarded text-only messages remain allowed", async () => {
  const { app, processor } = make();
  const id = await chat(app);
  const attachment = await upload(app, id);
  expect((await request(app, `/v1/sessions/${id}/turns`, { content: "Legacy request", attachmentIds: [attachment] })).status).toBe(202);
  await waitForCompletion(app, id);
  expect(processor.received[0]?.some(message => message.imageInputs?.length)).toBe(false);
  expect(processor.received[0]?.some(message => typeof message.content === "string" && message.content.includes("sample.png"))).toBe(true);
  expect((await request(app, `/v1/sessions/${id}/turns`, { content: "Ordinary text", requireImageInput: true })).status).toBe(202);
  await waitForCompletion(app, id);
});

test("the guard flag is validated and existing text/image request constraints still apply", async () => {
  expect(parseSubmitTurnRequest({ content: "Image", requireImageInput: true }).requireImageInput).toBe(true);
  expect(parseSubmitTurnRequest({ content: "Image", requireImageInput: false }).requireImageInput).toBe(false);
  expect(parseSubmitTurnRequest({ content: "Image" }).requireImageInput).toBeUndefined();
  for (const requireImageInput of ["true", 1, null, {}]) {
    expect(() => parseSubmitTurnRequest({ content: "Image", requireImageInput })).toThrow("requireImageInput must be a boolean");
  }
  expect(() => parseSubmitTurnRequest({ content: "", attachmentIds: ["image"], requireImageInput: true })).toThrow("content cannot be empty");
  expect(() => parseSubmitTurnRequest({ content: "Image", attachmentIds: Array(7).fill("image"), requireImageInput: true })).toThrow("at most 6");
  const { app } = make();
  const id = await chat(app);
  for (const mime of ["image/heic", "application/pdf", "image/gif"]) {
    expect((await app.fetch(new Request(`http://localhost/v1/sessions/${id}/attachments`, {
      method: "POST", headers: { authorization: "Bearer fixture-key", "content-type": mime }, body: "invalid",
    }))).status).toBe(400);
  }
  expect((await app.fetch(new Request(`http://localhost/v1/sessions/${id}/attachments`, {
    method: "POST", headers: { authorization: "Bearer fixture-key", "content-type": "image/png", "content-length": String(20 * 1024 * 1024 + 1) }, body: "invalid",
  }))).status).toBe(400);
});
