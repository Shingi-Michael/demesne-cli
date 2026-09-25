import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { DemesneStore } from "@demesne/storage";
import { imageGenerationTool } from "../src/image-generation.ts";
import { ingestImage } from "../src/artifacts.ts";
import { createDaemonApp } from "../src/app.ts";
import type { TurnProcessor } from "../src/processor.ts";
import { loadConfig, validateConfigDocument } from "@demesne/config";

const png = await sharp({ create: { width: 24, height: 16, channels: 3, background: "cyan" } }).png().toBuffer();
const response = () => Response.json({ data: [{ b64_json: png.toString("base64") }] });

test("image configuration is explicit, validated, and environment-overridable", () => {
  const { config } = loadConfig({ userConfigPath: null, includeProject: false, env: {
    DEMESNE_IMAGE_URL: "https://api.openai.com/v1", DEMESNE_IMAGE_MODEL: "image-model", DEMESNE_IMAGE_API_KEY: "test-key",
  } });
  expect(config.images).toEqual({ url: "https://api.openai.com/v1", model: "image-model", apiKey: "test-key" });
  expect(config.provider).toEqual({});
  expect(() => validateConfigDocument({ images: { url: "invalid" } })).toThrow();
  expect(() => validateConfigDocument({ images: { typo: true } })).toThrow();
  expect(() => createDaemonApp({ databasePath: ":memory:", images: { model: "image-model" } })).toThrow("both");
});

test("generation and reference edits use the image API and enforce session boundaries", async () => {
  const root = mkdtempSync(join(tmpdir(), "demesne-generate-"));
  const store = new DemesneStore(join(root, "state.sqlite"));
  try {
    const { session } = store.createSession("Images", root);
    const { turn } = store.createTurn(session.id, "Generate");
    const calls: Request[] = [];
    const tool = imageGenerationTool({ url: "https://images.test/v1/", model: "image-model", apiKey: "secret" }, store,
      (async (url, init) => { calls.push(new Request(url, init)); return response(); }) as typeof fetch);
    const context = { sessionId: session.id, workspaceRoot: root, signal: new AbortController().signal };
    const output = await tool.executeWithArtifacts!({ prompt: "A logo" }, context);
    if (typeof output === "string") throw new Error("Missing image");
    expect(calls[0]!.url).toBe("https://images.test/v1/images/generations");
    expect(calls[0]!.headers.get("authorization")).toBe("Bearer secret");
    expect(await calls[0]!.json()).toEqual({ model: "image-model", prompt: "A logo", size: "auto", n: 1 });
    const artifact = await ingestImage(store, output.images[0]!, { sessionId: session.id, turnId: turn.id, toolCallId: "one", name: "generate_image" }, 0);
    const edited = await tool.executeWithArtifacts!({ prompt: "Darker background", referenceArtifactId: artifact.id }, context);
    if (typeof edited === "string") throw new Error("Missing edit");
    expect(edited.images[0]!.revisionOf).toBe(artifact.id);
    expect(calls[1]!.url).toEndWith("/images/edits");
    const form = await calls[1]!.formData();
    expect(Buffer.from(await (form.get("image") as File).arrayBuffer())).toEqual(png);
    await expect(tool.executeWithArtifacts!({ prompt: "Edit", referenceArtifactId: artifact.id }, { ...context, sessionId: "other" })).rejects.toThrow("this session");
    await expect(tool.executeWithArtifacts!({ prompt: "" }, context)).rejects.toThrow("nonempty");
    expect(calls).toHaveLength(2);
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("image failures are bounded and cancellation never starts a request", async () => {
  const store = new DemesneStore(":memory:");
  const context = { workspaceRoot: "/", signal: new AbortController().signal };
  try {
    for (const [reply, message] of [
      [new Response("secret", { status: 401 }), "HTTP 401"],
      [Response.json({ data: [{ url: "https://elsewhere.test/image" }] }), "b64_json"],
      [Response.json({ data: [{ b64_json: "!!!!" }] }), "base64"],
      [new Response("{"), "invalid JSON"],
      [new Response(new Uint8Array(29 * 1024 * 1024)), "size limit"],
    ] as const) {
      const tool = imageGenerationTool({ url: "https://images.test", model: "test" }, store, (async () => reply) as unknown as typeof fetch);
      await expect(tool.executeWithArtifacts!({ prompt: "Logo" }, context)).rejects.toThrow(message);
    }
    let called = false;
    const tool = imageGenerationTool({ url: "https://images.test", model: "test" }, store, (async () => { called = true; return response(); }) as unknown as typeof fetch);
    await expect(tool.executeWithArtifacts!({ prompt: "Logo" }, { ...context, signal: AbortSignal.abort() })).rejects.toThrow();
    expect(called).toBe(false);
    const waitingFetch = (async (_url: unknown, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init.signal!.addEventListener("abort", () => reject(init.signal!.reason), { once: true });
    })) as unknown as typeof fetch;
    const timeoutTool = imageGenerationTool({ url: "https://images.test", model: "test", requestTimeoutMs: 10 }, store, waitingFetch);
    await expect(timeoutTool.executeWithArtifacts!({ prompt: "Logo" }, context)).rejects.toThrow();
  } finally { store.close(); }
});

test("unconfigured image generation is absent from the model tool list", async () => {
  let done!: () => void;
  const completed = new Promise<void>((resolve) => { done = resolve; });
  const app = createDaemonApp({ databasePath: ":memory:", processor: {
    providerId: "test", modelId: "test", contextCapacity: 32768, maxOutputTokens: 1024,
    async listModels() { return []; },
    async *stream(_messages, tools) {
      expect(tools.some((tool) => tool.name === "generate_image")).toBe(false);
      yield { type: "text_delta", delta: "Ready" }; done();
    },
  } });
  const post = (path: string, body: unknown) => app.fetch(new Request(`http://localhost${path}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  }));
  try {
    const { session } = await (await post("/v1/sessions", { title: "Text" })).json();
    await post(`/v1/sessions/${session.id}/turns`, { content: "Hello" });
    await completed;
  } finally { await app.close(); }
});

test("normal agent loop advertises generate_image and publishes a retrievable artifact without image bytes in model text", async () => {
  const root = mkdtempSync(join(tmpdir(), "demesne-generate-loop-"));
  mkdirSync(join(root, "data"));
  mkdirSync(join(root, "workspace"));
  const imageServer = Bun.serve({ port: 0, fetch: () => response() });
  let round = 0;
  let toolResult = "";
  let done!: () => void;
  const completed = new Promise<void>((resolve) => { done = resolve; });
  const processor: TurnProcessor = {
    providerId: "test", modelId: "chat-model", contextCapacity: 32768, maxOutputTokens: 1024,
    async listModels() { return []; },
    async *stream(messages, tools) {
      expect(tools.some((tool) => tool.name === "generate_image")).toBe(true);
      if (++round === 1) yield { type: "tool_call_delta", index: 0, idDelta: "generate-1", nameDelta: "generate_image", argumentsDelta: JSON.stringify({ prompt: "Logo" }) };
      else {
        toolResult = JSON.stringify(messages.filter((message) => message.role === "tool"));
        yield { type: "text_delta", delta: "Your image is in Preview." };
        done();
      }
    },
  };
  const app = createDaemonApp({ databasePath: join(root, "data/state.sqlite"), processor, images: { url: `${imageServer.url}v1`, model: "image-model" } });
  const get = async (path: string, body?: unknown) => app.fetch(new Request(`http://localhost${path}`, body ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}));
  try {
    const { session } = await (await get("/v1/sessions", { title: "Images", workspacePath: join(root, "workspace") })).json();
    const submitted = await get(`/v1/sessions/${session.id}/turns`, { content: "Generate a logo" });
    expect(submitted.ok).toBe(true);
    await completed;
    const page = await (await get(`/v1/sessions/${session.id}/artifacts`)).json();
    expect(page.artifacts).toHaveLength(1);
    const artifact = page.artifacts[0];
    expect(artifact.source).toEqual({ kind: "tool", name: "generate_image", modelId: "image-model" });
    expect(toolResult).toContain(artifact.id);
    expect(toolResult).not.toContain(png.toString("base64"));
    const content = await get(`/v1/sessions/${session.id}/artifacts/${artifact.id}/content`);
    expect(Buffer.from(await content.arrayBuffer())).toEqual(png);
    const store = new DemesneStore(join(root, "data/state.sqlite"));
    try { expect(store.eventsAfter(session.id, 0).filter((event) => event.type === "artifact.created")).toHaveLength(1); }
    finally { store.close(); }
  } finally { await app.close(); await imageServer.stop(true); rmSync(root, { recursive: true, force: true }); }
});
