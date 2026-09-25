import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { DemesneStore } from "@demesne/storage";
import { ingestImage, readArtifact } from "../src/artifacts.ts";
import { createDaemonApp } from "../src/app.ts";
import { McpManager } from "../src/mcp.ts";
import { ToolRegistry } from "../src/tools.ts";

test("image outputs persist once with immutable bytes and survive restart", async () => {
  const root = mkdtempSync(join(tmpdir(), "demesne-images-"));
  let store = new DemesneStore(join(root, "state.sqlite"));
  try {
    const { session } = store.createSession("Images", root);
    const { turn } = store.createTurn(session.id, "Make an image");
    const data = await sharp({ create: { width: 32, height: 16, channels: 3, background: "cyan" } }).jpeg().toBuffer();
    const input = { data, mimeType: "image/jpeg", modelId: "image-model" };
    const origin = { sessionId: session.id, turnId: turn.id, toolCallId: "image-call", name: "mcp__images__generate" };
    const first = await ingestImage(store, input, origin, 0);
    expect(await ingestImage(store, input, origin, 0)).toEqual(first);
    expect(first.width).toBe(32);
    expect(first.source.modelId).toBe("image-model");
    expect(await readArtifact(store, first, false)).toEqual(data);
    expect((await sharp(await readArtifact(store, first, true)).metadata()).format).toBe("png");
    expect(store.eventsAfter(session.id, 0).filter((event) => event.type === "artifact.created")).toHaveLength(1);
    expect(store.getImageArtifact("another-session", first.id)).toBeNull();
    store.close(); store = new DemesneStore(join(root, "state.sqlite"));
    expect(store.listImageArtifacts(session.id).artifacts).toEqual([first]);
    expect(await readArtifact(store, first, false)).toEqual(data);
    await expect(ingestImage(store, { ...input, mimeType: "image/png" }, origin, 1)).rejects.toThrow("mismatched");
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("MCP image blocks become retrievable session artifacts through authenticated routes", async () => {
  const root = mkdtempSync(join(tmpdir(), "demesne-image-api-"));
  const databasePath = join(root, "state.sqlite");
  const store = new DemesneStore(databasePath);
  const registry = new ToolRegistry();
  const manager = new McpManager({ servers: { images: { command: process.execPath, args: [join(import.meta.dir, "../../../scripts/fake-image-mcp.ts")] } } });
  let app: ReturnType<typeof createDaemonApp> | undefined;
  try {
    await manager.start(registry);
    const { session } = store.createSession("Images", root);
    const { turn } = store.createTurn(session.id, "Make image");
    const tool = registry.get("mcp__images__create_image")!;
    const output = await tool.executeWithArtifacts!({}, { workspaceRoot: root, signal: new AbortController().signal });
    expect(typeof output).toBe("object");
    if (typeof output === "string") throw new Error("Missing image blocks");
    expect(output.images).toHaveLength(1);
    const artifact = await ingestImage(store, output.images[0]!, { sessionId: session.id, turnId: turn.id, toolCallId: "call", name: tool.definition.name }, 0);
    store.close();
    app = createDaemonApp({ databasePath, authToken: "test-token" });
    const path = `http://localhost/v1/sessions/${session.id}/artifacts`;
    expect((await app.fetch(new Request(path))).status).toBe(401);
    const get = (url: string) => app!.fetch(new Request(url, { headers: { authorization: "Bearer test-token" } }));
    const listed = await (await get(path)).json();
    expect(listed.artifacts[0].id).toBe(artifact.id);
    const content = await get(`${path}/${artifact.id}/content?variant=preview`);
    expect(content.headers.get("content-type")).toBe("image/png");
    expect((await sharp(new Uint8Array(await content.arrayBuffer())).metadata()).width).toBe(640);
    expect((await get(`${path}?after=invalid`)).status).toBe(400);
  } finally { manager.stop(); if (app) await app.close(); else store.close(); rmSync(root, { recursive: true, force: true }); }
});
